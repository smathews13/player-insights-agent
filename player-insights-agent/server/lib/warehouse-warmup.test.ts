/**
 * Every case here asserts what the warehouse was ASKED, not that a function
 * exists. The recorded call list is the whole point: "pings once" and "does not
 * ping again" are claims about the calls that left this process, and a test that
 * only checked a returned verdict would pass on an implementation that returned
 * `cooling-down` while starting the warehouse anyway.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createWarehouseWarmup,
  waitForWarehouseReady,
  warehouseStartPath,
  warehouseStatePath,
  WARMUP_COOLDOWN_MS,
  type WarmupTransport,
} from './warehouse-warmup';

const WAREHOUSE = 'wh-test-0001';
const STATE = warehouseStatePath(WAREHOUSE);
const START = warehouseStartPath(WAREHOUSE);

/**
 * A workspace that records what it was asked and answers with `state`.
 *
 * `state` is a getter over a mutable box so a test can have the warehouse change
 * under the warm-up, which is what actually happens: the first ping leaves it
 * STARTING and a second arrival a moment later must see that rather than the
 * state the first one found.
 */
function workspace(initial: string) {
  const calls: { path: string; method: string }[] = [];
  const box = { state: initial };
  const transport: WarmupTransport = ({ path, method }) => {
    calls.push({ path, method });
    if (path === START) {
      box.state = 'STARTING';
      return Promise.resolve({});
    }
    return Promise.resolve({ state: box.state });
  };
  return {
    transport,
    calls,
    box,
    starts: () => calls.filter((call) => call.path === START),
    reads: () => calls.filter((call) => call.path === STATE),
  };
}

function clock(start = 1_000_000) {
  const box = { now: start };
  return { now: () => box.now, advance: (ms: number) => (box.now += ms) };
}

function warmupOver(ws: ReturnType<typeof workspace>, time = clock()) {
  return {
    time,
    warmup: createWarehouseWarmup({
      warehouseId: () => WAREHOUSE,
      transport: ws.transport,
      now: time.now,
    }),
  };
}

describe('warming the warehouse when somebody opens the app', () => {
  it('starts a stopped warehouse', async () => {
    const ws = workspace('STOPPED');
    const { warmup } = warmupOver(ws);

    const outcome = await warmup.warm();

    expect(outcome).toEqual({ kind: 'started', from: 'STOPPED' });
    // The state was read first, and only then was a start asked for. The order
    // matters: reading second would mean every arrival called start.
    expect(ws.calls).toEqual([
      { path: STATE, method: 'GET' },
      { path: START, method: 'POST' },
    ]);
  });

  it('does not start a warehouse that is already running', async () => {
    const ws = workspace('RUNNING');
    const { warmup } = warmupOver(ws);

    const outcome = await warmup.warm();

    expect(outcome).toEqual({ kind: 'already-warm', state: 'RUNNING' });
    expect(ws.starts()).toHaveLength(0);
  });

  it('does not start a warehouse that is already starting', async () => {
    // The case the cooldown alone would not cover: somebody else's arrival, or a
    // scheduled job, already woke it and the compute is on its way up.
    const ws = workspace('STARTING');
    const { warmup } = warmupOver(ws);

    const outcome = await warmup.warm();

    expect(outcome).toEqual({ kind: 'already-warm', state: 'STARTING' });
    expect(ws.starts()).toHaveLength(0);
  });

  it('leaves a deleted warehouse alone rather than trying to start it', async () => {
    const ws = workspace('DELETED');
    const { warmup } = warmupOver(ws);

    expect(await warmup.warm()).toEqual({ kind: 'nothing-to-warm', state: 'DELETED' });
    expect(ws.starts()).toHaveLength(0);
  });

  it('does nothing at all when no warehouse is configured', async () => {
    const ws = workspace('STOPPED');
    const warmup = createWarehouseWarmup({ warehouseId: () => '  ', transport: ws.transport });

    expect(await warmup.warm()).toEqual({ kind: 'not-configured' });
    // Not even a metadata read: there is no id to ask about.
    expect(ws.calls).toEqual([]);
  });
});

describe('waiting for runnable compute after an explicit Ask', () => {
  it('starts a stopped warehouse and resolves only after it reports running', async () => {
    const ws = workspace('STOPPED');
    const time = clock(0);
    const outcome = await waitForWarehouseReady({
      warehouseId: WAREHOUSE,
      transport: ws.transport,
      now: time.now,
      sleep: (delay) => {
        time.advance(delay);
        ws.box.state = 'RUNNING';
        return Promise.resolve();
      },
      pollMs: 1_000,
    });

    expect(outcome).toEqual({ kind: 'ready', state: 'RUNNING', waitedMs: 1_000 });
    expect(ws.calls).toEqual([
      { path: STATE, method: 'GET' },
      { path: START, method: 'POST' },
      { path: STATE, method: 'GET' },
    ]);
  });

  it('does not start or wait when the warehouse is already running', async () => {
    const ws = workspace('RUNNING');
    const outcome = await waitForWarehouseReady({ warehouseId: WAREHOUSE, transport: ws.transport });
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') throw new Error('expected ready warehouse');
    expect(typeof outcome.waitedMs).toBe('number');
    expect(ws.starts()).toHaveLength(0);
  });
});

describe('once per app open, and genuinely once', () => {
  it('collapses ten simultaneous arrivals into one start', async () => {
    // Ten people opening the app in the same instant, which is the standup case.
    // None of the ten has resolved yet, so the cooldown has nothing to compare
    // against and the single flight is what has to hold.
    const ws = workspace('STOPPED');
    const { warmup } = warmupOver(ws);

    const outcomes = await Promise.all(Array.from({ length: 10 }, () => warmup.warm()));

    expect(ws.starts()).toHaveLength(1);
    expect(ws.reads()).toHaveLength(1);
    // Every caller learns what the one attempt found, rather than nine of them
    // getting a "somebody else is doing it" they cannot act on.
    expect(outcomes.every((outcome) => outcome.kind === 'started')).toBe(true);
  });

  it('does not ping again inside the cooldown, however many times the page is reloaded', async () => {
    const ws = workspace('STOPPED');
    const { warmup, time } = warmupOver(ws);

    await warmup.warm();
    // One person reloading five times over the following fifty seconds.
    for (let reload = 0; reload < 5; reload += 1) {
      time.advance(10_000);
      expect((await warmup.warm()).kind).toBe('cooling-down');
    }

    expect(ws.starts()).toHaveLength(1);
    // And not even a metadata read per reload: the whole feature costs one round
    // trip a minute regardless of how many people arrive.
    expect(ws.reads()).toHaveLength(1);
  });

  it('pings again once the cooldown has passed, because the warehouse can have stopped', async () => {
    // The reason the cooldown must stay under the five-minute auto-stop. A
    // warehouse that went quiet and stopped has to be warmable by the next
    // arrival, or the feature works in testing and fails in the afternoon.
    const ws = workspace('STOPPED');
    const { warmup, time } = warmupOver(ws);

    await warmup.warm();
    ws.box.state = 'STOPPED'; // it came up, went idle, and auto-stopped
    time.advance(WARMUP_COOLDOWN_MS + 1);

    expect((await warmup.warm()).kind).toBe('started');
    expect(ws.starts()).toHaveLength(2);
  });

  it('keeps the cooldown well inside the warehouse auto-stop window', () => {
    // Asserted as a fact rather than left to a comment. A cooldown at or above
    // the five-minute auto-stop would refuse the next arrival a warm-up on
    // exactly the deployments that need one.
    const autoStopMs = 5 * 60_000;
    expect(WARMUP_COOLDOWN_MS).toBeLessThan(autoStopMs);
    // And not so small that a burst stops being collapsed.
    expect(WARMUP_COOLDOWN_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('starts the cooldown when the attempt begins, not when it finishes', async () => {
    // A slow start call must not leave a window where a later arrival gets past
    // the cooldown. The single flight covers the overlap; this covers the moment
    // just after it resolves.
    const ws = workspace('STOPPED');
    let release: () => void = () => {};
    let reachedStart: () => void = () => {};
    const startCalled = new Promise<void>((resolve) => {
      reachedStart = resolve;
    });
    const slow: WarmupTransport = (request) => {
      if (request.path !== START) return ws.transport(request);
      ws.calls.push({ path: request.path, method: request.method });
      const pending = new Promise<Record<string, unknown>>((resolve) => {
        release = () => resolve({});
      });
      reachedStart();
      return pending;
    };
    const time = clock();
    const warmup = createWarehouseWarmup({
      warehouseId: () => WAREHOUSE,
      transport: slow,
      now: time.now,
    });

    const first = warmup.warm();
    await startCalled;
    time.advance(20_000); // the start call took twenty seconds
    release();
    await first;

    expect((await warmup.warm()).kind).toBe('cooling-down');
    expect(ws.starts()).toHaveLength(1);
  });
});

describe('a warm-up that fails is a warm-up nobody hears about', () => {
  it('swallows a refused start and resolves rather than throwing', async () => {
    const ws = workspace('STOPPED');
    const transport: WarmupTransport = (request) => {
      ws.calls.push(request);
      if (request.path === START) return Promise.reject(new Error('403 PERMISSION_DENIED'));
      return Promise.resolve({ state: 'STOPPED' });
    };
    const warmup = createWarehouseWarmup({ warehouseId: () => WAREHOUSE, transport });

    const outcome = await warmup.warm();

    expect(outcome).toEqual({ kind: 'failed', at: 'start', message: '403 PERMISSION_DENIED' });
  });

  it('does not call start when it could not read the state', async () => {
    const calls: string[] = [];
    const transport: WarmupTransport = ({ path }) => {
      calls.push(path);
      return Promise.reject(new Error('getaddrinfo ENOTFOUND'));
    };
    const warmup = createWarehouseWarmup({ warehouseId: () => WAREHOUSE, transport });

    expect((await warmup.warm()).kind).toBe('failed');
    // An unreadable state means the call path is broken, not that we are one
    // permission short of the start. Firing it blind would fail the same way.
    expect(calls).toEqual([STATE]);
  });

  it('treats a state it cannot read as unknown rather than as stopped', async () => {
    const transport: WarmupTransport = () => Promise.resolve({ nothing: 'useful' });
    const warmup = createWarehouseWarmup({ warehouseId: () => WAREHOUSE, transport });

    expect(await warmup.warm()).toEqual({
      kind: 'failed',
      at: 'state',
      message: 'the warehouse reported no state',
    });
  });

  it('gives up on a workspace that accepts the call and goes silent', async () => {
    vi.useFakeTimers();
    try {
      const transport: WarmupTransport = () => new Promise(() => {});
      const warmup = createWarehouseWarmup({
        warehouseId: () => WAREHOUSE,
        transport,
        timeoutMs: 10_000,
      });

      const settled = warmup.warm();
      await vi.advanceTimersByTimeAsync(10_001);
      const outcome = await settled;

      expect(outcome.kind).toBe('failed');
      expect(outcome).toMatchObject({ at: 'state' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the next arrival try again after a failure, once the cooldown is up', async () => {
    // A failure burns the cooldown on purpose -- retrying per arrival is how a
    // quiet warm-up becomes a hot loop -- but it must not be permanent.
    let failing = true;
    const calls: { path: string; method: string }[] = [];
    const transport: WarmupTransport = (request) => {
      calls.push(request);
      if (failing) return Promise.reject(new Error('503 from the control plane'));
      return request.path === START ? Promise.resolve({}) : Promise.resolve({ state: 'STOPPED' });
    };
    const time = clock();
    const warmup = createWarehouseWarmup({ warehouseId: () => WAREHOUSE, transport, now: time.now });

    expect((await warmup.warm()).kind).toBe('failed');
    expect((await warmup.warm()).kind).toBe('cooling-down');

    failing = false;
    time.advance(WARMUP_COOLDOWN_MS + 1);

    expect((await warmup.warm()).kind).toBe('started');
    expect(calls.filter((call) => call.path === START)).toHaveLength(1);
  });
});

describe('nothing here keeps the warehouse alive', () => {
  it('makes no call of its own once nobody is arriving', async () => {
    vi.useFakeTimers();
    try {
      const ws = workspace('STOPPED');
      const warmup = createWarehouseWarmup({ warehouseId: () => WAREHOUSE, transport: ws.transport });

      await warmup.warm();
      const afterOneArrival = ws.calls.length;
      // Half an hour of nobody opening the app. A keepalive timer, a poll, or a
      // retry loop would show up here as calls this test did not ask for; the
      // warehouse's own five-minute auto-stop is then free to do its job.
      await vi.advanceTimersByTimeAsync(30 * 60_000);

      expect(ws.calls).toHaveLength(afterOneArrival);
    } finally {
      vi.useRealTimers();
    }
  });
});
