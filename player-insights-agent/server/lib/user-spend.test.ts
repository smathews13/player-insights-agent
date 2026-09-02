import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CostTile } from '../../shared/ops-contract';
import {
  allocateDeterministically,
  buildSpendByUser,
  buildUserMonitoringPage,
  cachedUserSpend,
  cacheUserSpend,
  capUserSpendRange,
  invalidateUserSpendCache,
  readUserInteractionEvidence,
  readUserRunSpendEvidence,
  USER_ACTIVE_MINUTES_QUERY,
  USER_MONITORING_ACTIVITY_QUERY,
  USER_SPEND_RUNS_QUERY,
  userSpendCacheKey,
  type UserRunSpendEvidence,
} from './user-spend';

const OPS_ROUTE_SOURCE = readFileSync(new URL('../routes/ops-routes.ts', import.meta.url), 'utf8');

function tile(
  id: string,
  amount: number | null,
  dbus: number | null,
  basis: CostTile['basis'] = 'total-in-range'
): CostTile {
  return {
    id,
    label: id,
    resourceId: id === 'genie:data' ? 'space-data' : id === 'genie:dictionary' ? 'space-dictionary' : id,
    secondaryResourceId: id === 'vector-search' ? 'vector-endpoint' : undefined,
    quality: amount === null ? 'unknown' : 'real',
    amount,
    dbus,
    basis,
    population: 'This app',
    attribution: amount === null && dbus === null ? 'unavailable' : 'deployment',
    unavailable: amount === null && dbus === null ? 'Missing price' : '',
    remedy: '',
    note: '',
  };
}

const runs: UserRunSpendEvidence[] = [
  {
    email: 'a@example.test',
    totalRuns: 1,
    tokenCoveredRuns: 1,
    totalTokens: 100,
    resources: [{ tool: 'search_semantics', resourceId: 'vector-search', calls: 1 }],
  },
  {
    email: 'b@example.test',
    totalRuns: 1,
    tokenCoveredRuns: 1,
    totalTokens: 300,
    resources: [{ tool: 'search_semantics', resourceId: 'vector-search', calls: 3 }],
  },
];

function build(overrides: Partial<Parameters<typeof buildSpendByUser>[0]> = {}) {
  return buildSpendByUser({
    readAt: '2026-09-01T12:00:00Z',
    requestedRange: { from: '2026-08-25', to: '2026-08-31' },
    range: { from: '2026-08-25', to: '2026-08-31' },
    tiles: [
      tile('serving-endpoint', 10, 5),
      tile('sql-warehouse', 6, 3),
      tile('genie:data', 2, 1),
      tile('genie:dictionary', 1, 0.5),
      tile('vector-search', 0.7, 0.35, 'per-day'),
      tile('app-compute', 1, 0.5, 'per-day'),
    ],
    queryComplete: true,
    queryUsers: [
      {
        email: 'a@example.test',
        astrolabeExecutionMs: 100,
        genieSpaces: [
          { spaceId: 'space-data', executionMs: 30 },
          { spaceId: 'space-dictionary', executionMs: 10 },
        ],
      },
      {
        email: 'b@example.test',
        astrolabeExecutionMs: 200,
        genieSpaces: [
          { spaceId: 'space-data', executionMs: 70 },
          { spaceId: 'space-dictionary', executionMs: 30 },
        ],
      },
    ],
    runs,
    activity: {
      available: true,
      recordedFrom: '2026-08-01T00:00:00Z',
      recordedThrough: '2026-08-31T23:59:00Z',
      users: [
        { email: 'a@example.test', activeMinutes: 10 },
        { email: 'b@example.test', activeMinutes: 30 },
      ],
    },
    ...overrides,
  });
}

describe('individual user spend attribution', () => {
  it('allocates deterministic millionth residuals and reconciles exactly', () => {
    const allocated = allocateDeterministically(
      1,
      new Map([
        ['b@example.test', 1],
        ['a@example.test', 1],
        ['c@example.test', 1],
      ])
    );

    expect([...allocated.keys()]).toEqual(['a@example.test', 'b@example.test', 'c@example.test']);
    expect([...allocated.values()].reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(allocated.get('a@example.test')).toBe(0.333334);
  });

  it('reconciles all users plus unattributed to app totals in USD and DBU', () => {
    const payload = build();

    expect(payload.reconciliation.usd.difference).toBe(0);
    expect(payload.reconciliation.dbu.difference).toBe(0);
    expect(payload.reconciliation.usd.users! + payload.reconciliation.usd.unattributed!).toBe(
      payload.reconciliation.usd.appTotal
    );
    expect(payload.users.map((user) => user.email)).toEqual(['a@example.test', 'b@example.test']);
    expect(
      payload.users[0].components
        .filter((part) => part.usd.amount !== null)
        .every((part) => part.usd.quality === 'allocated')
    ).toBe(true);
  });

  it('leaves shared app compute unattributed when active-minute coverage is incomplete', () => {
    const payload = build({
      activity: {
        available: false,
        recordedFrom: '',
        recordedThrough: '',
        users: [],
      },
    });
    const app = payload.unattributed.find((part) => part.id === 'app-compute')!;

    expect(app.usd).toEqual({ amount: 7, quality: 'unattributed' });
    expect(payload.reconciliation.usd.difference).toBe(0);
    expect(payload.users[0].components.find((part) => part.id === 'app-compute')?.usd.amount).toBeNull();
  });

  it('keeps direct and joined evidence distinct and puts the remainder in unattributed', () => {
    const payload = build({
      direct: [
        { email: 'a@example.test', componentId: 'serving-endpoint', quality: 'direct', usd: 3, dbu: 1.5 },
        { email: 'b@example.test', componentId: 'serving-endpoint', quality: 'joined', usd: 2, dbu: 1 },
      ],
    });
    const a = payload.users[0].components.find((part) => part.id === 'serving-endpoint')!;
    const b = payload.users[1].components.find((part) => part.id === 'serving-endpoint')!;
    const missing = payload.unattributed.find((part) => part.id === 'serving-endpoint')!;

    expect(a.usd).toEqual({ amount: 3, quality: 'direct' });
    expect(b.usd).toEqual({ amount: 2, quality: 'joined' });
    expect(missing.usd).toEqual({ amount: 5, quality: 'unattributed' });
    expect(payload.reconciliation.usd.difference).toBe(0);
  });

  it('keeps direct Data and Dictionary Genie amounts in separate user rows', () => {
    const payload = build({
      direct: [
        { email: 'a@example.test', componentId: 'genie:data', quality: 'direct', usd: 1.5, dbu: 0.75 },
        {
          email: 'a@example.test',
          componentId: 'genie:dictionary',
          quality: 'direct',
          usd: 0.5,
          dbu: 0.25,
        },
      ],
    });
    const components = payload.users[0].components.filter((part) => part.id.startsWith('genie:'));
    expect(components.map((part) => [part.id, part.usd.amount, part.dbu.amount])).toEqual([
      ['genie:data', 1.5, 0.75],
      ['genie:dictionary', 0.5, 0.25],
    ]);
    expect(payload.reconciliation.usd.difference).toBe(0);
  });

  it('sums the same user direct Genie evidence across calendar-month slices', () => {
    const payload = build({
      direct: [
        { email: 'a@example.test', componentId: 'genie:data', quality: 'direct', usd: 0.5, dbu: 0.4 },
        { email: 'a@example.test', componentId: 'genie:data', quality: 'direct', usd: 1.5, dbu: 0.6 },
      ],
    });
    const data = payload.users[0].components.find((part) => part.id === 'genie:data');
    expect(data?.usd).toEqual({ amount: 2, quality: 'direct' });
    expect(data?.dbu).toEqual({ amount: 1, quality: 'direct' });
    expect(payload.reconciliation.usd.difference).toBe(0);
    expect(payload.reconciliation.dbu.difference).toBe(0);
  });

  it('does not turn missing USD price coverage into zero when DBUs are measurable', () => {
    const payload = build({
      tiles: [tile('serving-endpoint', null, 4)],
    });
    const serving = payload.users[0].components.find((part) => part.id === 'serving-endpoint')!;

    expect(serving.usd).toEqual({ amount: null, quality: 'unavailable' });
    expect(serving.dbu.amount).not.toBeNull();
    expect(payload.reconciliation.usd.appTotal).toBeNull();
    expect(payload.reconciliation.dbu.difference).toBe(0);
  });

  it('deduplicates repeated aggregate rows before using them as drivers', () => {
    const row = {
      row_kind: 'resource',
      user_email: 'A@EXAMPLE.TEST',
      tool: 'search_semantics',
      resource_id: 'index',
      calls: '2',
      total_runs: '0',
      total_tokens: '0',
    };
    const evidence = readUserRunSpendEvidence([row, { ...row }]);

    expect(evidence).toEqual([
      {
        email: 'a@example.test',
        totalRuns: 0,
        tokenCoveredRuns: 0,
        totalTokens: 0,
        resources: [{ tool: 'search_semantics', resourceId: 'index', calls: 2 }],
      },
    ]);
  });

  it('caps raw user attribution to the existing 90-day telemetry retention', () => {
    const capped = capUserSpendRange({ from: '2026-01-01', to: '2026-08-31' });
    expect(capped).toEqual({ range: { from: '2026-06-03', to: '2026-08-31' }, partial: true });
  });

  it('isolates the short cache by authenticated admin and data revision', () => {
    invalidateUserSpendCache();
    const range = { from: '2026-08-25', to: '2026-08-31' };
    const firstKey = userSpendCacheKey('first-admin@example.test', range);
    const otherKey = userSpendCacheKey('other-admin@example.test', range);
    const payload = build();
    cacheUserSpend(firstKey, payload, 1_000);

    expect(cachedUserSpend(firstKey, 1_001)).toBe(payload);
    expect(cachedUserSpend(otherKey, 1_001)).toBeNull();
    expect(cachedUserSpend(firstKey, 31_001)).toBeNull();

    cacheUserSpend(firstKey, payload, 40_000);
    invalidateUserSpendCache();
    expect(cachedUserSpend(firstKey, 40_001)).toBeNull();
  });

  it('keeps both evidence reads bounded and aggregate instead of querying once per user', () => {
    expect(USER_SPEND_RUNS_QUERY).toContain('r.completed_at >= $1::date');
    expect(USER_SPEND_RUNS_QUERY).toContain("r.completed_at < ($2::date + INTERVAL '1 day')");
    expect(USER_SPEND_RUNS_QUERY).toContain('GROUP BY user_email');
    expect(USER_ACTIVE_MINUTES_QUERY).toContain('active_minute >=');
    expect(USER_ACTIVE_MINUTES_QUERY).toContain('active_minute <');
    expect(USER_ACTIVE_MINUTES_QUERY).toContain('GROUP BY selected.user_email');
    expect(USER_SPEND_RUNS_QUERY).not.toMatch(/WHERE\s+lower\(r\.user_email\)\s*=\s*\$/i);
    expect(USER_ACTIVE_MINUTES_QUERY).not.toMatch(/WHERE\s+lower\(user_email\)\s*=\s*\$/i);
    expect(USER_MONITORING_ACTIVITY_QUERY).toContain("COUNT(DISTINCT evidence_id) FILTER (WHERE kind = 'question')");
    expect(USER_MONITORING_ACTIVITY_QUERY).toContain("COUNT(DISTINCT evidence_id) FILTER (WHERE kind = 'run')");
    expect(USER_MONITORING_ACTIVITY_QUERY).toContain('s.deployment_key = $3');
    expect(USER_MONITORING_ACTIVITY_QUERY).not.toMatch(/roster|permission|persona|admin_role/i);
  });

  it('uses the selected activity window for population, including retained all-time evidence', () => {
    expect(OPS_ROUTE_SOURCE).toContain('const activityRange = userBrowse ? range : spendWindow.range');
    expect(OPS_ROUTE_SOURCE).toMatch(
      /\.query\(\s*USER_MONITORING_ACTIVITY_QUERY,\s*\[\s*activityRange\.from,\s*activityRange\.to,/
    );
  });

  it('deduplicates durable question, run, feedback, and session evidence by user', () => {
    const evidence = readUserInteractionEvidence([
      {
        user_email: 'ACTIVE@EXAMPLE.TEST',
        questions: 2,
        runs: 1,
        first_active: '2026-08-30T10:00:00Z',
        last_active: '2026-08-30T11:00:00Z',
      },
      {
        user_email: 'active@example.test',
        questions: 2,
        runs: 1,
        first_active: '2026-08-30T10:00:00Z',
        last_active: '2026-08-30T11:00:00Z',
      },
    ]);
    expect(evidence).toEqual([
      {
        email: 'active@example.test',
        questions: 2,
        runs: 1,
        firstActive: '2026-08-30T10:00:00Z',
        lastActive: '2026-08-30T11:00:00Z',
      },
    ]);
  });

  it('excludes roster, persona, and admin-only users from the active population', () => {
    const page = buildUserMonitoringPage({
      spend: build(),
      runs,
      activity: [],
      roles: new Map([
        ['a@example.test', 'admin'],
        ['b@example.test', 'consumer'],
        ['roster-only@example.test', 'consumer'],
        ['admin-only@example.test', 'admin'],
        ['persona-only@example.test', 'consumer'],
      ]),
      personas: new Map([['persona-only@example.test', { id: 'analyst', name: 'Analyst' }]]),
      unit: 'USD',
    });

    expect(page.users.map((row) => row.email)).toEqual(['b@example.test', 'a@example.test']);
  });

  it('includes session, question, run, and feedback users even when spend is unavailable', () => {
    const emptySpend = build();
    emptySpend.users = [];
    const page = buildUserMonitoringPage({
      spend: emptySpend,
      runs: [],
      activity: [],
      interactions: [
        {
          email: 'session-only@example.test',
          questions: 0,
          runs: 0,
          firstActive: '2026-08-31T09:00:00Z',
          lastActive: '2026-08-31T09:00:00Z',
        },
        {
          email: 'question@example.test',
          questions: 1,
          runs: 0,
          firstActive: '2026-08-31T10:00:00Z',
          lastActive: '2026-08-31T10:00:00Z',
        },
        {
          email: 'run@example.test',
          questions: 1,
          runs: 1,
          firstActive: '2026-08-31T11:00:00Z',
          lastActive: '2026-08-31T11:00:00Z',
        },
        {
          email: 'feedback@example.test',
          questions: 0,
          runs: 0,
          firstActive: '2026-08-31T12:00:00Z',
          lastActive: '2026-08-31T12:00:00Z',
        },
      ],
      roles: new Map(),
      unit: 'USD',
    });

    expect(page.users.map((row) => row.email).sort()).toEqual([
      'feedback@example.test',
      'question@example.test',
      'run@example.test',
      'session-only@example.test',
    ]);
    expect(page.users.every((row) => row.lastActive && row.spend.usd.quality === 'unavailable')).toBe(true);
  });

  it('keyset-pages measured spend before zero and unavailable users with a stable email tie-break', () => {
    const spend = build();
    spend.users.push({
      email: 'service-principal-id',
      total: {
        usd: { amount: 999, quality: 'direct' },
        dbu: { amount: 999, quality: 'direct' },
      },
      components: [],
    });
    const first = buildUserMonitoringPage({
      spend,
      runs,
      activity: [],
      roles: new Map([
        ['a@example.test', 'admin'],
        ['b@example.test', 'consumer'],
        ['zero@example.test', 'consumer'],
      ]),
      unit: 'USD',
      pageSize: 1,
    });
    expect(first.users).toHaveLength(1);
    expect(first.users[0].email).toBe('b@example.test');
    expect(first.users.some((row) => row.email === 'service-principal-id')).toBe(false);
    expect(first.pagination.nextCursor).toBeTruthy();

    const second = buildUserMonitoringPage({
      spend,
      runs,
      activity: [],
      roles: new Map([
        ['a@example.test', 'admin'],
        ['b@example.test', 'consumer'],
        ['zero@example.test', 'consumer'],
      ]),
      unit: 'USD',
      pageSize: 1,
      cursor: first.pagination.nextCursor ?? '',
    });
    expect(second.users[0].email).toBe('a@example.test');
  });

  it('applies normalized search and canonical role filters after one shared aggregation', () => {
    const page = buildUserMonitoringPage({
      spend: build(),
      runs,
      activity: [],
      roles: new Map([
        ['a@example.test', 'admin'],
        ['b@example.test', 'consumer'],
      ]),
      unit: 'DBU',
      search: 'A@EXAMPLE',
      role: 'admin',
    });
    expect(page.users.map((row) => row.email)).toEqual(['a@example.test']);
    expect(page.unit).toBe('DBU');
    expect(page.reconciliation.dbu.difference).toBe(0);
  });

  it('filters by the authorized current persona assignment and returns named options', () => {
    const page = buildUserMonitoringPage({
      spend: build(),
      runs,
      activity: [],
      roles: new Map([
        ['a@example.test', 'admin'],
        ['b@example.test', 'consumer'],
      ]),
      personas: new Map([['b@example.test', { id: 'analyst', name: 'Analyst' }]]),
      personaOptions: [
        { id: 'engineer', name: 'Engineer' },
        { id: 'analyst', name: 'Analyst' },
      ],
      persona: 'analyst',
      unit: 'USD',
    });

    expect(page.users.map((row) => row.email)).toEqual(['b@example.test']);
    expect(page.users[0].persona).toEqual({ id: 'analyst', name: 'Analyst' });
    expect(page.personas.map((persona) => persona.name)).toEqual(['Analyst', 'Engineer']);
    expect(page.personas.map((persona) => persona.count)).toEqual([1, 0]);
  });
});
