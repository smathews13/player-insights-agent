import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACTIVE_RUN_INITIAL_POLL_MS,
  startAdaptiveActiveRunPolling,
  type ActiveRunPollOutcome,
  type ActiveRunPollingHost,
} from './active-run-polling';

function fakeBrowser() {
  let hidden = false;
  const visibility = new Set<() => void>();
  const reconnect = new Set<() => void>();
  const host: ActiveRunPollingHost = {
    hidden: () => hidden,
    watchVisibility: (listener) => {
      visibility.add(listener);
      return () => visibility.delete(listener);
    },
    watchReconnect: (listener) => {
      reconnect.add(listener);
      return () => reconnect.delete(listener);
    },
    setTimer: (run, delayMs) => setTimeout(run, delayMs) as unknown as number,
    clearTimer: (handle) => clearTimeout(handle),
    random: () => 0.5,
  };
  return {
    host,
    hide() {
      hidden = true;
      for (const listener of visibility) listener();
    },
    show() {
      hidden = false;
      for (const listener of visibility) listener();
    },
    reconnect() {
      for (const listener of reconnect) listener();
    },
  };
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('adaptive active-run polling', () => {
  it('eliminates more than 90% of status requests during a healthy 150-second SSE stream', async () => {
    const browser = fakeBrowser();
    const poll = vi.fn<() => Promise<ActiveRunPollOutcome>>().mockResolvedValue('unchanged');
    const controller = startAdaptiveActiveRunPolling({
      targets: () => [{ conversationId: 'streamed', shouldPoll: false }],
      poll,
      host: browser.host,
    });

    await tick(150_000);

    const previousFixedIntervalRequests = Math.floor(150_000 / ACTIVE_RUN_INITIAL_POLL_MS);
    expect(previousFixedIntervalRequests).toBe(100);
    expect(poll).toHaveBeenCalledTimes(0);
    expect(1 - poll.mock.calls.length / previousFixedIntervalRequests).toBeGreaterThan(0.9);
    controller.stop();
  });

  it('pauses while hidden and polls immediately when the tab becomes visible', async () => {
    const browser = fakeBrowser();
    const poll = vi.fn<() => Promise<ActiveRunPollOutcome>>().mockResolvedValue('unchanged');
    const controller = startAdaptiveActiveRunPolling({
      targets: () => [{ conversationId: 'fallback', shouldPoll: true }],
      poll,
      host: browser.host,
    });

    browser.hide();
    await tick(30_000);
    expect(poll).not.toHaveBeenCalled();

    browser.show();
    await tick(0);
    expect(poll).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('switches immediately from SSE to durable recovery when the stream detaches', async () => {
    const browser = fakeBrowser();
    let streamHealthy = true;
    const poll = vi.fn<() => Promise<ActiveRunPollOutcome>>().mockResolvedValue('unchanged');
    const controller = startAdaptiveActiveRunPolling({
      targets: () => [{ conversationId: 'streamed', shouldPoll: !streamHealthy }],
      poll,
      host: browser.host,
    });

    await tick(ACTIVE_RUN_INITIAL_POLL_MS);
    expect(poll).not.toHaveBeenCalled();
    streamHealthy = false;
    controller.wake();
    await tick(0);
    expect(poll).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('bypasses fallback backoff on reconnect and background-run navigation', async () => {
    const browser = fakeBrowser();
    const poll = vi.fn<() => Promise<ActiveRunPollOutcome>>().mockResolvedValue('unchanged');
    const controller = startAdaptiveActiveRunPolling({
      targets: () => [{ conversationId: 'background', shouldPoll: true }],
      poll,
      host: browser.host,
    });

    await tick(ACTIVE_RUN_INITIAL_POLL_MS);
    expect(poll).toHaveBeenCalledTimes(1);

    browser.reconnect();
    await tick(0);
    expect(poll).toHaveBeenCalledTimes(2);

    // HomePage uses this same wake when a rail navigation opens the run.
    controller.wake();
    await tick(0);
    expect(poll).toHaveBeenCalledTimes(3);
    controller.stop();
  });

  it.each(['AWAITING_APPROVAL', 'CANCELLED'])('stops polling after durable %s settlement', async () => {
    const browser = fakeBrowser();
    const poll = vi.fn<() => Promise<ActiveRunPollOutcome>>().mockResolvedValue('stop');
    const controller = startAdaptiveActiveRunPolling({
      targets: () => [{ conversationId: 'settled', shouldPoll: true }],
      poll,
      host: browser.host,
    });

    await tick(ACTIVE_RUN_INITIAL_POLL_MS);
    expect(poll).toHaveBeenCalledTimes(1);
    await tick(60_000);
    expect(poll).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('polls only fallback runs in a mixed multi-run registry', async () => {
    const browser = fakeBrowser();
    const polled: string[] = [];
    const controller = startAdaptiveActiveRunPolling({
      targets: () => [
        { conversationId: 'healthy-sse', shouldPoll: false },
        { conversationId: 'other-replica', shouldPoll: true },
        { conversationId: 'reopened', shouldPoll: true },
      ],
      poll: (conversationId) => {
        polled.push(conversationId);
        return Promise.resolve('unchanged');
      },
      host: browser.host,
    });

    await tick(ACTIVE_RUN_INITIAL_POLL_MS);
    expect(polled).toEqual(['other-replica', 'reopened']);
    controller.stop();
  });

  it('backs off from 2 to 10 seconds and resets after meaningful state change', async () => {
    const browser = fakeBrowser();
    const startedAt = Date.now();
    const calledAt: number[] = [];
    const outcomes: ActiveRunPollOutcome[] = ['unchanged', 'unchanged', 'changed', 'unchanged'];
    const controller = startAdaptiveActiveRunPolling({
      targets: () => [{ conversationId: 'fallback', shouldPoll: true }],
      poll: () => {
        calledAt.push(Date.now() - startedAt);
        return Promise.resolve(outcomes.shift() ?? 'unchanged');
      },
      host: browser.host,
    });

    await tick(1_500);
    await tick(2_000);
    await tick(3_000);
    await tick(1_500);
    expect(calledAt).toEqual([1_500, 3_500, 6_500, 8_000]);
    controller.stop();
  });

  it('does not bootstrap a completed target when stream detach wakes the old effect', async () => {
    const browser = fakeBrowser();
    const poll = vi.fn<() => Promise<ActiveRunPollOutcome>>().mockResolvedValue('unchanged');
    let active = true;
    const controller = startAdaptiveActiveRunPolling({
      targets: () => (active ? [{ conversationId: 'just-finished', shouldPoll: false }] : []),
      poll,
      host: browser.host,
    });

    active = false;
    controller.wake();
    await tick(60_000);

    expect(poll).not.toHaveBeenCalled();
    controller.stop();
  });

  it('survives StrictMode-style stop and replay without reviving the first controller', async () => {
    const browser = fakeBrowser();
    let resolveFirst: (outcome: ActiveRunPollOutcome) => void = () => undefined;
    const firstPoll = vi.fn(
      () =>
        new Promise<ActiveRunPollOutcome>((resolve) => {
          resolveFirst = resolve;
        })
    );
    const first = startAdaptiveActiveRunPolling({
      targets: () => [{ conversationId: 'replayed', shouldPoll: true }],
      poll: firstPoll,
      host: browser.host,
    });
    await tick(ACTIVE_RUN_INITIAL_POLL_MS);
    expect(firstPoll).toHaveBeenCalledOnce();

    first.stop();
    const secondPoll = vi.fn<() => Promise<ActiveRunPollOutcome>>().mockResolvedValue('stop');
    const second = startAdaptiveActiveRunPolling({
      targets: () => [{ conversationId: 'replayed', shouldPoll: true }],
      poll: secondPoll,
      host: browser.host,
    });
    resolveFirst('changed');
    await tick(ACTIVE_RUN_INITIAL_POLL_MS);
    await tick(60_000);

    expect(firstPoll).toHaveBeenCalledOnce();
    expect(secondPoll).toHaveBeenCalledOnce();
    second.stop();
  });
});
