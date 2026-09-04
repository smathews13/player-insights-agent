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
  expectedRuns: number;
  coveredRuns: number;
  missingEvidenceRequests: number;
  ambiguousRequests: number;
  excludedRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number | null;
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
raw_model_requests AS (
  SELECT
    COALESCE(
      NULLIF(LOWER(TRIM(CAST(u.databricks_request_id AS STRING))), ''),
      CONCAT('anonymous:', CAST(u.request_time AS STRING), ':', CAST(u.served_entity_id AS STRING))
    ) AS request_id,
    u.request_time,
    COALESCE(u.input_token_count, 0) AS input_tokens,
    COALESCE(u.output_token_count, 0) AS output_tokens
  FROM system.serving.endpoint_usage u
  JOIN system.serving.served_entities e
    ON u.served_entity_id = e.served_entity_id
  WHERE u.workspace_id = :workspaceId
    AND e.workspace_id = :workspaceId
    AND REGEXP_REPLACE(LOWER(e.endpoint_name), '[^a-z0-9]', '') =
        REGEXP_REPLACE(LOWER(:foundationModel), '[^a-z0-9]', '')
    AND u.request_time >= CAST(:from_day AS DATE)
    ${range.fromTimestamp ? 'AND u.request_time >= :from_instant' : ''}
    AND u.request_time < DATEADD(DAY, 1, CAST(:to_day AS DATE))
),
model_requests AS (
  SELECT
    request_id,
    MIN(request_time) AS request_time,
    MAX(input_tokens) AS input_tokens,
    MAX(output_tokens) AS output_tokens
  FROM raw_model_requests
  GROUP BY request_id
),
request_candidates AS (
  SELECT
    request.request_id,
    request.request_time,
    request.input_tokens,
    request.output_tokens,
    run.run_id,
    CASE WHEN request.request_id IN (
      LOWER(TRIM(run.run_id)),
      LOWER(TRIM(run.request_id)),
      LOWER(TRIM(run.correlation_id)),
      LOWER(TRIM(run.trace_id))
    ) THEN 1 ELSE 0 END AS exact_match
  FROM model_requests request
  LEFT JOIN run_evidence run
    ON request.request_id IN (
      LOWER(TRIM(run.run_id)),
      LOWER(TRIM(run.request_id)),
      LOWER(TRIM(run.correlation_id)),
      LOWER(TRIM(run.trace_id))
    )
    OR request.request_time BETWEEN CAST(run.started_at AS TIMESTAMP) AND CAST(run.completed_at AS TIMESTAMP)
),
classified_requests AS (
  SELECT
    request_id,
    request_time,
    MAX(input_tokens) AS input_tokens,
    MAX(output_tokens) AS output_tokens,
    CASE
      WHEN COUNT(DISTINCT CASE WHEN exact_match = 1 THEN run_id END) = 1 THEN
        MAX(CASE WHEN exact_match = 1 THEN run_id END)
      WHEN COUNT(DISTINCT CASE WHEN exact_match = 1 THEN run_id END) = 0
       AND COUNT(DISTINCT run_id) = 1 THEN MAX(run_id)
      ELSE CAST(NULL AS STRING)
    END AS matched_run_id,
    CASE
      WHEN COUNT(DISTINCT CASE WHEN exact_match = 1 THEN run_id END) = 1
       AND MAX(input_tokens + output_tokens) = 0 THEN 'ask-missing-token'
      WHEN COUNT(DISTINCT CASE WHEN exact_match = 1 THEN run_id END) = 1 THEN 'ask-exact'
      WHEN COUNT(DISTINCT CASE WHEN exact_match = 1 THEN run_id END) = 0
       AND COUNT(DISTINCT run_id) = 1
       AND MAX(input_tokens + output_tokens) = 0 THEN 'ask-missing-token'
      WHEN COUNT(DISTINCT CASE WHEN exact_match = 1 THEN run_id END) = 0
       AND COUNT(DISTINCT run_id) = 1 THEN 'ask-bounded'
      WHEN COUNT(DISTINCT run_id) > 1 THEN 'ambiguous'
      ELSE 'known-excluded'
    END AS request_class
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
    ${range.fromTimestamp ? 'AND u.usage_start_time >= :from_instant' : ''}
    AND REGEXP_REPLACE(LOWER(u.usage_metadata.endpoint_name), '[^a-z0-9]', '') =
        REGEXP_REPLACE(LOWER(:foundationModel), '[^a-z0-9]', '')
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
        WHEN UPPER(billing.sku_name) LIKE '%CACHE%' THEN request.input_tokens
        WHEN UPPER(billing.sku_name) LIKE '%OUTPUT%' THEN request.output_tokens
        WHEN UPPER(billing.sku_name) LIKE '%INPUT%' THEN request.input_tokens
        ELSE request.input_tokens + request.output_tokens
      END
    ) AS all_weight,
    SUM(
      CASE WHEN request.request_class IN ('ask-exact', 'ask-bounded') THEN
        CASE
          WHEN UPPER(billing.sku_name) LIKE '%CACHE%' THEN request.input_tokens
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
request_billing_coverage AS (
  SELECT
    request.*,
    MAX(CASE
      WHEN billing.record_id IS NOT NULL
       AND billing.price_match_count = 1
       AND billing.unit_price IS NOT NULL
       AND (
         (UPPER(billing.sku_name) LIKE '%INPUT%' AND UPPER(billing.sku_name) NOT LIKE '%CACHE%')
         OR (
           UPPER(billing.sku_name) NOT LIKE '%INPUT%'
           AND UPPER(billing.sku_name) NOT LIKE '%OUTPUT%'
           AND UPPER(billing.sku_name) NOT LIKE '%CACHE%'
         )
         OR request.input_tokens = 0
       )
      THEN 1 ELSE 0
    END) AS input_billing_covered,
    MAX(CASE
      WHEN billing.record_id IS NOT NULL
       AND billing.price_match_count = 1
       AND billing.unit_price IS NOT NULL
       AND (
         UPPER(billing.sku_name) LIKE '%OUTPUT%'
         OR (
           UPPER(billing.sku_name) NOT LIKE '%INPUT%'
           AND UPPER(billing.sku_name) NOT LIKE '%OUTPUT%'
           AND UPPER(billing.sku_name) NOT LIKE '%CACHE%'
         )
         OR request.output_tokens = 0
       )
      THEN 1 ELSE 0
    END) AS output_billing_covered
  FROM classified_requests request
  LEFT JOIN deduped billing
    ON request.request_time >= billing.usage_start_time
   AND request.request_time < billing.usage_end_time
  GROUP BY ALL
),
request_totals AS (
  SELECT
    COUNT(*) AS requests,
    COUNT(*) FILTER (
      WHERE request_class IN ('ask-exact', 'ask-bounded')
        AND input_billing_covered = 1
        AND output_billing_covered = 1
    ) AS covered_requests,
    COUNT(DISTINCT CASE
      WHEN request_class IN ('ask-exact', 'ask-bounded')
       AND input_billing_covered = 1
       AND output_billing_covered = 1
      THEN matched_run_id
    END) AS covered_runs,
    COUNT(*) FILTER (
      WHERE request_class = 'ask-missing-token'
         OR (
           request_class IN ('ask-exact', 'ask-bounded')
           AND (input_billing_covered = 0 OR output_billing_covered = 0)
         )
    ) AS missing_evidence_requests,
    COUNT(*) FILTER (WHERE request_class = 'ambiguous') AS ambiguous_requests,
    COUNT(*) FILTER (WHERE request_class = 'known-excluded') AS excluded_requests,
    COALESCE(
      SUM(input_tokens) FILTER (WHERE request_class IN ('ask-exact', 'ask-bounded')),
      0
    ) AS input_tokens,
    COALESCE(
      SUM(output_tokens) FILTER (WHERE request_class IN ('ask-exact', 'ask-bounded')),
      0
    ) AS output_tokens
  FROM request_billing_coverage
),
run_totals AS (
  SELECT COUNT(DISTINCT run_id) AS expected_runs
  FROM run_evidence
)
SELECT
  CASE
    WHEN COUNT(*) FILTER (
      WHERE COALESCE(ask_weight, 0) > 0
        AND (price_match_count <> 1 OR unit_price IS NULL)
    ) > 0
      THEN CAST(NULL AS DOUBLE)
    ELSE COALESCE(SUM(
      CASE WHEN unit_price IS NOT NULL AND price_match_count = 1
        THEN usage_quantity * unit_price * COALESCE(ask_weight / NULLIF(all_weight, 0), 0)
        ELSE 0
      END
    ), 0)
  END AS spend,
  CASE
    WHEN COUNT(DISTINCT currency_code) FILTER (WHERE COALESCE(ask_weight, 0) > 0) = 1
      THEN MAX(currency_code) FILTER (WHERE COALESCE(ask_weight, 0) > 0)
    WHEN COUNT(*) FILTER (WHERE COALESCE(ask_weight, 0) > 0) = 0 THEN 'USD'
    ELSE CAST('' AS STRING)
  END AS currency,
  CASE
    WHEN COUNT(*) FILTER (
      WHERE COALESCE(ask_weight, 0) > 0 AND UPPER(TRIM(usage_unit)) <> 'DBU'
    ) > 0 THEN CAST(NULL AS DOUBLE)
    ELSE COALESCE(SUM(usage_quantity * COALESCE(ask_weight / NULLIF(all_weight, 0), 0)), 0)
  END AS dbus,
  CASE
    WHEN COUNT(*) = 0 THEN 'none'
    WHEN COUNT(*) FILTER (WHERE COALESCE(ask_weight, 0) > 0 AND price_match_count > 1) > 0 THEN 'duplicate'
    WHEN COUNT(DISTINCT currency_code) FILTER (WHERE COALESCE(ask_weight, 0) > 0) > 1
      THEN 'mixed-currency'
    WHEN COUNT(*) FILTER (WHERE COALESCE(ask_weight, 0) > 0 AND unit_price IS NULL) > 0
     AND COUNT(*) FILTER (WHERE COALESCE(ask_weight, 0) > 0 AND unit_price IS NOT NULL) > 0 THEN 'partial'
    WHEN COUNT(*) FILTER (WHERE COALESCE(ask_weight, 0) > 0 AND unit_price IS NOT NULL) = 0
     AND COUNT(*) FILTER (WHERE COALESCE(ask_weight, 0) > 0) > 0 THEN 'unpriced'
    ELSE 'priced'
  END AS price_match_status,
  COALESCE(SUM(CASE
    WHEN COALESCE(ask_weight, 0) > 0 AND unit_price IS NOT NULL AND price_match_count = 1
      THEN usage_quantity * COALESCE(ask_weight / NULLIF(all_weight, 0), 0)
    ELSE 0
  END), 0) AS priced_quantity,
  COALESCE(SUM(CASE
    WHEN COALESCE(ask_weight, 0) > 0 AND (unit_price IS NULL OR price_match_count <> 1)
      THEN usage_quantity * COALESCE(ask_weight / NULLIF(all_weight, 0), 0)
    ELSE 0
  END), 0) AS unpriced_quantity,
  COUNT(*) FILTER (
    WHERE COALESCE(ask_weight, 0) > 0 AND unit_price IS NOT NULL AND price_match_count = 1
  ) AS priced_rows,
  COUNT(*) FILTER (
    WHERE COALESCE(ask_weight, 0) > 0 AND (unit_price IS NULL OR price_match_count <> 1)
  ) AS unpriced_rows,
  ARRAY_JOIN(COLLECT_SET(CASE
    WHEN COALESCE(ask_weight, 0) > 0 AND (unit_price IS NULL OR price_match_count <> 1)
      THEN sku_name
  END), ',') AS unpriced_skus,
  COUNT(*) FILTER (WHERE COALESCE(ask_weight, 0) > 0 AND price_match_count > 1) AS duplicate_matches,
  COUNT(*) FILTER (WHERE record_type ILIKE '%CORRECT%' OR usage_quantity < 0) AS correction_rows,
  MAX(price_start_time) AS price_effective_at,
  COUNT(*) AS billing_rows,
  COUNT(*) FILTER (WHERE COALESCE(all_weight, 0) = 0) AS unmapped_billing_rows,
  MAX(request_totals.requests) AS requests,
  MAX(request_totals.covered_requests) AS covered_requests,
  MAX(request_totals.input_tokens) AS input_tokens,
  MAX(request_totals.output_tokens) AS output_tokens,
  MAX(request_totals.input_tokens + request_totals.output_tokens) AS total_tokens,
  MAX(run_totals.expected_runs) AS expected_runs,
  MAX(request_totals.covered_runs) AS covered_runs,
  MAX(request_totals.missing_evidence_requests) AS missing_evidence_requests,
  MAX(request_totals.ambiguous_requests) AS ambiguous_requests,
  MAX(request_totals.excluded_requests) AS excluded_requests
FROM weighted
CROSS JOIN request_totals
CROSS JOIN run_totals`;
  return {
    statement,
    covered: [],
    estimated: [],
    parameters: [
      { name: 'from_day', value: range.from, type: 'DATE' },
      { name: 'to_day', value: range.to, type: 'DATE' },
      ...(range.fromTimestamp ? [{ name: 'from_instant', value: range.fromTimestamp, type: 'TIMESTAMP' }] : []),
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
    expectedRuns,
    coveredRuns,
    missingEvidenceRequests,
    ambiguousRequests,
    excludedRequests,
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
  const eligibleRuns = finite(expectedRuns);
  const runsWithEvidence = finite(coveredRuns);
  const priceComplete = pricing.match === 'priced' || (pricing.match === 'none' && finite(billingRows) === 0);
  return {
    amount: optionalFinite(spend),
    dbus: optionalFinite(dbus),
    currency: text(currency),
    pricing,
    billingRows: finite(billingRows),
    unmappedBillingRows: unmapped,
    requests: allRequests,
    coveredRequests: mapped,
    expectedRuns: eligibleRuns,
    coveredRuns: runsWithEvidence,
    missingEvidenceRequests: finite(missingEvidenceRequests),
    ambiguousRequests: finite(ambiguousRequests),
    excludedRequests: finite(excludedRequests),
    inputTokens: finite(inputTokens),
    outputTokens: finite(outputTokens),
    totalTokens: optionalFinite(totalTokens),
    complete: priceComplete && runsWithEvidence === eligibleRuns && finite(missingEvidenceRequests) === 0,
  };
}

export function foundationCostTile(
  ids: CostIdentifiers,
  result: FoundationBillingResult | null,
  reason = ''
): CostTile {
  const amountAvailable =
    result?.amount !== null &&
    result?.amount !== undefined &&
    (result.pricing.match === 'priced' || (result.pricing.match === 'none' && result.billingRows === 0));
  const coverageComplete = Boolean(result?.complete);
  const missingEligibleRequests = Math.max(
    result?.missingEvidenceRequests ?? 0,
    (result?.expectedRuns ?? 0) - (result?.coveredRuns ?? 0)
  );
  return {
    id: 'foundation-model',
    label: 'Foundation model tokens',
    resourceId: ids.foundationModel,
    resourceKind: ids.foundationModel ? 'serving-endpoint' : '',
    quality: amountAvailable ? (coverageComplete ? 'per-token' : 'estimate') : 'unknown',
    amount: amountAvailable ? (result?.amount ?? 0) : null,
    dbus: amountAvailable ? (result?.dbus ?? null) : null,
    basis: 'total-in-range',
    population: 'Interactive Ask tokens',
    attribution: amountAvailable ? 'deployment' : 'unavailable',
    pricing: result?.pricing ?? EMPTY_PRICING,
    unavailable: amountAvailable
      ? ''
      : reason ||
        (!ids.foundationModel
          ? 'Configured foundation model unavailable.'
          : result?.pricing.match === 'partial' || result?.pricing.match === 'unpriced'
            ? 'Matched Ask model usage is missing a list price.'
            : 'Foundation-model billing could not be attributed.'),
    remedy: '',
    note:
      amountAvailable && !coverageComplete
        ? `Measured lower bound; ${missingEligibleRequests} eligible Ask${missingEligibleRequests === 1 ? '' : 's'} missing model evidence`
        : '',
    evidence: {
      billingRows: null,
      astrolabeQueries: null,
      interactiveRequests: result?.coveredRequests ?? 0,
      coveredRequests: result?.coveredRequests ?? 0,
      coverageComplete,
      missingEligibleRequests,
      excludedRequests: result?.excludedRequests ?? 0,
      ambiguousRequests: result?.ambiguousRequests ?? 0,
      tokens: result
        ? {
            input: result.inputTokens,
            output: result.outputTokens,
            total:
              result.totalTokens === null || (result.expectedRuns > 0 && result.coveredRuns === 0)
                ? null
                : result.totalTokens,
            requests: result.coveredRequests,
            coveredRequests: result.coveredRequests,
          }
        : null,
    },
  };
}
