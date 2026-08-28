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
  foundationEndpoint: 'databricks-claude-sonnet-4-6',
  warehouseId: 'warehouse-1',
  vectorEndpoint: '',
  vectorIndex: '',
  indexRebuildJobId: 'job-123',
  genieSpaces: [],
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
    expect(query?.statement).toContain(
      "WHEN u.billing_origin_product = 'MODEL_SERVING' AND u.usage_metadata.endpoint_name = :foundationEndpoint THEN 'foundation-model'"
    );
    expect(query?.statement).toContain(
      "WHEN u.billing_origin_product = 'SQL' AND u.usage_metadata.warehouse_id = :warehouseId THEN 'sql-warehouse'"
    );
    expect(query?.statement).toContain(
      "WHEN u.billing_origin_product = 'APPS' AND u.usage_metadata.app_name = :appName THEN 'app-compute'"
    );
    expect(query?.statement).toContain(
      "WHEN u.billing_origin_product = 'JOBS' AND u.usage_metadata.job_id = :indexRebuildJobId THEN 'index-rebuild-job'"
    );
    expect(query?.statement).not.toContain('COALESCE(p.pricing.default, 0)');
    expect(query?.statement).toContain('t.usage_unit = p.usage_unit');
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
    expect(tiles.find((tile) => tile.id === 'foundation-model')?.resourceId).toBe(IDS.foundationEndpoint);
    expect(tiles.find((tile) => tile.id === 'sql-warehouse')?.resourceId).toBe(IDS.warehouseId);
    expect(tiles.find((tile) => tile.id === 'app-compute')?.resourceId).toBe(IDS.appName);
    expect(tiles.find((tile) => tile.id === 'genie')?.resourceId).toBe('');
    expect(tiles.find((tile) => tile.id === 'vector-search')?.resourceId).toBe('');
    expect(tiles.find((tile) => tile.id === 'index-rebuild-job')?.resourceId).toBe(IDS.indexRebuildJobId);
  });

  it('does not turn a missing app-tag match into zero app-compute spend', () => {
    const app = buildTiles(IDS, []).find((tile) => tile.id === 'app-compute');
    expect(app?.amount).toBeNull();
    expect(app?.unavailable).toBe('No Apps billing rows matched this app in this range.');
    expect(app?.note).toContain('tag');
    expect(app?.note).toContain('matched by app name');
  });

  it('keeps a verified organizational tag separate from app-name billing availability', () => {
    const app = buildTiles({ ...IDS, appBillingTag: 'matched' }, []).find((tile) => tile.id === 'app-compute');
    expect(app?.amount).toBeNull();
    expect(app?.unavailable).toBe('No Apps billing rows matched this app in this range.');
    expect(app?.note).toContain('system_billing=astrolabe is on this app');
    expect(app?.unavailable).not.toContain('tag');
  });

  it('does not claim applying a missing organizational tag would create a billing join', () => {
    const app = buildTiles({ ...IDS, appBillingTag: 'missing' }, []).find((tile) => tile.id === 'app-compute');
    expect(app?.amount).toBeNull();
    expect(app?.unavailable).toBe('No Apps billing rows matched this app in this range.');
    expect(app?.remedy).toBe('');
    expect(app?.note).toContain('still matched by app name');
  });

  it('reports Genie SQL through the warehouse instead of claiming space-level spend', () => {
    const genie = buildTiles(IDS, [
      {
        component: 'genie',
        spend: 12,
        currency: 'USD',
        billedDays: 1,
        jobRuns: null,
        lastDay: RANGE.to,
      },
    ]).find((tile) => tile.id === 'genie');

    expect(genie?.amount).toBeNull();
    expect(genie?.unavailable).toBe('Genie LLM spend not attributable in this model');
    expect(genie?.remedy).toBe('Genie space identifier unavailable');
    expect(genie?.note).toContain('not the complete Genie cost');
  });

  it('emits one Genie tile per configured space and links the space id', () => {
    const tiles = buildTiles(
      {
        ...IDS,
        genieSpaces: [
          { id: 'space-data', label: 'Data Genie space' },
          { id: 'space-dictionary', label: 'Dictionary Genie space' },
        ],
      },
      []
    );
    const genie = tiles.filter((tile) => tile.id.startsWith('genie:'));
    expect(genie).toHaveLength(2);
    expect(genie.map((tile) => tile.resourceId)).toEqual(['space-data', 'space-dictionary']);
    expect(genie.every((tile) => tile.resourceKind === 'genie-space')).toBe(true);
    expect(genie.every((tile) => tile.unavailable === 'Genie LLM spend not attributable in this model')).toBe(true);
    expect(genie.every((tile) => tile.note.includes('not the complete Genie cost'))).toBe(true);
    expect(tiles.some((tile) => tile.id === 'genie')).toBe(false);
  });

  it('opens Vector Search as the index when a three-level name is known', () => {
    const tile = buildTiles({ ...IDS, vectorIndex: 'cat.schema.index', vectorEndpoint: 'vs-endpoint' }, []).find(
      (item) => item.id === 'vector-search'
    );
    expect(tile?.resourceId).toBe('cat.schema.index');
    expect(tile?.resourceKind).toBe('vector-index');
    expect(tile?.unavailable).toBe('No billing rows');
  });

  it('keeps the Vector Search index id when billing has no rows and the endpoint is unknown', () => {
    const tile = buildTiles({ ...IDS, vectorIndex: 'cat.schema.index' }, []).find(
      (item) => item.id === 'vector-search'
    );
    expect(tile?.resourceId).toBe('cat.schema.index');
    expect(tile?.resourceKind).toBe('vector-index');
    expect(tile?.unavailable).toBe('No billing rows');
  });

  it('apportions serving by recorded tokens while keeping SQL an estimate', () => {
    const tiles = buildTiles(IDS, [
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
    ]);
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

  it('counts one MODEL_SERVING endpoint once when agent and foundation names are equal', () => {
    const same = buildTiles({ ...IDS, foundationEndpoint: IDS.endpointName }, [
      {
        component: 'serving-endpoint',
        spend: 12,
        currency: 'USD',
        billedDays: 2,
        jobRuns: null,
        lastDay: RANGE.to,
      },
    ]);
    expect(same.find((tile) => tile.id === 'serving-endpoint')?.amount).toBe(12);
    const foundation = same.find((tile) => tile.id === 'foundation-model');
    expect(foundation).toMatchObject({
      amount: null,
      quality: 'unknown',
    });
    expect(foundation?.unavailable).toContain('counted once');
  });
});
