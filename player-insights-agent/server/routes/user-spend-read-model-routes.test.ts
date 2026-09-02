/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */
import { describe, expect, it, vi } from 'vitest';
import type { Application, Request, Response } from 'express';

import {
  setupUserSpendReadModelRoutes,
  USER_SPEND_READ_MODEL_ROUTES,
  USER_SPEND_SELF_ROUTE,
} from './user-spend-read-model-routes';
import type { InsightsAppKit } from './insights-routes';
import { READ_USER_SPEND_COMPONENTS_QUERY, READ_USER_SPEND_SUMMARY_QUERY } from '../lib/user-spend-read-model';
import { READ_USER_SPEND_HOURLY_SUMMARY_QUERY } from '../lib/user-spend-hourly-read-model';
import { isAdminRoute } from '../lib/admin-roles';

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    display_email: 'person@example.test',
    submitted_questions: '4',
    completed_questions: '3',
    run_count: '3',
    active_minutes: '9',
    total_tokens: '250',
    covered_days: '7',
    app_covered_days: '7',
    spend_usd: '12.5',
    spend_dbu: '6.25',
    spend_usd_quality: 'allocated',
    spend_dbu_quality: 'allocated',
    app_spend_usd: '50',
    app_spend_dbu: '25',
    activity_complete: true,
    billing_complete: true,
    app_role: 'consumer',
    persona_id: 'analyst',
    persona_name: 'Analyst',
    source_through: '2026-09-01T03:00:00Z',
    computed_at: '2026-09-01T04:00:00Z',
    refresh_status: 'ready',
    refresh_source_through: '2026-09-01T03:00:00Z',
    refresh_completed_at: '2026-09-01T04:00:00Z',
    billing_complete_through: '2026-08-31',
    total_users: '1',
    ...overrides,
  };
}

function response() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { json, status } as unknown as Response & { json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
}

function routes(rows = [storedRow()]) {
  const handlers = new Map<string, (req: Request, res: Response) => Promise<void>>();
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return Promise.resolve({
      rows:
        sql === READ_USER_SPEND_COMPONENTS_QUERY
          ? [
              {
                component_id: 'genie:data',
                label: 'Data Genie',
                spend_usd: '0',
                spend_dbu: '1.5',
                spend_usd_quality: 'direct',
                spend_dbu_quality: 'direct',
                reason: '',
              },
            ]
          : rows,
    });
  });
  const appkit = {
    lakebase: { query },
    server: {
      extend(register: (app: Application) => void) {
        register({
          get(path: string, handler: (req: Request, res: Response) => Promise<void>) {
            handlers.set(path, handler);
          },
        } as unknown as Application);
      },
    },
  } as unknown as InsightsAppKit;
  setupUserSpendReadModelRoutes(appkit, {
    isAdminRoute,
    now: () => Date.parse('2026-09-01T04:30:00Z'),
  });
  return { handlers, query, calls };
}

describe('User Monitoring read-model routes', () => {
  it('are all covered by the real admin guard and refuse incomplete coverage', () => {
    expect(USER_SPEND_READ_MODEL_ROUTES.every((path) => isAdminRoute(path))).toBe(true);
    const extend = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setupUserSpendReadModelRoutes({ lakebase: { query: vi.fn() }, server: { extend } } as unknown as InsightsAppKit, {
      isAdminRoute: (path) => !path.includes(':email'),
    });
    expect(extend).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT REGISTERED'));
    error.mockRestore();
  });

  it('serves the list with one bounded Lakebase query and no warehouse/system-billing call', async () => {
    const { handlers, query, calls } = routes();
    const res = response();
    await handlers.get('/api/monitoring/user-spend')!(
      {
        query: {
          from: '2026-08-25',
          to: '2026-08-31',
          unit: 'USD',
          q: 'person',
          role: 'consumer',
          persona: 'analyst',
          pageSize: '25',
        },
        headers: { 'x-forwarded-email': 'admin@example.test' },
        header: (name: string) => (name.toLowerCase() === 'x-forwarded-email' ? 'admin@example.test' : undefined),
      } as unknown as Request,
      res
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(calls[0]?.sql).toBe(READ_USER_SPEND_SUMMARY_QUERY);
    expect(calls[0]?.sql).not.toMatch(/system\.billing|sql\/history|\/api\/2\.0/i);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'ready',
        users: [expect.objectContaining({ email: 'person@example.test', questions: 4, coveredDays: 7 })],
        freshness: expect.objectContaining({
          computedAt: '2026-09-01T04:00:00.000Z',
          sourceThrough: '2026-09-01T03:00:00.000Z',
          isStale: false,
        }),
      })
    );
  });

  it('serves 24 complete UTC hours from the hourly projection without a warehouse call', async () => {
    const { handlers, query, calls } = routes([
      storedRow({
        covered_hours: '24',
        refresh_completed_at: '2026-09-01T04:00:00Z',
        refresh_source_through: '2026-09-01T03:00:00Z',
        billing_basis_through: '2026-08-31',
      }),
    ]);
    const res = response();
    await handlers.get('/api/monitoring/user-spend')!(
      {
        query: {
          from: '2026-08-31T04:30:00Z',
          to: '2026-09-01T04:30:00Z',
          window: '24h',
          unit: 'USD',
          pageSize: '25',
        },
        headers: { 'x-forwarded-email': 'admin@example.test' },
        header: (name: string) => (name.toLowerCase() === 'x-forwarded-email' ? 'admin@example.test' : undefined),
      } as unknown as Request,
      res
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(calls[0]?.sql).toBe(READ_USER_SPEND_HOURLY_SUMMARY_QUERY);
    expect(calls[0]?.params).toEqual(expect.arrayContaining(['2026-08-31T04:00:00.000Z', '2026-09-01T04:00:00.000Z']));
    expect(calls[0]?.sql).not.toMatch(/system\.billing|sql\/history|\/api\/2\.0/i);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'partial',
        users: [expect.objectContaining({ email: 'person@example.test', coveredDays: 1 })],
      })
    );
  });

  it('computes profile and comparison KPIs from five bounded Lakebase reads only', async () => {
    const { handlers, query, calls } = routes();
    const res = response();
    await handlers.get('/api/monitoring/user-spend/:email')!(
      {
        params: { email: 'person@example.test' },
        query: { from: '2026-08-25', to: '2026-08-31', unit: 'USD' },
        headers: { 'x-forwarded-email': 'admin@example.test' },
        header: (name: string) => (name.toLowerCase() === 'x-forwarded-email' ? 'admin@example.test' : undefined),
      } as unknown as Request,
      res
    );
    expect(query).toHaveBeenCalledTimes(6);
    expect(calls.filter((call) => call.sql === READ_USER_SPEND_SUMMARY_QUERY)).toHaveLength(5);
    expect(calls.filter((call) => call.sql === READ_USER_SPEND_COMPONENTS_QUERY)).toHaveLength(1);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'ready',
        users: [
          expect.objectContaining({
            email: 'person@example.test',
            total: { usd: { amount: 12.5, quality: 'allocated' }, dbu: { amount: 6.25, quality: 'allocated' } },
            metrics: expect.objectContaining({
              costPerQuestion: expect.objectContaining({ value: 3.125 }),
              averageDaily: expect.objectContaining({ value: 12.5 / 7 }),
              appShare: expect.objectContaining({ value: 25 }),
            }),
            components: [
              expect.objectContaining({
                id: 'genie:data',
                usd: { amount: 0, quality: 'direct' },
                dbu: { amount: 1.5, quality: 'direct' },
              }),
            ],
          }),
        ],
      })
    );
  });

  it('rejects a malformed cross-user detail key before touching Lakebase', async () => {
    const { handlers, query } = routes();
    const res = response();
    await handlers.get('/api/monitoring/user-spend/:email')!(
      {
        params: { email: 'not-an-email' },
        query: {},
        headers: { 'x-forwarded-email': 'admin@example.test' },
        header: (name: string) => (name.toLowerCase() === 'x-forwarded-email' ? 'admin@example.test' : undefined),
      } as unknown as Request,
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('binds the consumer route to the authenticated identity and never enables browse scope', async () => {
    const { handlers, calls } = routes();
    const res = response();
    await handlers.get(USER_SPEND_SELF_ROUTE)!(
      {
        query: { from: '2026-08-25', to: '2026-08-31' },
        headers: { 'x-forwarded-email': 'PERSON@EXAMPLE.TEST' },
        header: (name: string) => (name.toLowerCase() === 'x-forwarded-email' ? 'PERSON@EXAMPLE.TEST' : undefined),
      } as unknown as Request,
      res
    );
    const summary = calls.find((call) => call.sql === READ_USER_SPEND_SUMMARY_QUERY);
    expect(summary?.params).toEqual(expect.arrayContaining([false, 'person@example.test']));
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        users: [expect.objectContaining({ email: 'person@example.test' })],
      })
    );
  });
});
