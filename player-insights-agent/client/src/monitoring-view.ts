/**
 * Every decision Monitoring makes about what a figure is allowed to say.
 *
 * Separate from the page for the reason `unavailable-copy.ts` is separate from
 * the panel it fills: these are the claims the app makes about its own numbers,
 * and they have to be assertable without rendering anything. The page below is
 * layout.
 *
 * THE RULES THIS FILE ENFORCES, each of which has been got wrong somewhere in
 * this app before:
 *
 *  - Human feedback is counted by direction, never averaged into a score.
 *  - Refused and failed are never added. There is no function here that returns
 *    their sum, which is the only reliable way to stop one appearing.
 *  - A 95th percentile over fewer than twenty runs is not a percentile. It
 *    becomes the slowest run, labelled as the slowest run.
 *  - A token total names how many runs it covers, always. The app records zero
 *    when the model reported no usage, and a zero is indistinguishable from an
 *    unknown once it is inside a sum.
 *  - Nothing here invents a number to fill a tile. Where a figure cannot be
 *    sourced the tile says so in words.
 *
 * No em dashes in any string in this file. Short declarative sentences, for
 * somebody who does not read the code.
 */

import type { MonitoringQuestion, MonitoringSummary, QuestionOutcome } from '../../shared/monitoring-contract';
import { dataAccessDisclosure } from './analytical-execution';

/** Under this many runs, a 95th percentile is the slowest run instead. */
export const PERCENTILE_FLOOR = 20;

/** What a tile shows where there is no number to show. */
export interface TileValue {
  /** The large figure, or null when there is none to print. */
  value: string | null;
  /**
   * The sentence that replaces the figure when there is none.
   *
   * Present exactly when `value` is null, so a tile can never render blank and
   * can never render a figure and an excuse at the same time.
   */
  absence: string | null;
  caption: string;
}

function tile(value: string, caption: string): TileValue {
  return { value, absence: null, caption };
}

function absent(absence: string, caption: string): TileValue {
  return { value: null, absence, caption };
}

/** A count, grouped, so a four-figure total is readable. */
function count(value: number): string {
  return value.toLocaleString();
}

/**
 * A recorded run time, as the design prints it: seconds to one decimal.
 *
 * NOT `formatMs` from trace-timeline.ts, and the difference is deliberate rather
 * than an oversight. That one gives two decimals above a second, because on the
 * timeline the remainder is the panel's own evidence that the stage durations
 * reconcile to the total. Nothing on this page reconciles anything, and a column
 * of `76.20s` spends two characters per row on precision no reader of a list
 * wants. One decimal at every magnitude, so the column stays comparable at a
 * glance and a slow run does not change units halfway down.
 *
 * Null rather than a zero for anything that was not recorded. A run that reported
 * no duration did not take no time.
 */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The label on the range, for the captions that name it. */
export type RangeLabel = string;

export function questionsAskedTile(summary: MonitoringSummary): TileValue {
  return tile(count(summary.questionsAsked), 'Submitted in this period');
}

export function userThreadsTile(summary: MonitoringSummary): TileValue {
  return tile(count(summary.userThreads), 'Distinct conversation threads');
}

/**
 * The four-part tile, using the same verdicts as the run table.
 *
 * The caption in the design reads "sum to questions asked", and it is only
 * printed when they do. A range holding a clarification, a cancelled run, or a
 * run still executing does not add up, and claiming it does would send an admin
 * looking for a counting bug. So the remainder is named instead.
 *
 * The three values are returned separately and there is no total. Refused and
 * failed are different problems with different fixes.
 */
export interface OutcomeTile {
  completed: string;
  partial: string;
  refused: string;
  failed: string;
  caption: string;
}

export function outcomeTile(summary: MonitoringSummary): OutcomeTile {
  const { completed, partial, refused, failed, questionsAsked } = summary;
  const accounted = completed + partial + refused + failed;
  const missing = questionsAsked - accounted;
  const terminal = `${count(accounted)} finished question${accounted === 1 ? '' : 's'}`;
  const caption =
    accounted === questionsAsked
      ? terminal
      : `${terminal} · ${count(missing)} more ${missing === 1 ? 'has' : 'have'} no recorded outcome`;
  return {
    completed: count(completed),
    partial: count(partial),
    refused: count(refused),
    failed: count(failed),
    caption,
  };
}

/** Helpful and Not helpful counts, with no score or average. */
export function feedbackTile(summary: MonitoringSummary): TileValue {
  const total = summary.feedbackTotal ?? summary.ratedTotal ?? 0;
  const helpful = summary.helpful ?? summary.ratedUp ?? 0;
  if (total <= 0) return absent('No feedback', 'No feedback in this period');
  const notHelpful = total - helpful;
  return tile(count(total), `${count(helpful)} Helpful · ${count(notHelpful)} Not helpful`);
}

/**
 * The median recorded answer time, over the runs that recorded one.
 *
 * The caption names the coverage whenever it is short of the questions asked,
 * for the same reason the token total does: a median over eight of forty runs is
 * a median of eight runs.
 */
export function medianAnswerTimeTile(summary: MonitoringSummary): TileValue {
  const formatted = formatDuration(summary.medianMs);
  const caption = `Over ${count(summary.timedCount)} of ${count(summary.questionsAsked)} runs`;
  if (formatted === null) {
    return absent('No run times recorded', caption);
  }
  return tile(formatted, caption);
}

/**
 * The token total and the runs it covers, which are one figure and not two.
 *
 * The coverage caption is unconditional. It is printed when coverage is complete
 * as well, because "over 41 of 41 runs" is the sentence that teaches a reader
 * what the shorter one means when it appears.
 */
export function tokensTile(tokens: { total: number; metredRuns: number; totalRuns: number }): TileValue {
  if (tokens.totalRuns === 0) {
    return absent('No runs in this range', '');
  }
  if (tokens.metredRuns === 0) {
    return absent('Not metred', '');
  }
  return tile(count(tokens.total), `over ${count(tokens.metredRuns)} of ${count(tokens.totalRuns)} runs`);
}

/**
 * The mark this panel prints where a figure was not computed.
 *
 * An en dash, where `ops-view.ts` uses an em dash for the same job on the
 * latency block. Every string in this file is held to no em dash, and the mark
 * reads identically.
 */
export const NO_FIGURE = '\u2013';

/**
 * What the measured tokens cost when the deployment configured their rate.
 *
 * Null means there is no defensible figure, so the whole tile is omitted. An
 * empty KPI card would spend the same space as a measured fact while reporting
 * only a configuration detail.
 */
export function tokenCostTile(costUsd: number | null): TileValue | null {
  if (costUsd === null) return null;
  return tile(`$${costUsd.toFixed(2)}`, 'at configured rate · USD');
}

/**
 * Median and 95th percentile, or median and the slowest run.
 *
 * Below twenty runs the second figure is the slowest run and says so. A "95th
 * percentile" over six runs is the second-slowest of six, and naming it a
 * percentile invites a reader to compare it with one computed over four hundred.
 */
export interface AnswerTimeTile extends TileValue {
  /** The second line: the percentile, or the labelled slowest run. */
  tail: string;
}

export function answerTimeTile(durationsMs: number[]): AnswerTimeTile {
  const sorted = durationsMs.filter((ms) => Number.isFinite(ms) && ms >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return {
      ...absent('No run times recorded', ''),
      tail: '',
    };
  }
  const median = formatDuration(percentile(sorted, 50)) ?? '';
  const slowest = formatDuration(sorted[sorted.length - 1]) ?? '';
  if (sorted.length < PERCENTILE_FLOOR) {
    return {
      ...tile(median, 'median'),
      tail: `${slowest} was the slowest run`,
    };
  }
  return {
    ...tile(median, 'median'),
    tail: `${formatDuration(percentile(sorted, 95)) ?? ''} at the 95th percentile`,
  };
}

/** Nearest-rank on a sorted ascending list. No interpolation, so it is a real run. */
function percentile(sortedAscending: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index];
}

/** The feedback split on the per-user panel. Directions are never netted. */
export function personFeedbackTile(helpful: number, notHelpful: number): TileValue {
  const total = helpful + notHelpful;
  if (total === 0) return absent('No feedback', '');
  return tile(count(total), `${count(helpful)} Helpful · ${count(notHelpful)} Not helpful`);
}

/* ── The states, and the three empties that are not the same empty ───────── */

export type MonitoringState =
  | 'loading'
  | 'empty-range'
  | 'empty-filters'
  | 'empty-search'
  | 'unavailable'
  | 'partial'
  | 'ready';

export type EmptyState = 'empty-range' | 'empty-filters' | 'empty-search';

export interface EmptyCopy {
  sentence: string;
  /** Whether a Clear filters action belongs beside it. */
  clearFilters: boolean;
  /** Whether a Clear search action belongs beside it. */
  clearSearch: boolean;
}

/**
 * Which empty this is, and what it says.
 *
 * Conflating them sends somebody looking for a data problem that is a filter
 * they set themselves, which is the single most common way a review surface
 * wastes an afternoon. There are three, not two, because a typed word and a set
 * chip fail differently and are undone differently.
 *
 * The search empty quotes the word back, so a reader who mistyped can see that
 * they did. Where a chip is narrowing as well, the sentence says so: clearing
 * the word alone would not bring the list back, and an empty that names only one
 * of two causes is an empty that gets read twice.
 */
export function emptyCopy(state: EmptyState, options: { search?: string; chips?: boolean } = {}): EmptyCopy {
  if (state === 'empty-range') {
    return { sentence: 'No questions in this range.', clearFilters: false, clearSearch: false };
  }
  if (state === 'empty-search') {
    const term = (options.search ?? '').trim();
    const quoted = term ? `Nothing matches "${term}".` : 'Nothing matches your search.';
    return {
      sentence: quoted,
      clearFilters: options.chips === true,
      clearSearch: true,
    };
  }
  return { sentence: 'No questions match these filters.', clearFilters: true, clearSearch: false };
}

/**
 * The state, from the read and the filters, in one place.
 *
 * `filtersActive` is what tells the two empties apart, and it is passed in
 * rather than derived from the row count: a filter that happens to match
 * everything still means a reader who sees nothing set something.
 */
export function monitoringState(input: {
  loading: boolean;
  readState: 'ok' | 'partial' | 'unavailable' | null;
  rowCount: number;
  filtersActive: boolean;
  /** Whether the reader has typed into the search box. */
  searchActive?: boolean;
}): MonitoringState {
  if (input.loading) return 'loading';
  if (input.readState === 'unavailable' || input.readState === null) return 'unavailable';
  if (input.rowCount === 0) {
    // The search wins where both are set, because the word is the thing the
    // reader typed most recently and the thing they will try changing first. The
    // copy for that state names the chips as well, so nothing is hidden by the
    // precedence.
    if (input.searchActive === true) return 'empty-search';
    return input.filtersActive ? 'empty-filters' : 'empty-range';
  }
  return input.readState === 'partial' ? 'partial' : 'ready';
}

/**
 * What a partial read says about its own coverage.
 *
 * The strip still renders, because a figure over a stated denominator is useful
 * and a blank page is not. What it must never do is print a count with no
 * denominator at all.
 */
export function partialSentence(counted: number, found: number | null): string {
  return found !== null && found > counted
    ? `Counted ${count(counted)} of ${count(found)} questions. All figures above except User threads are over the ${count(counted)} that were read; User threads covers the full selected range.`
    : `Counted ${count(counted)} questions. All figures above except User threads are over those ${count(counted)}; User threads covers the full selected range.`;
}

/** The one line above the list when the permissions check could not run. */
export const GRANTS_UNRESOLVED_LINE = 'Could not check your table permissions just now, so everything is shown.';

/*
 * THERE IS DELIBERATELY NO LINE HERE ABOUT THE SIZE OF THE WINDOW.
 *
 * A `slowRangeLine` used to print "N questions in this range. This read slows as
 * that number grows." above the list past 500 questions. It was a stand-in for a
 * guard, written while the read genuinely was quadratic in the range: the pairing
 * joined on the result of a correlated subquery, so no index could serve it and
 * an all-time window paid once per question.
 *
 * `MONITORING_QUESTIONS_QUERY` was rewritten to page first and pair per page, so
 * the answer-side work is bounded by the page rather than by the window and the
 * growth that line described no longer happens. A warning about a cost nobody
 * pays teaches a reader to narrow a range for no reason, so it is gone rather
 * than reworded.
 *
 * The limit that IS load-bearing is the server's `QUESTION_READ_LIMIT`, and
 * `partialSentence` above is what says so on the page: past the cap the read is
 * partial and the strip states its own denominator. That one stays.
 */

/** The body line that replaces an answer the reader's grants do not cover. */
export function conditioningLine(table: string, permission: string): string {
  return `${table}: you do not have ${permission} on this table.`;
}

/** The closing caption on the permissions section. It is load-bearing. */
export const LIVE_VERSUS_RECORDED =
  'Grants, filters and masks are read now. Everything else is what was recorded when each question ran.';

/* ── What a person's runs carried, as badges ─────────────────────────────── */

/** The word on a table's badge, and never a colour on its own. */
export const NOT_CHECKED = 'Not checked';

/** One permission a person's runs actually carried, with the runs that did. */
export interface ReadScope {
  /** What the runs were bounded by, in four or five words. */
  label: string;
  /** How many runs carried it, grouped, with its noun. */
  runs: string;
  /** Decoration over the label. The label is the fact. */
  tone: 'ok' | 'neutral';
}

function runsCarrying(runs: number): string {
  return `${count(runs)} run${runs === 1 ? '' : 's'}`;
}

/**
 * The permissions section, as badges rather than as three paragraphs.
 *
 * WHAT THIS REPLACED, because the shape of it is the point. The section used to
 * be prose: which identity executed, whether the token's subject could be
 * checked, and what the access gate had checked, each written out as a sentence
 * with a clause explaining what the sentence did not mean. Three paragraphs to
 * carry four counts, on a panel whose other six facts are tiles.
 *
 * A SCOPE IS ONLY LISTED WHERE RUNS CARRIED IT. Nothing here reports a bucket of
 * zero, and nothing reports the runs that recorded nothing. The old prose said
 * "1 did not record which identity ran them", which is the doubting sentence the
 * answer footer just deleted, wearing a count: it states no permission, it cannot
 * be acted on, and beside a person's name on the one page that knows who asked it
 * reads as a hint that their question was answered as somebody else. Where a run
 * recorded who it ran as, this says so; where it did not, this says nothing. See
 * `askerGrantsLine` below, which drops its segment for the same reason.
 *
 * THE ACCESS GATE IS NOT HERE, and must not be added back. `ACCESS_GATE_ENABLED`
 * in shared/access-gate.ts is false, so a count of runs the gate verified,
 * skipped or had not checked is a count about a feature that is switched off.
 *
 * Ordered so the ordinary case leads: an admin reading this wants "their own
 * grants" first, and the application's grants are the row worth noticing.
 */
export function readScopes(panel: {
  executionSplit: { asThemselves: number; asApplication: number };
  subjectSplit: { verified: number; confirmedByEndpoint: number };
}): ReadScope[] {
  const scopes: ReadScope[] = [];
  if (panel.executionSplit.asThemselves > 0) {
    scopes.push({
      label: 'Their own Unity Catalog grants',
      runs: runsCarrying(panel.executionSplit.asThemselves),
      tone: 'ok',
    });
  }
  if (panel.executionSplit.asApplication > 0) {
    // Neutral, not red. Running as the application is a configured mode of this
    // app and not a fault, and the grants rows below are the same either way.
    scopes.push({
      label: "The application's grants",
      runs: runsCarrying(panel.executionSplit.asApplication),
      tone: 'neutral',
    });
  }
  if (panel.subjectSplit.verified > 0) {
    scopes.push({
      label: 'Sign-in verified on the token',
      runs: runsCarrying(panel.subjectSplit.verified),
      tone: 'ok',
    });
  }
  if (panel.subjectSplit.confirmedByEndpoint > 0) {
    // Also ordinary, which is why it is neutral and not amber. The endpoint
    // confirmed the subject instead of the token carrying it.
    scopes.push({
      label: 'Sign-in confirmed by the endpoint',
      runs: runsCarrying(panel.subjectSplit.confirmedByEndpoint),
      tone: 'neutral',
    });
  }
  return scopes;
}

/**
 * One table's badge, in the vocabulary the first-open gate already uses.
 *
 * THREE RECIPES, NOT TWO. A reading that did not answer arrives here as
 * `canRead: false` with `Not checked` in `missing`, and the row used to paint it
 * the red "Cannot read" badge and put "Not checked" in grey beside it: a
 * permissions finding nobody established, contradicted by the words next to it.
 * Not checked means not checked yet, and takes the neutral badge the gate gives
 * a scope nothing showed to be absent.
 */
export function grantBadge(grant: { canRead: boolean; missing: string | null }): {
  label: string;
  tone: 'ok' | 'neutral' | 'bad';
} {
  if (grant.missing === NOT_CHECKED) return { label: NOT_CHECKED, tone: 'neutral' };
  return grant.canRead ? { label: 'Can read', tone: 'ok' } : { label: 'Cannot read', tone: 'bad' };
}

/**
 * The drawer's meta line, in the app's existing wording.
 *
 * Derived from `dataAccessDisclosure` rather than written again, so the sentence
 * an admin reads here is the sentence a consumer reads under their own answer.
 * The possessive is swapped because the reader is not the asker.
 *
 * Null where the run recorded no identity, which is the same silence the answer
 * footer keeps, and for a sharper reason on this surface: Monitoring knows who
 * asked. A line here doubting the identity would be doubting it in front of the
 * one fact the page is certain of, and reads as a hint that the question was
 * answered as somebody other than the asker. The caller drops the segment.
 */
export function askerGrantsLine(execution: { mode: string; verified: boolean } | null, asker: string): string | null {
  const base = dataAccessDisclosure(execution ?? undefined);
  if (!base) return null;
  const name = asker.trim();
  if (!name) return base;
  return base.replace('your own', `${name}'s own`);
}

/** The local part, which is what the list shows. Full address goes on `title`. */
export function localPart(email: string): string {
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

/**
 * When one question was asked, as the drawer's meta line prints it.
 *
 * `Aug 15, 09:12`, which is the design's format and not `toLocaleString`'s. The
 * default was rendering `8/15/2026, 3:12:00 AM`: a four-figure year on a stamp
 * from this week, seconds nobody reads, and a twelve-hour clock in a line that
 * sits beside a column of times written the other way. The month is a word
 * because a numbered month in a list read by two people in two countries is
 * ambiguous, and `h23` rather than `hour12: false` because that option prints
 * midnight as 24 in some locales.
 *
 * Local to the reader, deliberately. An admin comparing this against a stamp in
 * MLflow or a message in a channel is working in their own hours.
 */
export function askedAtLabel(iso: string): string {
  const at = Date.parse(iso);
  // Not a dash and not the epoch. A stamp this cannot read is a stamp that was
  // not recorded in a form anybody can print.
  if (!Number.isFinite(at)) return 'when it was asked was not recorded';
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/**
 * The heading over the timeline: "What ran", and what it cost, when recorded.
 *
 * The two figures come from the run's own trace, which is the same place the
 * list's Time and Tools columns read, so the drawer cannot report a duration the
 * row disagrees with. Each is appended only if it is there: a run that recorded
 * no envelope gets "What ran" and nothing else, rather than "What ran · 0.0s ·
 * 0 tool calls", which is two measurements nobody took.
 *
 * `toolCalls` is the agent's own count of external calls and is not the number
 * of rows in the timeline below. The timeline says so itself where the two
 * differ; this line uses the agent's count because that is what the list column
 * beside it uses.
 */
export function whatRanHeading(trace: unknown): string {
  const summary = (trace ?? null) as { totalMs?: unknown; toolCalls?: unknown } | null;
  const parts = ['What ran'];
  const duration = formatDuration(typeof summary?.totalMs === 'number' ? summary.totalMs : null);
  if (duration !== null) parts.push(duration);
  const calls = typeof summary?.toolCalls === 'number' && Number.isFinite(summary.toolCalls) ? summary.toolCalls : null;
  if (calls !== null) parts.push(`${count(calls)} tool call${calls === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * When, relative under a day and absolute after.
 *
 * A relative stamp is what a reader wants for something that happened during
 * this sitting and is actively unhelpful for something from last Tuesday.
 */
export function whenLabel(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const ago = now - at;
  if (ago < 0) return 'just now';
  const minutes = Math.floor(ago / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return 'Yesterday';
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The word on an outcome pill. Never colour alone. */
export const OUTCOME_LABEL: Record<QuestionOutcome, string> = {
  completed: 'Completed',
  partial: 'Partial',
  refused: 'Refused',
  failed: 'Failed',
};

/**
 * The pill's tone, which is decoration over the word above.
 *
 * `other` is neutral rather than red. A question whose outcome nobody recorded
 * is not a failure, and painting it as one manufactures an incident.
 */
export const OUTCOME_TONE: Record<QuestionOutcome, 'ok' | 'warn' | 'neutral' | 'bad'> = {
  completed: 'ok',
  partial: 'warn',
  refused: 'neutral',
  failed: 'bad',
};

/** Sorted newest first, which is the order the list is specified in. */
export function newestFirst(questions: MonitoringQuestion[]): MonitoringQuestion[] {
  return [...questions].sort((a, b) => Date.parse(b.askedAt) - Date.parse(a.askedAt));
}
