/**
 * The dependency checks, run once when the app is first opened, and only on
 * request after that.
 *
 * WHY THIS MODULE EXISTS AT ALL. Two tabs report these checks -- Connections as a
 * list and Architecture as a diagram -- and until now each one decided for itself
 * when to ask. Connections fetched both routes on every mount, so navigating away
 * and back re-invoked the serving endpoint and the workspace probes with nobody
 * asking for it. Architecture fetched neither, so it opened on `Not checked` down
 * its whole length until somebody found the button.
 *
 * Neither behaviour was defensible, and the two were opposite. What made it worse
 * is that BOTH were reported as the same complaint by the person the app is for:
 * "it says nothing is checked, so it looks broken". Architecture said it because
 * it had not looked; Connections said it, on the same deployment, because a probe
 * that has not landed yet also renders as `Not checked`. A reader cannot tell a
 * page mid-flight from a page that never asked.
 *
 * So there is one mechanism, here, and both pages use it. It runs the checks the
 * first time anything wants them in a session, and after that the Refresh button
 * is the only thing that runs them again. Adding a second implementation to
 * either page would put the two tabs back on separate clocks, which is what
 * `check-session.ts` was written to stop and what this is the other half of.
 *
 * ONCE PER SESSION, NOT ONCE PER VISIT, and the distinction is the whole point.
 * The claim is taken from {@link claimAutoCheck}, a module-level latch, before
 * any fetch is issued. So:
 *
 *   - a second mount of the same page does not re-run it
 *   - the other page mounting does not re-run it
 *   - React's development double-mount does not re-run it
 *   - an automatic run that FAILED does not re-run it on the next visit
 *
 * The last is the one that is easy to get wrong by keying on the store instead of
 * on a latch, and it is the one that would hurt: a deployment whose probes are
 * timing out would retry the expensive pair on every navigation, forever, with no
 * button pressed.
 *
 * A RUN IN FLIGHT IS VISIBLE TO WHOEVER IS LOOKING. The subscriber list is not
 * decoration. The automatic run belongs to the session rather than to the page
 * that happened to claim it, so a reader who opens Connections and switches to
 * Architecture two seconds later must see that run land, not an empty page that
 * has given up waiting for a fetch it never made.
 */
import { useCallback, useEffect, useState } from 'react';

import { claimAutoCheck, recallChecks, rememberChecks, type CheckSession } from './check-session';
import type { ConnectionEntry, SettingsPayload } from './connection-model';
import { fetchWithTimeout } from './fetch-timeout';
import { isPreflightReport, type PreflightReport } from './preflight';

type Listener = () => void;

const listeners = new Set<Listener>();

/** Whether a run is in flight. One at a time; a second request is dropped. */
let running = false;

/**
 * How many runs have COMPLETED in this session.
 *
 * A page records this at mount and compares, which is how it tells results it
 * restored from results that arrived while it was open. A boolean could not: the
 * page that claims the automatic run is looking at fresh results even though the
 * store was empty when it mounted, and a page opened later is looking at restored
 * ones even though the store is full. Only the count distinguishes them.
 */
let completed = 0;
let settingsMutationGeneration = 0;
let latestSettingsRequest = 0;
let runGeneration = 0;

/** Longer than a healthy preflight, but never an unbounded screen wait. */
export const SESSION_CHECK_TIMEOUT_MS = 25_000;

function announce(): void {
  // Over a copy: a listener that unsubscribes while being notified would
  // otherwise mutate the set being iterated.
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reset the notifier. For tests; nothing in the app unsubscribes everything. */
export function resetSessionChecks(): void {
  listeners.clear();
  running = false;
  completed = 0;
  settingsMutationGeneration = 0;
  latestSettingsRequest = 0;
  runGeneration += 1;
}

interface SettingsRead {
  payload: SettingsPayload;
  generation: number;
  request: number;
}

async function readSettings(): Promise<SettingsRead> {
  const generation = settingsMutationGeneration;
  const request = ++latestSettingsRequest;
  const response = await fetchWithTimeout('/api/settings', {}, SESSION_CHECK_TIMEOUT_MS);
  if (!response.ok) throw new Error(`the settings endpoint answered ${response.status}`);
  return { payload: (await response.json()) as SettingsPayload, generation, request };
}

function currentSettings(read: SettingsRead): boolean {
  return read.generation === settingsMutationGeneration && read.request === latestSettingsRequest;
}

/** Fence every settings GET that started before a connection mutation. */
export function beginConnectionMutation(): void {
  settingsMutationGeneration += 1;
}

/**
 * Commit a confirmed deletion into the session cache before navigation can
 * remount Connections from it. Lakebase remains the source of truth; this only
 * prevents a known-stale cached payload from replaying records it still held.
 */
export function commitConnectionDeletion(ids: readonly string[]): void {
  settingsMutationGeneration += 1;
  const removed = new Set(ids);
  const previous = recallChecks();
  if (!previous?.settings) return;
  rememberChecks({
    ...previous,
    settings: {
      ...previous.settings,
      connections: (previous.settings.connections ?? []).filter((entry) => !removed.has(entry.connection.id)),
    },
  });
  announce();
}

/** Keep a confirmed creation in the session cache before any revalidation lands. */
export function commitConnectionAddition(entry: ConnectionEntry): void {
  settingsMutationGeneration += 1;
  const previous = recallChecks();
  if (!previous?.settings) return;
  rememberChecks({
    ...previous,
    settings: {
      ...previous.settings,
      connections: [
        ...(previous.settings.connections ?? []).filter((candidate) => candidate.connection.id !== entry.connection.id),
        entry,
      ],
    },
  });
  announce();
}

/**
 * The report, including the one it answers with when the agent is unreachable.
 *
 * A 503 here carries a usable body describing that unreachability as a failed
 * check, so the body is read whatever the status. Only a body that is not a
 * report at all is a failure of this read.
 */
async function readPreflight(): Promise<PreflightReport> {
  const response = await fetchWithTimeout('/api/preflight', {}, SESSION_CHECK_TIMEOUT_MS);
  const body: unknown = await response.json();
  if (isPreflightReport(body)) return body;
  throw new Error(`the preflight route answered ${response.status} but not with a dependency report`);
}

function settleFirstLoadPart(
  run: number,
  part: 'settings' | 'report',
  status: 'ready' | 'error',
  value?: SettingsPayload | PreflightReport
): void {
  if (run !== runGeneration) return;
  const current = recallChecks();
  if (!current?.load?.firstLoad) return;
  rememberChecks({
    ...current,
    settings: part === 'settings' && status === 'ready' ? (value as SettingsPayload) : current.settings,
    report: part === 'report' && status === 'ready' ? (value as PreflightReport) : current.report,
    load: { ...current.load, [part]: status },
  });
  announce();
}

/**
 * Run both reads and keep the result, whatever it is.
 *
 * A route that failed this time keeps whatever it answered last time, under the
 * sentence saying it could not be re-read. Blanking it would turn a failed
 * refresh into a page that has lost the results it did have.
 *
 * Never rejects. Every failure is reported as part of the session rather than
 * thrown, because the two callers are both render paths and neither has anywhere
 * to put an exception.
 */
export async function runSessionChecks(): Promise<void> {
  // A second press cannot race the first. Both land on the same store, and the
  // later answer has been able to arrive first.
  if (running) return;
  const previous = recallChecks();
  const firstLoad = previous === null;
  const run = ++runGeneration;
  running = true;
  if (firstLoad) {
    rememberChecks({
      settings: null,
      report: null,
      error: '',
      load: { firstLoad: true, settings: 'pending', report: 'pending' },
    });
  }
  announce();

  const problems: string[] = [];
  const settingsRequest = readSettings().then(
    (read) => {
      if (currentSettings(read)) settleFirstLoadPart(run, 'settings', 'ready', read.payload);
      return read;
    },
    (error: unknown) => {
      settleFirstLoadPart(run, 'settings', 'error');
      throw error;
    }
  );
  const reportRequest = readPreflight().then(
    (value) => {
      settleFirstLoadPart(run, 'report', 'ready', value);
      return value;
    },
    (error: unknown) => {
      settleFirstLoadPart(run, 'report', 'error');
      throw error;
    }
  );
  const [settings, report] = await Promise.allSettled([settingsRequest, reportRequest]);
  if (run !== runGeneration) return;

  const next: CheckSession = {
    settings:
      settings.status === 'fulfilled' && currentSettings(settings.value)
        ? settings.value.payload
        : (recallChecks()?.settings ?? previous?.settings ?? null),
    report: report.status === 'fulfilled' ? report.value : (previous?.report ?? null),
    error: '',
    load: {
      firstLoad: false,
      settings: settings.status === 'fulfilled' ? 'ready' : 'error',
      report: report.status === 'fulfilled' ? 'ready' : 'error',
    },
  };
  if (settings.status === 'rejected') {
    problems.push(`The app could not read its own configuration: ${(settings.reason as Error).message}.`);
  }
  if (report.status === 'rejected') {
    problems.push(`The dependency checks could not be run: ${(report.reason as Error).message}.`);
  }
  // Deliberately not "nothing is reachable". A check that could not run says so,
  // and everything it would have graded stays on Not checked.
  if (problems.length > 0) {
    next.error = `${problems.join(' ')} Anything they would have graded is still unchecked.`;
  }

  rememberChecks(next);
  completed += 1;
  running = false;
  announce();
}

/**
 * Re-read the configuration only, after a value has been written.
 *
 * NOT a run of the checks, and deliberately not counted as one. A save changes
 * what this deployment is configured with, so the rows have to be redrawn; it
 * changes nothing about whether the workspace answers, so re-probing every
 * dependency to find that out would be an expensive way of learning nothing.
 * `completed` is left alone so a page that was showing restored results still
 * says so.
 */
export async function reloadSessionSettings(): Promise<string> {
  const previous = recallChecks();
  try {
    const read = await readSettings();
    if (currentSettings(read)) {
      rememberChecks({ settings: read.payload, report: previous?.report ?? null, error: previous?.error ?? '' });
      announce();
    }
    return '';
  } catch (caught) {
    return `The app could not read its own configuration: ${(caught as Error).message}. Nothing below is current.`;
  }
}

export interface SessionChecks {
  /** The last completed run, or null where none has completed. */
  session: CheckSession | null;
  /** Whether a run is in flight right now, automatic or requested. */
  running: boolean;
  /**
   * Whether what is on screen was restored rather than produced while this page
   * has been open. False on the visit that runs the checks, including the
   * automatic one, because those results are this visit's.
   */
  restored: boolean;
  /** True only until this session's first run has completed. */
  firstLoad: boolean;
  /** Re-run both reads. The only thing that does, after the automatic run. */
  refresh: () => Promise<void>;
  /** Re-read the configuration after a write. Not a re-run of the checks. */
  reloadSettings: () => Promise<string>;
}

/**
 * The checks, for a page that draws them.
 *
 * The first caller in a session starts them; every caller after that reads the
 * same store and is told when it changes.
 */
export function useSessionChecks(): SessionChecks {
  // A counter rather than the session object: the store is the source of truth
  // and this only has to force a read of it. Holding a copy in state would give
  // two mounted pages two copies of one run.
  const [, bump] = useState(0);
  // STATE RATHER THAN REFS, and never set again. Both of these are read while
  // rendering, to decide `restored` below, and a ref read during render is the
  // thing `react-hooks/refs` is about: a ref is not part of the render's input,
  // so nothing guarantees the value a render sees. A `useState` initialiser
  // runs exactly once per mount, which is the whole of what these need, and it
  // is a value the render is allowed to read.
  const [seenAtMount] = useState(completed);
  const [hadSessionAtMount] = useState(() => recallChecks() !== null);

  useEffect(() => subscribe(() => bump((count) => count + 1)), []);

  // The automatic run. Guarded by the latch rather than by this effect, so
  // React's development double-invocation, a remount, and the other page opening
  // all find it already claimed.
  useEffect(() => {
    if (claimAutoCheck()) void runSessionChecks();
  }, []);

  const refresh = useCallback(() => runSessionChecks(), []);
  const reloadSettings = useCallback(() => reloadSessionSettings(), []);

  return {
    session: recallChecks(),
    running,
    restored: hadSessionAtMount && completed === seenAtMount,
    firstLoad: !hadSessionAtMount && completed === seenAtMount,
    refresh,
    reloadSettings,
  };
}
