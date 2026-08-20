/**
 * Handing back what an earlier version of this app granted, and nothing else.
 *
 * THE GRANT HALF IS GONE, and its absence is asserted in the route tests: adding an
 * administrator runs no statement at all. What used to be tested here was a screen
 * that granted on the telemetry schema and the `system.billing` tables whenever
 * somebody was appointed, which put PERMISSION_DENIED beside the name of a
 * colleague who had in fact been appointed successfully.
 *
 * What remains is the debt. Deployments that ran the earlier version recorded
 * privileges this app added, and the tests worth having are about the two ways
 * paying that debt back can be dishonest:
 *
 *   1. Revoking something this app did not grant. There is no undo. A person can
 *      hold `SELECT` on the billing tables because a platform team granted it for
 *      an unrelated reason, and taking a role away must not take that with it.
 *   2. Treating "could not check" as "this app granted it". Unknown is not
 *      evidence, and the safe reading of no evidence is to change nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  readProvenance,
  revokeStatement,
  withdrawAccess,
  type Provenance,
  type SqlOutcome,
  type SqlRunner,
} from './admin-access';
import { ADMIN_GRANTS_TABLE } from './admin-roles-schema';

const TELEMETRY = 'example_catalog.player_insights_telemetry';
const PERSON = 'analyst@example.com';

/** Just enough Lakebase to hold provenance rows, so the tests exercise the real SQL. */
function fakeStore() {
  const rows: Record<string, string>[] = [];
  return {
    rows,
    /** One row of the record an earlier version of this app wrote. */
    recorded(object: string, privilege: string, provenance: Provenance) {
      rows.push({ email: PERSON, target: 'telemetry', object, privilege, provenance });
    },
    query(text: string, params: unknown[] = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      const values = params as string[];
      if (sql.startsWith('SELECT email, target, object, privilege, provenance')) {
        return Promise.resolve({ rows: rows.filter((row) => row.email === values[0]) as Record<string, unknown>[] });
      }
      if (sql.startsWith(`DELETE FROM ${ADMIN_GRANTS_TABLE}`)) {
        const [email, object, privilege] = values;
        const at = rows.findIndex(
          (row) => row.email === email && row.object === object && row.privilege === privilege
        );
        if (at >= 0) rows.splice(at, 1);
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      }
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
  };
}

function runner(behaviour: (statement: string) => SqlOutcome) {
  const seen: string[] = [];
  const run: SqlRunner = (statement) => {
    seen.push(statement);
    return Promise.resolve(behaviour(statement));
  };
  return { run, seen };
}

const succeeds = (): SqlOutcome => ({ ok: true, rows: [] });

describe('the statement', () => {
  it('revokes from, rather than to, and quotes every identifier part', () => {
    expect(revokeStatement({ kind: 'TABLE', name: 'system.billing.usage', privilege: 'SELECT' }, PERSON)).toBe(
      'REVOKE SELECT ON TABLE `system`.`billing`.`usage` FROM `analyst@example.com`;'
    );
  });

  it('names a schema as a schema, so a two-part name is not aimed at a table', () => {
    expect(revokeStatement({ kind: 'SCHEMA', name: TELEMETRY, privilege: 'SELECT' }, PERSON)).toBe(
      'REVOKE SELECT ON SCHEMA `example_catalog`.`player_insights_telemetry` FROM `analyst@example.com`;'
    );
  });
});

describe('taking back what this app granted', () => {
  it('revokes the read, and stops claiming it afterwards', async () => {
    const store = fakeStore();
    store.recorded(TELEMETRY, 'SELECT', 'app-granted');
    const revoking = runner(succeeds);

    const outcome = await withdrawAccess({ run: revoking.run, store, email: PERSON });

    expect(outcome.revoked).toBe(1);
    expect(outcome.refused).toEqual([]);
    expect(outcome.summary).toBe('Access taken back.');
    expect(revoking.seen).toEqual([revokeStatement({ kind: 'SCHEMA', name: TELEMETRY, privilege: 'SELECT' }, PERSON)]);
    // The claim goes with the privilege, so the app stops saying it granted
    // something it no longer did.
    await expect(readProvenance(store, PERSON)).resolves.toEqual([]);
  });

  /**
   * The one privilege this app leaves behind.
   *
   * `USE CATALOG` shows no data by itself: it lets somebody see INTO a catalog, and
   * without it Unity Catalog hides objects rather than refusing them. Revoking it is
   * the only revoke here that can break something nobody asked this app to touch,
   * because a data owner may have granted this person a table in the same catalog in
   * the meantime and that table would start reading as absent.
   */
  it('keeps the permission to see into a catalog, and says why', async () => {
    const store = fakeStore();
    store.recorded('example_catalog', 'USE CATALOG', 'app-granted');
    store.recorded(TELEMETRY, 'SELECT', 'app-granted');
    const revoking = runner(succeeds);

    const outcome = await withdrawAccess({ run: revoking.run, store, email: PERSON });

    expect(revoking.seen.some((statement) => statement.startsWith('REVOKE USE CATALOG'))).toBe(false);
    expect(revoking.seen.some((statement) => statement.startsWith('REVOKE SELECT'))).toBe(true);
    expect(outcome.note).toContain('see into the catalog was left in place');
    expect(outcome.note).toContain('shows no data on its own');
  });

  it('leaves a privilege the person already held, and says so', async () => {
    // The case this whole mechanism exists for. Somebody may hold SELECT on the
    // billing tables because a platform team granted it for an unrelated reason,
    // and there is no undo for taking it away.
    const store = fakeStore();
    store.recorded('system.billing.usage', 'SELECT', 'pre-existing');
    const revoking = runner(() => {
      throw new Error('nothing should have been revoked');
    });

    const outcome = await withdrawAccess({ run: revoking.run, store, email: PERSON });

    expect(revoking.seen).toHaveLength(0);
    expect(outcome.revoked).toBe(0);
    expect(outcome.summary).toBe('No read access to take away.');
    expect(outcome.note).toContain('Access this app did not grant was left in place.');
    // The row stays, because it is the record of the decision not to revoke.
    await expect(readProvenance(store, PERSON)).resolves.toHaveLength(1);
  });

  it('leaves a privilege whose provenance could not be established', async () => {
    const store = fakeStore();
    store.recorded(TELEMETRY, 'SELECT', 'unknown');
    const revoking = runner(() => {
      throw new Error('unknown provenance must never be revoked');
    });

    await withdrawAccess({ run: revoking.run, store, email: PERSON });

    expect(revoking.seen).toHaveLength(0);
  });

  it('reads a provenance it does not recognise as unknown rather than as its own', async () => {
    const store = fakeStore();
    store.recorded(TELEMETRY, 'SELECT', 'something-else' as Provenance);

    await expect(readProvenance(store, PERSON)).resolves.toEqual([
      { email: PERSON, object: TELEMETRY, privilege: 'SELECT', provenance: 'unknown' },
    ]);
  });

  it('says there is nothing to take back when this app granted nothing', async () => {
    const outcome = await withdrawAccess({ run: runner(succeeds).run, store: fakeStore(), email: PERSON });

    expect(outcome.summary).toBe('No access to take away. This app granted none.');
    expect(outcome.note).toBe('');
  });

  it('keeps the claim when a revoke is refused, and offers the statement', async () => {
    const store = fakeStore();
    store.recorded(TELEMETRY, 'SELECT', 'app-granted');
    const revoking = runner(() => ({ ok: false, status: 403, message: 'PERMISSION_DENIED' }));

    const outcome = await withdrawAccess({ run: revoking.run, store, email: PERSON });

    expect(outcome.revoked).toBe(0);
    expect(outcome.refused[0]).toContain('REVOKE');
    expect(outcome.summary).toContain('1 of 1 statements were refused');
    // Still claimed, because the privilege is still there.
    await expect(readProvenance(store, PERSON)).resolves.toHaveLength(1);
  });

  it('revokes nothing when there is no warehouse to revoke through', async () => {
    const store = fakeStore();
    store.recorded(TELEMETRY, 'SELECT', 'app-granted');

    const outcome = await withdrawAccess({
      run: null,
      store,
      email: PERSON,
      unavailable: 'Not checked. No warehouse.',
    });

    expect(outcome.revoked).toBe(0);
    expect(outcome.summary).toBe('Not checked. No warehouse.');
    await expect(readProvenance(store, PERSON)).resolves.toHaveLength(1);
  });

  it('revokes nothing when the record of what it granted cannot be read', async () => {
    const unreadable = {
      query(text: string) {
        if (text.includes('SELECT email, target')) return Promise.reject(new Error('Lakebase is not answering'));
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      },
    };
    const revoking = runner(() => {
      throw new Error('nothing should have been revoked');
    });

    const outcome = await withdrawAccess({ run: revoking.run, store: unreadable, email: PERSON });

    expect(outcome.revoked).toBe(0);
    expect(outcome.summary).toContain('could not be read');
    expect(revoking.seen).toHaveLength(0);
  });
});

describe('the copy', () => {
  it('uses no em dash anywhere', async () => {
    const store = fakeStore();
    store.recorded('example_catalog', 'USE CATALOG', 'app-granted');
    store.recorded(TELEMETRY, 'SELECT', 'app-granted');

    const outcome = await withdrawAccess({ run: runner(succeeds).run, store, email: PERSON });

    expect(`${outcome.summary} ${outcome.note}`).not.toContain('\u2014');
  });
});
