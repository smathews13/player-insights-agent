import { describe, expect, it, vi } from 'vitest';
import { createSqlExecutor, sqlIsResultQuery, tableFromStatementPayload } from './genie-result-execute';

describe('Genie result execution', () => {
  it('only runs statements that produce a result set', () => {
    expect(sqlIsResultQuery('SELECT 1')).toBe(true);
    expect(sqlIsResultQuery('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true);
    expect(sqlIsResultQuery('INSERT INTO t VALUES (1)')).toBe(false);
  });

  it('reads columns from the statement payload, without inventing names when none arrived', () => {
    const table = tableFromStatementPayload({
      status: { state: 'SUCCEEDED' },
      manifest: { schema: { columns: [{ name: 'title' }, { name: 'active_players' }] } },
      result: { data_array: [['halo', 10], ['destiny', 20]] },
    });
    expect(table?.rowCount).toBe(2);
    expect(table?.columns.map((entry) => entry.name)).toEqual(['title', 'active_players']);
    expect(table?.columns[1]?.values).toEqual([10, 20]);
  });

  it('tags the outgoing Statement Execution body without copying benchmark SQL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: { state: 'SUCCEEDED' },
          manifest: { schema: { columns: [{ name: 'answer' }] } },
          result: { data_array: [[1]] },
        }),
        { status: 200 }
      )
    );
    const execute = createSqlExecutor({
      host: 'https://example.invalid',
      token: 'user-token',
      warehouseId: 'warehouse-id',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const sensitiveSql = 'SELECT secret_value FROM private_catalog.private_schema.private_table';
    await execute?.(sensitiveSql);

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as Record<string, unknown>;
    expect(body.query_tags).toEqual([
      { key: 'application', value: 'Astrolabe' },
      { key: 'surface', value: 'benchmark' },
      { key: 'tool', value: 'genie_result' },
      { key: 'operation', value: 'execute' },
    ]);
    expect(JSON.stringify(body.query_tags)).not.toContain('secret_value');
    expect(JSON.stringify(body.query_tags)).not.toContain('private_table');
  });
});
