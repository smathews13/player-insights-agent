import { describe, expect, it } from 'vitest';

import { appCostSummary } from '../../shared/app-cost-summary';
import {
  buildQuestionAttribution,
  buildTiles,
  type ComponentRow,
  type CostIdentifiers,
  type QuestionRunInput,
} from './ops-billing';
import { buildFoundationCostStatement, foundationCostTile, readFoundationBillingRows } from './ops-foundation-billing';
import { buildSpendByUser, type UserRunSpendEvidence } from './user-spend';

const IDS: CostIdentifiers = {
  appName: 'astrolabe',
  endpointName: 'astrolabe-agent',
  foundationModel: 'databricks-claude-sonnet',
  warehouseId: 'shared-warehouse',
  vectorEndpoint: '',
  vectorIndex: '',
  vectorEndpointIndexCount: null,
  vectorIdentityError: '',
  genieSpaces: [],
  workspaceId: 'workspace-1',
  telemetryEnabled: false,
  appBillingTag: 'matched',
};

const RANGE = { from: '2026-08-26', to: '2026-09-01' };
const FULL_SERVING = 64.214932;
const MARGINAL_SERVING = 0.203157;
const FULL_SQL = 442.11266;
const BROAD_APP_SQL = 91.155718;
const ASK_EXECUTION_MS = 29_796;
const ALL_EXECUTION_MS = 1_969_589;
const ASK_SQL = (FULL_SQL * ASK_EXECUTION_MS) / ALL_EXECUTION_MS;

function pricedRow(component: string, spend: number, dbus: number, billedSeconds = 0): ComponentRow {
  return {
    component,
    spend,
    currency: 'USD',
    currencyCount: 1,
    billedDays: 7,
    jobRuns: null,
    lastDay: RANGE.to,
    pricedQuantity: dbus,
    unpricedQuantity: 0,
    pricedRows: 1,
    unpricedRows: 0,
    unpricedSkus: [],
    priceMatchStatus: 'priced',
    correctionRows: 0,
    duplicateMatches: 0,
    priceEffectiveAt: '2026-01-01T00:00:00Z',
    usageUnitCount: 1,
    dbuQuantity: dbus,
    dbuRows: 1,
    billedSeconds,
  };
}

function runs(): QuestionRunInput[] {
  return Array.from({ length: 26 }, (_, index) => {
    const durationMs = index === 25 ? 8_157 : 7_800;
    const start =
      Date.parse(`2026-08-${String(26 + Math.floor(index / 5)).padStart(2, '0')}T00:00:00Z`) + index * 10_000;
    return {
      runId: `run-${index}`,
      requestId: `req-${index}`,
      correlationId: `corr-${index}`,
      traceId: `trace-${index}`,
      user: index % 2 ? 'b@example.test' : 'a@example.test',
      startedAt: new Date(start).toISOString(),
      completedAt: new Date(start + durationMs).toISOString(),
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      runsInRange: 26,
      tokenCoveredRuns: 26,
      totalRecordedTokens: 3_120,
      evidenceComplete: true,
    };
  });
}

function foundation() {
  const result = readFoundationBillingRows([
    [
      '4.088699',
      'USD',
      '5.840999',
      'priced',
      '5.840999',
      '0',
      '90',
      '0',
      '',
      '0',
      '0',
      '2026-01-01T00:00:00Z',
      '90',
      '0',
      '216',
      '177',
      '1288343',
      '93394',
      '1381737',
      '26',
      '26',
      '0',
      '0',
      '39',
    ],
  ]);
  return foundationCostTile(IDS, result);
}

describe('Aug 26–Sep 1 component-total and marginal Ask audit fixture', () => {
  it('shows the dedicated endpoint total while retaining its request-active share only for efficiency', () => {
    const interactive = runs();
    const tiles = buildTiles(
      IDS,
      [
        pricedRow('serving-endpoint', FULL_SERVING, 917.356171, FULL_SERVING * 1_000),
        pricedRow('sql-warehouse', FULL_SQL, 631.589514),
      ],
      {
        complete: true,
        astrolabeQueries: 26,
        totalQueries: 1_024,
        astrolabeExecutionMs: ASK_EXECUTION_MS,
        totalExecutionMs: ALL_EXECUTION_MS,
        askRuns: interactive.map((run, index) => ({
          runId: run.runId,
          executionMs: index === 25 ? 1_046 : 1_150,
        })),
        genieSpaces: [],
      },
      [],
      null,
      '',
      { interactive: { runs: interactive, complete: true }, foundation: foundation() }
    );

    expect(tiles.find((tile) => tile.id === 'serving-endpoint')).toMatchObject({
      label: 'Agent serving',
      amount: FULL_SERVING,
      marginalAmount: MARGINAL_SERVING,
      population: 'Configured endpoint',
      basis: 'total-in-range',
    });
    expect(tiles.find((tile) => tile.id === 'foundation-model')).toMatchObject({
      label: 'Foundation model tokens',
      amount: 4.088699,
      quality: 'per-token',
      attribution: 'deployment',
      evidence: {
        coverageComplete: true,
        excludedRequests: 39,
        ambiguousRequests: 0,
      },
    });
    expect(tiles.find((tile) => tile.id === 'sql-warehouse')?.amount).toBeCloseTo(ASK_SQL, 9);
    expect(ASK_SQL).toBeCloseTo(6.69, 2);
    expect(tiles.map((tile) => tile.amount)).toContain(FULL_SERVING);
    expect(tiles.map((tile) => tile.amount)).not.toContain(BROAD_APP_SQL);

    const summary = appCostSummary({ range: RANGE, tiles, currency: 'USD' });
    expect(summary.amount).toBeCloseTo(FULL_SERVING + 4.088699 + ASK_SQL, 9);
    expect(summary.amount).not.toBeCloseTo(FULL_SERVING + BROAD_APP_SQL, 2);

    const average = buildQuestionAttribution(interactive, tiles, 100, {
      complete: true,
      astrolabeQueries: 26,
      totalQueries: 1_024,
      astrolabeExecutionMs: ASK_EXECUTION_MS,
      totalExecutionMs: ALL_EXECUTION_MS,
      askRuns: interactive.map((run, index) => ({
        runId: run.runId,
        executionMs: index === 25 ? 1_046 : 1_150,
      })),
      genieSpaces: [],
    });
    expect(average.complete).toBe(true);
    expect(average.requestCoveredRuns).toBe(26);
    expect(average.traceCoveredRuns).toBe(26);
    expect(average.timingCoveredRuns).toBe(26);
  });

  it('keeps partial foundation prices unavailable and proves a priced zero', () => {
    const partial = readFoundationBillingRows([
      [null, '', null, 'partial', '2', '1', '1', '1', 'NEW_SKU', '0', '0', '', '2', '1', '2', '1', '10', '5', '15'],
    ]);
    expect(foundationCostTile(IDS, partial)).toMatchObject({ amount: null, attribution: 'unavailable' });

    const zero = readFoundationBillingRows([
      ['0', 'USD', '0', 'priced', '1', '0', '1', '0', '', '0', '0', '', '1', '0', '3', '0', '0', '0', '0'],
    ]);
    expect(foundationCostTile(IDS, zero)).toMatchObject({ amount: 0, dbus: 0, attribution: 'deployment' });
  });

  it('distinguishes unavailable token evidence from a provider-reported zero', () => {
    const unavailable = readFoundationBillingRows([
      ['1', 'USD', '1', 'priced', '1', '0', '1', '0', '', '0', '0', '', '1', '0', '1', '0', null, null, null, '1', '0'],
    ]);
    expect(foundationCostTile(IDS, unavailable).evidence?.tokens?.total).toBeNull();

    const zero = readFoundationBillingRows([
      ['0', 'USD', '0', 'priced', '1', '0', '1', '0', '', '0', '0', '', '1', '0', '1', '1', '0', '0', '0', '1', '1'],
    ]);
    expect(foundationCostTile(IDS, zero).evidence?.tokens?.total).toBe(0);
  });

  it('shows a measured lower bound when an eligible Ask lacks model evidence', () => {
    const partialCoverage = readFoundationBillingRows([
      [
        '3.25',
        'USD',
        '4.5',
        'priced',
        '4.5',
        '0',
        '2',
        '0',
        '',
        '0',
        '0',
        '2026-01-01T00:00:00Z',
        '3',
        '1',
        '42',
        '40',
        '1000',
        '200',
        '1200',
        '26',
        '25',
        '1',
        '1',
        '1',
      ],
    ]);
    expect(foundationCostTile(IDS, partialCoverage)).toMatchObject({
      amount: 3.25,
      dbus: 4.5,
      quality: 'estimate',
      attribution: 'deployment',
      unavailable: '',
      note: 'Measured lower bound; 1 eligible Ask missing model evidence',
      evidence: {
        coverageComplete: false,
        missingEligibleRequests: 1,
        ambiguousRequests: 1,
        excludedRequests: 1,
      },
    });
  });

  it('reconciles marginal serving, token, and Ask SQL to users exactly once', () => {
    const interactive = runs();
    const tiles = buildTiles(
      IDS,
      [
        pricedRow('serving-endpoint', FULL_SERVING, 917.356171, FULL_SERVING * 1_000),
        pricedRow('sql-warehouse', FULL_SQL, 631.589514),
      ],
      {
        complete: true,
        astrolabeQueries: 26,
        totalQueries: 1_024,
        astrolabeExecutionMs: ASK_EXECUTION_MS,
        totalExecutionMs: ALL_EXECUTION_MS,
        askRuns: [],
        genieSpaces: [],
      },
      [],
      null,
      '',
      { interactive: { runs: interactive, complete: true }, foundation: foundation() }
    );
    const userRuns: UserRunSpendEvidence[] = ['a@example.test', 'b@example.test'].map((email) => ({
      email,
      totalRuns: 13,
      tokenCoveredRuns: 13,
      totalTokens: 1_560,
      totalDurationMs: interactive
        .filter((run) => run.user === email)
        .reduce((sum, run) => sum + (Date.parse(run.completedAt) - Date.parse(run.startedAt ?? '')), 0),
      resources: [],
    }));
    const spend = buildSpendByUser({
      readAt: '2026-09-02T00:00:00Z',
      requestedRange: RANGE,
      range: RANGE,
      tiles,
      queryComplete: true,
      queryUsers: [
        { email: 'a@example.test', astrolabeExecutionMs: ASK_EXECUTION_MS / 2, genieSpaces: [] },
        { email: 'b@example.test', astrolabeExecutionMs: ASK_EXECUTION_MS / 2, genieSpaces: [] },
      ],
      runs: userRuns,
      activity: { available: false, recordedFrom: '', recordedThrough: '', users: [] },
    });
    expect(spend.reconciliation.usd.difference).toBe(0);
    expect(spend.reconciliation.usd.users).toBeCloseTo(spend.reconciliation.usd.appTotal ?? 0, 6);
    expect(
      spend.users.flatMap((user) => user.components).filter((part) => part.id === 'foundation-model')
    ).toHaveLength(2);
  });
});

describe('foundation billing query contract', () => {
  it('uses priced model/time/request evidence without a guessed token price or endpoint overlap', () => {
    const built = buildFoundationCostStatement(IDS, RANGE, runs());
    expect(built?.statement).toContain('system.serving.endpoint_usage');
    expect(built?.statement).toContain('system.billing.list_prices');
    expect(built?.statement).toContain("request.request_class IN ('ask-exact', 'ask-bounded')");
    expect(built?.statement).toContain("'known-excluded'");
    expect(built?.statement).toContain("'ambiguous'");
    expect(built?.statement).toContain('ask_weight / NULLIF(all_weight, 0)');
    expect(built?.statement).not.toContain('COALESCE(all_weight, 0) = 0) > 0');
    expect(built?.statement).toContain("LIKE '%OUTPUT%'");
    expect(built?.statement).toContain("LIKE '%INPUT%'");
    expect(built?.statement).toContain("LIKE '%CACHE%' THEN request.input_tokens");
    expect(built?.statement).not.toContain("LIKE '%CACHE%READ%' THEN 0");
    expect(built?.statement).toContain("record_type ILIKE '%CORRECT%'");
    expect(built?.statement).toContain("REGEXP_REPLACE(LOWER(e.endpoint_name), '[^a-z0-9]', '')");
    expect(built?.statement).toContain('GROUP BY record_id');
    expect(built?.statement).toContain('MAX(usage_quantity) AS usage_quantity');
    expect(built?.statement).toContain('u.usage_metadata.endpoint_name <> :agentEndpoint');
    expect(built?.statement).not.toMatch(/input_tokens\s*\+\s*[2-9]\s*\*/);
    expect(built?.parameters.find((parameter) => parameter.name === 'interactive_runs_json')?.value).not.toContain(
      '@example.test'
    );
  });

  it('clips nested model requests and billing rows at the exact first deployment instant', () => {
    const built = buildFoundationCostStatement(IDS, { ...RANGE, fromTimestamp: '2026-08-26T18:42:11.000Z' }, runs());
    expect(built?.statement).toContain('u.request_time >= :from_instant');
    expect(built?.statement).toContain('u.usage_start_time >= :from_instant');
    expect(built?.parameters).toContainEqual({
      name: 'from_instant',
      value: '2026-08-26T18:42:11.000Z',
      type: 'TIMESTAMP',
    });
  });
});
