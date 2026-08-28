import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Application, Request, Response } from 'express';

import {
  DISTINCT_ASKERS_PER_DAY_QUERY,
  QUESTIONS_PER_DAY_QUERY,
  RUN_OUTCOMES_QUERY,
  TOOL_CALLS_QUERY,
  setupOpsRoutes,
} from './ops-routes';
import { REQUEST_LATENCY_QUERY } from '../lib/request-latency';
import { ACTIVE_MINUTES_PER_DAY_QUERY } from '../lib/app-activity';
import type { InsightsAppKit } from './insights-routes';
import type { OpsLatencyPayload, OpsTrafficPayload } from '../../shared/ops-contract';

const FROM = '2026-08-19T00:00:00.000Z';
const TO = '2026-08-20T04:32:00.000Z';

function routes() {
  const handlers = new Map<string, (req: Request, res: Response) => Promise<void>>();
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const app = {
    get: (path: string, handler: (req: Request, res: Response) => Promise<void>) => handlers.set(path, handler),
  } as unknown as Application;
  const answers: Record<string, Record<string, unknown>[]> = {
    [QUESTIONS_PER_DAY_QUERY]: [{ day: '2026-08-20', count: 3 }],
    [DISTINCT_ASKERS_PER_DAY_QUERY]: [{ day: '2026-08-20', count: 2 }],
    [ACTIVE_MINUTES_PER_DAY_QUERY]: [{ day: '2026-08-20', count: 18 }],
    [RUN_OUTCOMES_QUERY]: [{ state: 'SUCCEEDED', terminal_code: '', count: 3 }],
    [TOOL_CALLS_QUERY]: [{ tool: 'genie', count: 5 }],
    [REQUEST_LATENCY_QUERY]: [
      {
        route: 'POST /api/insights/ask',
        current_count: 3,
        current_p50_ms: 4100,
        current_p95_ms: 6200,
        current_p99_ms: 6400,
        slowest_ms: 6500,
        error_count: 0,
        last_request_at: new Date('2026-08-20T04:30:00.000Z'),
        prior_count: 2,
        prior_p50_ms: 3900,
        covered_from: new Date('2026-08-19T21:00:00.000Z'),
        covered_to: new Date('2026-08-20T04:30:00.000Z'),
      },
      {
        route: 'GET /api/identity',
        current_count: 8,
        current_p50_ms: 12,
        current_p95_ms: 30,
        current_p99_ms: 35,
        slowest_ms: 38,
        error_count: 0,
        last_request_at: new Date('2026-08-20T04:31:00.000Z'),
        prior_count: 6,
        prior_p50_ms: 10,
        covered_from: new Date('2026-08-19T21:00:00.000Z'),
        covered_to: new Date('2026-08-20T04:30:00.000Z'),
      },
    ],
  };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  setupOpsRoutes(
    {
      lakebase: {
        query: (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          return Promise.resolve({ rows: answers[sql] ?? [] });
        },
      },
      server: { extend: (register: (target: Application) => void) => register(app) },
    } as unknown as InsightsAppKit,
    { isAdminRoute: () => true, now: () => Date.parse(TO) }
  );
  log.mockRestore();
  return { handlers, calls };
}

async function invoke<T>(handler: (req: Request, res: Response) => Promise<void>): Promise<T> {
  let body = {} as T;
  const response = {
    json: (value: T) => {
      body = value;
    },
  } as unknown as Response;
  await handler({ query: { from: FROM, to: TO }, headers: {} } as unknown as Request, response);
  return body;
}

afterEach(() => {
  delete process.env.PLAYER_INSIGHTS_TELEMETRY_SCHEMA;
});

describe('Ops activity without billed telemetry', () => {
  it('counts all recorded questions without date parameters', async () => {
    delete process.env.PLAYER_INSIGHTS_TELEMETRY_SCHEMA;
    const { handlers, calls } = routes();

    const payload = await invoke<OpsTrafficPayload>(handlers.get('/api/ops/traffic')!);

    expect(payload.questionsPerDay).toEqual([{ day: '2026-08-20', count: 3 }]);
    expect(payload.distinctAskersPerDay).toEqual([{ day: '2026-08-20', count: 2 }]);
    expect(payload.activeMinutesPerDay).toEqual([{ day: '2026-08-20', count: 18 }]);
    expect(calls.filter((call) => call.sql !== REQUEST_LATENCY_QUERY).map((call) => call.params)).toEqual([
      [],
      [],
      [],
      [],
      [],
    ]);
  });

  it('reads each recorded API route from Lakebase when telemetry is off', async () => {
    delete process.env.PLAYER_INSIGHTS_TELEMETRY_SCHEMA;
    const { handlers, calls } = routes();

    const payload = await invoke<OpsLatencyPayload>(handlers.get('/api/ops/latency')!);

    expect(calls).toEqual([{ sql: REQUEST_LATENCY_QUERY, params: [] }]);
    expect(payload.state).toBe('ready');
    expect(payload.table).toContain('.request_latencies');
    expect(payload.routes).toEqual([
      expect.objectContaining({ route: 'POST /api/insights/ask', spans: 3, p50Ms: 4100, slowestMs: 6500 }),
      expect.objectContaining({ route: 'GET /api/identity', spans: 8, p50Ms: 12, slowestMs: 38 }),
    ]);
  });
});
