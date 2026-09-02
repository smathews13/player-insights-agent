import type { CostTile, CostTilePricing } from '../../shared/ops-contract';
import {
  EMPTY_PRICING,
  type CostIdentifiers,
  type CostRange,
  type CostStatement,
  type QuestionRunInput,
} from './ops-billing';

export interface FoundationBillingResult {
  amount: number | null;
  dbus: number | null;
  currency: string;
  pricing: CostTilePricing;
  billingRows: number;
  unmappedBillingRows: number;
  requests: number;
  coveredRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  complete: boolean;
}

function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function optionalFinite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Actual Foundation Model API billing, narrowed by the closed completed-Ask
 * ledger population. The model price always comes from list_prices. Tokens are
 * used only to allocate billing rows that share the same model/time bucket.
 */
export function buildFoundationCostStatement(
  ids: CostIdentifiers,
  range: CostRange,
  runs: readonly QuestionRunInput[]
): CostStatement | null {
  if (!ids.workspaceId || !ids.foundationModel) return null;
  const evidence = runs.map((run) => ({
    run_id: run.runId,
    request_id: run.requestId ?? '',
    correlation_id: run.correlationId,
    trace_id: run.traceId,
    started_at: run.startedAt ?? '',
    completed_at: run.completedAt,
  }));
  const statement = `WITH run_evidence AS (
  SELECT run.*
  FROM EXPLODE(
    FROM_JSON(
      :interactive_runs_json,
      'ARRAY<STRUCT<run_id:STRING,request_id:STRING,correlation_id:STRING,trace_id:STRING,started_at:STRING,completed_at:STRING>>'
    )
  ) AS source(run)
),
model_requests AS (
  SELECT
    CAST(u.databricks_request_id AS STRING) AS request_id,
    u.request_time,
    COALESCE(u.input_token_count, 0) AS input_tokens,
    COALESCE(u.output_token_count, 0) AS output_tokens
  FROM system.serving.endpoint_usage u
  JOIN system.serving.served_entities e
    ON u.served_entity_id = e.served_entity_id
  WHERE u.workspace_id = :workspaceId
    AND e.workspace_id = :workspaceId
    AND e.endpoint_name = :foundationModel
    AND u.request_time >= CAST(:from_day AS DATE)
    AND u.request_time < DATEADD(DAY, 1, CAST(:to_day AS DATE))
),
request_candidates AS (
  SELECT
    request.request_id,
    request.request_time,
    request.input_tokens,
    request.output_tokens,
    run.run_id,
    CASE WHEN request.request_id IN (run.run_id, run.request_id, run.correlation_id, run.trace_id) THEN 1 ELSE 0 END AS exact_match
  FROM model_requests request
  LEFT JOIN run_evidence run
    ON request.request_id IN (run.run_id, run.request_id, run.correlation_id, run.trace_id)
    OR request.request_time BETWEEN CAST(run.started_at AS TIMESTAMP) AND CAST(run.completed_at AS TIMESTAMP)
),
classified_requests AS (
  SELECT
    request_id,
    request_time,
    MAX(input_tokens) AS input_tokens,
    MAX(output_tokens) AS output_tokens,
    CASE
      WHEN COUNT(DISTINCT CASE WHEN exact_match = 1 THEN run_id END) = 1 THEN TRUE
      WHEN COUNT(DISTINCT CASE WHEN exact_match = 1 THEN run_id END) = 0
       AND COUNT(DISTINCT run_id) = 1 THEN TRUE
      ELSE FALSE
    END AS interactive_ask
  FROM request_candidates
  GROUP BY request_id, request_time
),
billing AS (
  SELECT
    COALESCE(
      CAST(u.record_id AS STRING),
      CONCAT_WS('|', CAST(u.workspace_id AS STRING), u.sku_name, CAST(u.usage_start_time AS STRING), CAST(u.usage_end_time AS STRING))
    ) AS record_id,
    u.usage_quantity,
    u.usage_unit,
    u.sku_name,
    u.cloud,
    u.usage_start_time,
    u.usage_end_time,
    COALESCE(u.record_type, 'ORIGINAL') AS record_type
  FROM system.billing.usage u
  WHERE u.workspace_id = :workspaceId
    AND u.usage_date >= :from_day
    AND u.usage_date <= :to_day
    AND u.usage_metadata.endpoint_name = :foundationModel
    AND u.billing_origin_product IN ('MODEL_SERVING', 'AI_GATEWAY')
    AND u.usage_metadata.endpoint_name <> :agentEndpoint
),
price_hits AS (
  SELECT
    billing.*,
    price.pricing.default AS unit_price,
    price.currency_code,
    price.price_start_time,
    COUNT(price.sku_name) OVER (PARTITION BY billing.record_id) AS price_match_count
  FROM billing
  LEFT JOIN system.billing.list_prices price
    ON billing.sku_name = price.sku_name
   AND billing.cloud = price.cloud
   AND billing.usage_unit = price.usage_unit
   AND billing.usage_end_time >= price.price_start_time
   AND (price.price_end_time IS NULL OR billing.usage_end_time < price.price_end_time)
),
deduped AS (
  SELECT
    record_id,
    MAX(usage_quantity) AS usage_quantity,
    MAX(usage_unit) AS usage_unit,
    MAX(sku_name) AS sku_name,
    MAX(usage_start_time) AS usage_start_time,
    MAX(usage_end_time) AS usage_end_time,
    MAX(record_type) AS record_type,
    MAX(unit_price) AS unit_price,
    MAX(currency_code) AS currency_code,
    MAX(CAST(price_start_time AS STRING)) AS price_start_time,
    MAX(price_match_count) AS price_match_count
  FROM price_hits
  GROUP BY record_id
),
weighted AS (
  SELECT
    billing.*,
    COUNT(request.request_id) AS requests,
    SUM(
      CASE
        WHEN UPPER(billing.sku_name) LIKE '%CACHE%READ%' THEN 0
        WHEN UPPER(billing.sku_name) LIKE '%CACHE%WRITE%' THEN 0
        WHEN UPPER(billing.sku_name) LIKE '%OUTPUT%' THEN request.output_tokens
        WHEN UPPER(billing.sku_name) LIKE '%INPUT%' THEN request.input_tokens
        ELSE request.input_tokens + request.output_tokens
      END
    ) AS all_weight,
    SUM(
      CASE WHEN request.interactive_ask THEN
        CASE
          WHEN UPPER(billing.sku_name) LIKE '%CACHE%READ%' THEN 0
          WHEN UPPER(billing.sku_name) LIKE '%CACHE%WRITE%' THEN 0
          WHEN UPPER(billing.sku_name) LIKE '%OUTPUT%' THEN request.output_tokens
          WHEN UPPER(billing.sku_name) LIKE '%INPUT%' THEN request.input_tokens
          ELSE request.input_tokens + request.output_tokens
        END
      ELSE 0 END
    ) AS ask_weight
  FROM deduped billing
  LEFT JOIN classified_requests request
    ON request.request_time >= billing.usage_start_time
   AND request.request_time < billing.usage_end_time
  GROUP BY ALL
),
request_totals AS (
  SELECT
    COUNT(*) AS requests,
    COUNT(*) FILTER (WHERE interactive_ask) AS covered_requests,
    COALESCE(SUM(input_tokens) FILTER (WHERE interactive_ask), 0) AS input_tokens,
    COALESCE(SUM(output_tokens) FILTER (WHERE interactive_ask), 0) AS output_tokens
  FROM classified_requests
)
SELECT
  CASE
    WHEN COUNT(*) FILTER (WHERE price_match_count <> 1 OR unit_price IS NULL OR COALESCE(all_weight, 0) = 0) > 0
      THEN CAST(NULL AS DOUBLE)
    ELSE COALESCE(SUM(usage_quantity * unit_price * COALESCE(ask_weight / NULLIF(all_weight, 0), 0)), 0)
  END AS spend,
  CASE WHEN COUNT(DISTINCT currency_code) = 1 THEN MAX(currency_code) ELSE CAST('' AS STRING) END AS currency,
  CASE
    WHEN COUNT(*) FILTER (WHERE UPPER(TRIM(usage_unit)) <> 'DBU') > 0 THEN CAST(NULL AS DOUBLE)
    ELSE COALESCE(SUM(usage_quantity * COALESCE(ask_weight / NULLIF(all_weight, 0), 0)), 0)
  END AS dbus,
  CASE
    WHEN COUNT(*) = 0 THEN 'none'
    WHEN COUNT(*) FILTER (WHERE price_match_count > 1) > 0 THEN 'duplicate'
    WHEN COUNT(DISTINCT currency_code) > 1 THEN 'mixed-currency'
    WHEN COUNT(*) FILTER (WHERE unit_price IS NULL) > 0
     AND COUNT(*) FILTER (WHERE unit_price IS NOT NULL) > 0 THEN 'partial'
    WHEN COUNT(*) FILTER (WHERE unit_price IS NOT NULL) = 0 THEN 'unpriced'
    WHEN COUNT(*) FILTER (WHERE COALESCE(all_weight, 0) = 0) > 0 THEN 'partial'
    ELSE 'priced'
  END AS price_match_status,
  COALESCE(SUM(CASE WHEN unit_price IS NOT NULL AND price_match_count = 1 THEN usage_quantity ELSE 0 END), 0) AS priced_quantity,
  COALESCE(SUM(CASE WHEN unit_price IS NULL OR price_match_count <> 1 THEN usage_quantity ELSE 0 END), 0) AS unpriced_quantity,
  COUNT(*) FILTER (WHERE unit_price IS NOT NULL AND price_match_count = 1) AS priced_rows,
  COUNT(*) FILTER (WHERE unit_price IS NULL OR price_match_count <> 1) AS unpriced_rows,
  ARRAY_JOIN(COLLECT_SET(CASE WHEN unit_price IS NULL OR price_match_count <> 1 THEN sku_name END), ',') AS unpriced_skus,
  COUNT(*) FILTER (WHERE price_match_count > 1) AS duplicate_matches,
  COUNT(*) FILTER (WHERE record_type ILIKE '%CORRECT%' OR usage_quantity < 0) AS correction_rows,
  MAX(price_start_time) AS price_effective_at,
  COUNT(*) AS billing_rows,
  COUNT(*) FILTER (WHERE COALESCE(all_weight, 0) = 0) AS unmapped_billing_rows,
  MAX(request_totals.requests) AS requests,
  MAX(request_totals.covered_requests) AS covered_requests,
  MAX(request_totals.input_tokens) AS input_tokens,
  MAX(request_totals.output_tokens) AS output_tokens,
  MAX(request_totals.input_tokens + request_totals.output_tokens) AS total_tokens
FROM weighted
CROSS JOIN request_totals`;
  return {
    statement,
    covered: [],
    estimated: [],
    parameters: [
      { name: 'from_day', value: range.from, type: 'DATE' },
      { name: 'to_day', value: range.to, type: 'DATE' },
      { name: 'workspaceId', value: ids.workspaceId, type: 'STRING' },
      { name: 'foundationModel', value: ids.foundationModel, type: 'STRING' },
      { name: 'agentEndpoint', value: ids.endpointName, type: 'STRING' },
      { name: 'interactive_runs_json', value: JSON.stringify(evidence), type: 'STRING' },
    ],
  };
}

export function readFoundationBillingRows(data: unknown): FoundationBillingResult | null {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  const cells = data[0] as unknown[];
  const [
    spend,
    currency,
    dbus,
    match,
    pricedQuantity,
    unpricedQuantity,
    pricedRows,
    unpricedRows,
    unpricedSkus,
    duplicateMatches,
    correctionRows,
    priceEffectiveAt,
    billingRows,
    unmappedBillingRows,
    requests,
    coveredRequests,
    inputTokens,
    outputTokens,
    totalTokens,
  ] = cells;
  const status = text(match);
  const pricing: CostTilePricing = {
    ...EMPTY_PRICING,
    match:
      status === 'priced' ||
      status === 'partial' ||
      status === 'unpriced' ||
      status === 'duplicate' ||
      status === 'mixed-currency' ||
      status === 'none'
        ? status
        : 'none',
    currency: text(currency),
    pricedQuantity: finite(pricedQuantity),
    unpricedQuantity: finite(unpricedQuantity),
    pricedRows: finite(pricedRows),
    unpricedRows: finite(unpricedRows),
    unpricedSkus: text(unpricedSkus)
      .split(',')
      .map((sku) => sku.trim())
      .filter(Boolean),
    duplicateMatches: finite(duplicateMatches),
    correctionRows: finite(correctionRows),
    priceEffectiveAt: text(priceEffectiveAt),
  };
  const mapped = finite(coveredRequests);
  const allRequests = finite(requests);
  const unmapped = finite(unmappedBillingRows);
  return {
    amount: optionalFinite(spend),
    dbus: optionalFinite(dbus),
    currency: text(currency),
    pricing,
    billingRows: finite(billingRows),
    unmappedBillingRows: unmapped,
    requests: allRequests,
    coveredRequests: mapped,
    inputTokens: finite(inputTokens),
    outputTokens: finite(outputTokens),
    totalTokens: finite(totalTokens),
    complete:
      (pricing.match === 'priced' && unmapped === 0) ||
      (pricing.match === 'none' && finite(billingRows) === 0 && allRequests === 0),
  };
}

export function foundationCostTile(
  ids: CostIdentifiers,
  result: FoundationBillingResult | null,
  reason = ''
): CostTile {
  const complete = Boolean(result?.complete);
  return {
    id: 'foundation-model',
    label: 'Foundation model tokens',
    resourceId: ids.foundationModel,
    resourceKind: ids.foundationModel ? 'serving-endpoint' : '',
    quality: complete ? 'per-token' : 'unknown',
    amount: complete ? (result?.amount ?? 0) : null,
    dbus: complete ? (result?.dbus ?? null) : null,
    basis: 'total-in-range',
    population: 'Interactive Ask tokens',
    attribution: complete ? 'deployment' : 'unavailable',
    pricing: result?.pricing ?? EMPTY_PRICING,
    unavailable:
      reason ||
      (!ids.foundationModel
        ? 'Configured foundation model unavailable.'
        : result?.pricing.match === 'partial'
          ? 'Foundation-model request or price coverage is partial; spend is withheld.'
          : 'Foundation-model billing could not be attributed.'),
    remedy: '',
    note: '',
    evidence: {
      billingRows: null,
      astrolabeQueries: null,
      interactiveRequests: result?.coveredRequests ?? 0,
      coveredRequests: result?.coveredRequests ?? 0,
      tokens: result
        ? {
            input: result.inputTokens,
            output: result.outputTokens,
            total: result.totalTokens,
            requests: result.requests,
            coveredRequests: result.coveredRequests,
          }
        : null,
    },
  };
}
