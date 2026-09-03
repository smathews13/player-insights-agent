/**
 * The read side of Monitoring: every question anyone asked, and one question in
 * full.
 *
 * WHAT THESE ROUTES DO NOT DO. They do not decide who may call them. The admin
 * guard is owned elsewhere and is passed in at registration, and
 * {@link setupMonitoringRoutes} refuses to register a single route without one.
 * That is deliberate: a guard with a default is a guard somebody forgets to pass,
 * and the failure is silent and serves everybody's conversations to everybody.
 *
 * WHERE THE NUMBERS COME FROM. Questions and answers are stored messages.
 * Outcomes are the run ledger's terminal state, falling back to the stored
 * trace for questions asked before the ledger existed. Ratings are feedback
 * rows. Tables read are the fully-qualified names the agent recorded on each
 * answer as its sources. Nothing here computes a figure from anything else, and
 * nothing here has a placeholder: where a value was not recorded the field is
 * null and the page says so in words.
 *
 * THE LEDGER IS READ SEPARATELY AND MAY FAIL. `${APP_SCHEMA}.runs` is created
 * by a DDL statement that a database can legitimately refuse when the app's role
 * does not own the schema, so joining it into the main query would make an
 * absent ledger take the whole page down. It is a second read, and its failure
 * costs the outcome precision the trace fallback cannot provide rather than
 * costing the page.
 */
import { APP_SCHEMA } from '../../shared/app-schema';
import {
  ANSWER_LANDED_SQL,
  bindSynthesisIncompleteSql,
  PROSE_ONLY_DEGRADED_SQL,
  VERDICT_STAGE_EXEMPTION_SQL,
} from '../../shared/run-verdict';
import { overlayJoinSql } from '../lib/run-label-overrides';
import type { Application, Request, Response } from 'express';
import {
  applyAdminOutcome,
  applyAdminFeedback,
  classifyOutcome,
  classifyRefusal,
  refusalSentence,
  type MonitoringDetail,
  type MonitoringPagination,
  type MonitoringQuestion,
  type MonitoringQuestionsPayload,
  type MonitoringSummary,
  type PersonPanelPayload,
  type QuestionOutcome,
} from '../../shared/monitoring-contract';
import { feedbackDirection } from '../../shared/feedback-direction';
import { runRuntimeUsedFromStored } from '../../shared/run-runtime-used';
import { chooseRows, markResponse, readStored } from '../lib/lakebase-store';
import { workspaceLinksAllowed } from '../lib/egress-store';
import { resolveGrants, conditioningFor, type GrantResolution, type TableProbe } from '../lib/monitoring-grants';
import { accessDependenciesFrom, forwardedUserToken, statementRunnerFor } from './access-verification';
import { mlflowReference, userEmail, PLAN_APPROVAL_MESSAGE, type InsightsAppKit } from './insights-routes';
import { resolveExperimentId } from '../lib/app-settings';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import { APP_ACTIVITY_TABLE } from '../lib/app-activity';
import { APP_SESSION_TABLE, appSessionDeployment } from '../lib/app-session';
import { effectiveRole, everyKnownUser, readRosterForRequest } from '../lib/user-roster';
import { invalidAdminEmail, seedRoles } from '../lib/admin-roles';
import { listSpAssignments, listSpPersonas } from '../lib/sp-identity-store';
import type { TraceTokenEvidenceReader } from '../lib/mlflow-token-evidence';
import { isMlflowTraceId } from '../../shared/mlflow-trace-id';
import type { TokenAttribution } from '../../shared/llm-token-usage';
import { listDeclarableTablesInSchema, unionTableNames } from '../lib/declared-tables';

/**
 * Default and hard maximum for one API page. The query asks for one look-ahead
 * row to establish `hasMore`; that row is never returned.
 */
export const QUESTION_PAGE_SIZE = 50;
export const QUESTION_READ_LIMIT = 100;

/** The compact person panel shows no more than this many recorded source tables. */
export const MONITORING_TOP_TABLE_LIMIT = 5;

/**
 * What a caller is told when they ask for a page starting part way in.
 *
 * Said to the caller rather than logged, because the caller is the only person
 * who can do anything about it, and because the alternative is a page that
 * looks right and is missing a row.
 */
export const OFFSET_REFUSAL = 'Use the opaque cursor from pagination.nextCursor instead of an offset.';

interface QuestionCursor {
  askedAt: string;
  id: string;
}

function encodeCursor(cursor: QuestionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): QuestionCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<QuestionCursor>;
    const askedAt = typeof parsed.askedAt === 'string' ? new Date(parsed.askedAt).toISOString() : '';
    const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
    return askedAt && id ? { askedAt, id } : null;
  } catch {
    return null;
  }
}

/** Opaque cursor exported for route-contract tests. */
export function monitoringCursor(askedAt: string, id: string): string {
  return encodeCursor({ askedAt: new Date(askedAt).toISOString(), id });
}

/**
 * One stable keyset page. The cursor contains the final `(asked_at, id)` tuple
 * from the prior page, matching the query's total order. Offsets remain refused
 * so concurrent inserts cannot shift a later page under the caller.
 */
export function pageFrom(req: Request): {
  limit: number;
  cursor: QuestionCursor | null;
  refusal: string;
} {
  const limit = Number.parseInt(queryString(req.query.limit), 10);
  const offset = Number.parseInt(queryString(req.query.offset), 10);
  const rawCursor = queryString(req.query.cursor).trim();
  const cursor = decodeCursor(rawCursor);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, QUESTION_READ_LIMIT) : QUESTION_PAGE_SIZE,
    cursor,
    refusal:
      Number.isFinite(offset) && offset > 0
        ? OFFSET_REFUSAL
        : rawCursor && !cursor
          ? 'The Monitoring page cursor is invalid. Start again without a cursor.'
          : '',
  };
}

/**
 * Questions in a range, with the answer that followed each and how it was rated.
 *
 * `$1` is the plan-approval sentinel, which is a stored user message and is not a
 * question anybody asked. `$2` and `$3` bound the range. `$4` is one more than
 * the requested page size, `$5` optionally scopes to one person, `$6`/`$7` are
 * the keyset cursor, and `$8` is question-or-asker search.
 *
 * An answer is an assistant message that CARRIES A TRACE, which is the same
 * definition `RUNS_QUERY` uses in insights-routes.ts, and the reason this reads
 * the way it does. A conversation that went through plan approval stores three
 * assistant turns: the proposed plan, then the answer. The plan carries no
 * trace. Walking forward from the question to the first assistant message
 * therefore landed on the plan and called it the answer, which is how a run with
 * a recorded duration, seven tool calls and a rating came back with none of the
 * three: they are on the answer, and this was reading the plan. Rows that did
 * show a time were the conversations that skipped approval, so nothing looked
 * uniformly broken.
 *
 * The pairing runs BACKWARD from the answer for the same reason `RUNS_QUERY`
 * does: the approval turn is a stored user message, so the last user message
 * before an answer is the approval rather than the question unless the sentinel
 * in `$1` is skipped. Going backward also stops an unanswered question from
 * adopting the next question's answer, which a forward walk bounded only by time
 * would have done.
 *
 * `answers` has no upper time bound because an answer can land after the range
 * ends for a question asked just inside it, and that answer is still this
 * question's. The lower bound holds because an answer cannot precede its
 * question.
 *
 * The feedback row is the ASKER'S own, scoped by their email rather than the
 * reading admin's. That is the one deliberate difference from `RUNS_QUERY`,
 * which scopes to the caller because a reader there is looking at their own
 * runs. An admin reading someone else's question wants the rating that person
 * gave, and scoping to the admin would have shown "not rated" for every row.
 *
 * ── THE ALL-TIME RANGE, AND HOW IT STOPPED BEING QUADRATIC ──
 *
 * This query used to be quadratic in the number of rows in the range, and an
 * all-time window reached it. The cause was structural rather than a missing
 * index: an `answers` CTE computed each answer's `question_id` with a correlated
 * scalar subquery, and the join was on the RESULT of that computation
 * (`WHERE a2.question_id = q.question_id`). A scalar subquery result is not a
 * column, so no index could ever serve that predicate, and Postgres had to
 * evaluate the pairing once per question in the range.
 *
 * It is now paired in the other direction, which is what makes an all-time
 * window cost what a day costs:
 *
 *   1. `page` takes the newest `$4` questions in the range and nothing else.
 *      `messages_created_at_idx` serves that directly, walked backward, and it
 *      stops as soon as the page is full. Nothing here reads an answer.
 *   2. For each of those (at most `$4`) questions, two INDEXED lookups on
 *      `(conversation_id, created_at)`, which is what
 *      `messages_conversation_created_idx` (added 2026-08-16, see
 *      `schemaStatements` in insights-routes.ts) exists for: where the next
 *      question in that conversation is, and the first traced answer before it.
 *
 * So the answer-side work is bounded by the PAGE, whatever the window. The one
 * part still proportional to the range is `range_totals`, deliberately: see its
 * note below.
 *
 * ── THE PAIRING RULE IS UNCHANGED, AND IT IS THE PART TO BE CAREFUL WITH ──
 *
 * The rule is still exactly what `RUNS_QUERY` uses and what the recorded pairing
 * bugs above were fixed to: an answer belongs to the LAST non-sentinel user
 * message at or before it. Expressed forward, that is a traced assistant message
 * at or after the question and STRICTLY BEFORE the next non-sentinel user
 * message in the conversation -- because if another question had landed in
 * between, the answer would belong to that one.
 *
 * WHICH of the window's messages is the answer was the third pairing bug. It was
 * the FIRST, and on an approved-plan turn the window holds the proposed plan as
 * well as the answer, so Monitoring served the plan's trace: no `totalMs`, no
 * `toolCalls`, blank Time and Tools on a run whose figures Run Explorer was
 * showing on the next tab. It is now the message that carries the figures, which
 * is the turn's final answer. Two surfaces do not make different claims about
 * one fact; see D13 in bundle/DECISIONS.md.
 *
 * The `< COALESCE(next question, 'infinity')` bound is therefore not an
 * optimisation, it is the pairing rule. Remove it and an unanswered question
 * adopts the next question's answer, which is one of the two bugs above.
 *
 * `m.created_at >= q.asked_at` replaces the old `m.created_at >= $2` and is
 * strictly tighter and per question. Note what is still absent: NO upper bound
 * at `$3`. An answer can land after the range ends for a question asked just
 * inside it, and that answer is still this question's.
 *
 * ── WHAT THE TOTALS COST, AND WHY THEY ARE IN HERE ──
 *
 * `range_totals` counts the range's questions and distinct conversation threads,
 * and lists its askers. It was two further round
 * trips (`MONITORING_TOTALS_QUERY` and `MONITORING_PEOPLE_QUERY`, both deleted),
 * folded in here so a Monitoring refresh is one statement rather than three.
 *
 * It is deliberately NOT a window function over the page, though the plan called
 * for one. `COUNT(*) OVER ()` after a `LIMIT` counts the PAGE, and the whole
 * reason these totals exist is to be the range's real figures when the page is
 * truncated -- a window function would have quietly turned "2000 of 40000
 * questions" into "2000 of 2000". `COUNT(DISTINCT ...) OVER ()` is not
 * implemented in Postgres at all. So they are a one-row aggregate CTE joined
 * onto the page, which is the same single round trip and the correct numbers.
 *
 * They stay proportional to the range, and that is the accepted cost of an exact
 * denominator: an index range scan and a hash aggregate, no answers read and no
 * jsonb touched. The expensive half was never the counting.
 *
 * MEASURE BEFORE CHANGING ANY OF IT. Two pairing bugs are recorded above, one of
 * which served a plan's trace as the answer's. Do NOT fetch credentials and
 * explain it against the deployed branch from a laptop: a local process holding
 * a connection to that branch is how tables came to be owned by the wrong role
 * and blocked a release.
 *
 * See section 5.8 of the admin Monitoring and Ops plan for all of it.
 */
export const MONITORING_QUESTIONS_QUERY = `
  WITH page AS (
    SELECT u.id AS question_id, u.conversation_id, u.content AS question,
           u.created_at AS asked_at, c.user_email
    FROM ${APP_SCHEMA}.messages u
    JOIN ${APP_SCHEMA}.conversations c ON c.id = u.conversation_id
    WHERE u.role = 'user' AND u.content <> $1
      AND u.created_at >= $2::timestamptz AND u.created_at < $3::timestamptz
      AND ($5 = '' OR lower(c.user_email) = lower($5))
      AND ($6 = '' OR (u.created_at, u.id) < ($6::timestamptz, $7))
      AND (
        $8 = ''
        OR lower(u.content) LIKE ('%' || lower($8) || '%')
        OR lower(c.user_email) LIKE ('%' || lower($8) || '%')
      )
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT $4
  ),
  range_totals AS (
    SELECT COUNT(*)::int AS asked_total,
           COUNT(DISTINCT u.conversation_id)::int AS thread_total,
           COALESCE(array_agg(DISTINCT c.user_email), ARRAY[]::text[]) AS people_list
    FROM ${APP_SCHEMA}.messages u
    JOIN ${APP_SCHEMA}.conversations c ON c.id = u.conversation_id
    WHERE u.role = 'user' AND u.content <> $1
      AND u.created_at >= $2::timestamptz AND u.created_at < $3::timestamptz
      AND ($5 = '' OR lower(c.user_email) = lower($5))
      AND (
        $8 = ''
        OR lower(u.content) LIKE ('%' || lower($8) || '%')
        OR lower(c.user_email) LIKE ('%' || lower($8) || '%')
      )
  )
  SELECT t.asked_total, t.thread_total, t.people_list,
         q.question_id, q.conversation_id, q.question, q.asked_at, q.user_email,
         a.id AS answer_id, a.trace_id,
         a.execution_mode, a.execution_identity_verified, a.access_mode,
         a.response_json->'trace'->>'totalMs' AS total_ms,
         a.response_json->'trace'->>'toolCalls' AS tool_calls,
         a.response_json->'trace'->>'total_tokens' AS total_tokens,
         jsonb_path_exists(a.response_json->'trace', '$.stages[*] ? (@.status == "failed" ${VERDICT_STAGE_EXEMPTION_SQL})') AS trace_failed,
         jsonb_path_exists(
           a.response_json->'trace',
           '$.stages[*] ? (@.status == "partial" ${VERDICT_STAGE_EXEMPTION_SQL})'
         ) AS trace_partial,
         ${ANSWER_LANDED_SQL.split('payload').join('a.response_json')} AS answer_landed,
         ${bindSynthesisIncompleteSql("a.response_json->'trace'", "a.response_json->'caveats'")} AS synthesis_incomplete,
         ${PROSE_ONLY_DEGRADED_SQL.split('payload').join('a.response_json').split('caveats').join("a.response_json->'caveats'")} AS prose_only_degraded,
         label_overlay.status AS overlay_status,
         label_overlay.rating AS overlay_rating,
         (SELECT COALESCE(jsonb_agg(s->>'name'), '[]'::jsonb)
            FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(a.response_json->'sources') = 'array'
                        THEN a.response_json->'sources' ELSE '[]'::jsonb END) s
           WHERE s->>'name' IS NOT NULL) AS sources,
         f.sentiment, f.usefulness, f.comment
  FROM range_totals t
  LEFT JOIN page q ON TRUE
  LEFT JOIN LATERAL (
    SELECT m.id, m.response_json, m.trace_id, m.execution_mode,
           m.execution_identity_verified, m.access_mode
    FROM ${APP_SCHEMA}.messages m
    WHERE m.conversation_id = q.conversation_id
      AND m.role = 'assistant'
      AND jsonb_typeof(m.response_json->'trace') = 'object'
      AND m.created_at >= q.asked_at
      AND m.created_at < COALESCE(
            (SELECT MIN(u.created_at) FROM ${APP_SCHEMA}.messages u
              WHERE u.conversation_id = q.conversation_id AND u.role = 'user'
                AND u.content <> $1 AND u.created_at > q.asked_at),
            'infinity'::timestamptz)
    -- The turn's FINAL assistant message, not its first. A turn that went
    -- through plan approval has the proposed plan in this window as well as the
    -- answer, and the plan's trace carries neither \`totalMs\` nor \`toolCalls\`.
    -- Taking the first left Monitoring's Time and Tools blank for exactly those
    -- turns while Run Explorer, which reads the answer, showed both. The
    -- \`totalMs\` test leads so the row carrying the figures wins outright rather
    -- than by being latest; \`created_at DESC\` settles the rest.
    ORDER BY (m.response_json->'trace'->>'totalMs') IS NOT NULL DESC,
             m.created_at DESC
    LIMIT 1
  ) a ON TRUE
  LEFT JOIN LATERAL (
    SELECT fb.sentiment, fb.usefulness, fb.comment
    FROM ${APP_SCHEMA}.feedback fb
    WHERE fb.message_id = a.id AND fb.user_email = q.user_email
    ORDER BY fb.created_at DESC LIMIT 1
  ) f ON TRUE
  ${overlayJoinSql('a.id')}
  ORDER BY q.asked_at DESC, q.question_id DESC
`;

/**
 * The ledger's verdict for a set of answers.
 *
 * Read on its own. See the note at the top of the file: the ledger's table can
 * be legitimately absent, and an absent ledger must cost outcome precision
 * rather than the page.
 */
export const MONITORING_LEDGER_QUERY = `
  SELECT terminal_message_id AS answer_id, state, terminal_code
  FROM ${APP_SCHEMA}.runs
  WHERE terminal_message_id = ANY($1::text[])
`;

/**
 * One question, its answer, and everything the drawer shows.
 *
 * Same answer definition and same backward pairing as
 * `MONITORING_QUESTIONS_QUERY`, and for the same reason: the drawer opened on a
 * row was showing the proposed plan's trace, so a run whose timeline had a
 * duration for every step opened onto nothing. `$2` is the plan-approval
 * sentinel here.
 */
export const MONITORING_DETAIL_QUERY = `
  SELECT q.id AS question_id, q.conversation_id, q.content AS question,
         q.created_at AS asked_at, c.user_email,
         a.id AS answer_id, a.trace_id, a.response_json,
         jsonb_path_exists(a.response_json->'trace', '$.stages[*] ? (@.status == "failed" ${VERDICT_STAGE_EXEMPTION_SQL})') AS trace_failed,
         jsonb_path_exists(
           a.response_json->'trace',
           '$.stages[*] ? (@.status == "partial" ${VERDICT_STAGE_EXEMPTION_SQL})'
         ) AS trace_partial,
         ${ANSWER_LANDED_SQL.split('payload').join('a.response_json')} AS answer_landed,
         ${bindSynthesisIncompleteSql("a.response_json->'trace'", "a.response_json->'caveats'")} AS synthesis_incomplete,
         ${PROSE_ONLY_DEGRADED_SQL.split('payload').join('a.response_json').split('caveats').join("a.response_json->'caveats'")} AS prose_only_degraded,
         label_overlay.status AS overlay_status,
         label_overlay.rating AS overlay_rating,
         a.execution_mode, a.execution_identity_verified,
         (SELECT COALESCE(jsonb_agg(s->>'name'), '[]'::jsonb)
            FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(a.response_json->'sources') = 'array'
                        THEN a.response_json->'sources' ELSE '[]'::jsonb END) s
           WHERE s->>'name' IS NOT NULL) AS sources,
         f.sentiment, f.usefulness, f.comment
  FROM ${APP_SCHEMA}.messages q
  JOIN ${APP_SCHEMA}.conversations c ON c.id = q.conversation_id
  LEFT JOIN LATERAL (
    SELECT m.id, m.response_json, m.trace_id, m.execution_mode, m.execution_identity_verified
    FROM ${APP_SCHEMA}.messages m
    WHERE m.conversation_id = q.conversation_id AND m.role = 'assistant'
      AND jsonb_typeof(m.response_json->'trace') = 'object'
      AND m.created_at >= q.created_at
      AND (SELECT u.id FROM ${APP_SCHEMA}.messages u
            WHERE u.conversation_id = m.conversation_id AND u.role = 'user'
              AND u.content <> $2 AND u.created_at <= m.created_at
            ORDER BY u.created_at DESC LIMIT 1) = q.id
    -- Same "the answer, not the plan" rule as MONITORING_QUESTIONS_QUERY, and
    -- for the same reason: the drawer opened on an approved-plan row was reading
    -- the plan's trace, so it disagreed with the row it was opened from.
    ORDER BY (m.response_json->'trace'->>'totalMs') IS NOT NULL DESC,
             m.created_at DESC
    LIMIT 1
  ) a ON TRUE
  LEFT JOIN LATERAL (
    SELECT fb.sentiment, fb.usefulness, fb.comment
    FROM ${APP_SCHEMA}.feedback fb
    WHERE fb.message_id = a.id AND fb.user_email = c.user_email
    ORDER BY fb.created_at DESC LIMIT 1
  ) f ON TRUE
  ${overlayJoinSql('a.id')}
  WHERE q.id = $1 AND q.role = 'user'
    AND q.created_at >= $3::timestamptz AND q.created_at < $4::timestamptz
`;

/** First and last retained durable app activity, never roster or ACL membership. */
export const MONITORING_PERSON_SEEN_QUERY = `
  WITH evidence AS (
    SELECT u.created_at AS occurred_at
    FROM ${APP_SCHEMA}.messages u
    JOIN ${APP_SCHEMA}.conversations c ON c.id = u.conversation_id
    WHERE u.role = 'user' AND u.content <> $1 AND c.user_email = $2
    UNION ALL
    SELECT r.created_at
    FROM ${APP_SCHEMA}.runs r
    WHERE lower(r.user_email) = lower($2)
    UNION ALL
    SELECT f.created_at
    FROM ${APP_SCHEMA}.feedback f
    WHERE lower(f.user_email) = lower($2)
    UNION ALL
    SELECT a.active_minute
    FROM ${APP_ACTIVITY_TABLE} a
    WHERE lower(a.user_email) = lower($2)
    UNION ALL
    SELECT s.created_at
    FROM ${APP_SESSION_TABLE} s
    WHERE s.deployment_key = $3 AND lower(s.subject) = lower($2)
  )
  SELECT MIN(occurred_at) AS first_seen, MAX(occurred_at) AS last_seen
  FROM evidence
`;

/**
 * The most-read recorded source tables for one person over the whole selected
 * period, independent of the question-list page cap.
 *
 * `$1` is the approval sentinel, `$2`/`$3` are the half-open period, `$4` is the
 * person, and `$5` is the compact result cap. A repeated source entry contributes
 * once because the final count is distinct by answer id and normalized table
 * name. Configured tables never enter this query.
 */
export const MONITORING_PERSON_TABLES_QUERY = `
  WITH asked AS (
    SELECT u.id AS question_id, u.conversation_id, u.created_at AS asked_at
    FROM ${APP_SCHEMA}.messages u
    JOIN ${APP_SCHEMA}.conversations c ON c.id = u.conversation_id
    WHERE u.role = 'user' AND u.content <> $1
      AND u.created_at >= $2::timestamptz AND u.created_at < $3::timestamptz
      AND lower(c.user_email) = lower($4)
  ),
  answered AS (
    SELECT q.question_id, a.id AS answer_id, a.response_json
    FROM asked q
    JOIN LATERAL (
      SELECT m.id, m.response_json
      FROM ${APP_SCHEMA}.messages m
      WHERE m.conversation_id = q.conversation_id
        AND m.role = 'assistant'
        AND jsonb_typeof(m.response_json->'trace') = 'object'
        AND m.created_at >= q.asked_at
        AND m.created_at < COALESCE(
              (SELECT MIN(u.created_at) FROM ${APP_SCHEMA}.messages u
                WHERE u.conversation_id = q.conversation_id AND u.role = 'user'
                  AND u.content <> $1 AND u.created_at > q.asked_at),
              'infinity'::timestamptz)
      ORDER BY (m.response_json->'trace'->>'totalMs') IS NOT NULL DESC,
               m.created_at DESC
      LIMIT 1
    ) a ON TRUE
  ),
  source_runs AS (
    SELECT lower(source->>'name') AS table_key,
           MIN(source->>'name') AS table_name,
           COUNT(DISTINCT a.answer_id)::int AS runs
    FROM answered a
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(a.response_json->'sources') = 'array'
           THEN a.response_json->'sources' ELSE '[]'::jsonb END
    ) source
    WHERE source->>'name' ~ '^[^.]+[.][^.]+[.][^.]+$'
    GROUP BY lower(source->>'name')
  )
  SELECT table_name, runs
  FROM source_runs
  ORDER BY runs DESC, table_name ASC
  LIMIT $5
`;

/** Verified user-token reads for the declared-table ledger; never an app-SP permission inference. */
export const MONITORING_PERSON_TABLE_EVIDENCE_QUERY = `
  WITH asked AS (
    SELECT u.conversation_id, u.created_at AS asked_at
    FROM ${APP_SCHEMA}.messages u
    JOIN ${APP_SCHEMA}.conversations c ON c.id = u.conversation_id
    WHERE u.role = 'user' AND u.content <> $1
      AND u.created_at >= $2::timestamptz AND u.created_at < $3::timestamptz
      AND lower(c.user_email) = lower($4)
  ),
  answered AS (
    SELECT a.id AS answer_id, a.response_json, a.created_at
    FROM asked q
    JOIN LATERAL (
      SELECT m.id, m.response_json, m.created_at
      FROM ${APP_SCHEMA}.messages m
      WHERE m.conversation_id = q.conversation_id
        AND m.role = 'assistant'
        AND m.execution_mode = 'signed_in_user'
        AND m.execution_identity_verified = TRUE
        AND jsonb_typeof(m.response_json->'sources') = 'array'
        AND m.created_at >= q.asked_at
      ORDER BY m.created_at DESC
      LIMIT 1
    ) a ON TRUE
  )
  SELECT lower(source->>'name') AS table_key,
         COUNT(DISTINCT answered.answer_id)::int AS runs,
         MAX(answered.created_at) AS latest_read_at
  FROM answered
  CROSS JOIN LATERAL jsonb_array_elements(answered.response_json->'sources') source
  WHERE lower(source->>'name') = ANY($5::text[])
  GROUP BY lower(source->>'name')
`;

/**
 * The tables PIA is configured to read, which is what the grants table lists.
 *
 * Through the access gate's own resolver rather than reading an environment
 * variable here. There are two variables and one of them wins: a deployment
 * configured with `PLAYER_INSIGHTS_DECLARED_MANIFEST` and no
 * `PLAYER_INSIGHTS_TABLES` is ordinary, and a reader of only the second would
 * have found nothing and reported that this person's grants could not be read.
 * That is a sentence about a permission check, produced by a deployment that is
 * configured correctly.
 */
function manifestTables(): readonly string[] {
  return accessDependenciesFrom({ env: process.env }).tables;
}

async function declaredTablesForRequest(req: Request): Promise<string[]> {
  const configured = manifestTables();
  const discovered = await listDeclarableTablesInSchema({
    catalog: (process.env.PLAYER_INSIGHTS_CATALOG ?? '').trim(),
    schema: (process.env.PLAYER_INSIGHTS_SCHEMA ?? '').trim(),
    host: normalizeWorkspaceHost(process.env.DATABRICKS_HOST),
    token: forwardedUserToken(req) ?? '',
    denylist: (process.env.PLAYER_INSIGHTS_CATALOG_DENYLIST ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  });
  return unionTableNames(configured, discovered);
}

export function liveSelfGrantLedger(
  tables: readonly string[],
  resolution: GrantResolution
): NonNullable<PersonPanelPayload['grants']> {
  return tables.map((table) => {
    const verdict = resolution.verdicts.get(table);
    return {
      table,
      canRead: verdict?.status === 'ok' ? true : verdict?.status === 'denied' ? false : null,
      missing: verdict?.status === 'denied' ? (verdict.missing?.permission ?? 'SELECT missing') : null,
      rowFilter: null,
      maskedColumns: null,
      source: 'live-user-probe',
      verifiedRuns: 0,
      latestVerifiedReadAt: null,
    };
  });
}

export function historicalGrantLedger(
  tables: readonly string[],
  rows: readonly Record<string, unknown>[]
): NonNullable<PersonPanelPayload['grants']> {
  const evidence = new Map(
    rows.map((row) => [
      text(row.table_key).toLowerCase(),
      { runs: integer(row.runs) ?? 0, latest: stamp(row.latest_read_at) || null },
    ])
  );
  return tables.map((table) => {
    const recorded = evidence.get(table.toLowerCase());
    return {
      table,
      canRead: recorded && recorded.runs > 0 ? true : null,
      missing: null,
      rowFilter: null,
      maskedColumns: null,
      source: recorded && recorded.runs > 0 ? 'verified-run' : 'no-evidence',
      verifiedRuns: recorded?.runs ?? 0,
      latestVerifiedReadAt: recorded?.latest ?? null,
    };
  });
}

/**
 * The approval turn's exact text, from the module that writes it.
 *
 * Not a second copy of the literal. Every query here skips this string, so a
 * copy that drifted from the writer would silently start counting approvals as
 * questions and pairing answers to the approval instead of the question.
 */
const PLAN_APPROVAL_SENTINEL = PLAN_APPROVAL_MESSAGE;

/**
 * One query parameter as a string, or ''.
 *
 * Express types a parameter as a string, an array of them, or a nested object,
 * because `?from=a&from=b` and `?from[x]=y` are both things a caller can send.
 * Only the plain string is used: the other two are a caller sending something
 * this route does not accept, and '' sends them to the documented fallback rather
 * than into a cast that would reach a SQL timestamp as `[object Object]`.
 */
function queryString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/* ── Row shaping ─────────────────────────────────────────────────────────── */

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A whole number, or null.
 *
 * Postgres hands back `numeric` and `bigint` as strings, so both shapes arrive
 * here. Anything that is neither is null rather than coerced: `String()` on an
 * object produces `[object Object]`, which parses to NaN and would have become a
 * null anyway, by a route that reads as though it might not.
 */
function integer(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function tokenCount(value: unknown): number | null {
  const parsed = integer(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function stamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const raw = text(value);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function tableList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Map<string, string>();
  for (const entry of value) {
    const name = text(entry).trim();
    // Fully qualified or nothing. A bare table name is the tail of an object
    // rather than an object, it cannot be probed for a grant, and it cannot be
    // linked. Counting one would put a row on the grants table that no GRANT
    // statement could clear.
    if (name.split('.').filter((part) => part.length > 0).length === 3) {
      const normalized = name.toLowerCase();
      if (!seen.has(normalized)) seen.set(normalized, name);
    }
  }
  return [...seen.values()];
}

/** The stored trace, or null. Not conditioned, so it is read on every path. */
function traceOf(response: unknown): unknown {
  if (!response || typeof response !== 'object') return null;
  const trace = (response as { trace?: unknown }).trace;
  return trace && typeof trace === 'object' ? trace : null;
}

/** Attach the same redacted evidence projection Run Explorer uses. */
export function responseWithTokenAttribution(response: unknown, attribution: TokenAttribution | null): unknown {
  if (!response || typeof response !== 'object' || !attribution) return response;
  const answer = response as Record<string, unknown>;
  const trace = traceOf(answer);
  if (!trace || typeof trace !== 'object') return response;
  const traceRecord = trace as Record<string, unknown>;
  const stages: unknown[] = Array.isArray(traceRecord.stages) ? (traceRecord.stages as unknown[]) : [];
  return {
    ...answer,
    trace: {
      ...traceRecord,
      stages: stages.map((stage) => {
        if (!stage || typeof stage !== 'object') return stage;
        const record = stage as Record<string, unknown>;
        const usage = attribution.stages[text(record.id)];
        return usage ? { ...record, token_usage: usage } : record;
      }),
      token_reconciliation: attribution.reconciliation,
      token_invocations: attribution.invocations,
    },
  };
}

/**
 * The three token counts a run recorded, or null where none were.
 *
 * Each half is null on its own when it was not reported. A split printed with a
 * zero in one half claims the model read nothing, or wrote nothing.
 */
function tokensOf(
  response: unknown
): { prompt: number | null; completion: number | null; total: number | null } | null {
  const trace = traceOf(response) as Record<string, unknown> | null;
  if (!trace) return null;
  const prompt = integer(trace.prompt_tokens);
  const completion = integer(trace.completion_tokens);
  const total = integer(trace.total_tokens);
  if (prompt === null && completion === null && total === null) return null;
  return { prompt, completion, total };
}

interface LedgerVerdict {
  state: string;
  code: string | null;
}

/**
 * The rows that are questions.
 *
 * The statement joins one row of range totals to the page, so an empty page
 * still returns that row, carrying the counts and no question. Mapping it as a
 * question would put a row with no id, no asker and no time on the list, which
 * is a fabricated question on a page whose entire job is to report real ones.
 */
export function questionRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.filter((row) => text(row.question_id) !== '');
}

/**
 * The range's own figures, off any row of the same read.
 *
 * Falls back to what the page itself shows if the columns are absent, which is
 * the case for a store fake that predates them. The fallback is a floor, never a
 * claim: `asked` cannot be smaller than the number of rows in hand, so the
 * "partial" flag on the response can only under-report the truncation, never
 * invent one.
 */
export function rangeTotalsFrom(
  row: Record<string, unknown> | undefined,
  page: MonitoringQuestion[]
): { asked: number; threads: number; peopleList: string[] } {
  const asked = integer(row?.asked_total);
  const threads = integer(row?.thread_total);
  const listed = Array.isArray(row?.people_list)
    ? (row.people_list as unknown[]).map((entry) => text(entry)).filter((email) => email !== '')
    : null;
  const fromPage = [...new Set(page.map((question) => question.askedBy).filter((email) => email !== ''))].sort();
  const threadsFromPage = new Set(page.map((question) => question.conversationId).filter(Boolean)).size;
  return {
    asked: asked !== null && asked >= page.length ? asked : page.length,
    threads: threads !== null && threads >= 0 ? threads : threadsFromPage,
    peopleList: listed === null ? fromPage : [...listed].sort(),
  };
}

/**
 * One list row, from a stored question and whatever was recorded beside it.
 */
export function questionFromRow(row: Record<string, unknown>, ledger: Map<string, LedgerVerdict>): MonitoringQuestion {
  const answerId = text(row.answer_id);
  const verdict = answerId ? ledger.get(answerId) : undefined;
  const outcome = applyAdminOutcome(
    classifyOutcome({
      runState: verdict?.state ?? null,
      hasStoredAnswer: answerId !== '',
      traceHasFailedStage: row.trace_failed === true,
      traceHasPartialStage: row.trace_partial === true,
      answerLanded: row.answer_landed === true,
      synthesisIncomplete: row.synthesis_incomplete === true,
      proseOnlyDegraded: row.prose_only_degraded === true,
    }),
    text(row.overlay_status)
  );
  return {
    id: text(row.question_id),
    conversationId: text(row.conversation_id),
    question: text(row.question),
    askedBy: text(row.user_email),
    askedAt: stamp(row.asked_at),
    outcome,
    // The taxonomy's own sentence, and only where a code was recorded. A run
    // that failed without a code gets no `title`, which is honest: this build
    // has no sentence for a failure nobody named.
    outcomeDetail: refusalSentence(verdict?.code),
    durationMs: integer(row.total_ms),
    toolCalls: integer(row.tool_calls),
    totalTokens: tokenCount(row.total_tokens),
    feedback: applyAdminFeedback(feedbackDirection(row.sentiment, row.usefulness), text(row.overlay_rating)),
    tables: tableList(row.sources),
  };
}

/**
 * The five figures, over the rows that were read.
 *
 * `questionsAsked` is the number of rows the figures were computed over, not the
 * number the range holds. The two differ only on a partial read, where the
 * response carries both and the strip says which it is showing.
 */
export function summarize(questions: MonitoringQuestion[], userThreads: number): MonitoringSummary {
  const buckets: Record<QuestionOutcome, number> = { completed: 0, partial: 0, refused: 0, failed: 0 };
  let helpful = 0;
  let feedbackTotal = 0;
  const durations: number[] = [];
  for (const question of questions) {
    buckets[question.outcome] += 1;
    if (question.feedback === 'up') {
      helpful += 1;
      feedbackTotal += 1;
    } else if (question.feedback === 'down') {
      feedbackTotal += 1;
    }
    if (question.durationMs !== null) durations.push(question.durationMs);
  }
  durations.sort((a, b) => a - b);
  return {
    questionsAsked: questions.length,
    userThreads,
    completed: buckets.completed,
    partial: buckets.partial,
    refused: buckets.refused,
    failed: buckets.failed,
    helpful,
    feedbackTotal,
    medianMs: durations.length > 0 ? durations[Math.floor((durations.length - 1) / 2)] : null,
    timedCount: durations.length,
  };
}

/**
 * Rank the tables a person's selected-period runs recorded.
 *
 * The pair key is question id plus case-insensitive table name, so a source
 * repeated in one answer, or a duplicate copy of the same run row, contributes
 * once. Unity Catalog identifiers are case-insensitive; the first recorded
 * spelling is retained for display.
 */
export function rankTablesRead(
  questions: MonitoringQuestion[],
  limit = MONITORING_TOP_TABLE_LIMIT
): { table: string; runs: number }[] {
  const counted = new Set<string>();
  const totals = new Map<string, { table: string; runs: number }>();
  for (const question of questions) {
    for (const table of question.tables) {
      const normalized = table.trim().toLowerCase();
      if (!normalized) continue;
      const pair = `${question.id}\u0000${normalized}`;
      if (counted.has(pair)) continue;
      counted.add(pair);
      const current = totals.get(normalized);
      if (current) current.runs += 1;
      else totals.set(normalized, { table: table.trim(), runs: 1 });
    }
  }
  return [...totals.values()]
    .sort((left, right) => right.runs - left.runs || left.table.localeCompare(right.table))
    .slice(0, Math.max(0, limit));
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

interface RangeQuery {
  from: string;
  to: string;
}

/**
 * The range the caller asked for, or the last seven days.
 *
 * Bounded here rather than trusted, because these values reach a timestamp cast.
 * An unparseable bound falls back to the default window rather than to an open
 * interval, which on this query would be every message ever stored.
 */
export function rangeFrom(req: Request, now = Date.now()): RangeQuery {
  const from = Date.parse(queryString(req.query.from));
  const to = Date.parse(queryString(req.query.to));
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  }
  return { from: new Date(now - 7 * 86_400_000).toISOString(), to: new Date(now).toISOString() };
}

export interface MonitoringFilterQuery {
  person: string;
  outcome: string;
  feedback?: string;
  /** @deprecated Temporary mixed-version compatibility. */
  rating?: string;
  table: string;
  search: string;
}

function filtersFrom(req: Request, person = queryString(req.query.person).trim()): MonitoringFilterQuery {
  const outcome = queryString(req.query.outcome).trim();
  // `rating` is accepted temporarily for a mixed-version browser, but all new
  // links and response contracts use `feedback`.
  const feedback = (queryString(req.query.feedback) || queryString(req.query.rating)).trim();
  return {
    person,
    outcome: ['completed', 'partial', 'refused', 'failed'].includes(outcome) ? outcome : '',
    feedback: ['up', 'down', 'none', 'unrated'].includes(feedback) ? (feedback === 'unrated' ? 'none' : feedback) : '',
    table: queryString(req.query.table).trim(),
    search: queryString(req.query.q).trim(),
  };
}

export function matchingQuestions(
  questions: MonitoringQuestion[],
  filters: MonitoringFilterQuery
): MonitoringQuestion[] {
  const person = filters.person.toLowerCase();
  const search = filters.search.toLowerCase();
  const table = filters.table.toLowerCase();
  const feedback = filters.feedback ?? (filters.rating === 'unrated' ? 'none' : (filters.rating ?? ''));
  return questions.filter((question) => {
    if (person && question.askedBy.toLowerCase() !== person) return false;
    if (filters.outcome && question.outcome !== filters.outcome) return false;
    if (feedback === 'none' && question.feedback !== null) return false;
    if ((feedback === 'up' || feedback === 'down') && question.feedback !== feedback) {
      return false;
    }
    if (table && !question.tables.some((name) => name.toLowerCase() === table)) return false;
    if (
      search &&
      !`${question.question} ${question.askedBy} ${question.askedBy.split('@')[0]}`.toLowerCase().includes(search)
    ) {
      return false;
    }
    return true;
  });
}

function paginationFor(input: {
  page: ReturnType<typeof pageFrom>;
  rawPage: MonitoringQuestion[];
  total: number | null;
}): MonitoringPagination {
  const hasMore = input.rawPage.length > input.page.limit;
  const last = hasMore ? input.rawPage[input.page.limit - 1] : null;
  return {
    pageSize: input.page.limit,
    total: input.total,
    hasMore,
    nextCursor: last ? encodeCursor({ askedAt: last.askedAt, id: last.id }) : null,
  };
}

/**
 * The ledger's verdicts, best effort.
 *
 * An empty map on any failure, which makes every outcome fall back to the stored
 * trace. Logged rather than surfaced as a page failure: the list still renders
 * and its outcomes are still derived from something the app recorded.
 */
async function readLedger(appkit: InsightsAppKit, answerIds: string[]): Promise<Map<string, LedgerVerdict>> {
  const verdicts = new Map<string, LedgerVerdict>();
  if (answerIds.length === 0) return verdicts;
  try {
    const result = await appkit.lakebase.query(MONITORING_LEDGER_QUERY, [answerIds]);
    for (const row of result.rows) {
      const id = text(row.answer_id);
      if (!id) continue;
      verdicts.set(id, { state: text(row.state), code: text(row.terminal_code) || null });
    }
  } catch (error) {
    console.warn(
      `[monitoring] The run ledger could not be read (${(error as Error).message}). Outcomes fall back to each ` +
        'answer\u2019s stored trace, which cannot tell a refusal from a failure by code.'
    );
  }
  return verdicts;
}

/**
 * A probe of one table under the calling admin's own token, or null.
 *
 * Null whenever the app has no warehouse, no workspace host, or no forwarded
 * token, each of which means the check cannot run. The caller treats null as an
 * unresolved check, which shows everything.
 */
function probeForAdmin(req: Request): TableProbe | null {
  const host = normalizeWorkspaceHost(process.env.DATABRICKS_HOST);
  const warehouseId = (process.env.DATABRICKS_SQL_WAREHOUSE_ID ?? '').trim();
  const token = forwardedUserToken(req);
  if (!host || !warehouseId || !token) return null;
  return statementRunnerFor({ host, token, warehouseId });
}

/* ── Routes ──────────────────────────────────────────────────────────────── */

/** Every path this module registers, so the coverage check below can be exact. */
export const MONITORING_ROUTES: readonly string[] = [
  '/api/monitoring/questions',
  '/api/monitoring/questions/:id',
  '/api/monitoring/people/:email',
];

export interface MonitoringDeps {
  /**
   * The admin guard's own view of which paths it covers.
   *
   * This is `isAdminRoute` from lib/admin-roles.ts, and it is a REQUIRED
   * dependency rather than a convenience. The guard itself is one `app.use`
   * registered by the insights routes, and it decides whether to refuse by
   * testing the request path against its own prefix list. That arrangement has a
   * failure mode: the prefix list and the routes are in different files, so a
   * route added under a path the list does not name is served to everybody, and
   * nothing anywhere fails. So every path below is checked against the list
   * before a single one is registered, and none is registered if one is not
   * covered.
   *
   * Not a second copy of the middleware, deliberately. Resolving a role reads the
   * stored admin list, so applying the guard again per route would double a
   * database read on every request to this page for no additional protection.
   */
  isAdminRoute: (path: string) => boolean;
  /** Injected by tests so the grant probe does not need a warehouse. */
  probeFor?: (req: Request) => TableProbe | null;
  /** Injected by tests to use the exact Connections inventory without workspace calls. */
  declaredTablesFor?: (req: Request) => Promise<string[]>;
  now?: () => number;
  /** One cached, redacted trace read for an opened answer; never used by the list. */
  traceTokenEvidenceReader?: TraceTokenEvidenceReader;
}

/**
 * Register the read routes, ONLY IF the admin guard covers them.
 *
 * MUST be called after `setupInsightsRoutes`. Express applies middleware to what
 * is added afterwards, and the guard is registered in there, so a call before it
 * would leave every route below open. That ordering is the reason the coverage
 * check cannot be the whole of the protection, and the reason this note is here
 * rather than only in server.ts.
 */
export function setupMonitoringRoutes(appkit: InsightsAppKit, deps: MonitoringDeps) {
  if (typeof deps?.isAdminRoute !== 'function') {
    console.error(
      '[monitoring] NOT REGISTERED: no admin-route predicate was supplied, so there is no way to confirm ' +
        'these paths are guarded. They serve every person\u2019s questions and answers. Pass isAdminRoute.'
    );
    return;
  }
  const uncovered = MONITORING_ROUTES.filter((path) => !deps.isAdminRoute(path));
  if (uncovered.length > 0) {
    // Loud, and nothing registered. A 404 on Monitoring is a page somebody
    // reports in a minute; an unguarded one is a disclosure nobody notices.
    console.error(
      `[monitoring] NOT REGISTERED: the admin guard does not cover ${uncovered.join(', ')}. Add the prefix to ` +
        'ADMIN_ROUTE_PREFIXES in lib/admin-roles.ts. Registering these unguarded would serve every ' +
        'person\u2019s questions and answers to any signed-in reader.'
    );
    return;
  }
  const probeFor = deps.probeFor ?? probeForAdmin;
  const clock = deps.now ?? Date.now;
  const declaredTables = deps.declaredTablesFor ?? declaredTablesForRequest;

  appkit.server.extend((app: Application) => {
    /**
     * The list, the strip, and everything the filter row needs to offer.
     */
    app.get('/api/monitoring/questions', async (req: Request, res: Response) => {
      const admin = userEmail(req);
      const range = rangeFrom(req, clock());
      const page = pageFrom(req);
      const filters = filtersFrom(req);
      if (page.refusal) {
        res.status(400).json({ error: page.refusal });
        return;
      }
      const stored = await readStored(appkit, 'GET /api/monitoring/questions', MONITORING_QUESTIONS_QUERY, [
        PLAN_APPROVAL_SENTINEL,
        range.from,
        range.to,
        page.limit + 1,
        filters.person,
        page.cursor?.askedAt ?? '',
        page.cursor?.id ?? '',
        filters.search,
      ]);
      // Sifted BEFORE `chooseRows`, not after. The statement joins a one-row
      // totals aggregate to the page, so it answers with a row whatever the
      // range holds, and `chooseRows` decides whether this route found records
      // by counting the rows it is handed. Handed the raw result it would call
      // an untouched deployment populated, and that is the sentence the Sources
      // page prints to the person working out why their lists are empty.
      const { rows, substitution } = chooseRows(
        'GET /api/monitoring/questions',
        stored.available ? { available: true, rows: questionRows(stored.rows) } : stored
      );
      markResponse(res, substitution);
      const readAt = new Date(clock()).toISOString();
      if (!stored.available) {
        // No half-populated page. The client swaps the body for the app's
        // storage-failure panel, which says the list is blank because nobody
        // could read it rather than because there is nothing there.
        res.status(503).json({
          readState: 'unavailable',
          readAt,
          summary: summarize([], 0),
          questions: [],
          people: [],
          tables: [],
          grantsResolution: 'ok',
          pagination: { pageSize: page.limit, total: null, hasMore: false, nextCursor: null },
        } satisfies MonitoringQuestionsPayload);
        return;
      }

      const answerIds = rows.map((row) => text(row.answer_id)).filter((id) => id !== '');
      const ledger = await readLedger(appkit, answerIds);
      const rawPage = rows.map((row) => questionFromRow(row, ledger));
      const pageRows = rawPage.slice(0, page.limit);
      const all = matchingQuestions(pageRows, filters);

      // The range's real totals, so a truncated list never becomes a smaller
      // count of what people asked. Read from the same statement as the page,
      // rather than from two further round trips. Off the STATEMENT's first row
      // rather than the page's, because the totals ride on every row including
      // the one a range holding nothing still returns.
      const totals = rangeTotalsFrom(stored.rows[0], all);
      const found = totals.asked;
      const threads = totals.threads;
      const peopleList = totals.peopleList;

      // Resolved once for this admin over this range's distinct tables, and
      // reused for every row. Its only job on this route is to tell the client
      // whether the check ran, so it can put one line above the list.
      const distinctTables = [...new Set(all.flatMap((question) => question.tables))].sort();
      const tableOptions = [...new Set([...distinctTables, ...(filters.table ? [filters.table] : [])])].sort();
      const peopleOptions = [...new Set([...peopleList, ...(filters.person ? [filters.person] : [])])].sort();
      const grants = await resolveGrants({
        key: { admin, window: `${range.from}|${range.to}` },
        tables: distinctTables,
        probe: probeFor(req),
        now: clock(),
      });

      const exactTotal = filters.outcome || filters.feedback || filters.table ? null : found;
      const pagination = paginationFor({ page, rawPage, total: exactTotal });
      const partial = pagination.hasMore || page.cursor !== null;
      res.json({
        readState: partial ? 'partial' : 'ok',
        readAt,
        // Over the rows that were read, always, and the two counts below say so
        // when those are fewer than the range holds.
        summary: summarize(all, threads),
        ...(partial
          ? {
              countedQuestions: all.length,
              ...(exactTotal !== null ? { foundQuestions: exactTotal } : {}),
            }
          : {}),
        // One bounded, filtered keyset page. The active filters travel with every
        // cursor request, so page two cannot silently widen back to all rows.
        questions: all,
        people: peopleOptions,
        tables: tableOptions,
        grantsResolution: grants.resolved ? 'ok' : 'failed',
        pagination,
      } satisfies MonitoringQuestionsPayload);
    });

    /**
     * One question in full, conditioned on the reading admin's own grants.
     *
     * The answer body is withheld on the server rather than hidden in the
     * browser. Conditioning applied in the client would mean the body had
     * already been delivered to a reader who is not entitled to it, which is a
     * disclosure with a stylesheet in front of it.
     */
    app.get('/api/monitoring/questions/:id', async (req: Request, res: Response) => {
      const admin = userEmail(req);
      const range = rangeFrom(req, clock());
      const stored = await readStored(appkit, 'GET /api/monitoring/questions/:id', MONITORING_DETAIL_QUERY, [
        req.params.id,
        PLAN_APPROVAL_SENTINEL,
        range.from,
        range.to,
      ]);
      if (!stored.available) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const row = stored.rows[0];
      if (!row) {
        res.status(404).json({ error: 'question_not_found' });
        return;
      }
      const answerId = text(row.answer_id);
      const ledger = await readLedger(appkit, answerId ? [answerId] : []);
      const verdict = answerId ? ledger.get(answerId) : undefined;
      const tables = tableList(row.sources);
      const grants = await resolveGrants({
        key: { admin, window: `${range.from}|${range.to}` },
        // The tables THIS run read. The cache is keyed on the admin and the
        // range, so a drawer opened from a list has already paid for this.
        tables,
        probe: probeFor(req),
        now: clock(),
      });
      const conditioning = conditioningFor(tables, grants);
      const traceId = text(row.trace_id);
      const storedTrace = traceOf(row.response_json) as Record<string, unknown> | null;
      const stageIds = Array.isArray(storedTrace?.stages)
        ? storedTrace.stages
            .map((stage) => (stage && typeof stage === 'object' ? text((stage as Record<string, unknown>).id) : ''))
            .filter(Boolean)
        : [];
      const attribution =
        deps.traceTokenEvidenceReader && isMlflowTraceId(traceId)
          ? await deps.traceTokenEvidenceReader(traceId, stageIds, tokenCount(storedTrace?.total_tokens) ?? undefined)
          : null;
      const enrichedResponse = responseWithTokenAttribution(row.response_json, attribution);
      const mlflow = traceId ? mlflowReference(traceId, await resolveExperimentId(appkit)) : null;
      const executionMode = text(row.execution_mode);
      const detail: MonitoringDetail = {
        id: text(row.question_id),
        conversationId: text(row.conversation_id),
        question: text(row.question),
        askedBy: text(row.user_email),
        askedAt: stamp(row.asked_at),
        outcome: applyAdminOutcome(
          classifyOutcome({
            runState: verdict?.state ?? null,
            hasStoredAnswer: answerId !== '',
            traceHasFailedStage: row.trace_failed === true,
            traceHasPartialStage: row.trace_partial === true,
            answerLanded: row.answer_landed === true,
            synthesisIncomplete: row.synthesis_incomplete === true,
            proseOnlyDegraded: row.prose_only_degraded === true,
          }),
          text(row.overlay_status)
        ),
        outcomeDetail: refusalSentence(verdict?.code),
        outcomeCode: verdict?.code ?? null,
        // Withheld, not blanked: the field is null and `conditioning` says why.
        answer: conditioning ? null : (enrichedResponse ?? null),
        conditioning,
        // Always sent. See the field's note in the contract: the timeline and the
        // token counts are records about the agent rather than about anybody's
        // data, and the conditioned drawer in the design renders both.
        trace: traceOf(enrichedResponse),
        tokens: tokensOf(enrichedResponse),
        // Both halves or neither. A row carrying a mode and no verified flag is
        // a half-written claim, and the footer's absent sentence is the truthful
        // reading of one. See normalizeExecutionIdentity in answer-shape.ts.
        execution:
          executionMode && typeof row.execution_identity_verified === 'boolean'
            ? { mode: executionMode, verified: row.execution_identity_verified }
            : null,
        feedback: applyAdminFeedback(feedbackDirection(row.sentiment, row.usefulness), text(row.overlay_rating)),
        comment:
          applyAdminFeedback(feedbackDirection(row.sentiment, row.usefulness), text(row.overlay_rating)) === 'down'
            ? text(row.comment) || null
            : null,
        // Absent rather than dead. `mlflowReference` answers null for a trace id
        // that is not MLflow's and for a deployment with no host or experiment,
        // and now also for a deployment whose administrator has turned the
        // workspace links off. Withheld HERE rather than in the drawer: a URL
        // suppressed in the browser is a URL that was already delivered.
        mlflowUrl: (await workspaceLinksAllowed(appkit)) ? (mlflow?.url ?? null) : null,
        runId: answerId || null,
        // Always sent, even when the answer body is withheld: the budget is a
        // record of the agent, not of anybody's data.
        runtimeUsed: runRuntimeUsedFromStored(row.response_json),
      };
      res.json(detail);
    });

    /**
     * One person: what they asked, what they can read, and their questions.
     */
    app.get('/api/monitoring/people/:email', async (req: Request, res: Response) => {
      const admin = userEmail(req);
      const person = decodeURIComponent(String(req.params.email));
      if (invalidAdminEmail(person)) {
        res.status(400).json({ error: 'invalid_monitoring_user' });
        return;
      }
      let roster: Awaited<ReturnType<typeof readRosterForRequest>>;
      try {
        roster = await readRosterForRequest(appkit.lakebase, req);
      } catch {
        res.status(503).json({ error: 'identity_roster_unavailable' });
        return;
      }
      const identityRoster = everyKnownUser({ seed: seedRoles(), stored: roster.rows });
      if (!identityRoster.some((entry) => entry.email === person.trim().toLowerCase())) {
        res.status(404).json({ error: 'monitoring_user_not_rostered' });
        return;
      }
      const range = rangeFrom(req, clock());
      const page = pageFrom(req);
      const filters = filtersFrom(req, person);
      if (page.refusal) {
        res.status(400).json({ error: page.refusal });
        return;
      }
      const readAt = new Date(clock()).toISOString();
      const stored = await readStored(appkit, 'GET /api/monitoring/people/:email', MONITORING_QUESTIONS_QUERY, [
        PLAN_APPROVAL_SENTINEL,
        range.from,
        range.to,
        page.limit + 1,
        person,
        page.cursor?.askedAt ?? '',
        page.cursor?.id ?? '',
        filters.search,
      ]);
      if (!stored.available) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const mine = questionRows(stored.rows).filter(
        (row) => text(row.user_email).toLowerCase() === person.toLowerCase()
      );
      const answerIds = mine.map((row) => text(row.answer_id)).filter((id) => id !== '');
      const ledger = await readLedger(appkit, answerIds);
      const rawPage = mine.map((row) => questionFromRow(row, ledger));
      const questions = matchingQuestions(rawPage.slice(0, page.limit), filters);
      const selectedQuestionIds = new Set(questions.map((question) => question.id));
      const selectedRows = mine.filter((row) => selectedQuestionIds.has(text(row.question_id)));
      const selectedAnswerIds = selectedRows.map((row) => text(row.answer_id)).filter((id) => id !== '');
      const totals = rangeTotalsFrom(stored.rows[0], questions);
      const exactTotal = filters.outcome || filters.feedback || filters.table ? null : totals.asked;
      const pagination = paginationFor({ page, rawPage, total: exactTotal });

      // Tokens, and the runs the total covers. A run the model reported no usage
      // for records zero, and a zero is indistinguishable from an unknown inside
      // a sum, so the coverage travels with the total everywhere it is shown.
      let tokenTotal = 0;
      let metredRuns = 0;
      for (const row of selectedRows) {
        const tokens = integer(row.total_tokens);
        if (tokens !== null && tokens > 0) {
          tokenTotal += tokens;
          metredRuns += 1;
        }
      }

      // Which identity ran their reads and whether the subject was provable. Two
      // separate splits, each counted from what the row recorded, with an
      // explicit bucket for rows that recorded nothing. Neither is rendered as a
      // problem, and the panel prints no bucket of zero.
      //
      // A THIRD SPLIT WAS COUNTED HERE and is gone: the runs the access gate had
      // verified, skipped, or not yet checked. `ACCESS_GATE_ENABLED` is false, so
      // it was a figure about a switched-off feature, and the panel that printed
      // it needed two further sentences to say what "skipped" did not mean.
      const executionSplit = { asThemselves: 0, asApplication: 0, unrecorded: 0 };
      const subjectSplit = { verified: 0, confirmedByEndpoint: 0, unrecorded: 0 };
      for (const row of selectedRows) {
        const mode = text(row.execution_mode);
        if (mode === 'signed_in_user') executionSplit.asThemselves += 1;
        else if (mode === 'app_service_principal') executionSplit.asApplication += 1;
        else executionSplit.unrecorded += 1;
        if (typeof row.execution_identity_verified === 'boolean') {
          if (row.execution_identity_verified) subjectSplit.verified += 1;
          else subjectSplit.confirmedByEndpoint += 1;
        } else subjectSplit.unrecorded += 1;
      }

      // Two counts, never one. The first is a grant somebody can make; the
      // second is a change to the release or to the question.
      let refusedMissingGrant = 0;
      let refusedAgentRules = 0;
      for (const id of selectedAnswerIds) {
        const verdict = ledger.get(id);
        if (!verdict || verdict.state !== 'REFUSED') continue;
        const cause = classifyRefusal(verdict.code);
        if (cause === 'missing-grant') refusedMissingGrant += 1;
        else if (cause === 'agent-rules') refusedAgentRules += 1;
      }

      // Unlike the visible question list, this ranking covers the entire
      // selected period. A person can have more questions than the list cap,
      // and their older runs must still be able to place a table in the top five.
      const tableResult = await appkit.lakebase.query(MONITORING_PERSON_TABLES_QUERY, [
        PLAN_APPROVAL_SENTINEL,
        range.from,
        range.to,
        person,
        MONITORING_TOP_TABLE_LIMIT,
      ]);
      const tablesReadMost = tableResult.rows
        .map((row) => {
          const table = tableList([row.table_name])[0] ?? '';
          const runs = integer(row.runs);
          return table && runs !== null && runs > 0 ? { table, runs } : null;
        })
        .filter((entry): entry is { table: string; runs: number } => entry !== null)
        .sort((left, right) => right.runs - left.runs || left.table.localeCompare(right.table))
        .slice(0, MONITORING_TOP_TABLE_LIMIT);

      // Inventory is the same configured-plus-discovered set Connections shows.
      // Permission evidence is deliberately tied to the selected human: a live
      // OBO probe only for self, otherwise verified historical user-token runs.
      const wanted = await declaredTables(req);
      let grants: PersonPanelPayload['grants'] = null;
      const self = admin.trim().toLowerCase() === person.trim().toLowerCase();
      if (wanted.length > 0) {
        if (self) {
          const resolution = await resolveGrants({
            key: { admin, window: `person-self:${range.from}:${range.to}` },
            tables: wanted,
            probe: probeFor(req),
            now: clock(),
          });
          grants = liveSelfGrantLedger(wanted, resolution);
        } else {
          const evidenceResult = await appkit.lakebase.query(MONITORING_PERSON_TABLE_EVIDENCE_QUERY, [
            PLAN_APPROVAL_SENTINEL,
            range.from,
            range.to,
            person,
            wanted.map((table) => table.toLowerCase()),
          ]);
          grants = historicalGrantLedger(wanted, evidenceResult.rows);
        }
      }

      let firstSeen: string | null = null;
      let lastSeen: string | null = null;
      try {
        const seen = await appkit.lakebase.query(MONITORING_PERSON_SEEN_QUERY, [
          PLAN_APPROVAL_SENTINEL,
          person,
          appSessionDeployment() ?? '__unavailable__',
        ]);
        firstSeen = stamp(seen.rows[0]?.first_seen) || null;
        lastSeen = stamp(seen.rows[0]?.last_seen) || null;
      } catch (error) {
        console.warn(`[monitoring] First and last seen could not be read for ${person}: ${(error as Error).message}`);
      }
      const [personaCatalog, personaAssignments] = await Promise.all([
        listSpPersonas(appkit).catch(() => []),
        listSpAssignments(appkit).catch(() => []),
      ]);
      const role = effectiveRole({ seed: seedRoles(), stored: roster.rows, email: person });
      const assignment = personaAssignments.find((entry) => entry.email.toLowerCase() === person.toLowerCase());
      const assignedPersona = assignment
        ? personaCatalog.find((entry) => entry.id === assignment.personaId)
        : undefined;
      const assignedPersonaName = assignedPersona?.displayName.trim() ?? '';
      const persona =
        assignedPersona &&
        assignedPersonaName &&
        !/^(no persona|none|unassigned|n\/a|null|unknown)$/i.test(assignedPersonaName)
          ? { id: assignedPersona.id, name: assignedPersonaName }
          : null;

      const payload: PersonPanelPayload = {
        email: person,
        role,
        persona,
        firstSeen,
        lastSeen,
        summary: summarize(questions, totals.threads),
        durationsMs: questions.map((question) => question.durationMs).filter((ms): ms is number => ms !== null),
        tokens: { total: tokenTotal, metredRuns, totalRuns: questions.length },
        // Null until both usage and the deployment's explicit token rate are
        // known. Ops billing is deliberately not reused here: it is a separate,
        // privileged list-price read and its component spend is not this total.
        tokenCostUsd: tokenCost(tokenTotal, metredRuns),
        helpful: questions.filter((question) => question.feedback === 'up').length,
        notHelpful: questions.filter((question) => question.feedback === 'down').length,
        tablesReadMost,
        executionSplit,
        subjectSplit,
        grants,
        grantsMode: self ? 'live-self' : 'historical',
        refusedMissingGrant,
        refusedAgentRules,
        questions,
        readState: pagination.hasMore || page.cursor !== null ? 'partial' : 'ok',
        readAt,
        pagination,
      };
      // Named but unused on this route: the conditioning of an answer body is a
      // drawer concern, and this panel shows no answer bodies at all.
      void admin;
      res.json(payload);
    });
  });

  console.log("[monitoring] Registered the Monitoring read routes. The admin guard's prefix list covers all of them.");
}

/**
 * What a token total cost, when a price is configured.
 *
 * Null when it is not, which is the ordinary case today: the price lives in the
 * deployment's configuration and no default is invented here. A per-million
 * figure rather than per-token because that is how the endpoints publish it.
 */
export function tokenCost(totalTokens: number, metredRuns: number): number | null {
  if (metredRuns <= 0) return null;
  const raw = (process.env.PLAYER_INSIGHTS_TOKEN_PRICE_PER_MILLION_USD ?? '').trim();
  if (!raw) return null;
  const price = Number.parseFloat(raw);
  if (!Number.isFinite(price) || price < 0) return null;
  return (totalTokens / 1_000_000) * price;
}
