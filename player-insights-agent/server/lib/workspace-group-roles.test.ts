import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminStore } from './admin-identity';
import {
  deploymentGroupRoleLookup,
  deploymentGroups,
  forgetWorkspaceGroupMemberships,
  groupRoleLookupForStore,
} from './workspace-group-roles';

const EMAIL = 'person@example.com';

function storeWithMappings(rows: Record<string, unknown>[]): AdminStore {
  return { query: vi.fn(() => Promise.resolve({ rows })) };
}

function scim(groups: string[]) {
  return {
    Resources: [
      {
        userName: EMAIL,
        groups: groups.map((display) => ({ display })),
      },
    ],
  };
}

describe('stored workspace group roles', () => {
  beforeEach(() => forgetWorkspaceGroupMemberships());

  it('does not assign a group role when no mapping has been added', async () => {
    const reader = vi.fn(() => Promise.resolve(scim(['Existing Team'])));
    await expect(groupRoleLookupForStore(storeWithMappings([]), reader)(EMAIL)).resolves.toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });

  it('maps direct workspace membership without case sensitivity', async () => {
    const store = storeWithMappings([
      {
        group_name: 'Existing Team',
        role: 'admin',
        added_by: 'owner@example.com',
        added_at: '2026-09-10T00:00:00.000Z',
      },
    ]);
    const reader = vi.fn(() => Promise.resolve(scim(['existing team'])));

    await expect(groupRoleLookupForStore(store, reader)(EMAIL.toUpperCase())).resolves.toBe('admin');
    expect(reader).toHaveBeenCalledWith('/api/2.0/preview/scim/v2/Users', {
      filter: `userName eq "${EMAIL}"`,
    });
  });

  it('gives an admin mapping precedence over a consumer mapping', async () => {
    const store = storeWithMappings([
      {
        group_name: 'Readers',
        role: 'consumer',
        added_by: 'owner@example.com',
        added_at: '2026-09-10T00:00:00.000Z',
      },
      {
        group_name: 'Operators',
        role: 'admin',
        added_by: 'owner@example.com',
        added_at: '2026-09-10T00:00:00.000Z',
      },
    ]);
    const reader = vi.fn(() => Promise.resolve(scim(['Readers', 'Operators'])));

    await expect(groupRoleLookupForStore(store, reader)(EMAIL)).resolves.toBe('admin');
  });

  it('fails closed when SCIM membership cannot be read', async () => {
    const store = storeWithMappings([
      {
        group_name: 'Operators',
        role: 'admin',
        added_by: 'owner@example.com',
        added_at: '2026-09-10T00:00:00.000Z',
      },
    ]);
    await expect(
      groupRoleLookupForStore(store, () => Promise.reject(new Error('forbidden')))(EMAIL)
    ).resolves.toBeNull();
  });
});

describe('the deployment admin group', () => {
  const ADMIN_GROUP = 'S_TK2_Databricks_globalmartech_PIA_Admin';
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
    const reader = vi.fn(() => Promise.resolve(scim([ADMIN_GROUP.toLowerCase()])));
    await expect(groupRoleLookupForStore(storeWithMappings([]), reader)(EMAIL)).resolves.toBe('admin');
  });

  it('cannot be weakened by a stored consumer row for the same group', async () => {
    const store = storeWithMappings([
      {
        group_name: ADMIN_GROUP,
        role: 'consumer',
        added_by: 'owner@example.com',
        added_at: '2026-10-06T00:00:00.000Z',
      },
    ]);
    const reader = vi.fn(() => Promise.resolve(scim([ADMIN_GROUP])));
    await expect(groupRoleLookupForStore(store, reader)(EMAIL)).resolves.toBe('admin');
  });

  it('still applies, and says so, when stored mappings cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store: AdminStore = { query: vi.fn(() => Promise.reject(new Error('lakebase down'))) };
    const reader = vi.fn(() => Promise.resolve(scim([ADMIN_GROUP])));
    await expect(groupRoleLookupForStore(store, reader)(EMAIL)).resolves.toBe('admin');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lakebase down'));
    warn.mockRestore();
  });

  it('reads SCIM membership once per caller within the cache window', async () => {
    const reader = vi.fn(() => Promise.resolve(scim([ADMIN_GROUP])));
    const lookup = groupRoleLookupForStore(storeWithMappings([]), reader);
    await expect(lookup(EMAIL)).resolves.toBe('admin');
    await expect(lookup(EMAIL)).resolves.toBe('admin');
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed SCIM read', async () => {
    const reader = vi
      .fn()
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce(scim([ADMIN_GROUP]));
    const lookup = groupRoleLookupForStore(storeWithMappings([]), reader);
    await expect(lookup(EMAIL)).resolves.toBeNull();
    await expect(lookup(EMAIL)).resolves.toBe('admin');
  });

  it('does not cache a SCIM body that does not include the caller', async () => {
    const reader = vi
      .fn()
      .mockResolvedValueOnce({ Resources: [] })
      .mockResolvedValueOnce(scim([ADMIN_GROUP]));
    const lookup = groupRoleLookupForStore(storeWithMappings([]), reader);
    await expect(lookup(EMAIL)).resolves.toBeNull();
    await expect(lookup(EMAIL)).resolves.toBe('admin');
  });

  it('ignores stored mappings in the deployment-only lookup', async () => {
    const reader = vi.fn(() => Promise.resolve(scim(['Operators', ADMIN_GROUP])));
    await expect(deploymentGroupRoleLookup(reader)(EMAIL)).resolves.toBe('admin');
    process.env.PLAYER_INSIGHTS_ADMIN_GROUP = '';
    await expect(deploymentGroupRoleLookup(reader)(EMAIL)).resolves.toBeNull();
  });

  it('gives non-members no group role', async () => {
    const reader = vi.fn(() => Promise.resolve(scim(['S_TK2_Databricks_globalmartech_PIA_Engineer'])));
    await expect(groupRoleLookupForStore(storeWithMappings([]), reader)(EMAIL)).resolves.toBeNull();
  });

  it('is inert when the deployment names no group', async () => {
    process.env.PLAYER_INSIGHTS_ADMIN_GROUP = '';
    const reader = vi.fn(() => Promise.resolve(scim([ADMIN_GROUP])));
    await expect(groupRoleLookupForStore(storeWithMappings([]), reader)(EMAIL)).resolves.toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });
});

describe('the deployment consumer groups', () => {
  const ENGINEER = 'S_TK2_Databricks_globalmartech_PIA_Engineer';
  const EXEC = 'S_TK2_Databricks_globalmartech_PIA_Exec';
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
    const store = storeWithMappings([
      { group_name: EXEC, role: 'admin', added_by: 'owner@example.com', added_at: '2026-10-06T00:00:00.000Z' },
    ]);
    const reader = vi.fn(() => Promise.resolve(scim([EXEC.toLowerCase()])));
    await expect(groupRoleLookupForStore(store, reader)(EMAIL)).resolves.toBe('consumer');
  });

  it('is nothing when the environment names no groups', () => {
    delete process.env.PLAYER_INSIGHTS_CONSUMER_GROUPS;
    expect(deploymentGroups()).toEqual([]);
  });
});
