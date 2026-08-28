/**
 * What the six cost tiles are read from, and what each of them is allowed to claim.
 *
 * Every figure here comes from `system.billing.usage` priced against
 * `system.billing.list_prices`. Nothing is modelled, apportioned by a ratio
 * invented in this file, or carried over from a previous read. Where a
 * component cannot be attributed, its tile says so and shows no number, because
 * a component nobody could attribute and a component that cost nothing are
 * different facts and `$0.00` states the second one.
 *
 * THE IDENTIFIERS ARE THE WHOLE PROBLEM. Billing is workspace-wide, so a query
 * that does not name this deployment's own endpoint, warehouse, app and index
 * returns somebody else's spend. Each component below is therefore matched on a
 * `usage_metadata` key that Databricks fills in for that product, and a
 * component whose identifier this deployment has not configured contributes NO
 * BRANCH to the statement at all. It then renders as "not configured" and names
 * the variable to set, which is a true statement about this deployment, rather
 * than as zero, which is a false statement about the bill.
 *
 * The product names and metadata keys were read off the workspace rather than
 * recalled:
 *
 *   MODEL_SERVING     usage_metadata.endpoint_name
 *   SQL               usage_metadata.warehouse_id
 *   APPS              usage_metadata.app_name
 *   VECTOR_SEARCH     usage_metadata.endpoint_name
 *   GENIE             no metadata at all, workspace-scoped only
 *   LAKEFLOW_CONNECT  no metadata at all, workspace-scoped only
 *
 * The last two are why the Genie and telemetry tiles say they cover the whole
 * workspace. There is no key to narrow them with, and narrowing them by a guess
 * would be the invented number this app has spent months removing.
 *
 * NO IDENTIFIER IS WRITTEN DOWN HERE. Every one arrives as a bound parameter
 * from the environment, so this file carries the shape of the question and a
 * deployment carries its own answer. That is also what keeps a customer's
 * endpoint and warehouse ids out of the repository.
 */

import { BILLING_TAG, billingTagPair, type AppBillingTagState } from '../../shared/billing-tag';
import type {
  CostAttributionScope,
  CostCoverage,
  CostCoverageProduct,
  CostHonesty,
  CostPriceMatch,
  CostPropagation,
  CostQuality,
  CostResourceKind,
  CostTile,
  CostTilePricing,
  QuestionCostAttribution,
  QuestionCostPart,
  QuestionCostRun,
} from '../../shared/ops-contract';

/**
 * The components a deployment can be billed for, in the order they are shown.
 *
 * SIX, WHICH IS THE HANDOFF'S GRID, and telemetry ingestion is the one that was
 * removed. It was a seventh card carrying a WHOLE WORKSPACE total that no key
 * narrows to this app. On a deployment with telemetry off, which is the default
 * and the customer case, the card said "Telemetry off" and nothing else. A
 * reader could neither act on it nor attribute it, and the one thing it could do
 * was be mistaken for this deployment's spend.
 */
export const COST_COMPONENTS = [
  'serving-endpoint',
  'foundation-model',
  'sql-warehouse',
  'genie',
  'vector-search',
  'app-compute',
] as const;

export type CostComponent = (typeof COST_COMPONENTS)[number];

/**
 * What this deployment calls its own resources.
 *
 * Every field may be empty, and empty is handled rather than defaulted. The app
 * genuinely does not know some of these: the vector search endpoint is read off
 * a probe rather than configuration.
 */
export interface CostIdentifiers {
  /** `DATABRICKS_APP_NAME`. */
  appName: string;
  /** `DATABRICKS_SERVING_ENDPOINT_NAME`. */
  endpointName: string;
  /** The resolved `llm-endpoint` setting used by the orchestrator. */
  foundationEndpoint: string;
  /** `DATABRICKS_SQL_WAREHOUSE_ID`. */
  warehouseId: string;
  /** Resolved from the index when this deployment searches one. */
  vectorEndpoint: string;
  /** Three-level Vector Search index name, or ''. Used to open the index, not to bill. */
  vectorIndex: string;
  /** The Genie spaces this deployment asks, in display order. */
  genieSpaces: readonly { id: string; label: string }[];
  /** `DATABRICKS_WORKSPACE_ID`. The only handle workspace-wide Genie billing has. */
  workspaceId: string;
  /**
   * Whether a telemetry destination is configured.
   *
   * NO TILE DEPENDS ON THIS ANY MORE. It decided a seventh card for telemetry
   * ingestion, which was removed: the figure was a whole-workspace total no key
   * narrows to this app, and on a deployment with telemetry off it was a card
   * reading "Telemetry off" and nothing else. The field stays because the route
   * still reports it and removing it belongs with the telemetry work in flight
   * elsewhere.
   */
  telemetryEnabled: boolean;
  /**
   * Whether this app's own tag assignment is `system_billing=astrolabe`.
   *
   * Read from the Apps tag API, not from billed usage. Missing spend is not
   * evidence the tag is absent.
   */
  appBillingTag: AppBillingTagState;
}

/** Inclusive ISO dates. `to` is the last complete day, never today. */
export interface CostRange {
  from: string;
  to: string;
}

/** One bound parameter, in the shape the SQL Statement Execution API takes. */
export interface StatementParameter {
  name: string;
  value: string;
  type: string;
}

export interface CostStatement {
  statement: string;
  parameters: StatementParameter[];
  /** The components this statement can actually return, in the order asked for. */
  covered: CostComponent[];
  /**
   * The components it can only answer at WHOLE-WORKSPACE scope.
   *
   * Separate from `covered` on purpose, and the separation is the governance:
   * these are not this deployment's spend and nothing may add them to a figure
   * that claims to be. See {@link WORKSPACE_ESTIMATE_SUFFIX}.
   */
  estimated: CostComponent[];
}

/**
 * ── THE LABELLED ESTIMATE, AND WHY IT IS A SEPARATE ROW ───────────────────
 *
 * A component this deployment cannot name shows "Not attributable" and no
 * number, which is honest and, on the deployments that matter, most of the grid:
 * nothing hands the app its vector search endpoint name, and no deployment sets a
 * rebuild job id. Two of six tiles are therefore blank, and an admin asking what
 * this thing costs gets a page that mostly declines to answer.
 *
 * There IS a true figure available for those: the product's total across the
 * whole workspace. It is not this deployment's spend, and the entire risk in
 * showing it is that somebody reads it as though it were. So it comes back under
 * its OWN row key, `component:workspace`, which means:
 *
 *  - No sum over the components can pick it up. Anything adding these rows
 *    selects by exact component name, so a workspace total is structurally
 *    ineligible rather than excluded by a filter someone might later "tidy up".
 *  - The tile that renders it is relabelled at the same time: quality becomes
 *    `estimate` and population becomes "Whole workspace", overriding whatever the
 *    narrowed tile would have claimed. A workspace-wide MODEL_SERVING total
 *    presented as `per-token` for this endpoint would be the exact
 *    mislabelling this file exists to prevent.
 *
 * It still requires a workspace id. Without one there is no predicate that keeps
 * the figure inside this workspace, and `system.billing.usage` can carry more
 * than one — so the fallback is unavailable rather than widened.
 */
export const WORKSPACE_ESTIMATE_SUFFIX = ':workspace';

export function workspaceEstimateRow(component: CostComponent): string {
  return `${component}${WORKSPACE_ESTIMATE_SUFFIX}`;
}

/**
 * The metadata predicate that isolates each component, and the parameter it binds.
 *
 * Kept as data rather than as a chain of string concatenation in the builder so
 * that adding a component is one entry and cannot half-happen: a component with
 * no entry here contributes no branch, which is the safe direction.
 */
const MATCHERS: Record<
  CostComponent,
  { product: string; column: string | null; parameter: keyof CostIdentifiers; type: string }
> = {
  'serving-endpoint': {
    product: 'MODEL_SERVING',
    column: 'u.usage_metadata.endpoint_name',
    parameter: 'endpointName',
    type: 'STRING',
  },
  'foundation-model': {
    product: 'MODEL_SERVING',
    column: 'u.usage_metadata.endpoint_name',
    parameter: 'foundationEndpoint',
    type: 'STRING',
  },
  'sql-warehouse': {
    product: 'SQL',
    column: 'u.usage_metadata.warehouse_id',
    parameter: 'warehouseId',
    type: 'STRING',
  },
  // No metadata key exists on this product. The workspace is the only filter,
  // and the tile's population line says exactly that.
  genie: { product: 'GENIE', column: null, parameter: 'workspaceId', type: 'STRING' },
  'vector-search': {
    product: 'VECTOR_SEARCH',
    column: 'u.usage_metadata.endpoint_name',
    parameter: 'vectorEndpoint',
    type: 'STRING',
  },
  'app-compute': {
    product: 'APPS',
    column: 'u.usage_metadata.app_name',
    parameter: 'appName',
    type: 'STRING',
  },
};

/** The row this statement adds so the block can date itself even with no matches. */
export const RANGE_ROW = '__range';
export const BILLING_TAG_KEY = BILLING_TAG.key;
export const BILLING_TAG_VALUE = BILLING_TAG.value;
export const LIST_PRICE_SOURCE = 'system.billing.list_prices' as const;

/** Genie space cards stay dollar-free; LLM spend is a separate stream we cannot join. */
export const GENIE_LLM_UNAVAILABLE = 'Genie LLM spend not attributable in this model';
export const GENIE_SQL_NOT_COMPLETE =
  'SQL from this space is billed on the SQL warehouse tile. That warehouse figure is not the complete Genie cost.';

const TILED_PRODUCTS = new Set(['MODEL_SERVING', 'SQL', 'VECTOR_SEARCH', 'APPS']);
const PRODUCT_REASONS: Record<string, string> = {
  MODEL_SERVING: 'Measured only when an exact tracked endpoint name matches; tag coverage is reported separately.',
  SQL: 'Tracked as the SQL warehouse tile. This is a shared meter, not app-only spend.',
  VECTOR_SEARCH: 'Tracked as the Vector Search tile when the endpoint name matches.',
  APPS: 'Measured by exact app name. App tag presence is a separate organizational signal.',
  GENIE: 'Genie space cards stay dollar-free. Genie LLM spend is not attributable in this model.',
  LAKEBASE: 'Lakebase can be tagged. No documented billing join exists in this model.',
  MLFLOW: 'MLflow experiments can be tagged. They have no Cost tile.',
};

export const EMPTY_PRICING: CostTilePricing = {
  source: 'list_prices',
  match: 'none',
  currency: '',
  pricedQuantity: 0,
  unpricedQuantity: 0,
  pricedRows: 0,
  unpricedRows: 0,
  unpricedSkus: [],
  duplicateMatches: 0,
  correctionRows: 0,
  priceEffectiveAt: '',
};

/**
 * Whether this deployment knows enough to ask about a component.
 *
 * Genie needs a workspace id and nothing else; the rest need their own
 * identifier.
 */
export function canAsk(component: CostComponent, ids: CostIdentifiers): boolean {
  // Resource names are not account-global. The live audit reproduced the old
  // Foundation figure across 214 workspaces because endpoint identity was used
  // without this boundary. No workspace means no defensible Cost query.
  if (!ids.workspaceId) return false;
  // Genie billing has no space identifier. A workspace id is not a safe
  // substitute: it would attribute every space in the workspace to this app.
  if (component === 'genie') return false;
  // A configured foundation endpoint is shared until app-level ownership is
  // proven independently. Exact endpoint-name identity proves only identity,
  // not ownership, so Cost never asks billing for this amount.
  if (component === 'foundation-model') return false;
  if (component === 'serving-endpoint' && ids.endpointName && ids.endpointName === ids.foundationEndpoint) {
    return false;
  }
  return Boolean(ids[MATCHERS[component].parameter]);
}

/**
 * The workspace identifier a tile can open, or ''.
 *
 * Separate from {@link canAsk}: Genie can be asked about (workspace id) but
 * that id is not a Genie space, so the tile has nothing to open. Vector Search
 * can name its endpoint and still have no verified workspace path for one.
 */
export function resourceIdFor(component: CostComponent, ids: CostIdentifiers): string {
  switch (component) {
    case 'serving-endpoint':
      return ids.endpointName;
    case 'foundation-model':
      return ids.foundationEndpoint;
    case 'sql-warehouse':
      return ids.warehouseId;
    case 'app-compute':
      return ids.appName;
    case 'vector-search':
      return vectorIndexName(ids.vectorIndex);
    case 'genie':
      return '';
  }
}

function resourceKindFor(component: CostComponent, ids: CostIdentifiers): CostResourceKind | '' {
  switch (component) {
    case 'serving-endpoint':
    case 'foundation-model':
      return 'serving-endpoint';
    case 'sql-warehouse':
      return 'sql-warehouse';
    case 'app-compute':
      return 'app';
    case 'vector-search':
      return vectorIndexName(ids.vectorIndex) ? 'vector-index' : '';
    case 'genie':
      return '';
  }
}

/** A three-level index name the Architecture page already knows how to open, or ''. */
export function vectorIndexName(raw: string): string {
  const name = raw.trim();
  const parts = name.split('.').filter((piece) => piece.length > 0);
  return parts.length === 3 ? name : '';
}

/**
 * The one statement the cost block runs.
 *
 * One statement rather than seven because a warehouse charges by the second it
 * is awake and seven round trips would cost the reader seven wake-ups to answer
 * a question about cost. Returns null when this deployment can identify nothing,
 * which the route reports as a configuration state rather than running a query
 * guaranteed to match no rows.
 *
 * The price join is bounded by the price's own validity window rather than
 * pinned to the current price. A range that crosses a price change would
 * otherwise be restated at today's rate, quietly, with no sign on the tile.
 */
export function buildCostStatement(ids: CostIdentifiers, range: CostRange): CostStatement | null {
  const covered = COST_COMPONENTS.filter((component) => canAsk(component, ids));
  // Live billing evidence confirms that workspace-wide product totals are not
  // deployment attribution. Missing exact identifiers stay unavailable.
  const estimated: CostComponent[] = [];
  if (covered.length === 0 && estimated.length === 0) return null;

  const parameters: StatementParameter[] = [];
  const branches: string[] = [];
  const bound = new Set<string>();

  const bind = (marker: string, value: string, type: string) => {
    if (bound.has(marker)) return;
    parameters.push({ name: marker, value, type });
    bound.add(marker);
  };
  bind('from_day', range.from, 'DATE');
  bind('to_day', range.to, 'DATE');
  if (ids.workspaceId) bind('workspaceId', ids.workspaceId, 'STRING');

  for (const component of covered) {
    const matcher = MATCHERS[component];
    const marker = String(matcher.parameter);
    bind(marker, ids[matcher.parameter] as string, matcher.type);
    const predicate = matcher.column === null ? `u.workspace_id = :${marker}` : `${matcher.column} = :${marker}`;
    branches.push(`      WHEN u.billing_origin_product = '${matcher.product}' AND ${predicate} THEN '${component}'`);
  }

  // AFTER the narrowed branches, always. A `CASE` takes the first match, so a
  // component the deployment CAN name must be claimed by its own branch before a
  // workspace-wide one for the same product is offered.
  for (const component of estimated) {
    const matcher = MATCHERS[component];
    bind('workspaceId', ids.workspaceId, 'STRING');
    branches.push(
      `      WHEN u.billing_origin_product = '${matcher.product}' AND u.workspace_id = :workspaceId ` +
        `AND u.custom_tags['${BILLING_TAG.key}'] = '${BILLING_TAG.value}' ` +
        `THEN '${workspaceEstimateRow(component)}'`
    );
  }

  const resourcePredicates: string[] = [];
  if (ids.warehouseId) {
    resourcePredicates.push(`(u.billing_origin_product = 'SQL' AND u.usage_metadata.warehouse_id = :warehouseId)`);
  }
  if (ids.endpointName && canAsk('serving-endpoint', ids)) {
    resourcePredicates.push(
      `(u.billing_origin_product = 'MODEL_SERVING' AND u.usage_metadata.endpoint_name = :endpointName)`
    );
  }
  if (ids.vectorEndpoint) {
    resourcePredicates.push(
      `(u.billing_origin_product = 'VECTOR_SEARCH' AND u.usage_metadata.endpoint_name = :vectorEndpoint)`
    );
  }
  if (ids.appName) {
    resourcePredicates.push(`(u.billing_origin_product = 'APPS' AND u.usage_metadata.app_name = :appName)`);
  }
  const leakPredicate = resourcePredicates.length > 0 ? resourcePredicates.join('\n     OR ') : 'FALSE';

  const statement = `WITH tagged AS (
  SELECT
    u.usage_date,
    u.usage_quantity,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_end_time,
    u.workspace_id,
    u.billing_origin_product,
    COALESCE(
      CAST(u.record_id AS STRING),
      CONCAT_WS('|', CAST(u.workspace_id AS STRING), u.sku_name, CAST(u.usage_start_time AS STRING), CAST(u.usage_end_time AS STRING))
    ) AS record_id,
    COALESCE(u.record_type, 'ORIGINAL') AS record_type,
    COALESCE(u.custom_tags['${BILLING_TAG.key}'] = '${BILLING_TAG.value}', FALSE) AS tag_matches,
    CASE
${branches.join('\n')}
      ELSE NULL
    END AS component
  FROM system.billing.usage u
  WHERE u.usage_date >= :from_day
    AND u.usage_date <= :to_day
    AND u.workspace_id = :workspaceId
    AND u.billing_origin_product <> 'JOBS'
    AND (
      u.custom_tags['${BILLING_TAG.key}'] = '${BILLING_TAG.value}'
      OR ${leakPredicate}
    )
),
price_hits AS (
  SELECT
    t.*,
    p.pricing.default AS unit_price,
    p.currency_code,
    p.price_start_time,
    COUNT(p.sku_name) OVER (PARTITION BY t.record_id) AS price_match_count
  FROM tagged t
  LEFT JOIN system.billing.list_prices p
    ON t.sku_name = p.sku_name
   AND t.cloud = p.cloud
   AND t.usage_unit = p.usage_unit
   AND t.usage_end_time >= p.price_start_time
   AND (p.price_end_time IS NULL OR t.usage_end_time < p.price_end_time)
),
deduped AS (
  SELECT
    record_id,
    usage_date,
    usage_quantity,
    sku_name,
    billing_origin_product,
    component,
    record_type,
    tag_matches,
    MAX(price_match_count) AS price_match_count,
    MAX(unit_price) AS unit_price,
    MAX(currency_code) AS currency_code,
    MAX(CAST(price_start_time AS STRING)) AS price_start_time
  FROM price_hits
  GROUP BY record_id, usage_date, usage_quantity, sku_name, billing_origin_product, component, record_type, tag_matches
),
priced AS (
  SELECT
    *,
    CASE
      WHEN unit_price IS NOT NULL AND price_match_count = 1 THEN usage_quantity * unit_price
      ELSE CAST(NULL AS DOUBLE)
    END AS spend,
    CASE
      WHEN price_match_count > 1 THEN 'duplicate'
      WHEN unit_price IS NULL THEN 'unpriced'
      ELSE 'priced'
    END AS row_match
  FROM deduped
)
SELECT
  'component' AS row_kind,
  component AS key,
  SUM(spend) AS spend,
  CASE WHEN COUNT(DISTINCT CASE WHEN currency_code IS NOT NULL THEN currency_code END) = 1
       THEN MAX(currency_code) ELSE CAST('' AS STRING) END AS currency,
  COUNT(DISTINCT CASE WHEN currency_code IS NOT NULL THEN currency_code END) AS currency_count,
  COUNT(DISTINCT usage_date) AS billed_days,
  CAST(NULL AS BIGINT) AS job_runs,
  MAX(usage_date) AS last_day,
  SUM(CASE WHEN row_match = 'priced' THEN usage_quantity ELSE 0 END) AS priced_quantity,
  SUM(CASE WHEN row_match <> 'priced' THEN usage_quantity ELSE 0 END) AS unpriced_quantity,
  COUNT(*) FILTER (WHERE row_match = 'priced') AS priced_rows,
  COUNT(*) FILTER (WHERE row_match <> 'priced') AS unpriced_rows,
  array_join(collect_set(CASE WHEN row_match <> 'priced' THEN sku_name END), ',') AS unpriced_skus,
  CASE
    WHEN COUNT(*) FILTER (WHERE row_match = 'duplicate') > 0 THEN 'duplicate'
    WHEN COUNT(DISTINCT CASE WHEN currency_code IS NOT NULL THEN currency_code END) > 1 THEN 'mixed-currency'
    WHEN COUNT(*) FILTER (WHERE row_match = 'unpriced') > 0 AND COUNT(*) FILTER (WHERE row_match = 'priced') > 0 THEN 'partial'
    WHEN COUNT(*) FILTER (WHERE row_match = 'priced') = 0 THEN 'unpriced'
    ELSE 'priced'
  END AS price_match_status,
  COUNT(*) FILTER (WHERE record_type ILIKE '%CORRECT%' OR usage_quantity < 0) AS correction_rows,
  COUNT(*) FILTER (WHERE price_match_count > 1) AS duplicate_matches,
  MAX(price_start_time) AS price_effective_at,
  COUNT(*) FILTER (WHERE tag_matches) AS tagged_rows,
  COUNT(*) FILTER (WHERE NOT tag_matches) AS untagged_rows
FROM priced
WHERE component IS NOT NULL
GROUP BY component
UNION ALL
SELECT
  'coverage' AS row_kind,
  billing_origin_product AS key,
  SUM(spend) AS spend,
  CASE WHEN COUNT(DISTINCT CASE WHEN currency_code IS NOT NULL THEN currency_code END) = 1
       THEN MAX(currency_code) ELSE CAST('' AS STRING) END AS currency,
  COUNT(DISTINCT CASE WHEN currency_code IS NOT NULL THEN currency_code END) AS currency_count,
  COUNT(DISTINCT usage_date) AS billed_days,
  CAST(NULL AS BIGINT) AS job_runs,
  MAX(usage_date) AS last_day,
  SUM(CASE WHEN row_match = 'priced' THEN usage_quantity ELSE 0 END) AS priced_quantity,
  SUM(CASE WHEN row_match <> 'priced' THEN usage_quantity ELSE 0 END) AS unpriced_quantity,
  COUNT(*) FILTER (WHERE row_match = 'priced') AS priced_rows,
  COUNT(*) FILTER (WHERE row_match <> 'priced') AS unpriced_rows,
  array_join(collect_set(CASE WHEN row_match <> 'priced' THEN sku_name END), ',') AS unpriced_skus,
  CASE
    WHEN COUNT(*) FILTER (WHERE row_match = 'duplicate') > 0 THEN 'duplicate'
    WHEN COUNT(DISTINCT CASE WHEN currency_code IS NOT NULL THEN currency_code END) > 1 THEN 'mixed-currency'
    WHEN COUNT(*) FILTER (WHERE row_match = 'unpriced') > 0 AND COUNT(*) FILTER (WHERE row_match = 'priced') > 0 THEN 'partial'
    WHEN COUNT(*) FILTER (WHERE row_match = 'priced') = 0 THEN 'unpriced'
    ELSE 'priced'
  END AS price_match_status,
  COUNT(*) FILTER (WHERE record_type ILIKE '%CORRECT%' OR usage_quantity < 0) AS correction_rows,
  COUNT(*) FILTER (WHERE price_match_count > 1) AS duplicate_matches,
  MAX(price_start_time) AS price_effective_at,
  COUNT(*) FILTER (WHERE tag_matches) AS tagged_rows,
  COUNT(*) FILTER (WHERE NOT tag_matches) AS untagged_rows
FROM priced
GROUP BY billing_origin_product
UNION ALL
SELECT
  'range' AS row_kind,
  '${RANGE_ROW}' AS key,
  CAST(NULL AS DOUBLE) AS spend,
  CASE WHEN COUNT(DISTINCT CASE WHEN currency_code IS NOT NULL THEN currency_code END) = 1
       THEN MAX(currency_code) ELSE CAST('' AS STRING) END AS currency,
  COUNT(DISTINCT CASE WHEN currency_code IS NOT NULL THEN currency_code END) AS currency_count,
  COUNT(DISTINCT usage_date) AS billed_days,
  CAST(NULL AS BIGINT) AS job_runs,
  MAX(usage_date) AS last_day,
  SUM(CASE WHEN row_match = 'priced' THEN usage_quantity ELSE 0 END) AS priced_quantity,
  SUM(CASE WHEN row_match <> 'priced' THEN usage_quantity ELSE 0 END) AS unpriced_quantity,
  COUNT(*) FILTER (WHERE row_match = 'priced') AS priced_rows,
  COUNT(*) FILTER (WHERE row_match <> 'priced') AS unpriced_rows,
  CAST('' AS STRING) AS unpriced_skus,
  CAST('' AS STRING) AS price_match_status,
  COUNT(*) FILTER (WHERE record_type ILIKE '%CORRECT%' OR usage_quantity < 0) AS correction_rows,
  COUNT(*) FILTER (WHERE price_match_count > 1) AS duplicate_matches,
  MAX(price_start_time) AS price_effective_at,
  COUNT(*) FILTER (WHERE tag_matches) AS tagged_rows,
  COUNT(*) FILTER (WHERE NOT tag_matches) AS untagged_rows
FROM priced
UNION ALL
SELECT
  'propagation' AS row_kind,
  u.billing_origin_product AS key,
  CAST(NULL AS DOUBLE) AS spend,
  CAST('' AS STRING) AS currency,
  CAST(0 AS BIGINT) AS currency_count,
  COUNT(DISTINCT u.usage_date) AS billed_days,
  CAST(NULL AS BIGINT) AS job_runs,
  MAX(u.usage_date) AS last_day,
  CAST(0 AS DOUBLE) AS priced_quantity,
  CAST(0 AS DOUBLE) AS unpriced_quantity,
  CAST(0 AS BIGINT) AS priced_rows,
  CAST(0 AS BIGINT) AS unpriced_rows,
  CAST('' AS STRING) AS unpriced_skus,
  CAST('' AS STRING) AS price_match_status,
  CAST(0 AS BIGINT) AS correction_rows,
  CAST(0 AS BIGINT) AS duplicate_matches,
  CAST('' AS STRING) AS price_effective_at,
  COUNT(*) FILTER (WHERE u.custom_tags['${BILLING_TAG.key}'] = '${BILLING_TAG.value}') AS tagged_rows,
  COUNT(*) FILTER (
    WHERE u.custom_tags['${BILLING_TAG.key}'] IS NULL
       OR u.custom_tags['${BILLING_TAG.key}'] <> '${BILLING_TAG.value}'
  ) AS untagged_rows
FROM system.billing.usage u
WHERE u.usage_date >= :from_day
  AND u.usage_date <= :to_day
  AND u.workspace_id = :workspaceId
  AND u.billing_origin_product <> 'JOBS'
  AND (${leakPredicate})
GROUP BY u.billing_origin_product`;

  return { statement, parameters, covered, estimated };
}

const ROW_KINDS = new Set(['component', 'coverage', 'propagation', 'range']);

/** One component's figures, as read back. */
export interface ComponentRow {
  kind?: 'component' | 'coverage' | 'propagation' | 'range';
  component: string;
  spend: number | null;
  currency: string;
  currencyCount?: number;
  billedDays: number;
  jobRuns: number | null;
  lastDay: string;
  pricedQuantity?: number;
  unpricedQuantity?: number;
  pricedRows?: number;
  unpricedRows?: number;
  unpricedSkus?: string[];
  priceMatchStatus?: CostPriceMatch;
  correctionRows?: number;
  duplicateMatches?: number;
  priceEffectiveAt?: string;
  taggedRows?: number;
  untaggedRows?: number;
}

function emptyRow(kind: ComponentRow['kind'], component: string): ComponentRow {
  return {
    kind,
    component,
    spend: null,
    currency: '',
    currencyCount: 0,
    billedDays: 0,
    jobRuns: null,
    lastDay: '',
    pricedQuantity: 0,
    unpricedQuantity: 0,
    pricedRows: 0,
    unpricedRows: 0,
    unpricedSkus: [],
    priceMatchStatus: 'none',
    correctionRows: 0,
    duplicateMatches: 0,
    priceEffectiveAt: '',
    taggedRows: 0,
    untaggedRows: 0,
  };
}

function asNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asCount(value: string | null | undefined): number {
  return asNumber(value) ?? 0;
}

function asMatch(value: string | null | undefined): CostPriceMatch {
  if (
    value === 'priced' ||
    value === 'unpriced' ||
    value === 'partial' ||
    value === 'duplicate' ||
    value === 'mixed-currency' ||
    value === 'none'
  ) {
    return value;
  }
  return 'none';
}

function parseSkus(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((sku) => sku.trim())
    .filter(Boolean);
}

/**
 * Read the statement's rows without inventing any.
 *
 * The API returns every value as a string or null, so a null spend stays null
 * here rather than becoming zero on the way through `Number()`. That single
 * coercion is how a tile would come to promise a figure nothing measured.
 *
 * Six-column rows from older tests still parse as component/range rows.
 */
export function readComponentRows(dataArray: unknown): ComponentRow[] {
  if (!Array.isArray(dataArray)) return [];
  const rows: ComponentRow[] = [];
  for (const raw of dataArray) {
    if (!Array.isArray(raw) || raw.length < 6) continue;
    const cells = raw as (string | null)[];
    const wide = cells.length >= 8 && typeof cells[0] === 'string' && ROW_KINDS.has(cells[0]);
    if (wide) {
      const [
        kind,
        component,
        spend,
        currency,
        currencyCount,
        billedDays,
        jobRuns,
        lastDay,
        pricedQuantity,
        unpricedQuantity,
        pricedRows,
        unpricedRows,
        unpricedSkus,
        priceMatchStatus,
        correctionRows,
        duplicateMatches,
        priceEffectiveAt,
        taggedRows,
        untaggedRows,
      ] = cells;
      if (typeof component !== 'string' || typeof kind !== 'string') continue;
      rows.push({
        kind: kind as ComponentRow['kind'],
        component,
        spend: asNumber(spend),
        currency: typeof currency === 'string' ? currency : '',
        currencyCount: asCount(currencyCount),
        billedDays: asCount(billedDays),
        jobRuns: asNumber(jobRuns),
        lastDay: typeof lastDay === 'string' ? lastDay : '',
        pricedQuantity: asCount(pricedQuantity),
        unpricedQuantity: asCount(unpricedQuantity),
        pricedRows: asCount(pricedRows),
        unpricedRows: asCount(unpricedRows),
        unpricedSkus: parseSkus(unpricedSkus),
        priceMatchStatus: asMatch(priceMatchStatus),
        correctionRows: asCount(correctionRows),
        duplicateMatches: asCount(duplicateMatches),
        priceEffectiveAt: typeof priceEffectiveAt === 'string' ? priceEffectiveAt : '',
        taggedRows: asCount(taggedRows),
        untaggedRows: asCount(untaggedRows),
      });
      continue;
    }
    const [component, spend, currency, billedDays, jobRuns, lastDay] = cells;
    if (typeof component !== 'string') continue;
    const kind = component === RANGE_ROW ? 'range' : 'component';
    rows.push({
      ...emptyRow(kind, component),
      spend: asNumber(spend),
      currency: typeof currency === 'string' ? currency : '',
      billedDays: asCount(billedDays),
      jobRuns: asNumber(jobRuns),
      lastDay: typeof lastDay === 'string' ? lastDay : '',
    });
  }
  return rows;
}

export function splitBillingRows(rows: ComponentRow[]): {
  components: ComponentRow[];
  coverage: ComponentRow[];
  propagation: ComponentRow[];
  meta: ComponentRow | undefined;
} {
  return {
    components: rows.filter((row) => (row.kind ?? 'component') === 'component' && row.component !== RANGE_ROW),
    coverage: rows.filter((row) => row.kind === 'coverage'),
    propagation: rows.filter((row) => row.kind === 'propagation'),
    meta: rows.find((row) => row.kind === 'range' || row.component === RANGE_ROW),
  };
}

export function pricingFromRow(row: ComponentRow | undefined): CostTilePricing {
  if (!row) return { ...EMPTY_PRICING };
  const pricedRows = row.pricedRows ?? 0;
  const unpricedRows = row.unpricedRows ?? 0;
  const unpricedQuantity = row.unpricedQuantity ?? 0;
  const duplicateMatches = row.duplicateMatches ?? 0;
  const currencyCount = row.currencyCount ?? (row.currency ? 1 : 0);
  let match: CostPriceMatch = row.priceMatchStatus ?? 'none';
  if (currencyCount > 1) match = 'mixed-currency';
  else if (duplicateMatches > 0 || match === 'duplicate') match = 'duplicate';
  else if (unpricedRows > 0 && pricedRows > 0) match = 'partial';
  else if (pricedRows === 0 && (unpricedRows > 0 || unpricedQuantity > 0)) match = 'unpriced';
  else if (pricedRows > 0) match = match === 'none' ? 'priced' : match;
  else if (row.spend !== null && Number.isFinite(row.spend) && match === 'none') match = 'priced';
  return {
    source: 'list_prices',
    match,
    currency: currencyCount > 1 ? '' : row.currency,
    pricedQuantity: row.pricedQuantity ?? 0,
    unpricedQuantity,
    pricedRows,
    unpricedRows,
    unpricedSkus: row.unpricedSkus ?? [],
    duplicateMatches,
    correctionRows: row.correctionRows ?? 0,
    priceEffectiveAt: row.priceEffectiveAt ?? '',
  };
}

export function attributionFor(population: string, amount: number | null): CostAttributionScope {
  if (population === 'Whole warehouse' || population === 'Whole workspace') return 'shared-upper-bound';
  if (amount === null) return 'unavailable';
  return 'deployment';
}

export function spendAmountFor(row: ComponentRow | undefined, basis: CostTile['basis']): number | null {
  if (!row) return null;
  const pricing = pricingFromRow(row);
  if (
    pricing.match === 'unpriced' ||
    pricing.match === 'partial' ||
    pricing.match === 'duplicate' ||
    pricing.match === 'mixed-currency'
  ) {
    return null;
  }
  if (row.spend === null || !Number.isFinite(row.spend)) return null;
  if (pricing.match === 'priced' || pricing.match === 'none') {
    return basis === 'per-day' ? row.spend / Math.max(row.billedDays, 1) : row.spend;
  }
  return null;
}

export function unpricedUnavailable(pricing: CostTilePricing): string {
  if (pricing.match === 'duplicate') return 'Duplicate list prices; spend withheld';
  if (pricing.match === 'mixed-currency') return 'Mixed currencies; spend withheld';
  if (pricing.match === 'partial') {
    const skus = pricing.unpricedSkus.slice(0, 4).join(', ');
    return skus
      ? `Partial list-price coverage; spend withheld. Unpriced SKUs: ${skus}`
      : 'Partial list-price coverage; spend withheld';
  }
  if (pricing.match === 'unpriced') {
    const skus = pricing.unpricedSkus.slice(0, 4).join(', ');
    return skus ? `Unpriced SKUs: ${skus}` : 'Usage has no matching list price';
  }
  return '';
}

export function buildHonesty(range: CostRange, meta: ComponentRow | undefined, tiles: CostTile[]): CostHonesty {
  const currencies = new Set(
    tiles.map((tile) => tile.pricing?.currency).filter((code): code is string => Boolean(code))
  );
  const through = meta?.lastDay || '';
  return {
    priceSource: 'list_prices',
    contractRates: 'unavailable',
    dataThrough: through,
    rangeMayStillFill: Boolean(through && through < range.to) || !through,
    currencyConsistent: currencies.size <= 1,
  };
}

export function buildCoverage(input: {
  inventoryCount: number;
  coverageRows: ComponentRow[];
  propagationRows: ComponentRow[];
  range: CostRange;
  meta?: ComponentRow;
  appBillingTag?: AppBillingTagState;
}): CostCoverage {
  const products: CostCoverageProduct[] = [];
  const seen = new Set<string>();
  for (const row of input.coverageRows) {
    if (row.component === 'JOBS') continue;
    seen.add(row.component);
    const tiled = TILED_PRODUCTS.has(row.component) || row.component === 'GENIE';
    products.push({
      product: row.component,
      taggedRows: row.taggedRows || (row.pricedRows ?? 0) + (row.unpricedRows ?? 0),
      taggedQuantity: (row.pricedQuantity ?? 0) + (row.unpricedQuantity ?? 0),
      pricedRows: row.pricedRows ?? 0,
      unpricedRows: row.unpricedRows ?? 0,
      tiled,
      reason:
        PRODUCT_REASONS[row.component] ?? (tiled ? 'On the tracked cost grid.' : 'Tagged usage with no Cost tile.'),
    });
  }
  for (const [product, reason] of Object.entries(PRODUCT_REASONS)) {
    if (seen.has(product)) continue;
    if (product === 'MLFLOW' || product === 'LAKEBASE') {
      products.push({
        product,
        taggedRows: 0,
        taggedQuantity: 0,
        pricedRows: 0,
        unpricedRows: 0,
        tiled: false,
        reason,
      });
    }
  }
  const through = input.meta?.lastDay || '';
  const delayed = Boolean(through && through < input.range.to);
  const propagation: CostPropagation[] = input.propagationRows
    .filter((row) => row.component !== 'JOBS')
    .map((row) => {
      if (row.component === 'APPS') {
        const pair = billingTagPair();
        const assignment =
          input.appBillingTag === 'matched'
            ? `${pair} is assigned to this app.`
            : input.appBillingTag === 'missing'
              ? `${pair} is not assigned to this app.`
              : `The app's ${pair} assignment could not be read.`;
        return {
          product: 'APPS',
          status: 'unsupported' as const,
          detail: `${assignment} App spend is measured separately by exact app name; billing-row tag propagation is not required.`,
        };
      }
      if (row.component === 'GENIE') {
        return {
          product: 'GENIE',
          status: 'unsupported' as const,
          detail: GENIE_LLM_UNAVAILABLE + ' ' + GENIE_SQL_NOT_COMPLETE,
        };
      }
      if ((row.taggedRows ?? 0) > 0) {
        return {
          product: row.component,
          status: 'propagated',
          detail: `${row.taggedRows} tagged billing rows in this range.`,
        };
      }
      if ((row.untaggedRows ?? 0) > 0) {
        return {
          product: row.component,
          status: 'unpropagated',
          detail: `${row.untaggedRows} matching usage rows have no ${BILLING_TAG.key}=${BILLING_TAG.value} tag.`,
        };
      }
      if (delayed) {
        return {
          product: row.component,
          status: 'delayed',
          detail: `Billing data through ${through}. Later days in this range may still be filling.`,
        };
      }
      return { product: row.component, status: 'unused', detail: 'No matching usage rows in this range.' };
    });
  return {
    inventoryCount: input.inventoryCount,
    costModelCount: COST_COMPONENTS.length,
    products,
    propagation,
  };
}

/**
 * How each tile describes itself.
 *
 * The quality and the population live together here, one entry per component, so
 * a tile cannot be drawn with another tile's claim about how good its number is.
 *
 * EVERY FIELD IS NOW A CHIP RATHER THAN A SENTENCE. Each entry used to carry a
 * `qualityNote` of one or two clauses and a population of one more, which put
 * three or four lines of prose around a single figure in a card fifteen
 * characters wide: the cards overflowed, no two in a row were the same height,
 * and two of the seven were nothing but the paragraph. What the prose was
 * carrying that had to survive is the POPULATION -- Genie and telemetry
 * ingestion are billed to the whole workspace, and a reader who takes either for
 * this deployment's own spend has misread the block in the most expensive
 * direction available on it. So the population stays, in the fewest words that
 * still say whose money it is, and the quality keeps its badge with no sentence
 * after it.
 *
 * `variable` is '' where there is genuinely nothing to set, which is the vector
 * search endpoint: nothing hands this app that name, the index reports which
 * endpoint serves it, and the generic remedy therefore used to name a variable
 * nobody can set. A remedy a reader cannot carry out is worse than none.
 */
const DESCRIPTIONS: Record<
  CostComponent,
  {
    label: string;
    quality: CostQuality;
    population: string;
    basis: CostTile['basis'];
    variable: string;
  }
> = {
  'serving-endpoint': {
    label: 'Serving endpoint',
    // This tile is the endpoint's measured total. `per-token` belongs only on
    // the run rows built below, after that total has actually been apportioned
    // by recorded tokens. Calling the numerator per-token before doing that was
    // the precise estimate-as-measurement failure this module forbids.
    quality: 'real',
    population: 'This endpoint',
    basis: 'total-in-range',
    variable: 'DATABRICKS_SERVING_ENDPOINT_NAME',
  },
  'foundation-model': {
    label: 'Foundation model',
    quality: 'unknown',
    population: 'Shared endpoint',
    basis: 'total-in-range',
    variable: '',
  },
  'sql-warehouse': {
    label: 'SQL warehouse',
    quality: 'estimate',
    population: 'Whole warehouse',
    basis: 'total-in-range',
    variable: 'DATABRICKS_SQL_WAREHOUSE_ID',
  },
  genie: {
    label: 'Genie',
    quality: 'estimate',
    population: 'Whole workspace',
    basis: 'total-in-range',
    variable: 'DATABRICKS_WORKSPACE_ID',
  },
  'vector-search': {
    label: 'Vector search',
    quality: 'rate',
    population: 'This endpoint',
    basis: 'per-day',
    variable: '',
  },
  'app-compute': {
    label: 'App compute',
    quality: 'rate',
    population: 'This app',
    basis: 'per-day',
    variable: 'DATABRICKS_APP_NAME',
  },
};

/**
 * Turn the rows into the tiles the page draws, one per component, always six.
 *
 * Always six because a tile that disappears when its figure does takes the
 * explanation with it. A reader looking for the index cost needs to be told
 * that nothing identifies the job on this deployment; an absent tile tells them
 * nothing and reads as an app that forgot.
 */
/**
 * Turn the rows into the tiles the page draws.
 *
 * Genie is one tile per configured space, because a single workspace-wide card
 * cannot be opened. Vector Search names the index when this deployment has a
 * three-level name, so the title can open a real page rather than a guessed
 * endpoint URL.
 */
export function buildTiles(ids: CostIdentifiers, rows: ComponentRow[]): CostTile[] {
  const byComponent = new Map(
    rows.filter((row) => (row.kind ?? 'component') === 'component').map((row) => [row.component, row])
  );
  const tiles: CostTile[] = [];

  for (const component of COST_COMPONENTS) {
    if (component === 'genie') {
      tiles.push(...genieSpaceTiles(ids));
      continue;
    }
    tiles.push(componentTile(component, ids, byComponent));
  }
  return tiles;
}

function genieSpaceTiles(ids: CostIdentifiers): CostTile[] {
  const spaces = ids.genieSpaces.filter((space) => space.id.trim());
  if (spaces.length === 0) {
    return [
      {
        id: 'genie',
        label: 'Genie',
        resourceId: '',
        resourceKind: '',
        quality: 'unknown',
        amount: null,
        basis: 'total-in-range',
        population: 'Whole workspace',
        attribution: 'unavailable',
        pricing: { ...EMPTY_PRICING },
        unavailable: GENIE_LLM_UNAVAILABLE,
        remedy: 'Genie space identifier unavailable',
        note: GENIE_SQL_NOT_COMPLETE,
      },
    ];
  }
  return spaces.map((space) => ({
    id: `genie:${space.id.trim()}`,
    label: space.label.trim() || 'Genie space',
    resourceId: space.id.trim(),
    resourceKind: 'genie-space' as const,
    quality: 'unknown' as const,
    amount: null,
    basis: 'total-in-range' as const,
    population: 'This space',
    attribution: 'unavailable' as const,
    pricing: { ...EMPTY_PRICING },
    unavailable: GENIE_LLM_UNAVAILABLE,
    remedy: '',
    note: GENIE_SQL_NOT_COMPLETE,
  }));
}

/**
 * App compute availability is decided by the app-name billing join.
 *
 * The organizational tag is useful inventory context, but it is not evidence
 * that any Apps billing row matched this app and must never replace that state.
 */
function appComputeAbsence(state: AppBillingTagState): { unavailable: string; remedy: string; note: string } {
  const pair = billingTagPair();
  if (state === 'matched') {
    return {
      unavailable: 'No Apps billing rows matched this app in this range.',
      remedy: '',
      note: `${pair} is on this app; Apps billing is matched by app name.`,
    };
  }
  if (state === 'missing') {
    return {
      unavailable: 'No Apps billing rows matched this app in this range.',
      remedy: '',
      note: `${pair} is not on this app; Apps billing is still matched by app name.`,
    };
  }
  return {
    unavailable: 'No Apps billing rows matched this app in this range.',
    remedy: '',
    note: `The app tag ${pair} could not be read; Apps billing is matched by app name.`,
  };
}

function componentTile(
  component: Exclude<CostComponent, 'genie'>,
  ids: CostIdentifiers,
  byComponent: Map<string, ComponentRow>
): CostTile {
  const description = DESCRIPTIONS[component];
  const base = {
    id: component,
    label: description.label,
    resourceId: resourceIdFor(component, ids),
    resourceKind: resourceKindFor(component, ids),
    quality: description.quality,
    basis: description.basis,
    population: description.population,
  };

  const withMeta = (
    tile: Omit<CostTile, 'attribution' | 'pricing'> & { pricing?: CostTilePricing | null }
  ): CostTile => {
    const pricing = tile.pricing ?? EMPTY_PRICING;
    const amount = tile.amount;
    const unpriced = unpricedUnavailable(pricing);
    return {
      ...tile,
      quality: unpriced ? 'unknown' : tile.quality,
      amount: unpriced ? null : amount,
      attribution: attributionFor(tile.population, unpriced ? null : amount),
      pricing,
      unavailable: tile.unavailable || unpriced,
      note: tile.note,
    };
  };

  if (component === 'foundation-model') {
    return withMeta({
      ...base,
      quality: 'unknown',
      amount: null,
      note: '',
      unavailable: 'Whole shared endpoint spend is withheld because this app has not proven ownership of the endpoint.',
      remedy: '',
    });
  }

  if (component === 'serving-endpoint' && ids.endpointName && ids.endpointName === ids.foundationEndpoint) {
    return withMeta({
      ...base,
      quality: 'unknown',
      population: 'Shared endpoint',
      amount: null,
      note: '',
      unavailable: 'Whole shared endpoint spend is withheld because this app has not proven ownership of the endpoint.',
      remedy: '',
    });
  }

  if (!canAsk(component, ids)) {
    const pricing = EMPTY_PRICING;
    if (component === 'vector-search') {
      return withMeta({
        ...base,
        quality: 'unknown',
        amount: null,
        pricing,
        note: '',
        unavailable: base.resourceId ? 'No billing rows' : 'Vector Search index identifier unavailable',
        remedy: '',
      });
    }
    return withMeta({
      ...base,
      quality: 'unknown',
      amount: null,
      pricing,
      note: '',
      unavailable: 'Resource identifier unavailable',
      remedy: description.variable ? `Set ${description.variable}.` : '',
    });
  }

  const row = byComponent.get(component);
  const pricing = pricingFromRow(row);
  const amount = spendAmountFor(row, description.basis);
  if (amount === null) {
    if (component === 'app-compute' && pricing.match === 'none') {
      const absence = appComputeAbsence(ids.appBillingTag);
      return withMeta({
        ...base,
        amount: null,
        pricing,
        note: absence.note,
        unavailable: absence.unavailable,
        remedy: absence.remedy,
      });
    }
    return withMeta({
      ...base,
      amount: null,
      pricing,
      note: '',
      unavailable: unpricedUnavailable(pricing) || 'No billing rows',
      remedy: '',
    });
  }

  return withMeta({ ...base, amount, pricing, note: '', unavailable: '', remedy: '' });
}

/*
 * NOTHING HERE SUMS THE COMPONENTS, and nothing should.
 *
 * There was a `headline` here that added five of the six together and divided
 * the total by the questions asked in the range. Every rule the block applies to
 * a rate was applied to it -- it named its denominator, it refused a division by
 * no questions, it excluded the Genie row because no key narrows that spend to
 * this app -- and the figure was meaningless anyway. Most of what it summed is
 * billed by TIME: a warehouse and a serving endpoint charge for the hours they
 * exist, so the average FELL as the deployment was used more, and at sixteen
 * questions it read as fifty-seven dollars a question.
 *
 * A cross-quality total is the thing this file's opening rule forbids, and the
 * per-question division was the only reason one was ever computed. Both are
 * gone. See the note on {@link OpsCostPayload} in the shared contract.
 */

/** A completed run as read from Lakebase, before billing is apportioned to it. */
export interface QuestionRunInput {
  runId: string;
  correlationId: string;
  traceId: string;
  completedAt: string;
  totalTokens: number | null;
  runsInRange: number;
  tokenCoveredRuns: number;
  totalRecordedTokens: number;
}

const UNKNOWN_QUESTION_PARTS: readonly Omit<Extract<QuestionCostPart, { quality: 'unknown' }>, 'amount' | 'quality'>[] =
  [
    {
      id: 'genie',
      label: 'Genie spaces',
      unavailable:
        'Space tags are organizational only. Genie LLM spend is not attributable in this model; Genie SQL is billed through the associated warehouse and is not the complete Genie cost.',
    },
    {
      id: 'vector-search',
      label: 'Vector search',
      unavailable: 'Endpoint time is billed as a rate and cannot be joined to one query.',
    },
    {
      id: 'app-compute',
      label: 'App compute',
      unavailable: 'Compute time cannot be joined to one run.',
    },
    {
      id: 'lakebase',
      label: 'Lakebase Postgres',
      unavailable: 'No documented billing row in this app can be joined to a Lakebase query or run.',
    },
  ];

function unknownPart(id: string, label: string, unavailable: string): QuestionCostPart {
  return { id, label, quality: 'unknown', amount: null, unavailable };
}

/**
 * Apportion the two components for which the app has a defensible denominator.
 *
 * Serving uses each run's recorded token share of the endpoint total. SQL uses
 * an explicitly even allocation of the warehouse total across completed runs:
 * useful for understanding the range, but still an estimate and never eligible
 * for a measured total. Every other component is returned as an unavailable
 * part rather than silently omitted.
 */
export function buildQuestionAttribution(
  runs: QuestionRunInput[],
  tiles: CostTile[],
  limit: number
): QuestionCostAttribution {
  const newest = runs.slice(0, limit);
  const first = runs[0];
  const runsInRange = first?.runsInRange ?? 0;
  const tokenCoveredRuns = first?.tokenCoveredRuns ?? 0;
  const totalRecordedTokens = first?.totalRecordedTokens ?? 0;
  const servingTile = tiles.find((tile) => tile.id === 'serving-endpoint');
  const servingSpend = servingTile?.amount;
  const sqlSpend = tiles.find((tile) => tile.id === 'sql-warehouse')?.amount;

  const attributed: QuestionCostRun[] = newest.map((run) => {
    const parts: QuestionCostPart[] = [];
    if (
      run.totalTokens !== null &&
      run.totalTokens >= 0 &&
      typeof servingSpend === 'number' &&
      Number.isFinite(servingSpend) &&
      totalRecordedTokens > 0
    ) {
      parts.push({
        id: 'serving-endpoint',
        label: 'Model serving',
        /*
         * Token shares of an endpoint total are per-token. Token shares of a
         * workspace-wide estimate are still that estimate, divided. Labelling
         * the second per-token was the same quality lie the tile itself already
         * refuses when the endpoint name is missing.
         */
        quality: servingTile?.quality === 'real' ? 'per-token' : 'estimate',
        amount: (servingSpend * run.totalTokens) / totalRecordedTokens,
        unavailable: '',
      });
    } else {
      parts.push(
        unknownPart(
          'serving-endpoint',
          'Model serving',
          run.totalTokens === null
            ? 'This run recorded no token count.'
            : 'No endpoint spend was measured for this range.'
        )
      );
    }

    if (typeof sqlSpend === 'number' && Number.isFinite(sqlSpend) && runsInRange > 0) {
      parts.push({
        id: 'sql-warehouse',
        label: 'SQL warehouse',
        quality: 'estimate',
        amount: sqlSpend / runsInRange,
        unavailable: '',
      });
    } else {
      parts.push(
        unknownPart('sql-warehouse', 'SQL warehouse', 'No warehouse spend was available to allocate in this range.')
      );
    }

    parts.push(
      ...UNKNOWN_QUESTION_PARTS.map((part): QuestionCostPart => ({ ...part, quality: 'unknown', amount: null }))
    );
    return {
      runId: run.runId,
      correlationId: run.correlationId,
      traceId: run.traceId,
      completedAt: run.completedAt,
      totalTokens: run.totalTokens,
      parts,
    };
  });

  return {
    runs: attributed,
    runsInRange,
    tokenCoveredRuns,
    totalRecordedTokens,
    limited: runsInRange > attributed.length,
    reason: runsInRange === 0 ? 'No completed runs were recorded in this billing range.' : '',
  };
}
