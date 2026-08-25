/**
 * The Monitoring questions list, kept for as long as the app is loaded.
 *
 * WHAT WAS WRONG. The page held its payload in `useState`. React unmounts a
 * route on navigation, so leaving Monitoring and coming back re-ran the
 * questions query -- the one that scans every message in the range -- with
 * nobody asking for it. Refresh already exists for that.
 *
 * ONCE PER SESSION PER RANGE, NOT ONCE PER VISIT. The claim is taken from
 * {@link claimAutoLoad} before any fetch is issued. So:
 *
 *   - a second mount of the same range does not re-run it
 *   - React's development double-mount does not re-run it
 *   - an automatic run that FAILED does not re-run it on the next visit
 *   - a different range is a different question and gets its own first read
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
import { CUSTOM_FROM_PARAM, CUSTOM_TO_PARAM, rangeFromParams, type ReadableParams } from './time-range';

type Listener = () => void;

const listeners = new Set<Listener>();

/** Last completed read for each range, including a failed one (payload null). */
const remembered = new Map<string, MonitoringQuestionsPayload | null>();

/** Ranges whose one automatic run has been taken. */
const autoClaimed = new Set<string>();

/** In-flight read per range. A second caller joins this rather than starting another. */
const inflight = new Map<string, Promise<MonitoringQuestionsPayload | null>>();

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
 * window and pay for the scan again. The word in the URL (`7d`, `24h`, a
 * custom pair) is the question the reader asked, and it is what a later visit
 * is still asking.
 */
export function monitoringRangeId(params: ReadableParams): string {
  const key = rangeFromParams(params);
  if (key !== 'custom') return key;
  const from = (params.get(CUSTOM_FROM_PARAM) ?? '').trim();
  const to = (params.get(CUSTOM_TO_PARAM) ?? '').trim();
  return `custom:${from}:${to}`;
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
  remembered.clear();
  autoClaimed.clear();
  inflight.clear();
  listeners.clear();
}

async function readQuestions(from: string, to: string): Promise<MonitoringQuestionsPayload | null> {
  try {
    const response = await fetch(
      `/api/monitoring/questions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    );
    // A 403 is the guard doing its job for a consumer who reached the URL.
    // The body still parses as a payload shape, and `readState` carries the
    // outcome, so there is no separate error path to keep in step.
    const body = (await response.json()) as MonitoringQuestionsPayload;
    return response.ok ? body : { ...body, readState: 'unavailable' };
  } catch {
    // No stand-in rows and no invented figures. The page swaps its body for
    // the storage-failure panel, which says the list is blank because nobody
    // could read it.
    return null;
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
  rangeId: string,
  from: string,
  to: string
): Promise<MonitoringQuestionsPayload | null> {
  const existing = inflight.get(rangeId);
  if (existing) return existing;

  const work = readQuestions(from, to)
    .then((payload) => {
      remembered.set(rangeId, payload);
      return payload;
    })
    .finally(() => {
      inflight.delete(rangeId);
      announce();
    });
  inflight.set(rangeId, work);
  announce();
  return work;
}

export interface MonitoringQuestionsSession {
  payload: MonitoringQuestionsPayload | null;
  loading: boolean;
  /** Re-read this range. The only thing that does, after the automatic run. */
  refresh: () => void;
}

/**
 * The questions list, for the page that draws it.
 *
 * The first visit of a range starts the read; every visit after that restores
 * the same store. Refresh is the only thing that reads again.
 */
export function useMonitoringQuestions(
  rangeId: string,
  from: string,
  to: string
): MonitoringQuestionsSession {
  const [, bump] = useState(0);
  useEffect(() => subscribe(() => bump((count) => count + 1)), []);

  // Guarded by the latch rather than by this effect, so React's development
  // double-invocation and a remount both find it already claimed. `from`/`to`
  // are the window for THIS range's first read. A remount recomputes them
  // from a later clock and must not count as a new question.
  useEffect(() => {
    if (claimAutoLoad(rangeId)) void loadMonitoringQuestions(rangeId, from, to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeId]);

  const refresh = useCallback(() => {
    void loadMonitoringQuestions(rangeId, from, to);
  }, [rangeId, from, to]);

  return {
    payload: recallQuestions(rangeId),
    loading: isMonitoringLoading(rangeId) || !autoLoadClaimed(rangeId),
    refresh,
  };
}
