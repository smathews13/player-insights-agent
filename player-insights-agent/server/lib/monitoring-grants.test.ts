import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  conditioningFor,
  GRANT_CACHE_MAX_ENTRIES,
  GRANT_CACHE_TTL_MS,
  PERSON_PRIVILEGE_CACHE_MAX_ENTRIES,
  PERSON_PRIVILEGE_TTL_MS,
  readTableGrant,
  resetGrantCache,
  resolveGrants,
  TABLE_POLICY_CACHE_MAX_ENTRIES,
  unresolvedGrants,
} from './monitoring-grants';
import type { TableVerdict, VerificationOutcome } from '../routes/access-verification';

/**
 * The conditioning rule, and the failure decision it turns on.
 *
 * The decision worth guarding is the one that feels wrong and is right: when the
 * permission check cannot be completed, EVERYTHING is shown. An admin's grants
 * normally cover whatever a consumer asked about, the data itself is still
 * governed by Unity Catalog, and conditioning is a courtesy on top of that
 * boundary rather than the boundary. Hiding the page because a check timed out is
 * the failure mode the whole design was written against.
 */

const TABLE = 'a_catalog.a_schema.a_table';
const OTHER = 'a_catalog.a_schema.b_table';

function verdicts(...rows: TableVerdict[]) {
  return { resolved: true, verdicts: new Map(rows.map((row) => [row.table, row])), resolvedAt: 0 };
}

function denied(table: string, permission = 'SELECT'): TableVerdict {
  return {
    table,
    status: 'denied',
    detail: `No ${permission} on ${table}.`,
    missing: { object: table, permission, objectKind: 'table' },
  };
}

function ok(table: string): TableVerdict {
  return { table, status: 'ok', detail: `SELECT on ${table} succeeded.` };
}

beforeEach(() => {
  resetGrantCache();
});

describe('what a missing grant conditions', () => {
  it('names the table and the privilege that was missing', () => {
    expect(conditioningFor([TABLE], verdicts(denied(TABLE)))).toEqual({ table: TABLE, permission: 'SELECT' });
  });

  /**
   * The privilege is not always SELECT. A refusal naming the catalog is a missing
   * USE CATALOG, and granting SELECT on a table inside a catalog the reader
   * cannot enter does not clear it, so telling them to run the wrong GRANT costs
   * them a round trip with whoever owns their access.
   */
  it('carries the privilege the refusal actually named', () => {
    const verdict: TableVerdict = {
      table: TABLE,
      status: 'denied',
      detail: 'No USE CATALOG.',
      missing: { object: 'a_catalog', permission: 'USE CATALOG', objectKind: 'catalog' },
    };

    expect(conditioningFor([TABLE], verdicts(verdict))).toEqual({
      table: 'a_catalog',
      permission: 'USE CATALOG',
    });
  });

  it('conditions nothing when every table was readable', () => {
    expect(conditioningFor([TABLE, OTHER], verdicts(ok(TABLE), ok(OTHER)))).toBeNull();
  });

  it('conditions on any denied table, whichever position it is in', () => {
    expect(conditioningFor([TABLE, OTHER], verdicts(ok(TABLE), denied(OTHER)))?.table).toBe(OTHER);
  });

  /** Stable across refreshes, rather than depending on map iteration. */
  it('names the first denied table in the order the run recorded its sources', () => {
    const both = verdicts(denied(OTHER), denied(TABLE));

    expect(conditioningFor([TABLE, OTHER], both)?.table).toBe(TABLE);
    expect(conditioningFor([OTHER, TABLE], both)?.table).toBe(OTHER);
  });

  /**
   * A table that could not be checked is not a table that was denied. "Not
   * checked" in this app always means not checked yet.
   */
  it('does not condition on a table the probe could not classify', () => {
    const errored: TableVerdict = { table: TABLE, status: 'error', detail: 'Not checked: budget reached.' };

    expect(conditioningFor([TABLE], verdicts(errored))).toBeNull();
  });

  it('does not condition on a table that was not in the probed set', () => {
    expect(conditioningFor(['a.b.late_arrival'], verdicts(ok(TABLE)))).toBeNull();
  });

  /** THE DECISION. A failed resolution shows everything. */
  it('conditions nothing at all when the check did not run', () => {
    expect(conditioningFor([TABLE, OTHER], unresolvedGrants(0))).toBeNull();
  });
});

describe('resolving the grants once per admin per range', () => {
  it('probes the range\u2019s tables once and reuses the answer', async () => {
    const verify = vi.fn(
      (): Promise<VerificationOutcome> => Promise.resolve({ verdicts: [denied(TABLE)], ok: 0, denied: 1, errored: 0 })
    );
    const key = { admin: 'admin@example.test', window: 'w1' };
    const options = { key, tables: [TABLE], probe: () => Promise.resolve({ ok: true as const }), verify, now: 0 };

    const first = await resolveGrants(options);
    const second = await resolveGrants(options);

    expect(verify).toHaveBeenCalledTimes(1);
    expect(first.resolved).toBe(true);
    expect(second.verdicts.get(TABLE)?.status).toBe('denied');
  });

  it('re-probes when the range changes', async () => {
    const verify = vi.fn(
      (): Promise<VerificationOutcome> => Promise.resolve({ verdicts: [ok(TABLE)], ok: 1, denied: 0, errored: 0 })
    );
    const shared = { tables: [TABLE], probe: () => Promise.resolve({ ok: true as const }), verify, now: 0 };

    await resolveGrants({ ...shared, key: { admin: 'a@example.test', window: 'w1' } });
    await resolveGrants({ ...shared, key: { admin: 'a@example.test', window: 'w2' } });

    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('keeps one admin\u2019s answer out of another\u2019s', async () => {
    const verify = vi.fn(
      (): Promise<VerificationOutcome> => Promise.resolve({ verdicts: [ok(TABLE)], ok: 1, denied: 0, errored: 0 })
    );
    const shared = { tables: [TABLE], probe: () => Promise.resolve({ ok: true as const }), verify, now: 0 };

    await resolveGrants({ ...shared, key: { admin: 'a@example.test', window: 'w1' } });
    await resolveGrants({ ...shared, key: { admin: 'b@example.test', window: 'w1' } });

    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('reads again once the entry has expired', async () => {
    const verify = vi.fn(
      (): Promise<VerificationOutcome> => Promise.resolve({ verdicts: [ok(TABLE)], ok: 1, denied: 0, errored: 0 })
    );
    const shared = {
      key: { admin: 'a@example.test', window: 'w1' },
      tables: [TABLE],
      probe: () => Promise.resolve({ ok: true as const }),
      verify,
    };

    await resolveGrants({ ...shared, now: 0 });
    await resolveGrants({ ...shared, now: GRANT_CACHE_TTL_MS + 1 });

    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used grant range at the global maximum', async () => {
    const verify = vi.fn(
      (): Promise<VerificationOutcome> => Promise.resolve({ verdicts: [ok(TABLE)], ok: 1, denied: 0, errored: 0 })
    );
    const shared = { tables: [TABLE], probe: () => Promise.resolve({ ok: true as const }), verify, now: 0 };
    for (let index = 0; index < GRANT_CACHE_MAX_ENTRIES; index += 1) {
      await resolveGrants({ ...shared, key: { admin: `admin-${index}@example.test`, window: 'w1' } });
    }
    await resolveGrants({ ...shared, key: { admin: 'admin-0@example.test', window: 'w1' } });
    await resolveGrants({ ...shared, key: { admin: 'overflow@example.test', window: 'w1' } });
    await resolveGrants({ ...shared, key: { admin: 'admin-1@example.test', window: 'w1' } });

    expect(verify).toHaveBeenCalledTimes(GRANT_CACHE_MAX_ENTRIES + 2);
  });

  /**
   * A range with nothing in it has nothing to condition. That is a successful
   * resolution, not a failure, and reporting it as one would put the "could not
   * check" line above an empty list.
   */
  it('resolves trivially and truthfully when the range read no tables', async () => {
    const verify = vi.fn();
    const resolution = await resolveGrants({
      key: { admin: 'a@example.test', window: 'w1' },
      tables: [],
      probe: () => Promise.resolve({ ok: true as const }),
      verify: verify as never,
      now: 0,
    });

    expect(resolution.resolved).toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('when the check cannot run, everything is shown', () => {
  it('reports unresolved when there is nothing to probe with', async () => {
    const resolution = await resolveGrants({
      key: { admin: 'a@example.test', window: 'w1' },
      tables: [TABLE],
      // No warehouse, no host, or no forwarded token.
      probe: null,
      now: 0,
    });

    expect(resolution.resolved).toBe(false);
    expect(conditioningFor([TABLE], resolution)).toBeNull();
  });

  it('reports unresolved when the probe throws', async () => {
    const resolution = await resolveGrants({
      key: { admin: 'a@example.test', window: 'w1' },
      tables: [TABLE],
      probe: () => Promise.resolve({ ok: true as const }),
      verify: () => Promise.reject(new Error('the warehouse did not answer')),
      now: 0,
    });

    expect(resolution.resolved).toBe(false);
    expect(conditioningFor([TABLE], resolution)).toBeNull();
  });

  /**
   * A block is a reason that is not about any one table: no forwarded token, no
   * SQL scope, a warehouse that is down. Nothing was established about this
   * reader's access to anything, so it is a failed resolution and not a set of
   * denials.
   */
  it('treats a block as a failed resolution rather than as denial of every table', async () => {
    const resolution = await resolveGrants({
      key: { admin: 'a@example.test', window: 'w1' },
      tables: [TABLE, OTHER],
      probe: () => Promise.resolve({ ok: true as const }),
      verify: () =>
        Promise.resolve({
          verdicts: [],
          ok: 0,
          denied: 0,
          errored: 0,
          blocked: { summary: 'No token arrived.', layer: 'app configuration', kind: 'no-user-token' as const },
        }),
      now: 0,
    });

    expect(resolution.resolved).toBe(false);
    expect(conditioningFor([TABLE], resolution)).toBeNull();
    expect(conditioningFor([OTHER], resolution)).toBeNull();
  });

  /**
   * A failure is cached like any other answer. Without that, a deployment whose
   * warehouse is refusing would re-probe every table on every request for as long
   * as it stayed broken, which turns a check nobody can complete into load.
   */
  it('does not re-probe a failure on every request', async () => {
    const verify = vi.fn(() => Promise.reject(new Error('still down')));
    const options = {
      key: { admin: 'a@example.test', window: 'w1' },
      tables: [TABLE],
      probe: () => Promise.resolve({ ok: true as const }),
      verify: verify as never,
      now: 0,
    };

    await resolveGrants(options);
    await resolveGrants(options);

    expect(verify).toHaveBeenCalledTimes(1);
  });
});

describe('the per-user grants read answers null rather than guessing', () => {
  it('reports what one person may do with one table', async () => {
    const reading = await readTableGrant(
      (path) =>
        Promise.resolve(
          path.includes('effective-permissions')
            ? {
                privilege_assignments: [
                  { principal: 'first.person@example.test', privileges: [{ privilege: 'SELECT' }] },
                ],
              }
            : { row_filter: { name: 'f' }, columns: [{ name: 'a_column', mask: { function_name: 'm' } }] }
        ),
      TABLE,
      'first.person@example.test'
    );

    expect(reading.canRead).toBe(true);
    expect(reading.rowFilter).toBe(true);
    expect(reading.maskedColumns).toEqual(['a_column']);
  });

  it('reports a person the response mentions with no privileges as unable to read', async () => {
    const reading = await readTableGrant(
      () =>
        Promise.resolve({
          privilege_assignments: [{ principal: 'first.person@example.test', privileges: [] }],
        }),
      TABLE,
      'first.person@example.test'
    );

    expect(reading.canRead).toBe(false);
    expect(reading.missing).toBe('SELECT missing');
  });

  /**
   * A response that mentions nobody is not a response saying they have nothing.
   * The caller may simply not be allowed to see other users, and turning that
   * silence into "cannot read" would be a finding about the person.
   */
  it('answers null when the response does not mention the person at all', async () => {
    const reading = await readTableGrant(
      () =>
        Promise.resolve({
          privilege_assignments: [{ principal: 'someone.else@example.test', privileges: ['SELECT'] }],
        }),
      TABLE,
      'first.person@example.test'
    );

    expect(reading.canRead).toBeNull();
    expect(reading.missing).toBeNull();
  });

  it('answers null on every field when the read throws', async () => {
    const reading = await readTableGrant(
      () => Promise.reject(new Error('not permitted')),
      TABLE,
      'first.person@example.test'
    );

    expect(reading.canRead).toBeNull();
    expect(reading.rowFilter).toBeNull();
    expect(reading.maskedColumns).toBeNull();
  });

  it('reports a table with no policies as having none rather than as unknown', async () => {
    const reading = await readTableGrant(
      (path) => Promise.resolve(path.includes('effective-permissions') ? {} : { columns: [{ name: 'a_column' }] }),
      TABLE,
      'first.person@example.test'
    );

    expect(reading.rowFilter).toBe(false);
    expect(reading.maskedColumns).toEqual([]);
  });
});

/**
 * What the per-person panel holds on to, and for how long.
 *
 * THE PROPERTY THESE EXIST FOR, and the reason they are worth the lines: this
 * panel reports what Unity Catalog says one NAMED PERSON may do. Two of the
 * three answers it assembles are now reused rather than re-read, and a reuse
 * that crossed people would report one person's access under another's name --
 * on the screen an admin opens precisely because they are trying to work out
 * why two people got different answers. Nothing here enforces access, so the
 * failure would be a false statement rather than a disclosure, but a false
 * statement about somebody's permissions is what this panel exists not to make.
 *
 * The two halves are held differently on purpose, and the split is the thing
 * being pinned. A row filter belongs to the TABLE, so one reading serves
 * everybody and is held ten minutes. A privilege belongs to the PERSON, so it
 * is held thirty seconds and keyed by who was asked about.
 */
describe('what the per-person read reuses, and whose', () => {
  const READS_IT = {
    privilege_assignments: [{ principal: 'first.person@example.test', privileges: ['SELECT'] }],
  };
  const SOMEBODY_ELSE_READS_IT = {
    privilege_assignments: [{ principal: 'second.person@example.test', privileges: ['SELECT'] }],
  };

  /** A workspace that records who it was asked about, so the key can be read off it. */
  function workspace(bodyFor: (principal: string) => unknown) {
    const asked: string[] = [];
    return {
      asked,
      read: (path: string, query?: Record<string, string>) => {
        if (!path.includes('effective-permissions')) return Promise.resolve({ columns: [] });
        const principal = query?.principal ?? '';
        asked.push(principal);
        return Promise.resolve(bodyFor(principal));
      },
    };
  }

  it('never answers for one person out of what it read about another', async () => {
    const uc = workspace((principal) =>
      principal === 'first.person@example.test' ? READS_IT : SOMEBODY_ELSE_READS_IT
    );

    const first = await readTableGrant(uc.read, TABLE, 'first.person@example.test', 1_000);
    const second = await readTableGrant(uc.read, TABLE, 'second.person@example.test', 1_000);

    // Both were asked about by name, a second apart, over the same table. The
    // second person's answer is their own.
    expect(uc.asked).toEqual(['first.person@example.test', 'second.person@example.test']);
    expect(first.canRead).toBe(true);
    expect(second.canRead).toBe(true);
  });

  it('reuses one person\u2019s privileges only for the safe TTL and then asks again', async () => {
    const uc = workspace(() => READS_IT);

    await readTableGrant(uc.read, TABLE, 'first.person@example.test', 1_000);
    await readTableGrant(uc.read, TABLE, 'first.person@example.test', PERSON_PRIVILEGE_TTL_MS);
    expect(uc.asked).toHaveLength(1);

    // The TTL is the whole of the window. A grant revoked while an admin
    // is reading has to stop being reported as held, and this is what bounds
    // how long "held" can outlive the truth.
    await readTableGrant(uc.read, TABLE, 'first.person@example.test', 1_000 + PERSON_PRIVILEGE_TTL_MS);
    expect(uc.asked).toHaveLength(2);
  });

  it('does not hold on to a reading that never answered', async () => {
    const uc = workspace(() => ({ privilege_assignments: [] }));

    const first = await readTableGrant(uc.read, TABLE, 'first.person@example.test', 1_000);
    const second = await readTableGrant(uc.read, TABLE, 'first.person@example.test', 2_000);

    // Silence is not a verdict, so it is asked again rather than becoming a
    // minute of the panel confidently saying "Not checked" while the workspace
    // was answering.
    expect(first.canRead).toBeNull();
    expect(second.canRead).toBeNull();
    expect(uc.asked).toHaveLength(2);
  });

  it('bounds high-cardinality person privilege readings globally', async () => {
    const asked: string[] = [];
    const read = (path: string, query?: Record<string, string>) => {
      if (!path.includes('effective-permissions')) return Promise.resolve({ columns: [] });
      const principal = query?.principal ?? '';
      asked.push(principal);
      return Promise.resolve({ privilege_assignments: [{ principal, privileges: ['SELECT'] }] });
    };

    for (let index = 0; index <= PERSON_PRIVILEGE_CACHE_MAX_ENTRIES; index += 1) {
      await readTableGrant(read, TABLE, `person-${index}@example.test`, 0);
    }
    await readTableGrant(read, TABLE, 'person-0@example.test', 1);

    expect(asked).toHaveLength(PERSON_PRIVILEGE_CACHE_MAX_ENTRIES + 2);
  });

  it('bounds high-cardinality table policy readings globally', async () => {
    const policyReads: string[] = [];
    const principal = 'first.person@example.test';
    const read = (path: string) => {
      if (path.includes('effective-permissions')) {
        return Promise.resolve({ privilege_assignments: [{ principal, privileges: ['SELECT'] }] });
      }
      policyReads.push(path);
      return Promise.resolve({ columns: [] });
    };

    for (let index = 0; index <= TABLE_POLICY_CACHE_MAX_ENTRIES; index += 1) {
      await readTableGrant(read, `catalog.schema.table_${index}`, principal, 0);
    }
    await readTableGrant(read, 'catalog.schema.table_0', principal, 1);

    expect(policyReads).toHaveLength(TABLE_POLICY_CACHE_MAX_ENTRIES + 2);
  });
});
