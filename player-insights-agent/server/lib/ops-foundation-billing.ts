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
 * Foundation Model API spend for this app's own questions.
 *
 * Pay-per-token models are shared by the whole workspace and the agent's model
 * calls carry no app identifier, so no system table can say which requests were
 * ours. The app does record every run's tokens. This statement prices those
 * tokens at the model's billed workspace rate for the same range: the priced
 * bill for the configured model, scaled by the app's share of every token the
 * model served. One SKU bills input and output together, so a blended rate is
 * the most specific price the bill supports.
 *
 * The agent endpoint's model calls are billed but never appear in
 * `endpoint_usage`, so the app's own tokens are added to the logged tokens to
 * form the denominator.
 */
export function buildFoundationCostStatement(
  ids: CostIdentifiers,
  range: CostRange,
  runs: readonly QuestionRunInput[]
): CostStatement | null {
  if (!ids.workspaceId || !ids.foundationModel) return null;
  const evidence = runs.map((run) => ({
    run_id: run.runId,
    input_tokens: run.inputTokens ?? null,
    output_tokens: run.outputTokens ?? null,
    total_tokens: run.totalTokens,
  }));
  const statement = `WITH run_evidence AS (
  SELECT run.*
  FROM EXPLODE(
    FROM_JSON(
      :interactive_runs_json,
      'ARRAY<STRUCT<run_id:STRING,input_tokens:BIGINT,output_tokens:BIGINT,total_tokens:BIGINT>>'
    )
  ) AS source(run)
),
ledger AS (
  SELECT
    COUNT(DISTINCT run_id) AS expected_runs,
    COUNT(DISTINCT CASE WHEN COALESCE(total_tokens, 0) > 0 THEN run_id END) AS covered_runs,
    COALESCE(SUM(CASE WHEN total_tokens > 0 THEN COALESCE(input_tokens, 0) END), 0) AS input_tokens,
    COALESCE(SUM(CASE WHEN total_tokens > 0 THEN COALESCE(output_tokens, 0) END), 0) AS output_tokens,
    COALESCE(SUM(CASE WHEN total_tokens > 0 THEN total_tokens END), 0) AS total_tokens
  FROM run_evidence
),
model_tokens AS (
  SELECT COALESCE(SUM(COALESCE(u.input_token_count, 0) + COALESCE(u.output_token_count, 0)), 0) AS tokens
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
    AND u.billing_origin_product = 'MODEL_SERVING'
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
    MAX(record_type) AS record_type,
    MAX(unit_price) AS unit_price,
    MAX(currency_code) AS currency_code,
    MAX(CAST(price_start_time AS STRING)) AS price_start_time,
    MAX(price_match_count) AS price_match_count
  FROM price_hits
  GROUP BY record_id
),
bill AS (
  SELECT
    COUNT(record_id) AS billing_rows,
    COUNT(*) FILTER (WHERE unit_price IS NOT NULL AND price_match_count = 1) AS priced_rows,
    COUNT(*) FILTER (WHERE unit_price IS NULL OR price_match_count <> 1) AS unpriced_rows,
    COUNT(*) FILTER (WHERE price_match_count > 1) AS duplicate_matches,
    COUNT(*) FILTER (WHERE record_type ILIKE '%CORRECT%' OR usage_quantity < 0) AS correction_rows,
    COUNT(*) FILTER (WHERE UPPER(TRIM(usage_unit)) <> 'DBU') AS non_dbu_rows,
    COUNT(DISTINCT currency_code) AS currencies,
    MAX(currency_code) AS currency_code,
    MAX(price_start_time) AS price_effective_at,
    COALESCE(SUM(CASE WHEN unit_price IS NOT NULL AND price_match_count = 1
      THEN usage_quantity * unit_price END), 0) AS priced_spend,
    COALESCE(SUM(CASE WHEN unit_price IS NOT NULL AND price_match_count = 1
      THEN usage_quantity END), 0) AS priced_quantity,
    COALESCE(SUM(CASE WHEN unit_price IS NULL OR price_match_count <> 1
      THEN usage_quantity END), 0) AS unpriced_quantity,
    COALESCE(SUM(usage_quantity), 0) AS all_quantity,
    ARRAY_JOIN(COLLECT_SET(CASE WHEN unit_price IS NULL OR price_match_count <> 1 THEN sku_name END), ',') AS unpriced_skus
  FROM deduped
),
rated AS (
  SELECT
    ledger.*,
    bill.*,
    model_tokens.tokens AS model_tokens,
    CASE
      WHEN ledger.total_tokens = 0 THEN CAST(0 AS DOUBLE)
      WHEN bill.billing_rows = 0 THEN CAST(NULL AS DOUBLE)
      ELSE ledger.total_tokens / (model_tokens.tokens + ledger.total_tokens)
    END AS app_share
  FROM ledger CROSS JOIN model_tokens CROSS JOIN bill
)
SELECT
  CASE
    WHEN app_share IS NULL OR unpriced_rows > 0 OR currencies > 1 THEN CAST(NULL AS DOUBLE)
    ELSE priced_spend * app_share
  END AS spend,
  CASE WHEN currencies = 1 THEN currency_code WHEN billing_rows = 0 THEN 'USD' ELSE '' END AS currency,
  CASE
    WHEN app_share IS NULL OR non_dbu_rows > 0 THEN CAST(NULL AS DOUBLE)
    ELSE all_quantity * app_share
  END AS dbus,
  CASE
    WHEN billing_rows = 0 THEN 'none'
    WHEN duplicate_matches > 0 THEN 'duplicate'
    WHEN currencies > 1 THEN 'mixed-currency'
    WHEN unpriced_rows > 0 AND priced_rows > 0 THEN 'partial'
    WHEN unpriced_rows > 0 THEN 'unpriced'
    ELSE 'priced'
  END AS price_match_status,
  priced_quantity * COALESCE(app_share, 0) AS priced_quantity,
  unpriced_quantity * COALESCE(app_share, 0) AS unpriced_quantity,
  priced_rows,
  unpriced_rows,
  unpriced_skus,
  duplicate_matches,
  correction_rows,
  price_effective_at,
  billing_rows,
  0 AS unmapped_billing_rows,
  expected_runs AS requests,
  covered_runs AS covered_requests,
  input_tokens,
  output_tokens,
  total_tokens,
  expected_runs,
  covered_runs,
  expected_runs - covered_runs AS missing_evidence_requests,
  0 AS ambiguous_requests,
  0 AS excluded_requests
FROM rated`;
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

const FOUNDATION_ESTIMATE_NOTE = "Estimated from the app's recorded tokens at this model's billed rate.";

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
    quality: amountAvailable ? 'estimate' : 'unknown',
    amount: amountAvailable ? (result?.amount ?? 0) : null,
    dbus: amountAvailable ? (result?.dbus ?? null) : null,
    basis: 'total-in-range',
    population: 'App-recorded Ask tokens',
    attribution: amountAvailable ? 'deployment' : 'unavailable',
    pricing: result?.pricing ?? EMPTY_PRICING,
    unavailable: amountAvailable
      ? ''
      : reason ||
        (!ids.foundationModel
          ? 'Configured foundation model unavailable.'
          : result?.pricing.match === 'partial' || result?.pricing.match === 'unpriced'
            ? "This model's billing is missing a list price."
            : result && result.billingRows === 0
              ? 'No billing for this model has landed for this range yet.'
              : 'Foundation-model billing could not be attributed.'),
    remedy: '',
    note: !amountAvailable
      ? ''
      : coverageComplete
        ? FOUNDATION_ESTIMATE_NOTE
        : `${FOUNDATION_ESTIMATE_NOTE} Lower bound: ${missingEligibleRequests} Ask${missingEligibleRequests === 1 ? '' : 's'} recorded no tokens.`,
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
