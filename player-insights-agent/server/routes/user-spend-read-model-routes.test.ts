/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */
import { describe, expect, it, vi } from 'vitest';
import type { Application, Request, Response } from 'express';

import {
  setupUserSpendReadModelRoutes,
  USER_SPEND_READ_MODEL_ROUTES,
  USER_SPEND_SELF_ROUTE,
} from './user-spend-read-model-routes';
import type { InsightsAppKit } from './insights-routes';
import {
  READ_USER_SPEND_COMPONENTS_QUERY,
  READ_USER_SPEND_REFRESH_STATE_QUERY,
  READ_USER_SPEND_SUMMARY_QUERY,
} from '../lib/user-spend-read-model';
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
    token_covered_runs: '3',
    token_covered_questions: '2',
    spend_usd_covered_days: '7',
    spend_dbu_covered_days: '7',
    spend_usd_covered_hours: '24',
    spend_dbu_covered_hours: '24',
    app_usd_covered_days: '7',
    app_dbu_covered_days: '7',
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
    identity_updated_at: '2026-09-01T03:30:00Z',
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

function routes(rows = [storedRow()], rosterRows = rows) {
  const handlers = new Map<string, (req: Request, res: Response) => Promise<void>>();
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return Promise.resolve({
      rows: /SELECT email, role, added_by, added_at FROM player_insights\.admin_emails/.test(sql)
        ? rosterRows.map((row) => ({
            email: row.display_email,
            role: row.app_role,
            added_by: 'bootstrap',
            added_at: row.identity_updated_at,
          }))
        : sql === READ_USER_SPEND_COMPONENTS_QUERY
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
          : sql === READ_USER_SPEND_REFRESH_STATE_QUERY
            ? [
                {
                  refresh_status: 'ready',
                  refresh_source_through: '2026-09-01T03:00:00Z',
                  refresh_completed_at: '2026-09-01T04:00:00Z',
                  billing_complete_through: '2026-08-31',
                  identity_updated_at: '2026-09-01T03:30:00Z',
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
          organization: 'domain:example.test',
          pageSize: '25',
        },
        headers: { 'x-forwarded-email': 'admin@example.test' },
        header: (name: string) => (name.toLowerCase() === 'x-forwarded-email' ? 'admin@example.test' : undefined),
      } as unknown as Request,
      res
    );
    expect(query).toHaveBeenCalledTimes(2);
    const summary = calls.find((call) => call.sql === READ_USER_SPEND_SUMMARY_QUERY);
    expect(summary?.sql).not.toMatch(/system\.billing|sql\/history|\/api\/2\.0/i);
    expect(summary?.sql).toContain('FROM player_insights.admin_emails');
    expect(summary?.sql).toContain('LEFT JOIN aggregated');
    expect(summary?.sql).not.toContain("COALESCE(NULLIF(admin_user.role, ''), 'consumer')");
    expect(summary?.params).toContainEqual(['example.test']);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'ready',
        users: [
          expect.objectContaining({
            email: 'person@example.test',
            organization: expect.objectContaining({ id: 'domain:example.test', name: 'example.test' }),
            questions: 4,
            coveredDays: 7,
            tokenUsage: { totalTokens: 250, coveredRuns: 3, coveredQuestions: 2 },
          }),
        ],
        organizations: [expect.objectContaining({ id: 'domain:example.test', count: 1 })],
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
    expect(query).toHaveBeenCalledTimes(2);
    const hourly = calls.find((call) => call.sql === READ_USER_SPEND_HOURLY_SUMMARY_QUERY);
    expect(hourly?.params).toEqual(expect.arrayContaining(['2026-08-31T04:00:00.000Z', '2026-09-01T04:00:00.000Z']));
    expect(hourly?.sql).not.toMatch(/system\.billing|sql\/history|\/api\/2\.0/i);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'partial',
        users: [expect.objectContaining({ email: 'person@example.test', coveredDays: 1 })],
      })
    );
  });

  it('keeps Identity-roster organization options when combined filters return no rows', async () => {
    const previousOrganizations = process.env.PLAYER_INSIGHTS_ORGANIZATIONS;
    process.env.PLAYER_INSIGHTS_ORGANIZATIONS = JSON.stringify([
      { domain: 'studio.example', name: 'Example Studio', monogram: 'ES' },
      { domain: 'partner.example', name: 'Example Partner', monogram: 'EP' },
    ]);
    const { handlers, calls } = routes(
      [],
      [
        storedRow({ display_email: 'producer@studio.example' }),
        storedRow({ display_email: 'artist@north.partner.example' }),
      ]
    );
    const res = response();
    await handlers.get('/api/monitoring/user-spend')!(
      {
        query: {
          from: '2026-08-25',
          to: '2026-08-31',
          q: 'no match',
          role: 'admin',
          persona: 'analyst',
          organization: 'domain:studio.example,domain:partner.example',
        },
        headers: { 'x-forwarded-email': 'admin@example.test' },
        header: (name: string) => (name.toLowerCase() === 'x-forwarded-email' ? 'admin@example.test' : undefined),
      } as unknown as Request,
      res
    );
    const summary = calls.find((call) => call.sql === READ_USER_SPEND_SUMMARY_QUERY);
    expect(summary?.params.slice(6, 10)).toEqual([
      'no match',
      'admin',
      'analyst',
      ['studio.example', 'partner.example'],
    ]);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        users: [],
        pagination: expect.objectContaining({ total: 0 }),
        organizations: expect.arrayContaining([
          expect.objectContaining({ id: 'domain:studio.example', count: 1 }),
          expect.objectContaining({ id: 'domain:partner.example', count: 1 }),
        ]),
      })
    );
    if (previousOrganizations === undefined) delete process.env.PLAYER_INSIGHTS_ORGANIZATIONS;
    else process.env.PLAYER_INSIGHTS_ORGANIZATIONS = previousOrganizations;
  });

  it('computes current-period profile KPIs from two bounded Lakebase reads only', async () => {
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
    expect(query).toHaveBeenCalledTimes(2);
    expect(calls.filter((call) => call.sql === READ_USER_SPEND_SUMMARY_QUERY)).toHaveLength(1);
    expect(calls.filter((call) => call.sql === READ_USER_SPEND_COMPONENTS_QUERY)).toHaveLength(1);
    expect(JSON.stringify(res.json.mock.calls[0]?.[0])).not.toMatch(
      /weekOverWeek|monthOverMonth|prior 7 days|prior matched month|comparable period/i
    );
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
              averageTokens: {
                totalTokens: 250,
                coveredRuns: 3,
                coveredQuestions: 2,
                perRun: 250 / 3,
                perQuestion: 125,
              },
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

  it('keeps best-known spend and derives core KPIs when one source is incomplete', async () => {
    const { handlers } = routes([
      storedRow({
        submitted_questions: '25',
        spend_usd: '9.55',
        spend_usd_quality: 'partial',
        billing_complete: false,
        spend_usd_covered_days: '7',
      }),
    ]);
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
    const payload = res.json.mock.calls[0]?.[0] as {
      users: Array<{
        total: { usd: { amount: number; quality: string } };
        metrics: {
          costPerQuestion: { value: number; estimated?: boolean };
          averageDaily: { value: number; estimated?: boolean };
        };
      }>;
    };
    expect(payload.users[0]?.total.usd).toEqual({ amount: 9.55, quality: 'partial' });
    expect(payload.users[0]?.metrics.costPerQuestion).toMatchObject({ value: 9.55 / 25, estimated: true });
    expect(payload.users[0]?.metrics.averageDaily).toMatchObject({ value: 9.55 / 7, estimated: true });
    expect(payload.users[0]?.metrics).not.toHaveProperty('weekOverWeek');
    expect(payload.users[0]?.metrics).not.toHaveProperty('monthOverMonth');
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

  it('rejects a removed Identity user direct link instead of serving stale aggregate data', async () => {
    const { handlers } = routes([]);
    const res = response();
    await handlers.get('/api/monitoring/user-spend/:email')!(
      {
        params: { email: 'removed@example.test' },
        query: { from: '2026-08-25', to: '2026-08-31', unit: 'USD' },
        headers: { 'x-forwarded-email': 'admin@example.test' },
        header: (name: string) => (name.toLowerCase() === 'x-forwarded-email' ? 'admin@example.test' : undefined),
      } as unknown as Request,
      res
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'monitoring_user_not_rostered' });
  });

  it('never falls back to account identities when the Identity roster query fails', async () => {
    const handlers = new Map<string, (req: Request, res: Response) => Promise<void>>();
    const query = vi.fn().mockRejectedValue(new Error('identity store unavailable'));
    setupUserSpendReadModelRoutes(
      {
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
      } as unknown as InsightsAppKit,
      { isAdminRoute, now: () => Date.parse('2026-09-01T04:30:00Z') }
    );
    const res = response();
    await handlers.get('/api/monitoring/user-spend')!(
      {
        query: { from: '2026-08-25', to: '2026-08-31' },
        header: (name: string) => (name.toLowerCase() === 'x-forwarded-email' ? 'admin@example.test' : undefined),
      } as unknown as Request,
      res
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'identity_roster_unavailable' }));
    expect(query).toHaveBeenCalledTimes(1);
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
