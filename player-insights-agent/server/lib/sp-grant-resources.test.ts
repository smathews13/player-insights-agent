import { describe, expect, it } from 'vitest';
import { discoverSpGrantResources } from './sp-grant-resources';

describe('SP grant resource discovery', () => {
  it('combines configured and declared resources without exposing unrelated environment values', async () => {
    const client = {
      lakebase: {
        query: () =>
          Promise.resolve({
            rows: [
              {
                id: 'players',
                label: 'Players',
                kind: 'unity-catalog',
                value: 'main.games.players',
                note: '',
                state: 'declared',
                origin: 'app',
              },
              {
                id: 'old-space',
                label: 'Old space',
                kind: 'genie-space',
                value: '01ef0000000000000000000000000000',
                note: '',
                state: 'withdrawn',
                origin: 'app',
              },
            ],
          }),
      },
    };
    const resources = await discoverSpGrantResources(client as never, {
      DATABRICKS_SERVING_ENDPOINT_NAME: 'astrolabe-agent',
      DATABRICKS_SQL_WAREHOUSE_ID: 'abc123',
      PLAYER_INSIGHTS_CATALOG: 'main',
      PLAYER_INSIGHTS_SCHEMA: 'games',
      DATABRICKS_TOKEN: 'must-not-leak',
      CLIENT_SECRET: 'must-not-leak',
    });
    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'SERVING_ENDPOINT', id: 'astrolabe-agent', source: 'configured' }),
        expect.objectContaining({ type: 'SQL_WAREHOUSE', id: 'abc123', source: 'configured' }),
        expect.objectContaining({ type: 'CATALOG', id: 'main', source: 'configured' }),
        expect.objectContaining({ type: 'SCHEMA', id: 'main.games', source: 'configured' }),
        expect.objectContaining({ type: 'TABLE', id: 'main.games.players', source: 'declared' }),
      ])
    );
    expect(JSON.stringify(resources)).not.toMatch(/must-not-leak|token|secret/i);
    expect(resources.some((resource) => resource.id.includes('01ef'))).toBe(false);
  });

  it('deduplicates the same configured and declared object', async () => {
    const client = {
      lakebase: {
        query: () =>
          Promise.resolve({
            rows: [
              {
                id: 'warehouse-copy',
                label: 'Same warehouse',
                kind: 'sql-warehouse',
                value: 'abc123',
                state: 'declared',
                origin: 'app',
              },
            ],
          }),
      },
    };
    const resources = await discoverSpGrantResources(client as never, {
      DATABRICKS_SQL_WAREHOUSE_ID: 'abc123',
    });
    expect(resources.filter((resource) => resource.type === 'SQL_WAREHOUSE')).toHaveLength(1);
  });
});
