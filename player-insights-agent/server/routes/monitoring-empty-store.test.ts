import { afterEach, describe, expect, it, vi } from 'vitest';

import { MONITORING_QUESTIONS_QUERY, setupMonitoringRoutes } from './monitoring-routes';
import { lakebaseHealth, resetLakebaseHealth } from '../lib/lakebase-store';
import type { InsightsAppKit } from './insights-routes';
import type { Application, Request, Response } from 'express';

/**
 * What the Monitoring list reports about a store that holds nothing.
 *
 * WHY THIS IS ITS OWN FILE. The rewritten questions statement joins a one-row
 * totals aggregate to the page, so it returns a row whatever the range holds.
 * That row is the reason the counts are exact on a truncated page, and it is
 * also a trap: `chooseRows` decides whether a route found records by counting
 * the rows it is handed, and a totals row is not a record. Handed the raw
 * result, it concludes the store is populated on a deployment where nobody has
 * asked anything, and that conclusion is what the Sources page prints back at
 * the person trying to work out why their lists are empty.
 *
 * The route must therefore weigh the QUESTION rows, not the statement's rows.
 */

const ROUTE = 'GET /api/monitoring/questions';

/** The shape the statement returns for a range holding no questions. */
const TOTALS_ONLY_ROW = { asked_total: 0, thread_total: 0, people_list: [] as string[] };

function routeUnder(rows: Record<string, unknown>[]) {
  let handler: ((req: Request, res: Response) => Promise<void>) | null = null;
  const app = {
    get: (path: string, fn: (req: Request, res: Response) => Promise<void>) => {
      if (path === '/api/monitoring/questions') handler = fn;
    },
  } as unknown as Application;

  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  setupMonitoringRoutes(
    {
      lakebase: {
        query: (text: string) => Promise.resolve(text === MONITORING_QUESTIONS_QUERY ? { rows } : { rows: [] }),
      },
      server: { extend: (fn: (target: Application) => void) => fn(app) },
    } as unknown as InsightsAppKit,
    { isAdminRoute: () => true, probeFor: () => null }
  );
  log.mockRestore();
  return handler as unknown as (req: Request, res: Response) => Promise<void>;
}

async function callRoute(rows: Record<string, unknown>[]) {
  const handler = routeUnder(rows);
  let body: Record<string, unknown> = {};
  const res = {
    json: (payload: Record<string, unknown>) => {
      body = payload;
    },
    status: () => res,
    setHeader: () => res,
  } as unknown as Response;
  await handler(
    { query: {}, headers: {}, params: {}, header: () => undefined, get: () => undefined } as unknown as Request,
    res
  );
  return body;
}

describe('the Monitoring list over a store that holds nothing', () => {
  afterEach(() => {
    resetLakebaseHealth();
    vi.restoreAllMocks();
  });

  it('reports the route as empty rather than as holding records', async () => {
    resetLakebaseHealth();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const body = await callRoute([{ ...TOTALS_ONLY_ROW }]);

    expect(body.questions).toEqual([]);
    // THE CLAIM. The statement answered with one row and that row is a count,
    // not a question. A store nobody has used is empty, and the health this
    // feeds is what the Sources page turns into a sentence for a deployer.
    const health = lakebaseHealth();
    expect(health.content).toBe('empty');
    expect(health.empty_routes).toContain(ROUTE);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('STORE EMPTY'));
  });

  it('still reports records when the page carries a question', async () => {
    resetLakebaseHealth();

    await callRoute([
      {
        ...TOTALS_ONLY_ROW,
        asked_total: 1,
        thread_total: 1,
        people_list: ['someone@example.test'],
        question_id: 'q1',
        conversation_id: 'c1',
        question: 'A question.',
        asked_at: '2026-08-15T10:00:00Z',
        user_email: 'someone@example.test',
      },
    ]);

    const health = lakebaseHealth();
    expect(health.content).toBe('populated');
    expect(health.empty_routes).not.toContain(ROUTE);
  });
});
