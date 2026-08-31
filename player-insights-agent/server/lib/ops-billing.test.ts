import { describe, expect, it } from 'vitest';

import {
  BILLING_TAG_KEY,
  buildCostStatement,
  buildQuestionAttribution,
  buildTiles,
  workspaceEstimateRow,
  type CostIdentifiers,
} from './ops-billing';

const IDS: CostIdentifiers = {
  appName: 'player-insights',
  endpointName: 'player-insights-agent',
  warehouseId: 'warehouse-1',
  vectorEndpoint: '',
  vectorIndex: '',
  genieSpaces: [
    { id: '', label: 'Data Genie', tool: 'data_genie', tileId: 'genie:data' },
    { id: '', label: 'Dictionary Genie', tool: 'dictionary_genie', tileId: 'genie:dictionary' },
  ],
  workspaceId: 'workspace-1',
  telemetryEnabled: false,
  appBillingTag: 'unverified',
};
const RANGE = { from: '2026-08-10', to: '2026-08-16' };

describe('billing attribution', () => {
  it('uses exact resource identity for spend and keeps the tag as separate coverage evidence', () => {
    const query = buildCostStatement(IDS, RANGE);

    expect(BILLING_TAG_KEY).toBe('system_billing');
    expect(query?.statement).toContain("u.custom_tags['system_billing'] = 'astrolabe'");
    expect(query?.statement).toContain(
      "WHEN u.billing_origin_product = 'MODEL_SERVING' AND u.usage_metadata.endpoint_name = :endpointName THEN 'serving-endpoint'"
    );
    expect(query?.statement).not.toContain(':foundationEndpoint');
    expect(query?.statement).toContain(
      "WHEN u.billing_origin_product = 'SQL' AND u.usage_metadata.warehouse_id = :warehouseId THEN 'sql-warehouse'"
    );
    expect(query?.statement).toContain(
      "WHEN u.billing_origin_product = 'APPS' AND u.usage_metadata.app_name = :appName THEN 'app-compute'"
    );
    expect(query?.statement).not.toContain('indexRebuildJobId');
    expect(query?.statement).not.toContain("billing_origin_product = 'JOBS'");
    expect(query?.statement).not.toContain('COALESCE(p.pricing.default, 0)');
    expect(query?.statement).toContain('t.usage_unit = p.usage_unit');
    expect(query?.statement.match(/u\.workspace_id = :workspaceId/g) ?? []).toHaveLength(2);
    expect(query?.parameters).toContainEqual({ name: 'workspaceId', value: IDS.workspaceId, type: 'STRING' });
  });

  it('refuses to scan account-wide billing when the workspace id is unavailable', () => {
    expect(buildCostStatement({ ...IDS, workspaceId: '' }, RANGE)).toBeNull();
  });

  it('deduplicates tag and metadata overlap by billing record id before summing', () => {
    const statement = buildCostStatement(IDS, RANGE)!.statement;
    const spendInput = statement.slice(statement.indexOf('WITH tagged AS ('), statement.indexOf('price_hits AS ('));
    expect(spendInput).toContain("u.custom_tags['system_billing'] = 'astrolabe'");
    expect(spendInput).toContain('OR (u.billing_origin_product');
    expect(statement).toContain('COALESCE(\n      CAST(u.record_id AS STRING)');
    expect(statement).toContain('GROUP BY record_id, usage_date');
    expect(spendInput).not.toContain('UNION');
  });

  it('bounds the billing scan to the complete days the page requested', () => {
    const query = buildCostStatement(IDS, RANGE);
    expect(query?.statement).toContain('u.usage_date >= :from_day');
    expect(query?.statement).toContain('u.usage_date <= :to_day');
    expect(query?.parameters).toEqual(
      expect.arrayContaining([
        { name: 'from_day', value: RANGE.from, type: 'DATE' },
        { name: 'to_day', value: RANGE.to, type: 'DATE' },
      ])
    );
  });

  it('does not call an endpoint range total per-token before apportioning it', () => {
    const endpoint = buildTiles(IDS, [
      {
        component: 'serving-endpoint',
        spend: 12,
        currency: 'USD',
        billedDays: 2,
        jobRuns: null,
        lastDay: RANGE.to,
      },
    ]).find((tile) => tile.id === 'serving-endpoint');
    expect(endpoint?.quality).toBe('real');
  });

  it('puts the configured identifier on each tile that has one', () => {
    const tiles = buildTiles(IDS, []);
    expect(tiles.find((tile) => tile.id === 'serving-endpoint')?.resourceId).toBe(IDS.endpointName);
    expect(tiles.find((tile) => tile.id === 'sql-warehouse')?.resourceId).toBe(IDS.warehouseId);
    expect(tiles.find((tile) => tile.id === 'app-compute')?.resourceId).toBe(IDS.appName);
    expect(tiles.find((tile) => tile.id === 'genie:data')?.resourceId).toBe('');
    expect(tiles.find((tile) => tile.id === 'genie:dictionary')?.resourceId).toBe('');
    expect(tiles.find((tile) => tile.id === 'vector-search')?.resourceId).toBe('');
    expect(tiles.some((tile) => tile.id === 'index-rebuild-job')).toBe(false);
  });

  it('does not turn a missing app-tag match into zero app-compute spend', () => {
    const app = buildTiles(IDS, []).find((tile) => tile.id === 'app-compute');
    expect(app?.amount).toBeNull();
    expect(app?.unavailable).toBe('No Apps billing rows matched this app.');
    expect(app?.note).toContain('tag');
    expect(app?.note).toContain('matched by app name');
  });

  it('keeps a verified organizational tag separate from app-name billing availability', () => {
    const app = buildTiles({ ...IDS, appBillingTag: 'matched' }, []).find((tile) => tile.id === 'app-compute');
    expect(app?.amount).toBeNull();
    expect(app?.unavailable).toBe('No Apps billing rows matched this app.');
    expect(app?.note).toContain('system_billing=astrolabe is on this app');
    expect(app?.unavailable).not.toContain('tag');
  });

  it('does not claim applying a missing organizational tag would create a billing join', () => {
    const app = buildTiles({ ...IDS, appBillingTag: 'missing' }, []).find((tile) => tile.id === 'app-compute');
    expect(app?.amount).toBeNull();
    expect(app?.unavailable).toBe('No Apps billing rows matched this app.');
    expect(app?.remedy).toBe('');
    expect(app?.note).toContain('still matched by app name');
  });

  it('reports both configured Genie roles even before their identifiers are available', () => {
    const genie = buildTiles(IDS, [
      {
        component: 'genie',
        spend: 12,
        currency: 'USD',
        billedDays: 1,
        jobRuns: null,
        lastDay: RANGE.to,
      },
    ]).filter((tile) => tile.id.startsWith('genie:'));

    expect(genie).toHaveLength(2);
    expect(genie.map((tile) => tile.label)).toEqual(['Data Genie', 'Dictionary Genie']);
    expect(genie.every((tile) => tile.amount === null)).toBe(true);
    expect(genie.every((tile) => tile.unavailable.startsWith('Resource identifier unavailable.'))).toBe(true);
    expect(genie.every((tile) => tile.unavailable.includes('billing exposes surface and channel'))).toBe(true);
  });

  it('emits one Genie tile per configured space and links the space id', () => {
    const tiles = buildTiles(
      {
        ...IDS,
        genieSpaces: [
          { id: 'space-data', label: 'Data Genie', tool: 'data_genie', tileId: 'genie:data' },
          {
            id: 'space-dictionary',
            label: 'Dictionary Genie',
            tool: 'dictionary_genie',
            tileId: 'genie:dictionary',
          },
        ],
      },
      [],
      undefined,
      [
        { tileId: 'genie:data', calls: 3, observedCalls: 4 },
        { tileId: 'genie:dictionary', calls: 2, observedCalls: 2 },
      ]
    );
    const genie = tiles.filter((tile) => tile.id.startsWith('genie:'));
    expect(genie).toHaveLength(2);
    expect(genie.map((tile) => tile.resourceId)).toEqual(['space-data', 'space-dictionary']);
    expect(genie.every((tile) => tile.resourceKind === 'genie-space')).toBe(true);
    expect(genie.map((tile) => tile.id)).toEqual(['genie:data', 'genie:dictionary']);
    expect(genie.every((tile) => tile.unavailable.includes('billing exposes surface and channel'))).toBe(true);
    expect(genie.map((tile) => tile.evidence?.activity?.calls)).toEqual([3, 2]);
    expect(tiles.some((tile) => tile.id === 'genie')).toBe(false);
  });

  it('separates generated SQL cost by Genie space without double-counting the SQL warehouse share', () => {
    const tiles = buildTiles(
      {
        ...IDS,
        genieSpaces: [
          { id: 'space-data', label: 'Data Genie', tool: 'data_genie', tileId: 'genie:data' },
          {
            id: 'space-dictionary',
            label: 'Dictionary Genie',
            tool: 'dictionary_genie',
            tileId: 'genie:dictionary',
          },
        ],
      },
      [
        {
          component: 'sql-warehouse',
          spend: 100,
          currency: 'USD',
          billedDays: 2,
          jobRuns: null,
          lastDay: RANGE.to,
          pricedRows: 4,
          unpricedRows: 0,
          priceMatchStatus: 'priced',
        },
      ],
      {
        complete: true,
        astrolabeQueries: 1,
        totalQueries: 4,
        astrolabeExecutionMs: 20,
        totalExecutionMs: 100,
        genieSpaces: [
          { spaceId: 'space-data', queries: 2, executionMs: 30 },
          { spaceId: 'space-dictionary', queries: 1, executionMs: 10 },
        ],
      }
    );

    expect(tiles.find((tile) => tile.id === 'sql-warehouse')?.amount).toBe(20);
    expect(tiles.find((tile) => tile.id === 'genie:data')).toMatchObject({
      amount: 30,
      quality: 'estimate',
      population: 'Generated SQL share',
      attribution: 'deployment',
      evidence: { billingRows: 4, queryHistoryComplete: true },
    });
    expect(tiles.find((tile) => tile.id === 'genie:dictionary')?.amount).toBe(10);
    const allocatedSql = tiles
      .filter((tile) => tile.id === 'sql-warehouse' || tile.id.startsWith('genie:'))
      .reduce((sum, tile) => sum + (tile.amount ?? 0), 0);
    expect(allocatedSql).toBe(60);
    expect(allocatedSql).toBeLessThanOrEqual(100);
  });

  it('does not repeat generated SQL cost when both Genie roles use one space', () => {
    const tiles = buildTiles(
      {
        ...IDS,
        genieSpaces: [
          { id: 'shared-space', label: 'Data Genie', tool: 'data_genie', tileId: 'genie:data' },
          {
            id: 'shared-space',
            label: 'Dictionary Genie',
            tool: 'dictionary_genie',
            tileId: 'genie:dictionary',
          },
        ],
      },
      [
        {
          component: 'sql-warehouse',
          spend: 100,
          currency: 'USD',
          billedDays: 2,
          jobRuns: null,
          lastDay: RANGE.to,
          pricedRows: 4,
          unpricedRows: 0,
          priceMatchStatus: 'priced',
        },
      ],
      {
        complete: true,
        astrolabeQueries: 1,
        totalQueries: 2,
        astrolabeExecutionMs: 20,
        totalExecutionMs: 100,
        genieSpaces: [{ spaceId: 'shared-space', queries: 1, executionMs: 30 }],
      }
    );

    expect(tiles.find((tile) => tile.id === 'genie:data')?.amount).toBe(30);
    expect(tiles.find((tile) => tile.id === 'genie:dictionary')).toMatchObject({
      amount: null,
      attribution: 'unavailable',
      quality: 'unknown',
    });
    expect(tiles.find((tile) => tile.id === 'genie:dictionary')?.unavailable).toContain(
      'already represented by Data Genie'
    );
  });

  it('opens Vector Search as the index when a three-level name is known', () => {
    const tile = buildTiles({ ...IDS, vectorIndex: 'cat.schema.index', vectorEndpoint: 'vs-endpoint' }, []).find(
      (item) => item.id === 'vector-search'
    );
    expect(tile?.resourceId).toBe('cat.schema.index');
    expect(tile?.secondaryResourceId).toBe('vs-endpoint');
    expect(tile?.resourceKind).toBe('vector-index');
    expect(tile?.unavailable).toBe('No billing rows');
  });

  it('attributes measured Vector Search dollars and DBUs only after index-to-endpoint recovery', () => {
    const ids = { ...IDS, vectorIndex: 'cat.schema.index', vectorEndpoint: 'vs-endpoint' };
    const query = buildCostStatement(ids, RANGE)!;
    expect(query.parameters).toContainEqual({ name: 'vectorEndpoint', value: 'vs-endpoint', type: 'STRING' });
    expect(query.statement).toContain(
      "u.billing_origin_product = 'VECTOR_SEARCH' AND u.usage_metadata.endpoint_name = :vectorEndpoint"
    );

    const vector = buildTiles(ids, [
      {
        component: 'vector-search',
        spend: 14,
        currency: 'USD',
        billedDays: 2,
        jobRuns: null,
        lastDay: RANGE.to,
        usageUnitCount: 1,
        dbuQuantity: 6,
      },
    ]).find((item) => item.id === 'vector-search');
    expect(vector).toMatchObject({ amount: 7, dbus: 3, basis: 'per-day', attribution: 'deployment' });
  });

  it('does not combine mixed usage units into a DBU figure', () => {
    const vector = buildTiles({ ...IDS, vectorIndex: 'cat.schema.index', vectorEndpoint: 'vs-endpoint' }, [
      {
        component: 'vector-search',
        spend: 14,
        currency: 'USD',
        billedDays: 2,
        jobRuns: null,
        lastDay: RANGE.to,
        usageUnitCount: 2,
        dbuQuantity: 6,
      },
    ]).find((item) => item.id === 'vector-search');
    expect(vector?.dbus).toBeNull();
  });

  it('keeps the Vector Search index id when billing has no rows and the endpoint is unknown', () => {
    const tile = buildTiles({ ...IDS, vectorIndex: 'cat.schema.index' }, []).find(
      (item) => item.id === 'vector-search'
    );
    expect(tile?.resourceId).toBe('cat.schema.index');
    expect(tile?.resourceKind).toBe('vector-index');
    expect(tile?.unavailable).toBe('Vector Search dollars unavailable');
  });

  it('apportions serving by recorded tokens while keeping SQL an estimate', () => {
    const tiles = buildTiles(
      IDS,
      [
        {
          component: 'serving-endpoint',
          spend: 12,
          currency: 'USD',
          billedDays: 2,
          jobRuns: null,
          lastDay: RANGE.to,
        },
        {
          component: 'sql-warehouse',
          spend: 9,
          currency: 'USD',
          billedDays: 2,
          jobRuns: null,
          lastDay: RANGE.to,
        },
      ],
      {
        complete: true,
        astrolabeQueries: 2,
        totalQueries: 4,
        astrolabeExecutionMs: 100,
        totalExecutionMs: 100,
        genieSpaces: [],
      }
    );
    const attribution = buildQuestionAttribution(
      [
        {
          runId: 'run-1',
          correlationId: 'req-1',
          traceId: 'trace-1',
          completedAt: '2026-08-16T10:00:00Z',
          totalTokens: 250,
          runsInRange: 2,
          tokenCoveredRuns: 2,
          totalRecordedTokens: 1000,
        },
      ],
      tiles,
      100
    );
    const parts = attribution.runs[0].parts;
    expect(parts.find((part) => part.id === 'serving-endpoint')).toEqual(
      expect.objectContaining({ quality: 'per-token', amount: 3 })
    );
    expect(parts.find((part) => part.id === 'sql-warehouse')).toEqual(
      expect.objectContaining({ quality: 'estimate', amount: 4.5 })
    );
    expect(parts.find((part) => part.id === 'genie')).toEqual(
      expect.objectContaining({ quality: 'unknown', amount: null })
    );
  });

  it('estimates SQL from Astrolabe execution-time share rather than whole-warehouse spend', () => {
    const sql = buildTiles(
      IDS,
      [
        {
          component: 'sql-warehouse',
          spend: 100,
          currency: 'USD',
          billedDays: 2,
          jobRuns: null,
          lastDay: RANGE.to,
          pricedRows: 4,
          unpricedRows: 0,
          priceMatchStatus: 'priced',
        },
      ],
      {
        complete: true,
        astrolabeQueries: 2,
        totalQueries: 10,
        astrolabeExecutionMs: 25,
        totalExecutionMs: 100,
        genieSpaces: [],
      }
    ).find((tile) => tile.id === 'sql-warehouse');

    expect(sql).toMatchObject({
      amount: 25,
      quality: 'estimate',
      population: 'Astrolabe query share',
      attribution: 'deployment',
      evidence: {
        billingRows: 4,
        astrolabeQueries: 2,
        warehouseQueries: 10,
        queryHistoryComplete: true,
      },
    });
  });

  it('withholds SQL dollars on an incomplete denominator while retaining query and billing counts', () => {
    const sql = buildTiles(
      IDS,
      [
        {
          component: 'sql-warehouse',
          spend: 100,
          currency: 'USD',
          billedDays: 2,
          jobRuns: null,
          lastDay: RANGE.to,
          pricedRows: 4,
          unpricedRows: 0,
          priceMatchStatus: 'priced',
        },
      ],
      {
        complete: false,
        astrolabeQueries: 2,
        totalQueries: 9,
        astrolabeExecutionMs: 25,
        totalExecutionMs: 75,
        genieSpaces: [],
        coverage: {
          state: 'partial',
          requestedRange: { from: '1970-01-01T00:00:00.000Z', to: '2026-08-17T23:59:59.999Z' },
          queriedRange: { from: '2025-08-17T00:00:00.000Z', to: '2026-08-17T23:59:59.999Z' },
          rowsRead: 9,
          pagesRead: 2,
          chunksRead: 1,
          reasons: ['range-clamped', 'page-cap'],
        },
      }
    ).find((tile) => tile.id === 'sql-warehouse');

    expect(sql).toMatchObject({
      amount: null,
      unavailable: 'Incomplete Query History',
      evidence: {
        billingRows: 4,
        astrolabeQueries: 2,
        warehouseQueries: 9,
        queryHistoryComplete: false,
        queryHistoryCoverage: {
          state: 'partial',
          rowsRead: 9,
          pagesRead: 2,
          reasons: ['range-clamped', 'page-cap'],
        },
      },
    });
    expect(sql?.amount).not.toBe(100);
  });

  it('does not substitute a workspace-wide total when an endpoint identifier is absent', () => {
    const tiles = buildTiles({ ...IDS, endpointName: '' }, [
      {
        component: workspaceEstimateRow('serving-endpoint'),
        spend: 12,
        currency: 'USD',
        billedDays: 2,
        jobRuns: null,
        lastDay: RANGE.to,
      },
    ]);
    const serving = tiles.find((tile) => tile.id === 'serving-endpoint');
    expect(serving?.amount).toBeNull();
    expect(serving?.attribution).toBe('unavailable');
  });

  it('excludes unrelated shared model-serving activity from the serving tile query', () => {
    const statement = buildCostStatement(IDS, RANGE)!.statement;
    expect(statement).toContain('u.usage_metadata.endpoint_name = :endpointName');
    expect(statement).toContain('u.workspace_id = :workspaceId');
    expect(statement).not.toContain(':foundationEndpoint');
    expect(statement).not.toContain('foundation-model');
  });
});
