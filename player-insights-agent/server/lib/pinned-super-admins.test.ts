import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminStore } from './admin-identity';
import {
  announceSeedAdmins,
  bootstrapSeedRoles,
  PINNED_SUPER_ADMINS_ENV,
  resolveRole,
  seedAdminEmails,
  seedRoles,
  seedSuperAdminEmails,
} from './admin-roles';

const PINNED = 'pinned.owner@example.com';
const OTHER = 'someone.else@example.com';

function rosterWith(rows: { email: string; role: string }[]): AdminStore {
  return {
    query: vi.fn(() =>
      Promise.resolve({
        rows: rows.map((row) => ({ ...row, added_by: 'x', added_at: '2026-08-19T00:00:00.000Z' })),
      })
    ),
  };
}

describe('super admins pinned by the deployment', () => {
  beforeEach(() => {
    announceSeedAdmins('');
    process.env[PINNED_SUPER_ADMINS_ENV] = ` ${PINNED.toUpperCase()} , not-an-address `;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env[PINNED_SUPER_ADMINS_ENV];
    vi.restoreAllMocks();
  });

  it('is a super admin even when the stored roster lists them as a consumer', async () => {
    const store = rosterWith([{ email: PINNED, role: 'consumer' }]);
    await expect(resolveRole(store, PINNED)).resolves.toMatchObject({ role: 'super_admin' });
  });

  it('is still a super admin when the roster cannot be read', async () => {
    const unreadable: AdminStore = { query: vi.fn(() => Promise.reject(new Error('lakebase down'))) };
    await expect(resolveRole(unreadable, PINNED)).resolves.toMatchObject({ role: 'super_admin' });
  });

  it('stays pinned after production bootstrap clears the boot seed', async () => {
    const store = rosterWith([{ email: OTHER, role: 'consumer' }]);
    await bootstrapSeedRoles(store, '');
    expect(seedSuperAdminEmails()).toEqual([PINNED]);
    expect(seedAdminEmails()).toContain(PINNED);
    expect(seedRoles().superAdmins).toEqual([PINNED]);
  });

  it('promotes nobody else and ignores entries that are not addresses', async () => {
    const store = rosterWith([{ email: OTHER, role: 'consumer' }]);
    await expect(resolveRole(store, OTHER)).resolves.toMatchObject({ role: 'consumer' });
    expect(seedAdminEmails()).toEqual([PINNED]);
  });

  it('pins nobody when the deployment names no one', () => {
    delete process.env[PINNED_SUPER_ADMINS_ENV];
    expect(seedRoles()).toEqual({ superAdmins: [], admins: [] });
  });
});
