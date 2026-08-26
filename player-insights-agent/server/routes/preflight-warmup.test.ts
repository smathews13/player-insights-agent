/**
 * Opening the app wakes the SQL warehouse, and the page never waits for it.
 *
 * The module tests in ../lib/warehouse-warmup.test.ts cover the rules about
 * WHETHER to ping. These cover the part only the route can be wrong about: that
 * arriving is what triggers it, that a warm-up which hangs or throws cannot reach
 * the response, and that nothing about it appears in the report a reader's screen
 * is drawn from.
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupInsightsRoutes, type InsightsAppKit, type ServingTransport } from './insights-routes';
import { resetLakebaseHealth } from '../lib/lakebase-store';
import {
  createWarehouseWarmup,
  warehouseStartPath,
  warehouseStatePath,
  type WarehouseWarmup,
  type WarmupOutcome,
} from '../lib/warehouse-warmup';

const noLakebase: InsightsAppKit['lakebase'] = { query: () => Promise.resolve({ rows: [] }) };

/** The endpoint answering without a dependency report, which is what every live version does. */
const answersWithoutAReport: ServingTransport = () =>
  Promise.resolve({ output: [{ content: 'Here is your analysis.' }] });

async function startApp(warehouseWarmup: WarehouseWarmup, transport = answersWithoutAReport) {
  const app = express();
  app.use(express.json());
  await setupInsightsRoutes({
    lakebase: noLakebase,
    server: { extend: (fn) => fn(app) },
    servingTransport: transport,
    servingEndpointReader: () => Promise.resolve({ state: { ready: 'READY' } }),
    warehouseWarmup,
  });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    open: () => fetch(`http://127.0.0.1:${port}/api/preflight`),
    warm: () => fetch(`http://127.0.0.1:${port}/api/warehouse-warmup`, { method: 'POST' }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A warm-up that records how many times it was asked. */
function countingWarmup(outcome: WarmupOutcome = { kind: 'started', from: 'STOPPED' }) {
  const calls: number[] = [];
  return {
    calls,
    warm: () => {
      calls.push(Date.now());
      return Promise.resolve(outcome);
    },
  };
}

const WAREHOUSE = 'wh-route-0001';

beforeEach(() => {
  resetLakebaseHealth();
  // Without this the route never reaches the endpoint and answers
  // `preflight_unavailable`, which would still exercise the warm-up but would
  // stop these cases describing the path a real arrival takes.
  process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
});

describe('opening the app warms the warehouse', () => {
  it('accepts the splash warm-up without waiting for warehouse control-plane calls', async () => {
    const calls: number[] = [];
    const app = await startApp({
      warm: () => {
        calls.push(Date.now());
        return new Promise<WarmupOutcome>(() => {});
      },
    });

    let response: Response;
    try {
      response = await app.warm();
    } finally {
      await app.close();
    }

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(calls).toHaveLength(1);
  });

  it('pings on arrival', async () => {
    const warmup = countingWarmup();
    const app = await startApp(warmup);

    try {
      await app.warm();
    } finally {
      await app.close();
    }

    expect(warmup.calls).toHaveLength(1);
  });

  it('produces one start when five people open the app at once', async () => {
    // The real warm-up over a fake workspace, so this exercises the debounce and
    // the single flight through the HTTP path rather than trusting a stub.
    const calls: string[] = [];
    const warmup = createWarehouseWarmup({
      warehouseId: () => WAREHOUSE,
      transport: ({ path }) => {
        calls.push(path);
        return Promise.resolve(path === warehouseStatePath(WAREHOUSE) ? { state: 'STOPPED' } : {});
      },
    });
    const app = await startApp(warmup);

    try {
      await Promise.all([app.warm(), app.warm(), app.warm(), app.warm(), app.warm()]);
    } finally {
      await app.close();
    }

    expect(calls.filter((path) => path === warehouseStartPath(WAREHOUSE))).toHaveLength(1);
  });
});

describe('the page never waits for the warm-up', () => {
  it('answers while the warm-up is still hanging', async () => {
    // The warehouse call is accepted and goes silent. If the handler awaited it,
    // this request would not come back at all -- so a passing assertion here is
    // the whole "fire and forget" claim, not a proxy for it.
    const app = await startApp({ warm: () => new Promise<WarmupOutcome>(() => {}) });

    let status: number;
    let body: Record<string, unknown>;
    try {
      const response = await app.warm();
      status = response.status;
      body = (await response.json()) as Record<string, unknown>;
    } finally {
      await app.close();
    }

    expect(status).toBe(202);
    expect(body).toEqual({ accepted: true });
  });

  it('warms without invoking the endpoint', async () => {
    const order: string[] = [];
    const app = await startApp(
      {
        warm: () => {
          order.push('warmup');
          return Promise.resolve<WarmupOutcome>({ kind: 'started', from: 'STOPPED' });
        },
      },
      () => {
        order.push('endpoint');
        return Promise.resolve({ output: [{ content: 'answer' }] });
      }
    );

    try {
      await app.warm();
    } finally {
      await app.close();
    }

    expect(order).toEqual(['warmup']);
  });

  it('warms declared adopted Genie spaces on the same arrival path', () => {
    const source = readFileSync(new URL('./insights-routes.ts', import.meta.url), 'utf8');
    expect(source).toContain('warmGenieWarehousesForArrival(req)');
    expect(source).toContain('createGenieWarehouseWarmup');
    expect(source).toContain('forwardedUserToken(req)');
  });
});

describe('a failed warm-up is invisible', () => {
  it('answers a failed warm-up identically to a successful one', async () => {
    // Deep equality against the healthy run, which is stronger than checking for
    // the absence of an error field: it also catches a warm-up that added a
    // check, a caveat, or an assumption to the report a reader's page is drawn
    // from. `checked_at` is the one field that moves with the clock.
    const failed = { kind: 'failed', at: 'start', message: '403 PERMISSION_DENIED' } as const;
    const strip = (body: Record<string, unknown>) => ({ ...body, checked_at: '<when>' });

    const healthy = await startApp(countingWarmup());
    const unhealthy = await startApp(countingWarmup(failed));
    let good: Record<string, unknown>;
    let bad: Record<string, unknown>;
    let goodStatus: number;
    let badStatus: number;
    try {
      const first = await healthy.warm();
      goodStatus = first.status;
      good = (await first.json()) as Record<string, unknown>;
      const second = await unhealthy.warm();
      badStatus = second.status;
      bad = (await second.json()) as Record<string, unknown>;
    } finally {
      await healthy.close();
      await unhealthy.close();
    }

    expect(badStatus).toBe(goodStatus);
    expect(strip(bad)).toEqual(strip(good));
    // And nothing anywhere in the body mentions the warehouse warm-up. It is not
    // a dependency check and must never be rendered as one.
    expect(JSON.stringify(bad).toLowerCase()).not.toContain('warm');
  });

  it('answers normally even when the warm-up breaks its contract and throws', async () => {
    // `warm()` is documented never to reject. If it ever does, an unhandled
    // rejection could take down the process, and the app that was trying to be
    // faster would be the app that is down.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await startApp({ warm: () => Promise.reject(new Error('boom')) });

    let status: number;
    let logged: string;
    try {
      status = (await app.warm()).status;
      // Let the rejection settle inside the handler's own catch rather than
      // racing the assertion against it.
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Read before restoring: `mockRestore` clears the recorded calls as well as
      // putting the real console back.
      logged = warn.mock.calls.flat().join(' ');
    } finally {
      await app.close();
      warn.mockRestore();
    }

    expect(status).toBe(202);
    expect(logged).toContain('should not');
  });
});
