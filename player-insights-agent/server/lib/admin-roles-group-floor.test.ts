import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminStore } from './admin-identity';

import { announceSeedAdmins, resolveRole } from './admin-roles';
import { forgetWorkspaceGroupMemberships, rememberOwnGroups } from './workspace-group-roles';

const ADMIN_GROUP = 'Example_PIA_Admin';
const MEMBER = 'member@example.com';
const signIn = (groups: string[]) =>
  rememberOwnGroups(MEMBER, 'member-token', () =>
    Promise.resolve({ userName: MEMBER, groups: groups.map((display) => ({ display })) })
  );
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
    await signIn([ADMIN_GROUP]);
    await expect(resolveRole(unreadable, MEMBER)).resolves.toMatchObject({
      role: 'admin',
      addedAdminsReadable: false,
    });
  });

  it('admits nobody else above the seed floor', async () => {
    await signIn(['Example_PIA_Engineer']);
    await expect(resolveRole(unreadable, MEMBER)).resolves.toMatchObject({ role: 'consumer' });
  });

  it('keeps the deployment Super admin group, so its members can repair the roster', async () => {
    process.env.PLAYER_INSIGHTS_SUPER_ADMIN_GROUP = 'Example_PIA_Super';
    await signIn(['Example_PIA_Super']);
    await expect(resolveRole(unreadable, MEMBER)).resolves.toMatchObject({ role: 'super_admin' });
    delete process.env.PLAYER_INSIGHTS_SUPER_ADMIN_GROUP;
  });

  it('applies no floor when the deployment names no admin group', async () => {
    process.env.PLAYER_INSIGHTS_ADMIN_GROUP = '';
    await signIn([ADMIN_GROUP]);
    await expect(resolveRole(unreadable, MEMBER)).resolves.toMatchObject({ role: 'consumer' });
  });
});
