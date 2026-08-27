import { describe, expect, it } from 'vitest';

import { qualifyDataContractTables } from '../../shared/data-contract';
import {
  exclusionReason,
  isDataContractFallback,
  isInferencePayloadTable,
  listDeclarableTablesInSchema,
  listedTableFromBody,
  PAYLOAD_TABLE_SIGNATURE,
  tablesFromListing,
  unionTableNames,
  type ListedTable,
} from './declared-tables';

function table(over: Partial<ListedTable> & { fullName: string }): ListedTable {
  const parts = over.fullName.split('.');
  return {
    schemaName: parts[1] ?? '',
    shortName: parts[2] ?? '',
    columns: ['id'],
    ...over,
  };
}

describe('recognising an inference payload table', () => {
  it('matches the four-column signature the log uses, not a name ending in _payload', () => {
    expect(isInferencePayloadTable([...PAYLOAD_TABLE_SIGNATURE])).toBe(true);
    expect(isInferencePayloadTable(['databricks_request_id', 'request'])).toBe(false);
    expect(isInferencePayloadTable(null)).toBeNull();
  });
});

describe('what the Connections matrix may list', () => {
  it('drops payload tables and information_schema, but keeps the index backing table', () => {
    const listed = tablesFromListing([
      table({ fullName: 'cat.sch.gold_player_180d_summary' }),
      table({
        fullName: 'cat.sch.endpoint_payload',
        columns: [...PAYLOAD_TABLE_SIGNATURE],
      }),
      table({ fullName: 'cat.information_schema.columns', schemaName: 'information_schema' }),
      table({ fullName: 'cat.sch.semantic_layer_index', shortName: 'semantic_layer_index' }),
      table({ fullName: 'cat.sch.silver_purchases' }),
    ]);
    expect(listed).toEqual([
      'cat.sch.gold_player_180d_summary',
      'cat.sch.semantic_layer_index',
      'cat.sch.silver_purchases',
    ]);
  });

  it('honours a denylist glob without inventing names', () => {
    expect(
      exclusionReason(table({ fullName: 'cat.sch.raw_events', shortName: 'raw_events' }), ['raw_*'])
    ).toContain('raw_*');
  });

  it('keeps a table whose columns were not returned, rather than dropping it as unscreened', () => {
    expect(
      tablesFromListing([table({ fullName: 'cat.sch.kept', columns: null })])
    ).toEqual(['cat.sch.kept']);
  });
});

describe('the data-contract fallback', () => {
  it('is exactly the six qualified contract names, not a longer enumerated set', () => {
    const catalog = 'cat';
    const schema = 'sch';
    const contract = qualifyDataContractTables(catalog, schema);
    expect(isDataContractFallback(contract, catalog, schema)).toBe(true);
    expect(isDataContractFallback([...contract, 'cat.sch.extra'], catalog, schema)).toBe(false);
    expect(isDataContractFallback([], catalog, schema)).toBe(false);
  });

  it('unions recovered names onto the contract without inventing any', () => {
    expect(unionTableNames(['cat.sch.a'], ['cat.sch.b', 'cat.sch.a'])).toEqual(['cat.sch.a', 'cat.sch.b']);
  });
});

describe('listing as the signed-in user', () => {
  it('pages, filters, and returns the names Unity Catalog actually sent', async () => {
    const pages = [
      {
        tables: [
          { full_name: 'cat.sch.one', name: 'one', columns: [{ name: 'id' }] },
          {
            full_name: 'cat.sch.payload',
            name: 'payload',
            columns: [...PAYLOAD_TABLE_SIGNATURE].map((name) => ({ name })),
          },
        ],
        next_page_token: 'page-2',
      },
      {
        tables: [{ full_name: 'cat.sch.two', name: 'two', columns: [{ name: 'id' }] }],
      },
    ];
    const call = ((url: string) => {
      const token = new URL(url).searchParams.get('page_token');
      const body = token === 'page-2' ? pages[1] : pages[0];
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
      } as Response);
    }) as unknown as typeof fetch;

    const listed = await listDeclarableTablesInSchema({
      catalog: 'cat',
      schema: 'sch',
      host: 'https://workspace.example',
      token: 'a-token',
      fetchImpl: call,
    });
    expect(listed).toEqual(['cat.sch.one', 'cat.sch.two']);
  });

  it('returns nothing rather than throwing when the workspace refuses', async () => {
    const call = (() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response)) as unknown as typeof fetch;
    expect(
      await listDeclarableTablesInSchema({
        catalog: 'cat',
        schema: 'sch',
        host: 'https://workspace.example',
        token: 'a-token',
        fetchImpl: call,
      })
    ).toEqual([]);
  });

  it('does not invent a three-level name from a bare table name', () => {
    expect(listedTableFromBody({ name: 'gold_player_180d_summary' })).toBeNull();
  });
});
