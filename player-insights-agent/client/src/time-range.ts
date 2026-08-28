/**
 * The time range Monitoring and Ops are both read over, and the URL it lives in.
 *
 * ONE MODULE FOR BOTH PAGES, and that is the whole reason it exists. Monitoring
 * reads a question list and a summary strip; Ops reads health, cost and traffic.
 * Every one of those is a figure over a window, and a page whose strip is over
 * one window and whose list is over another is a page that quietly disagrees
 * with itself. Section 5.8 of the plan forbids exactly that, so the range is
 * derived here and nowhere else.
 *
 * WHY THE URL IS THE STORE. An admin who has narrowed Ops to the last 24 hours
 * has done work, and the point of that work is usually to send it to somebody.
 * A range held in component state cannot be sent, cannot be reloaded, and is
 * lost by the browser's back button.
 *
 * `TimeRangeControl.tsx` renders this. Nothing about appearance is decided here,
 * so every rule below can be tested without a browser.
 */

/** The parameter holding the choice. */
export const RANGE_PARAM = 'range';

export type RangeKey = '24h' | '7d' | '30d' | 'all';

/** Seven days, matching Genie's weekly digest, which Monitoring is modelled on. */
export const DEFAULT_RANGE: RangeKey = '7d';

/**
 * The segments, in the order they are drawn, with the word on each.
 *
 * A list rather than four literals in the component, so the control, the tests
 * and anything that later needs to name a range read one set of words. The
 * labels are the design's: "24h" abbreviated, the others spelled out.
 */
export const RANGE_SEGMENTS: readonly { key: RangeKey; label: string }[] = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All time' },
];

const RANGE_KEYS = new Set<string>(RANGE_SEGMENTS.map((segment) => segment.key));

/** The slice of `URLSearchParams` this reads, so a test needs no browser. */
export interface ReadableParams {
  get(name: string): string | null;
}

/**
 * The selected range, defaulting to seven days.
 *
 * An unrecognised value falls back to the default rather than to nothing, so a
 * hand-edited or truncated URL still renders a page.
 */
export function rangeFromParams(params: ReadableParams): RangeKey {
  const raw = (params.get(RANGE_PARAM) ?? '').trim();
  return RANGE_KEYS.has(raw) ? (raw as RangeKey) : DEFAULT_RANGE;
}

export interface RangeWindow {
  /** ISO timestamp of the start of the window. */
  from: string;
  /** ISO timestamp of the end. */
  to: string;
  /** The words a caption uses, so two panels over one window say one thing. */
  label: string;
}

const DAY_MS = 86_400_000;

const SEVEN_DAYS = 'last 7 days';

/**
 * The start of all time, which is a real timestamp rather than an absent bound.
 *
 * The reads this feeds acme ends and bound on both. Sending an empty `from`
 * would have every caller decide separately what an open interval means, and the
 * epoch is earlier than any row a Postgres `timestamptz` column in this store can
 * hold, so it selects everything without any of them having to.
 */
const START_OF_TIME = new Date(0).toISOString();

/**
 * The two timestamps to query, from the word in the URL.
 *
 * `now` is a parameter rather than a call to `Date.now()` so a test can assert
 * the arithmetic instead of the clock, and so a strip and a list rendered in one
 * pass cannot land either side of a midnight.
 *
 * Legacy custom ranges are read as the documented seven-day default. The
 * shared control also removes their obsolete URL parameters.
 */
export function rangeWindow(params: ReadableParams, now: number): RangeWindow {
  const key = rangeFromParams(params);
  const to = new Date(now).toISOString();
  const fallback = { from: new Date(now - 7 * DAY_MS).toISOString(), to, label: SEVEN_DAYS };
  if (key === '24h') {
    return { from: new Date(now - DAY_MS).toISOString(), to, label: 'last 24 hours' };
  }
  if (key === '30d') {
    return { from: new Date(now - 30 * DAY_MS).toISOString(), to, label: 'last 30 days' };
  }
  if (key === 'all') {
    return { from: START_OF_TIME, to, label: 'all time' };
  }
  return fallback;
}

/**
 * Remove the retired custom-range state from a route while preserving every
 * parameter owned by the page. A legacy custom selection becomes the
 * documented seven-day default, represented by an absent `range` parameter.
 */
export function normalizeTimeRangeSearch(search: string): string {
  const params = new URLSearchParams(search);
  if ((params.get(RANGE_PARAM) ?? '').trim() === 'custom') params.delete(RANGE_PARAM);
  params.delete('from');
  params.delete('to');
  const next = params.toString();
  return next ? `?${next}` : '';
}

/**
 * The search string after choosing a range, with everything else left alone.
 *
 * Every parameter this does not recognise is preserved, which is what keeps a
 * filter, an open drawer and anything a later tab adds intact through a range
 * change. Leaving the default range out of the URL keeps a first-visit link
 * clean, and `rangeFromParams` reads an absent parameter as the default, so the
 * two agree.
 *
 * Obsolete custom ends are always removed, so choosing a supported preset also
 * cleans links created by older versions of the app.
 */
export function withRange(search: string, key: RangeKey): string {
  const params = new URLSearchParams(search);
  if (key === DEFAULT_RANGE) params.delete(RANGE_PARAM);
  else params.set(RANGE_PARAM, key);
  params.delete('from');
  params.delete('to');
  const next = params.toString();
  return next ? `?${next}` : '';
}
