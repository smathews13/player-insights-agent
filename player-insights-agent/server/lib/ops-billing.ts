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
 *   JOBS              usage_metadata.job_id, usage_metadata.job_run_id
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

import type {
  CostQuality,
  CostTile,
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
  'sql-warehouse',
  'genie',
  'vector-search',
  'app-compute',
  'index-rebuild-job',
] as const;

export type CostComponent = (typeof COST_COMPONENTS)[number];

/**
 * What this deployment calls its own resources.
 *
 * Every field may be empty, and empty is handled rather than defaulted. The app
 * genuinely does not know some of these: the vector search endpoint is read off
 * a probe rather than configuration, and the rebuild job id is not exposed to
 * the app at all.
 */
export interface CostIdentifiers {
  /** `DATABRICKS_APP_NAME`. */
  appName: string;
  /** `DATABRICKS_SERVING_ENDPOINT_NAME`. */
  endpointName: string;
  /** `DATABRICKS_SQL_WAREHOUSE_ID`. */
  warehouseId: string;
  /** Resolved from the index probe on the health block, not from configuration. */
  vectorEndpoint: string;
  /** `PLAYER_INSIGHTS_INDEX_REBUILD_JOB_ID`. Not set on any deployment today. */
  rebuildJobId: string;
  /** `DATABRICKS_WORKSPACE_ID`. The only handle Genie and telemetry have. */
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
  'index-rebuild-job': {
    product: 'JOBS',
    column: 'u.usage_metadata.job_id',
    parameter: 'rebuildJobId',
    type: 'STRING',
  },
};

/** The row this statement adds so the block can date itself even with no matches. */
export const RANGE_ROW = '__range';
export const BILLING_TAG_KEY = 'astrolabe';

/**
 * Whether this deployment knows enough to ask about a component.
 *
 * Genie needs a workspace id and nothing else; the rest need their own
 * identifier.
 */
export function canAsk(component: CostComponent, ids: CostIdentifiers): boolean {
  return Boolean(ids[MATCHERS[component].parameter]);
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
  // Only where the workspace itself is identified. See the note on
  // WORKSPACE_ESTIMATE_SUFFIX: without that predicate there is nothing keeping
  // the figure inside one workspace, and a wider total is not a safer one.
  const estimated = ids.workspaceId
    ? COST_COMPONENTS.filter((component) => !canAsk(component, ids) && MATCHERS[component].column !== null)
    : [];
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
        `THEN '${workspaceEstimateRow(component)}'`
    );
  }

  const statement = `WITH priced AS (
  SELECT
    u.usage_date,
    u.usage_quantity * COALESCE(p.pricing.default, 0) AS spend,
    p.currency_code,
    u.usage_metadata.job_run_id AS job_run_id,
    CASE
${branches.join('\n')}
      ELSE NULL
    END AS component
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
   AND u.cloud = p.cloud
   AND u.usage_end_time >= p.price_start_time
   AND (p.price_end_time IS NULL OR u.usage_end_time < p.price_end_time)
  WHERE u.usage_date >= :from_day
    AND u.usage_date <= :to_day
    AND u.custom_tags['${BILLING_TAG_KEY}'] IS NOT NULL
)
SELECT
  component,
  SUM(spend) AS spend,
  MAX(currency_code) AS currency,
  COUNT(DISTINCT usage_date) AS billed_days,
  COUNT(DISTINCT job_run_id) AS job_runs,
  MAX(usage_date) AS last_day
FROM priced
WHERE component IS NOT NULL
GROUP BY component
UNION ALL
SELECT
  '${RANGE_ROW}' AS component,
  CAST(NULL AS DOUBLE) AS spend,
  MAX(currency_code) AS currency,
  COUNT(DISTINCT usage_date) AS billed_days,
  CAST(NULL AS BIGINT) AS job_runs,
  MAX(usage_date) AS last_day
FROM priced`;

  return { statement, parameters, covered, estimated };
}

/** One component's figures, as read back. */
export interface ComponentRow {
  component: string;
  spend: number | null;
  currency: string;
  billedDays: number;
  jobRuns: number | null;
  lastDay: string;
}

/**
 * Read the statement's rows without inventing any.
 *
 * The API returns every value as a string or null, so a null spend stays null
 * here rather than becoming zero on the way through `Number()`. That single
 * coercion is how a tile would come to promise a figure nothing measured.
 */
export function readComponentRows(dataArray: unknown): ComponentRow[] {
  if (!Array.isArray(dataArray)) return [];
  const rows: ComponentRow[] = [];
  for (const raw of dataArray) {
    if (!Array.isArray(raw) || raw.length < 6) continue;
    const [component, spend, currency, billedDays, jobRuns, lastDay] = raw as (string | null)[];
    if (typeof component !== 'string') continue;
    rows.push({
      component,
      spend: spend === null || spend === undefined || spend === '' ? null : Number(spend),
      currency: typeof currency === 'string' ? currency : '',
      billedDays: billedDays ? Number(billedDays) : 0,
      jobRuns: jobRuns === null || jobRuns === undefined || jobRuns === '' ? null : Number(jobRuns),
      lastDay: typeof lastDay === 'string' ? lastDay : '',
    });
  }
  return rows;
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
  'index-rebuild-job': {
    label: 'Index rebuild job',
    quality: 'real',
    population: 'This job',
    basis: 'total-in-range',
    variable: 'PLAYER_INSIGHTS_INDEX_REBUILD_JOB_ID',
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
export function buildTiles(ids: CostIdentifiers, rows: ComponentRow[]): CostTile[] {
  const byComponent = new Map(rows.map((row) => [row.component, row]));

  return COST_COMPONENTS.map((component): CostTile => {
    const description = DESCRIPTIONS[component];
    const base = {
      id: component,
      label: description.label,
      quality: description.quality,
      basis: description.basis,
      population: description.population,
    };

    if (!canAsk(component, ids)) {
      // A workspace-wide figure, if the statement got one, RELABELLED as what it
      // is. Both overrides matter: the population so a reader cannot take it for
      // this deployment, and the quality because the narrowed tile's claim does
      // not survive the widening -- a whole-workspace serving total is not
      // per-token for this endpoint. The remedy still names the variable that
      // would turn this into the real thing.
      const estimate = byComponent.get(workspaceEstimateRow(component));
      if (estimate && estimate.spend !== null && Number.isFinite(estimate.spend)) {
        return {
          ...base,
          quality: 'estimate',
          population: 'Whole workspace',
          amount: description.basis === 'per-day' ? estimate.spend / Math.max(estimate.billedDays, 1) : estimate.spend,
          note: '',
          unavailable: '',
          remedy: description.variable ? `Set ${description.variable} to narrow this to this deployment.` : '',
        };
      }
      // A state and, where one exists, the one thing that would change it. This
      // was a two-sentence paragraph per card, and on the two deployments where
      // both of these cards were unattributable the paragraph was the entire
      // card: no figure above it and nothing to do about it below.
      return {
        ...base,
        amount: null,
        note: '',
        unavailable: 'Not attributable',
        remedy: description.variable ? `Set ${description.variable}.` : '',
      };
    }

    const row = byComponent.get(component);
    if (!row || row.spend === null || !Number.isFinite(row.spend)) {
      if (component === 'app-compute') {
        return {
          ...base,
          amount: null,
          note: '',
          unavailable: 'Billing tag match unverified',
          remedy: 'Verify whether app compute propagates the Astrolabe billing tag.',
        };
      }
      return { ...base, amount: null, note: '', unavailable: 'No billing rows', remedy: '' };
    }

    const amount = description.basis === 'per-day' ? row.spend / Math.max(row.billedDays, 1) : row.spend;
    // A second FIGURE, never a second sentence. The vector search tile carried a
    // paragraph here about a usage count this deployment does not record, which
    // is a fact about our instrumentation rather than about anybody's bill.
    const note =
      component === 'index-rebuild-job' && row.jobRuns !== null
        ? `${row.jobRuns} ${row.jobRuns === 1 ? 'run' : 'runs'}`
        : '';

    return { ...base, amount, note, unavailable: '', remedy: '' };
  });
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
      unavailable: 'Billing exposes workspace spend but no run or space attribution key.',
    },
    {
      id: 'vector-search',
      label: 'Vector search',
      unavailable: 'Endpoint time is billed as a rate and cannot be joined to one query.',
    },
    {
      id: 'app-compute',
      label: 'App compute',
      unavailable: 'Compute time cannot be joined to one run; billing-tag propagation also needs live verification.',
    },
    {
      id: 'index-rebuild-job',
      label: 'Index rebuild job',
      unavailable: 'A rebuild is shared maintenance work rather than work caused by one question.',
    },
    {
      id: 'foundation-model',
      label: 'Foundation model',
      unavailable: 'The foundation-model endpoint identifier is not recorded with the run today.',
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
