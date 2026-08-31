import type { LakebaseReader } from './lakebase-store';
import { readRun } from './run-ledger';

/**
 * An explicit Stop, kept distinct from a broken or truncated serving stream.
 *
 * Model Serving has no per-invocation cancellation API. Aborting here closes
 * this app's request/body consumption and prevents any fallback invocation; an
 * invocation already accepted by the remote endpoint may still finish there.
 */
export class RunCancelledError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(
      `Run ${runId} was explicitly cancelled. App-side serving consumption stopped and no replacement ` +
        'invocation will be started; the current remote model invocation may still finish server-side.'
    );
    this.name = 'RunCancelledError';
    this.runId = runId;
  }
}

export function isRunCancelledError(error: unknown): error is RunCancelledError {
  return error instanceof RunCancelledError;
}

/** The app-side deadline that actively closes serving transport consumption. */
export class RunDeadlineExceededError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`The agent endpoint did not answer within ${timeoutMs} ms, so its app-side transport was stopped.`);
    this.name = 'RunDeadlineExceededError';
    this.timeoutMs = timeoutMs;
  }
}

export function isRunDeadlineExceededError(error: unknown): error is RunDeadlineExceededError {
  return error instanceof RunDeadlineExceededError;
}

export function throwIfRunCancelled(signal: AbortSignal | undefined, runId = ''): void {
  if (!signal?.aborted) return;
  if (isRunCancelledError(signal.reason)) throw signal.reason;
  if (isRunDeadlineExceededError(signal.reason)) throw signal.reason;
  throw new RunCancelledError(runId || 'unknown');
}

/**
 * Controllers owned by this process, as a latency fast path.
 *
 * The durable row remains authoritative. This registry only lets a cancellation
 * request that lands on the same replica close its body immediately instead of
 * waiting for the durable watcher below to observe the row.
 */
const activeRunControllers = new Map<string, Set<AbortController>>();

export function registerRunController(runId: string, controller: AbortController): () => void {
  const controllers = activeRunControllers.get(runId) ?? new Set<AbortController>();
  controllers.add(controller);
  activeRunControllers.set(runId, controllers);
  return () => {
    controllers.delete(controller);
    if (controllers.size === 0) activeRunControllers.delete(runId);
  };
}

/** Abort every in-process consumer for these already-cancelled durable runs. */
export function abortInProcessRuns(runIds: readonly string[]): string[] {
  const aborted: string[] = [];
  for (const runId of new Set(runIds)) {
    const controllers = activeRunControllers.get(runId);
    if (!controllers || controllers.size === 0) continue;
    const reason = new RunCancelledError(runId);
    for (const controller of controllers) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
    aborted.push(runId);
  }
  return aborted;
}

export interface DurableCancellationWatch {
  stop(): void;
}

export const DURABLE_CANCELLATION_POLL_MS = 1_500;

/**
 * Observe the durable state so Stop works when the route and invocation live on
 * different app replicas.
 *
 * Read failures are retried: an unavailable store is not evidence the user
 * cancelled. The caller stops the watcher as soon as app-side consumption ends.
 */
export function watchDurableCancellation(input: {
  store: LakebaseReader;
  runId: string;
  userEmail: string;
  controller: AbortController;
  intervalMs?: number;
}): DurableCancellationWatch {
  // Cross-replica cancellation is a fallback behind the in-process controller.
  // Keep it prompt without turning every active run into four Lakebase reads a
  // second. The bounds also prevent a caller from accidentally reintroducing
  // that load or stretching cancellation beyond the promised two seconds.
  const intervalMs = Math.min(2_000, Math.max(1_000, input.intervalMs ?? DURABLE_CANCELLATION_POLL_MS));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (stopped || input.controller.signal.aborted) return;
    timer = setTimeout(() => void check(), intervalMs);
  };

  const check = async () => {
    try {
      const result = await readRun(input.store, input.runId, input.userEmail);
      if (stopped || input.controller.signal.aborted) return;
      if (result.ok && result.value?.state === 'CANCELLED') {
        input.controller.abort(new RunCancelledError(input.runId));
        return;
      }
    } catch {
      // `readRun` normally returns an unavailable result. A substitute store may
      // throw; either way, absence of a read is not evidence of cancellation.
    }
    schedule();
  };

  // Immediate first read closes the cross-replica gap for a cancellation that
  // committed between admission and watcher registration.
  void check();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
