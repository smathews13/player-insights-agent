import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminStore } from './admin-identity';
import {
  deploymentGroupRoleLookup,
  deploymentGroups,
  forgetWorkspaceGroupMemberships,
  groupRoleLookupForStore,
  rememberOwnGroups,
} from './workspace-group-roles';

const EMAIL = 'person@example.com';

function storeWithMappings(rows: Record<string, unknown>[]): AdminStore {
  return { query: vi.fn(() => Promise.resolve({ rows })) };
}

/** The caller's own SCIM record, as the request middleware records it. */
async function signIn(groups: (string | { display: string; type: string })[], caller = EMAIL): Promise<void> {
  const own = {
    userName: caller,
    groups: groups.map((group) => (typeof group === 'string' ? { display: group } : group)),
  };
  await expect(rememberOwnGroups(caller, 'user-token', () => Promise.resolve(own))).resolves.toBe(true);
}

function mapping(groupName: string, role: 'admin' | 'consumer') {
  return { group_name: groupName, role, added_by: 'owner@example.com', added_at: '2026-09-10T00:00:00.000Z' };
}

describe('stored workspace group roles', () => {
  beforeEach(() => forgetWorkspaceGroupMemberships());

  it('does not assign a group role when no mapping has been added', async () => {
    await signIn(['Existing Team']);
    await expect(groupRoleLookupForStore(storeWithMappings([]))(EMAIL)).resolves.toBeNull();
  });

  it('maps membership without case sensitivity', async () => {
    await signIn(['existing team']);
    const store = storeWithMappings([mapping('Existing Team', 'admin')]);
    await expect(groupRoleLookupForStore(store)(EMAIL.toUpperCase())).resolves.toBe('admin');
  });

  it('gives an admin mapping precedence over a consumer mapping', async () => {
    await signIn(['Readers', 'Operators']);
    const store = storeWithMappings([mapping('Readers', 'consumer'), mapping('Operators', 'admin')]);
    await expect(groupRoleLookupForStore(store)(EMAIL)).resolves.toBe('admin');
  });

  it('fails closed when the caller has not been seen with their own record', async () => {
    const store = storeWithMappings([mapping('Operators', 'admin')]);
    await expect(groupRoleLookupForStore(store)(EMAIL)).resolves.toBeNull();
  });
});

describe('the deployment admin group', () => {
  const ADMIN_GROUP = 'Example_PIA_Admin';
  const previous = process.env.PLAYER_INSIGHTS_ADMIN_GROUP;

  beforeEach(() => {
    forgetWorkspaceGroupMemberships();
    process.env.PLAYER_INSIGHTS_ADMIN_GROUP = ADMIN_GROUP;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.PLAYER_INSIGHTS_ADMIN_GROUP;
    else process.env.PLAYER_INSIGHTS_ADMIN_GROUP = previous;
  });

  it('makes members admins without any stored mapping', async () => {
    await signIn([ADMIN_GROUP.toLowerCase()]);
    await expect(groupRoleLookupForStore(storeWithMappings([]))(EMAIL)).resolves.toBe('admin');
  });

  it('cannot be weakened by a stored consumer row for the same group', async () => {
    await signIn([ADMIN_GROUP]);
    await expect(groupRoleLookupForStore(storeWithMappings([mapping(ADMIN_GROUP, 'consumer')]))(EMAIL)).resolves.toBe(
      'admin'
    );
  });

  it('still applies, and says so, when stored mappings cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await signIn([ADMIN_GROUP]);
    const store: AdminStore = { query: vi.fn(() => Promise.reject(new Error('lakebase down'))) };
    await expect(groupRoleLookupForStore(store)(EMAIL)).resolves.toBe('admin');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lakebase down'));
    warn.mockRestore();
  });

  it('ignores stored mappings in the deployment-only lookup', async () => {
    await signIn(['Operators', ADMIN_GROUP]);
    await expect(deploymentGroupRoleLookup()(EMAIL)).resolves.toBe('admin');
    process.env.PLAYER_INSIGHTS_ADMIN_GROUP = '';
    await expect(deploymentGroupRoleLookup()(EMAIL)).resolves.toBeNull();
  });

  it('counts membership through a nested group, which SCIM reports as indirect', async () => {
    await signIn([
      { display: 'Studio Leads', type: 'direct' },
      { display: ADMIN_GROUP, type: 'indirect' },
    ]);
    await expect(deploymentGroupRoleLookup()(EMAIL)).resolves.toBe('admin');
  });

  it('gives non-members no group role', async () => {
    await signIn(['Example_PIA_Engineer']);
    await expect(groupRoleLookupForStore(storeWithMappings([]))(EMAIL)).resolves.toBeNull();
  });

  it('is inert when the deployment names no group', async () => {
    process.env.PLAYER_INSIGHTS_ADMIN_GROUP = '';
    await signIn([ADMIN_GROUP]);
    await expect(groupRoleLookupForStore(storeWithMappings([]))(EMAIL)).resolves.toBeNull();
  });
});

describe("the caller's own group read", () => {
  const ADMIN_GROUP = 'Example_PIA_Admin';
  const previous = process.env.PLAYER_INSIGHTS_ADMIN_GROUP;

  beforeEach(() => {
    forgetWorkspaceGroupMemberships();
    process.env.PLAYER_INSIGHTS_ADMIN_GROUP = ADMIN_GROUP;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.PLAYER_INSIGHTS_ADMIN_GROUP;
    else process.env.PLAYER_INSIGHTS_ADMIN_GROUP = previous;
    vi.restoreAllMocks();
  });

  it('reads the record with the caller token and resolves the group role from it', async () => {
    const self = vi.fn(() => Promise.resolve({ userName: EMAIL, groups: [{ display: ADMIN_GROUP }] }));
    await expect(rememberOwnGroups(EMAIL, 'user-token', self)).resolves.toBe(true);
    expect(self).toHaveBeenCalledWith('user-token');
    await expect(deploymentGroupRoleLookup()(EMAIL)).resolves.toBe('admin');
  });

  it('reads once per caller within the cache window', async () => {
    const self = vi.fn(() => Promise.resolve({ userName: EMAIL, groups: [{ display: ADMIN_GROUP }] }));
    await rememberOwnGroups(EMAIL, 'user-token', self);
    await expect(rememberOwnGroups(EMAIL, 'user-token', self)).resolves.toBe(false);
    expect(self).toHaveBeenCalledTimes(1);
  });

  it('reads a service principal by its application ID', async () => {
    const caller = '0f6a2b5c-1d3e-4f70-8a9b-0c1d2e3f4a5b';
    const self = vi.fn(() => Promise.resolve({ applicationId: caller, groups: [{ display: ADMIN_GROUP }] }));
    await expect(rememberOwnGroups(caller.toUpperCase(), 'sp-token', self)).resolves.toBe(true);
    await expect(deploymentGroupRoleLookup()(caller)).resolves.toBe('admin');
  });

  it('never records groups from a token for somebody else', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const self = vi.fn(() => Promise.resolve({ userName: 'other@example.com', groups: [{ display: ADMIN_GROUP }] }));
    await expect(rememberOwnGroups(EMAIL, 'other-token', self)).resolves.toBe(false);
    await expect(deploymentGroupRoleLookup()(EMAIL)).resolves.toBeNull();
  });

  it('gives no group role, and says so once, when the own record cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const self = vi.fn(() => Promise.reject(new Error('SCIM Me returned 403')));
    await expect(rememberOwnGroups(EMAIL, 'user-token', self)).resolves.toBe(false);
    await expect(rememberOwnGroups(EMAIL, 'user-token', self)).resolves.toBe(false);
    await expect(deploymentGroupRoleLookup()(EMAIL)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('SCIM Me returned 403');
    expect(warn.mock.calls[0][0]).not.toContain(EMAIL);
  });

  it('retries a failed read on the next request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const self = vi
      .fn()
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({ userName: EMAIL, groups: [{ display: ADMIN_GROUP }] });
    await expect(rememberOwnGroups(EMAIL, 'user-token', self)).resolves.toBe(false);
    await expect(rememberOwnGroups(EMAIL, 'user-token', self)).resolves.toBe(true);
    await expect(deploymentGroupRoleLookup()(EMAIL)).resolves.toBe('admin');
  });

  it('skips the read without a token', async () => {
    const self = vi.fn();
    await expect(rememberOwnGroups(EMAIL, null, self)).resolves.toBe(false);
    expect(self).not.toHaveBeenCalled();
  });
});

describe('the deployment Super admin group', () => {
  const SUPER = 'Example_PIA_Super';
  const ADMIN = 'Example_PIA_Admin';
  const ENGINEER = 'Example_PIA_Engineer';
  const saved = {
    super: process.env.PLAYER_INSIGHTS_SUPER_ADMIN_GROUP,
    admin: process.env.PLAYER_INSIGHTS_ADMIN_GROUP,
    consumers: process.env.PLAYER_INSIGHTS_CONSUMER_GROUPS,
  };
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  beforeEach(() => {
    forgetWorkspaceGroupMemberships();
    process.env.PLAYER_INSIGHTS_SUPER_ADMIN_GROUP = SUPER;
    process.env.PLAYER_INSIGHTS_ADMIN_GROUP = ADMIN;
    process.env.PLAYER_INSIGHTS_CONSUMER_GROUPS = ENGINEER;
  });
  afterEach(() => {
    restore('PLAYER_INSIGHTS_SUPER_ADMIN_GROUP', saved.super);
    restore('PLAYER_INSIGHTS_ADMIN_GROUP', saved.admin);
    restore('PLAYER_INSIGHTS_CONSUMER_GROUPS', saved.consumers);
  });

  it.each([
    [[SUPER], 'super_admin'],
    [[ADMIN], 'admin'],
    [[ENGINEER], 'consumer'],
    [[SUPER, ADMIN], 'super_admin'],
    [[SUPER, ENGINEER], 'super_admin'],
    [[ADMIN, ENGINEER], 'admin'],
    [[SUPER, ADMIN, ENGINEER], 'super_admin'],
    [['Somebody Else'], null],
    [[], null],
  ] as const)('members of %j resolve to %s', async (groups, expected) => {
    await signIn([...groups]);
    await expect(deploymentGroupRoleLookup()(EMAIL)).resolves.toBe(expected);
  });

  it('cannot be lowered by a stored row for the same group', async () => {
    await signIn([SUPER]);
    await expect(groupRoleLookupForStore(storeWithMappings([mapping(SUPER, 'consumer')]))(EMAIL)).resolves.toBe(
      'super_admin'
    );
  });

  it('is listed first among the deployment groups, and only once if it is also the admin group', () => {
    expect(deploymentGroups()[0]).toEqual({ groupName: SUPER, role: 'super_admin' });
    process.env.PLAYER_INSIGHTS_ADMIN_GROUP = SUPER;
    expect(deploymentGroups().filter((group) => group.groupName === SUPER)).toEqual([
      { groupName: SUPER, role: 'super_admin' },
    ]);
  });

  it('is never a consumer group, even if listed as one', () => {
    process.env.PLAYER_INSIGHTS_CONSUMER_GROUPS = `${ENGINEER},${SUPER}`;
    expect(deploymentGroups().filter((group) => group.role === 'consumer')).toEqual([
      { groupName: ENGINEER, role: 'consumer' },
    ]);
  });

  it('loses the role on the next read after leaving the group', async () => {
    await signIn([SUPER]);
    await expect(deploymentGroupRoleLookup()(EMAIL)).resolves.toBe('super_admin');
    forgetWorkspaceGroupMemberships();
    await signIn([ENGINEER]);
    await expect(deploymentGroupRoleLookup()(EMAIL)).resolves.toBe('consumer');
  });
});

describe('the deployment consumer groups', () => {
  const ENGINEER = 'Example_PIA_Engineer';
  const EXEC = 'Example_PIA_Exec';
  const previous = process.env.PLAYER_INSIGHTS_CONSUMER_GROUPS;

  beforeEach(() => {
    forgetWorkspaceGroupMemberships();
    process.env.PLAYER_INSIGHTS_CONSUMER_GROUPS = ` ${ENGINEER}, ${EXEC} ,,${ENGINEER}`;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.PLAYER_INSIGHTS_CONSUMER_GROUPS;
    else process.env.PLAYER_INSIGHTS_CONSUMER_GROUPS = previous;
  });

  it('lists each group once, trimmed, without needing a stored row', () => {
    expect(deploymentGroups()).toEqual([
      { groupName: ENGINEER, role: 'consumer' },
      { groupName: EXEC, role: 'consumer' },
    ]);
  });

  it('cannot be raised by a stored admin row for the same group', async () => {
    await signIn([EXEC.toLowerCase()]);
    await expect(groupRoleLookupForStore(storeWithMappings([mapping(EXEC, 'admin')]))(EMAIL)).resolves.toBe('consumer');
  });

  it('is nothing when the environment names no groups', () => {
    delete process.env.PLAYER_INSIGHTS_CONSUMER_GROUPS;
    expect(deploymentGroups()).toEqual([]);
  });
});
