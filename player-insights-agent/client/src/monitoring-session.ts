/**
 * The Monitoring questions list, kept for as long as the app is loaded.
 *
 * WHAT WAS WRONG. The page held its payload in `useState`. React unmounts a
 * route on navigation, so leaving Monitoring and coming back re-ran the
 * questions query -- the one that scans every message in the range -- with
 * nobody asking for it. Refresh already exists for that.
 *
 * ONCE PER SESSION PER REQUEST, NOT ONCE PER VISIT. A request is the normalized
 * range, active filters, and opaque page cursor. The claim is taken from
 * {@link claimAutoLoad} before any fetch is issued. So:
 *
 *   - a second mount of the same range does not re-run it
 *   - React's development double-mount does not re-run it
 *   - an automatic run that FAILED does not re-run it on the next visit
 *   - a different range, filter set, or cursor gets its own first read
 *
 * The last-but-one is the one that is easy to get wrong by keying on the store
 * instead of on a latch: a deployment whose list cannot be read would retry the
 * expensive scan on every navigation, forever, with no button pressed.
 *
 * After the automatic run, Refresh is the only thing that reads the list again.
 *
 * WHY A MODULE-LEVEL STORE RATHER THAN THE OTHER THREE OPTIONS. Same reasons
 * as `check-session.ts`. Not a provider (nothing above the page needs this).
 * Not sessionStorage (results must not outlive this running copy of the app).
 * Not a refetch on mount (that is the behaviour this exists to stop).
 *
 * A RUN IN FLIGHT IS VISIBLE TO WHOEVER IS LOOKING. The subscriber list is
 * not decoration. A reader who opens Monitoring and switches away two seconds
 * later must see that run land when they come back, not an empty page that
 * has given up waiting for a fetch it never made.
 */
import { useCallback, useEffect, useState } from 'react';

import type { MonitoringQuestionsPayload } from '../../shared/monitoring-contract';
import {
  OUTCOME_PARAM,
  PERSON_PARAM,
  RATING_PARAM,
  SEARCH_PARAM,
  TABLE_PARAM,
  type MonitoringFilters,
} from './monitoring-filters';
import { RANGE_PARAM, rangeFromParams, type ReadableParams } from './time-range';

type Listener = () => void;

const listeners = new Set<Listener>();

/** Last completed read for each normalized request, including a failed one. */
const remembered = new Map<string, MonitoringQuestionsPayload | null>();

/** Requests whose one automatic run has been taken. */
const autoClaimed = new Set<string>();

interface InflightRead {
  promise: Promise<MonitoringQuestionsPayload | null>;
  controller: AbortController;
}

/** In-flight read per request. A duplicate caller joins rather than starting another. */
const inflight = new Map<string, InflightRead>();

/** Incremented when the authenticated app session ends. */
let sessionGeneration = 0;

/** The range and secondary filters the Monitoring nav tab should restore. */
let rememberedSearch = '';

function announce(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Which range the URL is asking for, as a stable session key.
 *
 * The computed `from`/`to` timestamps move every time the clock is read, so
 * they cannot be the key: a remount a second later would look like a different
 * window and pay for the scan again. The supported preset in the URL is the
 * question the reader asked, and it is what a later visit is still asking.
 */
export function monitoringRangeId(params: ReadableParams): string {
  return rangeFromParams(params);
}

/**
 * Take this range's one automatic run. True for exactly one caller, ever,
 * until {@link forgetMonitoringSession}.
 *
 * Synchronous and side-effecting on purpose: the caller that gets `true` owns
 * the run, and every later caller gets `false` whether the first one succeeded,
 * failed, or is still in flight. After that only a human pressing Refresh
 * re-reads this range.
 */
export function claimAutoLoad(rangeId: string): boolean {
  if (autoClaimed.has(rangeId)) return false;
  autoClaimed.add(rangeId);
  return true;
}

/** Whether this range's automatic run has been claimed. */
export function autoLoadClaimed(rangeId: string): boolean {
  return autoClaimed.has(rangeId);
}

/** The last completed read for this range, or null where none has completed. */
export function recallQuestions(rangeId: string): MonitoringQuestionsPayload | null {
  return remembered.has(rangeId) ? (remembered.get(rangeId) ?? null) : null;
}

/** Whether a read of this range is in flight right now. */
export function isMonitoringLoading(rangeId: string): boolean {
  return inflight.has(rangeId);
}

/**
 * Drop the store, the latch and any in-flight read. For tests, and for
 * nothing else.
 *
 * All three, because a test that emptied the store and left a range claimed
 * would be testing the second visit while believing it was testing the first.
 */
export function forgetMonitoringSession(): void {
  sessionGeneration += 1;
  for (const read of inflight.values()) read.controller.abort();
  remembered.clear();
  autoClaimed.clear();
  inflight.clear();
  listeners.clear();
  rememberedSearch = '';
}

export interface MonitoringListRequest {
  rangeId: string;
  from: string;
  to: string;
  filters: MonitoringFilters;
  cursor: string;
}

/**
 * Every intentional Monitoring choice, normalized into one stable cache key.
 *
 * The computed timestamps are deliberately absent. They move between mounts,
 * while the preset/filter/page represented here does not; including them caused
 * every return to the tab to miss its retained payload and fetch again.
 */
export function monitoringRequestId(request: MonitoringListRequest): string {
  const normalized = {
    range: request.rangeId,
    person: request.filters.person.trim().toLowerCase(),
    outcome: request.filters.outcome,
    rating: request.filters.rating,
    table: request.filters.table.trim().toLowerCase(),
    search: request.filters.search.trim().toLowerCase(),
    cursor: request.cursor,
  };
  return JSON.stringify(normalized);
}

/** Reset pagination when range or filters produce a different request owner. */
export function monitoringPageForOwner(owner: string, pages: { owner: string; index: number }): number {
  return pages.owner === owner ? pages.index : 0;
}

const RESTORED_SEARCH_PARAMS = [
  RANGE_PARAM,
  PERSON_PARAM,
  OUTCOME_PARAM,
  RATING_PARAM,
  TABLE_PARAM,
  SEARCH_PARAM,
] as const;

/** Remember only view controls, never an open question/person detail panel. */
export function rememberMonitoringSearch(search: string): void {
  const current = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const name of RESTORED_SEARCH_PARAMS) {
    for (const value of current.getAll(name)) kept.append(name, value);
  }
  rememberedSearch = kept.toString();
}

/** The top-nav destination that restores the last Monitoring view this session. */
export function monitoringTabHref(): string {
  return rememberedSearch ? `/monitoring?${rememberedSearch}` : '/monitoring';
}

export function monitoringQuestionsUrl(request: MonitoringListRequest): string {
  const params = new URLSearchParams({
    from: request.from,
    to: request.to,
    limit: '50',
  });
  if (request.cursor) params.set('cursor', request.cursor);
  if (request.filters.person) params.set('person', request.filters.person);
  if (request.filters.outcome) params.set('outcome', request.filters.outcome);
  if (request.filters.rating) params.set('rating', request.filters.rating);
  if (request.filters.table) params.set('table', request.filters.table);
  if (request.filters.search) params.set('q', request.filters.search);
  return `/api/monitoring/questions?${params.toString()}`;
}

async function readQuestions(
  request: MonitoringListRequest,
  signal: AbortSignal
): Promise<MonitoringQuestionsPayload | null> {
  try {
    const response = await fetch(monitoringQuestionsUrl(request), { signal });
    // A 403 is the guard doing its job for a consumer who reached the URL.
    // The body still parses as a payload shape, and `readState` carries the
    // outcome, so there is no separate error path to keep in step.
    const body = (await response.json()) as MonitoringQuestionsPayload;
    return response.ok ? body : { ...body, readState: 'unavailable' };
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    // No stand-in rows and no invented figures. The page swaps its body for
    // the storage-failure panel, which says the list is blank because nobody
    // could read it.
    return null;
  }
}

/**
 * Cancel list reads that no longer belong to the range/filter/page on screen.
 *
 * Results are keyed, so an old response could not paint under a new period.
 * Cancellation still matters: changing period must not leave an expensive scan
 * running after every visible KPI, row, and detail panel has moved on.
 */
export function abortMonitoringRequestsExcept(requestId: string): void {
  for (const [id, read] of inflight) {
    if (id !== requestId) read.controller.abort();
  }
}

/**
 * Read the list and keep the result, whatever it is.
 *
 * A second call for a range that is already in flight joins that run rather
 * than starting another. Refresh uses this directly; the automatic run goes
 * through {@link claimAutoLoad} first.
 */
export async function loadMonitoringQuestions(
  request: MonitoringListRequest
): Promise<MonitoringQuestionsPayload | null> {
  const requestId = monitoringRequestId(request);
  const existing = inflight.get(requestId);
  if (existing) return existing.promise;

  const controller = new AbortController();
  const generation = sessionGeneration;
  const work = readQuestions(request, controller.signal)
    .then((payload) => {
      if (controller.signal.aborted || generation !== sessionGeneration) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const previous = recallQuestions(requestId);
      const successful = payload?.readState === 'ok' || payload?.readState === 'partial';
      // A failed refresh never clears the last successful page and KPI strip.
      if (successful || !remembered.has(requestId))
        remembered.set(requestId, successful ? payload : (previous ?? payload));
      return payload;
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        // A return to this request later gets a fresh automatic read rather than
        // restoring an aborted request as an unavailable result.
        autoClaimed.delete(requestId);
        return null;
      }
      throw error;
    })
    .finally(() => {
      if (inflight.get(requestId)?.controller === controller) inflight.delete(requestId);
      announce();
    });
  inflight.set(requestId, { promise: work, controller });
  announce();
  return work;
}

/** First-open/intentional-change entry point. A remount of the same view is a no-op. */
export function autoLoadMonitoringQuestions(
  request: MonitoringListRequest
): Promise<MonitoringQuestionsPayload | null> | null {
  const requestId = monitoringRequestId(request);
  abortMonitoringRequestsExcept(requestId);
  if (!claimAutoLoad(requestId)) return null;
  return loadMonitoringQuestions(request);
}

export interface MonitoringQuestionsSession {
  payload: MonitoringQuestionsPayload | null;
  loading: boolean;
  /** Re-read this range. The only thing that does, after the automatic run. */
  refresh: (nextRequest?: MonitoringListRequest) => void;
}

/**
 * The questions list, for the page that draws it.
 *
 * The first visit of a range starts the read; every visit after that restores
 * the same store. Refresh is the only thing that reads again.
 */
export function useMonitoringQuestions(request: MonitoringListRequest): MonitoringQuestionsSession {
  const requestId = monitoringRequestId(request);
  const [, bump] = useState(0);
  useEffect(() => subscribe(() => bump((count) => count + 1)), []);

  // Guarded by the latch rather than by this effect, so React's development
  // double-invocation and a remount both find it already claimed. `from`/`to`
  // are the window for THIS range's first read. A remount recomputes them
  // from a later clock and must not count as a new question.
  useEffect(() => {
    void autoLoadMonitoringQuestions(request);
  }, [request, requestId]);

  const refresh = useCallback(
    (nextRequest: MonitoringListRequest = request) => {
      void loadMonitoringQuestions(nextRequest);
    },
    [request]
  );

  return {
    payload: recallQuestions(requestId),
    loading: isMonitoringLoading(requestId) || !autoLoadClaimed(requestId),
    refresh,
  };
}
