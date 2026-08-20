import { describe, expect, it, vi } from 'vitest';

import { bootstrapSeedRoles, type AdminStore } from './admin-roles';
import { writeRole, type Role, type StoredRole } from './user-roster';

const DEPLOYER = 'deployer@example.com';
const EXISTING = 'existing@example.com';
const STALE = 'stale@example.com';

function stored(email: string, role: Role, actor = DEPLOYER): StoredRole {
  return { email, role, setBy: actor, setAt: '2026-08-19T00:00:00.000Z' };
}

function fakeRoster(initial: StoredRole[] = []) {
  const rows = initial.map((row) => ({ ...row }));
  const store: AdminStore = {
    async query(sql, params = []) {
      if (sql.startsWith('SELECT email, role,')) {
        return {
          rows: rows.map((row) => ({
            email: row.email,
            role: row.role,
            added_by: row.setBy,
            added_at: row.setAt,
          })),
        };
      }
      if (sql.includes('FROM (VALUES')) {
        if (rows.length > 0) return { rows: [] };
        const inserted: Record<string, unknown>[] = [];
        for (let index = 0; index < params.length; index += 3) {
          const row = stored(String(params[index]), String(params[index + 1]) as Role, String(params[index + 2]));
          rows.push(row);
          inserted.push({ email: row.email, role: row.role });
        }
        return { rows: inserted };
      }
      if (sql.startsWith('INSERT INTO') && sql.includes('ON CONFLICT (email) DO UPDATE')) {
        const email = String(params[0]);
        const role = String(params[1]) as Role;
        const actor = String(params[2]);
        const existing = rows.find((row) => row.email === email);
        if (existing) {
          existing.role = role;
          existing.setBy = actor;
        } else {
          rows.push(stored(email, role, actor));
        }
        return { rows: [] };
      }
      throw new Error(`Unexpected role-bootstrap SQL: ${sql}`);
    },
  };
  return { store, rows };
}

describe('deployment role bootstrap', () => {
  it.each([
    ['a different configured admin', `super:${STALE}`],
    ['no configured admin', ''],
  ])('ignores %s when Lakebase already has roles', async (_label, config) => {
    const fixture = fakeRoster([stored(EXISTING, 'super_admin'), stored('reader@example.com', 'consumer')]);

    expect(await bootstrapSeedRoles(fixture.store, config)).toBe('existing-roster');
    expect(fixture.rows).toEqual([
      stored(EXISTING, 'super_admin'),
      stored('reader@example.com', 'consumer'),
    ]);
  });

  it('bootstraps the configured administrator when the roster is genuinely empty', async () => {
    const fixture = fakeRoster();

    expect(await bootstrapSeedRoles(fixture.store, `super:${DEPLOYER}`)).toBe('bootstrapped');
    expect(fixture.rows).toEqual([stored(DEPLOYER, 'super_admin', DEPLOYER)]);
  });

  it('is idempotent on a second boot with the same config', async () => {
    const fixture = fakeRoster();

    await bootstrapSeedRoles(fixture.store, `super:${DEPLOYER}`);
    expect(await bootstrapSeedRoles(fixture.store, `super:${DEPLOYER}`)).toBe('existing-roster');
    expect(fixture.rows).toEqual([stored(DEPLOYER, 'super_admin', DEPLOYER)]);
  });

  it('preserves a UI promotion across a code deploy with stale config', async () => {
    const fixture = fakeRoster([stored(DEPLOYER, 'admin')]);
    await writeRole(fixture.store, {
      email: EXISTING,
      role: 'super_admin',
      actor: DEPLOYER,
      roleColumnPresent: true,
    });

    expect(await bootstrapSeedRoles(fixture.store, `super:${STALE}`)).toBe('existing-roster');
    expect(fixture.rows).toEqual([
      stored(DEPLOYER, 'admin'),
      stored(EXISTING, 'super_admin', DEPLOYER),
    ]);
  });

  it('preserves explicit consumer rows across a code deploy', async () => {
    const fixture = fakeRoster([stored(EXISTING, 'consumer')]);

    expect(await bootstrapSeedRoles(fixture.store, `super:${STALE}`)).toBe('existing-roster');
    expect(fixture.rows).toEqual([stored(EXISTING, 'consumer')]);
  });

  it.each([
    ['permission denied', '42501', 'permission denied for schema player_insights'],
    ['missing schema', '3F000', 'schema "player_insights" does not exist'],
  ])('keeps boot running with an empty runtime roster when the schema is %s', async (_label, code, message) => {
    const queries: string[] = [];
    const store: AdminStore = {
      async query(sql) {
        queries.push(sql);
        const error = new Error(message) as Error & { code?: string };
        error.code = code;
        throw error;
      },
    };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(bootstrapSeedRoles(store, `super:${DEPLOYER}`)).resolves.toBe('unavailable');
      expect(queries).toHaveLength(1);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('ROLE BOOTSTRAP SKIPPED'));
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('No configured role was written or retained'));
    } finally {
      errorLog.mockRestore();
    }
  });
});
