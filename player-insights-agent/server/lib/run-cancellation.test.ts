import { describe, expect, it, vi } from 'vitest';
import { createOrGetRun } from './run-ledger';
import {
  abortInProcessRuns,
  DURABLE_CANCELLATION_POLL_MS,
  isRunCancelledError,
  registerRunController,
  watchDurableCancellation,
} from './run-cancellation';
import { FakeStore } from './__fixtures__/fake-run-store';

async function stored(store: FakeStore, runId: string) {
  await createOrGetRun(store, {
    runId,
    userEmail: 'reader@example.com',
    conversationId: 'conv-1',
    turnId: 'turn-1',
    requestHash: `hash-${runId}`,
    idempotencyKeyHash: null,
    deadlineAt: new Date('2026-08-27T23:00:00Z'),
    identityModeRequested: 'signed_in_user',
    releaseIdentity: {},
    correlationId: `req-${runId}`,
  });
  return store.runs[0];
}

describe('in-process cancellation registry', () => {
  it('aborts only controllers registered to the cancelled run', () => {
    const first = new AbortController();
    const other = new AbortController();
    const unregisterFirst = registerRunController('run-1', first);
    const unregisterOther = registerRunController('run-2', other);

    expect(abortInProcessRuns(['run-1'])).toEqual(['run-1']);
    expect(first.signal.aborted).toBe(true);
    expect(isRunCancelledError(first.signal.reason)).toBe(true);
    expect(other.signal.aborted).toBe(false);

    unregisterFirst();
    unregisterOther();
  });

  it('removes a completed invocation from the fast path', () => {
    const controller = new AbortController();
    registerRunController('run-finished', controller)();

    expect(abortInProcessRuns(['run-finished'])).toEqual([]);
    expect(controller.signal.aborted).toBe(false);
  });
});

describe('durable cancellation watcher', () => {
  it('aborts an invocation owned by another app replica after the row becomes CANCELLED', async () => {
    vi.useFakeTimers();
    const store = new FakeStore();
    const row = await stored(store, 'run-cross-replica');
    const controller = new AbortController();
    const watch = watchDurableCancellation({
      store,
      runId: row.run_id,
      userEmail: row.user_email,
      controller,
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(controller.signal.aborted).toBe(false);
    row.state = 'CANCELLED';
    await vi.advanceTimersByTimeAsync(1_001);

    expect(controller.signal.aborted).toBe(true);
    expect(isRunCancelledError(controller.signal.reason)).toBe(true);
    watch.stop();
    vi.useRealTimers();
  });

  it('does not interpret an unavailable durable read as a cancellation', async () => {
    vi.useFakeTimers();
    const store = new FakeStore();
    store.failWith = 'connection unavailable';
    const controller = new AbortController();
    const watch = watchDurableCancellation({
      store,
      runId: 'run-unreadable',
      userEmail: 'reader@example.com',
      controller,
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(controller.signal.aborted).toBe(false);
    watch.stop();
    vi.useRealTimers();
  });

  it('uses a safe 1.5-second default cadence without delaying the first cross-replica read', async () => {
    vi.useFakeTimers();
    const store = new FakeStore();
    const row = await stored(store, 'run-default-cadence');
    const reads = vi.spyOn(store.lakebase, 'query');
    const controller = new AbortController();
    const watch = watchDurableCancellation({
      store,
      runId: row.run_id,
      userEmail: row.user_email,
      controller,
    });

    await vi.advanceTimersByTimeAsync(1);
    const afterImmediate = reads.mock.calls.length;
    expect(afterImmediate).toBe(1);
    await vi.advanceTimersByTimeAsync(DURABLE_CANCELLATION_POLL_MS - 2);
    expect(reads.mock.calls.length).toBe(afterImmediate);
    await vi.advanceTimersByTimeAsync(2);
    expect(reads.mock.calls.length).toBe(afterImmediate + 1);

    watch.stop();
    vi.useRealTimers();
  });
});
