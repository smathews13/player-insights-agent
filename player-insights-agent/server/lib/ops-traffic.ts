import { APP_SCHEMA, appTable } from '../../shared/app-schema';
import { classifiedRunStatusSql } from '../../shared/run-verdict';
import type { TrafficBar, TrafficBreakdownCoverage } from '../../shared/ops-contract';

export const TRAFFIC_DAILY_ROLLUP_TABLE = appTable('traffic_daily_rollups');

export const TRAFFIC_DAILY_ROLLUP_DDL = `CREATE TABLE IF NOT EXISTS ${TRAFFIC_DAILY_ROLLUP_TABLE} (
  day DATE PRIMARY KEY,
  run_count INTEGER NOT NULL,
  failure_causes JSONB NOT NULL DEFAULT '{}'::jsonb,
  refusal_causes JSONB NOT NULL DEFAULT '{}'::jsonb,
  tool_calls JSONB NOT NULL DEFAULT '{}'::jsonb,
  completed_at TIMESTAMPTZ NOT NULL,
  CHECK (run_count >= 0)
)`;

const answerStatus = classifiedRunStatusSql({
  trace: "m.response_json->'trace'",
  payload: 'm.response_json',
  caveats: "m.response_json->'caveats'",
});

function evidenceCtes(start: string, end: string): string {
  return `answers AS (
    SELECT m.id AS message_id,
           COALESCE(NULLIF(m.trace_id, ''), NULLIF(m.response_json->'trace'->>'id', '')) AS trace_id,
           ${answerStatus} AS answer_status,
           m.response_json->'trace' AS trace,
           m.created_at
    FROM ${APP_SCHEMA}.messages m
    WHERE m.role = 'assistant'
      AND jsonb_typeof(m.response_json) = 'object'
  ),
  ledger_population AS (
    SELECT 'run:' || r.run_id AS event_id,
           r.run_id,
           r.created_at AS event_at,
           CASE
             WHEN r.state = 'REFUSED' THEN 'REFUSED'
             WHEN r.state IN ('FAILED', 'DEADLINE_EXCEEDED', 'PERSISTENCE_FAILED') THEN r.state
             WHEN a.answer_status = 'failed' THEN 'FAILED'
             ELSE r.state
           END AS state,
           CASE
             WHEN COALESCE(r.terminal_code, '') <> '' THEN r.terminal_code
             WHEN r.state IN ('FAILED', 'DEADLINE_EXCEEDED', 'PERSISTENCE_FAILED')
               THEN 'UNKNOWN_FAILURE_CAUSE'
             WHEN r.state = 'REFUSED' THEN 'UNKNOWN_REFUSAL_CAUSE'
             WHEN a.answer_status = 'failed' THEN 'UNKNOWN_STORED_ANSWER_FAILURE'
             ELSE ''
           END AS cause,
           a.trace
    FROM ${APP_SCHEMA}.runs r
    LEFT JOIN LATERAL (
      SELECT candidate.trace, candidate.answer_status
      FROM answers candidate
      WHERE candidate.message_id = r.terminal_message_id
         OR (COALESCE(r.trace_id, '') <> '' AND candidate.trace_id = r.trace_id)
      ORDER BY (candidate.message_id = r.terminal_message_id) DESC, candidate.created_at DESC
      LIMIT 1
    ) a ON TRUE
    WHERE r.created_at >= ${start}
      AND r.created_at < ${end}
  ),
  legacy_population AS (
    SELECT 'message:' || a.message_id AS event_id,
           ''::text AS run_id,
           a.created_at AS event_at,
           CASE WHEN a.answer_status = 'failed' THEN 'FAILED' ELSE 'SUCCEEDED' END AS state,
           CASE WHEN a.answer_status = 'failed' THEN 'UNKNOWN_STORED_ANSWER_FAILURE' ELSE '' END AS cause,
           a.trace
    FROM answers a
    WHERE a.created_at >= ${start}
      AND a.created_at < ${end}
      AND NOT EXISTS (
        SELECT 1
        FROM ${APP_SCHEMA}.runs r
        WHERE r.terminal_message_id = a.message_id
           OR (COALESCE(r.trace_id, '') <> '' AND r.trace_id = a.trace_id)
      )
  ),
  population AS (
    SELECT * FROM ledger_population
    UNION ALL
    SELECT * FROM legacy_population
  ),
  answer_tool_events AS (
    SELECT p.event_id,
           COALESCE(NULLIF(stage.value->>'id', ''), 'answer-stage:' || stage.ordinality::text) AS call_id,
           COALESCE(
             NULLIF(stage.value->>'name', ''),
             NULLIF(regexp_replace(stage.value->>'id', '^step-[0-9]+-[0-9]+-', ''), ''),
             'Unknown tool'
           ) AS tool,
           CASE WHEN COALESCE(stage.value->>'calls', '') ~ '^[0-9]+$'
                THEN (stage.value->>'calls')::int ELSE 1 END AS calls,
           1 AS source_priority
    FROM population p
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(p.trace->'stages') = 'array' THEN p.trace->'stages' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS stage(value, ordinality)
    WHERE stage.value->>'kind' = 'tool'
  ),
  durable_tool_events AS (
    SELECT p.event_id,
           COALESCE(NULLIF(e.payload->>'id', ''), 'run-event:' || e.seq::text) AS call_id,
           COALESCE(
             NULLIF(e.payload->>'name', ''),
             NULLIF(regexp_replace(e.payload->>'id', '^step-[0-9]+-[0-9]+-', ''), ''),
             NULLIF(e.stage, ''),
             'Unknown tool'
           ) AS tool,
           CASE WHEN COALESCE(e.payload->>'calls', '') ~ '^[0-9]+$'
                THEN (e.payload->>'calls')::int ELSE 1 END AS calls,
           2 AS source_priority
    FROM population p
    JOIN ${APP_SCHEMA}.run_events e ON e.run_id = p.run_id
    WHERE e.event_type = 'stage'
      AND e.payload->>'kind' = 'tool'
  ),
  deduped_tool_events AS (
    SELECT DISTINCT ON (event_id, call_id) event_id, call_id, tool, calls
    FROM (
      SELECT * FROM answer_tool_events
      UNION ALL
      SELECT * FROM durable_tool_events
    ) evidence
    ORDER BY event_id, call_id, source_priority DESC
  )`;
}

function metricSelect(population: string, tools: string): string {
  return `SELECT 'population' AS kind, '' AS key, COUNT(*)::bigint AS count
  FROM ${population}
  UNION ALL
  SELECT 'failure', cause, COUNT(*)::bigint
  FROM ${population}
  WHERE state IN ('FAILED', 'DEADLINE_EXCEEDED', 'PERSISTENCE_FAILED')
  GROUP BY cause
  UNION ALL
  SELECT 'refusal', cause, COUNT(*)::bigint
  FROM ${population}
  WHERE state = 'REFUSED'
  GROUP BY cause
  UNION ALL
  SELECT 'tool', tool, SUM(calls)::bigint
  FROM ${tools}
  GROUP BY tool`;
}

const bounds = `(($2::date::timestamp) AT TIME ZONE $1)`;
const endBounds = `((($3::date + 1)::timestamp) AT TIME ZONE $1)`;
const rawEvidence = evidenceCtes(bounds, endBounds);

/** Raw durable/legacy evidence, used directly and as the migration fallback. */
export const RAW_TRAFFIC_BREAKDOWNS_QUERY = `WITH ${rawEvidence}
${metricSelect('population', 'deduped_tool_events')}
ORDER BY 1, 3 DESC, 2`;

/**
 * Selected Traffic breakdowns over one deduplicated run population.
 *
 * UTC daily rollups replace raw evidence only for the exact UTC days they
 * cover. Other timezones retain timestamp-grain raw reads so a local-day range
 * is never approximated with a UTC aggregate.
 */
export const TRAFFIC_BREAKDOWNS_QUERY = `WITH ${rawEvidence},
  selected_rollups AS (
    SELECT *
    FROM ${TRAFFIC_DAILY_ROLLUP_TABLE}
    WHERE $1 = 'UTC' AND day BETWEEN $2::date AND $3::date
  ),
  selected_population AS (
    SELECT p.*
    FROM population p
    WHERE NOT EXISTS (
      SELECT 1 FROM selected_rollups rolled
      WHERE rolled.day = (p.event_at AT TIME ZONE 'UTC')::date
    )
  ),
  selected_tools AS (
    SELECT t.*
    FROM deduped_tool_events t
    JOIN population p USING (event_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM selected_rollups rolled
      WHERE rolled.day = (p.event_at AT TIME ZONE 'UTC')::date
    )
  ),
  raw_metrics AS (
    ${metricSelect('selected_population', 'selected_tools')}
  ),
  rolled_metrics AS (
    SELECT 'population' AS kind, '' AS key, SUM(run_count)::bigint AS count FROM selected_rollups
    UNION ALL
    SELECT 'failure', item.key, SUM(item.value::bigint)
    FROM selected_rollups, LATERAL jsonb_each_text(failure_causes) item
    GROUP BY item.key
    UNION ALL
    SELECT 'refusal', item.key, SUM(item.value::bigint)
    FROM selected_rollups, LATERAL jsonb_each_text(refusal_causes) item
    GROUP BY item.key
    UNION ALL
    SELECT 'tool', item.key, SUM(item.value::bigint)
    FROM selected_rollups, LATERAL jsonb_each_text(tool_calls) item
    GROUP BY item.key
  )
SELECT kind, key, SUM(count)::bigint AS count
FROM (
  SELECT * FROM raw_metrics
  UNION ALL
  SELECT * FROM rolled_metrics
) combined
GROUP BY kind, key
ORDER BY 1, 3 DESC, 2`;

/** Historical answer-only fallback for a deployment whose durable ledger is unavailable. */
export const LEGACY_TRAFFIC_BREAKDOWNS_QUERY = `WITH answers AS (
  SELECT m.id AS event_id,
         ${answerStatus} AS answer_status,
         m.response_json->'trace' AS trace
  FROM ${APP_SCHEMA}.messages m
  WHERE m.role = 'assistant'
    AND m.created_at >= ${bounds}
    AND m.created_at < ${endBounds}
    AND jsonb_typeof(m.response_json) = 'object'
),
tools AS (
  SELECT a.event_id,
         COALESCE(NULLIF(stage.value->>'id', ''), 'answer-stage:' || stage.ordinality::text) AS call_id,
         COALESCE(
           NULLIF(stage.value->>'name', ''),
           NULLIF(regexp_replace(stage.value->>'id', '^step-[0-9]+-[0-9]+-', ''), ''),
           'Unknown tool'
         ) AS tool,
         CASE WHEN COALESCE(stage.value->>'calls', '') ~ '^[0-9]+$'
              THEN (stage.value->>'calls')::int ELSE 1 END AS calls
  FROM answers a
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(a.trace->'stages') = 'array' THEN a.trace->'stages' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS stage(value, ordinality)
  WHERE stage.value->>'kind' = 'tool'
)
SELECT 'population' AS kind, '' AS key, COUNT(*)::bigint AS count FROM answers
UNION ALL
SELECT 'failure', 'UNKNOWN_STORED_ANSWER_FAILURE', COUNT(*)::bigint
FROM answers WHERE answer_status = 'failed'
UNION ALL
SELECT 'tool', tool, SUM(calls)::bigint FROM tools GROUP BY tool
ORDER BY 1, 3 DESC, 2`;

const rollupStart = `($1::date::timestamp AT TIME ZONE 'UTC')`;
const rollupEnd = `(($1::date + 1)::timestamp AT TIME ZONE 'UTC')`;

/** Preserve the same deduplicated outcomes/tools before any raw telemetry is pruned. */
export const ROLLUP_TRAFFIC_DAY_QUERY = `WITH ${evidenceCtes(rollupStart, rollupEnd)},
failure_counts AS (
  SELECT cause, COUNT(*)::int AS count
  FROM population
  WHERE state IN ('FAILED', 'DEADLINE_EXCEEDED', 'PERSISTENCE_FAILED')
  GROUP BY cause
),
refusal_counts AS (
  SELECT cause, COUNT(*)::int AS count FROM population WHERE state = 'REFUSED' GROUP BY cause
),
tool_counts AS (
  SELECT tool, SUM(calls)::int AS count FROM deduped_tool_events GROUP BY tool
)
INSERT INTO ${TRAFFIC_DAILY_ROLLUP_TABLE}
  (day, run_count, failure_causes, refusal_causes, tool_calls, completed_at)
SELECT $1::date,
       (SELECT COUNT(*)::int FROM population),
       COALESCE((SELECT jsonb_object_agg(cause, count) FROM failure_counts), '{}'::jsonb),
       COALESCE((SELECT jsonb_object_agg(cause, count) FROM refusal_counts), '{}'::jsonb),
       COALESCE((SELECT jsonb_object_agg(tool, count) FROM tool_counts), '{}'::jsonb),
       NOW()
ON CONFLICT (day) DO UPDATE SET
  run_count = EXCLUDED.run_count,
  failure_causes = EXCLUDED.failure_causes,
  refusal_causes = EXCLUDED.refusal_causes,
  tool_calls = EXCLUDED.tool_calls,
  completed_at = EXCLUDED.completed_at`;

export interface TrafficBreakdownRead {
  runsInRange: number;
  failuresByCause: TrafficBar[];
  refusalsByCause: TrafficBar[];
  toolCalls: TrafficBar[];
  outcomesCoverage: TrafficBreakdownCoverage;
  toolCallsCoverage: TrafficBreakdownCoverage;
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

function label(kind: string, key: string): string {
  if (key === 'UNKNOWN_FAILURE_CAUSE') return 'Unknown failure cause';
  if (key === 'UNKNOWN_REFUSAL_CAUSE') return 'Unknown refusal cause';
  if (key === 'UNKNOWN_STORED_ANSWER_FAILURE') return 'Unknown historical answer failure';
  if (!key) return kind === 'tool' ? 'Unknown tool' : 'Unknown cause';
  return key;
}

function sortedBars(values: Map<string, number>, kind: string): TrafficBar[] {
  return [...values]
    .map(([key, count]) => ({ key, label: label(kind, key), count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

/** Parse aggregate SQL rows without converting malformed/missing rows to zero. */
export function readTrafficBreakdowns(
  rows: readonly Record<string, unknown>[],
  input: { state?: TrafficBreakdownCoverage['state']; reason?: string } = {}
): TrafficBreakdownRead {
  const failures = new Map<string, number>();
  const refusals = new Map<string, number>();
  const tools = new Map<string, number>();
  let population: number | null = null;
  let malformed = false;
  for (const row of rows) {
    const kind = scalar(row.kind);
    const key = scalar(row.key);
    const parsed = Number(scalar(row.count));
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      malformed = true;
      continue;
    }
    if (kind === 'population') {
      population = parsed;
      continue;
    }
    const target = kind === 'failure' ? failures : kind === 'refusal' ? refusals : kind === 'tool' ? tools : null;
    if (!target) {
      malformed = true;
      continue;
    }
    const named = key || (kind === 'tool' ? 'Unknown tool' : 'Unknown cause');
    target.set(named, (target.get(named) ?? 0) + parsed);
  }
  const requested = input.state ?? 'complete';
  const state = population === null ? 'unavailable' : malformed && requested === 'complete' ? 'partial' : requested;
  const reason =
    input.reason ||
    (population === null
      ? 'The run population row was missing, so zero was not established.'
      : malformed
        ? 'One or more aggregate rows were malformed and were withheld.'
        : '');
  const coverage = { state, coveredRuns: population ?? 0, reason } satisfies TrafficBreakdownCoverage;
  return {
    runsInRange: population ?? 0,
    failuresByCause: sortedBars(failures, 'failure'),
    refusalsByCause: sortedBars(refusals, 'refusal'),
    toolCalls: sortedBars(tools, 'tool'),
    outcomesCoverage: { ...coverage },
    toolCallsCoverage: { ...coverage },
  };
}
