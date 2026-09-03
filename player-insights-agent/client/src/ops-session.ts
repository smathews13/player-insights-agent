/**
 * The Ops blocks, kept for as long as the app is loaded.
 *
 * WHAT WAS WRONG. Each block held its payload in `useState`. React unmounts a
 * route on navigation, so leaving Ops and coming back re-ran health, cost,
 * traffic and latency -- including the billing scan -- with nobody asking for
 * it. Refresh already exists for that. Monitoring had the same defect and
 * keeps the list in {@link ./monitoring-session.ts}; this is that latch for
 * the four Ops reads.
 *
 * ONCE PER SESSION PER BLOCK AND CALENDAR MONTH, NOT ONCE PER VISIT. The
 * claim is taken from {@link claimOpsAutoLoad} before any fetch is issued. So:
 *
 *   - a second mount of the same block does not re-run it
 *   - React's development double-mount does not re-run it
 *   - an automatic run that FAILED does not re-run it on the next visit
 *   - a new calendar month is a new question and gets its own first read
 *
 * The last-but-one is the one that is easy to get wrong by keying on the store
 * instead of on a latch: a deployment whose billing table cannot be read would
 * retry the expensive scan on every navigation, forever, with no button pressed.
 *
 * After the automatic run, Refresh is the only thing that reads a block again.
 *
 * WHY A MODULE-LEVEL STORE RATHER THAN THE OTHER THREE OPTIONS. Same reasons
 * as `check-session.ts` and `monitoring-session.ts`. Not a provider (nothing
 * above the page needs this). Not sessionStorage (results must not outlive
 * this running copy of the app). Not a refetch on mount (that is the behaviour
 * this exists to stop).
 *
 * A RUN IN FLIGHT IS VISIBLE TO WHOEVER IS LOOKING. A reader who opens Ops and
 * switches away two seconds later must see that run land when they come back,
 * not an empty page that has given up waiting for a fetch it never made.
 *
 * RETROSPECTIVE IDENTITY IS THE CALENDAR MONTH. Arbitrary Ops URL ranges no
 * longer exist; Health remains live and therefore has no month suffix.
 */
import { useCallback, useEffect, useState } from 'react';

type Listener = () => void;

const listeners = new Set<Listener>();

/** Last completed read for each block key, including a failed one. */
const remembered = new Map<string, OpsBlockAnswer<unknown>>();

/** Block keys whose one automatic run has been taken. */
const autoClaimed = new Set<string>();

/** In-flight read per key. A second caller joins this rather than starting another. */
const inflight = new Map<string, Promise<OpsBlockAnswer<unknown>>>();

/** Forced health checks are separate from ordinary cached reads, but settle into the same block. */
const healthChecks = new Map<string, Promise<OpsBlockAnswer<unknown>>>();
const healthCheckFailures = new Map<string, string>();

/** Latest request generation per block, so an older GET cannot overwrite a newer forced check. */
const generations = new Map<string, number>();

function nextGeneration(key: string): number {
  const next = (generations.get(key) ?? 0) + 1;
  generations.set(key, next);
  return next;
}

function announce(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * One block's completed read, as the page receives it.
 *
 * `failed` is for the request itself not completing. A 200 with a `reason`
 * inside the payload is a fact the block renders, not a failure here.
 */
export interface OpsBlockAnswer<T> {
  data: T | null;
  failed: string;
}

/** One block's session key, optionally suffixed by the authoritative month. */
export function opsBlockKey(path: string, identity = ''): string {
  return identity ? `${path}:${identity}` : path;
}

/**
 * Take this block's one automatic run. True for exactly one caller, ever,
 * until {@link forgetOpsSession}.
 *
 * Synchronous and side-effecting on purpose: the caller that gets `true` owns
 * the run, and every later caller gets `false` whether the first one succeeded,
 * failed, or is still in flight. After that only a human pressing Refresh
 * re-reads this block.
 */
export function claimOpsAutoLoad(key: string): boolean {
  if (autoClaimed.has(key)) return false;
  autoClaimed.add(key);
  return true;
}

/** Whether this block's automatic run has been claimed. */
export function opsAutoLoadClaimed(key: string): boolean {
  return autoClaimed.has(key);
}

/** The last completed read for this block, or null where none has completed. */
export function recallOpsBlock<T>(key: string): OpsBlockAnswer<T> | null {
  return remembered.has(key) ? (remembered.get(key) as OpsBlockAnswer<T>) : null;
}

/** Whether a read of this block is in flight right now. */
export function isOpsBlockLoading(key: string): boolean {
  return inflight.has(key) || healthChecks.has(key);
}

/**
 * Drop the store, the latch and any in-flight read. For tests, and for
 * nothing else.
 *
 * All three, because a test that emptied the store and left a block claimed
 * would be testing the second visit while believing it was testing the first.
 */
export function forgetOpsSession(): void {
  remembered.clear();
  autoClaimed.clear();
  inflight.clear();
  healthChecks.clear();
  healthCheckFailures.clear();
  generations.clear();
  listeners.clear();
}

async function readBlock<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
  return (await response.json()) as T;
}

/**
 * Read the block and keep the result, whatever it is.
 *
 * A second call for a key that is already in flight joins that run rather
 * than starting another. Refresh uses this directly; the automatic run goes
 * through {@link claimOpsAutoLoad} first.
 *
 * The previous payload is deliberately kept on a failed re-read. A block that
 * empties itself on a failed refresh has thrown away the last thing it knew,
 * at the moment somebody is trying to work out what changed.
 */
export async function loadOpsBlock<T>(key: string, url: string): Promise<OpsBlockAnswer<T>> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<OpsBlockAnswer<T>>;
  const generation = nextGeneration(key);

  const work = readBlock<T>(url)
    .then((payload): OpsBlockAnswer<T> => {
      const answer = { data: payload, failed: '' };
      if (generations.get(key) === generation) remembered.set(key, answer);
      return answer;
    })
    .catch((error: Error): OpsBlockAnswer<T> => {
      const last = recallOpsBlock<T>(key);
      const answer = { data: last?.data ?? null, failed: error.message };
      if (generations.get(key) === generation) remembered.set(key, answer);
      return answer;
    })
    .finally(() => {
      inflight.delete(key);
      announce();
    });
  inflight.set(key, work);
  announce();
  return work;
}

async function forceHealthCheck<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json' },
  });
  const body = (await response.json().catch(() => ({}))) as T & { detail?: unknown };
  if (!response.ok) {
    throw new Error(
      typeof body.detail === 'string' ? body.detail : `The health check endpoint answered ${response.status}.`
    );
  }
  return body;
}

/**
 * Force fresh Health probes and atomically replace the remembered Health payload.
 *
 * Double-clicks join one POST. A total request failure keeps the prior payload
 * untouched and records only a retryable action error.
 */
export async function checkAllHealthResources<T>(key: string, url: string): Promise<OpsBlockAnswer<T>> {
  const existing = healthChecks.get(key);
  if (existing) return existing as Promise<OpsBlockAnswer<T>>;
  const generation = nextGeneration(key);
  healthCheckFailures.delete(key);
  const work = forceHealthCheck<T>(url)
    .then((payload): OpsBlockAnswer<T> => {
      const answer = { data: payload, failed: '' };
      if (generations.get(key) === generation) remembered.set(key, answer);
      return answer;
    })
    .catch((error: Error): OpsBlockAnswer<T> => {
      if (generations.get(key) === generation) healthCheckFailures.set(key, error.message);
      const last = recallOpsBlock<T>(key);
      return { data: last?.data ?? null, failed: error.message };
    })
    .finally(() => {
      if (healthChecks.get(key) === work) healthChecks.delete(key);
      announce();
    });
  healthChecks.set(key, work);
  announce();
  return work;
}

/**
 * Start one block's automatic read only when its surface is enabled.
 *
 * Kept outside the hook so the warehouse-saving gate can be tested with a real
 * fetch. A disabled block does not even claim its session key, which means
 * turning the experiment on later still gets its intended first read.
 */
export function autoLoadOpsBlock<T>(enabled: boolean, key: string, url: string): Promise<OpsBlockAnswer<T>> | null {
  if (!enabled || !claimOpsAutoLoad(key)) return null;
  return loadOpsBlock<T>(key, url);
}

export interface OpsBlockSession<T> {
  data: T | null;
  busy: boolean;
  /** The sentence for a read that did not come back at all. */
  failed: string;
  /** Re-read this block. The only thing that does, after the automatic run. */
  refresh: () => void;
}

export interface OpsHealthCheckSession {
  busy: boolean;
  failed: string;
  checkAll: () => void;
}

/** Manual Health action state, sharing the Ops session store with the normal Health read. */
export function useOpsHealthCheck(key: string, url: string, enabled = true): OpsHealthCheckSession {
  const [, bump] = useState(0);
  useEffect(() => subscribe(() => bump((count) => count + 1)), []);
  const checkAll = useCallback(() => {
    if (enabled) void checkAllHealthResources(key, url);
  }, [enabled, key, url]);
  return {
    busy: enabled && healthChecks.has(key),
    failed: enabled ? (healthCheckFailures.get(key) ?? '') : '',
    checkAll,
  };
}

/**
 * One Ops block, for the page that draws it.
 *
 * The first visit of a key starts the read; every visit after that restores
 * the same store. Refresh is the only thing that reads again.
 *
 * `search` is captured for the automatic run of THIS key and for Refresh; Ops
 * itself now passes an empty search because the server owns the month window.
 */
export function useOpsBlock<T>(path: string, search: string, identity = '', enabled = true): OpsBlockSession<T> {
  const key = opsBlockKey(path, identity);
  const url = `${path}${search}`;
  const [, bump] = useState(0);
  useEffect(() => subscribe(() => bump((count) => count + 1)), []);

  // Guarded by the latch rather than by this effect, so React's development
  // double-invocation and a remount both find it already claimed.
  useEffect(() => {
    void autoLoadOpsBlock<T>(enabled, key, url);
  }, [enabled, key, url]);

  const refresh = useCallback(() => {
    if (enabled) void loadOpsBlock<T>(key, url);
  }, [enabled, key, url]);

  const stored = recallOpsBlock<T>(key);
  const busy = enabled && (isOpsBlockLoading(key) || !opsAutoLoadClaimed(key));
  return {
    data: stored?.data ?? null,
    busy,
    // Only this request's failure. A stale one from the previous range would
    // report the new read as broken before it has come back.
    failed: busy ? '' : (stored?.failed ?? ''),
    refresh,
  };
}
