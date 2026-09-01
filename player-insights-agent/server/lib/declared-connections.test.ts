/**
 * Adding and removing an asset the agent may consider.
 *
 * Every identifier is invented. A customer's catalogs, schemas, warehouse ids and
 * people do not belong in a tracked file.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  addFault,
  addedConnectionEffect,
  forgetDeclaredConnection,
  readDeclaredConnections,
  removalImpact,
  restoreDeclaredConnection,
  withdrawDeclaredConnection,
  writeDeclaredConnection,
  type StoredDeclaredConnection,
} from './declared-connections';
import type { LakebaseReader } from './lakebase-store';

function client(rows: Array<Record<string, unknown>>, capture?: unknown[][]): LakebaseReader {
  return {
    lakebase: {
      query: (_sql: string, params?: unknown[]) => {
        if (capture && params) capture.push(params);
        return Promise.resolve({ rows });
      },
    },
  } as unknown as LakebaseReader;
}

const ROW = {
  id: 'roster-table',
  label: 'Title roster',
  kind: 'unity-catalog',
  value: 'gamesight_share_prod.analytics.title_roster',
  note: '',
  state: 'declared',
  origin: 'app',
  created_at: new Date('2026-08-17T18:00:00.000Z'),
  created_by: 'analyst@example.invalid',
  changed_at: new Date('2026-08-17T18:00:00.000Z'),
  changed_by: 'analyst@example.invalid',
};

function stored(overrides: Partial<StoredDeclaredConnection> = {}): StoredDeclaredConnection {
  return {
    id: 'roster-table',
    label: 'Title roster',
    kind: 'unity-catalog',
    value: 'gamesight_share_prod.analytics.title_roster',
    note: '',
    state: 'declared',
    origin: 'app',
    createdAt: '2026-08-17T18:00:00.000Z',
    createdBy: 'analyst@example.invalid',
    changedAt: '2026-08-17T18:00:00.000Z',
    changedBy: 'analyst@example.invalid',
    ...overrides,
  };
}

describe('what adding a connection is allowed to be', () => {
  it('accepts a plain named asset', () => {
    expect(addFault({ id: 'roster-table', kind: 'unity-catalog', value: 'a.b.c' })).toBeNull();
  });

  /**
   * The registry ids are the deployment's own wiring. Two rows claiming
   * `sql-warehouse`, one resolved from the artifact and one from this table, is a
   * page that contradicts itself.
   */
  it('refuses a name the deployment already uses for one of its own settings', () => {
    expect(addFault({ id: 'sql-warehouse', kind: 'sql-warehouse', value: 'wh-1' })).toMatch(/already the name/);
  });

  it('refuses a kind that describes the app rather than a customer asset', () => {
    expect(addFault({ id: 'rail', kind: 'app-behaviour', value: 'on' })).toMatch(/not a kind/);
  });

  it('refuses a name that would not be safe in a URL', () => {
    for (const id of ['Has Capitals', 'has/slash', 'a', '-leading', 'has space']) {
      expect.soft(addFault({ id, kind: 'volume', value: '/Volumes/catalog/schema/volume' }), id).not.toBeNull();
    }
  });

  it('refuses an asset with no identifier', () => {
    expect(addFault({ id: 'empty', kind: 'volume', value: '   ' })).toMatch(/needs an identifier/);
  });

  /**
   * The load-bearing sentence of the feature. A customer reads "added a
   * connection" as "granted access", and this is the text that stops them.
   */
  it('says that adding grants nobody anything', () => {
    const effect = addedConnectionEffect();
    expect(effect).toMatch(/grants nobody access/i);
    expect(effect).toMatch(/Unity Catalog/);
    expect(effect).not.toMatch(/—/);
  });
});

describe('reading and writing declarations', () => {
  it('reads a row back as a declaration', async () => {
    const [entry] = await readDeclaredConnections(client([ROW]));
    expect(entry).toMatchObject({ id: 'roster-table', state: 'declared', origin: 'app' });
    expect(entry.createdAt).toBe('2026-08-17T18:00:00.000Z');
  });

  it('reads an unrecognised kind as a catalog asset rather than passing it through', async () => {
    const [entry] = await readDeclaredConnections(client([{ ...ROW, kind: 'something-retired' }]));
    expect(entry.kind).toBe('unity-catalog');
  });

  it('reads an unrecognised state as withdrawn only when it says so', async () => {
    const [declared] = await readDeclaredConnections(client([{ ...ROW, state: 'nonsense' }]));
    expect(declared.state).toBe('declared');
    const [withdrawn] = await readDeclaredConnections(client([{ ...ROW, state: 'withdrawn' }]));
    expect(withdrawn.state).toBe('withdrawn');
  });

  /**
   * The same degradation `readStoredSettings` chose, for the same reason: this is
   * the page somebody opens to find out why the app is misbehaving.
   */
  it('answers with nothing rather than throwing when the store is down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = {
      lakebase: { query: () => Promise.reject(new Error('relation does not exist')) },
    } as unknown as LakebaseReader;
    await expect(readDeclaredConnections(broken)).resolves.toEqual([]);
    warn.mockRestore();
  });

  it('passes the publisher through as the origin', async () => {
    const params: unknown[][] = [];
    await writeDeclaredConnection(client([{ ...ROW, origin: 'notebook' }], params), {
      id: 'roster-table',
      label: 'Title roster',
      kind: 'unity-catalog',
      value: 'gamesight_share_prod.analytics.title_roster',
      note: '',
      origin: 'notebook',
      changedBy: 'analyst@example.invalid',
    });
    expect(params[0]).toContain('notebook');
  });

  it('reports nothing withdrawn when there was nothing to withdraw', async () => {
    await expect(withdrawDeclaredConnection(client([]), 'absent', 'a@example.invalid')).resolves.toBeNull();
  });

  it('puts a withdrawn declaration back', async () => {
    const restored = await restoreDeclaredConnection(
      client([{ ...ROW, state: 'declared' }]),
      'roster-table',
      'analyst@example.invalid'
    );
    expect(restored?.state).toBe('declared');
  });

  it('forgets every logical duplicate only when the store deleted rows', async () => {
    const params: unknown[][] = [];
    await expect(
      forgetDeclaredConnection(client([{ id: 'roster-table' }, { id: 'roster-table-2' }], params), 'roster-table')
    ).resolves.toEqual(['roster-table', 'roster-table-2']);
    expect(params).toEqual([['roster-table']]);
    await expect(forgetDeclaredConnection(client([]), 'absent')).resolves.toEqual([]);
  });

  it('deletes duplicate logical records atomically with normalized keys, types and values', async () => {
    let sql = '';
    const duplicateClient = {
      lakebase: {
        query: (statement: string) => {
          sql = statement;
          return Promise.resolve({ rows: [{ id: 'one' }, { id: 'two' }] });
        },
      },
    } as unknown as LakebaseReader;
    await forgetDeclaredConnection(duplicateClient, 'one');
    expect(sql).toMatch(/WITH target[\s\S]*DELETE FROM[\s\S]*USING target/);
    expect(sql).toMatch(/lower\(btrim\(connection\.kind\)\)/);
    expect(sql).toMatch(/lower\(btrim\(coalesce\(connection\.resource_type/);
    expect(sql).toMatch(/lower\(btrim\(connection\.value\)\)/);
  });
});

describe('what removing a connection costs', () => {
  it('does not claim a first-click deletion can be restored', () => {
    expect(removalImpact(stored(), []).recoverable).toBe(false);
  });

  it('says the agent stops being offered the asset', () => {
    const impact = removalImpact(stored(), []);
    expect(impact.consequences[0]).toMatch(/stops being offered/);
  });

  /**
   * The case that would otherwise mislead. When the running model is configured
   * with the same value, withdrawing the row changes the page and not the
   * deployment, and a reader who assumed otherwise would think they had closed
   * something off.
   */
  it('says plainly when the running agent keeps using the value anyway', () => {
    const impact = removalImpact(stored(), ['gamesight_share_prod.analytics.title_roster']);
    expect(impact.headline).toMatch(/keeps using it/);
    expect(impact.consequences.join(' ')).toMatch(/not what the agent reaches/);
  });

  it('compares the live value without being fooled by case or padding', () => {
    const impact = removalImpact(stored(), ['  GAMESIGHT_SHARE_PROD.Analytics.Title_Roster  ']);
    expect(impact.headline).toMatch(/keeps using it/);
  });

  it('does not claim the agent keeps using an unrelated value', () => {
    const impact = removalImpact(stored(), ['gamesight_share_prod.analytics.other_table']);
    expect(impact.headline).not.toMatch(/keeps using it/);
  });

  it('warns that publishing again re-adds a notebook declaration', () => {
    const impact = removalImpact(stored({ origin: 'notebook' }), []);
    expect(impact.consequences.join(' ')).toMatch(/publishing again/i);
  });

  it('writes no em dash into anything a reader sees', () => {
    const impact = removalImpact(stored({ origin: 'notebook' }), ['gamesight_share_prod.analytics.title_roster']);
    for (const line of [impact.headline, ...impact.consequences]) {
      expect.soft(line, line).not.toMatch(/—/);
    }
  });
});
