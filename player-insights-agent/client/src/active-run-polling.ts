/**
 * Adaptive durable polling for conversation runs.
 *
 * The SSE response is the primary live transport. Durable status is the
 * recovery transport for reloads, other replicas, dropped streams, and runs
 * opened from the conversation rail. This scheduler keeps those two transports
 * from narrating the same healthy run at the same time.
 */

export const ACTIVE_RUN_INITIAL_POLL_MS = 1_500;
export const ACTIVE_RUN_BACKOFF_MS = [2_000, 3_000, 5_000, 8_000, 10_000] as const;
export const ACTIVE_RUN_JITTER_RATIO = 0.15;

export type ActiveRunPollOutcome = 'changed' | 'unchanged' | 'stop';

export interface ActiveRunPollTarget {
  conversationId: string;
  /** False while a healthy SSE stream for this exact run is attached. */
  shouldPoll: boolean;
}

export interface ActiveRunPollingHost {
  hidden(): boolean;
  watchVisibility(onChange: () => void): () => void;
  watchReconnect(onReconnect: () => void): () => void;
  setTimer(run: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
  random(): number;
}

export interface ActiveRunPollingController {
  /** Read immediately, resetting fallback backoff. */
  wake(): void;
  stop(): void;
}

export function browserActiveRunPollingHost(): ActiveRunPollingHost {
  const page = typeof document === 'undefined' ? null : document;
  const browser = typeof window === 'undefined' ? null : window;
  return {
    hidden: () => page?.hidden === true,
    watchVisibility: (onChange) => {
      if (!page) return () => undefined;
      page.addEventListener('visibilitychange', onChange);
      return () => page.removeEventListener('visibilitychange', onChange);
    },
    watchReconnect: (onReconnect) => {
      if (!browser) return () => undefined;
      browser.addEventListener('online', onReconnect);
      return () => browser.removeEventListener('online', onReconnect);
    },
    setTimer: (run, delayMs) => globalThis.setTimeout(run, delayMs) as unknown as number,
    clearTimer: (handle) => globalThis.clearTimeout(handle),
    random: Math.random,
  };
}

function jittered(baseMs: number, host: ActiveRunPollingHost): number {
  const factor = 1 - ACTIVE_RUN_JITTER_RATIO + host.random() * ACTIVE_RUN_JITTER_RATIO * 2;
  return Math.round(baseMs * factor);
}

/**
 * Start one non-overlapping polling loop for all active conversations.
 *
 * The loop still wakes cheaply while every target has a healthy stream so it
 * can notice a stream that has gone stale. It does not issue a request for
 * those targets. Visibility, network reconnection, stream attach/detach, and
 * navigation call {@link ActiveRunPollingController.wake} to bypass the current
 * delay.
 */
export function startAdaptiveActiveRunPolling(input: {
  targets(): readonly ActiveRunPollTarget[];
  poll(conversationId: string): Promise<ActiveRunPollOutcome>;
  host: ActiveRunPollingHost;
}): ActiveRunPollingController {
  let stopped = false;
  let timer: number | null = null;
  let inFlight = false;
  let wakePending = false;
  let unchangedRounds = 0;

  const clearTimer = () => {
    if (timer === null) return;
    input.host.clearTimer(timer);
    timer = null;
  };

  const schedule = (delayMs: number) => {
    if (stopped || input.host.hidden()) return;
    clearTimer();
    timer = input.host.setTimer(() => {
      timer = null;
      void run();
    }, delayMs);
  };

  const run = async () => {
    if (stopped || input.host.hidden()) return;
    if (inFlight) {
      wakePending = true;
      return;
    }

    const allTargets = input.targets();
    // A terminal stream transition removes its run synchronously, before React
    // tears this effect down. Do not keep a stale controller alive long enough
    // to bootstrap one more status read for a run that is already settled.
    if (allTargets.length === 0) return;
    const targets = allTargets.filter((target) => target.shouldPoll);
    if (targets.length === 0) {
      unchangedRounds = 0;
      schedule(ACTIVE_RUN_INITIAL_POLL_MS);
      return;
    }

    inFlight = true;
    const outcomes = await Promise.all(
      targets.map(async ({ conversationId }) => {
        try {
          return await input.poll(conversationId);
        } catch {
          return 'unchanged' as const;
        }
      })
    );
    inFlight = false;
    if (stopped || input.host.hidden()) return;
    if (wakePending) {
      wakePending = false;
      unchangedRounds = 0;
      schedule(0);
      return;
    }

    const changed = outcomes.includes('changed');
    const continuing = outcomes.some((outcome) => outcome !== 'stop') || allTargets.length > targets.length;
    if (!continuing) return;
    if (changed) {
      unchangedRounds = 0;
      schedule(ACTIVE_RUN_INITIAL_POLL_MS);
      return;
    }

    const base = ACTIVE_RUN_BACKOFF_MS[Math.min(unchangedRounds, ACTIVE_RUN_BACKOFF_MS.length - 1)];
    unchangedRounds += 1;
    schedule(jittered(base, input.host));
  };

  const wake = () => {
    if (stopped || input.host.hidden()) return;
    unchangedRounds = 0;
    clearTimer();
    if (inFlight) {
      wakePending = true;
      return;
    }
    schedule(0);
  };

  const settleVisibility = () => {
    if (input.host.hidden()) {
      clearTimer();
      return;
    }
    wake();
  };

  const unwatchVisibility = input.host.watchVisibility(settleVisibility);
  const unwatchReconnect = input.host.watchReconnect(wake);
  if (!input.host.hidden()) schedule(ACTIVE_RUN_INITIAL_POLL_MS);

  return {
    wake,
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimer();
      unwatchVisibility();
      unwatchReconnect();
    },
  };
}
