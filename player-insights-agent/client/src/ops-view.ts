/**
 * Every claim the Ops tab makes about a number, decided here and drawn in
 * `OpsPage.tsx`.
 *
 * SPLIT FOR THE REASON `monitoring-view.ts` IS SPLIT. The rules this file holds
 * are the ones that are expensive to get wrong and impossible to check by
 * looking: whether a figure is a measurement or an apportionment, whether a
 * blank is a zero or an absence, whether two counts may be added. None of that
 * is visual, so none of it should need a browser to assert, and this repository
 * cannot run one.
 *
 * THE FOUR RULES EVERY FUNCTION BELOW IS HELD TO.
 *
 *  1. A number carries the quality of its own measurement. A cost tile is drawn
 *     from `{ amount, quality }` and labels itself from the second; nothing here
 *     takes a bare number and decides afterwards what it means.
 *  2. Absence is not zero. `null` renders the sentence saying why, never `$0.00`
 *     and never a dash. This app has already shipped a panel that drew an
 *     unattributable figure as nothing and a summary counting something other
 *     than the rows beneath it.
 *  3. Failures and refusals are never added. They are disjoint by construction,
 *     and nothing here offers a total of the two.
 *  4. Every rate names its population. A per-question average that does not say
 *     what it divided by is a number a reader will use for capacity planning.
 */
// The one place a product is paired with its mark. Types only here; this module
// decides WHICH product a row is about and never how the artwork is drawn.
import { astPill } from './astrolabe-pill';
import type { BrandProduct } from './brand-icons';
import type { DatabricksObject } from '../../shared/databricks-links';
import {
  costBudgetValue,
  type CostBudgetInput,
  type CostBudgetUnit,
  type LegacyCostBudget,
} from '../../shared/cost-budgets';
import {
  COST_QUALITY_LABEL,
  DEPENDENCY_RESULT_LABEL,
  LATENCY_BASELINE_FLOOR,
  LATENCY_SLOWER_RATIO,
  SPAN_PERCENTILE_FLOOR,
  type CostAttributionScope,
  type CostCoverage,
  type CostHonesty,
  type CostTile,
  type DependencyResult,
  type HealthDependency,
  type OpsCostPayload,
  type OpsLatencyPayload,
  type OpsTrafficPayload,
  type PlatformReading,
  type QueryHistoryCoverage,
  type RouteLatency,
  type TelemetryState,
  type TrafficBar,
} from '../../shared/ops-contract';

const QUERY_HISTORY_REASON: Record<QueryHistoryCoverage['reasons'][number], string> = {
  'invalid-range': 'the requested dates were invalid',
  'range-clamped': 'the requested span exceeded the bounded history window',
  'page-cap': 'the page limit was reached',
  'repeated-page-token': 'Databricks repeated a page cursor',
  'missing-page-token': 'Databricks reported another page without a cursor',
  deadline: 'the overall read deadline was reached',
  'caller-abort': 'the caller cancelled the read',
  'transport-error': 'Databricks Query History did not answer',
  'invalid-row': 'one or more rows had no query identifier',
  'unexpected-warehouse': 'one or more rows belonged to another warehouse',
  'missing-execution-time': 'one or more rows had no execution-time metric',
  'interactive-run-coverage': 'the completed interactive Ask ledger population was partial',
};

export function queryHistoryCoverageDetail(coverage: QueryHistoryCoverage): string {
  const dates = (range: QueryHistoryCoverage['requestedRange']) =>
    range ? `${range.from.slice(0, 10)} to ${range.to.slice(0, 10)}` : 'no valid range';
  if (coverage.state === 'complete') {
    return `Complete: ${coverage.rowsRead} rows across ${coverage.pagesRead} pages and ${coverage.chunksRead} bounded date chunks.`;
  }
  const reasons = coverage.reasons.map((reason) => QUERY_HISTORY_REASON[reason]).join('; ');
  return (
    `Partial: requested ${dates(coverage.requestedRange)}; queried ${dates(coverage.queriedRange)}; ` +
    `${coverage.rowsRead} rows across ${coverage.pagesRead} pages and ${coverage.chunksRead} bounded date chunks. ` +
    `${reasons || 'Coverage was not established'}. SQL and Genie allocations are withheld.`
  );
}

/* ── Money ───────────────────────────────────────────────────────────────── */

/**
 * A figure in the currency the billing rows named, or the sentence for its
 * absence.
 *
 * The currency is never assumed. `system.billing.list_prices` carries it per
 * row, so a workspace billed in something other than USD gets its own symbol
 * rather than a dollar sign in front of a number that is not dollars. With no
 * currency read, the code is omitted rather than guessed.
 *
 * Four decimal places under a cent, because several of these components cost
 * fractions of one and rounding them to `$0.00` makes a real charge look like
 * no charge.
 */
export function money(amount: number | null, currency: string): string {
  if (amount === null || !Number.isFinite(amount)) return '';
  const decimals = Math.abs(amount) > 0 && Math.abs(amount) < 0.01 ? 4 : 2;
  const figure = amount.toFixed(decimals);
  return currency ? `${figure} ${currency}` : figure;
}

export function costAmount(amount: number | null, currency: string, unit: CostBudgetUnit): string {
  return unit === 'DBU' && amount !== null && Number.isFinite(amount)
    ? `${amount.toFixed(2)} DBU`
    : money(amount, currency);
}

function selectedBudgetUnit(input: CostBudgetInput, selected?: CostBudgetUnit): CostBudgetUnit {
  if (selected) return selected;
  return input && typeof input === 'object' && 'unit' in input ? (input as LegacyCostBudget).unit : 'USD';
}

/** A whole count with thousands separators, or '' where there is no count. */
export function count(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '' : value.toLocaleString('en-US');
}

/**
 * Spend on one tile compared to its budget, in the same window the tile already
 * shows. A missing spend figure is not compared, and is never treated as $0.00.
 *
 * Unknown-quality tiles cannot be compared even if a number snuck onto the wire:
 * that amount is not a measurement. Shared meters cannot trigger app over-budget.
 * Unpriced or duplicate list-price joins cannot pass a budget check. The app
 * total is handled separately and is never a sum of these.
 */
export type SpendVersusBudget =
  | { kind: 'none' }
  | { kind: 'budget-only'; budgetLabel: string }
  | { kind: 'compared'; spendLabel: string; budgetLabel: string; over: boolean }
  | { kind: 'shared-meter'; spendLabel: string; budgetLabel: string };

export function tileAttribution(tile: Pick<CostTile, 'amount' | 'population' | 'attribution'>): CostAttributionScope {
  if (tile.attribution) return tile.attribution;
  if (SHARED_POPULATIONS.has(tile.population)) return 'shared-upper-bound';
  if (tile.amount === null) return 'unavailable';
  return 'deployment';
}

export function spendVersusBudget(
  tile: Pick<CostTile, 'amount' | 'dbus' | 'quality' | 'population' | 'attribution' | 'pricing'>,
  inputBudget: CostBudgetInput,
  currency: string,
  selectedUnit?: CostBudgetUnit
): SpendVersusBudget {
  const unit = selectedBudgetUnit(inputBudget, selectedUnit);
  const budget = costBudgetValue(inputBudget, unit);
  if (budget === null || !Number.isFinite(budget)) return { kind: 'none' };
  const budgetLabel = costAmount(budget, currency, unit);
  const observed = unit === 'DBU' ? (tile.dbus ?? null) : tile.amount;
  const match = tile.pricing?.match;
  const unusable =
    unit === 'USD' &&
    (tile.quality === 'unknown' ||
      match === 'unpriced' ||
      match === 'duplicate' ||
      match === 'mixed-currency' ||
      match === 'partial');
  if (unusable || observed === null || !Number.isFinite(observed)) {
    return { kind: 'budget-only', budgetLabel };
  }
  const spendLabel = costAmount(observed, currency, unit);
  if (!spendLabel || !budgetLabel) return { kind: 'budget-only', budgetLabel };
  if (tileAttribution(tile) === 'shared-upper-bound' || SHARED_POPULATIONS.has(tile.population)) {
    return { kind: 'shared-meter', spendLabel, budgetLabel };
  }
  return { kind: 'compared', spendLabel, budgetLabel, over: observed > budget };
}

/**
 * The app-wide budget, never compared to a summed spend.
 *
 * Cost does not add tiles: their qualities do not mix. The amount is for the
 * same Cost window the tiles already show, not a separate monthly calendar.
 */
export function totalBudgetView(
  inputBudget: CostBudgetInput,
  currency: string,
  observed: { USD: number | null; DBU: number | null } = { USD: null, DBU: null },
  selectedUnit?: CostBudgetUnit
): SpendVersusBudget {
  const unit = selectedBudgetUnit(inputBudget, selectedUnit);
  const budget = costBudgetValue(inputBudget, unit);
  if (budget === null || !Number.isFinite(budget)) return { kind: 'none' };
  const budgetLabel = costAmount(budget, currency, unit);
  const actual = observed[unit];
  if (!budgetLabel || actual === null || !Number.isFinite(actual)) {
    return budgetLabel ? { kind: 'budget-only', budgetLabel } : { kind: 'none' };
  }
  const spendLabel = costAmount(actual, currency, unit);
  return spendLabel
    ? { kind: 'compared', spendLabel, budgetLabel, over: actual > budget }
    : { kind: 'budget-only', budgetLabel };
}

/* ── Cost tiles ──────────────────────────────────────────────────────────── */

/**
 * What a tile shows in place of a figure, and the label saying how good the
 * figure is.
 *
 * `quality` travels on the tile rather than being decided here, which is the
 * point: this function cannot mislabel a figure, because it does not know
 * enough to. It only renders what the tile already carries.
 */
export interface TileView {
  /** The component this tile is for. Selects the caption the handoff writes. */
  id: string;
  label: string;
  /** The figure, or '' when there is none. */
  figure: string;
  /** The STATE in place of a figure. Empty when there is one. */
  absence: string;
  /** The contract's quality label. The renderer never invents one. */
  qualityLabel: string;
  /**
   * Whether this card carries the estimate badge.
   *
   * THE APPORTIONMENTS ONLY, and only where there is a figure to qualify. The
   * warehouse and Genie figures are an hour's spend divided across the work in
   * that hour; the endpoint's is its own recorded tokens and the two rates are
   * what the platform bills by the day, and a badge on those would say
   * "estimate" about a measurement. A card with no figure gets none either: a
   * badge qualifying an absence qualifies nothing.
   */
  estimate: boolean;
  /** What the figure covers, in two or three words. */
  population: string;
  /**
   * Whether `population` is drawn as a badge, because the meter behind the
   * figure covers more than this deployment.
   *
   * THE SHARED METERS ONLY. 'Whole warehouse' and 'Whole workspace' are the
   * clause that stops a reader taking the Genie figure for this app's spend,
   * which is a wrong number rather than a missing footnote. The rest are this
   * endpoint, this app and this job — what a reader assumes already — and a chip
   * on every card would be the captions again in a smaller font. As with the
   * estimate badge, an absent figure gets none: there is nothing for the scope to
   * be the scope of.
   *
   * WHICH CARDS THESE ARE IS NOT FIXED. A tile the server could not narrow to
   * this deployment is relabelled 'Whole workspace' in the response, so the badge
   * follows the population it was sent rather than the card it is on.
   */
  sharedScope: boolean;
  /** Empty for a range total, or 'per day' for a rate that must stay explicit. */
  basisLabel: string;
  /** The one thing that would make an absent figure attributable, or ''. */
  remedy: string;
  note: string;
}

export type CostCardStatus = 'Estimated';

export interface CostCardView {
  id: string;
  title: string;
  amount: string;
  status: CostCardStatus;
  basis: string;
  evidence: string;
  detail: string;
  resource: string;
}

export interface GenieCardView {
  id: string;
  title: string;
  charged: string;
  free: string;
}

/** The words for the two bases. A rate drawn as a total is the whole hazard. */
export const BASIS_LABEL: Record<CostTile['basis'], string> = {
  'total-in-range': '',
  'per-day': 'per day',
};

/**
 * The workspace object a cost tile can open, or null.
 *
 * Null when the tile names no object, or when this app has no verified path for
 * the object it does name. Vector Search links the index (Architecture already
 * opens those); a bare endpoint name is not a path. Genie links only a space
 * id, never a workspace id.
 */
export function costTileWorkspaceObject(
  tile: Pick<CostTile, 'id' | 'resourceId' | 'resourceKind'>
): DatabricksObject | null {
  const id = tile.resourceId.trim();
  if (!id) return null;
  const kind = tile.resourceKind || kindFromCostTileId(tile.id);
  switch (kind) {
    case 'serving-endpoint':
      return { kind: 'serving-endpoint', name: id };
    case 'sql-warehouse':
      return { kind: 'sql-warehouse', warehouseId: id };
    case 'app':
      return { kind: 'app', name: id };
    case 'genie-space':
      return { kind: 'genie-space', spaceId: id };
    case 'vector-index': {
      const parts = id.split('.').filter((piece) => piece.length > 0);
      return parts.length === 3 ? { kind: 'vector-index', index: id } : null;
    }
    default:
      return null;
  }
}

function kindFromCostTileId(id: string): CostTile['resourceKind'] {
  if (id === 'serving-endpoint') return 'serving-endpoint';
  if (id === 'sql-warehouse') return 'sql-warehouse';
  if (id === 'app-compute') return 'app';
  if (id.startsWith('genie:')) return 'genie-space';
  if (id === 'vector-search') return 'vector-index';
  return '';
}

export function tileView(tile: CostTile, currency: string, unit: CostBudgetUnit = 'USD'): TileView {
  // `CostTile` predates the discriminated per-question part, so defend the wire
  // boundary here too: an unknown tile never becomes a number even if malformed
  // JSON happens to carry one.
  const completePrice = !tile.pricing || tile.pricing.match === 'priced' || tile.pricing.match === 'none';
  const selected = unit === 'DBU' ? (tile.dbus ?? null) : tile.amount;
  const figure =
    unit === 'USD' && (tile.quality === 'unknown' || !completePrice) ? '' : costAmount(selected, currency, unit);
  return {
    id: tile.id,
    label: tile.label,
    figure,
    // A tile with an amount it could not format is an absence, not a blank.
    absence: figure
      ? ''
      : unit === 'DBU'
        ? (tile.evidence?.billingRows ?? 0) > 0
          ? 'Measured DBU unavailable: matched billing rows contain no DBU usage'
          : tile.unavailable
            ? `DBU unavailable: ${tile.unavailable}`
            : 'Measured DBU unavailable: no matched billing rows'
        : tile.unavailable || 'Billing detail unavailable',
    qualityLabel: COST_QUALITY_LABEL[tile.quality],
    estimate: figure !== '' && tile.quality === 'estimate',
    population: tile.population,
    sharedScope: figure !== '' && SHARED_POPULATIONS.has(tile.population),
    basisLabel: BASIS_LABEL[tile.basis],
    // Only ever beside an absence. A figure that arrived needs nothing set.
    remedy: figure ? '' : tile.remedy,
    note: tile.note,
  };
}

const PRIMARY_COST_TITLES: Readonly<Record<string, string>> = {
  'serving-endpoint': 'Agent serving',
  'foundation-model': 'Foundation model tokens',
  'sql-warehouse': 'Ask SQL',
  'vector-search': 'Vector Search',
  'app-compute': 'App compute',
};

const PRIMARY_COST_ORDER = [
  'serving-endpoint',
  'foundation-model',
  'sql-warehouse',
  'vector-search',
  'app-compute',
] as const;

function tokenEvidence(tile: CostTile): string {
  const tokens = tile.evidence?.tokens;
  if (!tokens) return '';
  const expectedRequests = tokens.coveredRequests + (tile.evidence?.missingEligibleRequests ?? 0);
  const calls = `${count(tokens.coveredRequests)} of ${count(expectedRequests)} Ask model ${
    expectedRequests === 1 ? 'call' : 'calls'
  }`;
  const coverage =
    tile.evidence?.coverageComplete === false
      ? `${count(tile.evidence.missingEligibleRequests ?? 0)} eligible Ask missing evidence`
      : 'complete coverage';
  if (tokens.total === null) return `${calls} · ${coverage}`;
  const cache =
    tokens.cachedRead === undefined && tokens.cacheWrite === undefined
      ? 'Cache not reported'
      : `${count(tokens.cachedRead ?? 0)} cached input`;
  return `${calls} · ${count(tokens.input)} input · ${count(tokens.output)} output · ${count(
    tokens.total
  )} total · ${cache} · ${coverage}`;
}

function primaryEvidence(tile: CostTile, throughDay: string): string {
  if (tile.id === 'foundation-model') return tokenEvidence(tile);
  if (tile.id === 'serving-endpoint') {
    const requests = tile.evidence?.interactiveRequests;
    const covered = tile.evidence?.coveredRequests;
    return requests === null || requests === undefined
      ? ''
      : `${count(covered ?? 0)} of ${count(requests)} interactive requests`;
  }
  if (tile.id === 'sql-warehouse') {
    const queries = tile.evidence?.astrolabeQueries;
    return queries === null || queries === undefined
      ? ''
      : `${count(queries)} Ask ${queries === 1 ? 'query' : 'queries'} · ${
          tile.evidence?.queryHistoryComplete === false ? 'incomplete' : 'complete'
        } history`;
  }
  return throughDay ? `Billing through ${throughDay}` : '';
}

function primaryBasis(tile: CostTile): string {
  if (tile.id === 'serving-endpoint') return 'Marginal interactive Ask';
  if (tile.id === 'foundation-model') return 'Interactive Ask tokens';
  if (tile.id === 'sql-warehouse') return 'Marginal Ask SQL';
  return BASIS_LABEL[tile.basis] || 'Selected period';
}

function isPartialFoundation(tile: CostTile): boolean {
  return (
    tile.id === 'foundation-model' && (tile.pricing?.match === 'partial' || tile.evidence?.coverageComplete === false)
  );
}

/** The single presentation contract used by every standard Cost card. */
export function costCardView(
  tile: CostTile,
  payload: Pick<OpsCostPayload, 'currency' | 'throughDay'>,
  unit: CostBudgetUnit = 'USD'
): CostCardView {
  const view = tileView(tile, payload.currency, unit);
  const partial = isPartialFoundation(tile);
  return {
    id: tile.id,
    title: PRIMARY_COST_TITLES[tile.id] ?? tile.label,
    amount: view.figure || (partial ? 'Measured amount unavailable' : 'No measured amount'),
    status: 'Estimated',
    basis: primaryBasis(tile),
    evidence: primaryEvidence(tile, payload.throughDay),
    detail: partial ? 'Some request or price coverage is incomplete.' : view.absence,
    resource: [tile.resourceId, tile.secondaryResourceId].filter(Boolean).join(' · '),
  };
}

function usableQuestionComponent(tile: CostTile | undefined, unit: CostBudgetUnit): number | null {
  if (!tile || tileAttribution(tile) !== 'deployment' || tile.quality === 'unknown') return null;
  if (unit === 'USD' && tile.pricing && tile.pricing.match !== 'priced' && tile.pricing.match !== 'none') {
    return null;
  }
  const value = unit === 'DBU' ? tile.dbus : tile.amount;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A measured partial average is preferable to discarding every usable marginal component. */
export function questionCostCardView(payload: OpsCostPayload, unit: CostBudgetUnit = 'USD'): CostCardView {
  const legacy = payload.perQuestion.complete === undefined;
  const ids = legacy
    ? (['serving-endpoint', 'sql-warehouse'] as const)
    : (['serving-endpoint', 'foundation-model', 'sql-warehouse'] as const);
  const components = ids.map((id) => payload.tiles.find((tile) => tile.id === id));
  const usable = components
    .map((tile) => usableQuestionComponent(tile, unit))
    .filter((value): value is number => value !== null);
  const completed = payload.perQuestion.runsInRange;
  const value = completed > 0 && usable.length > 0 ? usable.reduce((sum, amount) => sum + amount, 0) / completed : null;
  const partial =
    value !== null &&
    (usable.length < ids.length || components.some((tile) => Boolean(tile && isPartialFoundation(tile))));
  return {
    id: 'average-cost-question',
    title: 'Average cost / question',
    amount: value === null ? 'No measured average' : costAmount(value, payload.currency, unit),
    status: 'Estimated',
    basis: partial ? 'Available marginal components' : 'Marginal interactive Ask',
    evidence:
      completed > 0
        ? `${usable.length} of ${ids.length} components · ${count(completed)} completed ${
            completed === 1 ? 'Ask' : 'Asks'
          }`
        : 'No completed interactive Asks',
    detail:
      value === null
        ? 'No usable numerator and denominator were measured.'
        : partial
          ? 'Components without a safe measured amount are excluded from this estimate.'
          : QUESTION_COST_FORMULA,
    resource: '',
  };
}

export function primaryCostCardViews(payload: OpsCostPayload, unit: CostBudgetUnit = 'USD'): CostCardView[] {
  const displayed = costTilesForDisplay(payload.tiles);
  const byId = new Map(displayed.map((tile) => [tile.id, tile]));
  const emptyById = new Map(EMPTY_COST_TILES.map((tile) => [tile.id, tile]));
  const cards = PRIMARY_COST_ORDER.map((id) => byId.get(id) ?? emptyById.get(id)).filter((tile): tile is CostTile =>
    Boolean(tile)
  );
  return [...cards.map((tile) => costCardView(tile, payload, unit)), questionCostCardView(payload, unit)];
}

export function genieCostCardViews(payload: OpsCostPayload, unit: CostBudgetUnit = 'USD'): GenieCardView[] {
  return costTilesForDisplay(payload.tiles)
    .filter((tile) => tile.id.startsWith('genie:') && tile.id !== 'genie:unattributed')
    .map((tile) => {
      const accounting = tile.genieInstanceAccounting;
      const paid = accounting?.paidUsd ?? tile.amount;
      const chargedDbus = accounting?.chargedEffectiveDbus ?? tile.dbus;
      const allowance = accounting?.allowanceUsedDbus ?? 0;
      const promotional = accounting?.promotionalDbus ?? 0;
      const freeDbus = allowance + promotional;
      return {
        id: tile.id,
        title:
          tile.id === 'genie:data' ? 'Data Genie' : tile.id === 'genie:dictionary' ? 'Dictionary Genie' : tile.label,
        charged:
          unit === 'USD'
            ? paid === null
              ? 'Unavailable'
              : `$${paid.toFixed(2)}`
            : chargedDbus === null || chargedDbus === undefined
              ? 'Unavailable'
              : `${chargedDbus.toFixed(2)} DBU`,
        free:
          unit === 'USD'
            ? freeDbus === 0
              ? '$0.00'
              : accounting?.freeEquivalentUsd === null || accounting?.freeEquivalentUsd === undefined
                ? 'Unavailable'
                : `$${accounting.freeEquivalentUsd.toFixed(2)}`
            : `${freeDbus.toFixed(2)} DBU`,
      };
    });
}

/*
 * THERE IS NO CAPTION UNDER A FIGURE ANY MORE, and the line each card used to
 * carry is worth naming because it was written per component and looked
 * unremovable: "per-token: from recorded tokens · This endpoint", "estimate:
 * hourly spend shared across queries by duration · Whole warehouse", and four
 * more like them. Six cards each holding two lines of prose under a number is a
 * grid nobody reads to the end of, and the captions wrapped into the card's own
 * border at the widths the tab is read at.
 *
 * What survived is the two facts a reader acts on, as badges rather than
 * sentences: whether the figure is an apportionment, and whether the meter it
 * came off covers more than this deployment. Both are drawn in the same pill the
 * block's own "Experimental" uses. See `estimate` and `sharedScope`.
 *
 * THE SCOPE CHIP WENT WITH THE CAPTIONS AND CAME BACK WITHOUT THEM, which is
 * worth recording because it was cut once as decoration. It is not: with no
 * "Whole workspace" on it, the Genie figure reads as this app's spend, and a
 * reader who plans against it has been handed one number for two questions. That
 * is a wrong number, and it is the one kind of missing context this file exists
 * to prevent. Cut the sentence, keep the fact.
 */

/**
 * The populations that are somebody else's meter as well as ours.
 *
 * KEYED ON THE POPULATION AND NOT ON THE COMPONENT, and it was the other way
 * round for a day. The reason it changed is worth keeping: the server can
 * RELABEL a tile's population at request time. Where a narrowing id is not
 * configured, `ops-billing` falls back to the workspace-wide figure and
 * overrides that tile's population to 'Whole workspace' -- so which cards are
 * whole-workspace is a property of the response, not of the component list, and
 * an id-keyed rule left that fallback figure looking like this deployment's own
 * spend. That is the exact misreading the badge exists to stop.
 *
 * The cost of keying on prose is that a reword in the server's table silently
 * unbadges a card. That is a worse failure than it looks, so the pairing is
 * asserted from the server's own values rather than from a copy of them, and
 * anything wider than this deployment belongs in this set on the day it lands.
 * Keyed on quality it would be worse still: a figure can be apportioned for
 * reasons other than a shared meter, and the badge would then say something
 * false about scope rather than nothing at all.
 */
const SHARED_POPULATIONS = new Set<string>(['Whole warehouse', 'Whole workspace']);

/*
 * THERE IS NO HEADLINE VIEW, because there is no per-question average to compose
 * one for. It formatted "Average per question" over "918.51 USD across 16
 * questions", and the two rules it was written to satisfy -- say the word
 * "average", show the denominator -- both held while the figure itself was
 * meaningless.
 *
 * What it divided is mostly billed by TIME. A warehouse and a serving endpoint
 * charge for the hours they exist, and dividing a range's idle hours by the
 * sixteen questions somebody happened to ask gives a number that FALLS as the
 * deployment is used more. A reader doing capacity arithmetic with something
 * labelled "per question" will do the opposite of what the figure supports, and
 * at sixteen questions it read as fifty-seven dollars a question.
 *
 * The lesson worth keeping: naming a denominator makes an average honest about
 * its arithmetic, not about its meaning. A rate whose numerator is time and
 * whose denominator is demand has no honest label, so this one has no figure.
 * `headline` has since gone from the payload and from the server that computed
 * it, so there is nothing left for a later pass to find and put back on screen.
 */

/* ── The cost block's states ─────────────────────────────────────────────── */

/**
 * A stated absence: what it is, and the one line a reader acts on.
 *
 * TITLE AND ONE LINE, AND THERE IS NO SECOND HALF. Every absence here used to
 * carry three sentences of body and a paragraph of reasoning behind a "Why"
 * disclosure, and the shape of all of them was the same: how the reading works,
 * then what to do about it. Only the second was ever read. The first is the
 * narration this tab has had removed from it repeatedly, and a collapsed
 * paragraph is still a paragraph somebody has to decide not to open.
 *
 * What survives is what a person acts on: the state, the server's own words
 * where it said something, and a remedy where one exists. A provider's exact
 * sentence is never shortened; it is the most useful thing on the block.
 */
export interface Absence {
  title: string;
  body: string;
}

/**
 * The heading and sentence for a cost block with no figures.
 *
 * `no-grant` AND `no-rows` ARE DIFFERENT and this is the function that keeps
 * them so. The first is a privilege somebody can grant. The second is a range
 * billing has not filled yet, which no privilege fixes: usage rows land hours
 * after the usage, so a range ending today is normally partly empty and that is
 * the system working. Showing one sentence for both sends an admin to ask for
 * something they already hold.
 *
 * Empty spend still draws the resource tiles. The no-rows copy is a note under
 * that grid, not a card that replaces it. A missing grant, a failed read, and a
 * missing warehouse still replace the grid: there is nothing to attach a box to.
 */
export function costAbsence(payload: OpsCostPayload): Absence | null {
  if (payload.state === 'ready') return null;
  if (payload.state === 'no-grant') {
    return {
      title: 'You cannot read the billing tables',
      body: 'Run the statement below, or ask an account admin to, and refresh.',
    };
  }
  if (payload.state === 'no-rows') {
    // The one clause that stops the wrong action. Without it an admin reads an
    // empty block as the missing grant above and goes to ask for a privilege
    // they already hold.
    return {
      title: 'No billing rows yet',
      body: `${payload.reason ? `${payload.reason} ` : ''}This is not a permission problem and there is nothing to grant.`,
    };
  }
  if (payload.state === 'no-warehouse') {
    return {
      title: 'No warehouse to read billing with',
      body: payload.reason || 'No SQL warehouse is configured, so the billing tables cannot be queried.',
    };
  }
  // The reassurance is appended rather than used as a fallback. A read that
  // failed and a range that cost nothing produce the same empty block, and the
  // server's own sentence explains the failure without ever saying which of the
  // two this is. Losing the clause whenever the server had something to say
  // would drop it in exactly the cases that have the most to explain.
  const failed = payload.reason || 'The billing query did not come back.';
  return {
    title: 'Spend could not be read',
    // The server's own sentence stays in front of the reader. It is the specific
    // half of this block, and the clause after it is what stops an empty block
    // being read as a cheap week.
    body: `${failed} This is not a figure for zero spend: nothing here was measured.`,
  };
}

/**
 * Whether the absence copy replaces the tile grid.
 *
 * Empty spend does not: the boxes stay, each saying there were no billing rows,
 * and the note sits under them. A missing grant still swallows the grid, because
 * the next action is the statement, not a row of blank cards.
 */
export function costAbsenceReplacesGrid(payload: OpsCostPayload): boolean {
  return payload.state !== 'ready' && payload.state !== 'no-rows';
}

/**
 * The tiles Cost draws, even when billing returned nothing.
 *
 * Index rebuild stays out. An empty payload still gets one box per tracked
 * resource so the grid does not collapse into a single empty-state card.
 */
export function costTilesForDisplay(tiles: readonly CostTile[]): CostTile[] {
  if (tiles.length === 0) return EMPTY_COST_TILES.map((tile) => ({ ...tile }));
  return tiles.filter((tile) => tile.id !== 'genie:unattributed');
}

const EMPTY_COST_TILE: Omit<CostTile, 'id' | 'label' | 'resourceKind'> = {
  resourceId: '',
  quality: 'unknown',
  amount: null,
  basis: 'total-in-range',
  population: '',
  attribution: 'unavailable',
  pricing: null,
  unavailable: 'No billing rows',
  remedy: '',
  note: '',
};

const EMPTY_COST_TILES: readonly CostTile[] = [
  { ...EMPTY_COST_TILE, id: 'serving-endpoint', label: 'Agent serving', resourceKind: 'serving-endpoint' },
  { ...EMPTY_COST_TILE, id: 'foundation-model', label: 'Foundation model tokens', resourceKind: 'serving-endpoint' },
  { ...EMPTY_COST_TILE, id: 'sql-warehouse', label: 'Ask SQL', resourceKind: 'sql-warehouse' },
  { ...EMPTY_COST_TILE, id: 'genie:data', label: 'Data Genie', resourceKind: '' },
  { ...EMPTY_COST_TILE, id: 'genie:dictionary', label: 'Dictionary Genie', resourceKind: '' },
  { ...EMPTY_COST_TILE, id: 'vector-search', label: 'Vector search', resourceKind: 'vector-index' },
  { ...EMPTY_COST_TILE, id: 'app-compute', label: 'App compute', resourceKind: 'app' },
];

/* ── Health ──────────────────────────────────────────────────────────────── */

/**
 * The words for a dependency result, and the tone class beside them.
 *
 * THE WORD IS THE STATE AND THE COLOUR IS DECORATION. Every row states its
 * result in text, so the block reads the same to somebody who cannot distinguish
 * the colours, on a monochrome print, and to a screen reader. The class only
 * paints what the word already said.
 *
 * `not-checked` is a third state rather than a shade of failure. A probe that
 * did not run has said nothing about the dependency, and drawing that as a fault
 * sends somebody to investigate a service that is fine.
 */
export const RESULT_TONE: Record<DependencyResult, string> = {
  answered: astPill('pos', 'ops-pill'),
  'did-not-answer': astPill('neg', 'ops-pill'),
  'not-checked': astPill('neutral-outline', 'ops-pill'),
};

export function resultLabel(result: DependencyResult): string {
  return DEPENDENCY_RESULT_LABEL[result];
}

/**
 * The words a platform reading is painted green for.
 *
 * GREEN ONLY FOR THE WORDS THAT MEAN IT. The handoff drew these green because on
 * the deployment it was drawn from everything was up. A pill painted green
 * whatever the platform said would be the one element on this page whose colour
 * is not a second copy of its word, and the word it contradicted would be the
 * one somebody needed.
 */
const PLATFORM_GOOD = /^(ready|running|available|online|connected)$/i;

export function platformTone(reading: PlatformReading): string {
  if (!reading.read || !reading.state) return astPill('neutral-outline', 'ops-pill');
  return PLATFORM_GOOD.test(reading.state.trim()) ? astPill('pos', 'ops-pill') : astPill('warn', 'ops-pill');
}

/**
 * What a resource is, in one short noun phrase, for the left half of its Result
 * pill.
 *
 * KEYED ON `kind` FOR THE REASON `productForProbe` IS. A probe's own `label`
 * carries the configured identifier -- "Orchestrator serving endpoint ·
 * a-model-name" -- which is the right thing in the first column and far too long
 * to be half of a pill. The kind is the stable property, and a kind nobody has
 * named here falls back to the label's own leading phrase rather than to a blank
 * or to an invented word.
 */
const KIND_LABEL: Record<string, string> = {
  'serving-endpoint': 'Serving endpoint',
  'sql-warehouse': 'SQL warehouse',
  'genie-space': 'Genie space',
  'vector-index': 'Vector Search index',
  'vector-endpoint': 'Vector Search endpoint',
  catalog: 'Catalog',
  schema: 'Schema',
  table: 'Table',
  lakebase: 'Lakebase',
  app: 'App',
};

/**
 * The workspace object a Health resource can open, or null.
 *
 * Same rule as Architecture: a guessed URL is a dead affordance that looks live.
 * Vector Search endpoints and Lakebase have no verified workspace path here.
 */
export function healthResourceObject(row: { kind: string; name: string }): DatabricksObject | null {
  const id = row.name.trim();
  if (!id) return null;
  switch (row.kind) {
    case 'serving-endpoint':
      return { kind: 'serving-endpoint', name: id };
    case 'sql-warehouse':
      return { kind: 'sql-warehouse', warehouseId: id };
    case 'genie-space':
      return { kind: 'genie-space', spaceId: id };
    case 'vector-index':
      return { kind: 'vector-index', index: id };
    case 'catalog':
      return { kind: 'catalog', catalog: id };
    case 'schema': {
      const [catalog, schema] = id.split('.');
      return catalog && schema ? { kind: 'schema', catalog, schema } : null;
    }
    case 'table':
      return { kind: 'table', table: id };
    case 'app':
      return { kind: 'app', name: id };
    case 'experiment':
    case 'experiment-id':
      return { kind: 'experiment', experimentId: id };
    default:
      return null;
  }
}

export function resourceWord(row: { kind: string; label: string }): string {
  const named = KIND_LABEL[row.kind];
  if (named) return named;
  const leading = row.label.split('\u00b7')[0].trim();
  return leading || row.label;
}

/** One row of the health table, and the pill that states its result. */
export interface HealthRow {
  /** The row's own key, which is the probe id or the reading's. */
  id: string;
  kind: string;
  /** What the first column shows: the probe's own words, or the reading's label. */
  label: string;
  /** The configured identifier, where the label is not already carrying it. */
  name: string;
  /** The Connections row to link to, or '' for none. */
  connectionsId: string;
  lastCheckedAt: string;
  /** The Notes cell, already quoted or already the sentence for a check that did not run. */
  notes: string;
  /** The Result cell: what the resource is, what it said, and the tone painting it. */
  pill: { label: string; value: string; tone: string };
}

/**
 * The Notes cell, which is empty for most rows and is the whole finding on the
 * rest.
 *
 * The probe's own words, verbatim and in quotes so a reader can see where the app
 * stops speaking and the platform starts. Rewriting them here would produce two
 * accounts of one failure that a reader has to reconcile, and the probe's is the
 * one that matches the logs.
 */
const RESOURCE_NOTES: Readonly<Record<string, string>> = {
  app: 'Databricks App runtime',
  lakebase: 'Conversation state store',
  'sql-warehouse': 'SQL query execution',
  'genie-space': 'Natural-language data space',
  'serving-endpoint': 'Model inference endpoint',
  'vector-endpoint': 'Vector Search compute',
  'vector-index': 'Semantic vector index',
  catalog: 'Unity Catalog container',
  schema: 'Unity Catalog namespace',
  table: 'Governed table',
};

function noteFor(kind: string, result: DependencyResult): string {
  const description = RESOURCE_NOTES[kind] ?? 'Connected dependency';
  return result === 'not-checked' ? `${description} · not checked` : description;
}

/**
 * Every row of the health table, one per resource, each stating its result as a
 * pill that names the resource it is about.
 *
 * ONE PLACE TO LOOK, WHICH IS WHY THIS FUNCTION EXISTS. The platform's readings
 * used to be a cluster of pills in the block's head, above a table whose Result
 * column said "Answered" about the same serving endpoint the pill beside it
 * called "Ready". Two badges for one question, in two places, in two
 * vocabularies. The readings are now rows: the ones taken FROM probe rows land in
 * those rows' Result cells, and the ones taken from something else -- the app,
 * which is running because this handler answered, and Lakebase, which was read --
 * get a row each.
 *
 * NOTHING IS DRAWN TWICE. A reading only reaches a row the server said it was
 * taken from, and a reading that names no row is the only kind that gets one of
 * its own, so no resource can appear both as a probe row and as a synthesised
 * one.
 */
export function healthRows(
  payload: {
    dependencies?: readonly HealthDependency[];
    platform?: readonly PlatformReading[];
    checkedAt?: string;
  } | null
): HealthRow[] {
  if (!payload) return [];
  const readings = payload.platform ?? [];
  const spokenFor = new Map<string, PlatformReading>();
  for (const reading of readings) {
    for (const id of reading.rows ?? []) spokenFor.set(id, reading);
  }

  const probed = (payload.dependencies ?? []).map((row): HealthRow => {
    const reading = spokenFor.get(row.id);
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      name: row.name,
      connectionsId: row.connectionsId,
      lastCheckedAt: row.lastCheckedAt,
      notes: noteFor(row.kind, row.result),
      pill: reading
        ? {
            // The platform's own word wins where the platform gave one. It is a
            // reading of the endpoint's state rather than of whether a GET came
            // back, and it is the more specific of the two.
            label: reading.label,
            value: reading.read && reading.state ? reading.state : 'Not checked',
            tone: platformTone(reading),
          }
        : { label: resourceWord(row), value: resultLabel(row.result), tone: RESULT_TONE[row.result] },
    };
  });

  const ownRows = readings
    .filter((reading) => (reading.rows ?? []).length === 0)
    .map(
      (reading): HealthRow => ({
        id: reading.id,
        kind: reading.id,
        label: reading.label,
        name: '',
        connectionsId: '',
        // The reading was taken on the same pass as the probes, so it is as old as
        // the check the band is dated by. Nothing here invents a fresher time.
        lastCheckedAt: payload.checkedAt ?? '',
        notes: noteFor(reading.id, reading.read ? 'answered' : 'not-checked'),
        pill: {
          label: reading.label,
          value: reading.read && reading.state ? reading.state : 'Not checked',
          tone: platformTone(reading),
        },
      })
    );

  return [...probed, ...ownRows];
}

/* ── Which product a row or a tile is about ──────────────────────────────── */

/**
 * The Databricks product behind a dependency probe, or null.
 *
 * KEYED ON `kind`, NEVER ON `id` OR ON THE LABEL. The ids vary with what a
 * deployment configures and the labels are the probe's own prose; the kind is on
 * the wire precisely because it is the stable one, and the Serving endpoint pill
 * has twice been keyed to a literal id and twice reported a healthy endpoint as
 * unchecked when that id was not among the rows. A mark keyed the same way would
 * fail the same way, more quietly: a missing icon looks like a design choice.
 *
 * Null is a real answer and its caller draws nothing. A mark is a claim about
 * which product a reader is looking at, and the wrong one on a row that is
 * failing sends them to the wrong service's console.
 */
export function productForProbe(kind: string): BrandProduct | null {
  return PROBE_PRODUCTS[kind] ?? null;
}

const PROBE_PRODUCTS: Record<string, BrandProduct> = {
  'sql-warehouse': 'databricks-sql',
  'genie-space': 'genie',
  // The two rows the platform speaks for rather than the probes: the app itself,
  // and the store it writes to. Keyed the same way as everything else, so the
  // synthesised rows carry a mark like their neighbours instead of a blank.
  app: 'apps',
  lakebase: 'lakebase',
  // The served model and the semantic index are both Mosaic AI, which is the
  // handoff's pairing and the console's.
  'serving-endpoint': 'mosaic-ai',
  'vector-index': 'mosaic-ai',
  'vector-endpoint': 'mosaic-ai',
  // The three governed-object probes. One product, three grains.
  catalog: 'unity-catalog',
  schema: 'unity-catalog',
  table: 'unity-catalog',
};

/**
 * The product behind a cost tile, or null.
 *
 * Genie space tiles are keyed `genie:<space id>` so each space can be its own
 * card; they still carry the Genie mark.
 */
export function productForCostTile(id: string): BrandProduct | null {
  if (id === 'genie' || id.startsWith('genie:')) return 'genie';
  return COST_TILE_PRODUCTS[id] ?? null;
}

const COST_TILE_PRODUCTS: Record<string, BrandProduct> = {
  'serving-endpoint': 'mosaic-ai',
  'foundation-model': 'mosaic-ai',
  'vector-search': 'mosaic-ai',
  'sql-warehouse': 'databricks-sql',
  'app-compute': 'apps',
};

/**
 * Coverage belongs to the product tile it describes, never to a prose match.
 *
 * The product names are the billing contract's stable identifiers. Genie may
 * have one tile per space, while Jobs is only eligible for the rebuild tile if
 * that tile is ever displayed. Products without a displayed owner deliberately
 * map to nothing instead of borrowing a nearby tile.
 */
const COST_COVERAGE_PRODUCT: Readonly<Record<string, string>> = {
  'serving-endpoint': 'MODEL_SERVING',
  'sql-warehouse': 'SQL',
  'vector-search': 'VECTOR_SEARCH',
  'app-compute': 'APPS',
  genie: 'GENIE',
};

export function costCoverageProductForTile(tileId: string): string | null {
  if (tileId === 'genie' || tileId.startsWith('genie:')) return 'GENIE';
  return COST_COVERAGE_PRODUCT[tileId] ?? null;
}

/** Concise coverage and propagation facts for one displayed tile. */
export function costCoverageLinesForTile(tileId: string, coverage: CostCoverage | null | undefined): string[] {
  if (!coverage) return [];
  const product = costCoverageProductForTile(tileId);
  if (!product) return [];

  const lines: string[] = [];
  const productCoverage = coverage.products.find((row) => row.product === product);
  if (productCoverage?.reason.trim()) lines.push(productCoverage.reason.trim());

  for (const propagation of coverage.propagation) {
    if (propagation.product !== product || propagation.status === 'unused') continue;
    const detail = propagation.detail.trim();
    if (detail && !lines.includes(detail)) lines.push(detail);
  }
  return lines;
}

/**
 * The three marginal question-serving components with defensible period attribution,
 * divided by every completed question in that same complete-day period.
 */
export const QUESTION_COST_FORMULA = 'Marginal serving + foundation tokens + Ask SQL ÷ completed interactive Asks';

export function questionServingAverage(payload: OpsCostPayload, unit: CostBudgetUnit = 'USD'): number | null {
  const serving = payload.tiles.find((tile) => tile.id === 'serving-endpoint');
  const foundation = payload.tiles.find((tile) => tile.id === 'foundation-model');
  const sql = payload.tiles.find((tile) => tile.id === 'sql-warehouse');
  const completed = payload.perQuestion.runsInRange;
  const legacy = payload.perQuestion.complete === undefined;
  const priced = (tile: CostTile | undefined) =>
    !tile?.pricing || tile.pricing.match === 'priced' || tile.pricing.match === 'none';
  const servingAmount = unit === 'DBU' ? serving?.dbus : serving?.amount;
  const foundationAmount = unit === 'DBU' ? foundation?.dbus : foundation?.amount;
  const sqlAmount = unit === 'DBU' ? sql?.dbus : sql?.amount;
  const usdUnavailable =
    unit === 'USD' &&
    (serving?.quality === 'unknown' ||
      (!legacy && foundation?.quality === 'unknown') ||
      sql?.quality === 'unknown' ||
      !priced(serving) ||
      (!legacy && !priced(foundation)) ||
      !priced(sql));
  if (
    !serving ||
    !sql ||
    (!legacy && !foundation) ||
    tileAttribution(serving) !== 'deployment' ||
    (!legacy && foundation && tileAttribution(foundation) !== 'deployment') ||
    tileAttribution(sql) !== 'deployment' ||
    usdUnavailable ||
    typeof servingAmount !== 'number' ||
    !Number.isFinite(servingAmount) ||
    typeof sqlAmount !== 'number' ||
    !Number.isFinite(sqlAmount) ||
    (!legacy && (typeof foundationAmount !== 'number' || !Number.isFinite(foundationAmount))) ||
    completed <= 0
  ) {
    return null;
  }
  return (servingAmount + (legacy ? 0 : (foundationAmount ?? 0)) + sqlAmount) / completed;
}

export function costHonestyLine(honesty: CostHonesty | null | undefined): string {
  if (!honesty) {
    return 'Figures are list prices from system.billing.list_prices, not contracted rates.';
  }
  const through = honesty.dataThrough
    ? ` Data through ${honesty.dataThrough}${honesty.rangeMayStillFill ? '; later days may still be filling' : ''}.`
    : honesty.rangeMayStillFill
      ? ' Later days may still be filling.'
      : '';
  const currency = honesty.currencyConsistent ? '' : ' Mixed currencies were withheld rather than combined.';
  return `Figures are list prices from system.billing.list_prices, not contracted rates.${through}${currency}`;
}

/*
 * Whether the app itself was up is the platform's reading and not this app's,
 * and the block says so by LINKING to the platform record rather than by
 * carrying two sentences about why it cannot compute one. The link is named
 * "App availability in Databricks", which is the whole of what the sentences
 * said, and it is a thing a reader can click instead of a thing they have to
 * finish reading.
 */

/**
 * What the telemetry half of Health says, in each of its states.
 *
 * FOUR OF THE FIVE ARE ORDINARY. Off is the default and the customer case:
 * ingestion is billed, so a deployment that has not opted in has no tables and
 * no charge, and that is a correct configuration rather than a fault. The block
 * says which one it is in and what would change it, and never renders an empty
 * chart in place of an explanation.
 *
 * 'unreadable' IS THE ONE THAT IS A FAULT, and it is kept apart from
 * 'no-rows-yet' for the reason `costAbsence` keeps them apart: a read that did
 * not come back has said nothing about whether the table is empty, and titling
 * it "no history yet" sends somebody to look at ingestion instead of at the
 * error the platform handed back.
 */
export function telemetryNotice(
  state: TelemetryState,
  input: { variable: string; table: string; reason: string }
): Absence | null {
  if (state === 'reading') return null;
  if (state === 'not-enabled') {
    return {
      title: 'App telemetry is off',
      // Status only. The configuration variable and billing narrative are
      // deployment details, not useful copy for somebody reading Ops.
      body: '',
    };
  }
  if (state === 'no-grant') {
    return {
      title: 'You cannot read the telemetry table',
      body: `No SELECT on ${input.table}. Run the statement below, or ask whoever owns that schema to, and refresh.`,
    };
  }
  if (state === 'unreadable') {
    return {
      title: 'Telemetry could not be read',
      // The platform's own sentence stays in front of the reader, for the reason
      // it does on the cost block: it is the specific half, and the clause after
      // it is what stops an empty panel being read as a quiet week.
      body:
        `${input.reason || `The query against ${input.table} did not come back.`} ` +
        'This is not a reading of no activity: nothing here was measured.',
    };
  }
  return {
    title: 'No telemetry history yet',
    // Telemetry does not backfill, so an empty table is expected rather than a
    // sign that nothing was served. That is the one clause worth a reader's
    // time, and it is a clause rather than the paragraph it used to be.
    body: input.reason || `${input.table} is readable and holds nothing yet. Telemetry does not backfill.`,
  };
}

/**
 * The one line above the recorded error log lines that keeps them from reading
 * as a live outage.
 *
 * THE ERRORS ARE HISTORY, THE HEALTH TABLE IS NOW. The error lines come from
 * `otel_logs`: they are error-level lines the app wrote at some point inside the
 * range, each carrying its own timestamp. The Result column above them is a
 * live probe of each dependency, checked on demand. Those are different
 * questions, and a reader who reads two-day-old "cache fell back to in-memory"
 * lines as the current state of a dependency has been handed the wrong one.
 *
 * When every current dependency answers, historical lines do not render. A real
 * current fault still shows in the Result column and allows the matching log
 * lines through. Returns null at zero or when there is no live fault.
 */
export interface ErrorFraming {
  /** Count line, never zero: e.g. "2 error lines recorded in this range". */
  headline: string;
  /** Body sentence tying these recorded lines to the current failed check. */
  note: string;
  /** True only when a dependency is not answering its check right now. */
  live: boolean;
}

export function errorFraming(input: { errorCount: number; dependencies: DependencyResult[] }): ErrorFraming | null {
  if (input.errorCount <= 0 || !Number.isFinite(input.errorCount)) return null;
  const live = input.dependencies.some((result) => result === 'did-not-answer');
  // Recorded log lines are history, not a health result. When every current
  // probe is healthy (or has not run), this panel adds an alarming old error
  // beside green checks and no useful action, so it does not render.
  if (!live) return null;
  const noun = input.errorCount === 1 ? 'error line' : 'error lines';
  const headline = `${count(input.errorCount)} ${noun} recorded`;
  const note = 'A dependency is not answering its most recent check. Read these lines against the Result column above.';
  return { headline, note, live };
}

/* ── Traffic ─────────────────────────────────────────────────────────────── */

/**
 * Bar widths as percentages of the largest bar in the SAME chart.
 *
 * Per chart rather than across the page, and this is the reason failures and
 * refusals are two charts rather than one. Scaled together, a deployment with
 * many refusals and two failures draws the failures as slivers, which reads as
 * "almost nothing" about the one number an operator most wants to see. Each
 * chart naming its own maximum is what lets the two be compared honestly, by
 * reading them, rather than dishonestly, by their lengths.
 *
 * An empty chart returns an empty array. It never returns a bar of length zero,
 * because a drawn bar is a claim that there is something to draw.
 */
export function bars(series: TrafficBar[]): Array<TrafficBar & { percent: number }> {
  const largest = series.reduce((high, bar) => Math.max(high, bar.count), 0);
  if (largest <= 0) return [];
  return series.map((bar) => ({ ...bar, percent: Math.round((bar.count / largest) * 100) }));
}

/**
 * The caption under a traffic chart, naming what it counted.
 *
 * NEVER A COMBINED TOTAL. Refusals and failures are disjoint, so a sum is
 * arithmetically fine and semantically wrong: a refusal is the app working
 * correctly and telling somebody they may not read something, and a failure is
 * the app not working. Added together they make a "problems" figure that an
 * operator will chase, and most of it is the access controls doing their job.
 */
export function trafficCaption(series: TrafficBar[], singular: string, plural: string, runs: number): string {
  const total = series.reduce((sum, bar) => sum + bar.count, 0);
  /*
   * TWO WORDS FOR AN EMPTY CHART, not a sentence, and no denominator.
   *
   * Failures and refusals are stacked and both are usually empty, so the sentence
   * this used to return was rendered twice within a couple of centimetres of
   * itself: "No failures in this range, out of 16 runs that ended in it." then
   * "No refusals in this range, out of 16 runs that ended in it." The only word
   * that differed was the noun, and the run count it repeated is in the band at
   * the top of the block, once, where it governs all three charts.
   */
  if (total === 0) return `No ${plural}`;
  const noun = total === 1 ? singular : plural;
  return runs > 0 ? `${count(total)} ${noun} out of ${count(runs)} recorded runs.` : `${count(total)} ${noun}.`;
}

export function activeMinutesDisplay(payload: OpsTrafficPayload): { title: string; note: string } {
  const total = (payload.activeMinutesPerDay ?? []).reduce((sum, day) => sum + day.count, 0);
  const title = `Active app minutes · ${count(total)} total`;
  const from = payload.activeMinutesRecordedFrom ?? '';
  const through = payload.activeMinutesRecordedThrough ?? '';
  if (!from) return { title, note: 'Recording starts with this release; no backfill.' };
  const timeZone = payload.activeMinutesTimeZone || undefined;
  const format = (value: string) => {
    const at = new Date(value);
    if (!Number.isFinite(at.getTime())) return value;
    return at.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
      timeZoneName: 'short',
    });
  };
  const firstDay = payload.activeMinutesPerDay?.[0]?.day ?? '';
  const dayParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(new Date(from))
    .reduce<Record<string, string>>((parts, part) => ({ ...parts, [part.type]: part.value }), {});
  const recordedStartDay = `${dayParts.year}-${dayParts.month}-${dayParts.day}`;
  const prefix = firstDay && firstDay === recordedStartDay ? 'Partial coverage since' : 'Recorded since';
  return {
    title,
    note: `${prefix} ${format(from)}${through ? ` · latest ${format(through)}` : ''}`,
  };
}

/* ── Latency ─────────────────────────────────────────────────────────────── */

/**
 * A duration at the scale it was measured at.
 *
 * THREE SCALES, BECAUSE THIS BLOCK SPANS FIVE ORDERS OF MAGNITUDE. The routes
 * measured here run from under a millisecond to over two minutes, and
 * Monitoring's one-decimal-seconds form prints most of them as `0.0s`. A column
 * of `0.0s` is a column of zeroes, which this tab does not print, and worse it
 * reads as a measurement of nothing rather than as a fast route.
 *
 * Never rounds a real duration down to a bare zero: a sub-millisecond span
 * keeps its decimal.
 */
export function latencyFigure(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 90_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/*
 * THE BLOCK NO LONGER PRINTS THE WINDOW ITS SPANS COVER, and it is worth saying
 * what that was and what it cost, because it was not decoration: "Spans recorded
 * 2026-08-16 19:31 to 2026-08-17 18:07" said that this one block is NOT bounded
 * by the range chip at the top of the page, since telemetry does not backfill and
 * the table reaches back hours where the range reaches back days.
 *
 * Two timestamps to the minute is a lot of head-band for a fact that changes
 * nothing a reader does with a percentile, and `coveredFrom` and `coveredTo` are
 * still on the payload for whatever says it next. What is lost is that a reader
 * comparing this block against Traffic has nothing on screen telling them the two
 * are over different windows.
 */

/**
 * Why the latency block has no figures, when it has none.
 *
 * The same four-way split the cost block makes, and for the same reason: an
 * unreadable table, a missing grant, a table with nothing in it and a
 * deployment with telemetry switched off are four different things to do next.
 * Returns null when there are figures, so a caller cannot draw both.
 */
export function latencyAbsence(payload: OpsLatencyPayload): Absence | null {
  if (payload.state === 'ready' && payload.routes.length > 0) return null;
  return {
    title:
      payload.state === 'no-grant' || payload.state === 'unreadable' || payload.state === 'no-warehouse'
        ? 'Latency could not be read'
        : 'No timings recorded',
    body: payload.reason,
  };
}

/**
 * What a withheld 95th prints as.
 *
 * A MARK, NEVER A NUMBER. Under the floor there is no percentile to show, and
 * every candidate substitute -- a zero, the median repeated, the slowest span
 * unlabelled -- is a figure a reader would compare against a real percentile
 * computed over hundreds. The explanation rides on the cell's `title` rather
 * than the page, because this block prints figures and not prose.
 */
export const WITHHELD = '\u2014';

/** Said to a screen reader and on hover, where a mark alone would not carry. */
export function withheldReason(spans: number): string {
  return `Withheld: ${spans} spans is under the ${SPAN_PERCENTILE_FLOOR} needed for a high percentile. The slowest span is labelled beside it.`;
}

/**
 * How a route compares to its own prior-half median.
 *
 * Relative baseline, never a fixed budget. Thin on either half, or a missing
 * prior period, produces no flag: a red mark on three spans trains people to
 * ignore red marks.
 */
export type LatencyVerdict = 'slower' | 'within' | 'too-thin' | 'not-reported';

export interface LatencyRouteView {
  verdict: LatencyVerdict;
  /** Word on the row. Never colour alone. */
  verdictLabel: string;
  /** Why, naming both populations. '' when within range. */
  verdictDetail: string;
  /** Error count with its population, or '' when zero (zero counts never render). */
  errorsLabel: string;
  /** Always "Not reported" today: refusals are not on the span. */
  refusalsLabel: string;
  /** Relative freshness, or "Not reported" when the warehouse sent no time. */
  freshLabel: string;
}

/**
 * Split a route name so a UUID tail does not widen the table.
 *
 * Method stays on the first line; a trailing UUID (or similarly opaque id) drops
 * onto a second line rather than being clipped mid-phrase.
 */
export function splitRouteLabel(route: string): { head: string; tail: string } {
  const match = route.match(/^(.*?\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (match) return { head: match[1].replace(/\/$/, ''), tail: match[2] };
  const parts = route.split(' ');
  if (parts.length >= 2 && parts[0] === parts[0].toUpperCase() && parts[0].length <= 7) {
    return { head: parts[0], tail: parts.slice(1).join(' ') };
  }
  return { head: route, tail: '' };
}

/**
 * The HTTP method and the path, split off the span name.
 *
 * The platform writes a span as `POST /api/insights/ask`. The compact grid draws
 * the method as its own coloured chip and the path as the flexing, ellipsised
 * cell, so they are separated here rather than in the component: a span with no
 * leading method (some background spans have none) keeps its whole text as the
 * path and draws no chip, which is the honest thing rather than inventing a GET.
 */
export function splitMethod(route: string): { method: string; path: string } {
  const match = route.match(/^([A-Z]{3,7})\s+(.+)$/);
  if (match) return { method: match[1], path: match[2] };
  return { method: '', path: route };
}

/**
 * How wide each p50 bar is, log-scaled across the rows on screen so the fastest
 * and the slowest route are both legible.
 *
 * THE SCALE IS THE WHOLE POINT, AND IT IS LOG RATHER THAN LINEAR. These routes
 * run from under a millisecond to over a minute — five orders of magnitude — and
 * a linear bar draws 65ms as roughly nothing beside an 83.5s bar: 0.08% of the
 * track, a bar a reader cannot see, which reads as a route that was not measured
 * rather than as a fast one. Logarithms put the fast routes back on the chart:
 * the smallest positive value gets {@link P50_BAR_MIN_WIDTH} and the largest gets
 * the full track, with everything spaced by ratio between them.
 *
 * Zero and absent values get a zero-width bar, never the floor: a drawn bar is a
 * claim there is a duration to draw, and the p50 figure beside it is the number
 * that cannot be misread. When every visible p50 is equal the scale collapses,
 * and each full bar says truthfully that they are the same.
 */
export const P50_BAR_MIN_WIDTH = 6;

export function p50BarWidths(values: number[]): number[] {
  const positives = values.filter((value) => Number.isFinite(value) && value > 0);
  if (positives.length === 0) return values.map(() => 0);
  const logLo = Math.log(Math.min(...positives));
  const span = Math.log(Math.max(...positives)) - logLo;
  return values.map((value) => {
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (span <= 0) return 100;
    const fraction = (Math.log(value) - logLo) / span;
    return Math.round(P50_BAR_MIN_WIDTH + fraction * (100 - P50_BAR_MIN_WIDTH));
  });
}

/**
 * The one strip above the latency table, and whether the high-percentile
 * columns render at all.
 *
 * A FACT TRUE OF EVERY ROW IS SAID ONCE, NEVER PER ROW. On a quiet window every
 * route is under the span floor, so p95, p99 and the trend verdict are withheld
 * on all of them. Five columns of the same dash is five columns saying nothing,
 * so this collapses them into one sentence above the table. When even one route
 * crosses the floor its p95/p99/trend are worth a column again, so the columns
 * come back and this line stops claiming there are none.
 */
export interface LatencySharedFacts {
  /** The strip's sentence, or '' when nothing is universally empty. */
  line: string;
  /** Whether p95/p99/trend render as columns, because a route crossed the floor. */
  showPercentiles: boolean;
}

export function latencySharedFacts(routes: RouteLatency[]): LatencySharedFacts {
  // No routes means an absence is drawn instead of the table; there is nothing
  // for this strip to state, so it says nothing rather than a fact about an
  // empty set.
  if (routes.length === 0) return { line: '', showPercentiles: false };
  const showPercentiles = routes.some((route) => route.p95Ms !== null);
  const line = showPercentiles
    ? ''
    : `Every route is under ${SPAN_PERCENTILE_FLOOR} recorded requests: no p95, p99, or trend yet.`;
  return { line, showPercentiles };
}

export function latencyRouteView(route: RouteLatency, nowMs: number = Date.now()): LatencyRouteView {
  const refusalsLabel = 'Not reported';
  const errorsLabel = route.errorCount > 0 ? `${count(route.errorCount)} of ${count(route.spans)} spans` : '';
  const freshLabel = freshAgo(route.lastSpanAt, nowMs);

  if (route.spans < LATENCY_BASELINE_FLOOR || route.priorSpans < LATENCY_BASELINE_FLOOR) {
    return {
      verdict: 'too-thin',
      verdictLabel: 'Too thin to judge',
      verdictDetail:
        `Needs ${LATENCY_BASELINE_FLOOR} requests in each all-time half ` +
        `(recent half ${count(route.spans)}, earlier half ${count(route.priorSpans)}).`,
      errorsLabel,
      refusalsLabel,
      freshLabel,
    };
  }

  if (route.priorP50Ms === null || route.priorP50Ms <= 0) {
    return {
      verdict: 'not-reported',
      verdictLabel: 'Not reported',
      verdictDetail: 'No earlier-half median to compare against.',
      errorsLabel,
      refusalsLabel,
      freshLabel,
    };
  }

  if (route.p50Ms >= route.priorP50Ms * LATENCY_SLOWER_RATIO) {
    const ratio = route.priorP50Ms > 0 ? route.p50Ms / route.priorP50Ms : 0;
    return {
      verdict: 'slower',
      verdictLabel: 'Slower than baseline',
      verdictDetail:
        `Recent-half p50 is ${ratio.toFixed(1)}× the earlier-half p50 ` +
        `(${count(route.spans)} vs ${count(route.priorSpans)} spans).`,
      errorsLabel,
      refusalsLabel,
      freshLabel,
    };
  }

  return {
    verdict: 'within',
    verdictLabel: 'Within baseline',
    verdictDetail: '',
    errorsLabel,
    refusalsLabel,
    freshLabel,
  };
}

/**
 * Which trend pills are on. Neither, one, or both — never a third exclusive
 * "no data" unless both are on, which drops the dashes.
 */
export interface LatencyTrendFilter {
  within: boolean;
  outside: boolean;
}

/**
 * Whether one route belongs under the two TREND toggles.
 *
 * Neither on: every row, including a dash. One on: only that verdict. Both on:
 * every row that has a verdict, so the dashes drop out. A missing trend is not
 * "outside": outside is the red slower pill, not an absence of one.
 */
export function latencyRouteMatchesTrend(verdict: LatencyVerdict, filter: LatencyTrendFilter): boolean {
  const { within, outside } = filter;
  if (!within && !outside) return true;
  if (within && outside) return verdict === 'within' || verdict === 'slower';
  if (within) return verdict === 'within';
  return verdict === 'slower';
}

/** Relative age of the last span, or "Not reported" when nothing was timed. */
function freshAgo(at: string, nowMs: number): string {
  if (!at) return 'Not reported';
  const then = Date.parse(at.includes('T') ? at : at.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(then)) return 'Not reported';
  const minutes = Math.max(0, Math.round((nowMs - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return '1 hr ago';
  if (hours < 48) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
