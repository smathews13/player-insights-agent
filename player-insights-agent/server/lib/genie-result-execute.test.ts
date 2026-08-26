import { describe, expect, it } from 'vitest';
import { sqlIsResultQuery, tableFromStatementPayload } from './genie-result-execute';

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
});
