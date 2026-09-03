import type { Application, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { ACTIVE_MINUTES_PER_DAY_QUERY } from '../lib/app-activity';
import type { OpsTrafficPayload } from '../../shared/ops-contract';
import { DISTINCT_ASKERS_PER_DAY_QUERY, QUESTIONS_PER_DAY_QUERY, setupOpsRoutes } from './ops-routes';
import type { InsightsAppKit } from './insights-routes';

describe('Ops active-minute calendar and freshness', () => {
  it('uses the budget calendar month and returns recording bounds', async () => {
    let handler: ((req: Request, res: Response) => Promise<void>) | undefined;
    const app = {
      get: (path: string, registered: (req: Request, res: Response) => Promise<void>) => {
        if (path === '/api/ops/traffic') handler = registered;
      },
    } as unknown as Application;
    const query = vi.fn((sql: string) => {
      if (sql === ACTIVE_MINUTES_PER_DAY_QUERY) {
        return Promise.resolve({
          rows: [
            {
              day: '2026-08-27',
              count: 3,
              recorded_from: new Date('2026-08-28T05:58:00Z'),
              recorded_through: new Date('2026-08-28T06:00:00Z'),
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    setupOpsRoutes(
      {
        lakebase: { query },
        server: { extend: (register: (target: Application) => void) => register(app) },
      } as unknown as InsightsAppKit,
      { isAdminRoute: () => true, now: () => Date.parse('2026-08-31T12:00:00Z') }
    );

    let payload = {} as OpsTrafficPayload;
    await handler!(
      { query: { timeZone: 'America/New_York' }, headers: {} } as unknown as Request,
      { json: (body: OpsTrafficPayload) => (payload = body) } as unknown as Response
    );

    const parameters = ['UTC', '2026-08-01', '2026-08-30'];
    expect(query).toHaveBeenCalledWith(ACTIVE_MINUTES_PER_DAY_QUERY, parameters);
    expect(query).toHaveBeenCalledWith(QUESTIONS_PER_DAY_QUERY, parameters);
    expect(query).toHaveBeenCalledWith(DISTINCT_ASKERS_PER_DAY_QUERY, parameters);
    expect(payload.activeMinutesPerDay).toEqual([{ day: '2026-08-27', count: 3 }]);
    expect(payload.activeMinutesTimeZone).toBe('UTC');
    expect(payload.period).toBe('current_month');
    expect(payload.activeMinutesRecordedFrom).toBe('2026-08-28T05:58:00.000Z');
    expect(payload.activeMinutesRecordedThrough).toBe('2026-08-28T06:00:00.000Z');
  });
});
