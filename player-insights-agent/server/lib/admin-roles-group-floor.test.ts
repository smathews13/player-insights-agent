import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminStore } from './admin-identity';

const scimGroups = vi.hoisted(() => ({ value: [] as string[] }));

vi.mock('./control-plane-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./control-plane-identity')>();
  return {
    ...actual,
    workspaceControlPlaneReader: vi.fn((_path: string, query?: Record<string, string>) => {
      const userName = /"(.*)"/.exec(query?.filter ?? '')?.[1] ?? '';
      return Promise.resolve({
        Resources: [{ userName, groups: scimGroups.value.map((display) => ({ display })) }],
      });
    }),
  };
});

const { announceSeedAdmins, resolveRole } = await import('./admin-roles');
const { forgetWorkspaceGroupMemberships } = await import('./workspace-group-roles');

const ADMIN_GROUP = '<admin-group>';
const MEMBER = 'member@example.com';
const unreadable: AdminStore = { query: vi.fn(() => Promise.reject(new Error('lakebase down'))) };

describe('role resolution while the roster is unreadable', () => {
  beforeEach(() => {
    announceSeedAdmins('super:lead@example.com');
    forgetWorkspaceGroupMemberships();
    process.env.PLAYER_INSIGHTS_ADMIN_GROUP = ADMIN_GROUP;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env.PLAYER_INSIGHTS_ADMIN_GROUP;
    vi.restoreAllMocks();
  });

  it('keeps the deployment admin group as an Admin floor', async () => {
    scimGroups.value = [ADMIN_GROUP];
    await expect(resolveRole(unreadable, MEMBER)).resolves.toMatchObject({
      role: 'admin',
      addedAdminsReadable: false,
    });
  });

  it('admits nobody else above the seed floor', async () => {
    scimGroups.value = ['<engineer-group>'];
    await expect(resolveRole(unreadable, MEMBER)).resolves.toMatchObject({ role: 'consumer' });
  });

  it('applies no floor when the deployment names no admin group', async () => {
    process.env.PLAYER_INSIGHTS_ADMIN_GROUP = '';
    scimGroups.value = [ADMIN_GROUP];
    await expect(resolveRole(unreadable, MEMBER)).resolves.toMatchObject({ role: 'consumer' });
  });
});
