import { APP_ACTIVITY_TABLE } from './app-activity';
import { APP_SCHEMA } from '../../shared/app-schema';
import type { CostBudgetUnit } from '../../shared/cost-budgets';
import type { CostTile, OpsDayRange } from '../../shared/ops-contract';
import type {
  SpendByUserPayload,
  UserSpendAmount,
  UserSpendComponent,
  UserSpendProfile,
  UserSpendQuality,
} from '../../shared/user-spend-contract';

const DAY_MS = 86_400_000;
const MAX_USER_SPEND_DAYS = 90;
const ALLOCATION_SCALE = 1_000_000;
const USER_SPEND_CACHE_MS = 30_000;

let spendDataRevision = 0;
const spendCache = new Map<string, { expiresAt: number; payload: SpendByUserPayload }>();

export function invalidateUserSpendCache(): void {
  spendDataRevision += 1;
  spendCache.clear();
}

export function userSpendCacheKey(principal: string, range: OpsDayRange): string {
  return [principal.trim().toLowerCase(), range.from, range.to, 'USD+DBU', spendDataRevision].join('|');
}

export function cachedUserSpend(key: string, now = Date.now()): SpendByUserPayload | null {
  const cached = spendCache.get(key);
  if (!cached || cached.expiresAt <= now) {
    if (cached) spendCache.delete(key);
    return null;
  }
  return cached.payload;
}

export function cacheUserSpend(key: string, payload: SpendByUserPayload, now = Date.now()): void {
  spendCache.set(key, { expiresAt: now + USER_SPEND_CACHE_MS, payload });
}

export interface UserRunSpendEvidence {
  email: string;
  totalRuns: number;
  tokenCoveredRuns: number;
  totalTokens: number;
  resources: Array<{ tool: string; resourceId: string; calls: number }>;
}

export interface UserQuerySpendEvidence {
  email: string;
  astrolabeExecutionMs: number;
  genieSpaces: Array<{ spaceId: string; executionMs: number }>;
}

export interface UserActivitySpendEvidence {
  email: string;
  activeMinutes: number;
}

export interface DirectUserSpendEvidence {
  email: string;
  componentId: string;
  quality: 'direct' | 'joined';
  usd?: number | null;
  dbu?: number | null;
}

export const USER_SPEND_RUNS_QUERY = `
  WITH completed AS (
    SELECT lower(r.user_email) AS user_email,
           r.run_id,
           m.response_json->'trace' AS trace,
           CASE
             WHEN COALESCE(m.response_json->'trace'->>'total_tokens', '') ~ '^[0-9]+$'
               THEN (m.response_json->'trace'->>'total_tokens')::bigint
             WHEN COALESCE(m.response_json->'trace'->>'prompt_tokens', '') ~ '^[0-9]+$'
              AND COALESCE(m.response_json->'trace'->>'completion_tokens', '') ~ '^[0-9]+$'
               THEN (m.response_json->'trace'->>'prompt_tokens')::bigint
                  + (m.response_json->'trace'->>'completion_tokens')::bigint
             ELSE NULL
           END AS total_tokens
    FROM ${APP_SCHEMA}.runs r
    LEFT JOIN ${APP_SCHEMA}.messages m ON m.id = r.terminal_message_id
    WHERE r.completed_at >= $1::date
      AND r.completed_at < ($2::date + INTERVAL '1 day')
  ),
  run_totals AS (
    SELECT user_email,
           COUNT(*)::int AS total_runs,
           COUNT(*) FILTER (WHERE total_tokens IS NOT NULL AND total_tokens > 0)::int AS token_covered_runs,
           COALESCE(SUM(total_tokens) FILTER (WHERE total_tokens IS NOT NULL AND total_tokens > 0), 0)::bigint
             AS total_tokens
    FROM completed
    GROUP BY user_email
  ),
  modern_resources AS (
    SELECT c.user_email,
           resource->>'tool' AS tool,
           COALESCE(resource->>'id', '') AS resource_id,
           SUM(CASE WHEN COALESCE(resource->>'calls', '') ~ '^[0-9]+$'
                    THEN (resource->>'calls')::bigint ELSE 0 END)::bigint AS calls
    FROM completed c
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(c.trace->'resource_calls') = 'array'
           THEN c.trace->'resource_calls' ELSE '[]'::jsonb END
    ) resource
    WHERE resource->>'tool' IN ('data_genie', 'dictionary_genie', 'search_semantics')
    GROUP BY c.user_email, resource->>'tool', COALESCE(resource->>'id', '')
  ),
  legacy_resources AS (
    SELECT c.user_email,
           CASE
             WHEN stage->>'id' ~ 'dictionary_genie$' THEN 'dictionary_genie'
             WHEN stage->>'id' ~ 'data_genie$' THEN 'data_genie'
             WHEN stage->>'id' ~ 'search_semantics$' THEN 'search_semantics'
           END AS tool,
           ''::text AS resource_id,
           SUM(CASE WHEN COALESCE(stage->>'calls', '') ~ '^[0-9]+$'
                    THEN (stage->>'calls')::bigint ELSE 1 END)::bigint AS calls
    FROM completed c
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(c.trace->'stages') = 'array'
           THEN c.trace->'stages' ELSE '[]'::jsonb END
    ) stage
    WHERE jsonb_array_length(
            CASE WHEN jsonb_typeof(c.trace->'resource_calls') = 'array'
                 THEN c.trace->'resource_calls' ELSE '[]'::jsonb END
          ) = 0
      AND stage->>'id' ~ '(data_genie|dictionary_genie|search_semantics)$'
    GROUP BY c.user_email, tool
  ),
  resources AS (
    SELECT * FROM modern_resources
    UNION ALL
    SELECT * FROM legacy_resources
  )
  SELECT 'run' AS row_kind, totals.user_email,
         totals.total_runs, totals.token_covered_runs, totals.total_tokens,
         ''::text AS tool, ''::text AS resource_id, 0::bigint AS calls
  FROM run_totals totals
  UNION ALL
  SELECT 'resource' AS row_kind, resources.user_email,
         0::int, 0::int, 0::bigint,
         resources.tool, resources.resource_id, SUM(resources.calls)::bigint
  FROM resources
  GROUP BY resources.user_email, resources.tool, resources.resource_id
  ORDER BY user_email, row_kind, tool, resource_id`;

export const USER_ACTIVE_MINUTES_QUERY = `
  WITH selected AS (
    SELECT lower(user_email) AS user_email, active_minute
    FROM ${APP_ACTIVITY_TABLE}
    WHERE active_minute >= ($1::date::timestamp AT TIME ZONE 'UTC')
      AND active_minute < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
  ),
  bounds AS (
    SELECT MIN(active_minute) AS recorded_from, MAX(active_minute) AS recorded_through
    FROM ${APP_ACTIVITY_TABLE}
  )
  SELECT selected.user_email,
         COUNT(*)::int AS active_minutes,
         bounds.recorded_from,
         bounds.recorded_through
  FROM bounds
  LEFT JOIN selected ON TRUE
  GROUP BY selected.user_email, bounds.recorded_from, bounds.recorded_through
  ORDER BY selected.user_email`;

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readUserRunSpendEvidence(rows: readonly Record<string, unknown>[]): UserRunSpendEvidence[] {
  const users = new Map<string, UserRunSpendEvidence>();
  const seen = new Set<string>();
  for (const row of rows) {
    const email = text(row.user_email).toLowerCase();
    if (!email) continue;
    const rowKey = [
      text(row.row_kind),
      email,
      text(row.tool),
      text(row.resource_id),
      number(row.calls),
      number(row.total_runs),
      number(row.total_tokens),
    ].join('|');
    if (seen.has(rowKey)) continue;
    seen.add(rowKey);
    const current = users.get(email) ?? {
      email,
      totalRuns: 0,
      tokenCoveredRuns: 0,
      totalTokens: 0,
      resources: [],
    };
    if (text(row.row_kind) === 'run') {
      current.totalRuns = number(row.total_runs);
      current.tokenCoveredRuns = number(row.token_covered_runs);
      current.totalTokens = number(row.total_tokens);
    } else if (text(row.row_kind) === 'resource') {
      const tool = text(row.tool);
      const calls = number(row.calls);
      if (tool && calls > 0) current.resources.push({ tool, resourceId: text(row.resource_id), calls });
    }
    users.set(email, current);
  }
  return [...users.values()].sort((left, right) => left.email.localeCompare(right.email));
}

export function readUserActivitySpendEvidence(rows: readonly Record<string, unknown>[]): {
  users: UserActivitySpendEvidence[];
  recordedFrom: string;
  recordedThrough: string;
} {
  const first = rows[0];
  return {
    users: rows
      .map((row) => ({ email: text(row.user_email).toLowerCase(), activeMinutes: number(row.active_minutes) }))
      .filter((row) => row.email && row.activeMinutes > 0),
    recordedFrom: first?.recorded_from instanceof Date ? first.recorded_from.toISOString() : text(first?.recorded_from),
    recordedThrough:
      first?.recorded_through instanceof Date ? first.recorded_through.toISOString() : text(first?.recorded_through),
  };
}

export function capUserSpendRange(requested: OpsDayRange): {
  range: OpsDayRange;
  partial: boolean;
} {
  const from = Date.parse(`${requested.from}T00:00:00Z`);
  const to = Date.parse(`${requested.to}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return { range: requested, partial: true };
  const cappedFrom = Math.max(from, to - (MAX_USER_SPEND_DAYS - 1) * DAY_MS);
  return {
    range: { from: new Date(cappedFrom).toISOString().slice(0, 10), to: requested.to },
    partial: cappedFrom !== from,
  };
}

function amount(value: number | null, quality: UserSpendQuality): UserSpendAmount {
  return { amount: value !== null && Number.isFinite(value) ? value : null, quality };
}

function tileTotal(tile: CostTile | undefined, unit: CostBudgetUnit, days: number): number | null {
  if (!tile || tile.attribution !== 'deployment') return null;
  const value = unit === 'USD' ? tile.amount : (tile.dbus ?? null);
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value * (tile.basis === 'per-day' ? days : 1);
}

/**
 * Largest-remainder allocation in millionths. Lexical actor order settles exact
 * ties, so the residual is deterministic and user totals reconcile exactly.
 */
export function allocateDeterministically(total: number, weights: ReadonlyMap<string, number>): Map<string, number> {
  const usable = [...weights]
    .filter(([, weight]) => Number.isFinite(weight) && weight > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const denominator = usable.reduce((sum, [, weight]) => sum + weight, 0);
  if (!Number.isFinite(total) || denominator <= 0) return new Map();
  const sign = total < 0 ? -1 : 1;
  const totalUnits = Math.round(Math.abs(total) * ALLOCATION_SCALE);
  const parts = usable.map(([key, weight]) => {
    const exact = (totalUnits * weight) / denominator;
    const floor = Math.floor(exact);
    return { key, units: floor, remainder: exact - floor };
  });
  let residual = totalUnits - parts.reduce((sum, part) => sum + part.units, 0);
  parts.sort((left, right) => right.remainder - left.remainder || left.key.localeCompare(right.key));
  for (let index = 0; residual > 0; index = (index + 1) % Math.max(parts.length, 1), residual -= 1) {
    parts[index].units += 1;
  }
  return new Map(parts.map((part) => [part.key, (sign * part.units) / ALLOCATION_SCALE]));
}

function completeDays(range: OpsDayRange): number {
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? Math.round((to - from) / DAY_MS) + 1 : 0;
}

function qualityFor(parts: UserSpendAmount[], partial: boolean): UserSpendQuality {
  const measured = parts.filter((part) => part.amount !== null);
  if (measured.length === 0) return 'unavailable';
  if (partial) return 'partial';
  if (measured.some((part) => part.quality === 'allocated')) return 'allocated';
  if (measured.some((part) => part.quality === 'joined')) return 'joined';
  return 'direct';
}

export function buildSpendByUser(input: {
  readAt: string;
  requestedRange: OpsDayRange;
  range: OpsDayRange;
  tiles: CostTile[];
  queryComplete: boolean;
  queryUsers: UserQuerySpendEvidence[];
  runs: UserRunSpendEvidence[];
  activity: {
    available: boolean;
    recordedFrom: string;
    recordedThrough: string;
    users: UserActivitySpendEvidence[];
  };
  direct?: DirectUserSpendEvidence[];
  partialReason?: string;
}): SpendByUserPayload {
  const emails = new Set<string>();
  for (const row of [...input.queryUsers, ...input.runs, ...input.activity.users, ...(input.direct ?? [])]) {
    if (row.email.trim()) emails.add(row.email.trim().toLowerCase());
  }
  const users = [...emails].sort();
  const days = completeDays(input.range);
  const activityByUser = new Map(input.activity.users.map((row) => [row.email, row]));
  const tileById = new Map(input.tiles.map((tile) => [tile.id, tile]));
  const componentIds = [
    'serving-endpoint',
    'sql-warehouse',
    'genie:data',
    'genie:dictionary',
    'vector-search',
    'app-compute',
  ];
  const labels = new Map(input.tiles.map((tile) => [tile.id, tile.label]));
  const perUser = new Map<string, UserSpendComponent[]>();
  for (const email of users) perUser.set(email, []);
  const unattributed: UserSpendComponent[] = [];

  const appendComponent = (
    id: string,
    unit: CostBudgetUnit,
    total: number | null,
    weights: Map<string, number>,
    usable: boolean,
    reason: string
  ) => {
    const direct = (input.direct ?? []).filter(
      (row) => row.componentId === id && typeof (unit === 'USD' ? row.usd : row.dbu) === 'number'
    );
    const allocated =
      total === null
        ? new Map<string, number>()
        : direct.length > 0
          ? new Map(direct.map((row) => [row.email.toLowerCase(), (unit === 'USD' ? row.usd : row.dbu) as number]))
          : usable
            ? allocateDeterministically(total, weights)
            : new Map<string, number>();
    const attributedTotal = [...allocated.values()].reduce((sum, value) => sum + value, 0);
    const residual =
      total === null ? null : Math.round((total - attributedTotal) * ALLOCATION_SCALE) / ALLOCATION_SCALE;
    for (const email of users) {
      const found = direct.find((row) => row.email.toLowerCase() === email);
      const value = allocated.get(email) ?? null;
      const quality: UserSpendQuality = found?.quality ?? (value === null ? 'unavailable' : 'allocated');
      let component = perUser.get(email)?.find((entry) => entry.id === id);
      if (!component) {
        component = {
          id,
          label: labels.get(id) ?? id,
          usd: amount(null, 'unavailable'),
          dbu: amount(null, 'unavailable'),
          reason,
        };
        perUser.get(email)?.push(component);
      }
      component[unit === 'USD' ? 'usd' : 'dbu'] = amount(value, quality);
      if (value !== null) component.reason = '';
    }
    let missing = unattributed.find((entry) => entry.id === id);
    if (!missing) {
      missing = {
        id,
        label: labels.get(id) ?? id,
        usd: amount(null, total === null ? 'unavailable' : 'unattributed'),
        dbu: amount(null, total === null ? 'unavailable' : 'unattributed'),
        reason,
      };
      unattributed.push(missing);
    }
    missing[unit === 'USD' ? 'usd' : 'dbu'] = amount(residual, residual === null ? 'unavailable' : 'unattributed');
  };

  for (const id of componentIds) {
    const tile = tileById.get(id);
    const servingCoverage =
      input.runs.reduce((sum, row) => sum + row.totalRuns, 0) > 0 &&
      input.runs.every((row) => row.totalRuns === row.tokenCoveredRuns);
    const vectorRows = input.runs.flatMap((row) =>
      row.resources
        .filter((resource) => resource.tool === 'search_semantics')
        .map((resource) => ({ email: row.email, ...resource }))
    );
    const activityCoverage =
      input.activity.available &&
      Boolean(input.activity.recordedFrom) &&
      Date.parse(input.activity.recordedFrom) <= Date.parse(`${input.range.from}T23:59:59Z`);
    for (const unit of ['USD', 'DBU'] as const) {
      const total = tileTotal(tile, unit, days);
      let weights = new Map<string, number>();
      let usable = false;
      let reason = tile?.unavailable || 'No attributable component amount was measured.';
      if (id === 'serving-endpoint') {
        weights = new Map(input.runs.map((row) => [row.email, row.totalTokens]));
        usable = servingCoverage && [...weights.values()].some((value) => value > 0);
        reason = usable ? '' : 'Serving spend lacks complete per-run token coverage.';
      } else if (id === 'sql-warehouse') {
        weights = new Map(input.queryUsers.map((row) => [row.email, row.astrolabeExecutionMs]));
        usable = input.queryComplete && [...weights.values()].some((value) => value > 0);
        reason = usable ? '' : 'SQL spend lacks complete user-attributed Query History.';
      } else if (id.startsWith('genie:')) {
        const spaceId = tile?.resourceId ?? '';
        weights = new Map(
          input.queryUsers.map((row) => [
            row.email,
            row.genieSpaces.find((space) => space.spaceId === spaceId)?.executionMs ?? 0,
          ])
        );
        usable = Boolean(spaceId) && input.queryComplete && [...weights.values()].some((value) => value > 0);
        reason = usable ? '' : 'Genie generated-SQL spend lacks complete user and space attribution.';
      } else if (id === 'vector-search') {
        const wanted = new Set([tile?.resourceId ?? '', tile?.secondaryResourceId ?? ''].filter(Boolean));
        weights = new Map(
          users.map((email) => [
            email,
            vectorRows
              .filter((row) => row.email === email && wanted.has(row.resourceId))
              .reduce((sum, row) => sum + row.calls, 0),
          ])
        );
        usable =
          wanted.size > 0 &&
          vectorRows.length > 0 &&
          vectorRows.every((row) => Boolean(row.resourceId)) &&
          [...weights.values()].some((value) => value > 0);
        reason = usable ? '' : 'Vector Search billing cannot be joined to fully resource-scoped user calls.';
      } else if (id === 'app-compute') {
        weights = new Map(users.map((email) => [email, activityByUser.get(email)?.activeMinutes ?? 0]));
        usable = activityCoverage && [...weights.values()].some((value) => value > 0);
        reason = usable ? '' : 'App compute lacks complete per-user active-minute coverage.';
      }
      appendComponent(id, unit, total, weights, usable, reason);
    }
  }

  const profiles: UserSpendProfile[] = users.map((email) => {
    const components = (perUser.get(email) ?? []).sort(
      (left, right) => componentIds.indexOf(left.id) - componentIds.indexOf(right.id)
    );
    const usdParts = components.map((component) => component.usd);
    const dbuParts = components.map((component) => component.dbu);
    const usdValues = usdParts.flatMap((part) => (part.amount === null ? [] : [part.amount]));
    const dbuValues = dbuParts.flatMap((part) => (part.amount === null ? [] : [part.amount]));
    const partial = unattributed.some(
      (component) => (component.usd.amount ?? 0) !== 0 || (component.dbu.amount ?? 0) !== 0
    );
    return {
      email,
      total: {
        usd: amount(
          usdValues.length ? usdValues.reduce((sum, value) => sum + value, 0) : null,
          qualityFor(usdParts, partial)
        ),
        dbu: amount(
          dbuValues.length ? dbuValues.reduce((sum, value) => sum + value, 0) : null,
          qualityFor(dbuParts, partial)
        ),
      },
      components,
    };
  });

  const reconcile = (unit: CostBudgetUnit) => {
    const key = unit === 'USD' ? 'usd' : 'dbu';
    const componentTotals = componentIds
      .map((id) => tileTotal(tileById.get(id), unit, days))
      .filter((value): value is number => value !== null);
    const appTotal = componentTotals.length ? componentTotals.reduce((sum, value) => sum + value, 0) : null;
    const userTotal = profiles
      .flatMap((profile) => profile.total[key].amount ?? [])
      .reduce((sum, value) => sum + value, 0);
    const missing = unattributed
      .flatMap((component) => component[key].amount ?? [])
      .reduce((sum, value) => sum + value, 0);
    return {
      unit,
      appTotal,
      users: appTotal === null ? null : userTotal,
      unattributed: appTotal === null ? null : missing,
      difference:
        appTotal === null ? null : Math.round((appTotal - userTotal - missing) * ALLOCATION_SCALE) / ALLOCATION_SCALE,
    };
  };

  const partial = Boolean(input.partialReason);
  return {
    readAt: input.readAt,
    requestedRange: input.requestedRange,
    range: input.range,
    state: profiles.length === 0 && input.tiles.length === 0 ? 'unavailable' : partial ? 'partial' : 'ready',
    reason: input.partialReason ?? '',
    users: profiles,
    unattributed,
    reconciliation: { usd: reconcile('USD'), dbu: reconcile('DBU') },
  };
}
