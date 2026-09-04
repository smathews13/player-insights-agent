import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADD_FIRST_DEPLOYED_BY_STATEMENT,
  APP_DEPLOYMENT_LIFETIME_DDL,
  APP_DEPLOYMENT_LIFETIME_TABLE,
  FIRST_DURABLE_APP_ACTIVITY_QUERY,
  READ_APP_DEPLOYMENT_LIFETIME_QUERY,
  WRITE_APP_DEPLOYMENT_LIFETIME_QUERY,
  earliestSuccessfulDeployment,
  earliestSuccessfulDeploymentRecord,
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

  it('adds one nullable immutable owner identity without rewriting version 38', () => {
    const migration = LATER_MIGRATIONS.find((entry) => entry.version === 40);
    expect(migration?.name).toBe('immutable first deployment owner');
    expect(migration?.statements).toEqual([ADD_FIRST_DEPLOYED_BY_STATEMENT]);
    expect(ADD_FIRST_DEPLOYED_BY_STATEMENT).toContain('ADD COLUMN IF NOT EXISTS first_deployed_by TEXT');
    expect(APP_DEPLOYMENT_LIFETIME_DDL).not.toContain('first_deployed_by');
    expect(APP_DEPLOYMENT_LIFETIME_DDL).toContain('app_scope TEXT PRIMARY KEY');
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

  it('takes the creator only from the earliest successful deployment, including Git deployments', () => {
    expect(
      earliestSuccessfulDeploymentRecord([
        {
          app_deployments: [
            {
              create_time: '2026-09-01T00:00:00Z',
              creator: 'later@example.invalid',
              status: { state: 'SUCCEEDED' },
            },
            {
              create_time: '2026-08-28T18:42:11Z',
              creator: 'First.Deployer@Example.Invalid',
              git_source: { branch: 'main' },
              status: { state: 'SUCCEEDED' },
            },
          ],
        },
      ])
    ).toEqual({
      deployedAt: '2026-08-28T18:42:11.000Z',
      deployedBy: 'first.deployer@example.invalid',
      evidence: 'apps_deployment_history',
    });
  });

  it('does not guess an owner when the earliest successful record has no creator', () => {
    expect(
      earliestSuccessfulDeploymentRecord([
        {
          app_deployments: [
            { create_time: '2026-08-01T00:00:00Z', status: { state: 'SUCCEEDED' } },
            {
              create_time: '2026-08-02T00:00:00Z',
              creator: 'later@example.invalid',
              status: { state: 'SUCCEEDED' },
            },
          ],
        },
      ])?.deployedBy
    ).toBe('');
  });

  it('retains earlier persisted proof while refreshing bounded control-plane evidence', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            first_deployed_at: '2026-08-28T18:42:11Z',
            first_deployed_by: '',
            evidence: 'apps_deployment_history',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const readHistory = vi.fn().mockResolvedValue({ app_deployments: [] });
    await expect(
      resolveFirstAppDeployment({
        store: { query },
        appName: 'astrolabe',
        workspaceId: '123',
        readHistory,
        readAppSource: vi.fn().mockResolvedValue(false),
      })
    ).resolves.toEqual({
      deployedAt: '2026-08-28T18:42:11.000Z',
      deployedBy: '',
      evidence: 'apps_deployment_history',
    });
    expect(query).toHaveBeenCalledWith(READ_APP_DEPLOYMENT_LIFETIME_QUERY, ['123:astrolabe']);
    expect(query).toHaveBeenCalledTimes(2);
    expect(readHistory).toHaveBeenCalledOnce();
  });

  it('reuses one persisted owner read across concurrent callers', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          first_deployed_at: '2026-08-28T18:42:11Z',
          first_deployed_by: 'first.deployer@example.invalid',
          evidence: 'apps_deployment_history',
        },
      ],
    });
    const readHistory = vi.fn();
    const input = { store: { query }, appName: 'astrolabe', workspaceId: '123', readHistory };

    await expect(Promise.all([resolveFirstAppDeployment(input), resolveFirstAppDeployment(input)])).resolves.toEqual([
      {
        deployedAt: '2026-08-28T18:42:11.000Z',
        deployedBy: 'first.deployer@example.invalid',
        evidence: 'apps_deployment_history',
      },
      {
        deployedAt: '2026-08-28T18:42:11.000Z',
        deployedBy: 'first.deployer@example.invalid',
        evidence: 'apps_deployment_history',
      },
    ]);
    expect(query).toHaveBeenCalledOnce();
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
        app_deployments: [
          {
            create_time: '2026-08-28T18:42:11Z',
            creator: 'first.deployer@example.invalid',
            status: { state: 'SUCCEEDED' },
          },
        ],
      });
    const result = await resolveFirstAppDeployment({
      store: { query },
      appName: 'astrolabe',
      workspaceId: '123',
      readHistory,
      readAppSource: vi.fn().mockResolvedValue(false),
    });
    expect(result).toEqual({
      deployedAt: '2026-08-28T18:42:11.000Z',
      deployedBy: 'first.deployer@example.invalid',
      evidence: 'apps_deployment_history',
    });
    expect(readHistory).toHaveBeenNthCalledWith(1, 'astrolabe', undefined);
    expect(readHistory).toHaveBeenNthCalledWith(2, 'astrolabe', 'next');
    expect(query).toHaveBeenLastCalledWith(WRITE_APP_DEPLOYMENT_LIFETIME_QUERY, [
      '123:astrolabe',
      '2026-08-28T18:42:11.000Z',
      'apps_deployment_history',
      'first.deployer@example.invalid',
    ]);
  });

  it('uses a singleton conflict write that concurrent later deploys cannot overwrite', () => {
    expect(WRITE_APP_DEPLOYMENT_LIFETIME_QUERY).toContain('ON CONFLICT (app_scope) DO UPDATE');
    expect(WRITE_APP_DEPLOYMENT_LIFETIME_QUERY).toContain(
      `WHEN EXCLUDED.first_deployed_at < ${APP_DEPLOYMENT_LIFETIME_TABLE}.first_deployed_at`
    );
    expect(WRITE_APP_DEPLOYMENT_LIFETIME_QUERY).toContain(
      `WHEN EXCLUDED.first_deployed_at = ${APP_DEPLOYMENT_LIFETIME_TABLE}.first_deployed_at`
    );
    expect(WRITE_APP_DEPLOYMENT_LIFETIME_QUERY).toContain('THEN EXCLUDED.first_deployed_by');
    expect(WRITE_APP_DEPLOYMENT_LIFETIME_QUERY).toContain(`ELSE ${APP_DEPLOYMENT_LIFETIME_TABLE}.first_deployed_by`);
    expect(WRITE_APP_DEPLOYMENT_LIFETIME_QUERY).not.toMatch(/first_deployed_by\s*=\s*EXCLUDED\.first_deployed_by/);
  });

  it('persists the actual first Git deployer when history predates durable activity', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ first_active_at: '2026-08-29T00:00:00Z' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      resolveFirstAppDeployment({
        store: { query },
        appName: 'git-app',
        workspaceId: '123',
        readHistory: vi.fn().mockResolvedValue({
          app_deployments: [
            {
              create_time: '2026-08-28T18:42:11Z',
              creator: 'git.deployer@example.invalid',
              git_source: { branch: 'main' },
              status: { state: 'SUCCEEDED' },
            },
          ],
        }),
      })
    ).resolves.toEqual({
      deployedAt: '2026-08-28T18:42:11.000Z',
      deployedBy: 'git.deployer@example.invalid',
      evidence: 'apps_deployment_history',
    });
    expect(query).toHaveBeenLastCalledWith(WRITE_APP_DEPLOYMENT_LIFETIME_QUERY, [
      '123:git-app',
      '2026-08-28T18:42:11.000Z',
      'apps_deployment_history',
      'git.deployer@example.invalid',
    ]);
  });

  it('uses earlier durable Git-app activity when retained deployment history starts later', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ first_active_at: '2026-08-19T21:00:00Z' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      resolveFirstAppDeployment({
        store: { query },
        appName: 'git-app',
        workspaceId: '123',
        readHistory: vi.fn().mockResolvedValue({
          app_deployments: [
            { create_time: '2026-09-01T23:27:30Z', creator: 'later@example.test', status: { state: 'SUCCEEDED' } },
          ],
        }),
        readAppSource: vi.fn().mockResolvedValue(true),
      })
    ).resolves.toEqual({
      deployedAt: '2026-08-19T21:00:00.000Z',
      deployedBy: '',
      evidence: 'durable_app_activity',
    });
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
      deployedBy: '',
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
