/**
 * The precedence rule and the refusals, asserted without a server.
 *
 * Every address here is invented. The people this feature exists for are at a
 * customer domain, and a real address in a test file is a real address in the
 * published tree.
 */
import { describe, expect, it } from 'vitest';
import {
  ADD_ROLE_COLUMN_STATEMENT,
  countSuperAdmins,
  effectiveRole,
  everyKnownUser,
  readRoster,
  recoveryStatement,
  REFUSAL_DETAIL,
  removalRefusal,
  roleChangeRefusal,
  roleChangeSentence,
  rosterPayload,
  ROLE_COLUMN,
  seedFloorFor,
  writeRole,
  type SeedRoles,
  type StoredRole,
} from './user-roster';
import { ADDED_ADMINS_TABLE } from './admin-roles-schema';
import type { AdminStore } from './admin-identity';

const LEAD = 'lead@example.invalid';
const DEPUTY = 'deputy@example.invalid';
const ANALYST = 'analyst@example.invalid';
const STRANGER = 'stranger@example.invalid';

const NO_SEED: SeedRoles = { superAdmins: [], admins: [] };
const LEAD_SEEDED: SeedRoles = { superAdmins: [LEAD], admins: [LEAD] };

function stored(email: string, role: StoredRole['role']): StoredRole {
  return { email, role, setBy: LEAD, setAt: '2026-08-17T00:00:00.000Z' };
}

describe('the seed is a floor', () => {
  it('gives a seeded super admin the rank whatever the store says', () => {
    // The store says admin. The environment says super admin. The floor wins,
    // because the alternative lets a store that is wrong take away the one role
    // that can put it right.
    expect(effectiveRole({ seed: LEAD_SEEDED, stored: [stored(LEAD, 'admin')], email: LEAD })).toBe('super_admin');
  });

  it('lets the store raise a seeded admin', () => {
    const seed: SeedRoles = { superAdmins: [], admins: [DEPUTY] };
    expect(effectiveRole({ seed, stored: [stored(DEPUTY, 'super_admin')], email: DEPUTY })).toBe('super_admin');
  });

  it('gives an address neither half names nothing', () => {
    expect(effectiveRole({ seed: LEAD_SEEDED, stored: [], email: STRANGER })).toBe('consumer');
    expect(seedFloorFor(LEAD_SEEDED, STRANGER)).toBe('consumer');
  });

  it('reads a stored consumer row as a consumer', () => {
    // An explicit row is how the roster can list somebody it has not promoted.
    expect(effectiveRole({ seed: NO_SEED, stored: [stored(ANALYST, 'consumer')], email: ANALYST })).toBe('consumer');
  });

  it('matches an address whatever case it was written in', () => {
    const seed: SeedRoles = { superAdmins: [LEAD], admins: [LEAD] };
    expect(effectiveRole({ seed, stored: [], email: 'Lead@Example.INVALID' })).toBe('super_admin');
  });
});

describe('the deployment cannot be left with no super admin', () => {
  it('refuses demoting the only one', () => {
    const refusal = roleChangeRefusal({
      email: DEPUTY,
      role: 'admin',
      seed: NO_SEED,
      stored: [stored(DEPUTY, 'super_admin')],
      roleColumnPresent: true,
    });
    expect(refusal).toBe('immutable-super-admin');
  });

  it('refuses removing the only one', () => {
    expect(removalRefusal({ email: DEPUTY, seed: NO_SEED, stored: [stored(DEPUTY, 'super_admin')] })).toBe(
      'immutable-super-admin'
    );
  });

  it('refuses demoting a super admin even when there are two', () => {
    const refusal = roleChangeRefusal({
      email: DEPUTY,
      role: 'consumer',
      seed: NO_SEED,
      stored: [stored(DEPUTY, 'super_admin'), stored(ANALYST, 'super_admin')],
      roleColumnPresent: true,
    });
    expect(refusal).toBe('immutable-super-admin');
  });

  it('refuses removing a stored super admin even when a seeded owner remains', () => {
    const refusal = removalRefusal({
      email: DEPUTY,
      seed: LEAD_SEEDED,
      stored: [stored(DEPUTY, 'super_admin')],
    });
    expect(refusal).toBe('immutable-super-admin');
  });

  it('counts one address named by both halves once', () => {
    expect(countSuperAdmins({ seed: LEAD_SEEDED, stored: [stored(LEAD, 'super_admin')] })).toBe(1);
  });
});

describe('a seed row cannot be lowered from inside the app', () => {
  it('refuses lowering below the floor', () => {
    const refusal = roleChangeRefusal({
      email: LEAD,
      role: 'admin',
      seed: LEAD_SEEDED,
      stored: [],
      roleColumnPresent: true,
    });
    expect(refusal).toBe('immutable-super-admin');
  });

  it('refuses removing a seeded row', () => {
    expect(removalRefusal({ email: LEAD, seed: LEAD_SEEDED, stored: [stored(LEAD, 'super_admin')] })).toBe(
      'immutable-super-admin'
    );
  });

  it('allows raising a seeded admin above the floor', () => {
    const seed: SeedRoles = { superAdmins: [LEAD], admins: [LEAD, DEPUTY] };
    const refusal = roleChangeRefusal({
      email: DEPUTY,
      role: 'super_admin',
      seed,
      stored: [],
      roleColumnPresent: true,
    });
    expect(refusal).toBe('');
  });
});

describe('the other refusals', () => {
  it('refuses a role that is not one of the three', () => {
    expect(
      roleChangeRefusal({ email: ANALYST, role: 'owner', seed: NO_SEED, stored: [], roleColumnPresent: true })
    ).toBe('unknown-role');
  });

  it('refuses setting a role somebody already holds', () => {
    expect(
      roleChangeRefusal({
        email: ANALYST,
        role: 'admin',
        seed: NO_SEED,
        stored: [stored(ANALYST, 'admin')],
        roleColumnPresent: true,
      })
    ).toBe('already-holds');
  });

  it('allows POST to create an explicit consumer row for a new address', () => {
    expect(
      roleChangeRefusal({
        email: ANALYST,
        role: 'consumer',
        seed: LEAD_SEEDED,
        stored: [],
        roleColumnPresent: true,
        allowMissingConsumer: true,
      })
    ).toBe('');
  });

  it('still refuses a duplicate explicit consumer row', () => {
    expect(
      roleChangeRefusal({
        email: ANALYST,
        role: 'consumer',
        seed: LEAD_SEEDED,
        stored: [stored(ANALYST, 'consumer')],
        roleColumnPresent: true,
        allowMissingConsumer: true,
      })
    ).toBe('already-holds');
  });

  it('refuses an address the roster does not name', () => {
    expect(removalRefusal({ email: STRANGER, seed: NO_SEED, stored: [] })).toBe('not-found');
  });

  it('names the statement to run when the store cannot record a role', () => {
    const refusal = roleChangeRefusal({
      email: ANALYST,
      role: 'super_admin',
      seed: LEAD_SEEDED,
      stored: [],
      roleColumnPresent: false,
    });
    expect(refusal).toBe('no-role-column');
    expect(REFUSAL_DETAIL['no-role-column']).toContain(ADD_ROLE_COLUMN_STATEMENT);
  });

  it('still records an admin without the column, because a row has always meant admin', () => {
    const refusal = roleChangeRefusal({
      email: ANALYST,
      role: 'admin',
      seed: LEAD_SEEDED,
      stored: [],
      roleColumnPresent: false,
    });
    expect(refusal).toBe('');
  });
});

describe('the payload decides what each row may do', () => {
  const payload = () =>
    rosterPayload({
      seed: LEAD_SEEDED,
      stored: [stored(DEPUTY, 'admin'), stored(ANALYST, 'consumer')],
      storedRosterReadable: true,
      roleColumnPresent: true,
      reader: DEPUTY,
    });

  it('lists everybody either half names, highest rank first', () => {
    expect(payload().entries.map((entry) => entry.email)).toEqual([LEAD, DEPUTY, ANALYST]);
  });

  it('offers a seed row no role below its floor', () => {
    const lead = payload().entries.find((entry) => entry.email === LEAD);
    expect(lead?.assignable).toEqual([]);
    expect(lead?.canRemove).toBe(false);
  });

  it('marks the reader', () => {
    expect(payload().entries.find((entry) => entry.isYou)?.email).toBe(DEPUTY);
  });

  it('never offers a change the route would refuse', () => {
    // The property that matters about this payload: the control on screen and the
    // refusal on the route are one rule rather than two implementations of one.
    for (const entry of payload().entries) {
      for (const role of entry.assignable) {
        expect(
          roleChangeRefusal({
            email: entry.email,
            role,
            seed: LEAD_SEEDED,
            stored: [stored(DEPUTY, 'admin'), stored(ANALYST, 'consumer')],
            roleColumnPresent: true,
          })
        ).toBe('');
      }
    }
  });

  it('withholds the recovery statement while anybody can act', () => {
    expect(payload().recoveryStatement).toBe('');
  });

  it('prints the recovery statement only when nobody can act at all', () => {
    const locked = rosterPayload({
      seed: NO_SEED,
      stored: [],
      storedRosterReadable: true,
      roleColumnPresent: true,
      reader: STRANGER,
    });
    expect(locked.recoveryStatement).toBe(recoveryStatement());
    expect(locked.recoveryStatement).toContain(ADDED_ADMINS_TABLE);
  });

  it('withholds it when there is an admin but no super admin', () => {
    // An admin can still be raised by whoever holds the database, and a refusal
    // that prints a statement naming the app's tables to somebody who can act is a
    // directory of the things worth asking for.
    const noSuper = rosterPayload({
      seed: { superAdmins: [], admins: [DEPUTY] },
      stored: [],
      storedRosterReadable: true,
      roleColumnPresent: true,
      reader: DEPUTY,
    });
    expect(noSuper.superAdminCount).toBe(0);
    expect(noSuper.recoveryStatement).toBe('');
  });

  it('names the pending statement when the store cannot record a role', () => {
    const pending = rosterPayload({
      seed: LEAD_SEEDED,
      stored: [],
      storedRosterReadable: true,
      roleColumnPresent: false,
      reader: LEAD,
    });
    expect(pending.pendingSchemaStatement).toBe(ADD_ROLE_COLUMN_STATEMENT);
  });
});

describe('reading a roster whose table predates the role column', () => {
  /** A store that refuses the role column the way Postgres does, once. */
  function storeWithoutRoleColumn(): AdminStore & { asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      query(text: string) {
        asked.push(text.replace(/\s+/g, ' ').trim());
        if (text.includes(ROLE_COLUMN)) {
          const error = new Error(`column "${ROLE_COLUMN}" does not exist`) as Error & { code: string };
          error.code = '42703';
          return Promise.reject(error);
        }
        return Promise.resolve({
          rows: [{ email: DEPUTY, added_by: LEAD, added_at: '2026-08-17T00:00:00.000Z' }],
        });
      },
    };
  }

  it('re-reads without it and calls every row an admin', async () => {
    const store = storeWithoutRoleColumn();
    const roster = await readRoster(store);
    expect(roster.roleColumnPresent).toBe(false);
    expect(roster.rows).toEqual([stored(DEPUTY, 'admin')]);
  });

  it('writes without it rather than reporting a role it did not record', async () => {
    const written: unknown[][] = [];
    const store: AdminStore = {
      query(text: string, params: unknown[] = []) {
        written.push([text.replace(/\s+/g, ' ').trim(), ...params]);
        return Promise.resolve({ rows: [] });
      },
    };
    await writeRole(store, { email: ANALYST, role: 'admin', actor: LEAD, roleColumnPresent: false });
    expect(String(written[0][0])).not.toContain(ROLE_COLUMN);
  });

  it('passes a failure that is not the missing column straight through', async () => {
    const store: AdminStore = { query: () => Promise.reject(new Error('connection terminated')) };
    await expect(readRoster(store)).rejects.toThrow('connection terminated');
  });
});

describe('reading a stored role back', () => {
  it('keeps a consumer row a consumer', async () => {
    // The row a super admin creates for somebody they have listed without promoting.
    // Read back as an admin, it would hand out the role the row exists to withhold.
    const store: AdminStore = {
      query: () =>
        Promise.resolve({
          rows: [{ email: ANALYST, role: 'consumer', added_by: LEAD, added_at: '2026-08-17T00:00:00.000Z' }],
        }),
    };
    expect((await readRoster(store)).rows[0].role).toBe('consumer');
  });

  it('keeps a super admin row a super admin', async () => {
    const store: AdminStore = {
      query: () =>
        Promise.resolve({
          rows: [{ email: ANALYST, role: 'super_admin', added_by: LEAD, added_at: '2026-08-17T00:00:00.000Z' }],
        }),
    };
    expect((await readRoster(store)).rows[0].role).toBe('super_admin');
  });
});

describe('an unrecognised stored role', () => {
  it('reads as admin rather than as consumer or as the highest rank', async () => {
    // A value the app does not recognise must not silently take the role away, and
    // it is not evidence of the top of the hierarchy either.
    const store: AdminStore = {
      query: () =>
        Promise.resolve({
          rows: [{ email: DEPUTY, role: 'owner', added_by: LEAD, added_at: '2026-08-17T00:00:00.000Z' }],
        }),
    };
    const roster = await readRoster(store);
    expect(roster.rows[0].role).toBe('admin');
  });
});

describe('what the audit line says', () => {
  it('names both roles, so a reader knows what changed', () => {
    const sentence = roleChangeSentence({ actor: LEAD, email: DEPUTY, from: 'consumer', to: 'admin' });
    expect(sentence).toContain(LEAD);
    expect(sentence).toContain(DEPUTY);
    expect(sentence).toContain('consumer');
    expect(sentence).toContain('admin');
  });
});

describe('everyKnownUser', () => {
  it('does not list one address twice', () => {
    const users = everyKnownUser({ seed: LEAD_SEEDED, stored: [stored(LEAD, 'admin'), stored(DEPUTY, 'admin')] });
    expect(users.map((user) => user.email)).toEqual([LEAD, DEPUTY]);
  });
});
