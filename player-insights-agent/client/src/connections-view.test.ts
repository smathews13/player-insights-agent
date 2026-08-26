import { describe, expect, it } from 'vitest';

import {
  declaredTableFilterOptions,
  filterDeclaredTables,
  tableColumnCount,
  tableReachabilityCopy,
  unityCatalogNameParts,
} from './connections-view';
import type { PreflightCheck } from './preflight';

function check(over: Partial<PreflightCheck> = {}): PreflightCheck {
  return {
    id: 't',
    kind: 'table',
    name: 'a_catalog.a_schema.gold_title_daily_summary',
    label: 't',
    status: 'ok',
    detail: 'The workspace answered: 17 columns.',
    checked_with: '',
    duration_ms: 0,
    error: '',
    remedy: null,
    ...over,
  };
}

describe('a three-part Unity Catalog name', () => {
  it('splits catalog, schema and table', () => {
    expect(unityCatalogNameParts('<your_catalog>.<your_schema>.data_dictionary')).toEqual({
      catalog: '<your_catalog>',
      schema: '<your_schema>',
      table: 'data_dictionary',
    });
  });

  it('keeps extra dots on the table segment', () => {
    expect(unityCatalogNameParts('cat.sch.gold.extra')).toEqual({
      catalog: 'cat',
      schema: 'sch',
      table: 'gold.extra',
    });
  });
});

describe('the declared-tables search and filters', () => {
  const tables = [
    check({ id: 't1', name: '<your_catalog>.<your_schema>.data_dictionary' }),
    check({ id: 't2', name: '<your_catalog>.<your_schema>.gold_title_daily_summary' }),
    check({ id: 't3', name: 'other_catalog.other_schema.silver_player_activity' }),
  ];

  it('lists each catalog, and only the schemas inside the chosen one', () => {
    expect(declaredTableFilterOptions(tables).catalogs).toEqual(['<your_catalog>', 'other_catalog']);
    expect(declaredTableFilterOptions(tables).schemas).toEqual(['other_schema', '<your_schema>']);
    expect(declaredTableFilterOptions(tables, '<your_catalog>').schemas).toEqual(['<your_schema>']);
  });

  it('matches a typed fragment anywhere in the three-part name', () => {
    const names = (query: string) =>
      filterDeclaredTables(tables, { query, catalog: '', schema: '' }).map((row) => row.name);

    expect(names('data_dictionary')).toEqual(['<your_catalog>.<your_schema>.data_dictionary']);
    expect(names('example-demos')).toEqual([
      '<your_catalog>.<your_schema>.data_dictionary',
      '<your_catalog>.<your_schema>.gold_title_daily_summary',
    ]);
    expect(names('other_schema')).toEqual(['other_catalog.other_schema.silver_player_activity']);
  });

  it('narrows by catalog and then by schema', () => {
    const inCatalog = filterDeclaredTables(tables, {
      query: '',
      catalog: '<your_catalog>',
      schema: '',
    });
    expect(inCatalog).toHaveLength(2);
    expect(inCatalog.every((row) => row.name.startsWith('<your_catalog>.'))).toBe(true);

    const inSchema = filterDeclaredTables(tables, {
      query: '',
      catalog: '<your_catalog>',
      schema: '<your_schema>',
    });
    expect(inSchema).toHaveLength(2);

    const none = filterDeclaredTables(tables, {
      query: 'dictionary',
      catalog: 'other_catalog',
      schema: '',
    });
    expect(none).toEqual([]);
  });
});

describe('the table column count', () => {
  /**
   * THE LIVE BUG. The probe writes "answered: 17 columns" and may also mention
   * another figure. A first-number regex put 7 on the row and 17 on the hover.
   * Both surfaces read this helper, so they cannot split.
   */
  const twoCounts = check({
    detail:
      'Cached 7 columns from an earlier extract. The workspace answered as reader@example.com: 17 columns. ' +
      'That is a metadata read. It reads the table\u2019s definition, not its rows.',
  });

  it('takes the probe’s answered count, not an earlier decoy', () => {
    expect(tableColumnCount(twoCounts)).toBe(17);
    expect(tableColumnCount(check({ detail: 'The workspace answered: 1 column.' }))).toBe(1);
    expect(tableColumnCount(check({ detail: 'The workspace answered.' }))).toBeNull();
  });

  it('prints that same count on the row and on the hover', () => {
    const copy = tableReachabilityCopy(twoCounts, '2026-08-26T16:28:00.000Z');
    expect(copy.row).toMatch(/^17 columns · checked /);
    expect(copy.title).toMatch(/^Reachability confirmed\. Schema has 17 columns\./);
    expect(copy.row).not.toMatch(/(?<!\d)7 columns/);
    expect(copy.title).not.toMatch(/(?<!\d)7 columns/);
  });
});
