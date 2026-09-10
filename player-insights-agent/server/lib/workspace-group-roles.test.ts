import { describe, expect, it, vi } from 'vitest';
import type { AdminStore } from './admin-identity';
import { groupRoleLookupForStore } from './workspace-group-roles';

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
