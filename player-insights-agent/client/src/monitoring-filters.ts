/**
 * The filter set, as it lives in the URL, and what closing the drawer must not
 * disturb.
 *
 * WHY THE URL IS THE STORE. An admin who has narrowed this page to one person's
 * refusals in the last day has done real work, and the point of that work is
 * usually to send it to somebody. Filters held in component state cannot be
 * sent, cannot be reloaded, and are lost by the browser's back button. So the
 * URL holds them, every control reads them from there, and there is no second
 * copy that could disagree.
 *
 * WHAT THIS MODULE DOES NOT OWN. The time range. It is shared with Ops so that
 * the two tabs cannot be over different windows, and it lives in `time-range.ts`
 * with `TimeRangeControl.tsx` rendering it. Nothing here reads or writes a range
 * parameter: `withFilters` below preserves every parameter it does not
 * recognise, which is what keeps the range, the open drawer and anything a later
 * tab adds intact through a filter change.
 */

import type { MonitoringQuestion } from '../../shared/monitoring-contract';

/** Which question the drawer is open on, and which person's panel. */
export const QUESTION_PARAM = 'question';
export const PERSON_PANEL_PARAM = 'who';

export const PERSON_PARAM = 'person';
export const OUTCOME_PARAM = 'outcome';
export const RATING_PARAM = 'rating';
export const TABLE_PARAM = 'table';
export const SEARCH_PARAM = 'q';

/** Every parameter this page's filter row owns. Nothing else is touched. */
const FILTER_PARAMS = [PERSON_PARAM, OUTCOME_PARAM, RATING_PARAM, TABLE_PARAM, SEARCH_PARAM] as const;

export interface MonitoringFilters {
  /** Full email address, or '' for everyone. */
  person: string;
  /** One of the outcome words, or '' for all. */
  outcome: '' | 'completed' | 'partial' | 'refused' | 'failed';
  rating: '' | 'up' | 'down' | 'unrated';
  /** Fully-qualified table, or '' for any. */
  table: string;
  /**
   * Free text, matched against the question and the person who asked.
   *
   * NOT against table names, deliberately. The Table filter above already
   * matches those, exactly, from the list of tables the range actually read. A
   * free-text match over them as well would mean a row could match for a reason
   * the reader cannot see, and "why is this row here" is the one question a
   * review surface has to be able to answer.
   */
  search: string;
}

export const NO_FILTERS: MonitoringFilters = {
  person: '',
  outcome: '',
  rating: '',
  table: '',
  search: '',
};

/** The slice of `URLSearchParams` this reads, so a test needs no browser. */
export interface ReadableParams {
  get(name: string): string | null;
}

function oneOf<T extends string>(raw: string | null, allowed: readonly T[]): T | '' {
  const value = (raw ?? '').trim();
  return (allowed as readonly string[]).includes(value) ? (value as T) : '';
}

/**
 * The filters the URL is asking for, with anything unrecognised dropped.
 *
 * Dropped rather than passed through, because these values reach a SQL predicate
 * and a pill label. An `outcome=banana` that survived this would either produce
 * an empty list with no explanation, or a chip reading "Outcome · banana".
 */
export function filtersFromParams(params: ReadableParams): MonitoringFilters {
  return {
    person: (params.get(PERSON_PARAM) ?? '').trim(),
    outcome: oneOf(params.get(OUTCOME_PARAM), ['completed', 'partial', 'refused', 'failed'] as const),
    rating: oneOf(params.get(RATING_PARAM), ['up', 'down', 'unrated'] as const),
    table: (params.get(TABLE_PARAM) ?? '').trim(),
    search: (params.get(SEARCH_PARAM) ?? '').trim(),
  };
}

/** Whether the reader has narrowed anything. Tells the empty states apart. */
export function filtersActive(filters: MonitoringFilters): boolean {
  return FILTER_PARAMS.some((param) => filterValue(filters, param) !== '');
}

/**
 * Whether anything OTHER than the search box is narrowing the list.
 *
 * Needed on its own so the empty state can say which of the two is responsible.
 * A reader who has typed a word and sees nothing should be told the word matched
 * nothing, and told separately if a chip is also excluding rows, because
 * clearing the word alone would not bring the list back.
 */
export function chipsActive(filters: MonitoringFilters): boolean {
  return FILTER_PARAMS.filter((param) => param !== SEARCH_PARAM).some((param) => filterValue(filters, param) !== '');
}

/**
 * The rows that survive every filter. They combine with AND.
 *
 * Also applied here as a defensive final pass over the server page. The server
 * receives the same filters so paging does not return two thousand rows, while
 * this pass prevents a mixed-version response from briefly showing a row the
 * URL excludes.
 *
 * `unrated` is a filter value rather than the absence of one. "Show me what
 * nobody rated" is a different question from "show me everything", and the two
 * were indistinguishable while an empty string meant both.
 */
export function applyFilters(
  questions: readonly MonitoringQuestion[],
  filters: MonitoringFilters
): MonitoringQuestion[] {
  return questions.filter((question) => {
    if (filters.person && question.askedBy.toLowerCase() !== filters.person.toLowerCase()) return false;
    if (filters.outcome && question.outcome !== filters.outcome) return false;
    if (filters.rating === 'unrated' && question.rating !== null) return false;
    if ((filters.rating === 'up' || filters.rating === 'down') && question.rating !== filters.rating) {
      return false;
    }
    if (filters.table && !question.tables.includes(filters.table)) return false;
    if (filters.search && !matchesSearch(question, filters.search)) return false;
    return true;
  });
}

/**
 * Whether a row matches the typed text.
 *
 * The question as the reader wrote it, and the person who asked, matched
 * case-insensitively on a substring. That is deliberately the same rule Run
 * Explorer's search uses over its own prompt and person, so a word that finds a
 * run there finds the same question here.
 *
 * The address is matched whole and by its local part, because the list shows the
 * local part: typing what is on screen has to work, and so does pasting the
 * address out of a mail client.
 */
function matchesSearch(question: MonitoringQuestion, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  const email = question.askedBy.toLowerCase();
  const haystack = `${question.question.toLowerCase()} ${email} ${email.split('@')[0]}`;
  return haystack.includes(needle);
}

function filterValue(filters: MonitoringFilters, param: (typeof FILTER_PARAMS)[number]): string {
  switch (param) {
    case PERSON_PARAM:
      return filters.person;
    case OUTCOME_PARAM:
      return filters.outcome;
    case RATING_PARAM:
      return filters.rating;
    case TABLE_PARAM:
      return filters.table;
    case SEARCH_PARAM:
      return filters.search;
  }
}

/**
 * The same search string with the filter parameters replaced.
 *
 * Every parameter this module does not own is copied across untouched. That is
 * the whole contract with the shared range control and with the drawer: a
 * reader who changes Outcome while a drawer is open keeps both the drawer and
 * the selected preset.
 */
export function withFilters(search: string, filters: MonitoringFilters): string {
  const next = new URLSearchParams(search);
  for (const param of FILTER_PARAMS) {
    const value = filterValue(filters, param);
    if (value) next.set(param, value);
    else next.delete(param);
  }
  return next.toString();
}

/** Clearing the filter row, and only the filter row. The range survives. */
export function clearedFilters(search: string): string {
  return withFilters(search, NO_FILTERS);
}

/* ── The drawer ──────────────────────────────────────────────────────────── */

export interface DrawerTarget {
  /** The question message id the drawer is open on, or ''. */
  question: string;
  /** The person whose panel is open, or ''. */
  person: string;
}

export function drawerFromParams(params: ReadableParams): DrawerTarget {
  return {
    question: (params.get(QUESTION_PARAM) ?? '').trim(),
    person: (params.get(PERSON_PANEL_PARAM) ?? '').trim(),
  };
}

export function openQuestion(search: string, id: string): string {
  const next = new URLSearchParams(search);
  next.set(QUESTION_PARAM, id);
  next.delete(PERSON_PANEL_PARAM);
  next.delete('users');
  return next.toString();
}

export function openPerson(search: string, email: string): string {
  const next = new URLSearchParams(search);
  next.set(PERSON_PANEL_PARAM, email);
  next.delete(QUESTION_PARAM);
  next.delete('users');
  return next.toString();
}

export type UserMonitoringUnit = 'USD' | 'DBU';

export interface UserBrowserState {
  open: boolean;
  search: string;
  role: string;
  persona?: string;
  unit: UserMonitoringUnit;
  cursor: string;
}

export function userBrowserFromParams(params: ReadableParams): UserBrowserState {
  const persona = (params.get('userPersona') ?? '').trim();
  return {
    open: params.get('users') === '1',
    search: (params.get('userSearch') ?? '').trim(),
    role: (params.get('userRole') ?? '').trim(),
    persona: persona === 'none' ? '' : persona,
    unit: params.get('userUnit') === 'DBU' ? 'DBU' : 'USD',
    cursor: (params.get('userCursor') ?? '').trim(),
  };
}

export function openUserBrowser(search: string, unit: UserMonitoringUnit = 'USD'): string {
  const next = new URLSearchParams(search);
  next.set('users', '1');
  next.set('userUnit', unit);
  next.delete(QUESTION_PARAM);
  next.delete(PERSON_PANEL_PARAM);
  return next.toString();
}

/** Keep browser filters and cursor while replacing its list with one profile. */
export function openUserFromBrowser(search: string, email: string): string {
  const next = new URLSearchParams(search);
  next.set('users', '1');
  next.set(PERSON_PANEL_PARAM, email);
  next.delete(QUESTION_PARAM);
  return next.toString();
}

export function backToUserBrowser(search: string): string {
  const next = new URLSearchParams(search);
  next.set('users', '1');
  next.delete(PERSON_PANEL_PARAM);
  next.delete(QUESTION_PARAM);
  return next.toString();
}

export function closedUserMonitoring(search: string): string {
  const next = new URLSearchParams(search);
  for (const name of ['users', 'userSearch', 'userRole', 'userPersona', 'userUnit', 'userCursor']) next.delete(name);
  next.delete(PERSON_PANEL_PARAM);
  next.delete(QUESTION_PARAM);
  return next.toString();
}

/**
 * Closing the drawer, which must leave the view underneath exactly as it was.
 *
 * The drawer is not a route change, so closing it is removing two parameters and
 * nothing else. Every filter and the range survive by construction here, which is
 * what makes the promise in the design testable: this function cannot drop a
 * filter, because it never enumerates them.
 */
export function closedDrawer(search: string): string {
  const next = new URLSearchParams(search);
  next.delete(QUESTION_PARAM);
  next.delete(PERSON_PANEL_PARAM);
  return next.toString();
}

/**
 * Whether the drawer is what changed between two search strings.
 *
 * Used to decide against re-fetching the list when somebody opens a row: the
 * list is over a range and a filter set, and neither moved. Without this, opening
 * a drawer re-read every message in the range, which on a review surface is a
 * query per click.
 */
export function onlyDrawerChanged(before: string, after: string): boolean {
  return closedDrawer(before) === closedDrawer(after);
}

/**
 * Where the list was scrolled, so closing the drawer returns to it.
 *
 * A number and a setter rather than a hook, because the claim worth testing is
 * that the value survives a close: `restoreScroll(captureScroll(y))` is the
 * whole promise, and it can be asserted without a browser.
 */
export interface ScrollMemory {
  capture(offset: number): void;
  take(): number | null;
}

export function scrollMemory(): ScrollMemory {
  let saved: number | null = null;
  return {
    capture(offset: number) {
      // Captured on open only. A second capture while the drawer is open would
      // record the drawer's own scroll position and return the reader to it.
      if (saved === null) saved = offset;
    },
    take() {
      const value = saved;
      saved = null;
      return value;
    },
  };
}
