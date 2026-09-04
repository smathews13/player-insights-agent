import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetFirstAppDeployments, resolveFirstAppDeployment } from './app-deployment-lifetime';

describe('retained deployment-history boundary', () => {
  beforeEach(forgetFirstAppDeployments);

  it('uses earlier durable Git-app activity when retained history starts later', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ first_active_at: '2026-08-19T21:00:00Z' }] })
      .mockResolvedValueOnce({ rows: [] });
    const resolved = await resolveFirstAppDeployment({
      store: { query },
      appName: 'git-app',
      workspaceId: '123',
      readHistory: vi.fn().mockResolvedValue({
        app_deployments: [{ create_time: '2026-09-01T23:27:30Z', status: { state: 'SUCCEEDED' } }],
      }),
      readAppSource: vi.fn().mockResolvedValue(true),
    });
    expect(resolved).toMatchObject({
      deployedAt: '2026-08-19T21:00:00.000Z',
      evidence: 'durable_app_activity',
    });
  });
});
