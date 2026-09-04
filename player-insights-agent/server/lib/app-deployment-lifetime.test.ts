import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APP_DEPLOYMENT_LIFETIME_DDL,
  APP_DEPLOYMENT_LIFETIME_TABLE,
  FIRST_DURABLE_APP_ACTIVITY_QUERY,
  READ_APP_DEPLOYMENT_LIFETIME_QUERY,
  WRITE_APP_DEPLOYMENT_LIFETIME_QUERY,
  earliestSuccessfulDeployment,
  forgetFirstAppDeployments,
  resolveFirstAppDeployment,
} from './app-deployment-lifetime';
import { LATER_MIGRATIONS } from './migrations';

describe('first app deployment evidence', () => {
  beforeEach(forgetFirstAppDeployments);

  it('adds a durable, content-free deployment lifetime record', () => {
    const migration = LATER_MIGRATIONS.find((entry) => entry.version === 38);
    expect(migration?.name).toBe('app deployment lifetime evidence');
    expect(migration?.statements).toEqual([APP_DEPLOYMENT_LIFETIME_DDL]);
    expect(APP_DEPLOYMENT_LIFETIME_DDL).toContain('first_deployed_at TIMESTAMPTZ NOT NULL');
    expect(APP_DEPLOYMENT_LIFETIME_DDL).not.toMatch(/resource|endpoint|warehouse|prompt|user_email/i);
    expect(migration?.down).toEqual([`DROP TABLE IF EXISTS ${APP_DEPLOYMENT_LIFETIME_TABLE}`]);
  });

  it('selects the earliest successful deployment across every history page', () => {
    expect(
      earliestSuccessfulDeployment([
        {
          app_deployments: [
            { create_time: '2026-08-29T00:00:00Z', status: { state: 'SUCCEEDED' } },
            { create_time: '2026-06-01T00:00:00Z', status: { state: 'FAILED' } },
          ],
        },
        {
          app_deployments: [
            { create_time: '2026-08-28T18:42:11Z', status: { state: 'SUCCEEDED' } },
            { create_time: 'not-a-time', status: { state: 'SUCCEEDED' } },
          ],
        },
      ])
    ).toBe('2026-08-28T18:42:11.000Z');
  });

  it('reuses persisted proof without calling the control plane or activity fallback', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ first_deployed_at: '2026-08-28T18:42:11Z', evidence: 'apps_deployment_history' }],
    });
    const readHistory = vi.fn();
    await expect(
      resolveFirstAppDeployment({ store: { query }, appName: 'astrolabe', workspaceId: '123', readHistory })
    ).resolves.toEqual({
      deployedAt: '2026-08-28T18:42:11.000Z',
      evidence: 'apps_deployment_history',
    });
    expect(query).toHaveBeenCalledWith(READ_APP_DEPLOYMENT_LIFETIME_QUERY, ['123:astrolabe']);
    expect(query).toHaveBeenCalledTimes(1);
    expect(readHistory).not.toHaveBeenCalled();
  });

  it('paginates deployment history and persists the earliest successful result', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const readHistory = vi
      .fn()
      .mockResolvedValueOnce({
        app_deployments: [{ create_time: '2026-09-01T00:00:00Z', status: { state: 'SUCCEEDED' } }],
        next_page_token: 'next',
      })
      .mockResolvedValueOnce({
        app_deployments: [{ create_time: '2026-08-28T18:42:11Z', status: { state: 'SUCCEEDED' } }],
      });
    const result = await resolveFirstAppDeployment({
      store: { query },
      appName: 'astrolabe',
      workspaceId: '123',
      readHistory,
    });
    expect(result).toEqual({
      deployedAt: '2026-08-28T18:42:11.000Z',
      evidence: 'apps_deployment_history',
    });
    expect(readHistory).toHaveBeenNthCalledWith(1, 'astrolabe', undefined);
    expect(readHistory).toHaveBeenNthCalledWith(2, 'astrolabe', 'next');
    expect(query).toHaveBeenLastCalledWith(WRITE_APP_DEPLOYMENT_LIFETIME_QUERY, [
      '123:astrolabe',
      '2026-08-28T18:42:11.000Z',
      'apps_deployment_history',
    ]);
  });

  it('falls back only to durable app activity and returns unavailable when neither source proves a date', async () => {
    const withActivity = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ first_active_at: '2026-08-28T19:00:00Z' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      resolveFirstAppDeployment({
        store: { query: withActivity },
        appName: 'git-app',
        workspaceId: '123',
        readHistory: vi.fn().mockRejectedValue(new Error('forbidden')),
        readAppSource: vi.fn().mockResolvedValue(true),
      })
    ).resolves.toEqual({
      deployedAt: '2026-08-28T19:00:00.000Z',
      evidence: 'durable_app_activity',
    });
    expect(withActivity).toHaveBeenNthCalledWith(2, FIRST_DURABLE_APP_ACTIVITY_QUERY);

    forgetFirstAppDeployments();
    const noEvidence = vi.fn().mockResolvedValueOnce({ rows: [] });
    await expect(
      resolveFirstAppDeployment({
        store: { query: noEvidence },
        appName: 'unknown-app',
        workspaceId: '123',
        readHistory: vi.fn().mockResolvedValue({ app_deployments: [] }),
        readAppSource: vi.fn().mockResolvedValue(false),
      })
    ).resolves.toBeNull();
    expect(noEvidence).toHaveBeenCalledTimes(1);
  });
});
