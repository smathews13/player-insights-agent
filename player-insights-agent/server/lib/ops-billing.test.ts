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
  genieSpaces: [],
  workspaceId: 'workspace-1',
  telemetryEnabled: false,
};
const RANGE = { from: '2026-08-10', to: '2026-08-16' };

describe('billing attribution', () => {
  it('limits every cost figure to resources tagged for Astrolabe', () => {
    const query = buildCostStatement(IDS, RANGE);

    expect(BILLING_TAG_KEY).toBe('system_billing');
    expect(query?.statement).toContain("u.custom_tags['system_billing'] = 'astrolabe'");
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
    expect(tiles.find((tile) => tile.id === 'genie')?.resourceId).toBe('');
    expect(tiles.find((tile) => tile.id === 'vector-search')?.resourceId).toBe('');
    expect(tiles.some((tile) => tile.id === 'index-rebuild-job')).toBe(false);
  });

  it('does not turn a missing app-tag match into zero app-compute spend', () => {
    const app = buildTiles(IDS, []).find((tile) => tile.id === 'app-compute');
    expect(app?.amount).toBeNull();
    expect(app?.unavailable).toContain('unverified');
    expect(app?.remedy).toContain('Verify');
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
    expect(genie?.unavailable).toBe('Genie space identifier unavailable');
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
    expect(genie.every((tile) => tile.unavailable === 'Covered by SQL warehouse')).toBe(true);
    expect(tiles.some((tile) => tile.id === 'genie')).toBe(false);
  });

  it('opens Vector Search as the index when a three-level name is known', () => {
    const tile = buildTiles({ ...IDS, vectorIndex: 'cat.schema.index', vectorEndpoint: 'vs-endpoint' }, []).find(
      (item) => item.id === 'vector-search'
    );
    expect(tile?.resourceId).toBe('cat.schema.index');
    expect(tile?.resourceKind).toBe('vector-index');
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

  it('does not call a workspace serving total per-token after splitting it by tokens', () => {
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
    expect(serving?.quality).toBe('estimate');
    expect(serving?.population).toBe('Whole workspace');

    const attribution = buildQuestionAttribution(
      [
        {
          runId: 'run-1',
          correlationId: 'req-1',
          traceId: 'trace-1',
          completedAt: '2026-08-16T10:00:00Z',
          totalTokens: 250,
          runsInRange: 1,
          tokenCoveredRuns: 1,
          totalRecordedTokens: 250,
        },
      ],
      tiles,
      100
    );
    expect(attribution.runs[0].parts.find((part) => part.id === 'serving-endpoint')).toEqual(
      expect.objectContaining({ quality: 'estimate', amount: 12 })
    );
  });
});
