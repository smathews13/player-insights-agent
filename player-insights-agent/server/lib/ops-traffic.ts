import { APP_SCHEMA, appTable } from '../../shared/app-schema';
import { classifiedRunStatusSql } from '../../shared/run-verdict';
import type { TrafficBar, TrafficBreakdownCoverage } from '../../shared/ops-contract';

export const TRAFFIC_DAILY_ROLLUP_TABLE = appTable('traffic_daily_rollups');
export const TRAFFIC_EVIDENCE_VERSION = 2;

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

/** Explicit aliases observed in current and legacy persisted stage payloads. */
function canonicalToolSql(stage: string): string {
  return `CASE
    WHEN ${stage}->>'id' ~ '(^|-)run_sql$' THEN 'run_sql'
    WHEN ${stage}->>'id' ~ '(^|-)describe_table$' THEN 'describe_table'
    WHEN ${stage}->>'id' ~ '(^|-)list_data_assets$' THEN 'list_data_assets'
    WHEN ${stage}->>'id' ~ '(^|-)resolve_table$' THEN 'resolve_table'
    WHEN ${stage}->>'id' ~ '(^|-)search_tagged_assets$' THEN 'search_tagged_assets'
    WHEN ${stage}->>'id' ~ '(^|-)search_semantics$' THEN 'search_semantics'
    WHEN ${stage}->>'id' ~ '(^|-)data_genie$' THEN 'data_genie'
    WHEN ${stage}->>'id' ~ '(^|-)dictionary_genie$' THEN 'dictionary_genie'
    WHEN ${stage}->>'name' IN ('Ran a governed read-only query', 'Running a governed read-only query')
      THEN 'run_sql'
    WHEN ${stage}->>'name' IN ('Read a table''s columns', 'Reading a table''s columns')
      THEN 'describe_table'
    WHEN ${stage}->>'name' IN ('Listed available tables', 'Listing available tables')
      THEN 'list_data_assets'
    WHEN ${stage}->>'name' IN ('Located the named table', 'Locating the named table')
      THEN 'resolve_table'
    WHEN ${stage}->>'name' IN ('Searched catalog tags', 'Searching catalog tags')
      THEN 'search_tagged_assets'
    WHEN ${stage}->>'name' IN ('Called search_semantics', 'Calling search_semantics')
      THEN 'search_semantics'
    WHEN ${stage}->>'name' IN ('Asked the data Genie', 'Asking the data Genie')
      THEN 'data_genie'
    WHEN ${stage}->>'name' IN ('Checked field definitions', 'Checking field definitions')
      THEN 'dictionary_genie'
    WHEN ${stage}->>'kind' IN ('tool', 'sql', 'discovery', 'genie') THEN 'unknown_tool'
    ELSE NULL
  END`;
}

function evidenceCtes(start: string, end: string): string {
  return `answers AS (
    SELECT m.id AS message_id,
           COALESCE(NULLIF(m.trace_id, ''), NULLIF(m.response_json->'trace'->>'id', '')) AS trace_id,
           ${answerStatus} AS answer_status,
           m.response_json->'trace' AS trace,
           CASE
             WHEN ${answerStatus} <> 'failed' THEN ''
             WHEN EXISTS (
               SELECT 1
               FROM jsonb_array_elements_text(
                 CASE WHEN jsonb_typeof(m.response_json->'caveats') = 'array'
                      THEN m.response_json->'caveats' ELSE '[]'::jsonb END
               ) caveat
               WHERE caveat ~* 'APITimeoutError|Request timed out|reasoning endpoint.*not reachable'
             ) THEN 'REASONING_ENDPOINT_TIMEOUT'
             WHEN EXISTS (
               SELECT 1
               FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(m.response_json->'trace'->'stages') = 'array'
                      THEN m.response_json->'trace'->'stages' ELSE '[]'::jsonb END
               ) stage
               WHERE stage->>'status' = 'failed'
                 AND stage->>'output' ~* 'UNRESOLVED_COLUMN'
             ) THEN 'SQL_UNRESOLVED_COLUMN'
             WHEN EXISTS (
               SELECT 1
               FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(m.response_json->'trace'->'stages') = 'array'
                      THEN m.response_json->'trace'->'stages' ELSE '[]'::jsonb END
               ) stage
               WHERE stage->>'status' = 'failed' AND stage->>'kind' = 'sql'
             ) THEN 'SQL_TOOL_FAILURE'
             WHEN jsonb_path_exists(
               m.response_json->'trace',
               '$.stages[*] ? (@.id == "synthesis" && @.status == "failed")'
             ) THEN 'ANSWER_SYNTHESIS_FAILED'
             ELSE 'UNKNOWN_STORED_ANSWER_FAILURE'
           END AS answer_cause,
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
               THEN COALESCE(
                 (
                   SELECT NULLIF(evidence.payload->>'outcome_code', '')
                   FROM ${APP_SCHEMA}.run_events evidence
                   WHERE evidence.run_id = r.run_id
                     AND evidence.event_type = 'stage'
                     AND COALESCE(evidence.payload->>'outcome_code', '') <> ''
                   ORDER BY evidence.seq DESC
                   LIMIT 1
                 ),
                 'UNKNOWN_FAILURE_CAUSE'
               )
             WHEN r.state = 'REFUSED' THEN COALESCE(
               (
                 SELECT NULLIF(evidence.payload->>'outcome_code', '')
                 FROM ${APP_SCHEMA}.run_events evidence
                 WHERE evidence.run_id = r.run_id
                   AND evidence.event_type = 'stage'
                   AND COALESCE(evidence.payload->>'outcome_code', '') <> ''
                 ORDER BY evidence.seq DESC
                 LIMIT 1
               ),
               'UNKNOWN_REFUSAL_CAUSE'
             )
             WHEN a.answer_status = 'failed' THEN a.answer_cause
             ELSE ''
           END AS cause,
           a.trace,
           (
             jsonb_typeof(a.trace->'stages') = 'array'
             OR EXISTS (
               SELECT 1 FROM ${APP_SCHEMA}.run_events evidence
               WHERE evidence.run_id = r.run_id AND evidence.event_type = 'stage'
             )
           ) AS tool_evidence
    FROM ${APP_SCHEMA}.runs r
    LEFT JOIN LATERAL (
      SELECT candidate.trace, candidate.answer_status, candidate.answer_cause
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
           CASE WHEN a.answer_status = 'failed' THEN a.answer_cause ELSE '' END AS cause,
           a.trace,
           jsonb_typeof(a.trace->'stages') = 'array' AS tool_evidence
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
           ${canonicalToolSql('stage.value')} AS tool,
           CASE WHEN COALESCE(stage.value->>'calls', '') ~ '^[0-9]+$'
                THEN (stage.value->>'calls')::int ELSE 1 END AS calls,
           3 AS source_priority,
           3 AS status_priority
    FROM population p
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(p.trace->'stages') = 'array' THEN p.trace->'stages' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS stage(value, ordinality)
    WHERE ${canonicalToolSql('stage.value')} IS NOT NULL
  ),
  durable_stage_snapshots AS (
    SELECT p.event_id,
           COALESCE(NULLIF(e.payload->>'id', ''), 'run-event:' || e.seq::text) AS call_id,
           e.payload,
           e.seq,
           CASE WHEN e.payload->>'status' IN ('complete', 'failed', 'partial', 'refused')
                THEN 2 ELSE 1 END AS status_priority
    FROM population p
    JOIN ${APP_SCHEMA}.run_events e ON e.run_id = p.run_id
    WHERE e.event_type = 'stage'
  ),
  durable_tool_events AS (
    SELECT DISTINCT ON (event_id, call_id)
           event_id,
           call_id,
           ${canonicalToolSql('payload')} AS tool,
           CASE WHEN COALESCE(e.payload->>'calls', '') ~ '^[0-9]+$'
                THEN (e.payload->>'calls')::int ELSE 1 END AS calls,
           2 AS source_priority,
           status_priority
    FROM durable_stage_snapshots e
    WHERE ${canonicalToolSql('payload')} IS NOT NULL
    ORDER BY event_id, call_id, status_priority DESC, seq DESC
  ),
  deduped_tool_events AS (
    SELECT DISTINCT ON (event_id, call_id) event_id, call_id, tool, calls
    FROM (
      SELECT * FROM answer_tool_events
      UNION ALL
      SELECT * FROM durable_tool_events
    ) evidence
    ORDER BY event_id, call_id, source_priority DESC, status_priority DESC
  )`;
}

function metricSelect(population: string, tools: string): string {
  return `SELECT 'population' AS kind, '' AS key, COUNT(*)::bigint AS count
  FROM ${population}
  UNION ALL
  SELECT 'outcome_covered', '', COUNT(*)::bigint
  FROM ${population}
  WHERE cause NOT IN (
    'UNKNOWN_FAILURE_CAUSE',
    'UNKNOWN_REFUSAL_CAUSE',
    'UNKNOWN_STORED_ANSWER_FAILURE'
  )
  UNION ALL
  SELECT 'tool_covered', '', COUNT(*)::bigint
  FROM ${population}
  WHERE tool_evidence
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
    WHERE $1 = 'UTC'
      AND evidence_version = ${TRAFFIC_EVIDENCE_VERSION}
      AND day BETWEEN $2::date AND $3::date
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
    SELECT 'outcome_covered', '', SUM(outcome_covered_count)::bigint FROM selected_rollups
    UNION ALL
    SELECT 'tool_covered', '', SUM(tool_covered_count)::bigint FROM selected_rollups
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
         CASE
           WHEN ${answerStatus} <> 'failed' THEN ''
           WHEN EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(m.response_json->'caveats') = 'array'
                    THEN m.response_json->'caveats' ELSE '[]'::jsonb END
             ) caveat
             WHERE caveat ~* 'APITimeoutError|Request timed out|reasoning endpoint.*not reachable'
           ) THEN 'REASONING_ENDPOINT_TIMEOUT'
           WHEN EXISTS (
             SELECT 1 FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(m.response_json->'trace'->'stages') = 'array'
                    THEN m.response_json->'trace'->'stages' ELSE '[]'::jsonb END
             ) stage
             WHERE stage->>'status' = 'failed' AND stage->>'output' ~* 'UNRESOLVED_COLUMN'
           ) THEN 'SQL_UNRESOLVED_COLUMN'
           WHEN EXISTS (
             SELECT 1 FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(m.response_json->'trace'->'stages') = 'array'
                    THEN m.response_json->'trace'->'stages' ELSE '[]'::jsonb END
             ) stage
             WHERE stage->>'status' = 'failed' AND stage->>'kind' = 'sql'
           ) THEN 'SQL_TOOL_FAILURE'
           WHEN jsonb_path_exists(
             m.response_json->'trace',
             '$.stages[*] ? (@.id == "synthesis" && @.status == "failed")'
           ) THEN 'ANSWER_SYNTHESIS_FAILED'
           ELSE 'UNKNOWN_STORED_ANSWER_FAILURE'
         END AS cause,
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
         ${canonicalToolSql('stage.value')} AS tool,
         CASE WHEN COALESCE(stage.value->>'calls', '') ~ '^[0-9]+$'
              THEN (stage.value->>'calls')::int ELSE 1 END AS calls
  FROM answers a
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(a.trace->'stages') = 'array' THEN a.trace->'stages' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS stage(value, ordinality)
  WHERE ${canonicalToolSql('stage.value')} IS NOT NULL
)
SELECT 'population' AS kind, '' AS key, COUNT(*)::bigint AS count FROM answers
UNION ALL
SELECT 'outcome_covered', '', COUNT(*)::bigint FROM answers
WHERE cause <> 'UNKNOWN_STORED_ANSWER_FAILURE'
UNION ALL
SELECT 'tool_covered', '', COUNT(*)::bigint FROM answers
WHERE jsonb_typeof(trace->'stages') = 'array'
UNION ALL
SELECT 'failure', cause, COUNT(*)::bigint
FROM answers WHERE answer_status = 'failed' GROUP BY cause
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
  (day, run_count, failure_causes, refusal_causes, tool_calls,
   outcome_covered_count, tool_covered_count, evidence_version, completed_at)
SELECT $1::date,
       (SELECT COUNT(*)::int FROM population),
       COALESCE((SELECT jsonb_object_agg(cause, count) FROM failure_counts), '{}'::jsonb),
       COALESCE((SELECT jsonb_object_agg(cause, count) FROM refusal_counts), '{}'::jsonb),
       COALESCE((SELECT jsonb_object_agg(tool, count) FROM tool_counts), '{}'::jsonb),
       (SELECT COUNT(*)::int FROM population
         WHERE cause NOT IN (
           'UNKNOWN_FAILURE_CAUSE',
           'UNKNOWN_REFUSAL_CAUSE',
           'UNKNOWN_STORED_ANSWER_FAILURE'
         )),
       (SELECT COUNT(*)::int FROM population WHERE tool_evidence),
       ${TRAFFIC_EVIDENCE_VERSION},
       NOW()
ON CONFLICT (day) DO UPDATE SET
  run_count = EXCLUDED.run_count,
  failure_causes = EXCLUDED.failure_causes,
  refusal_causes = EXCLUDED.refusal_causes,
  tool_calls = EXCLUDED.tool_calls,
  outcome_covered_count = EXCLUDED.outcome_covered_count,
  tool_covered_count = EXCLUDED.tool_covered_count,
  evidence_version = EXCLUDED.evidence_version,
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
  if (key === 'REASONING_ENDPOINT_TIMEOUT') return 'Reasoning endpoint timed out';
  if (key === 'SQL_UNRESOLVED_COLUMN') return 'SQL referenced a missing column';
  if (key === 'SQL_TOOL_FAILURE') return 'SQL query failed';
  if (key === 'ANSWER_SYNTHESIS_FAILED') return 'Answer synthesis failed';
  if (key === 'unknown_tool') return 'Unknown tool';
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
  let outcomeCovered: number | null = null;
  let toolCovered: number | null = null;
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
    if (kind === 'outcome_covered') {
      outcomeCovered = parsed;
      continue;
    }
    if (kind === 'tool_covered') {
      toolCovered = parsed;
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
  const coverageFor = (covered: number | null, noun: string): TrafficBreakdownCoverage => {
    if (population === null) {
      return {
        state: 'unavailable',
        coveredRuns: 0,
        reason: input.reason || 'The run population row was missing, so zero was not established.',
      };
    }
    const safeCovered = Math.min(population, Math.max(0, covered ?? 0));
    const incomplete = covered === null || safeCovered < population;
    const state =
      malformed || requested === 'partial' || incomplete
        ? 'partial'
        : requested === 'unavailable'
          ? 'unavailable'
          : 'complete';
    const reason =
      input.reason ||
      (malformed
        ? 'One or more aggregate rows were malformed and were withheld.'
        : incomplete
          ? `${safeCovered} of ${population} recorded runs have ${noun} evidence.`
          : '');
    return { state, coveredRuns: safeCovered, reason };
  };
  return {
    runsInRange: population ?? 0,
    failuresByCause: sortedBars(failures, 'failure'),
    refusalsByCause: sortedBars(refusals, 'refusal'),
    toolCalls: sortedBars(tools, 'tool'),
    outcomesCoverage: coverageFor(outcomeCovered, 'specific outcome'),
    toolCallsCoverage: coverageFor(toolCovered, 'named stage'),
  };
}
