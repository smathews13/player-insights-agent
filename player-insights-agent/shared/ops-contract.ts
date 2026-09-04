import type { CostBudgets } from './cost-budgets';
import type { SpendByUserPayload } from './user-spend-contract';
import type { UserMonitoringPayload } from './user-monitoring-contract';
import type { CheckVerdict } from './check-verdict';

/**
 * What the three Ops blocks answer with, declared once for both sides.
 *
 * The Ops tab is three blocks that load, fail and timestamp separately: health,
 * cost, traffic. That independence is the whole design, and it is the reason
 * this file declares three payloads rather than one. A single `OpsPayload`
 * would be filled by a single route, a single route is a single failure, and a
 * slow billing query would then hold up the block that says whether the
 * warehouse is answering. The types are separate so that arrangement cannot be
 * arrived at by accident.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. Every figure on Ops carries the quality
 * of its own measurement, and the quality travels WITH the number rather than
 * being decided by whichever component draws it. A tile is `{ amount,
 * quality }`, not a number the page labels afterwards, because a label applied
 * at the call site is a label that can be forgotten at the next call site. This
 * app has already shipped one panel that promised figures it discarded and one
 * summary line counting something other than the rows beneath it; both were
 * possible because the number and the claim about it lived apart.
 */

/**
 * How good a cost figure is. Five qualities, and they are never added together.
 *
 * Section 7.3 of the plan names them and says why a total that mixes them is
 * worse than no total: a reader who cannot tell a measurement from an
 * apportionment will act on the apportionment.
 */
export type CostQuality =
  /** Billed per unit of the thing itself. A measurement. */
  | 'real'
  /** Billed per token, divided by the tokens each run recorded. Close, and it names its coverage. */
  | 'per-token'
  /** An hour's spend apportioned across the work in that hour. An apportionment. */
  | 'estimate'
  /** Billed by wall-clock time. Not divisible across runs at all. */
  | 'rate'
  /** No defensible attribution exists with the identifiers recorded today. */
  | 'unknown';

/** The words each quality is shown as. One place, so two tiles cannot disagree. */
export const COST_QUALITY_LABEL: Record<CostQuality, string> = {
  real: 'Real',
  'per-token': 'Per token',
  estimate: 'Estimate',
  rate: 'Rate',
  unknown: 'Not knowable',
};

/**
 * One cost tile.
 *
 * `amount` is `null` when the figure could not be sourced, and the tile then
 * renders `unavailable` instead. Null is not zero: a component nobody could
 * attribute and a component that cost nothing are different facts, and drawing
 * the first as `$0.00` is the invented number the honesty rules forbid.
 */
/** The workspace object a cost tile can open, when it can open one. */
export type CostResourceKind =
  | 'serving-endpoint'
  | 'sql-warehouse'
  | 'app'
  | 'genie-space'
  | 'vector-index'
  | 'vector-endpoint';

/**
 * Whose money a tile's figure is, independent of the chip wording.
 *
 * Display text can change; this cannot. A whole-warehouse meter compared to an
 * app budget is a false overage unless the comparison knows the figure is a
 * shared upper bound.
 */
export type CostAttributionScope = 'deployment' | 'shared-upper-bound' | 'unavailable';

/**
 * How the list-price join resolved for a tile.
 *
 * `priced` is the only status that may be compared as measured spend.
 * Unpriced, duplicate, or mixed-currency rows must not render as $0.00.
 */
export type CostPriceMatch = 'priced' | 'unpriced' | 'partial' | 'duplicate' | 'mixed-currency' | 'none';

/** List-price join evidence for one tile. Contracted rates are not available here. */
export interface CostTilePricing {
  source: 'list_prices';
  match: CostPriceMatch;
  currency: string;
  pricedQuantity: number;
  unpricedQuantity: number;
  pricedRows: number;
  unpricedRows: number;
  unpricedSkus: readonly string[];
  duplicateMatches: number;
  correctionRows: number;
  priceEffectiveAt: string;
}

export type CostPropagationStatus = 'propagated' | 'unpropagated' | 'delayed' | 'unused' | 'unsupported';

export interface CostCoverageProduct {
  product: string;
  taggedRows: number;
  taggedQuantity: number;
  pricedRows: number;
  unpricedRows: number;
  tiled: boolean;
  reason: string;
}

export interface CostPropagation {
  product: string;
  status: CostPropagationStatus;
  detail: string;
}

/**
 * Tag propagation vs the tracked identity-attributed tiles, so a successful tag repair cannot be
 * mistaken for complete cost coverage.
 */
export interface CostCoverage {
  inventoryCount: number;
  costModelCount: number;
  products: CostCoverageProduct[];
  propagation: CostPropagation[];
}

export interface CostHonesty {
  priceSource: 'list_prices';
  contractRates: 'unavailable';
  dataThrough: string;
  rangeMayStillFill: boolean;
  currencyConsistent: boolean;
}

export type QueryHistoryCoverageReason =
  | 'invalid-range'
  | 'range-clamped'
  | 'page-cap'
  | 'repeated-page-token'
  | 'missing-page-token'
  | 'deadline'
  | 'caller-abort'
  | 'transport-error'
  | 'invalid-row'
  | 'unexpected-warehouse'
  | 'missing-execution-time'
  | 'interactive-run-coverage';

/**
 * What the Query History read actually established.
 *
 * A partial range can still carry useful counts, but it can never be used as a
 * cost denominator. Timestamps are ISO strings so the API payload is directly
 * inspectable without knowing the server clock representation.
 */
export interface QueryHistoryCoverage {
  state: 'complete' | 'partial' | 'unavailable';
  requestedRange: { from: string; to: string } | null;
  queriedRange: { from: string; to: string } | null;
  rowsRead: number;
  pagesRead: number;
  chunksRead: number;
  reasons: QueryHistoryCoverageReason[];
}

export interface CostTile {
  id: string;
  /** What it is, in the reader's words. */
  label: string;
  /**
   * The workspace identifier this tile's spend is for, or '' if there is none.
   *
   * Warehouse id, serving-endpoint name, app name, Genie space id, or a
   * three-level Vector Search index. Empty when this deployment cannot name the
   * object. The page builds a Databricks link from this and the live workspace
   * host; it does not invent a host or a path.
   */
  resourceId: string;
  /** A second configured identifier shown in the title, such as the endpoint serving a Vector Search index. */
  secondaryResourceId?: string;
  /**
   * What `resourceId` is, when the page can open it. Absent or '' when there is
   * no verified workspace path for this tile.
   */
  resourceKind?: CostResourceKind | '';
  quality: CostQuality;
  /** Spend, or null where it could not be sourced. */
  amount: number | null;
  /**
   * Attributable usage when every contributing billing row is measured in DBUs.
   * Null means the component cannot be compared with a DBU budget; dollars are
   * never converted into DBUs.
   */
  dbus?: number | null;
  /** Whether `amount` is the total over the range or a per-day rate. */
  basis: 'total-in-range' | 'per-day';
  /**
   * What this figure covers, as a chip of two or three words.
   *
   * EVERY FIGURE STILL NAMES ITS POPULATION, and this is the field that does it.
   * It was a sentence each, and the sentences went because the cards were four
   * lines of prose around one number. What could not go with them is the fact:
   * the Genie and telemetry figures are the WHOLE WORKSPACE's, and a reader who
   * takes either for this deployment's own spend has been handed one number for
   * two questions. 'Whole workspace' fits in a chip; the paragraph did not.
   */
  population: string;
  /**
   * Deployment-attributable vs a shared upper bound vs unavailable.
   *
   * Optional on older payloads; the page infers from `population` when absent.
   */
  attribution?: CostAttributionScope;
  /** List-price join evidence. Absent on older payloads. */
  pricing?: CostTilePricing | null;
  /** The state shown in place of a figure, e.g. 'Not attributable'. Empty when there is one. */
  unavailable: string;
  /** What to set to make this figure attributable. Empty where nothing would. */
  remedy: string;
  /** Extra FIGURE this tile carries beside its own, e.g. the run count. Never prose. */
  note: string;
  /**
   * Concise, non-dollar evidence for this resource.
   *
   * Counts only: no query text or execution identity may cross this boundary.
   * Null means the source cannot be mapped safely at this resource grain.
   */
  evidence?: {
    billingRows: number | null;
    astrolabeQueries: number | null;
    /** Completed interactive Ask requests used as the allocation population. */
    interactiveRequests?: number | null;
    /** Requests with the identifier and timing evidence required by this allocation. */
    coveredRequests?: number | null;
    /** Whether every eligible completed Ask has matched evidence for this component. */
    coverageComplete?: boolean;
    /** Eligible completed Asks with no matching component evidence. */
    missingEligibleRequests?: number;
    /** Shared-endpoint requests excluded because they are known non-Ask or external. */
    excludedRequests?: number;
    /** Requests excluded because more than one Ask interval could own them. */
    ambiguousRequests?: number;
    warehouseQueries?: number | null;
    queryHistoryComplete?: boolean;
    /** Exact read bounds and any reason the SQL denominator was withheld. */
    queryHistoryCoverage?: QueryHistoryCoverage;
    /**
     * Calls explicitly tagged with this exact resource id, and all observed
     * calls of the same tool. A smaller numerator means older telemetry or
     * calls to another configured resource, never permission to widen scope.
     */
    activity?: {
      calls: number;
      observedCalls: number;
      unit: 'requests' | 'queries';
    } | null;
    /**
     * Provider-reported usage for the configured nested foundation model.
     * Token counts are evidence only: they are never converted to DBUs.
     */
    tokens?: {
      input: number | null;
      output: number | null;
      total: number | null;
      cachedRead?: number;
      cacheWrite?: number;
      requests: number;
      coveredRequests: number;
    } | null;
  } | null;
  /** This configured Genie's contribution to the shared monthly accounting. */
  genieInstanceAccounting?: GenieInstanceAccounting | null;
}

export interface GenieSurfaceAccounting {
  surface: 'GENIE_CODE' | 'GENIE_ONE' | 'GENIE_AGENTS' | 'UNKNOWN';
  allowanceUsedDbus: number;
  promotionalDbus: number;
  chargedEffectiveDbus: number;
  chargedRawEquivalentDbus: number;
  unknownDbus: number;
  paidUsd: number | null;
}

export interface GenieInstanceAccounting {
  spaceId: string;
  label: string;
  tileId: string;
  attribution:
    | 'query-history-exact'
    | 'query-history-allocation'
    | 'app-ledger-exact'
    | 'app-ledger-allocation'
    | 'unattributed';
  /** Allocated source usage_quantity before allowance/promotion classification. */
  sourceDbus: number;
  allowanceUsedDbus: number;
  promotionalDbus: number;
  chargedEffectiveDbus: number;
  chargedRawEquivalentDbus: number;
  /** Free or otherwise measured DBUs whose allowance/promotion class could not be established. */
  unknownDbus: number;
  paidUsd: number | null;
  /** Notional USD value of free DBUs at the applicable paid Genie list price. */
  freeEquivalentUsd?: number | null;
  freeEquivalentPricingState?: 'priced' | 'partial' | 'unpriced';
  freeEquivalentPriceSource?: 'system.billing.list_prices';
  freeEquivalentPricedThrough?: string;
  underlyingTotalDbus: number;
  pricingState: 'priced' | 'partial' | 'unpriced' | 'none';
  surfaces: GenieSurfaceAccounting[];
}

export interface GenieUserAccounting {
  identity: string;
  allowanceUsedDbus: number;
  allowanceRemainingDbus: number;
  promotionalDbus: number;
  chargedEffectiveDbus: number;
  chargedRawEquivalentDbus: number;
  unknownDbus: number;
  paidUsd: number | null;
  freeEquivalentUsd?: number | null;
  freeEquivalentPricingState?: 'priced' | 'partial' | 'unpriced';
  freeEquivalentPriceSource?: 'system.billing.list_prices';
  freeEquivalentPricedThrough?: string;
  /** Per-space contributions; allowance remaining deliberately stays overall. */
  instances?: Array<Omit<GenieInstanceAccounting, 'surfaces' | 'pricingState'>>;
}

/**
 * Genie billing is monthly and identity-aware.
 *
 * Free allowance is human-only. Promotional usage is distinct from charged
 * usage, and `underlyingTotalDbus` reconciles the three without adding the
 * 25%-promotion uplift a second time.
 */
export interface GenieAccounting {
  month: string;
  throughDay: string;
  humanUsers: number;
  allowanceDbusPerUser: number;
  allowanceUsedDbus: number;
  allowanceRemainingDbus: number;
  allowanceUtilization: number;
  promotionalDbus: number;
  chargedEffectiveDbus: number;
  chargedRawEquivalentDbus: number;
  unknownDbus: number;
  paidUsd: number | null;
  freeEquivalentUsd?: number | null;
  freeEquivalentPricingState?: 'priced' | 'partial' | 'unpriced';
  freeEquivalentPriceSource?: 'system.billing.list_prices';
  freeEquivalentPricedThrough?: string;
  underlyingTotalDbus: number;
  pricingState: 'priced' | 'partial' | 'unpriced' | 'none';
  instances?: GenieInstanceAccounting[];
  unattributed?: GenieInstanceAccounting | null;
  reconciliation?: {
    sourceRows: number;
    sourceDbus: number;
    classifiedDbus: number;
    classificationDifferenceDbus: number;
    attributedDbus: number;
    unattributedDbus: number;
    attributedShare: number;
    /** Internal coverage counters; excluded workspace usage is never presented as app spend. */
    directDbus?: number;
    allocatedDbus?: number;
    excludedDbus?: number;
  };
  diagnostics: string[];
  users: GenieUserAccounting[];
}

export type AppSpendCompleteness = 'complete' | 'partial' | 'unavailable';

/** One paid app-attributable spend snapshot with explicit source coverage. */
export interface AppSpendFigure {
  amount: number | null;
  dbus: number | null;
  currency: string;
  sourceFrom: string;
  sourceThrough: string;
  completeness: AppSpendCompleteness;
  estimated: boolean;
}

/** Lifetime and current-month spend are peers; component cards remain current-month. */
export interface AppSpendSummary {
  lifetime: AppSpendFigure;
  currentMonth: AppSpendFigure;
}

/** One completed UTC calendar month's app-attributed billing total. */
export interface AppMonthlySpend {
  /** Calendar month as `YYYY-MM`. */
  month: string;
  /** USD total, null when the month has no authoritative priced rows. */
  amount: number | null;
  /** DBU total, null when the month has no authoritative DBU rows. */
  dbus: number | null;
  currency: string;
}

/** A missing grant, in the shape the app already uses for one. */
export interface GrantRemedy {
  object: string;
  privilege: string;
  statement: string;
}

/**
 * Why the cost block has no figures, when it has none.
 *
 * `no-grant` and `no-rows` are DIFFERENT STATES and the plan says so twice. The
 * first is a permission somebody can grant; the second is a range that billing
 * has not filled yet, which no grant fixes. A block that showed one sentence
 * for both would send an admin to ask for a privilege they already hold.
 */
export type CostState = 'ready' | 'no-rows' | 'no-grant' | 'unreadable' | 'no-warehouse';

/**
 * One component's contribution to one recorded question.
 *
 * UNKNOWN IS A DIFFERENT SHAPE, not a nullable measured figure. The discriminant
 * makes it impossible to put a number on a component whose billing rows cannot
 * be joined to a run: a renderer narrowing `quality === 'unknown'` receives only
 * `amount: null`, while every other quality must carry a finite amount.
 */
export type QuestionCostPart =
  | {
      id: string;
      label: string;
      quality: Exclude<CostQuality, 'unknown' | 'rate'>;
      amount: number;
      unavailable: '';
    }
  | {
      id: string;
      label: string;
      quality: 'unknown';
      amount: null;
      unavailable: string;
    };

/** One completed run, named without exposing the question text. */
export interface QuestionCostRun {
  runId: string;
  requestId?: string;
  correlationId: string;
  traceId: string;
  user?: string;
  startedAt?: string;
  completedAt: string;
  durationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens: number | null;
  cachedReadTokens?: number;
  cacheWriteTokens?: number;
  parts: QuestionCostPart[];
}

/**
 * Per-question attribution over the same complete-day range as the billing read.
 *
 * THERE IS DELIBERATELY NO TOTAL. The parts have incompatible qualities:
 * token-apportioned model serving, evenly allocated warehouse spend, and
 * components that cannot be joined to a question. Adding the first two would
 * turn an estimate into a measured-looking headline; adding either while
 * silently dropping the unknown parts would call an incomplete number "cost per
 * question". The list is the answer until every component has a defensible join.
 */
export interface QuestionCostAttribution {
  runs: QuestionCostRun[];
  /** All completed runs in range, including rows omitted by the display limit. */
  runsInRange: number;
  /** Runs whose answer recorded a usable token count. */
  tokenCoveredRuns: number;
  /** Tokens across every covered run, used as the serving allocation denominator. */
  totalRecordedTokens: number;
  /** Runs carrying safe request/correlation identifiers. */
  requestCoveredRuns?: number;
  /** Runs carrying an MLflow trace identifier. */
  traceCoveredRuns?: number;
  /** Runs carrying a valid start/end interval. */
  timingCoveredRuns?: number;
  /** True only when the complete succeeded-run population was returned. */
  complete?: boolean;
  /** True when only the newest runs are returned but the denominators still cover all. */
  limited: boolean;
  /** Why attribution is absent or partial. Empty only when the read itself answered. */
  reason: string;
}

export interface OpsCostPayload {
  /** Retrospective Ops reads are locked to the current budget calendar month. */
  period?: 'current_month';
  state: CostState;
  /** Present only when `state` is 'no-grant'. */
  grant: GrantRemedy | null;
  /** The sentence for 'unreadable' and 'no-warehouse'. Empty otherwise. */
  reason: string;
  /** From the billing rows themselves, never assumed. Empty when nothing was read. */
  currency: string;
  /** The last complete day the range covers, ISO date. Billing rows arrive late. */
  throughDay: string;
  /** The complete-day range the server actually queried, after validation and clamping. */
  range: OpsDayRange;
  /**
   * Complete days between the requested end and the newest billing row, or null
   * when no billing row established freshness.
   */
  billingLagDays: number | null;
  /** ISO stamp of this read. Per block, because the three will differ. */
  readAt: string;
  tiles: CostTile[];
  /** Paid app-attributable summary; free Genie notional value is excluded from both figures. */
  appSpend?: AppSpendSummary;
  /** The three most recent completed UTC calendar months, newest first. */
  recentMonthlySpend?: AppMonthlySpend[];
  /** Overall shared allowance plus exact, allocated, and unattributed instance reconciliation. */
  genieAccounting?: GenieAccounting | null;
  /** Convenience list for API consumers; absent only on legacy cached payloads. */
  genieInstances?: GenieInstanceAccounting[];
  /** Component-by-component attribution, never a cross-quality total. */
  perQuestion: QuestionCostAttribution;
  /**
   * Nominal budgets the operator set. Independent of billing rows: a missing
   * spend figure does not become $0.00, and a budget may still be stored.
   * `total` is the app cap; `resources` is keyed by tile id. They are not
   * summed, and Cost does not invent a total spend to compare `total` against.
   */
  budgets: CostBudgets;
  /** False when Lakebase could not be read, so Save retries that load. */
  budgetsReadable: boolean;
  /**
   * Tag propagation vs the tracked cost tiles. Absent on older payloads; the page
   * then draws the grid without a coverage strip.
   */
  coverage?: CostCoverage | null;
  /** List-price source, lag, and currency consistency. */
  honesty?: CostHonesty | null;
  /**
   * Server-authoritative human attribution over the same bounded cost window.
   *
   * Optional only for compatibility with older deployments and fixtures.
   */
  spendByUser?: SpendByUserPayload;
  /** Present only for the admin User Monitoring browser request. */
  userMonitoring?: UserMonitoringPayload;
}

/**
 * A dependency's result, in three states.
 *
 * `not-checked` is its own state and must never be rendered as either of the
 * others. Nothing here is ever drawn as pass or fail: a probe that did not run
 * has not said anything about the dependency, and a probe that ran established
 * one narrow thing rather than that a service works.
 *
 * THE WORDS ARE THE CHECK'S, NOT A CONVERSATION'S. They were answered, did not
 * answer and not checked, which is the vocabulary of the app's own question and
 * answer path -- on a table of resource health, beside pills reading "Ready" and
 * "Running", "Answered" read as something a person had asked the warehouse. What
 * each probe does is a metadata GET as the signed-in user, so the word for one
 * that came back is the word Connections has always used for the same call:
 * reachable. `not-answering` keeps the failing case about the probe rather than
 * about the network, because a refusal is one of the ways a probe does not come
 * back and the Notes cell carries the platform's own words for which it was.
 */
export type DependencyResult = 'answered' | 'did-not-answer' | 'not-checked';

export const DEPENDENCY_RESULT_LABEL: Record<DependencyResult, string> = {
  answered: 'Reachable',
  'did-not-answer': 'Not answering',
  'not-checked': 'Not checked',
};

export interface HealthDependency {
  /** The probe's own id, so a row can link to the same row on Connections. */
  id: string;
  /**
   * What the probe asked about, from the probe itself.
   *
   * A STABLE PROPERTY, WHICH IS WHY IT IS ON THE WIRE. The ids vary with what a
   * deployment configures; the kind does not. The Serving endpoint pill has twice
   * been keyed to a literal id and twice reported a healthy endpoint as unchecked
   * when that id was not among the rows, so it selects on this instead.
   */
  kind: string;
  /**
   * The Connections row this dependency is documented on, or ''.
   *
   * SET BY THE SERVER, WHICH IS THE ONLY SIDE THAT KNOWS. Most probe ids are
   * also connection resource ids and a link on them lands on the matching row.
   * Some are not: the Vector Search ENDPOINT is discovered from the index rather
   * than configured, and the table checks are one probe over a manifest. A link
   * built from the id alone would send those readers to Connections with nothing
   * highlighted, which looks like the page failing to find the row rather than
   * like a row that was never there. Empty means do not draw a link.
   */
  connectionsId: string;
  /** What it is, in the probe's own words. */
  label: string;
  /** The configured identifier probed. Never invented. */
  name: string;
  result: DependencyResult;
  /** Canonical probe verdict. Optional only for compatibility with older cached payloads. */
  verdict?: CheckVerdict;
  /** ISO stamp of the check this row reports. Empty where nothing has been checked. */
  lastCheckedAt: string;
  /** The probe's own reason, verbatim. Empty when it answered. */
  reason: string;
}

/**
 * One thing the platform says about itself, as opposed to something PIA probed.
 *
 * `state` is the platform's own word where there is one.
 *
 * A ROW OF THE HEALTH TABLE RATHER THAN A PILL OVER IT. These used to sit in the
 * block's head as a cluster of their own, apart from the table, so a reader could
 * not mistake a platform reading for a probe result. What that produced was two
 * places to look for one question -- is this deployment's serving endpoint up --
 * and a table whose own Result column said "Answered" beside a pill saying
 * "Ready" about the same endpoint. The distinction is now carried where it costs
 * nothing: each row's Result pill NAMES the resource and states its word, so
 * "Serving endpoint · Ready" is visibly the platform's sentence and
 * "SQL warehouse · Reachable" is visibly this app's.
 */
export interface PlatformReading {
  id: 'endpoint' | 'app' | 'lakebase';
  label: string;
  /** The platform's word, or '' where it could not be read. */
  state: string;
  /** Whether this was read at all. False renders 'Not checked', never a failure. */
  read: boolean;
  /**
   * The `HealthDependency` ids this reading speaks for, and the field that keeps
   * one badge from being drawn twice.
   *
   * SET BY THE SERVER, WHICH IS THE ONLY SIDE THAT KNOWS WHICH ROWS IT READ. The
   * endpoint reading is taken from the answer-path endpoints only, so it may not
   * speak for a judge endpoint row that happens to share its kind, and a client
   * matching on kind would put "Serving endpoint · Ready" on a row the reading
   * never looked at.
   *
   * EMPTY MEANS THE READING IS ITS OWN ROW. The app and Lakebase are not probed
   * as dependencies -- one is true by construction because the handler answered,
   * the other is a read of the app's own store -- so the table synthesises a row
   * for each rather than dropping the reading on the floor.
   */
  rows: string[];
  /**
   * The platform's own words about a reading that is not the good one, or ''.
   *
   * Only a reading that is its own row can carry this, and only Lakebase has one
   * to carry: a dependency row's note is the probe's, and this app never rewrites
   * either. It is the difference between "the store is not answering" and knowing
   * whether that was the pool or a revoked grant.
   */
  reason: string;
}

/**
 * Whether app telemetry is on, and whether this reader can see it.
 *
 * Four states, and each of them is an ordinary condition rather than an error.
 * Off is supported: telemetry is off by default, it is billed, and a deployment
 * may choose to leave it off. Configured-but-unreadable is a grant somebody
 * makes, and it is handled with the same object/privilege/statement pattern the
 * cost block uses for billing, because it is the same problem. Configured and
 * empty is what a deployment reads as on the day it is switched on, since
 * telemetry does not backfill and the tables begin filling at the next deploy.
 */
export type TelemetryState =
  /** No destination configured. Nothing is written and nothing is charged. */
  | 'not-enabled'
  /** Configured, but this reader has no SELECT on the table. */
  | 'no-grant'
  /** Configured and readable, and nothing has been recorded yet. */
  | 'no-rows-yet'
  /**
   * Configured, and the read did not come back, so nothing was established.
   *
   * THE FIFTH STATE, AND THE REASON IT EXISTS. A read that failed used to be
   * reported as 'no-rows-yet', which is a claim about the table rather than
   * about the attempt: the page printed "No telemetry history yet" over a
   * table holding thousands of rows, and the query underneath it had been
   * failing to compile for as long as anybody had looked. An operator reading
   * that heading concludes the platform is not writing and goes to check the
   * bundle, which is the one place the fault was not.
   *
   * `CostState` has always drawn this distinction, between 'no-rows' and
   * 'unreadable', for the same reason and with the same wording. Telemetry
   * now draws it too.
   */
  | 'unreadable'
  /** Configured, readable, and carrying rows. */
  | 'reading';

/**
 * What the platform records about the app itself, as opposed to what PIA probes.
 *
 * THIS INTERFACE IS `otel_logs` ALONE, which is a statement about its scope and
 * not about the other two tables. Setting a telemetry destination makes
 * Databricks create three; this one carries a row per request the app served,
 * sign-in events with who and when, and error-level lines.
 *
 * IT USED TO SAY `otel_spans` AND `otel_metrics` WERE "permanently empty", and
 * that nothing here should ever grow a latency field because a panel drawn
 * against spans would render empty forever. Both claims were false and neither
 * was ever measured: appkit bundles the OpenTelemetry Node SDK with
 * auto-instrumentation, so an exporter runs without this source starting one,
 * and both tables have been filling since 2026-08-16. Per-route latency now has
 * its own contract -- see {@link RouteLatency} -- reading the spans this said
 * did not exist.
 *
 * The tables also do not sit beside the app's own tables. They land in a schema
 * of their own, deliberately: the served model's table manifest grants it read
 * access to everything in the app's schema, so sign-in records living there
 * would let a reader ask the agent who signed in. The destination is therefore
 * read from configuration and never derived from the app's own schema.
 */
export interface AppMeasurement {
  telemetry: TelemetryState;
  /** The variable that names the destination, so a deployer can go and look. */
  variable: string;
  /** The fully qualified `otel_logs` table, or '' when none is configured. */
  table: string;
  /** Present only when `telemetry` is 'no-grant'. */
  grant: GrantRemedy | null;
  /** Where app availability actually lives. Empty when no workspace host is known. */
  insightsHref: string;
  /** Requests the app served, by hour. Empty except in 'reading'. */
  requestsPerHour: Array<{ hour: string; count: number }>;
  /** ISO stamp of the most recent request recorded, or ''. */
  lastServedAt: string;
  /**
   * When the telemetry table's earliest row was written, or '' if it has none.
   *
   * READ WITHOUT THE RANGE FILTER, deliberately, and it is the only figure here
   * that is. An empty window has two causes that a reader must not have to guess
   * between: nothing has ever been recorded, or recording began after the days
   * on screen. The second is the ordinary case on the day telemetry is switched
   * on, because this page shows whole completed days and so cannot show today.
   *
   * It is evidence about the table, never about activity. Nothing may count it
   * as history -- see `hasHistory` in server/lib/ops-telemetry.ts.
   */
  recordingSince: string;
  /** Sign-in events in range, by day. Empty except in 'reading'. */
  signInsPerDay: Array<{ day: string; count: number }>;
  /** Error-level lines in range: how many, and the most recent few, readable. */
  errors: { count: number; recent: Array<{ at: string; body: string }> };
  /** The sentence explaining a state that is not 'reading'. Empty in 'reading'. */
  reason: string;
}

export interface OpsHealthPayload {
  /** ISO stamp of the check these rows report. Empty where nothing has run. */
  checkedAt: string;
  dependencies: HealthDependency[];
  platform: PlatformReading[];
  app: AppMeasurement;
  /** The sentence for a health read that failed outright. Empty otherwise. */
  reason: string;
}

/** One bar. `label` is what a reader sees; `key` is what a deep link filters on. */
export interface TrafficBar {
  key: string;
  label: string;
  count: number;
}

/** Whether raw and rolled telemetry cover the observed days without a hole. */
export interface TelemetryCoverage {
  state: 'complete' | 'partial' | 'unavailable';
  missingDays: number;
}

/** What one Traffic breakdown established over the shared run population. */
export interface TrafficBreakdownCoverage {
  state: 'complete' | 'partial' | 'unavailable';
  /** Runs represented by this read. Zero is meaningful only when state is complete. */
  coveredRuns: number;
  /** Human-readable source/read limitation. Empty only for complete coverage. */
  reason: string;
}

export interface OpsTrafficPayload {
  /** Retrospective Ops reads are locked to the current budget calendar month. */
  period?: 'current_month';
  readAt: string;
  /** '' or the storage-failure sentence, which replaces the block. */
  reason: string;
  /**
   * '' or one line naming the charts that could not be read, BESIDE the ones
   * that could.
   *
   * NOT A SECOND SPELLING OF `reason`, and the difference is the whole point of
   * the field. `reason` replaces the block: it is what the page shows when
   * nothing about traffic was established. `unread` stands next to charts that
   * did answer, because this block is several independent reads and losing one of
   * them is not losing the block.
   *
   * It exists because the alternative was a lie. A chart drawn from a read that
   * timed out is empty, and an empty questions chart under a heading naming a
   * population says nobody asked anything -- about a deployment where the store
   * merely did not answer in time. A measured zero and an unestablished figure
   * have to be distinguishable on screen, so a genuine zero leaves this empty
   * and only an absent answer fills it.
   */
  unread: string;
  questionsPerDay: Array<{ day: string; count: number }>;
  /** Distinct signed-in people who stored a user question on each day. */
  distinctAskersPerDay: Array<{ day: string; count: number }>;
  /**
   * Visible app minutes observed by the authenticated heartbeat.
   *
   * One signed-in person contributes at most one stored UTC minute. Display
   * buckets use the configured Runtime timezone (or browser/local fallback).
   * This starts with the release that creates the activity table and never
   * implies backfill.
   */
  activeMinutesPerDay: Array<{ day: string; count: number }>;
  /** IANA zone used to bucket `activeMinutesPerDay`. */
  activeMinutesTimeZone?: string;
  /** Earliest recorded heartbeat, proving where non-backfilled coverage starts. */
  activeMinutesRecordedFrom?: string;
  /** Newest recorded heartbeat, so the chart does not imply fresher coverage. */
  activeMinutesRecordedThrough?: string;
  /**
   * Failures and refusals, drawn as two charts and never one series.
   *
   * They are disjoint by construction rather than by discipline: a run ends in
   * REFUSED or in one of the failure states, decided by the LAYER of its
   * terminal code in `run-state.ts`, so no run can appear in both. That is why
   * they cannot be summed into a meaningful total, and why nothing here offers
   * one.
   */
  failuresByCause: TrafficBar[];
  refusalsByCause: TrafficBar[];
  toolCalls: TrafficBar[];
  questionStatistics?: {
    asked: number;
    answered: number;
    helpful: number;
    notHelpful: number;
  };
  runStatistics?: {
    total: number;
    completed: number;
    partial: number;
    refused: number;
    failed: number;
    unclassified: number;
  };
  /** Runs that ended in the range, whatever they ended as. */
  runsInRange: number;
  /**
   * Coverage travels with the empty arrays so the client cannot turn an
   * unavailable query into "No failures", "No refusals", or "No tool calls".
   */
  breakdownCoverage: {
    outcomes: TrafficBreakdownCoverage;
    toolCalls: TrafficBreakdownCoverage;
  };
  /** Complete-day period the traffic reads actually used. */
  range?: OpsDayRange;
  /** Coverage of raw plus durable activity rollups. */
  activityCoverage?: TelemetryCoverage;
}

/* ── Latency, from the spans this file used to say did not exist ─────────── */

/**
 * Under this many spans on a route, a high percentile is withheld.
 *
 * THE SAME FLOOR MONITORING USES, and it is duplicated here rather than
 * imported because that constant lives in a client module and this contract is
 * shared. `ops-latency.test.ts` asserts the two are equal, so they cannot drift
 * into two surfaces disagreeing about when a percentile is worth printing --
 * which is the failure the shared value exists to prevent, not the duplication.
 *
 * A 95th or 99th over eight spans is the slowest of eight wearing the name of a
 * percentile, and a reader comparing it against one computed over eight hundred
 * has no way to see the difference. The labelled slowest span is always on the
 * row for that case; see {@link RouteLatency.slowestMs}.
 */
export const SPAN_PERCENTILE_FLOOR = 20;

/**
 * Under this many spans in EITHER half of the covered window, a route is not
 * judged against its own baseline.
 *
 * Same number as {@link SPAN_PERCENTILE_FLOOR} on purpose: a verdict needs a
 * percentile-shaped sample on both sides of the split, and a red mark on three
 * spans trains people to ignore red marks.
 */
export const LATENCY_BASELINE_FLOOR = SPAN_PERCENTILE_FLOOR;

/**
 * How much slower than its own prior-half median a route must be before it is
 * flagged as concerning.
 *
 * Relative, never a fixed budget: 1.5 means the current-half p50 is at least
 * fifty percent above the prior-half p50 for the same route.
 */
export const LATENCY_SLOWER_RATIO = 1.5;

/** One route, as its server spans measured it. */
export interface RouteLatency {
  /** The span name, as the platform wrote it: `POST /api/insights/ask`. */
  route: string;
  /** Spans in the later half of the covered window (the "current" period). */
  spans: number;
  p50Ms: number;
  /** Withheld below {@link SPAN_PERCENTILE_FLOOR} spans, and null when it is. */
  p95Ms: number | null;
  /** Withheld below {@link SPAN_PERCENTILE_FLOOR} spans, and null when it is. */
  p99Ms: number | null;
  /** The single slowest span in the current half, always reported. */
  slowestMs: number;
  /**
   * Spans in the current half whose HTTP status was ≥500 (from span attributes).
   * Population is {@link spans}; never summed with refusals.
   */
  errorCount: number;
  /**
   * Always null on this payload. Refusals are run outcomes in the app store, not
   * span statuses, and inventing them from HTTP 4xx would mix access control with
   * transport failures. The client renders "Not reported".
   */
  refusalCount: number | null;
  /** Most recent span time for this route in the current half, as the warehouse wrote it. */
  lastSpanAt: string;
  /** Spans in the earlier half of the covered window. Zero when there is no prior half. */
  priorSpans: number;
  /** Median in the earlier half, or null when {@link priorSpans} is zero. */
  priorP50Ms: number | null;
}

export type LatencyState = 'ready' | 'no-rows' | 'no-grant' | 'unreadable' | 'no-warehouse' | 'not-enabled';

export interface OpsLatencyPayload {
  /** Retrospective Ops reads are locked to the current budget calendar month. */
  period?: 'current_month';
  readAt: string;
  state: LatencyState;
  /** Why there are no figures. '' exactly when `state` is 'ready'. */
  reason: string;
  /** Present only when `state` is 'no-grant'. */
  grant: GrantRemedy | null;
  /** The fully qualified `otel_spans` table, or '' when none is configured. */
  table: string;
  /** Slowest first, so the panel's first row is the one worth reading. */
  routes: RouteLatency[];
  /**
   * The first and last span ACTUALLY PRESENT, not the window that was asked
   * for.
   *
   * READ WITHOUT A RANGE FILTER, and the difference is the whole point. App
   * telemetry does not backfill: the platform starts writing at the deploy that
   * switches it on, so this table reaches back hours on a deployment that has
   * been up for months. A panel that printed these figures under the range the
   * other blocks use would state a window the data does not cover, which is the
   * shape of the two false absences this app has already shipped. Both are ''
   * when nothing was read.
   */
  coveredFrom: string;
  coveredTo: string;
  /** Complete-day period the latency read actually used. */
  range?: OpsDayRange;
  /** Coverage of raw plus durable request-latency rollups. */
  coverage?: TelemetryCoverage;
}

/* ── The window all three blocks are read over ───────────────────────────── */

/** Whole days, inclusive of both ends, as `YYYY-MM-DD`. */
export interface OpsDayRange {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;

/** The UTC calendar month used by monthly budgets and every retrospective Ops read. */
export function opsCurrentMonthRange(now: number = Date.now()): OpsDayRange {
  const today = new Date(now).toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastComplete = new Date(now - DAY_MS).toISOString().slice(0, 10);
  return { from: monthStart, to: lastComplete < monthStart ? monthStart : lastComplete };
}

/** Session/cache identity rolls naturally when the authoritative month changes. */
export function opsCurrentMonthKey(now: number = Date.now()): string {
  return `current-month:${new Date(now).toISOString().slice(0, 7)}`;
}

/**
 * The whole-day window a pair of timestamps means to Ops.
 *
 * SHARED SO THAT WHAT THE PAGE PRINTS AND WHAT THE SERVER QUERIES CANNOT
 * DISAGREE, which is not a hypothetical tidiness argument. Ops shipped with the
 * server reading `from` and `to` and the page sending neither for three of its
 * four range options, so 24h and 30 days both returned the last 7 days while the
 * chosen button stayed highlighted and every caption still read "in this range".
 * Nothing on the page named a date, so there was nothing for a reader to check a
 * figure against, and a cost total for the wrong week looked exactly like one for
 * the right week.
 *
 * The rule itself is unchanged, and it is the reason the window is days rather
 * than instants: BILLING ROWS ARRIVE LATE, so today is never the end of a cost
 * range. A range including today would draw a partial day beside complete ones
 * and read as spend falling off a cliff. Health and traffic take the same bound
 * so that the three blocks cannot be compared across different windows without
 * somebody noticing.
 *
 * Unparseable or reversed ends fall back to the last seven complete days, which
 * is the same default the page's range control starts on.
 */
export function opsDayRange(from: string, to: string, now: number): OpsDayRange {
  const day = (at: number) => new Date(at).toISOString().slice(0, 10);
  const start = Date.parse(from);
  const end = Date.parse(to);
  const lastComplete = now - DAY_MS;
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return { from: day(start), to: day(Math.min(end, lastComplete)) };
  }
  return { from: day(lastComplete - 6 * DAY_MS), to: day(lastComplete) };
}

/**
 * The dates a reader sees, so they can check a figure against a window rather
 * than trusting a highlighted button.
 *
 * Spelled out in full rather than as a duration. "Last 30 days" is what was
 * asked for; these are the days that answered, and the two are not the same
 * thing once the incomplete-day rule has taken today off the end. A single-day
 * window says one date rather than the same date twice.
 */
export function opsRangeDates(range: OpsDayRange): string {
  const spoken = (day: string) => {
    const at = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(at)) return day;
    return new Date(at).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  };
  if (range.from === range.to) return spoken(range.from);
  return `${spoken(range.from)} to ${spoken(range.to)}`;
}
