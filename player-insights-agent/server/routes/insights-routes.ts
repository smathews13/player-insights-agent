import { APP_SCHEMA, appTable } from '../../shared/app-schema';
import { raw, type Application, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { extractPdfText, isPdfFilename } from '../lib/pdf-text';
import {
  chooseRows,
  lakebaseHealth,
  lakebaseStorageCheck,
  markResponse,
  markSchemaPending,
  noSubstitution,
  readStored,
  startLakebaseWatchdog,
} from '../lib/lakebase-store';
import { describeSql, runMigrations, type SchemaStatementFailure } from '../lib/migration-runner';
import { buildMigrations } from '../lib/migrations';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import { REPRESENTATIVE_ANSWER_CAVEAT } from '../../shared/representative-answer';
import { conversationTitle, PLACEHOLDER_CONVERSATION_TITLE } from '../../shared/conversation-title';
import { repairTruncatedTitles } from '../lib/repair-conversation-titles';
import { attachRecordedStages, carriesEvidence, proseOnlyAnswer } from '../../shared/prose-only-answer';
import { classifiedRunStatusSql, DEADLINE_TRUNCATED_SQL } from '../../shared/run-verdict';
import { overlayJoinSql, overlayRatingSql, overlayStatusSql } from '../lib/run-label-overrides';
import { parseServedModel, startBenchmarkRun } from '../lib/benchmark-runner';
import { credentialLifetime } from '../lib/benchmark-identity';
import { BENCHMARK_CASE_CATALOG, CANONICAL_SUITE, canonicalSuite, resolveSuiteCases } from '../lib/benchmark-suite';
import { DEPLOYMENT_SETTINGS_DDL, resolveExperimentId, resolveJudgeEndpoint } from '../lib/app-settings';
import { RUN_LEDGER_DDL } from '../lib/run-ledger-schema';
import { workspaceLinksAllowed } from '../lib/egress-store';
import { ADMIN_ROLES_DDL } from '../lib/admin-roles-schema';
import { readRuntimeSettings } from '../lib/runtime-settings-store';
import {
  DEPLOYMENT_DECISIONS_TABLE_NAME,
  SHARED_RAIL_DECISION,
  preserveEnvDecision,
} from '../lib/deployment-decisions';
import type { RuntimeSettings } from '../../shared/runtime-settings';
import { runRuntimeUsedFromStored, type RunRuntimeUsed } from '../../shared/run-runtime-used';
import { isAdminRoute, requireAdmin, requireSuperAdmin, rolePayload } from '../lib/admin-roles';
import {
  admitRun,
  executorName,
  parkRun,
  releaseIdentity,
  resolveRunLedgerMode,
  RUN_LEDGER_MODE_ENV,
  settleRun,
} from '../lib/run-admission';
import { readReplay, replayBody } from '../lib/run-replay';
import { createStageRecorder, readStageEvents } from '../lib/run-stage-events';
import { isUsableIdempotencyKey } from '../lib/run-request-hash';
import { terminalStateFor } from '../lib/run-state';
import { answerRatherThanExit } from '../lib/handler-failures';
import { withDeadline } from '../lib/deadline';
import { requestLatencyRecorder } from '../lib/request-latency';
import {
  createWarehouseWarmup,
  describeWarmup,
  type WarehouseWarmup,
  type WarmupTransport,
} from '../lib/warehouse-warmup';
import { createGenieWarehouseWarmup } from '../lib/genie-warehouse-warmup';
import { FAILURE_TAXONOMY, type FailureCode } from '../../shared/failure-taxonomy';
import { type ExecutionIdentityClaim, unavailableHttpStatus, unavailableResult } from '../../shared/terminal-response';
import {
  carriedStatus,
  providerFailure,
  type FailedDependency,
  type FailureEvidence,
  type FailureStage,
} from '../../shared/failure-evidence';
import { readAgentRefusal } from '../lib/agent-refusal';
import { declaredUserApiScopes, sessionFreshness } from '../lib/session-freshness';
import {
  authorizationFailureFor,
  decideIdentity,
  describeRefusal,
  disclosableRefusal,
  executionIdentityClaim,
  refusedIdentityClaim,
  SIGNED_IN_USER,
} from '../lib/identity-binding';
import { consumeServingStream, TruncatedStreamError, type StageSink } from '../lib/serving-stream';
import { createAskResponder } from '../lib/ask-responder';
import { allowAstrolabeUserApiScopes } from '../lib/app-user-api-scopes';
import { isOptionalUserApiScope } from '../../shared/optional-user-api-scopes';
import {
  accessDecisionFor,
  accessModeFor,
  appServicePrincipal,
  declareAccessMode,
  executionIdentityColumns,
  isAccessMode,
  observedServingPrincipal,
  recordVerifiedAccess,
} from './execution-identity';
import {
  accessDependenciesFrom,
  diagnoseUserToken,
  entitlementLookupVia,
  extractServedConfiguration,
  forwardedUserToken,
  genieSpaceProbeFor,
  isVerified,
  limitsOfThisCheck,
  presentedTokenAge,
  statementRunnerFor,
  statusForOutcome,
  tokenGrantsGenie,
  verificationSummary,
  verifyAccess,
  warehouseProbeFor,
} from './access-verification';

interface QueryResult {
  rows: Record<string, unknown>[];
}

/**
 * One POST to a Model Serving endpoint's `/invocations` path, sending `payload`
 * verbatim.
 *
 * Deliberately not AppKit's `serving().invoke()`: that forwards the body through
 * the SDK's generated `servingEndpoints.query()`, which rebuilds the request from
 * a fixed field allowlist (`input`, `messages`, `prompt`, `extra_params`, ...).
 * `custom_inputs` is not on it, so plan approval never reaches the agent.
 */
export type ServingTransport = (request: {
  path: string;
  payload: Record<string, unknown>;
  /** Where to report each `TraceStage`. Absent makes the call blocking, which is what non-SSE callers want. */
  onStage?: StageSink;
  /**
   * The signed-in user's OAuth token, to invoke the endpoint AS them.
   *
   * The model version is logged with a `UserAuthPolicy`, so the endpoint
   * downscopes the invoker's token and runs Genie and SQL under it: the
   * invoker's Unity Catalog grants are what the warehouse enforces. Absent, the
   * invoker is the app's own service principal. The header carrying it exists
   * only on requests from a signed-in browser, so background callers (preflight,
   * the benchmark runner, the settings probe) omit it and run as the app.
   */
  userToken?: string;
}) => Promise<unknown>;

export interface InsightsAppKit {
  lakebase: {
    query(text: string, params?: unknown[]): Promise<QueryResult>;
    /**
     * The pool behind `query`. Declared because the read funnel needs a
     * connection of its own to put the statement timeout on (see
     * lib/lakebase-pool.ts), and optional because every test here supplies a
     * `query` and nothing else.
     */
    pool?: {
      connect(): Promise<{
        query(text: string, params?: unknown[]): Promise<QueryResult>;
        release(): void;
      }>;
    };
  };
  server: {
    extend(fn: (app: Application) => void): void;
  };
  /** Overridable so tests can assert the exact JSON that reaches Model Serving. */
  servingTransport?: ServingTransport;
  /**
   * Overridable endpoint metadata read used by the cheap readiness route.
   *
   * This is deliberately separate from `servingTransport`: readiness may read
   * the endpoint object, but it must never POST to `/invocations`.
   */
  servingEndpointReader?: (name: string) => Promise<unknown>;
  /**
   * Overridable so tests can assert that opening the app pings the warehouse
   * once, and that a ping that fails is not something the page waits on.
   */
  warehouseWarmup?: WarehouseWarmup;
}

/** Schema name for ownership guards; resolved from PLAYER_INSIGHTS_APP_SCHEMA. */
export { APP_SCHEMA };

/** Everything the app stores into, in the order it is created. */
export const schemaStatements = [
  `CREATE SCHEMA IF NOT EXISTS ${APP_SCHEMA}`,
  `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.conversations (id TEXT PRIMARY KEY, user_email TEXT NOT NULL, title TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, response_json JSONB, trace_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Under whose authority each turn ran. Added by ALTER rather than folded into
  // the CREATE above: `CREATE TABLE IF NOT EXISTS` is a no-op against an existing
  // table, so a column added there would reach fresh deployments only. Nullable,
  // because turns recorded before these columns existed have no answer and
  // backfilling one would invent an audit trail.
  `ALTER TABLE ${APP_SCHEMA}.messages
     ADD COLUMN IF NOT EXISTS app_principal TEXT,
     ADD COLUMN IF NOT EXISTS serving_principal TEXT,
     ADD COLUMN IF NOT EXISTS serving_principal_observed_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS access_mode TEXT,
     ADD COLUMN IF NOT EXISTS execution_mode TEXT,
     ADD COLUMN IF NOT EXISTS execution_identity_verified BOOLEAN`,
  /*
   * The two indexes Monitoring's reads need. Until these existed, `messages`
   * carried nothing but its primary key on `id`, so every read of it that was
   * not by id was a sequential scan.
   *
   * WHY THIS IS NOT OBVIOUS FROM THE SCHEMA. Monitoring shows one row per
   * question and has to find the answer that belongs to each one. There is no
   * foreign key between the two: an answer is paired to a question by looking,
   * inside the same conversation, for the most recent user message at or before
   * the answer's own timestamp. `MONITORING_QUESTIONS_QUERY` in
   * monitoring-routes.ts does that as a correlated subquery, so it runs once per
   * answer in range. Without the first index below, each of those runs is a full
   * scan of every message ever stored, which makes the page quadratic in the size
   * of the store rather than linear in the size of the window.
   *
   * The window bound was the only thing holding that down, which is why there is
   * no all-time range without these.
   */
  // The per-answer question lookup above, and the ordinary chat read of a
  // conversation's messages in order. `created_at DESC` is the second column
  // because that subquery ends `ORDER BY u.created_at DESC LIMIT 1`: with it,
  // finding the question is one walk to the first matching entry instead of
  // collecting every message in the conversation and sorting them.
  `CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
     ON ${APP_SCHEMA}.messages (conversation_id, created_at DESC)`,
  // The window bound itself, which every Monitoring and per-user-panel read
  // applies: the question list, the totals count, the asker list, and the
  // panel's own reads over the same rows. All of them filter `created_at` to the
  // selected range and the list then takes the newest first, which this serves in
  // one direction of the same walk.
  `CREATE INDEX IF NOT EXISTS messages_created_at_idx
     ON ${APP_SCHEMA}.messages (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.attachments (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, user_email TEXT NOT NULL,
    filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    extracted_text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.benchmark_suites (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
    cases_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.benchmark_runs (id TEXT PRIMARY KEY, suite_id TEXT NOT NULL, user_email TEXT NOT NULL,
    status TEXT NOT NULL, metrics_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.feedback (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, user_email TEXT NOT NULL,
    sentiment TEXT, usefulness INTEGER, comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `INSERT INTO ${APP_SCHEMA}.benchmark_suites (id, name, description, cases_json)
   VALUES ('poc-benchmark', 'POC benchmark suite',
   'Quality, latency, ambiguity, visualization, and access-boundary checks',
   '[{"id":"player-count"},{"id":"dictionary-lookup"},{"id":"cross-title"},{"id":"data-quality"},{"id":"visualization"},{"id":"access-boundary"}]'::jsonb)
   ON CONFLICT (id) DO NOTHING`,
  // Declared here rather than in the module that reads it: preflight and the
  // grant script find the schema name by parsing this file, so a second CREATE
  // elsewhere would put those tables outside what they check.
  DEPLOYMENT_SETTINGS_DDL,
  // The run ledger, last, because it is the newest and because everything
  // above it has to keep working on a database where these were refused. Its
  // statements are additive by construction: three tables nothing else in this
  // list mentions, every constraint declared inside its own CREATE, and not
  // one ALTER against a table that already holds the customer's history. See
  // the file for why that is not merely tidy.
  ...RUN_LEDGER_DDL,
  ...ADMIN_ROLES_DDL,
];

const AskBody = z.object({
  conversationId: z.string().min(1),
  prompt: z.string().min(2).max(5000),
  approvedPlanId: z.string().min(1).optional(),
  executePlan: z.boolean().optional(),
});

const FeedbackBody = z.object({
  messageId: z.string().min(1),
  sentiment: z.enum(['up', 'down']).optional(),
  usefulness: z.number().int().min(1).max(5).optional(),
  comment: z.string().max(2000).optional(),
});
const BenchmarkRunBody = z.object({ suiteId: z.string().min(1).optional() });
// Every object in the answer contract is loose. Zod's default would strip a
// field the agent starts returning, silently, between the endpoint and the
// browser; strict parsing would fail the whole answer over one unknown key.
// Unknown keys are forwarded and reported by `undeclaredAnswerKeys` instead.
const FigureSchema = z.looseObject({
  label: z.string(),
  value: z.number(),
  display: z.string(),
  comparison: z.string(),
});
/**
 * `role` is what the run read the table for: `reading` for a table a
 * value-returning query read, `reference` for one consulted for a definition or
 * a column list. Optional, so the agent and the app ship separately: an answer
 * stored before the agent published it, or served by an endpoint still running
 * the previous agent, states no role and is presented as stating none.
 */
const SourceSchema = z.looseObject({ name: z.string(), freshness: z.string(), role: z.string().optional() });
/**
 * One Plotly panel from the agent's `new_plot` tool.
 *
 * Only the envelope is declared. `data` and `layout` are Plotly's own free-form
 * shapes, validated as objects and carried through untouched to the browser that
 * renders them.
 */
const ChartSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  /** Derived by the agent from the traces, so it cannot disagree with `data`. */
  kind: z.string(),
  data: z.array(z.record(z.string(), z.unknown())),
  layout: z.record(z.string(), z.unknown()),
});
const StageSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  start: z.number(),
  duration: z.number(),
  status: z.enum(['complete', 'running', 'partial', 'failed']),
  calls: z.number(),
  input: z.string(),
  output: z.string(),
  // Where the stage sits in the run. Defaulted because an endpoint running a
  // model version logged before the agent's loop returns a flat list with
  // neither key, and requiring them would fail the parse.
  depth: z.number().default(0),
  parent_id: z.string().default(''),
});
/**
 * A Genie space a run put its question to.
 *
 * `title` is what a reader should be shown. `id` names infrastructure and is
 * carried for the admin who has to match it against the bundle, not for the
 * person reading their own run.
 */
const GenieSpaceSchema = z.looseObject({ id: z.string(), title: z.string().default('') });
export const TraceSchema = z.looseObject({
  id: z.string(),
  totalMs: z.number(),
  toolCalls: z.number(),
  stages: z.array(StageSchema),
  /**
   * The Genie spaces this run reached, in the order it first reached each.
   *
   * Optional rather than defaulted, for the reason spelled out on the token
   * fields below: an answer stored before the agent recorded this, or served by
   * an endpoint still running an older model version, reported nothing, and an
   * empty array would state that the run asked Genie nothing. Those are
   * different facts and only the agent knows which one applies. A run from a
   * version that DOES record it and asked no space returns `[]`, which is the
   * claim, so the two must not be collapsed.
   */
  genie_spaces: z.array(GenieSpaceSchema).optional(),
  // OPTIONAL WITHOUT A DEFAULT, and the difference is the whole point. Optional is
  // what lets an answer stored before the agent metered tokens still parse, and it
  // is enough to keep `undeclaredAnswerKeys` from calling a metered run drift.
  // Defaulting to zero went further and invented a measurement: some gateways
  // return `total_tokens` alone, and a zero written into the other two halves says
  // the model read nothing and wrote nothing. Worse, it made the guard downstream
  // in RunExplorer unfalsifiable -- it tests `typeof === 'number'`, which a default
  // guarantees -- so the rule that a half-metred split must not be printed had
  // never once applied. Absent has to stay absent for that guard to work.
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
});
/**
 * What one statement of a run measured, over what window, from which table.
 *
 * Four labelled facts, derived by the agent from the parse of the statement it
 * ran (`agent/provenance.py`). Every field defaults to empty because every field
 * can legitimately be empty: a query with no WHERE clause has no window, and a
 * Genie statement whose tables could not be resolved has no source. Absent must
 * render as nothing rather than as "unknown" or "all time" -- the second is a
 * claim about the population behind a figure that nothing measured.
 *
 * NOT NAMED `provenance`, and the collision is why: this app already sends the
 * browser a `provenance` meaning which parts of an answer came from a live run
 * (shared/answer-provenance.ts), set by the ask route after it spreads the
 * agent's answer. A field of that name here would be overwritten on the way out.
 */
const DerivationSchema = z.looseObject({
  source: z.string().default(''),
  metric: z.string().default(''),
  window: z.string().default(''),
  filter: z.string().default(''),
});

/**
 * The same entry, with an unusable one degraded to one that states nothing.
 *
 * THIS IS THE ONE PLACE IN THIS SCHEMA THAT SWALLOWS A SHAPE ERROR, and the
 * asymmetry against `ChartSchema` is deliberate. A malformed chart envelope
 * fails the parse because the chart IS the content a reader came for; a
 * malformed provenance entry that failed the parse would take the figures, the
 * charts, the sources and the SQL down with it and serve the agent's prose
 * alone, which trades the whole answer for a caption on it. So a bad entry
 * becomes four empty fields, which every renderer already draws as nothing.
 *
 * It is not silent: the warning below is the only record that the agent sent
 * something this app could not read, and it names the entry rather than the
 * answer.
 */
const DerivationEntrySchema = DerivationSchema.catch((ctx) => {
  console.warn(
    '[contract] An answer carried a provenance entry this app could not read, so that entry ' +
      `states nothing. Entry: ${JSON.stringify(ctx.value).slice(0, 200)}`
  );
  return { source: '', metric: '', window: '', filter: '' };
});

const DocumentSnippetSchema = z.looseObject({
  filename: z.string().min(1),
  quote: z.string().min(1),
  supports: z.string().min(1),
});

const LiveAnswerSchema = z.looseObject({
  id: z.string().min(1),
  takeaway: z.string().min(1),
  // Empty is allowed: a deadline-stopped run can have a takeaway and no written
  // narrative. Requiring a sentence here used to drop the structured result and
  // store a 0.0s prose-only card with the stages thrown away.
  narrative: z.string(),
  // Added by the notebook answer shape. Defaulted so an older served model and
  // a newer app can overlap safely during rollout.
  content: z.string().default(''),
  figures: z.array(FigureSchema),
  // Defaulted rather than required, so the agent and the app can ship separately:
  // an endpoint still running the previous agent returns no `charts` key at all,
  // and requiring it would drop every live answer back to a representative one.
  charts: z.array(ChartSchema).default([]),
  sources: z.array(SourceSchema),
  document_snippets: z.array(DocumentSnippetSchema).default([]),
  caveats: z.array(z.string()),
  // Defaulted for the same reason `charts` is: an endpoint still running the
  // model version that shipped before this returns no key at all, and requiring
  // it would drop every live answer back to a representative one -- which is a
  // far worse outcome than an answer that states no provenance.
  derivation: z.array(DerivationEntrySchema).default([]),
  sql: z.string(),
  trace: TraceSchema,
  // Set by the route, never by the agent. Declared so it is not reported as drift.
  mode: z.string().optional(),
  // Also the route's, and also declared here rather than only on the way out:
  // stored answers are read back through this schema and `undeclaredAnswerKeys`
  // would otherwise report every answer written since this shipped as agent
  // drift, which is the log that is supposed to mean the agent moved ahead of
  // the app. See shared/answer-provenance.ts.
  provenance: z.string().optional(),
  // The route's snapshot of the runtime this Ask sent. Declared so storing it
  // is not reported as the agent shipping a field the app cannot read.
  runtime_settings: z.looseObject({}).optional(),
});
type LiveAnswer = z.infer<typeof LiveAnswerSchema>;

function keysOutsideShape(value: unknown, shape: object, prefix: string): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value as Record<string, unknown>)
    .filter((key) => !(key in shape))
    .map((key) => `${prefix}${key}`);
}

/** Names the parts of an answer the app does not know about. */
export function undeclaredAnswerKeys(answer: LiveAnswer): string[] {
  const found = keysOutsideShape(answer, LiveAnswerSchema.shape, '');
  found.push(...keysOutsideShape(answer.trace, TraceSchema.shape, 'trace.'));
  answer.trace.stages.forEach((stage, index) => {
    found.push(...keysOutsideShape(stage, StageSchema.shape, `trace.stages[${index}].`));
  });
  answer.figures.forEach((figure, index) => {
    found.push(...keysOutsideShape(figure, FigureSchema.shape, `figures[${index}].`));
  });
  // The chart envelope only. Walking into `data` or `layout` would report
  // Plotly's own vocabulary as drift on every chart.
  answer.charts.forEach((chart, index) => {
    found.push(...keysOutsideShape(chart, ChartSchema.shape, `charts[${index}].`));
  });
  answer.sources.forEach((source, index) => {
    found.push(...keysOutsideShape(source, SourceSchema.shape, `sources[${index}].`));
  });
  answer.derivation.forEach((entry, index) => {
    found.push(...keysOutsideShape(entry, DerivationSchema.shape, `derivation[${index}].`));
  });
  return found;
}
const PlanStepSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  kind: z.enum(['context', 'definitions', 'data', 'synthesis']),
});

/**
 * The plan the user approves before anything runs.
 *
 * Loose like the rest of the contract, and here it matters most: a field added
 * to the Python `AnalysisPlan` and stripped here would be approved by a user who
 * was never shown it.
 */
const AnalysisPlanSchema = z.looseObject({
  id: z.string().min(1),
  question: z.string().min(1),
  summary: z.string().min(1),
  steps: z.array(PlanStepSchema),
  requires_approval: z.boolean().default(true),
  uses_conversation_context: z.boolean().default(false),
  uses_attachment_context: z.boolean().default(false),
});
type AnalysisPlan = z.infer<typeof AnalysisPlanSchema>;

/** Names the parts of a plan the app does not know about. */
export function undeclaredPlanKeys(plan: AnalysisPlan): string[] {
  const found = keysOutsideShape(plan, AnalysisPlanSchema.shape, '');
  plan.steps.forEach((step, index) => {
    found.push(...keysOutsideShape(step, PlanStepSchema.shape, `steps[${index}].`));
  });
  return found;
}

/**
 * The agent's third answer: a question back, when the one asked cannot be
 * answered as put. A first-class response rather than an error. Nothing failed,
 * and the run has a trace explaining why it is asking.
 *
 * `options` and `reason` are defaulted, because a clarification with neither is
 * still usable and must not fail the parse.
 */
const ClarificationSchema = z.looseObject({
  id: z.string().min(1),
  question: z.string().min(1),
  reason: z.string().default(''),
  options: z.array(z.string()).default([]),
  trace: TraceSchema,
});
type Clarification = z.infer<typeof ClarificationSchema>;

// PDF is handled separately, by `extractPdfText`; these are the formats read as UTF-8.
const ALLOWED_ATTACHMENT_TYPES = new Set(['txt', 'md', 'csv', 'json']);
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT = 50_000;
const MAX_CONVERSATION_ATTACHMENT_TEXT = 80_000;

/**
 * Written as the user turn when a proposed plan is approved. `RUNS_QUERY` skips
 * it when labelling a run, so the run shows the question rather than the approval.
 */
export const PLAN_APPROVAL_MESSAGE = 'Approved the proposed analysis plan.';

/** Stands in for the owner of a shared benchmark run that is not the caller's. */
export const SHARED_RUN_OWNER = 'Another team member';

/**
 * Every answered turn is a run, whether it came from Ask PIA or the Benchmark Lab.
 * Conversation runs are derived from the assistant messages that already carry a
 * trace rather than written as separate rows, so runs stored before this existed
 * still appear.
 */
export const RUNS_QUERY = `
  WITH answers AS (SELECT m.id, m.conversation_id, m.created_at,
           m.response_json->'trace' AS trace, m.response_json->'caveats' AS caveats,
           m.response_json AS payload, c.user_email
    FROM ${APP_SCHEMA}.messages m
    JOIN ${APP_SCHEMA}.conversations c ON c.id = m.conversation_id
    -- A plan proposal has no trace and is not yet a run; an answer always has one.
    WHERE m.role = 'assistant' AND jsonb_typeof(m.response_json->'trace') = 'object'
      AND c.user_email = $2
  )
  SELECT a.id, 'conversation' AS kind, a.conversation_id,
         COALESCE((SELECT u.content FROM ${APP_SCHEMA}.messages u
            WHERE u.conversation_id = a.conversation_id AND u.role = 'user'
              AND u.content <> $1 AND u.created_at <= a.created_at
            ORDER BY u.created_at DESC LIMIT 1),
           (SELECT c2.title FROM ${APP_SCHEMA}.conversations c2 WHERE c2.id = a.conversation_id)
         ) AS prompt,
         a.user_email AS stakeholder,
         -- The worst status any step ended on, EXCEPT the steps that are not
         -- part of the answer. Today that is the charting step alone, and the
         -- exemption is interpolated from VERDICT_EXEMPT_STAGE_IDS rather than
         -- written out here, so the rule this query applies and the rule the
         -- rest of the app applies cannot drift apart. A declined or unrenderable
         -- chart used to publish a sound answer as 'partial' on every surface
         -- that draws this column; see shared/run-verdict.ts for why that is the
         -- one step whose outcome says nothing about the answer above it.
         -- Empty stages used to fall through to complete, which painted a green
         -- badge on a 0.0s card that recorded nothing. Incomplete-sources notes
         -- do not flip a card that already has figures or tables. A writer
         -- timeout or failed synthesis after those tables landed is partial,
         -- so Monitoring, Ask, and Run Explorer say the same word. A finished
         -- writer with tables stays complete even when another step missed.
         -- A markdown catalog listing (no pipe table) is landed. An admin
         -- overlay, when one exists, is the word every surface must show.
         ${overlayStatusSql(
           classifiedRunStatusSql({ trace: 'a.trace', payload: 'a.payload', caveats: 'a.caveats' })
         )} AS status,
         -- Whether the run stopped before it had finished. The two halves record
         -- it differently and neither is inferred from the counts: a benchmark
         -- writes a truncation object saying why (see BenchmarkTruncation), and a
         -- conversation run that hit one of the agent's bounds closes with the
         -- cap stage, which the agent emits on that path and no other. Matched on
         -- the stage id rather than its name, because the name is prose someone
         -- will reword. Deadline caveats are the other half: synthesis can stop
         -- for time without emitting a cap stage.
         -- NO BACKTICKS BELOW THIS LINE: this is a template literal,
         -- and one in a SQL comment ends the query rather than quoting a word.
         (jsonb_path_exists(a.trace, '$.stages[*] ? (@.id == "cap")')
           OR ${DEADLINE_TRUNCATED_SQL.split('caveats').join('a.caveats')}) AS truncated,
         -- Which Genie spaces answered this run, as the run itself recorded them.
         -- The choice is made at request time from settings baked into the model
         -- artifact, so the app cannot look it up: this column is the only place
         -- the pairing exists. NULL, not an empty array, when the key is absent --
         -- a run stored before the agent recorded this reported nothing, and an
         -- empty array is the claim that the run asked no Genie space at all.
         a.trace->'genie_spaces' AS genie_spaces,
         ROUND((a.trace->>'totalMs')::numeric)::int AS duration_ms,
         (a.trace->>'toolCalls')::int AS tool_calls,
         -- The caller's own rating. The feedback route accepts any message id,
         -- so without the user_email predicate this would show whatever score
         -- anyone else submitted against the same answer.
         ${overlayRatingSql(`(SELECT f.usefulness FROM ${APP_SCHEMA}.feedback f
          WHERE f.message_id = a.id AND f.user_email = $2 AND f.usefulness IS NOT NULL
          ORDER BY f.created_at DESC LIMIT 1)`)} AS rating,
         a.created_at
  FROM answers a
  ${overlayJoinSql('a.id')}
  UNION ALL
  SELECT b.id, 'benchmark' AS kind, NULL AS conversation_id,
         b.metrics_json->>'prompt' AS prompt,
         CASE WHEN b.user_email = $2 THEN b.user_email ELSE '${SHARED_RUN_OWNER}' END AS stakeholder,
         ${overlayStatusSql('b.status')} AS status,
         jsonb_typeof(b.metrics_json->'truncation') = 'object' AS truncated,
         -- NULL because a suite has no single trace to read it off: each case is
         -- its own agent run with its own spaces, and the run row records none of
         -- them. Not reported, which is what NULL says here, rather than an empty
         -- array claiming a suite of Genie cases never opened a space.
         NULL::jsonb AS genie_spaces,
         (b.metrics_json->>'duration_ms')::int AS duration_ms,
         -- A suite contains several agent runs and stores no suite-level call
         -- count. NULL keeps that absence honest instead of adding unlike runs
         -- into a number the suite never recorded.
         NULL::int AS tool_calls,
         -- The caller's own rating, from the same table the conversation half
         -- reads. feedback.message_id carries no foreign key and the feedback
         -- route accepts any id, so a run id works here unchanged.
         ${overlayRatingSql(`(SELECT f.usefulness FROM ${APP_SCHEMA}.feedback f
          WHERE f.message_id = b.id AND f.user_email = $2 AND f.usefulness IS NOT NULL
          ORDER BY f.created_at DESC LIMIT 1)`)} AS rating,
         b.created_at
  FROM ${APP_SCHEMA}.benchmark_runs b
  ${overlayJoinSql('b.id')}
  ORDER BY created_at DESC
  LIMIT 200`;

/**
 * The only thing `POST /api/insights/ask` can end up serving as an answer.
 *
 * There used to be a second member here, `representativeFallback(prompt,
 * reason)`, which put a stored demo response in front of a reader when the
 * endpoint failed or answered in a shape this app could not read. It was
 * carefully labelled and it was still the app answering a question somebody
 * asked with figures nobody queried, so it is gone: a question with the
 * reader’s own words above it is not an empty surface. A failure is reported
 * as one on every target, and no deployment holds seeded content to serve
 * instead.
 *
 * Named so the variable that holds it can be declared without a value. See the
 * declaration in the ask handler for why that matters.
 */
type ServedAnswer = LiveAnswer & { mode: 'live' };

/** The shape of a payload, for a log line and a caveat, without its contents. */
function describePayloadShape(value: unknown): string {
  if (value === null || typeof value !== 'object') return `the endpoint returned ${typeof value}`;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length > 0 ? `top-level keys: ${keys.join(', ')}` : 'the endpoint returned an empty object';
}

// ---------------------------------------------------------------------------
// Per-run trace. The assistant message row's `response_json` holds the whole
// answer, trace included; these schemas describe what reading it back yields.
// ---------------------------------------------------------------------------

/** The persisted stage shape. Shared with the ask path, which reads the same stored stages. */
const TraceStageDetailSchema = StageSchema;
const TraceDetailSchema = TraceSchema.extend({ stages: z.array(TraceStageDetailSchema) });

/**
 * The stages the agent tagged `kind: 'tool'`, restated with their recorded
 * arguments and results.
 */
const ToolStageSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  status: z.enum(['complete', 'running', 'partial', 'failed']),
  durationMs: z.number(),
  calls: z.number(),
  arguments: z.string(),
  result: z.string(),
});

const MlflowReferenceSchema = z.looseObject({
  traceId: z.string(),
  experimentId: z.string().nullable(),
  url: z.string().nullable(),
});

/** Benchmark runs store metrics, not stages. Every field is optional in practice. */
const BenchmarkMetricsSchema = z.looseObject({
  suiteId: z.string().nullable(),
  passed: z.number().nullable(),
  total: z.number().nullable(),
  groundedness: z.number().nullable(),
  relevance: z.number().nullable(),
  durationMs: z.number().nullable(),
});

/**
 * Loose for the same reason the answer contract is: a key this app has not
 * caught up with must reach the browser rather than vanish silently.
 */
export const RunTraceSchema = z.looseObject({
  runId: z.string(),
  kind: z.enum(['conversation', 'benchmark']),
  /** 'trace' when real stages were found; 'no-trace' when the run has none to show. */
  state: z.enum(['trace', 'no-trace']),
  /** Whether the stored answer came from the agent or from the offline fallback. */
  mode: z.enum(['live', 'representative']).nullable(),
  conversationId: z.string().nullable(),
  createdAt: z.string(),
  prompt: z.string().nullable(),
  stakeholder: z.string().nullable(),
  takeaway: z.string(),
  narrative: z.string(),
  sql: z.string(),
  /** Canonical Plotly specs for the chart-building stage, when this answer had any. */
  charts: z.array(ChartSchema).optional(),
  sources: z.array(SourceSchema),
  /**
   * The answer's own caveats, so the Final answer tab can say what the answer
   * said. This projection carried the takeaway, the prose and the source and
   * dropped these, which made the Run Explorer the one surface where the
   * governance refusals, coverage gaps and undefined-metric warnings that
   * qualify a figure were absent from the figure -- and it is the surface people
   * open when they have started to doubt a number.
   */
  caveats: z.array(z.string()),
  /**
   * What each statement of the run measured, over what window, with what filter.
   *
   * OPTIONAL, unlike the caveats above, because there are three ways a run
   * genuinely has none and all three are ordinary: an answer from a model version
   * logged before the agent derived it, a stored answer that no longer satisfies
   * the contract, and a turn that ended in a question instead of a figure. An
   * empty array from the parse and an absent key both render as no provenance
   * block; what must not happen is a required field forcing one of the three to
   * be filled in with something.
   */
  derivation: z.array(DerivationSchema).optional(),
  trace: TraceDetailSchema.nullable(),
  /** Tool-tagged stages. The agent's own call counter is `trace.toolCalls`. */
  toolStages: z.array(ToolStageSchema),
  mlflow: MlflowReferenceSchema.nullable(),
  benchmark: BenchmarkMetricsSchema.nullable(),
  /** Plain-language reason the panes can render when `state` is 'no-trace'. */
  note: z.string(),
  undeclaredKeys: z.array(z.string()),
  /**
   * The runtime this Ask sent, snapshotted onto the stored answer.
   *
   * Null when the row predates the snapshot. Never today's Settings and never
   * the bundle defaults — those would describe an agent that did not run.
   */
  runtimeUsed: z
    .strictObject({
      loop: z.strictObject({
        maxSteps: z.number().nullable(),
        maxToolCalls: z.number().nullable(),
        maxRunSeconds: z.number().nullable(),
      }),
      answer: z.strictObject({
        takeaway: z.boolean().nullable(),
        narrative: z.boolean().nullable(),
        figures: z.boolean().nullable(),
        charts: z.boolean().nullable(),
        narrativeMaxCharacters: z.number().nullable(),
        figuresOrder: z.enum(['as-ranked', 'totals-first', 'averages-first']).nullable(),
      }),
    })
    .nullable()
    .default(null),
});
export type RunTrace = z.infer<typeof RunTraceSchema>;

/** `response_json` arrives parsed from JSONB, but as text through some drivers and fakes. */
function parseStoredJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function timestamp(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : new Date().toISOString();
}

/** Text columns only. Anything that is not already a scalar is not a label. */
function text(value: unknown) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function numberOrNull(value: unknown) {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

/**
 * A stored list of sentences, read without requiring the row around it to parse.
 *
 * Used for the caveats on a run whose stored answer no longer satisfies the whole
 * contract, for the same reason the trace is read on its own a few functions
 * below: an answer that drifted in one key still disclosed everything it
 * disclosed, and losing the row-filter warning because a later version of the
 * agent added a field is the failure this endpoint exists to avoid.
 */
function storedSentences(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

/**
 * Shared with the Architecture page's link builder rather than kept private
 * here, because a host normalised two ways is a link that works on one page and
 * not the other. See shared/databricks-links.ts.
 */
function workspaceHost() {
  return normalizeWorkspaceHost(process.env.DATABRICKS_HOST);
}

/**
 * The warehouse this app runs its own statements on.
 *
 * Resolved by the platform from the `sql-warehouse` app resource, so it is the
 * warehouse the app's service principal was granted access to. It is not
 * necessarily the one the orchestrator uses: that lives in the model artifact
 * and only a new model version changes it. A verdict from the access gate is
 * therefore about this warehouse, and says so.
 */
function appWarehouseId() {
  return (process.env.DATABRICKS_SQL_WAREHOUSE_ID ?? '').trim();
}

/** MLflow's own trace ids; `trace-<uuid>` is the agent's local fallback and is not one. */
const MLFLOW_TRACE_ID = /^tr-[0-9a-f]+$/i;

/**
 * Names the MLflow trace behind an answer, when there is one.
 */
export function mlflowReference(traceId: string, experimentId: string) {
  if (!MLFLOW_TRACE_ID.test(traceId)) return null;
  const named = experimentId.trim();
  const host = workspaceHost();
  const url =
    named && host
      ? `${host}/ml/experiments/${encodeURIComponent(named)}/traces` +
        `?selectedEvaluationId=${encodeURIComponent(traceId)}`
      : null;
  return { traceId, experimentId: named || null, url };
}

// Defined in shared/representative-answer.ts alongside the answer it describes,
// and re-exported here because that is where callers already import it from.
export { REPRESENTATIVE_ANSWER_CAVEAT } from '../../shared/representative-answer';

/**
 * Marks any answer that did not come from a traced agent run.
 *
 * The signal is the trace id, which is the one thing only a live answer can
 * produce: `agent.py` sets `trace.id` from the active MLflow span and falls
 * back to `trace-<uuid>` when there is none, and `mlflowReference` already
 * relies on that shape. Deriving the caveat from it instead of from a second
 * `isCanned` flag means a canned answer added later cannot be shipped without
 * the disclosure: there is nothing to remember to set.
 *
 * An answer carrying no evidence at all is left alone, and that is not a hole
 * in the rule. The caveat's sentence is about where the figures, SQL and stage
 * timings came from, so putting it on an answer that has none of them tells a
 * reader there is a stored demo response on the screen when what is on the
 * screen is prose and four empty sections. The prose-only path says what it is
 * in its own words. See shared/prose-only-answer.ts.
 */
export function discloseAnswerProvenance<
  T extends {
    caveats: string[];
    trace: { id: string; stages?: unknown[] };
    figures?: unknown[];
    sources?: unknown[];
    sql?: string;
  },
>(answer: T): T {
  if (MLFLOW_TRACE_ID.test(answer.trace.id)) return answer;
  if (!carriesEvidence(answer)) return answer;
  if (answer.caveats.includes(REPRESENTATIVE_ANSWER_CAVEAT)) return answer;
  return { ...answer, caveats: [REPRESENTATIVE_ANSWER_CAVEAT, ...answer.caveats] };
}

/**
 * Says so when an answer ran as the application instead of as its reader.
 *
 * Only ever adds. There is no caveat for the good case: an answer that ran as
 * the user is the ordinary one now, and annotating it would train people to
 * skim past the line that matters. The representative answer is left alone
 * because it did not run at all: `discloseAnswerProvenance` has already said
 * the stronger thing, and two caveats about provenance contradict each other
 * more than either informs.
 */
export function discloseExecutingIdentity<T extends { caveats: string[]; trace: { id: string } }>(
  answer: T,
  ranAsSignedInUser: boolean
): T {
  if (ranAsSignedInUser) return answer;
  if (!MLFLOW_TRACE_ID.test(answer.trace.id)) return answer;
  if (answer.caveats.includes(SERVICE_PRINCIPAL_FALLBACK_CAVEAT)) return answer;
  return { ...answer, caveats: [SERVICE_PRINCIPAL_FALLBACK_CAVEAT, ...answer.caveats] };
}

function toolStagesFromTrace(stages: z.infer<typeof TraceStageDetailSchema>[]) {
  return stages
    .filter((stage) => stage.kind === 'tool')
    .map((stage) => ({
      id: stage.id,
      name: stage.name,
      status: stage.status,
      durationMs: stage.duration,
      calls: stage.calls,
      arguments: stage.input,
      result: stage.output,
    }));
}

type RunTraceIdentity = Pick<RunTrace, 'runId' | 'kind' | 'conversationId' | 'createdAt' | 'prompt' | 'stakeholder'>;

function runWithoutTrace(
  identity: RunTraceIdentity,
  note: string,
  mode: RunTrace['mode'] = null,
  runtimeUsed: RunRuntimeUsed | null = null
): RunTrace {
  return {
    ...identity,
    state: 'no-trace',
    mode,
    takeaway: '',
    narrative: '',
    sql: '',
    sources: [],
    caveats: [],
    trace: null,
    toolStages: [],
    mlflow: null,
    benchmark: null,
    note,
    undeclaredKeys: [],
    runtimeUsed,
  };
}

/** Stamps the runtime this Ask sent onto whatever we persist for the run. */
function withAskRuntime<T extends Record<string, unknown>>(
  body: T,
  runtimeSettings: RuntimeSettings | undefined
): T {
  return runtimeSettings ? { ...body, runtime_settings: runtimeSettings } : body;
}

/**
 * Turns a stored assistant message into its run's trace.
 *
 * Three outcomes, kept distinct on purpose: a full answer with stages, an
 * answer whose stored shape no longer parses but still carries a trace, and a
 * turn that never produced a run at all (a proposed plan nobody approved).
 */
export function conversationRunTrace(row: Record<string, unknown>, experimentId: string): RunTrace {
  const identity: RunTraceIdentity = {
    runId: String(row.id),
    kind: 'conversation',
    conversationId: text(row.conversation_id),
    createdAt: timestamp(row.created_at),
    prompt: text(row.prompt),
    stakeholder: text(row.stakeholder),
  };
  const payload = parseStoredJson(row.response_json);
  if (!payload || typeof payload !== 'object') {
    return runWithoutTrace(identity, 'This run stored no response, so there is no trace to show.');
  }
  const record = payload as Record<string, unknown>;
  const runtimeUsed = runRuntimeUsedFromStored(record);
  const mode = record.mode === 'representative' ? 'representative' : record.mode === 'live' ? 'live' : null;
  if (record.type === 'plan') {
    return runWithoutTrace(
      identity,
      'This turn proposed an analysis plan and the plan was never approved, so no run was executed and there is no trace.',
      mode,
      runtimeUsed
    );
  }

  // A clarification is a completed run that ended in a question, and its trace is
  // the thing that explains why it is asking. Read here rather than left to the
  // answer parse below, which would find no `trace` key on it and report a run
  // with real stages as having none.
  if (record.type === 'clarification') {
    const clarification = ClarificationSchema.safeParse(record.clarification);
    const asked = clarification.success ? TraceDetailSchema.safeParse(clarification.data.trace) : null;
    if (clarification.success && asked?.success) {
      return {
        ...identity,
        state: 'trace',
        mode,
        takeaway: clarification.data.question,
        narrative: clarification.data.reason,
        sql: '',
        sources: [],
        // A clarification carries no caveats and none are invented for it: the
        // turn produced a question rather than a figure, so there is nothing here
        // for a caveat to qualify.
        caveats: [],
        trace: asked.data,
        toolStages: toolStagesFromTrace(asked.data.stages),
        mlflow: mlflowReference(asked.data.id, experimentId),
        benchmark: null,
        note: 'This turn ended in a question back to the user rather than an answer, so the stages stop where it asked.',
        undeclaredKeys: [],
        runtimeUsed,
      };
    }
    return runWithoutTrace(
      identity,
      'This turn asked the user for a missing detail, and stored no trace of the steps that led there.',
      mode,
      runtimeUsed
    );
  }

  const answer = LiveAnswerSchema.safeParse(record);
  const charts = z.array(ChartSchema).safeParse(record.charts);
  // A stored answer that no longer satisfies the whole contract can still hold a
  // perfectly good trace. Losing it to a schema mismatch would put the panes back
  // where they started, so the trace is read on its own before giving up.
  const trace = answer.success
    ? TraceDetailSchema.safeParse(answer.data.trace)
    : TraceDetailSchema.safeParse(record.trace);
  if (!trace.success) {
    return runWithoutTrace(
      identity,
      'This run stored a response with no trace, so there are no stages to show.',
      mode,
      runtimeUsed
    );
  }

  return {
    ...identity,
    state: 'trace',
    mode,
    takeaway: typeof record.takeaway === 'string' ? record.takeaway : '',
    narrative: typeof record.narrative === 'string' ? record.narrative : '',
    sql: typeof record.sql === 'string' ? record.sql : '',
    ...(charts.success ? { charts: charts.data } : {}),
    sources: answer.success ? answer.data.sources : [],
    // Read off the record rather than off the parse, so a run whose stored answer
    // has drifted in some unrelated key still discloses what it disclosed. The
    // sources above take the parsed value because they are objects with a shape
    // the browser indexes into; these are sentences.
    caveats: answer.success ? answer.data.caveats : storedSentences(record.caveats),
    // Only from the parse, and only when it succeeded. These are objects the
    // browser indexes into, like the sources above and unlike the caveats, and a
    // half-shaped one read straight off a drifted record would render as a
    // labelled fact with nothing beside the label.
    ...(answer.success && answer.data.derivation.length > 0 ? { derivation: answer.data.derivation } : {}),
    trace: trace.data,
    toolStages: toolStagesFromTrace(trace.data.stages),
    mlflow: mlflowReference(trace.data.id, experimentId),
    benchmark: null,
    note:
      mode === 'representative'
        ? 'This run was answered offline from the representative dataset, so these are reference stages rather than a live agent run.'
        : '',
    undeclaredKeys: answer.success ? undeclaredAnswerKeys(answer.data) : [],
    runtimeUsed,
  };
}

/**
 * Turns a benchmark run into the same envelope, without pretending it has a trace.
 *
 * A benchmark run records a per-case outcome for every case in the suite, not one
 * trace: six cases are six separate agent runs, each with its own MLflow trace
 * id. Splicing them into a single stage list would invent a run that never
 * happened, so the cases are returned as cases and the panes link out per case.
 */
export function benchmarkRunTrace(row: Record<string, unknown>): RunTrace {
  const metrics = (parseStoredJson(row.metrics_json) ?? {}) as Record<string, unknown>;
  const identity: RunTraceIdentity = {
    runId: String(row.id),
    kind: 'benchmark',
    conversationId: null,
    createdAt: timestamp(row.created_at),
    prompt: text(metrics.prompt) ?? `Benchmark suite: ${text(row.suite_id) ?? 'unknown'}`,
    stakeholder: text(row.user_email),
  };
  return {
    ...runWithoutTrace(
      identity,
      'A benchmark run records a per-case outcome for every case in the suite rather than one set of agent ' +
        'stages, so there is no single trace to walk. Each case carries its own MLflow trace id, open one of ' +
        'those, or a conversation run, to inspect a live trace.'
    ),
    benchmark: {
      // Spread first, narrow after. `BenchmarkMetricsSchema` is a loose object
      // for the same reason the answer contract is: a key this projection has
      // not caught up with must reach the browser rather than vanish here. The
      // six below are then read defensively because they are the ones the panes
      // depend on.
      ...metrics,
      suiteId: text(metrics.suiteId) ?? text(row.suite_id),
      passed: numberOrNull(metrics.passed),
      total: numberOrNull(metrics.total),
      groundedness: numberOrNull(metrics.groundedness),
      relevance: numberOrNull(metrics.relevance),
      durationMs: numberOrNull(metrics.durationMs ?? metrics.duration_ms),
    },
  };
}

/**
 * `$1` is the run id, `$2` is `PLAN_APPROVAL_MESSAGE`, `$3` is the caller.
 *
 * Mirrors how `RUNS_QUERY` labels a run, and now mirrors its scope too: a run id
 * is a message id, so without the caller predicate this returned any user's
 * prompt, answer and address to anyone who could name one.
 */
export const RUN_TRACE_MESSAGE_QUERY = `
  SELECT m.id, m.conversation_id, m.created_at, m.response_json, m.trace_id,
         c.user_email AS stakeholder,
         COALESCE((SELECT u.content FROM ${APP_SCHEMA}.messages u
            WHERE u.conversation_id = m.conversation_id AND u.role = 'user'
              AND u.content <> $2 AND u.created_at <= m.created_at
            ORDER BY u.created_at DESC LIMIT 1),
           c.title
         ) AS prompt
  FROM ${APP_SCHEMA}.messages m
  JOIN ${APP_SCHEMA}.conversations c ON c.id = m.conversation_id
  WHERE m.id = $1 AND c.user_email = $3`;

/**
 * `$1` is the run id, `$2` is the caller.
 *
 * Shared, like the benchmark half of `RUNS_QUERY`, and withholding the owner's
 * address on the same terms.
 */
export const RUN_TRACE_BENCHMARK_QUERY = `
  SELECT b.id, b.suite_id, b.status, b.metrics_json, b.created_at,
         CASE WHEN b.user_email = $2 THEN b.user_email ELSE '${SHARED_RUN_OWNER}' END AS user_email
  FROM ${APP_SCHEMA}.benchmark_runs b
  WHERE b.id = $1`;

// ---------------------------------------------------------------------------
// Preflight

const PreflightStatus = z.enum(['ok', 'failed', 'unverified']);

/**
 * The wire still says `note`, and it will keep saying it until the model is
 * re-logged.
 *
 * `guidance` is the name INSIDE this app. The serving endpoint builds its own
 * preflight report and sends `note`, and that report is baked into a logged
 * model version: renaming the field here without this made every agent-sourced
 * report fail validation, which is not a visible error but a silent downgrade --
 * the route stops finding the failed checks and answers `200` where it owes a
 * `503`. A release-gating status code, wrong, from a rename.
 *
 * So the rename is normalised on the way in rather than negotiated. Accepted
 * because the report predates the rename, NOT as a field a new producer may use:
 * anything written in this repository writes `guidance`.
 */
function withGuidance(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const remedy = value as Record<string, unknown>;
  if (typeof remedy.guidance === 'string') return remedy;
  if (typeof remedy.note !== 'string') return remedy;
  const { note, ...rest } = remedy;
  return { ...rest, guidance: note };
}

const PreflightRemedySchema = z.preprocess(
  withGuidance,
  z.looseObject({
    /**
     * `ui` is a third kind and not a cosmetic one: it is something the READER
     * does, in their own browser, with no workspace authority at all. The only
     * one is opening the app in a private window, which is the whole remedy for a
     * sign-in that is behind the app's declared scopes. Rendering it as a command
     * would put it in a code block and send somebody looking for a terminal.
     */
    kind: z.enum(['sql', 'cli', 'ui']),
    statement: z.string(),
    /**
     * The one line a reader needs to carry the statement out correctly, or `''`.
     *
     * NOT THE "WHY THIS IS THE FIX" PARAGRAPH, which is what this field held under
     * its old name `note` and which is gone. See `DiagnosisRemedy.guidance` in
     * `shared/stated-cause.ts` for the test a sentence has to pass to be here, and
     * `remedy-guidance.test.ts` for the check that holds every producer to it.
     */
    guidance: z.string(),
    /**
     * Who can actually run this, when `kind` does not imply it.
     *
     * Empty means the default for the kind, which is what almost every remedy
     * wants: a `sql` remedy is a GRANT for a metastore admin, and a `cli` remedy
     * is for someone who can manage the object. The exception is a remedy about
     * the APP rather than about the workspace -- a scope the app never declared --
     * where both defaults send the reader to an admin who cannot help, because the
     * fix is a line in this repository's bundle and a restart.
     */
    run_by: z.string().optional(),
  })
);
const PreflightCheckSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  label: z.string(),
  status: PreflightStatus,
  detail: z.string(),
  checked_with: z.string(),
  duration_ms: z.number(),
  error: z.string(),
  remedy: PreflightRemedySchema.nullable(),
  /**
   * When the object's CONTENT was last written, for the objects that hold
   * content someone rebuilds rather than serving it live. ISO 8601.
   *
   * `''` MEANS THE WORKSPACE DID NOT REPORT ONE, and it is the reason this
   * field exists rather than the age being computed where it is drawn. A card
   * that has no timestamp has to say so; a card given the probe time, or the
   * deployment time, or `Date.now()` would read as freshness while meaning
   * nothing at all. Optional rather than defaulted because most subjects have
   * no content to age and the orchestrator's own report predates the field;
   * absent and `''` mean the same thing to every reader, which is "not
   * reported".
   */
  content_at: z.string().optional(),
  /**
   * Which of the three ways an `unverified` check established nothing.
   *
   * `refused` means the workspace answered no, `unreachable` means the call
   * broke before an answer, `unasked` means nobody ran it. The status cannot
   * carry this and must not be widened to try: all three are correctly
   * "nobody established it either way", and collapsing any of them into
   * `failed` prints "Blocked" over an object nothing reached (D6, D8). But a row
   * reading `Not checked` beside `HTTP 403` contradicts itself, which is what
   * this separates. Optional: a model version logged before it existed reports
   * none, and `shared/check-verdict.ts` reads that absence without guessing a
   * refusal.
   */
  stopped: z.enum(['refused', 'unreachable', 'unasked']).optional(),
  /**
   * The permission a refusal turned on, in the Apps-API spelling, where one was
   * established.
   *
   * A NAME RATHER THAN A FLAG, and set only by the branch of
   * `dependency-probes.ts` that read a scope out of the refusal or off the
   * token. A 403 that established a missing GRANT carries none, because the
   * scope was ruled out rather than implicated, and a check nothing refused
   * carries none either.
   *
   * It exists so a surface can tell a shortfall in a permission this app treats
   * as optional (`shared/optional-user-api-scopes.ts`) from a finding somebody
   * has to act on, WITHOUT reading the prose back. The Connections panel used to
   * have no way to make that distinction and so drew three optional catalog
   * shortfalls under a heading reading "What to fix". Matching on the sentence
   * instead would be the second copy of the scope vocabulary this codebase has
   * already been bitten by; see `SCOPE_BY_API_PREFIX`.
   */
  scope: z.string().optional(),
});
/**
 * One setting the orchestrator resolved, with where the value came from.
 *
 * Loose and defaulted throughout, because the agent and the app deploy
 * separately: a model version logged before a field existed must not fail this
 * parse and drop the whole report. `source: ''` means the version did not record
 * provenance, which readers have to present as unknown rather than as `artifact`.
 */
const PreflightConfigurationSchema = z.looseObject({
  key: z.string(),
  env_var: z.string().default(''),
  value: z.unknown().default(''),
  source: z.string().default(''),
  mutability: z.string().default(''),
  baked: z.boolean().default(false),
  required: z.boolean().default(false),
});
export const PreflightReportSchema = z.looseObject({
  checked_at: z.string(),
  status: PreflightStatus,
  principal: z.string(),
  principal_resolved: z.boolean(),
  table_source: z.string(),
  // Both defaulted rather than required, and for the same reason: a version
  // logged before either existed reports neither, and refusing its report would
  // turn "this deployment is older than the feature" into "the endpoint is
  // broken". Empty means unknown at every reader.
  build_sha: z.string().default(''),
  configuration: z.array(PreflightConfigurationSchema).default([]),
  checks: z.array(PreflightCheckSchema),
  assumptions: z.array(z.string()),
});
export type PreflightCheck = z.infer<typeof PreflightCheckSchema>;
export type PreflightRemedy = z.infer<typeof PreflightRemedySchema>;
export type PreflightConfiguration = z.infer<typeof PreflightConfigurationSchema>;
export type PreflightReport = z.infer<typeof PreflightReportSchema> & {
  counts: { ok: number; failed: number; unverified: number };
  /**
   * WHO MEASURED THIS, in the only three answers there are.
   *
   * 'agent' means checks ran inside the serving endpoint, so the values below
   * were observed there. 'app' means the endpoint never answered and this server
   * is all that ran. 'configuration' is the third, and it exists because
   * collapsing it into 'agent' cost a release: a current model version answers
   * with what it is CONFIGURED with and runs no checks at all, and a report built
   * from that carried 'agent' and was read downstream as "an agent measured
   * this". The page then reported agreement it had never measured. A value that
   * came back from the endpoint is not the same claim as a value the endpoint
   * proved it can reach, and this field is where the difference is kept.
   */
  source: 'agent' | 'app' | 'configuration';
};

/**
 * The body that asks the endpoint to check its dependencies.
 *
 * The flag stays a bare `true` when there is no candidate, so a version logged
 * before any of this existed receives the same bytes it always did.
 */
export function buildPreflightServingBody(candidate?: Record<string, unknown>): Record<string, unknown> {
  // The agent short-circuits on this flag before it looks for a question, but
  // a user turn is sent anyway so the payload stays a valid agent request.
  const preflight = candidate && Object.keys(candidate).length > 0 ? { candidate } : true;
  return {
    input: [{ role: 'user', content: 'preflight' }],
    custom_inputs: { preflight },
  };
}

/**
 * Whether the endpoint understood that it was asked about a proposed
 * configuration, rather than answering about its own.
 *
 * A model version logged before candidate preflight existed ignores the
 * candidate entirely and returns a perfectly healthy report about the resources
 * it was baked with. Taking that as proof shows green ticks for a Genie space
 * the checks never touched.
 */
export function candidateAcknowledgement(value: unknown): {
  accepted: boolean;
  rejected: string;
  echoed: Array<Record<string, unknown>>;
} {
  const custom =
    value && typeof value === 'object'
      ? ((value as Record<string, unknown>).custom_outputs as Record<string, unknown> | undefined)
      : undefined;
  const echoed = custom?.candidate;
  return {
    accepted: custom?.accepts_candidate === true,
    rejected: typeof custom?.candidate_rejected === 'string' ? custom.candidate_rejected : '',
    echoed: Array.isArray(echoed) ? (echoed as Array<Record<string, unknown>>) : [],
  };
}

export function extractPreflightReport(value: unknown): z.infer<typeof PreflightReportSchema> | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (isEndpointError(record)) return null;
  const custom = record.custom_outputs;
  if (custom && typeof custom === 'object') {
    const parsed = PreflightReportSchema.safeParse((custom as Record<string, unknown>).preflight);
    if (parsed.success) return parsed.data;
  }
  for (const key of ['data', 'response', 'result', 'body']) {
    if (record[key]) {
      const nested = extractPreflightReport(record[key]);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * The configuration list out of a serving response, wherever the version put it.
 *
 * WHY THIS EXISTS SEPARATELY FROM {@link extractPreflightReport}. That function
 * looks for `custom_outputs.preflight`, which is the shape from when the endpoint
 * still ran dependency checks. It does not any more: it answers
 * `{type: 'preflight_retired', configuration: [...]}`, with the configuration at
 * the top level of `custom_outputs`. So the report parse fails, correctly, and
 * `/api/preflight` shows its retired state, also correctly -- but everything
 * downstream that wanted the CONFIGURATION rather than the checks was reading it
 * through the same function and getting nothing.
 *
 * The visible symptom was every connection reading "configured, unmeasured" on a
 * deployment whose endpoint was answering perfectly well and naming its own
 * catalog, warehouse, spaces and model. The app was comparing its environment
 * against an empty list and reporting the absence as if it were the orchestrator's
 * silence. Configuration drift, which is the entire point of that pane, could not
 * be detected at all.
 *
 * Each entry is parsed rather than passed through, so `source`, `mutability`,
 * `baked` and `required` survive: `source` is what lets the pane say a value came
 * from the artifact rather than from a guess, and it is the field a hand-rolled
 * `{key, value}` mapping loses first.
 */
export function extractConfigurationReport(value: unknown): PreflightConfiguration[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (isEndpointError(record)) return [];
  const custom =
    record.custom_outputs && typeof record.custom_outputs === 'object'
      ? (record.custom_outputs as Record<string, unknown>)
      : null;
  const nestedReport =
    custom?.preflight && typeof custom.preflight === 'object' ? (custom.preflight as Record<string, unknown>) : null;
  // Newest shape first, then the one inside a full report, then a bare top-level
  // list. A version that sends both is sending the same thing twice.
  for (const candidate of [custom?.configuration, nestedReport?.configuration, record.configuration]) {
    if (!Array.isArray(candidate)) continue;
    const entries = candidate
      .map((entry) => PreflightConfigurationSchema.safeParse(entry))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
      .filter((entry) => entry.key);
    if (entries.length > 0) return entries;
  }
  for (const key of ['data', 'response', 'result', 'body']) {
    if (record[key]) {
      const nested = extractConfigurationReport(record[key]);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

/** The app's own service principal, as the `permissions update` CLI names it. */
function appPrincipal() {
  return process.env.DATABRICKS_CLIENT_ID?.trim() || '<app-service-principal>';
}

/**
 * Whether this server can invoke the agent: the one link in the chain the
 * agent cannot report on, because a failure here is why it never ran.
 */
export function agentEndpointCheck(
  endpointName: string,
  outcome: { status: 'ok' | 'failed'; detail: string; error?: string; remedy?: PreflightRemedy }
): PreflightCheck {
  return {
    id: 'agent-endpoint',
    kind: 'serving-endpoint',
    name: endpointName || '(unset)',
    label: `Agent endpoint · ${endpointName || '(unset)'}`,
    status: outcome.status,
    detail: outcome.detail,
    checked_with: 'POST /serving-endpoints/:name/invocations',
    duration_ms: 0,
    error: outcome.error ?? '',
    remedy:
      outcome.status === 'ok' || !endpointName
        ? null
        : (outcome.remedy ?? {
            kind: 'cli',
            statement:
              `databricks permissions update serving-endpoints ${endpointName} --json '` +
              `{"access_control_list":[{"service_principal_name":"${appPrincipal()}",` +
              `"permission_level":"CAN_QUERY"}]}'`,
            // No guidance. What stood here said the app service principal is the
            // caller and that an endpoint is a workspace object; the statement
            // names the principal in `service_principal_name` and is itself the
            // API call, so both facts are already in front of the reader.
            guidance: '',
          }),
  };
}

/** A cheap endpoint-object reading. It proves visibility and state, never query permission. */
export function agentEndpointMetadataCheck(
  endpointName: string,
  outcome: { status: 'ok' | 'failed'; detail: string; error?: string }
): PreflightCheck {
  return {
    id: 'agent-endpoint',
    kind: 'serving-endpoint',
    name: endpointName || '(unset)',
    label: `Agent endpoint · ${endpointName || '(unset)'}`,
    status: outcome.status,
    detail: outcome.detail,
    checked_with: 'GET /api/2.0/serving-endpoints/:name',
    duration_ms: 0,
    error: outcome.error ?? '',
    // A metadata read cannot distinguish CAN_QUERY from its absence. Offering a
    // query grant here would claim that CAN_VIEW proved a query denial.
    remedy: null,
  };
}

export function countChecks(checks: PreflightCheck[]) {
  return {
    ok: checks.filter((check) => check.status === 'ok').length,
    failed: checks.filter((check) => check.status === 'failed').length,
    unverified: checks.filter((check) => check.status === 'unverified').length,
  };
}

/**
 * The overall verdict. Never 'ok' while anything is unverified: a check that
 * did not run is not a check that passed, and collapsing the two is how a
 * green page ends up meaning nothing.
 */
export function overallStatus(checks: PreflightCheck[]): 'ok' | 'failed' | 'unverified' {
  const counts = countChecks(checks);
  if (counts.failed > 0) return 'failed';
  if (counts.unverified > 0 || checks.length === 0) return 'unverified';
  return 'ok';
}

/**
 * The HTTP status a preflight report is served with.
 *
 * A DIAGNOSTIC THAT ANSWERS 200 WHILE REPORTING A FAILED DEPENDENCY IS ONE
 * NOTHING CAN GATE ON. Everything that polls a URL and reads its status code,
 * which is every uptime check and every release script anyone writes next, was
 * told this app was well while its store was unreadable. The body always said
 * so; nothing was reading the body.
 *
 * `unverified` stays 200 deliberately. A check that did not run is not a check
 * that failed, and answering 503 for it would take the app's own explanation of
 * why it is degraded off the air on the days it is most needed. This route
 * exists to keep answering while the rest of the API refuses.
 *
 * Both consumers read the body before the status (client/src/preflight.ts and
 * DataEntityLinks.tsx), and so does the certification runner, so none of them
 * loses a report to this.
 */
export function preflightHttpStatus(report: PreflightReport): number {
  return report.status === 'failed' ? 503 : 200;
}

/**
 * Add the app's own storage verdict to a report and re-derive the totals.
 *
 * Used on the paths where the agent never answered: those reports would
 * otherwise omit Lakebase entirely, and an omitted dependency reads as one
 * nobody needed to check.
 */
export function withStorageCheck(report: PreflightReport, storage: PreflightCheck): PreflightReport {
  const checks = [...report.checks, storage];
  return { ...report, checks, status: overallStatus(checks), counts: countChecks(checks) };
}

/**
 * A report for the case where the agent never answered.
 *
 * Shaped exactly like a real one so the page renders it the same way, and
 * explicitly *not* a healthy one: nothing behind the endpoint was reached, so
 * nothing behind it gets a verdict.
 */
export function preflightFailure(check: PreflightCheck, assumption: string): PreflightReport {
  const checks = [check];
  return {
    checked_at: new Date().toISOString(),
    status: overallStatus(checks),
    principal: '',
    principal_resolved: false,
    table_source: 'unknown',
    // Empty, not omitted, and not borrowed from anywhere. Nothing behind the
    // endpoint answered, so this report knows neither which commit the served
    // version was logged from nor what it was configured with, and both of
    // those read as unknown at every consumer.
    build_sha: '',
    configuration: [],
    checks,
    assumptions: [assumption],
    counts: countChecks(checks),
    source: 'app',
  };
}

/**
 * The address a local development session owns its rows as.
 *
 * A reserved `.invalid` domain (RFC 2606) rather than a mailbox, for two
 * reasons. It cannot collide with a real workspace user, so a developer can
 * never land on another principal's rows by accident. And it is visibly not a
 * person, so a row written on a laptop cannot later be read as one a named
 * colleague created, which is exactly what the previous default did, by
 * writing every unidentified request to the deployer's own address.
 */
export const DEVELOPMENT_IDENTITY = 'local-development@app.invalid';

/**
 * Whether this process is the deployed app rather than someone's laptop.
 *
 * `NODE_ENV` is the discriminator AppKit uses for the same purpose: its
 * execution context calls the forwarded identity header "required in
 * production" and only falls back under `NODE_ENV=development`, marking the
 * fallback in telemetry so it cannot be mistaken for a real user.
 *
 * It is a safe gate here because `app.yaml` runs `npm run start`, and that
 * script sets `NODE_ENV=production` itself rather than reading it from the
 * environment. The deployed app therefore cannot be talked into development
 * mode by anything the platform or a resource definition injects.
 */
function isDeployed() {
  return process.env.NODE_ENV === 'production';
}

/**
 * Thrown when a request that needs a user does not have one.
 */
export class IdentityUnavailableError extends Error {
  constructor() {
    super(
      'This request carries no end-user identity. Databricks Apps sets x-forwarded-email on ' +
        'authenticated traffic, so its absence means there is no user to act as and no rows ' +
        'that may be read or written.'
    );
    this.name = 'IdentityUnavailableError';
  }
}

/**
 * The caller, or nothing at all.
 *
 * Strict even though {@link requireIdentity} already refuses unidentified
 * requests at the edge, so that a route added later without the middleware
 * fails loudly instead of quietly inheriting someone's data.
 */
export function userEmail(req: Request): string {
  const forwarded = req.header('x-forwarded-email')?.trim();
  if (forwarded) return forwarded;
  if (isDeployed()) throw new IdentityUnavailableError();
  return DEVELOPMENT_IDENTITY;
}

/**
 * Diagnostics that have to keep answering when everything else is refusing.
 *
 * Each describes the app's own health or configuration rather than anyone's
 * data, and they are what someone reads to find out *why* the rest of the API is
 * returning 401. Gating them would hide the explanation behind the symptom.
 */
const IDENTITY_OPTIONAL_ROUTES = new Set([
  '/api/preflight',
  '/api/storage',
  '/api/settings',
  // The app's own shape: which endpoint it invokes, which workspace it thinks
  // it is in, what it was built from. It names no conversation and no person
  // but the app's own service principal, and it is the other half of what
  // somebody reads to find out why the rest of the API is refusing them.
  '/api/architecture',
]);

/**
 * Refuse user-scoped work that has no user, once, at the edge.
 */
export function requireIdentity(req: Request, res: Response, next: NextFunction) {
  const path = req.path.toLowerCase();
  if (!path.startsWith('/api/') || IDENTITY_OPTIONAL_ROUTES.has(path)) {
    next();
    return;
  }
  try {
    userEmail(req);
  } catch (error) {
    if (!(error instanceof IdentityUnavailableError)) throw error;
    console.error(
      `[identity] REFUSED ${req.method} ${req.path}: no x-forwarded-email on the request, so there is ` +
        'no user to scope conversations, attachments, feedback or benchmark runs to. Serving no data ' +
        'rather than guessing an owner. Expected for non-interactive calls; if a signed-in browser ' +
        'sees this, the app is behind a proxy path that drops the header.'
    );
    res.status(401).json({
      error: 'identity_unavailable',
      detail:
        'This request has no signed-in user. The app scopes every conversation, document and ' +
        'benchmark run to the person who created it, and will not fall back to another identity.',
    });
    return;
  }
  next();
}

/**
 * Whether the rail lists everyone's conversations or only the caller's.
 *
 * Named for the `PLAYER_INSIGHTS_` family rather than a new prefix, because
 * `PLAYER_INSIGHTS_EXPERIMENT_ID` and `PLAYER_INSIGHTS_MAX_OUTPUT_TOKENS`
 * already established it and a second convention is a second thing to search
 * for when a value does not arrive.
 */
export const SHARED_CONVERSATION_RAIL_ENV = 'PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL';

export type SharedRailReason = 'unset' | 'enabled' | 'disabled' | 'unrecognised';

export interface SharedRailResolution {
  shared: boolean;
  /** What the environment actually carried, for the boot log. */
  raw: string;
  reason: SharedRailReason;
}

/**
 * Resolve the flag, failing closed on anything that is not an explicit yes.
 */
export function resolveSharedConversationRail(raw: string | undefined): SharedRailResolution {
  const value = (raw ?? '').trim();
  if (value === '') return { shared: false, raw: value, reason: 'unset' };
  const normalised = value.toLowerCase();
  if (normalised === 'true') return { shared: true, raw: value, reason: 'enabled' };
  if (normalised === 'false') return { shared: false, raw: value, reason: 'disabled' };
  return { shared: false, raw: value, reason: 'unrecognised' };
}

/**
 * Read once, at boot, and never re-read per request.
 *
 * A per-request read would let the rail's scope change under a running app,
 * which makes an audit of who could see what unanswerable after the fact.
 */
let sharedRail: SharedRailResolution = { shared: false, raw: '', reason: 'unset' };

/** What the rail is currently scoped to. Exported for the identity payload. */
export function sharedConversationRail() {
  return sharedRail.shared;
}

function announceSharedConversationRail(resolution: SharedRailResolution) {
  sharedRail = resolution;
  if (resolution.reason === 'unrecognised') {
    console.error(
      `[rail] ${SHARED_CONVERSATION_RAIL_ENV} is set to ${JSON.stringify(resolution.raw)}, which is not a ` +
        'value this app recognises, so it has been IGNORED and the rail stays scoped to each user. ' +
        'The only value that turns sharing on is "true". Nothing is broken and nothing is exposed: ' +
        'but if a shared rail was intended, it is not on.'
    );
    return;
  }
  if (resolution.shared) {
    console.warn(
      `[rail] SHARED CONVERSATION RAIL IS ON (${SHARED_CONVERSATION_RAIL_ENV}=${JSON.stringify(resolution.raw)}). ` +
        "Every signed-in user can see, and open, every other user's conversations and the questions and " +
        'answers inside them. This is a deliberate setting for a shared evaluation workspace and it is not ' +
        'the default. Deleting, asking and uploading remain scoped to the owner.'
    );
    return;
  }
  console.log(
    `[rail] Conversations are scoped to each user (${SHARED_CONVERSATION_RAIL_ENV} ` +
      `${resolution.reason === 'unset' ? 'is unset' : `= ${JSON.stringify(resolution.raw)}`}).`
  );
}

/**
 * Settle the rail's scope against what this deployment last decided, once the
 * store is migrated far enough to hold the answer.
 *
 * THE DEFECT THIS FIXES. Deploy-from-Git replaces app.yaml with the copy
 * committed in `build/deploy/`, and that copy authors
 * `PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL: 'false'` -- correctly, because a
 * public artifact must not open one reader's conversations to another. A bundle
 * release fills the same variable from `var.shared_conversation_rail`, and the
 * example target sets it to "true" so its seeded evaluation conversations are
 * visible to every reviewer. So a Git deploy over a released app silently
 * narrowed the rail from everyone's conversations to the reader's own, and a
 * reader who owned none of the stored history was told "No saved conversations
 * yet" while Run Explorer's shared benchmark rows and Monitoring's all-user view
 * still listed all of it. Nothing was lost and nothing said so.
 *
 * The schema had the same problem and is solved the same way -- see
 * `shared/app-schema.ts` -- except that a schema can be discovered from Postgres
 * because it is an object with an owner, and a policy cannot. So a release
 * records the decision and a Git deploy reads it back; see
 * `lib/deployment-decisions.ts` for why a Git deploy never records.
 *
 * FAILS CLOSED AT EVERY STEP. The env-derived scope is already announced by the
 * time this runs, so no request is ever served under an unresolved one; an
 * unreadable or unrecorded decision leaves that value standing; and the stored
 * value goes through `resolveSharedConversationRail`, so a corrupted row widens
 * nothing.
 */
async function settleSharedConversationRail(appkit: InsightsAppKit): Promise<void> {
  const authored = process.env[SHARED_CONVERSATION_RAIL_ENV];
  const preserved = await preserveEnvDecision({
    store: appkit.lakebase,
    table: appTable(DEPLOYMENT_DECISIONS_TABLE_NAME),
    decision: SHARED_RAIL_DECISION,
    authored,
    env: process.env as Record<string, string | undefined>,
    recordedBy: 'app boot',
  });
  if (!preserved.restored) return;
  const resolution = resolveSharedConversationRail(preserved.value);
  console.warn(
    `[rail] This deploy carried ${SHARED_CONVERSATION_RAIL_ENV}=${JSON.stringify(preserved.authored ?? '')} ` +
      "because Deploy-from-Git replaces app.yaml with the public artifact's copy, which cannot state a " +
      `deployment's own decision. The recorded decision is ${JSON.stringify(preserved.value ?? '')}, so that is ` +
      'what the rail uses. Release the bundle to change it; a Git deploy never records one.'
  );
  announceSharedConversationRail(resolution);
}

/**
 * The rail read, and the read of one conversation's messages.
 */
export const CONVERSATION_RAIL_LIMIT = 100;

/**
 * What each conversation's latest answered turn ended on, for the rail's badge.
 *
 * WHY THIS IS NOT READ OFF `/api/runs`. The rail lists everyone's
 * conversations when the shared rail is on, but `RUNS_QUERY` is scoped
 * `AND c.user_email = $2` and an identity-boundary test holds it there. So the
 * rail drew a Complete badge and a wall time on the reader's own rows and
 * nothing at all on anybody else's -- reported as "other user questions should
 * show badges too". The scoping is right for that route: a run carries the
 * prompt, the trace, the generated SQL and the spaces it opened.
 *
 * What a badge needs is none of that. It is the verdict and the wall clock, and
 * both are already implied by a row this query returns unscoped: the rail is
 * showing the reader that the conversation exists and what it was called.
 * Ratings deliberately do NOT come through here -- a rating is one reader's
 * opinion and stays on `/api/runs`, which knows whose it is.
 *
 * The verdict is interpolated from the same `VERDICT_STAGE_EXEMPTION_SQL` that
 * `RUNS_QUERY` uses, so the badge on the rail and the status in the Run
 * Explorer cannot come to different conclusions about one turn.
 */
const CONVERSATION_VERDICT_JOIN = `
  LEFT JOIN LATERAL (
    SELECT
      ${overlayStatusSql(
        classifiedRunStatusSql({
          trace: "m.response_json->'trace'",
          payload: 'm.response_json',
          caveats: "m.response_json->'caveats'",
        })
      )} AS status,
      (jsonb_path_exists(m.response_json->'trace', '$.stages[*] ? (@.id == "cap")')
        OR ${DEADLINE_TRUNCATED_SQL.split('caveats').join("m.response_json->'caveats'")}) AS truncated,
      ROUND((m.response_json->'trace'->>'totalMs')::numeric)::int AS duration_ms
    FROM ${APP_SCHEMA}.messages m
    ${overlayJoinSql('m.id')}
    WHERE m.conversation_id = c.id
      AND m.role = 'assistant'
      AND jsonb_typeof(m.response_json->'trace') = 'object'
    ORDER BY m.created_at DESC
    LIMIT 1
  ) verdict ON TRUE`;

const CONVERSATION_LIST_COLUMNS =
  'c.id, c.title, c.updated_at, c.user_email, ' +
  'verdict.status, verdict.truncated, verdict.duration_ms';

function conversationListQuery(email: string) {
  return sharedRail.shared
    ? {
        sql:
          `SELECT ${CONVERSATION_LIST_COLUMNS} FROM ${APP_SCHEMA}.conversations c` +
          `${CONVERSATION_VERDICT_JOIN} ` +
          `ORDER BY c.updated_at DESC LIMIT ${CONVERSATION_RAIL_LIMIT}`,
        params: [] as unknown[],
      }
    : {
        sql:
          `SELECT ${CONVERSATION_LIST_COLUMNS} FROM ${APP_SCHEMA}.conversations c` +
          `${CONVERSATION_VERDICT_JOIN} ` +
          `WHERE c.user_email = $1 ORDER BY c.updated_at DESC LIMIT ${CONVERSATION_RAIL_LIMIT}`,
        params: [email] as unknown[],
      };
}

function conversationMessagesQuery(conversationId: string, email: string) {
  // `c.user_email AS asked_by` rather than a column on the message: the ask
  // route refuses a conversation somebody else owns, so the owner IS the asker
  // and storing it twice would be the same fact in two places. The join was
  // already here for the tenancy predicate, so the fourth identity costs a
  // column in the projection and nothing in the write path.
  // `execution_mode` and `execution_identity_verified` are here because the
  // answer footer says whose grants the figures were read under, and it derives
  // that sentence from what the run reported rather than from a constant. A run
  // reports it on the live reply; a reopened one has nowhere to report it from
  // except this projection, because the identity is recorded in columns beside
  // the answer rather than inside the stored JSON. Without them every answer in
  // the rail said its identity was unconfirmed -- true of what the browser had
  // been sent, and false of what the row knew.
  //
  // Both, never one. They are separate facts: the mode is which credential the
  // endpoint was called with, the flag is whether this app could prove the
  // forwarded token belonged to the reader. A half-filled pair is read as no
  // claim at all downstream, which is the honest reading of a record that could
  // not state one, and that only works if both make the trip.
  //
  // THE RATING IS THE SAME SHAPE OF OMISSION, found the same way: a reader rated
  // an answer, was told the rating was saved, came back, and the thumbs were
  // blank again. The write lands -- Run Explorer reads these rows and shows the
  // score -- and this projection was where it stopped. `feedback` is keyed on the
  // message id and carries no conversation id, so it is a scalar subquery rather
  // than a join, and it is scoped to the caller: the feedback route accepts any
  // message id, so without the address predicate a reopened answer would show
  // whatever score somebody else gave it. The comment comes with the score
  // because they were entered together and the box is prefilled from it.
  const select = `SELECT m.id, m.role, m.content, m.response_json, m.trace_id, m.created_at,
                m.app_principal, m.serving_principal, m.serving_principal_observed_at,
                m.access_mode, m.execution_mode, m.execution_identity_verified,
                c.user_email AS asked_by,
                (SELECT f.usefulness FROM ${APP_SCHEMA}.feedback f
                 WHERE f.message_id = m.id AND f.user_email = $2 AND f.usefulness IS NOT NULL
                 ORDER BY f.created_at DESC LIMIT 1) AS usefulness,
                (SELECT f.comment FROM ${APP_SCHEMA}.feedback f
                 WHERE f.message_id = m.id AND f.user_email = $2 AND f.usefulness IS NOT NULL
                 ORDER BY f.created_at DESC LIMIT 1) AS feedback_comment
         FROM ${APP_SCHEMA}.messages m
         JOIN ${APP_SCHEMA}.conversations c ON c.id = m.conversation_id`;
  return sharedRail.shared
    ? {
        // `$2` is still the caller on the shared rail, and deliberately so. The
        // rail shares whose question and whose answer; a rating is one reader's
        // opinion of it, and showing it to everybody would turn the thumbs into
        // a vote nobody agreed to publish.
        sql: `${select}\n         WHERE m.conversation_id = $1\n         ORDER BY m.created_at`,
        params: [conversationId, email] as unknown[],
      }
    : {
        sql: `${select}\n         WHERE m.conversation_id = $1 AND c.user_email = $2\n         ORDER BY m.created_at`,
        params: [conversationId, email] as unknown[],
      };
}

/**
 * The newest durable run for one conversation.
 *
 * Kept separate from the message list because an in-flight run has no assistant
 * message yet. Reopening a conversation used to inspect messages alone, find
 * only the user's question, and conclude that nothing was happening. This row
 * is written before Model Serving starts and remains readable after the
 * original SSE connection is gone.
 */
export const CONVERSATION_RUN_STATUS_QUERY = `SELECT run_id, state, created_at, updated_at, terminal_code
  FROM ${APP_SCHEMA}.runs
  WHERE conversation_id = $1 AND user_email = $2
  ORDER BY created_at DESC
  LIMIT 1`;

function isEndpointError(record: Record<string, unknown>) {
  const status = record.status ?? record.statusCode;
  return (
    Boolean(record.error) || typeof record.error_code === 'string' || (typeof status === 'number' && status >= 400)
  );
}

export function extractLiveText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (isEndpointError(record)) return null;
  if (typeof record.content === 'string') return record.content;
  if (typeof record.text === 'string') return record.text;
  for (const key of ['content', 'output', 'messages', 'choices']) {
    const items = record[key];
    if (Array.isArray(items)) {
      for (const item of items) {
        const text = extractLiveText(item);
        if (text) return text;
      }
    }
  }
  for (const key of ['message', 'data', 'response', 'result', 'body']) {
    if (record[key]) {
      const text = extractLiveText(record[key]);
      if (text) return text;
    }
  }
  return null;
}

export function extractStructuredAnswer(value: unknown): LiveAnswer | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (isEndpointError(record)) return null;
  const custom = record.custom_outputs;
  const candidates: unknown[] = [custom];
  if (custom && typeof custom === 'object') {
    const customRecord = custom as Record<string, unknown>;
    candidates.unshift(customRecord.answer, customRecord.player_insights_answer);
  }
  for (const candidate of candidates) {
    const parsed = LiveAnswerSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const undeclared = undeclaredAnswerKeys(parsed.data);
    if (undeclared.length > 0) {
      // Forwarded, not dropped, but the app renders nothing for these, so the
      // agent contract has moved ahead of the UI and someone needs to catch up.
      console.warn('[serving] Answer contains fields the app does not read:', undeclared.join(', '));
    }
    return parsed.data;
  }
  for (const key of ['data', 'response', 'result', 'body']) {
    if (record[key]) {
      const nested = extractStructuredAnswer(record[key]);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * A clarification from `custom_outputs`, or null.
 *
 * Checked BEFORE the answer contract on the ask path. A clarification carries no
 * `takeaway`, so the answer parse fails and the route would fall through to a
 * representative answer, which would answer a question the agent had just said
 * it could not answer, over an HTTP 200. That silent substitution is the failure
 * mode this whole extractor family exists to prevent.
 */
export function extractClarification(value: unknown): Clarification | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (isEndpointError(record)) return null;
  const custom = record.custom_outputs;
  if (custom && typeof custom === 'object') {
    const customRecord = custom as Record<string, unknown>;
    if (customRecord.type === 'clarification') {
      const parsed = ClarificationSchema.safeParse(customRecord.clarification);
      if (parsed.success) return parsed.data;
      console.warn(
        '[serving] Endpoint asked for clarification in a shape the app cannot read:',
        parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')
      );
    }
  }
  for (const key of ['data', 'response', 'result', 'body']) {
    if (record[key]) {
      const nested = extractClarification(record[key]);
      if (nested) return nested;
    }
  }
  return null;
}

export function extractAnalysisPlan(value: unknown): AnalysisPlan | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (isEndpointError(record)) return null;
  const custom = record.custom_outputs;
  if (custom && typeof custom === 'object') {
    const customRecord = custom as Record<string, unknown>;
    if (customRecord.type === 'plan') {
      const parsed = AnalysisPlanSchema.safeParse(customRecord.plan);
      if (parsed.success) {
        const undeclared = undeclaredPlanKeys(parsed.data);
        if (undeclared.length > 0) {
          // Forwarded and stored, but the plan screen renders nothing for these,
          // so the user is approving a plan with a part they cannot see.
          console.warn('[serving] Plan contains fields the app does not read:', undeclared.join(', '));
        }
        return parsed.data;
      }
    }
  }
  for (const key of ['data', 'response', 'result', 'body']) {
    if (record[key]) {
      const nested = extractAnalysisPlan(record[key]);
      if (nested) return nested;
    }
  }
  return null;
}

interface HistoryRow {
  role?: unknown;
  content?: unknown;
  response_json?: unknown;
}

export function buildServingHistory(rows: HistoryRow[]) {
  return rows
    .filter(
      (row): row is HistoryRow & { role: 'user' | 'assistant'; content: string } =>
        (row.role === 'user' || row.role === 'assistant') && typeof row.content === 'string'
    )
    .slice(-12)
    .map((row) => {
      if (row.role === 'user') return { role: row.role, content: row.content };
      let response = row.response_json;
      if (typeof response === 'string') {
        try {
          response = JSON.parse(response) as unknown;
        } catch {
          response = null;
        }
      }
      if (response && typeof response === 'object') {
        const record = response as Record<string, unknown>;
        if (record.type === 'plan' && record.plan && typeof record.plan === 'object') {
          const plan = record.plan as Record<string, unknown>;
          const summary = typeof plan.summary === 'string' ? plan.summary : row.content;
          const planId = typeof plan.id === 'string' ? plan.id : '';
          return {
            role: row.role,
            content: `${summary} Plan ID: ${planId}`.trim(),
          };
        }
        if (typeof record.takeaway === 'string') {
          const narrative = typeof record.narrative === 'string' ? record.narrative : row.content;
          return {
            role: row.role,
            content: `${record.takeaway}\n\n${narrative}`.slice(0, 4000),
          };
        }
      }
      return { role: row.role, content: row.content.slice(0, 4000) };
    });
}

function attachmentExtension(filename: string) {
  return filename.toLowerCase().split('.').pop() ?? '';
}

export async function extractAttachmentText(filename: string, bytes: Buffer) {
  // PDFs are binary by definition, so they must bypass the UTF-8 path and its NUL guard.
  // `PdfTextError` messages are written for the user, so they propagate to the 422 body.
  if (isPdfFilename(filename)) {
    return extractPdfText(bytes, { maxChars: MAX_ATTACHMENT_TEXT });
  }
  const extension = attachmentExtension(filename);
  if (!ALLOWED_ATTACHMENT_TYPES.has(extension)) {
    throw new Error('Use a PDF, TXT, Markdown, CSV, or JSON file.');
  }
  // A renamed binary decodes to replacement characters rather than failing, which would
  // otherwise be stored and sent to the agent as noise.
  if (bytes.subarray(0, 8000).includes(0)) {
    throw new Error('This file looks binary. Use a plain-text TXT, Markdown, CSV, or JSON file.');
  }
  return bytes.toString('utf8').slice(0, MAX_ATTACHMENT_TEXT);
}

export function identityPayload(req: Request) {
  const signedInAs = userEmail(req);
  return {
    signedInAs,
    // Named so the client can label a development session as one instead of
    // rendering "You are signed in as …" over an address nobody is signed in as.
    identitySource:
      signedInAs === DEVELOPMENT_IDENTITY ? ('development-fallback' as const) : ('databricks-apps' as const),
    executionIdentity: appServicePrincipal() ?? 'Astrolabe service principal',
    // Was a literal, which was true of every deployment right up until the gate
    // gave a user something else to choose. It is now whatever this server last
    // established for this user, and established is the operative word: see
    // `declareAccessMode`, which refuses to take `user-verified` on trust.
    executionMode: accessModeFor(signedInAs),
    accessDecision: accessDecisionFor(signedInAs),
    // The endpoint's own principal when preflight has reported it. Null until
    // then: it is only knowable from inside the endpoint. Who runs asks is
    // `analyticalExecution` below, not this field.
    servingPrincipal: observedServingPrincipal(),
    // Reported so a rail carrying other people's conversations says so on the
    // page rather than only in the boot log. A widened scope that is only
    // visible to whoever reads stdout is the silent kind of configuration this
    // app keeps getting bitten by.
    sharedConversationRail: sharedConversationRail(),
    // What the NEXT question would execute as, decided by the same function the
    // ask route decides it with rather than by a sentence about it here. The
    // panel above it has been wrong before, in the direction that matters: it
    // told every reader their questions run under an application's grants,
    // which stopped being true the day the fallback was removed, and a page
    // that under-claims the boundary teaches people not to trust it.
    //
    // A decision, not a claim about one that happened. Nothing is executed to
    // produce it, so `verified` here means the forwarded token binds to the
    // signed-in user, not that any query ran.
    analyticalExecution: analyticalExecution(req, signedInAs),
    // What the sign-in this browser presented was shown to carry, and the one
    // action that helps when it is short of something.
    //
    // HERE RATHER THAN ON THE CONNECTIONS PAGE, and that is the point of it. A
    // reader in this state does not go looking for a permissions panel; they
    // open the app, see red rows or an error, and read whatever the app says
    // first. Reporting it on the identity payload puts it on every page at once,
    // because the header already reads this route on every load.
    //
    // The token's own scope list rides along whether or not there is anything
    // wrong with it. It was already being read inside `dependency-probes.ts` and
    // reported by nothing, so the single fact a stale-session diagnosis turns on
    // could not be checked by the person doing the diagnosing.
    session: sessionFreshness({
      token: forwardedUserToken(req),
      declared: declaredUserApiScopes(),
    }),
  };
}

/**
 * The mode an ask from this request's identity would run under, for display.
 *
 * Refusals collapse to unverified rather than surfacing their code. A reader
 * looking at a permissions page has not asked anything yet, so there is no
 * request to explain the refusal of, and the code names which of two identities
 * failed to line up -- detail that belongs in the server log and in the answer
 * to an actual question, not on a page anyone can load.
 */
function analyticalExecution(req: Request, signedInAs: string): ExecutionIdentityClaim {
  const decision = decideIdentity(req, { signedInAs, required: isDeployed() });
  return decision.ok ? executionIdentityClaim(decision) : refusedIdentityClaim();
}

export function servingInvocationPath(endpointName: string) {
  return `/serving-endpoints/${encodeURIComponent(endpointName)}/invocations`;
}

let workspaceClient: import('@databricks/sdk-experimental').WorkspaceClient | undefined;

/**
 * The reader's workspace entitlements, read as the APP rather than as them.
 *
 * The forwarded user token is the wrong credential for this and would fail
 * every time: it carries only the scopes in `user_api_scopes`, none of which
 * covers SCIM, so it would be refused for a missing scope and every refusal
 * would degrade to "could not check". The app's own service principal at least
 * has a chance, and when it does not, the refusal is reported as one rather
 * than being read as an absent entitlement.
 */
function appEntitlementLookup() {
  return entitlementLookupVia(async (path: string, query: Record<string, string>) => {
    const { WorkspaceClient } = await import('@databricks/sdk-experimental');
    if (!workspaceClient) workspaceClient = new WorkspaceClient({});
    return workspaceClient.apiClient.request({
      path,
      method: 'GET',
      query,
      headers: new Headers({ Accept: 'application/json' }),
      raw: false,
    });
  });
}

/**
 * The workspace API, as the app's own service principal.
 *
 * The same credential `appEntitlementLookup` above uses, and for an overlapping
 * reason: the forwarded user token is the wrong one for this call. There the
 * reason is scopes; here it is that starting compute is not reading data and must
 * not be able to refuse a reader. `lib/warehouse-warmup.ts` carries the full
 * argument at the top of the file, which is where the next person will look.
 *
 * The SDK's `request` takes no abort signal, so the warm-up bounds it with
 * `withDeadline` on its own side rather than pretending this can be cancelled.
 */
function appWarmupTransport(): WarmupTransport {
  return async ({ path, method }) => {
    const { WorkspaceClient } = await import('@databricks/sdk-experimental');
    if (!workspaceClient) workspaceClient = new WorkspaceClient({});
    const body = await workspaceClient.apiClient.request({
      path,
      method,
      headers: new Headers({ Accept: 'application/json' }),
      // The start endpoint takes no parameters, but a POST with no body at all
      // is not something every layer between here and the control plane handles
      // the same way, and an empty object is what the endpoint expects to ignore.
      ...(method === 'POST' ? { payload: {} } : {}),
      raw: false,
    });
    return (body ?? {}) as Record<string, unknown>;
  };
}

/**
 * The one warm-up for this process.
 *
 * Process-wide rather than per-request, which is the entire point: the debounce
 * and the single flight live in this object, so ten people arriving at once share
 * one of it and produce one ping. A warm-up created per request would satisfy
 * every rule in that module and none of the requirement.
 */
const appWarehouseWarmup = createWarehouseWarmup({
  warehouseId: appWarehouseId,
  transport: appWarmupTransport(),
});
const genieWarehouseWarmup = createGenieWarehouseWarmup();

/**
 * Ping the warehouse for an arriving reader, and never let them wait for it.
 *
 * Returns `void` rather than a promise on purpose: there is nothing here a
 * request handler may legitimately await, and a signature that offers a promise is
 * an invitation to `await` it in six months. The page is the thing being
 * protected -- a warm-up that delayed first paint would have spent a saved minute
 * to buy a slower open.
 */
function warmWarehouseForArrival(warmup: WarehouseWarmup): void {
  warmup
    .warm()
    .then((outcome) => {
      // Only the two an operator would act on. `already-warm` and `cooling-down`
      // are the ordinary cases -- they are what a working warm-up looks like on
      // almost every page load -- and logging them would bury the rest.
      if (outcome.kind === 'started') console.log(`[warmup] ${describeWarmup(outcome)}`);
      else if (outcome.kind === 'failed') console.warn(`[warmup] ${describeWarmup(outcome)}`);
    })
    .catch((error) => {
      // `warm()` is documented never to reject, and is written not to. This is
      // here so that if it ever does, the result is one log line rather than an
      // unhandled rejection taking down the app that was trying to be quicker.
      console.warn(`[warmup] The warm-up threw, which it should not: ${(error as Error).message}`);
    });
}

/**
 * Discover the adopted spaces' warehouses from the served model configuration,
 * then wake any warehouse that differs from the app binding.
 *
 * This intentionally uses the arriving reader's forwarded token. Customer
 * spaces may point at warehouses the app principal is not and should not be
 * granted, while that reader already needs CAN RUN and CAN USE to ask Genie.
 */
function warmGenieWarehousesForArrival(req: Request, served: unknown): void {
  const token = forwardedUserToken(req);
  const host = workspaceHost();
  if (!token || !host) return;
  const { genieSpaces } = accessDependenciesFrom({
    configuration: extractServedConfiguration(served),
    env: process.env,
  });
  const spaceIds = genieSpaces.map(({ id }) => id);
  if (spaceIds.length === 0) return;

  genieWarehouseWarmup
    .warm({
      host,
      token,
      spaceIds,
      appWarehouseId: appWarehouseId(),
    })
    .then((outcomes) => {
      for (const outcome of outcomes) {
        if (outcome.kind === 'started') {
          console.log(`[warmup] Warming adopted Genie warehouse ${outcome.warehouseId}, which was ${outcome.from}.`);
        } else if (outcome.kind === 'failed') {
          console.warn(
            `[warmup] Adopted Genie warehouse could not be warmed (${outcome.at}, ${outcome.spaceId}): ${outcome.message}.`
          );
        }
      }
    })
    .catch((error) => {
      console.warn(`[warmup] The adopted Genie warm-up threw, which it should not: ${(error as Error).message}`);
    });
}

/** The subset of the SDK's low-level API client this route depends on. */
interface ServingApiClient {
  request(options: {
    path: string;
    method: 'POST';
    headers: Headers;
    payload: Record<string, unknown>;
    /**
     * True for a streamed invocation. The SDK then returns the undecoded body
     * as `{ contents }` instead of parsing it, which is required here: the
     * response is `text/event-stream` and JSON.parse fails on the leading
     * `data:` before a single stage has been read.
     */
    raw: boolean;
  }): Promise<unknown>;
}

/**
 * Posts `payload` verbatim through the SDK's low-level request API, so fields
 * outside the typed query allowlist (notably `custom_inputs`) survive to the
 * endpoint.
 *
 * The client is a parameter rather than a captured singleton so a test can run
 * this exact function against a stub and assert the body is not reshaped. A
 * regression back to `servingEndpoints.query()` has to change this factory,
 * which the test then fails on.
 */
export function createServingTransport(
  resolveClient: (userToken?: string) => Promise<ServingApiClient>
): ServingTransport {
  return async ({ path, payload, onStage, userToken }) => {
    const client = await resolveClient(userToken);
    // `payload` is still forwarded by identity in both branches. Whether the
    // endpoint streams is decided by `stream: true` inside the body that
    // `buildAskServingBody` already produced, deliberately rather than by
    // spreading a flag in here: a transport that rebuilds the body is the exact
    // shape of the bug this whole indirection exists to prevent, and a reviewer
    // cannot tell "added one key" from "rebuilt from an allowlist" at a glance.
    const streaming = typeof onStage === 'function';
    const invoke = (asStream: boolean) =>
      client.request({
        path,
        method: 'POST',
        headers: new Headers({
          'Content-Type': 'application/json',
          Accept: asStream ? 'text/event-stream' : 'application/json',
        }),
        payload,
        raw: asStream,
      });

    if (!streaming) return invoke(false);
    try {
      const streamed = (await invoke(true)) as { contents?: unknown };
      return await consumeServingStream(streamed.contents, onStage);
    } catch (error) {
      if (!(error instanceof TruncatedStreamError)) throw error;
      // Once a stage REPORTED work, the agent stack already ran. A blocking
      // retry would execute orchestrator → tools → synthesis a second time,
      // with a second set of governed reads and potentially different results.
      // Keep the observed stages and let the ask route report the interrupted
      // run; its ledger/live-ask paths remain the durable account of what
      // happened.
      //
      // `stages` counts reports, not events, and the distinction is the whole
      // branch: a `running` announcement means a step started, so a stream that
      // died after nothing but those has produced no work to preserve and no
      // reason to withhold the one call that can still answer. See
      // TruncatedStreamError.
      if (error.stages > 0) {
        console.warn(`[serving] ${error.message} Keeping the partial run; no second invocation will be started.`);
        throw error;
      }
      // With no reported stage and therefore no resumable work, one blocking
      // attempt is still the only route to an answer. This preserves the old
      // recovery for streams that fail before the agent reports doing anything.
      console.warn(
        `[serving] ${error.message} No stage reported work; asking once without streaming.`
      );
      // `stream: true` lives inside the body, so it has to come back out or the
      // endpoint streams into a caller no longer reading events.
      const blocking = { ...payload, stream: false };
      return client.request({
        path,
        method: 'POST',
        headers: new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        payload: blocking,
        raw: false,
      });
    }
  };
}

/**
 * Production transport. Auth resolves from the app's injected service-principal
 * environment, matching the identity the route reported before this change.
 */
export const workspaceServingTransport = createServingTransport(async (userToken?: string) => {
  // A per-call client, not the cached one, when a user token is supplied. The
  // cached client holds the app's service-principal credentials; handing it a
  // different identity for one request is not something it can do, and reusing
  // it across users is the failure mode this whole change exists to remove.
  // Not cached per token either: they are short-lived and per-session, so a map
  // keyed on them is a memory leak whose entries are all credentials.
  if (userToken) {
    const { WorkspaceClient } = await import('@databricks/sdk-experimental');
    // `authType` is not belt-and-braces here, it is load-bearing. Apps inject
    // DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET into the container, and
    // the SDK resolves those from the environment even when a token is passed
    // explicitly. It then sees an OAuth pair and a PAT, refuses to guess between
    // them, and throws `more than one authorization method configured: oauth and
    // pat` before any request leaves the process. The route reads that as the
    // endpoint being unreachable and answers from the representative fixture, so
    // the symptom is invented figures in under a second rather than an auth
    // error. Naming the auth type both skips that validation and pins
    // DefaultCredentials to the PAT provider, so the app's own credentials
    // cannot be picked up for a call that is meant to run as the user.
    const asUser = new WorkspaceClient({
      host: process.env.DATABRICKS_HOST,
      token: userToken,
      authType: 'pat',
    });
    return asUser.apiClient as unknown as ServingApiClient;
  }
  if (!workspaceClient) {
    const { WorkspaceClient } = await import('@databricks/sdk-experimental');
    workspaceClient = new WorkspaceClient({});
  }
  return workspaceClient.apiClient as unknown as ServingApiClient;
});

interface AskServingInputs {
  history: { role: string; content: string }[];
  prompt: string;
  conversationId: string;
  approvedPlanId?: string;
  executePlan?: boolean;
  attachmentText: string;
  /** Ask the endpoint for Server-Sent Events rather than one JSON body. */
  stream?: boolean;
  /** Correlates this HTTP request with the endpoint's trace and its log line. */
  requestId?: string;
  runId?: string;
  /**
   * The account the endpoint must find itself executing as.
   *
   * An assertion by this server, not by the caller, and the endpoint does not
   * take it on trust: it asks its own client who it is and refuses the turn
   * unless the two agree. Sending it is what makes that check possible, which
   * is why it is empty rather than the signed-in address when no token was
   * forwarded. Claiming a user we did not authenticate as would have the
   * endpoint verify our claim against our own service principal and pass.
   */
  expectedUser?: string;
  /** When this request stops being worth answering, ISO-8601 and absolute. */
  deadlineAt?: string;
  /** Lakebase-backed behavior knobs, resolved for this request. */
  runtimeSettings?: RuntimeSettings;
}

/**
 * Builds the exact JSON body sent to Model Serving.
 *
 * `custom_inputs` keys are omitted rather than set to `undefined` so the wire
 * payload only carries approval fields when the user actually approved a plan.
 */
export function buildAskServingBody({
  history,
  prompt,
  conversationId,
  approvedPlanId,
  executePlan,
  attachmentText,
  stream,
  requestId,
  runId,
  expectedUser,
  deadlineAt,
  runtimeSettings,
}: AskServingInputs): Record<string, unknown> {
  const custom_inputs: Record<string, unknown> = { conversation_id: conversationId };
  if (approvedPlanId) custom_inputs.approved_plan_id = approvedPlanId;
  if (executePlan !== undefined) custom_inputs.execute_plan = executePlan;
  if (attachmentText) custom_inputs.attachment_text = attachmentText;
  if (requestId) custom_inputs.request_id = requestId;
  if (runId) custom_inputs.run_id = runId;
  if (deadlineAt) custom_inputs.deadline_at = deadlineAt;
  if (runtimeSettings) custom_inputs.runtime_settings = runtimeSettings;
  // The mode travels with the user it names, and neither travels alone. A mode
  // with nobody named is a request the endpoint's gate refuses for having
  // nothing to hold its invoker against, so sending one without the other
  // would break the local path rather than securing it.
  if (expectedUser) {
    custom_inputs.identity_mode = SIGNED_IN_USER;
    custom_inputs.expected_user = expectedUser;
  }

  // The agent rejects a request with no user turn, so never let an empty or
  // unavailable conversation history drop the question being asked.
  const input = history.length > 0 ? history : [{ role: 'user', content: prompt }];
  // Omitted rather than sent as false, so a caller that never asked for
  // progress puts the same bytes on the wire it always did.
  return stream ? { input, custom_inputs, stream: true } : { input, custom_inputs };
}

/**
 * Upper bound on one interactive invocation of the agent endpoint.
 *
 * Generous on purpose. It exists to stop a silent socket holding a request open
 * forever (nothing here cancels a call, and `fetch` against an endpoint that
 * accepted the connection and then said nothing never rejects), not to police a
 * run that is slow but alive. The longest real answer measured against the
 * deployed endpoint is a little over a minute; the benchmark runner keeps its own
 * tighter per-turn bound because it is running twelve of them unattended.
 */
export const SERVING_INVOKE_TIMEOUT_MS = 240_000;

/**
 * The same bound for a preflight round trip, which is not a question and must
 * not be waited on like one. `GET /api/setup` runs one at startup (measured at
 * 15.9 s against production), and the client has nothing to show until it
 * answers, so four minutes of silence there is four minutes of a blank wizard.
 */
export const PREFLIGHT_TIMEOUT_MS = 60_000;

// Exported for the settings route, which asks the orchestrator the same question
// this one does. A second implementation of the invoke path is how `custom_inputs`
// got dropped once already, see the ServingTransport comment above.
export async function invokeServing(
  appkit: InsightsAppKit,
  payload: Record<string, unknown>,
  onStage?: StageSink,
  timeoutMs: number = SERVING_INVOKE_TIMEOUT_MS,
  userToken?: string
) {
  const endpointName = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
  if (!endpointName) {
    throw new Error('DATABRICKS_SERVING_ENDPOINT_NAME is not set.');
  }
  const transport = appkit.servingTransport ?? workspaceServingTransport;
  return withDeadline(
    transport({ path: servingInvocationPath(endpointName), payload, onStage, userToken }),
    timeoutMs,
    `The agent endpoint did not answer within ${timeoutMs} ms. The call was abandoned rather than ` +
      'cancelled, so it may still be running at the endpoint.'
  );
}

/**
 * The agent endpoint, named the way the workspace names it.
 *
 * Read from the environment at the moment of failure rather than captured at
 * boot, so a panel reports the endpoint this request was actually sent to. The
 * empty string is deliberate and is handled downstream: an unset
 * `DATABRICKS_SERVING_ENDPOINT_NAME` is a misconfigured deployment, and a
 * failure panel that invents a name for it sends somebody to look at an endpoint
 * that was never called.
 */
function agentEndpointDependency(): FailedDependency {
  return { kind: 'agent-endpoint', name: process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? '' };
}

/**
 * A stage's own label, from the field the trace and the live rail both read.
 *
 * `name` rather than `title`, matching `normalizeStage` in
 * client/src/answer-shape.ts: the agent emits one field and two readers of it
 * disagreeing about which is how a panel comes to say "Unnamed step" beside a
 * timeline that is labelled correctly.
 */
function readStageTitle(stage: Record<string, unknown>): string {
  const name = stage.name;
  return typeof name === 'string' && name.trim() ? name.trim() : 'an unnamed step';
}

/**
 * Whether a stage is an announcement of a step that has not returned.
 *
 * The endpoint emits one of these before each step and the completion after it,
 * both as `stage` events under the same id, so anything that counts steps has to
 * choose which it is counting. Everything on this route counts completions: a
 * count of both is not a count of anything.
 */
function isRunningStage(stage: Record<string, unknown>): boolean {
  return stage.status === 'running';
}

/**
 * The evidence for a failure of the agent endpoint, in the fields a panel reads.
 *
 * FOR THE PATHS WHERE THE PROVIDER'S OWN WORDS MAY TRAVEL, which is everything
 * except an authorization denial. A timeout, a socket, a Model Serving 5xx and a
 * payload shape all describe our own infrastructure, so there is nothing to
 * withhold and the message goes out unedited.
 *
 * The denial path builds its evidence inline instead, and deliberately does not
 * reuse this: Unity Catalog names the table, the privilege and its owner, which
 * is the operator's copy rather than the reader's. Making that an option here
 * would mean the safe behaviour depended on remembering to pass it.
 */
function agentEndpointEvidence(error: unknown, context: { principal?: string; stage?: FailureStage }): FailureEvidence {
  const { status, providerCode, providerMessage } = providerFailure(error);
  return {
    dependency: agentEndpointDependency(),
    ...(status === undefined ? {} : { status }),
    ...(providerCode === undefined ? {} : { providerCode }),
    providerMessage,
    ...(context.stage ? { stage: context.stage } : {}),
    ...(context.principal ? { principal: context.principal } : {}),
  };
}

/**
 * The caveat an answer carries when the question ran as the application rather
 * than as the person who asked it.
 *
 * REACHABLE ONLY ON A LAPTOP. There is no forwarded token outside Databricks
 * Apps, so a local process has no user to run as and says so. The deployed app
 * cannot produce an answer this describes: a request there either executes as
 * its reader or terminates as `unavailable`, and `invokeServingAsUser` has no
 * branch that would reach an answer any other way.
 *
 * Kept, rather than deleted with the fallback it used to describe, because the
 * local case is real and an undisclosed one would be the same bug at smaller
 * scale. It is not a rollback path: nothing sets it in production, because
 * nothing in production can call the endpoint without a user token.
 */
export const SERVICE_PRINCIPAL_FALLBACK_CAVEAT =
  'This answer ran as the application, not as you. Your own permissions were not what the ' +
  'warehouse enforced, so it may include data your account cannot read directly.';

/**
 * The endpoint would not run this question as the user who asked it.
 *
 * Its own class because it must not be catchable by the same clause as an
 * endpoint that could not be reached. That clause answers with the stored demo
 * response, and answering a denial with representative figures over HTTP 200 is
 * the most expensive version of this bug: the reader is shown data at exactly
 * the moment the system decided they may not see any.
 */
export class AuthorizationRefused extends Error {
  readonly code: FailureCode;
  readonly httpStatus: number;
  /**
   * The status the ENDPOINT returned, as distinct from the one this app answers
   * with.
   *
   * They correspond and they are not the same fact. `httpStatus` is chosen by
   * the taxonomy from the code; this is what the provider actually said, and it
   * is the only part of a denial that is both disclosable and worth disclosing:
   * 401 sends a reader to sign in again, 403 sends them to whoever owns their
   * grants. Undefined when the refusal was inferred from the message rather than
   * from a carried status, because reporting the taxonomy's number as the
   * provider's would be asserting a status nobody received.
   */
  readonly providerStatus: number | undefined;

  constructor(code: FailureCode, detail: string, providerStatus?: number) {
    super(detail);
    this.name = 'AuthorizationRefused';
    this.code = code;
    this.httpStatus = FAILURE_TAXONOMY[code].httpStatus;
    this.providerStatus = providerStatus;
  }

  /**
   * The `detail` this refusal may travel to the browser with.
   *
   * `message` is Unity Catalog's, and Unity Catalog names the table, the missing
   * privilege and who to ask for it. That is the correct thing for it to tell a
   * client holding the credential, and the wrong thing for this app to forward:
   * `detail` is carried in the response body, so it reaches the reader who has
   * just been told they may not read that table, and the existence of another
   * label's restricted product is that label's business rather than theirs.
   *
   * The operator's copy is not lost. It is logged in full where the refusal is
   * raised, beside the correlation id the reader is given to quote.
   */
  get disclosable(): string {
    return this.code === 'USER_NOT_AUTHORIZED'
      ? 'The endpoint refused this request under the signed-in user\u2019s own credential.'
      : 'The signed-in user\u2019s credential was not accepted by the endpoint.';
  }
}

/**
 * The status an SDK error carried, from wherever it put it.
 *
 * Falls back to reading the message because the transports here do not agree:
 * the experimental SDK surfaces `statusCode`, the generated client surfaces
 * `status`, and a streamed invocation that fails mid-body has neither and only
 * the prose. Matching prose is a guess, and it is the safe direction of guess:
 * being wrong turns a dependency failure into a refusal, which stops a request
 * that would otherwise have run. The opposite guess lets one through.
 *
 * A rejection that is neither an `Error` nor a scalar is read as having no
 * prose at all, via `text`, rather than through `String()`. `String()` on an
 * object yields the literal `[object Object]`, which is not prose anybody
 * wrote and matches none of the patterns below, so it only ever reached them
 * as noise. Reading it as absent says the same thing honestly.
 */
export function rejectionStatus(error: unknown): number | null {
  const carried = (error as { statusCode?: number })?.statusCode ?? (error as { status?: number })?.status;
  if (typeof carried === 'number') return carried;
  const message = error instanceof Error ? error.message : (text(error) ?? '');
  if (/\b403\b|permission denied|not authorized|forbidden/i.test(message)) return 403;
  if (/\b401\b|unauthenticated|unauthorized|invalid access token|expired/i.test(message)) return 401;
  return null;
}

/**
 * Invoke the endpoint as the signed-in user. There is no second attempt.
 *
 * THE DELETED BRANCH IS THE POINT OF THIS FUNCTION. It used to catch a 401 or a
 * 403 from the forwarded token and re-invoke with no token at all, which the
 * transport resolves as the app's own service principal: a principal with the
 * grants of an application rather than of a reader. The answer came back, was
 * stored, and carried a caveat. So the product could report that a user's access
 * had been checked while Genie and the warehouse had executed for somebody else,
 * and the only trace of it was a sentence under the chart.
 *
 * A refusal is now terminal. `AuthorizationRefused` is not caught anywhere that
 * could turn it into an answer, and the absence of a fallback is a property of
 * this function having no second call in it rather than of a flag somebody could
 * set back.
 */
export async function invokeServingAsUser(
  appkit: InsightsAppKit,
  payload: Record<string, unknown>,
  userToken: string,
  onStage?: StageSink,
  timeoutMs: number = SERVING_INVOKE_TIMEOUT_MS
): Promise<unknown> {
  try {
    return await invokeServing(appkit, payload, onStage, timeoutMs, userToken);
  } catch (error) {
    const code = authorizationFailureFor(rejectionStatus(error) ?? 0);
    if (!code) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `[identity] The endpoint refused this request under the signed-in user's own credential ` +
        `(${code}): ${detail}. Nothing was retried: the app's service principal is not an ` +
        'identity any analytical request may be executed under.'
    );
    // `carriedStatus` rather than the `rejectionStatus` above it: that one
    // guesses from the message when it has to, because a missed 403 would let a
    // denied request through, and this one must not guess because its only job is
    // to be printed.
    throw new AuthorizationRefused(code, detail, carriedStatus(error));
  }
}

/**
 * Ask the endpoint for its dependency report.
 *
 * A named call rather than `invokeServing(appkit, buildPreflightServingBody())`
 * repeated at five call sites, so the tighter bound belongs to the operation
 * instead of to whoever remembered to pass it. Every caller of this reports on a
 * page somebody is waiting in front of.
 */
export async function invokePreflight(appkit: InsightsAppKit, candidate?: Record<string, unknown>) {
  return invokeServing(appkit, buildPreflightServingBody(candidate), undefined, PREFLIGHT_TIMEOUT_MS);
}

/** Concurrent Ask and Connections reads share one endpoint metadata request. */
const endpointMetadataFlights = new WeakMap<object, Promise<unknown>>();

async function readServingEndpointMetadata(appkit: InsightsAppKit, endpointName: string): Promise<unknown> {
  const existing = endpointMetadataFlights.get(appkit);
  if (existing) return existing;
  const request = (async () => {
    if (appkit.servingEndpointReader) return appkit.servingEndpointReader(endpointName);
    const { WorkspaceClient } = await import('@databricks/sdk-experimental');
    return new WorkspaceClient({}).servingEndpoints.get({ name: endpointName });
  })();
  endpointMetadataFlights.set(appkit, request);
  try {
    return await request;
  } finally {
    if (endpointMetadataFlights.get(appkit) === request) endpointMetadataFlights.delete(appkit);
  }
}

function servingEndpointReadyState(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object') return '';
  const state = (metadata as Record<string, unknown>).state;
  if (!state || typeof state !== 'object') return '';
  const ready = (state as Record<string, unknown>).ready;
  return typeof ready === 'string' ? ready.trim() : '';
}

/**
 * A read that degrades to zero rows, for the write and best-effort paths where
 * a failure genuinely does not change the response.
 *
 * Read paths that choose between stored and representative rows must use
 * `respondWithStored` instead: this helper cannot tell its caller whether the
 * store answered, and a caller that treats "no rows" as "serve the demo data"
 * would put an outage on screen as though it were content.
 */
async function safeQuery(appkit: InsightsAppKit, sql: string, params: unknown[] = []) {
  const read = await readStored(appkit, describeSql(sql), sql, params);
  return { rows: read.available ? read.rows : [] };
}

/**
 * Answer a read route with stored rows, saying in the logs, and in headers the
 * browser can act on, whether the store answered at all.
 *
 * No deployment substitutes invented rows for missing ones. An unreadable store
 * answers with nothing and declares itself unavailable, which is a different
 * response from a store that answered and holds nothing; see `chooseRows`.
 */
async function respondWithStored(appkit: InsightsAppKit, res: Response, route: string, sql: string, params: unknown[]) {
  const read = await readStored(appkit, route, sql, params);
  const { rows, substitution } = chooseRows(route, read);
  markResponse(res, substitution);
  res.json(rows);
}

/**
 * The numbered versions this build knows about.
 *
 * Version 1 is {@link schemaStatements}, which is the schema every existing
 * deployment already has. Anything added from here on is a new numbered entry in
 * `lib/migrations.ts` with a way to undo itself, applied once and recorded, not
 * a statement appended to a list that is replayed on every boot.
 */
export const MIGRATIONS = buildMigrations(schemaStatements);

/**
 * Bring the store up to the newest known schema version.
 *
 * ── WHAT THIS IS NOW, AND WHAT IT WAS ──
 *
 * This used to BE the DDL: a flat list run on every boot, where "did the schema
 * change land" was answerable only by reading startup logs. It is now a thin call
 * into the versioned runner, which records each version in
 * `${APP_SCHEMA}.schema_version` and refuses to apply 3 when 2 failed.
 *
 * The DDL text still lives above rather than in `lib/migrations.ts`, and that is
 * not laziness: `bundle/preflight.sh`, `scripts/grant-app-db-access.mjs` and
 * `scripts/check-db-ownership.mjs` all learn the app's schema name by parsing
 * `CREATE SCHEMA IF NOT EXISTS <name>` out of THIS FILE. Moving it would leave
 * three checks — one of them in the release path — finding nothing.
 *
 * ── WHY BOOT STILL CALLS THIS AT ALL ──
 *
 * The sanctioned path is the explicit deploy step (`npm run migrate:lakebase`), which
 * runs ahead of the app, exits non-zero on failure, and can therefore stop a
 * release. Boot keeps a call because a deployment whose release step has not been
 * wired yet must not come up with no tables at all — and because the runner makes
 * that fallback safe in a way the old flat list was not: it is ordered, recorded,
 * and applied once.
 *
 * Set `PLAYER_INSIGHTS_MIGRATE_ON_BOOT=verify` once the deploy step is wired and
 * boot stops applying anything: it reads the version, reports what is pending,
 * and leaves the schema alone. See {@link bootMigrationMode}.
 *
 * The return type is unchanged — the statement-level failures, so every existing
 * caller and surface that reads them still does.
 */
export async function applySchema(appkit: InsightsAppKit): Promise<SchemaStatementFailure[]> {
  const outcome = await runMigrations(appkit, {
    schema: APP_SCHEMA,
    migrations: MIGRATIONS,
    mode: bootMigrationMode(),
    appliedBy: 'app boot',
  });
  return outcome.attempts.flatMap((attempt) => attempt.failures);
}

/**
 * Whether boot applies pending migrations or only reports them.
 *
 * Defaults to applying. A deployment that has wired the explicit migration step
 * into its release should set this to `verify`, after which boot never issues
 * DDL and a schema behind the code is reported rather than quietly repaired by
 * whichever container started first.
 *
 * Anything other than `verify` applies, including a typo. That direction is
 * deliberate: a misspelled value that silently stopped migrating would be a
 * deployment coming up with no tables, which is worse than one that migrates
 * when an operator meant it not to.
 */
export const MIGRATE_ON_BOOT_ENV = 'PLAYER_INSIGHTS_MIGRATE_ON_BOOT';

export function bootMigrationMode(env: NodeJS.ProcessEnv = process.env): 'apply' | 'verify' {
  return (env[MIGRATE_ON_BOOT_ENV] ?? '').trim().toLowerCase() === 'verify' ? 'verify' : 'apply';
}

/**
 * The schema pass and the one-off repair that follows it, off the boot path.
 *
 * Everything here is a WRITE the app makes to its own store before anybody asks
 * it for anything, and nothing that serves a request waits on it. Errors are
 * swallowed deliberately: `applySchema` already reports every refusal it saw, in
 * detail, and a rejection escaping this promise would be an unhandled one that
 * takes the process down for a database problem the app is designed to survive
 * and report.
 */
async function prepareStore(appkit: InsightsAppKit): Promise<void> {
  markSchemaPending(true);
  try {
    await applySchema(appkit);
  } catch (error) {
    console.error(
      `[lakebase] SCHEMA SETUP THREW rather than reporting: ${(error as Error).message}. The app is ` +
        'serving already, and every read of the store will report itself unavailable until this is fixed.'
    );
  } finally {
    // Before the title repair, not after: from here on a missing table is a
    // real missing table rather than one the schema pass has not reached yet.
    markSchemaPending(false);
  }

  // After the schema pass, because the decision it reads lives in a table that
  // pass creates, and before anything that answers a rail read. The scope in
  // force until this resolves is the one the environment carried, which is the
  // narrow direction.
  await settleSharedConversationRail(appkit);

  // Labels stored by the version that cut them to 80 characters, read back from
  // the questions they were cut from. After the schema pass, because it reads
  // two tables that pass creates.
  try {
    await repairTruncatedTitles(appkit);
  } catch (error) {
    console.warn(
      `[lakebase] The conversation-title repair did not run: ${(error as Error).message}. Titles cut to ` +
        '80 characters by an older version stay cut; nothing else is affected.'
    );
  }
}

/**
 * Register every route, and start the store's own setup without waiting for it.
 *
 * WHY NOTHING HERE IS AWAITED BEFORE THE ROUTES. AppKit does not begin
 * listening until `onPluginsReady` has resolved, so anything awaited on this
 * path is time during which the container answers nothing at all — not the
 * health check, not readiness, not a redeploy's first request. The schema pass
 * is 20-odd DDL statements against Lakebase, 0.5-2s on a cold start and worse on
 * a first deploy, and none of it is needed to answer a request that does not
 * read the store.
 *
 * The returned `storeReady` is that work, for a caller that genuinely needs it:
 * tests that assert what the schema pass did, and any future readiness surface.
 * `setupInsightsRoutes` itself does not await it, and a caller that awaits it on
 * the boot path has put the block back.
 *
 * The window this opens is narrow and real: a read arriving before the tables
 * exist fails, and it fails with `undefined_table`, which is one of the codes a
 * missing GRANT produces. `markSchemaPending` is what stops that being
 * misdiagnosed as "run the grant script" during the second it is true.
 */
export function setupInsightsRoutes(
  appkit: InsightsAppKit,
  options: { rolesReady?: () => Promise<void> } = {}
): Promise<{ storeReady: Promise<void> }> {
  // BEFORE `prepareStore`, not after, and that ordering is load-bearing rather
  // than tidy. `prepareStore` asks the store whether this deployment recorded a
  // different rail scope (see `settleSharedConversationRail`), and the scope in
  // force until that answer arrives has to be the narrow one the environment
  // carried. Announced here, that is true by construction instead of true
  // because two `await`s happen to interleave the way they do today.
  announceSharedConversationRail(resolveSharedConversationRail(process.env[SHARED_CONVERSATION_RAIL_ENV]));

  const storeReady = prepareStore(appkit);

  // Reads are what the pages depend on, and a `CREATE TABLE IF NOT EXISTS` that
  // succeeds says nothing about whether the store still answers minutes later.
  // The watchdog dates an outage and its recovery even when nobody is looking.
  startLakebaseWatchdog(appkit);

  if (isDeployed()) {
    console.log(
      '[identity] Requiring x-forwarded-email on user-scoped routes; unidentified requests are refused with 401.'
    );
  } else if (process.env.NODE_ENV !== 'test') {
    // Every test boots the app, and a warning on each would be noise nobody
    // reads. A developer running the server is the audience for this.
    console.warn(
      `[identity] DEVELOPMENT MODE: requests without x-forwarded-email act as ${DEVELOPMENT_IDENTITY}, and ` +
        'rows written now are owned by that address. This path does not exist when NODE_ENV=production, ' +
        'which is what app.yaml runs.'
    );
  }

  appkit.server.extend((app) => {
    // Before any route is registered, so every handler below (and every handler
    // the settings and setup modules register after them), answers 500 when it
    // throws instead of rejecting into an unhandled promise and exiting Node.
    answerRatherThanExit(app);
    app.use(requireIdentity);
    if (options.rolesReady) {
      app.use((req, _res, next) => {
        if (!isAdminRoute(req.path)) {
          next();
          return;
        }
        // Only role-bearing routes wait. Without this gate a greenfield request
        // could read the empty roster between schema creation and seed insertion,
        // while awaiting the same promise in onPluginsReady kept the entire app
        // dark. A rejected bootstrap still continues into the existing role guard,
        // which denies when Lakebase cannot establish the caller's role.
        options.rolesReady?.().then(() => next(), next);
      });
    }
    // Immediately after the identity gate and before any route, so every admin
    // path registered anywhere below is refused for a consumer without the
    // handler's author doing anything. THIS IS THE PERMISSION MODEL: hiding a tab
    // in the browser is a layout preference anybody can undo by typing a URL. The
    // prefix list lives in admin-roles.ts, and the identity reader is passed in
    // rather than imported so there is exactly one notion of who is calling.
    app.use(requireAdmin(appkit.lakebase, userEmail));
    // Immediately after the admin gate, so the roster is behind BOTH. `/api/users`
    // is on both prefix lists: a consumer is refused by the guard above and an
    // administrator by this one. Two refusals in front of one surface rather than
    // one, because this is the surface that decides who can do what in a customer's
    // deployment, and because a defect in the narrower list would otherwise leave
    // the roster open to every administrator rather than to nobody.
    app.use(requireSuperAdmin(appkit.lakebase, userEmail));
    // One recorder for every API route registered below or by later modules.
    // It runs after identity/role gates, so rejected requests are not presented
    // as routes the app served, and it stores canonical Express route templates
    // rather than concrete URLs containing user or resource ids.
    app.use(requestLatencyRecorder(appkit.lakebase));

    /**
     * Wake the configured SQL warehouse while the browser is showing the
     * opening sequence and login gate.
     *
     * This route is deliberately separate from `/api/preflight`. Preflight is
     * still fetched by the Ask page, but that page can mount after the opening
     * sequence and the agent no longer returns a dependency report. Warehouse
     * startup is an arrival concern, not a readiness verdict.
     *
     * Answer before the control-plane calls settle. A hanging or refused start
     * is logged by `warmWarehouseForArrival` and can never delay or fail login.
     */
    app.post('/api/warehouse-warmup', (req, res) => {
      warmWarehouseForArrival(appkit.warehouseWarmup ?? appWarehouseWarmup);
      // Adopted Genie warehouses are warmed from declared/environment
      // configuration on this same fire-and-forget arrival path. No serving
      // invocation is needed to discover them.
      warmGenieWarehousesForArrival(req, {});
      res.status(202).json({ accepted: true });
    });

    /**
     * Who the caller is and what they may open, in one payload.
     *
     * The role rides here rather than on an endpoint of its own so the browser
     * cannot hold an identity and a role that disagree. Async now, because the
     * role needs the stored half of the admin list; `resolveRole` never rejects,
     * so this cannot start failing on a Lakebase outage.
     */
    app.get('/api/identity', async (req, res) => {
      const role = await rolePayload(appkit.lakebase, userEmail(req));
      res.json({ ...identityPayload(req), ...role });
    });

    /**
     * Add Astrolabe's load-bearing scopes and workspace browse scope to this app
     * as the signed-in user.
     *
     * This is intentionally beside the identity route rather than under an
     * Astrolabe admin prefix. CAN MANAGE on the Databricks App is the authority
     * that matters, and the Apps API evaluates it from the forwarded token.
     */
    app.post('/api/app-user-api-scopes', async (req, res) => {
      const requestedScope = (req.body as { scope?: unknown } | undefined)?.scope;
      if (
        requestedScope !== undefined &&
        (typeof requestedScope !== 'string' || !isOptionalUserApiScope(requestedScope))
      ) {
        res.status(400).json({
          error: 'unsupported_scope',
          message: 'Only a known optional Databricks scope can be requested here.',
        });
        return;
      }
      const userToken = forwardedUserToken(req);
      if (!userToken) {
        res.status(409).json({
          error: 'user_token_unavailable',
          message: 'Sign in to Databricks again, then reopen this app.',
        });
        return;
      }
      const appName = (process.env.DATABRICKS_APP_NAME ?? '').trim();
      const host = workspaceHost();
      if (!appName || !host) {
        res.status(503).json({
          error: 'app_identity_unavailable',
          message: 'This running app could not identify its Databricks App resource.',
        });
        return;
      }

      const outcome = await allowAstrolabeUserApiScopes({
        host,
        appName,
        userToken,
        additionalScopes: requestedScope ? [requestedScope] : undefined,
      });
      if (outcome.kind === 'refused') {
        res.status(403).json({ error: 'app_manage_required', message: outcome.message });
        return;
      }
      if (outcome.kind === 'failed') {
        res.status(outcome.status).json({ error: 'scope_update_failed', message: outcome.message });
        return;
      }
      res.json({
        updated: outcome.kind === 'updated',
        scopes: outcome.scopes,
        signInAgain: true,
        message:
          outcome.kind === 'updated'
            ? 'Access was added. Sign in again so the new access takes effect.'
            : 'This app already allows serving, SQL, Genie, and workspace browsing. Sign in again so the access takes effect.',
      });
    });

    /**
     * What the agent can actually reach right now, and the exact grant for
     * anything it cannot.
     */
    /**
     * Record a mode the user chose for themselves at the gate.
     *
     * Only the modes that claim no extra authority. `user-verified` is not on
     * offer here and `declareAccessMode` throws if it is asked for: a request
     * asserting that its own permissions were checked is not evidence that they
     * were, and the whole value of the mode is that somebody can trust it.
     */
    app.post('/api/access-mode', (req, res) => {
      const requested = (req.body as { mode?: unknown } | undefined)?.mode;
      if (!isAccessMode(requested) || requested === 'user-verified') {
        res.status(400).json({
          error: 'unsupported_mode',
          message:
            'Choose `service-principal` or `skipped`. Verified access is established by ' +
            'running the checks at /api/access-verification, not by asking for it.',
        });
        return;
      }
      const email = userEmail(req);
      const decision = declareAccessMode(
        email,
        requested,
        requested === 'skipped'
          ? 'The user skipped the access gate. Nothing was checked under their token. Who runs questions is set by the deployment, not by this choice.'
          : 'The user chose service-principal mode at the gate: own access was not verified. Who runs questions is set by the deployment, not by this choice.'
      );
      console.log(`[access] ${email} → ${decision.mode}`);
      res.json({ decision, servingPrincipal: observedServingPrincipal() });
    });

    /**
     * Answer "can *I* read this data" instead of "can the principal that was
     * granted access read this data".
     *
     * The table list and the warehouse come from the agent's own dependency
     * report rather than from anything written down here, so the two can never
     * drift apart and the customer's table names stay out of this repository.
     * The cost is one agent round trip per verification, which is the right
     * trade for a deliberate action behind a button.
     */
    app.post('/api/access-verification', async (req, res) => {
      const email = userEmail(req);
      const diagnosis = diagnoseUserToken(req, email === DEVELOPMENT_IDENTITY);
      if (diagnosis.kind !== 'present') {
        console.warn(`[access] No forwarded user token for ${email}: ${diagnosis.layer}`);
        res.status(409).json({
          error: 'no_user_token',
          verified: false,
          // Deliberately not a fallback. Proceeding as the service principal
          // after somebody asked to be checked would answer a question they did
          // not ask and tell them it was the one they did.
          //
          // `kind` is what stops this reading as a denial in the UI. Nothing was
          // asked about this user's permissions, so nothing about them is known,
          // and the fix belongs to whoever configured the app.
          blocked: {
            kind: 'no-user-token',
            summary: diagnosis.summary,
            layer: diagnosis.layer,
            ...(diagnosis.kind === 'absent-in-apps'
              ? {
                  remedy: {
                    kind: 'cli' as const,
                    statement:
                      '# 1. A workspace admin enables user authorization (Public Preview).\n' +
                      '# 2. The app is restarted, because scopes apply at START, not at deploy:\n' +
                      'databricks apps stop <app-name>\n' +
                      'databricks apps start <app-name>',
                    // No guidance. It explained why two steps are listed, which
                    // is about the shape of the advice rather than about doing
                    // it, and closed by saying this is not a permission the
                    // reader is missing -- which is what the blocked heading
                    // above it already says, in the same red panel.
                    guidance: '',
                  },
                }
              : {}),
          },
          mode: accessModeFor(email),
        });
        return;
      }

      // The app's own warehouse, from its app resource. Tables and Genie spaces
      // come from the served model's configuration report (returned beside a
      // retired preflight) or from PLAYER_INSIGHTS_* env fallbacks. When neither
      // is available the gate still checks the warehouse and names what it
      // could not establish in notChecked.
      const warehouseId = appWarehouseId();
      let configuration: ReturnType<typeof extractServedConfiguration> = [];
      try {
        configuration = extractServedConfiguration(await invokePreflight(appkit));
      } catch (error) {
        console.warn(`[access] Served configuration could not be read for verification: ${(error as Error).message}`);
      }
      const { tables, genieSpaces } = accessDependenciesFrom({
        configuration,
        env: process.env,
      });
      const servingChecked: readonly { object: string; label: string; status: string }[] = [];
      const host = workspaceHost();
      // Two different missing things, and two different people to go and see.
      // Collapsing them into "verification unavailable" was the first thing
      // this route got wrong when it was run for real.
      const missing = !warehouseId
        ? {
            kind: 'not-configured' as const,
            summary:
              'This app has no SQL warehouse attached, so there is nowhere to run a statement ' +
              'as you. Attach one to the app and restart it. Nothing was checked, and this says ' +
              'nothing about your permissions.',
            layer: 'app configuration',
          }
        : !host
          ? {
              kind: 'not-configured' as const,
              summary:
                'The app does not know its own workspace URL (DATABRICKS_HOST is unset), so it ' +
                'cannot call the SQL API as you. This is an app environment problem and is ' +
                'unrelated to your permissions.',
              layer: 'app environment',
            }
          : null;
      if (missing) {
        console.warn(`[access] Verification unavailable for ${email}: ${missing.layer}`);
        res.status(503).json({
          error: 'verification_unavailable',
          verified: false,
          blocked: missing,
          notChecked: limitsOfThisCheck(servingChecked),
          mode: accessModeFor(email),
        });
        return;
      }

      const userToken = forwardedUserToken(req)!;
      const statementOptions = { host, token: userToken, warehouseId };
      const outcome = await verifyAccess(
        {
          tables,
          warehouseId,
          principal: email,
          servingChecked,
          genieSpaces,
          // What the token says about itself, which is `null` when it says
          // nothing. Only a definite "no" skips the call; an unreadable token
          // gets asked anyway, because declining to check and then printing a
          // reason nobody verified is the defect this replaced.
          genieScope: tokenGrantsGenie(userToken),
          // Read once, here, where the token is. It decides which of the two
          // 401s a refusal is: one that a page load replaces, and one that a
          // page load re-presents. Without it the checks say they cannot tell,
          // which is true but is less than this request can know.
          presentedToken: presentedTokenAge(userToken),
        },
        {
          warehouse: warehouseProbeFor(statementOptions),
          table: statementRunnerFor(statementOptions),
          genieSpace: genieSpaceProbeFor({ host, token: userToken }),
          // Consulted only if the warehouse answers with a bare 403, which is
          // the one refusal whose cause the response does not carry. The happy
          // path pays nothing for this.
          entitlements: appEntitlementLookup(),
        }
      );
      const serving = observedServingPrincipal();
      if (!isVerified(outcome)) {
        const genieDenied = (outcome.genie ?? []).filter((verdict) => verdict.status === 'denied').length;
        console.warn(
          `[access] ${email} not verified: ${
            outcome.blocked
              ? outcome.blocked.kind
              : `${outcome.denied} denied, ${outcome.errored} unknown, ${genieDenied} Genie space(s) refused`
          }`
        );
        // The status the block earned, not `403` for all of them. Four of the
        // seven blocked kinds are not denials (an unstarted app, a refused
        // token, a warehouse that is absent or down), and answering those with
        // `403` contradicts the summary in the same body, which says in as many
        // words that this is not a permission the reader is missing.
        res.status(statusForOutcome(outcome)).json({
          error: 'not_verified',
          verified: false,
          ...outcome,
          mode: accessModeFor(email),
          servingPrincipal: serving,
        });
        return;
      }
      const decision = recordVerifiedAccess(email, verificationSummary(outcome));
      console.log(`[access] ${email} → user-verified on warehouse ${warehouseId} (${outcome.ok} tables)`);
      res.json({ verified: true, ...outcome, decision, servingPrincipal: serving });
    });

    app.get('/api/preflight', async (_req, res) => {
      const endpointName = process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? '';
      if (!endpointName.trim()) {
        const missing = withStorageCheck(
          preflightFailure(
            agentEndpointMetadataCheck(endpointName, {
              status: 'failed',
              detail: 'No agent endpoint is configured for this app.',
              error: 'DATABRICKS_SERVING_ENDPOINT_NAME is unset.',
            }),
            'No serving invocation was attempted. Endpoint visibility and query permission are separate checks.'
          ),
          lakebaseStorageCheck()
        );
        res.status(503).json({ ...missing, error: 'preflight_unavailable' });
        return;
      }

      let metadata: unknown;
      try {
        metadata = await readServingEndpointMetadata(appkit, endpointName);
      } catch (error) {
        const message = (error as Error).message;
        console.warn('[preflight] Agent endpoint metadata could not be read:', message);
        res.status(503).json({
          ...withStorageCheck(
            preflightFailure(
              agentEndpointMetadataCheck(endpointName, {
                status: 'failed',
                detail: 'The app could not read the configured agent endpoint metadata.',
                error: message,
              }),
              'No serving invocation was attempted. CAN_VIEW and CAN_QUERY are separate grants, so this says nothing about whether this principal can ask a question.'
            ),
            lakebaseStorageCheck()
          ),
          error: 'preflight_unavailable',
        });
        return;
      }

      const state = servingEndpointReadyState(metadata);
      const report = withStorageCheck(
        preflightFailure(
          agentEndpointMetadataCheck(endpointName, {
          status: 'ok',
            detail:
              `The configured endpoint metadata is reachable${state ? ` (state ${state})` : ''}. ` +
              'This does not prove that the current principal may query it.',
        }),
          'No serving invocation was attempted. Endpoint visibility (CAN_VIEW) and query permission (CAN_QUERY) are separate, and dependencies remain unchecked.'
        ),
        lakebaseStorageCheck()
      );
      res.status(preflightHttpStatus(report)).json({ ...report, error: 'preflight_metadata_only' });
    });

    app.get('/api/conversations', async (req, res) => {
      const { sql, params } = conversationListQuery(userEmail(req));
      await respondWithStored(appkit, res, 'GET /api/conversations', sql, params);
    });

    /**
     * Remove one conversation, by primary key, and everything that hangs off it.
     *
     * There are no foreign keys on this schema, so nothing cascades on the
     * database's side and each table is named explicitly here. The order is
     * load-bearing rather than incidental, see the comments on each statement.
     */
    app.delete('/api/conversations/:id', async (req, res) => {
      const conversationId = req.params.id;
      const email = userEmail(req);

      const ownership = await readStored(
        appkit,
        'DELETE /api/conversations/:id (owner)',
        `SELECT user_email FROM ${APP_SCHEMA}.conversations WHERE id = $1`,
        [conversationId]
      );
      if (!ownership.available) {
        // A read that fails cannot establish ownership, and zero rows from a
        // failed read is indistinguishable from a conversation that does not
        // exist. Answering 404 here would report someone's conversation as
        // already gone during an outage.
        console.warn(
          `[lakebase] Conversation ${conversationId} could not be deleted: ownership unreadable (${ownership.code}).`
        );
        res.status(503).json({
          error: 'conversation_delete_failed',
          conversationId,
          message:
            'This conversation could not be deleted right now, because the store could not confirm who ' +
            'owns it. Nothing was removed. Try again shortly.',
        });
        return;
      }
      const owner = ownership.rows[0]?.user_email;
      if (owner !== email) {
        if (typeof owner === 'string') {
          console.warn(`[tenancy] Refused delete of conversation ${conversationId}: it belongs to another user.`);
        }
        res.status(404).json({
          error: 'conversation_not_found',
          conversationId,
          message: 'No conversation with this id belongs to you.',
        });
        return;
      }

      try {
        // Feedback first, while the messages it is keyed on still exist.
        // `feedback` carries no conversation id (only `message_id`), so once
        // the messages are gone there is nothing left to identify these rows
        // by, and they would stay in the table pointing at ids that no longer
        // resolve. Not filtered by the caller's address: the rows are being
        // removed because their target is being removed, and one left behind
        // because somebody else wrote it is an orphan nothing can reach.
        const feedback = await appkit.lakebase.query(
          `DELETE FROM ${APP_SCHEMA}.feedback
           WHERE message_id IN (SELECT id FROM ${APP_SCHEMA}.messages WHERE conversation_id = $1
           )
           RETURNING id`,
          [conversationId]
        );
        // Scoped by conversation rather than by owner, on purpose. An
        // attachment holds text extracted from an uploaded document, and one
        // left behind here would be unreachable (every read of it is scoped
        // through a conversation that no longer exists), while the document's
        // contents stayed in the store indefinitely.
        const attachments = await appkit.lakebase.query(
          `DELETE FROM ${APP_SCHEMA}.attachments WHERE conversation_id = $1 RETURNING id`,
          [conversationId]
        );
        const messages = await appkit.lakebase.query(
          `DELETE FROM ${APP_SCHEMA}.messages WHERE conversation_id = $1 RETURNING id`,
          [conversationId]
        );
        // The conversation row last, so that a failure part-way through leaves
        // the conversation listed and the delete retryable rather than leaving
        // orphaned children under an id the rail can no longer name. Every
        // statement above is keyed on the conversation id alone, so a retry
        // removes whatever the first attempt did not.
        const conversation = await appkit.lakebase.query(
          `DELETE FROM ${APP_SCHEMA}.conversations WHERE id = $1 AND user_email = $2 RETURNING id`,
          [conversationId, email]
        );

        res.json({
          conversationId,
          deleted: {
            conversations: conversation.rows.length,
            messages: messages.rows.length,
            attachments: attachments.rows.length,
            feedback: feedback.rows.length,
          },
        });
      } catch (error) {
        console.warn(`[lakebase] Conversation ${conversationId} could not be deleted:`, (error as Error).message);
        res.status(503).json({
          error: 'conversation_delete_failed',
          conversationId,
          message:
            'This conversation could not be fully deleted right now. It is still in the rail, and ' +
            'deleting it again will remove whatever is left. Try again shortly.',
        });
      }
    });

    /**
     * Scoped through `conversations`, because `messages` has no `user_email` of
     * its own. A message belongs to whoever owns its conversation. Without the
     * join this filtered on the conversation id alone, and a conversation id is
     * not a secret: it appears in this app's own Run Explorer rows. Any signed-in
     * user could read another's questions, answers and attachments-derived text
     * by naming one.
     */
    app.get('/api/conversations/:id/messages', async (req, res) => {
      const { sql, params } = conversationMessagesQuery(req.params.id, userEmail(req));
      await respondWithStored(appkit, res, 'GET /api/conversations/:id/messages', sql, params);
    });

    /**
     * Reconnect a browser to the durable state of work it did not stay to watch.
     *
     * This does not resume or duplicate execution. The original request keeps
     * running in this server process; this route only reads the Lakebase rows
     * written before and during that execution.
     *
     * THE STEPS COME WITH IT, and that is what makes this a reconnect rather
     * than a notification. The row alone says a run is working, which is what
     * the returning browser used to be told and all it was told: the question
     * came back on screen, the composer stayed shut because a run was in
     * flight, and the agent path stayed empty for the rest of the run. The
     * narration is durable now (see run-stage-events.ts), so the same read
     * hands back the path the reader walked away from and it goes on growing.
     *
     * Served together rather than from a second endpoint because they are one
     * question -- "what is happening in this conversation" -- and because a
     * browser polling two routes can hold a state neither of them ever
     * reported, a run that has finished beside the steps of one that had not.
     */
    app.get('/api/conversations/:id/run', async (req, res) => {
      const read = await readStored(appkit, 'GET /api/conversations/:id/run', CONVERSATION_RUN_STATUS_QUERY, [
        req.params.id,
        userEmail(req),
      ]);
      if (!read.available) {
        res.status(503).json({
          error: 'conversation_run_unavailable',
          message: 'The current state of this conversation could not be read just now.',
        });
        return;
      }
      const run = read.rows[0];
      if (!run) {
        res.json(null);
        return;
      }
      // Read under the run id this owner-scoped query returned, so the
      // narration cannot be reached by naming somebody else's run. An
      // unreadable narration is an empty one rather than a failed reconnect:
      // the state above is still true and still the thing the browser needs.
      res.json({ ...run, stages: await readStageEvents(appkit, String(run.run_id)) });
    });

    /**
     * The documents attached to one conversation, or an admission that they
     * could not be read.
     *
     * There are no representative attachments to substitute, so this refuses
     * rather than degrading: the honest answers are "here they are", "there are
     * none", and "ask again shortly", and the middle one must not cover for the
     * third.
     */
    app.get('/api/conversations/:id/attachments', async (req, res) => {
      const read = await readStored(
        appkit,
        'GET /api/conversations/:id/attachments',
        `SELECT id, filename, mime_type, size_bytes, created_at
         FROM ${APP_SCHEMA}.attachments
         WHERE conversation_id = $1 AND user_email = $2 ORDER BY created_at`,
        [req.params.id, userEmail(req)]
      );
      if (!read.available) {
        markResponse(res, noSubstitution('storage_unavailable'));
        res.status(503).json({
          error: 'attachments_unavailable',
          conversationId: req.params.id,
          message:
            'The documents attached to this conversation could not be read just now, so this is not ' +
            'a list of them. Anything already attached is still attached. Try again shortly.',
        });
        return;
      }
      markResponse(res, noSubstitution());
      res.json(read.rows);
    });

    /**
     * Attach a document to a conversation the caller owns.
     */
    app.post(
      '/api/conversations/:id/attachments',
      raw({ type: 'application/octet-stream', limit: MAX_ATTACHMENT_BYTES }),
      async (req, res) => {
        const encodedName = req.header('x-file-name');
        const filename = encodedName ? decodeURIComponent(encodedName) : '';
        const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!filename || bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
          res.status(400).json({ error: 'Choose a non-empty report no larger than 8 MB.' });
          return;
        }

        const conversationId = req.params.id;
        const owner = await readStored(
          appkit,
          'POST /api/conversations/:id/attachments (owner)',
          `SELECT user_email FROM ${APP_SCHEMA}.conversations WHERE id = $1`,
          [conversationId]
        );
        if (!owner.available) {
          console.warn(
            `[lakebase] Attachment for ${conversationId} was not stored: ownership unreadable (${owner.code}).`
          );
          res.status(503).json({
            error: 'attachment_owner_unreadable',
            conversationId,
            message:
              'This report could not be attached right now, because the store could not confirm who ' +
              'owns this conversation. Nothing was written. Try again shortly.',
          });
          return;
        }
        const ownerEmail = owner.rows[0]?.user_email;
        // Refused only with another owner's address in hand. No row means the
        // conversation is new and about to be claimed legitimately, which is how
        // the first upload in a fresh chat works.
        if (typeof ownerEmail === 'string' && ownerEmail !== userEmail(req)) {
          console.warn(
            `[tenancy] Refused attachment upload to conversation ${conversationId}: it belongs to another user.`
          );
          // 404 rather than 403, as everywhere else here: confirming the id
          // exists but is somebody else's is itself a disclosure.
          res.status(404).json({
            error: 'conversation_not_found',
            conversationId,
            message: 'No conversation with this id belongs to you.',
          });
          return;
        }

        let extractedText: string;
        try {
          extractedText = await extractAttachmentText(filename, bytes);
        } catch (error) {
          res.status(422).json({ error: (error as Error).message });
          return;
        }
        if (!extractedText.trim()) {
          res.status(422).json({ error: 'No readable text was found in this report.' });
          return;
        }

        const id = crypto.randomUUID();
        const email = userEmail(req);
        try {
          await appkit.lakebase.query(
            `INSERT INTO ${APP_SCHEMA}.conversations (id, user_email, title)
             VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
            [conversationId, email, PLACEHOLDER_CONVERSATION_TITLE]
          );
          await appkit.lakebase.query(
            `INSERT INTO ${APP_SCHEMA}.attachments
             (id, conversation_id, user_email, filename, mime_type, size_bytes, extracted_text)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              id,
              conversationId,
              email,
              filename,
              req.header('content-type') ?? 'application/octet-stream',
              bytes.length,
              extractedText,
            ]
          );
        } catch (error) {
          console.warn('[lakebase] Attachment could not be stored:', (error as Error).message);
          res.status(503).json({
            error: 'Attachment storage is unavailable right now. Try again shortly.',
          });
          return;
        }
        res.status(201).json({
          id,
          filename,
          mime_type: req.header('x-file-type') ?? 'application/octet-stream',
          size_bytes: bytes.length,
          status: 'ready',
        });
      }
    );

    /**
     * Remove one attachment, and report which of the three things happened.
     *
     * The same hazard the bulk-clear route below spells out, with the same
     * remedy. This answered 204 whatever the outcome (deleted, never existed,
     * owned by someone else, or Lakebase unreachable), and the client removes the
     * chip optimistically, so during an outage the document disappeared from the
     * UI and carried on reaching the agent with every subsequent question.
     */
    app.delete('/api/conversations/:conversationId/attachments/:attachmentId', async (req, res) => {
      const { conversationId, attachmentId } = req.params;
      try {
        const result = await appkit.lakebase.query(
          `DELETE FROM ${APP_SCHEMA}.attachments
           WHERE id = $1 AND conversation_id = $2 AND user_email = $3
           RETURNING id`,
          [attachmentId, conversationId, userEmail(req)]
        );
        if (result.rows.length === 0) {
          res.status(404).json({
            error: 'attachment_not_found',
            conversationId,
            attachmentId,
            message: 'No attachment with this id is attached to this conversation.',
          });
          return;
        }
        res.status(204).end();
      } catch (error) {
        console.warn('[lakebase] Attachment could not be removed:', (error as Error).message);
        res.status(503).json({
          error: 'attachment_delete_failed',
          conversationId,
          attachmentId,
          message:
            'This report could not be removed right now, so it is still attached and will still ' +
            'reach the agent. Try again shortly.',
        });
      }
    });

    /**
     * Drop every attachment on a conversation, without ending the conversation.
     */
    app.delete('/api/conversations/:conversationId/attachments', async (req, res) => {
      const conversationId = req.params.conversationId;
      try {
        const result = await appkit.lakebase.query(
          `DELETE FROM ${APP_SCHEMA}.attachments
           WHERE conversation_id = $1 AND user_email = $2
           RETURNING id`,
          [conversationId, userEmail(req)]
        );
        res.json({ conversationId, deleted: result.rows.length });
      } catch (error) {
        console.warn('[lakebase] Attachments could not be cleared:', (error as Error).message);
        res.status(503).json({
          error: 'attachment_clear_failed',
          conversationId,
          message: 'Attached reports could not be cleared right now. Try again shortly.',
        });
      }
    });

    app.post('/api/insights/ask', async (req, res) => {
      // Every response below goes through this rather than through `res`, so the
      // handler reads the same whether the caller wanted the answer in one JSON
      // body or wanted the run narrated first. See ask-responder.ts. `res`
      // itself is still used for the degradation headers, which are set before
      // any stream opens.
      const reply = createAskResponder(req, res);
      const parsed = AskBody.safeParse(req.body);
      if (!parsed.success) {
        reply.status(400).json({ error: 'A conversation and question are required.' });
        return;
      }
      const { conversationId, prompt, approvedPlanId, executePlan } = parsed.data;
      const email = userEmail(req);

      // BEFORE ANY WRITE. A request that will not be executed must not leave a
      // conversation row, a user turn, or an `updated_at` behind it: the rail
      // would then list a question that was never asked, and the next turn in
      // that conversation would carry it as context.
      const identity = decideIdentity(req, { signedInAs: email, required: isDeployed() });
      if (!identity.ok) {
        console.error(describeRefusal(identity));
        reply.status(unavailableHttpStatus(identity.code)).json(
          unavailableResult({
            code: identity.code,
            requestId: identity.correlationId,
            // Null rather than the request id. Nothing was run, so there is no
            // run to name, and reusing the request id here would put an
            // identifier in front of the user that finds nothing when quoted.
            runId: null,
            persistence: 'not_stored',
            executionIdentity: refusedIdentityClaim(),
            detail: disclosableRefusal(identity),
          })
        );
        return;
      }

      /**
       * Checked HERE, with the identity refusal and before any write, for the
       * reason the block above gives: a request that will not be executed must
       * not leave a conversation row or a user turn behind it.
       *
       * Refused rather than ignored, and refused in every mode, because this
       * one is about the CALLER's belief. A client that believes it sent an
       * idempotency key and did not believes it is protected against paying for
       * the same question twice, and now is the only moment it can be told
       * otherwise. `admitRun` checks this again; that is deliberate, since it
       * must hold for any future caller of it too.
       *
       * The status and the sentence are IDEMPOTENCY_KEY_MALFORMED's, not this
       * handler's. Both were written out here, and the same pair was written
       * out again in `admitRun`, so one condition answered from two places that
       * could drift from each other and from the code they were reporting.
       */
      const idempotencyKey = (req.header('idempotency-key') ?? '').trim();
      if (idempotencyKey !== '' && !isUsableIdempotencyKey(idempotencyKey)) {
        reply.status(unavailableHttpStatus('IDEMPOTENCY_KEY_MALFORMED')).json(
          unavailableResult({
            code: 'IDEMPOTENCY_KEY_MALFORMED',
            requestId: identity.correlationId,
            // No run to name: this is refused before the ledger is reached.
            runId: null,
            persistence: 'not_stored',
            executionIdentity: refusedIdentityClaim(),
          })
        );
        return;
      }

      const userMessageId = crypto.randomUUID();

      // Checked before anything is written, because `messages` carries no owner
      // of its own: a message belongs to whoever owns its conversation, so an
      // upsert keyed on the id alone let a caller append turns to another user's
      // conversation and then read that user's history straight back as the
      // context for their own question. That is the write-side twin of the
      // unscoped read this route used to do.
      const ownership = await readStored(
        appkit,
        'POST /api/insights/ask (conversation owner)',
        `SELECT user_email FROM ${APP_SCHEMA}.conversations WHERE id = $1`,
        [conversationId]
      );
      const owner = ownership.available ? ownership.rows[0]?.user_email : undefined;
      if (typeof owner === 'string' && owner !== email) {
        // 404 rather than 403: confirming the id exists but belongs to someone
        // else is itself a disclosure.
        console.warn(`[tenancy] Refused ask on conversation ${conversationId}: it belongs to another user.`);
        reply.status(404).json({
          error: 'conversation_not_found',
          message: 'No conversation with this id belongs to you.',
        });
        return;
      }

      // Identity, idempotency-key syntax and ownership are the checks that can
      // reject this caller before accepting the turn. Open the SSE response now,
      // before persistence and context reads, so those Lakebase round trips are
      // visible as accepted work rather than a frozen "sending" state. Later
      // admission refusals use AskResponder's typed `error` event; JSON callers
      // are unchanged because begin() is a no-op for them.
      reply.begin();

      // `messages` carries no owner, so every read of a turn resolves through
      // this row, including `RUNS_QUERY`, which joins it to scope runs to the
      // caller. A first turn whose conversation write is lost therefore stores an
      // answer that no query can reach: not in the Run Explorer, not in the
      // conversation, addressable by nothing. On a turn where the row already
      // exists the upsert only moves `updated_at`, so losing it costs an ordering
      // and nothing else, which is why this is not simply "did the write work".
      const conversationExisted = ownership.available && ownership.rows.length > 0;
      const conversationWrite = await readStored(
        appkit,
        'POST /api/insights/ask (conversation)',
        // The title is claimed on conflict, but ONLY while it is still the placeholder.
        // Attaching a document creates the conversation before any question is asked,
        // and this upsert used to set `updated_at` alone, so that row sat in the rail
        // reading "New conversation" for the rest of its life no matter what was asked
        // in it. Later turns must not rename a conversation after its first question,
        // hence the CASE rather than an unconditional assignment. `conversations.title`
        // is the stored row; `EXCLUDED.title` is this turn's.
        `INSERT INTO ${APP_SCHEMA}.conversations (id, user_email, title) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET updated_at = NOW(),
           title = CASE WHEN conversations.title = $4 THEN EXCLUDED.title ELSE conversations.title END`,
        [conversationId, email, conversationTitle(prompt), PLACEHOLDER_CONVERSATION_TITLE]
      );
      const conversationAddressable = conversationExisted || conversationWrite.available;
      await safeQuery(
        appkit,
        `INSERT INTO ${APP_SCHEMA}.messages (id, conversation_id, role, content) VALUES ($1,$2,$3,$4)`,
        [userMessageId, conversationId, 'user', approvedPlanId ? PLAN_APPROVAL_MESSAGE : prompt]
      );

      // Neither read depends on the other. Keeping them serial made every ask pay
      // both Lakebase latencies before admission even though they are two views of
      // context that was already fixed by the writes above.
      const [historyRead, attachmentRead] = await Promise.all([
        readStored(
          appkit,
          'POST /api/insights/ask (history)',
          `SELECT role, content, response_json FROM (SELECT m.role, m.content, m.response_json, m.created_at
             FROM ${APP_SCHEMA}.messages m
             JOIN ${APP_SCHEMA}.conversations c ON c.id = m.conversation_id
             WHERE m.conversation_id = $1 AND c.user_email = $2
             ORDER BY m.created_at DESC LIMIT 12
           ) recent ORDER BY created_at`,
          [conversationId, email]
        ),
        readStored(
          appkit,
          'POST /api/insights/ask (attachments)',
          `SELECT filename, extracted_text FROM ${APP_SCHEMA}.attachments
           WHERE conversation_id = $1 AND user_email = $2 ORDER BY created_at`,
          [conversationId, email]
        ),
      ]);
      const missingContext = [
        ...(historyRead.available ? [] : ['conversation history']),
        ...(attachmentRead.available ? [] : ['uploaded documents']),
      ];
      if (missingContext.length > 0) {
        // Lakebase persistence is not the product's execution dependency. A
        // Git-deployed app whose SP cannot use the old authored schema can still
        // invoke the governed agent safely as a stateless turn: no unread history
        // or attachment is forwarded, and no row from another user can leak.
        // The response's runStored=false warning tells the reader that this turn
        // will not survive; the app-wide storage banner owns the one remediation.
        console.error(
          `[serving] Answering without ${missingContext.join(' or ')} because Lakebase storage is unavailable. ` +
            'Only the current prompt is sent, and the answer will be marked not stored.'
        );
      }
      const historyRows = historyRead.available ? historyRead.rows : [];
      const attachmentRows = attachmentRead.available ? attachmentRead.rows : [];
      const historyResult = { rows: historyRows };
      const attachmentText = attachmentRows
        .map((row) => `## ${String(row.filename)}\n${String(row.extracted_text)}`)
        .join('\n\n')
        .slice(0, MAX_CONVERSATION_ATTACHMENT_TEXT);

      /**
       * The run ledger. Shadow by default, which records the run and changes
       * nothing about the response; see run-admission.ts, which also lists what
       * has to be true before anybody sets this to `enforce`.
       *
       * HERE and not earlier, because the hash covers the history and the
       * attachments this turn will actually run against, and those have only
       * just been read. HERE and not later, because a run created after the
       * endpoint call could not prevent the duplicate execution it exists to
       * prevent: by then it has already been paid for.
       */
      const admission = await admitRun(appkit, {
        mode: resolveRunLedgerMode(process.env[RUN_LEDGER_MODE_ENV]),
        // The same id the agent is handed as `runId` below, so the ledger row,
        // the trace and the answer all name one run rather than three.
        runId: identity.requestId,
        turnId: userMessageId,
        idempotencyKey,
        request: {
          userEmail: email,
          conversationId,
          prompt,
          history: historyRows.map((row) => ({
            role: String(row.role),
            content: String(row.content),
          })),
          attachments: attachmentRows.map((row) => ({
            filename: String(row.filename),
            text: String(row.extracted_text),
          })),
          approvedPlanId,
          executePlan,
        },
        identityModeRequested: executionIdentityClaim(identity).mode,
        releaseIdentity: releaseIdentity(),
        // The id the browser minted, so the ledger row can be found from a
        // reader's screenshot, a log line, or a trace attribute -- without any of
        // them having to know the run id this app chose internally.
        correlationId: identity.correlationId,
        // The budget the agent is given, so the ledger's deadline and the one
        // in the payload cannot disagree about when this run ran out of time.
        budgetMs: SERVING_INVOKE_TIMEOUT_MS,
        executor: executorName(),
      });
      if (admission.kind === 'refuse') {
        // Unreachable in shadow except for an unusable Idempotency-Key, which
        // is refused in every mode because it is about the CALLER's belief: a
        // client that thinks it is protected against duplicate execution and is
        // not can only be told now.
        console.warn(`[run-ledger] Refused ${identity.requestId} with ${admission.code}: ${admission.detail}`);
        /*
         * The user turn was written so admission could hash the history this
         * request would have run against. A refusal means that turn is not an
         * answer and must not sit in the rail as one. Leaving it was how a
         * reused Idempotency-Key produced a question with no run.
         */
        await appkit.lakebase.query(`DELETE FROM ${APP_SCHEMA}.messages WHERE id = $1`, [userMessageId]);
        if (!conversationExisted) {
          await appkit.lakebase.query(
            `DELETE FROM ${APP_SCHEMA}.conversations WHERE id = $1 AND user_email = $2
               AND NOT EXISTS (SELECT 1 FROM ${APP_SCHEMA}.messages WHERE conversation_id = $1)
               AND NOT EXISTS (SELECT 1 FROM ${APP_SCHEMA}.attachments WHERE conversation_id = $1)`,
            [conversationId, email]
          );
        }
        // Every admission refusal is a taxonomy code now, so they all leave in
        // the same shape. The hand-rolled `{ error: 'idempotency_conflict' }`
        // body that used to serve the two idempotency refusals went with the
        // local constant behind them: it labelled a malformed header a
        // conflict, which is the conflation the split exists to end.
        reply.status(admission.status).json(
          unavailableResult({
            code: admission.code,
            requestId: identity.correlationId,
            runId: admission.runId,
            persistence: 'not_stored',
            executionIdentity: refusedIdentityClaim(),
            detail: admission.detail,
          })
        );
        return;
      }
      if (admission.kind === 'replay') {
        const replay = await readReplay(appkit, admission.run);
        if (replay.kind === 'answer') {
          reply.json(replayBody(replay.body, admission.run));
          return;
        }
        // Everything else the replay could be is a run that finished without an
        // answer to give back, or an answer that cannot be found. Falling
        // through would run the question again, which is exactly what enforce
        // is for stopping, so it is refused with what the first run recorded.
        const code = replay.kind === 'failure' && replay.code ? replay.code : 'PERSISTENCE_UNAVAILABLE';
        console.warn(
          `[run-ledger] Run ${admission.run.runId} was asked again and has no answer to replay ` +
            `(${replay.kind}). Answering with ${code} rather than running it a second time.`
        );
        reply.status(unavailableHttpStatus(code)).json(
          unavailableResult({
            code,
            requestId: identity.correlationId,
            runId: admission.run.runId,
            persistence: 'stored',
            executionIdentity: executionIdentityClaim(identity),
            detail:
              replay.kind === 'failure' ? `This question already ran and ended as ${replay.state}.` : replay.detail,
          })
        );
        return;
      }

      /**
       * What this turn will answer with. Declared with no value on purpose.
       *
       * It used to be pre-seeded with the stored demo answer and
       * overwritten by the two paths that had a live answer to put there. That
       * made canned figures the default outcome of the block below rather than
       * a decision inside it: any exception, and any payload matching none of
       * the four contracts, served the demo dataset over HTTP 200 as
       * `type: 'answer'`, and there was no statement anywhere saying so to find
       * when somebody asked why. Adding one `custom_outputs` shape to the agent
       * was enough to do it.
       *
       * Nothing assigns it a stored answer now, on any target, and no target
       * holds one to assign. A question that was asked is answered by the run
       * or reported as unanswered.
       *
       * Uninitialised, TypeScript will not compile a path out of here that has
       * not said what it is serving, so a new early exit or a new unhandled
       * payload shape is a build failure rather than a plausible wrong number
       * in front of a customer.
       */
      let answer: ServedAnswer;
      // Set by the invocation below and read after it, because the disclosure
      // belongs on the answer and the answer is assembled further down. False
      // until something proves otherwise: nothing has run as anybody yet.
      let ranAsSignedInUser = false;
      // How far the run got, read by the failure paths below. Undefined rather
      // than a zeroth stage: a turn that answers with a plan emits no stages at
      // all, and reporting "stopped in step 0" for one would name a step that
      // does not exist.
      let stagesSeen = 0;
      let lastStage: FailureStage | undefined;
      const collectedStages: Record<string, unknown>[] = [];
      // The runtime this Ask sent. Snapshotted onto the stored row so Monitoring
      // and Run Explorer can show what THIS run used after Settings has moved on.
      let askRuntime: RuntimeSettings | undefined;
      try {
        const servingHistory = buildServingHistory(historyResult.rows);
        if (approvedPlanId && servingHistory.length > 0) {
          servingHistory[servingHistory.length - 1] = { role: 'user', content: prompt };
        }
        askRuntime = await readRuntimeSettings(appkit);
        const payload = buildAskServingBody({
          history: servingHistory,
          prompt,
          conversationId,
          approvedPlanId,
          executePlan,
          attachmentText,
          stream: reply.wantsStream,
          requestId: identity.correlationId,
          runId: identity.requestId,
          expectedUser: identity.token ? email : '',
          deadlineAt: new Date(Date.now() + SERVING_INVOKE_TIMEOUT_MS).toISOString(),
          runtimeSettings: askRuntime,
        });
        // Counted on the way past, so a failure can say where the run died
        // rather than only that it did. "It stopped in 'Query
        // gold_title_daily_summary' after four steps" and "it never started" are
        // the same red panel today, and they send a reader to two different
        // people. The forwarding behaviour is unchanged: this only reads what is
        // already going by.
        /**
         * Where each step is written down, so a browser that leaves mid-run can
         * be shown the path again when it returns.
         *
         * Null when the ledger recorded no run for this request, which is shadow
         * mode over a database whose ledger tables were refused: there is no
         * `run_id` to file the steps under, and inventing one would produce a
         * narration nothing could ever find. The run is unaffected either way --
         * nothing below waits on this, and a reconnect simply has no steps to
         * replay, which is the behaviour every run had before this existed.
         */
        const stageRecorder = admission.run ? createStageRecorder(appkit, admission.run.runId) : null;
        const onStage = (stage: Record<string, unknown>) => {
          // Always collected, including when the browser did not ask for a
          // stream. The prose-only path used to persist `stages: []` because
          // this list did not exist, so a failed run that had taken many
          // tools stored a card that said nothing ran.
          const id = typeof stage.id === 'string' ? stage.id : '';
          const at = id ? collectedStages.findIndex((held) => held.id === id) : -1;
          if (at !== -1) collectedStages[at] = stage;
          else collectedStages.push(stage);
          // Forwarded whatever it is, counted only if it finished. The
          // endpoint now announces a step when it STARTS as well, under the
          // same id and with `status: "running"`, so the rail can draw the
          // row a reader is waiting on. Counting those would double every
          // number in `FailureStage` and name a step that had not run as the
          // last one to finish, which is what that contract exists to avoid.
          if (!isRunningStage(stage)) {
            stagesSeen += 1;
            // The last stage to COMPLETE, which is not the stage that
            // failed; see FailureStage. Incremented first so the count and
            // the title describe the same event.
            lastStage = { title: readStageTitle(stage), completed: stagesSeen };
          }
          if (reply.wantsStream) reply.stage(stage);
          // AFTER the forward, and never awaited. The reader watching this
          // run live must not wait behind a write that exists for the
          // reader who left. Announcements are stored as well as
          // completions: the step a returning reader is waiting ON is the
          // one worth showing them, and it arrives as `running`.
          stageRecorder?.record(stage);
        };
        // Two calls rather than one with a nullable token, so the path that runs
        // without a user is visibly the local one and cannot be reached by a
        // deployed request: `bindIdentity` has already refused an empty token
        // above whenever `isDeployed()`.
        const endpointResult = identity.token
          ? await invokeServingAsUser(appkit, payload, identity.token, onStage)
          : await invokeServing(appkit, payload, onStage);
        ranAsSignedInUser = Boolean(identity.token);
        /**
         * Before all four shapes, because a refusal is none of them and looks
         * like one of them.
         *
         * `invokeServingAsUser` raises `AuthorizationRefused` when the ENDPOINT
         * declines the invocation with a 401 or a 403. This is the other half:
         * the invocation succeeded and the agent's identity gate declined the
         * turn from inside it, which a Model Serving container can only report
         * as an ordinary 200. The refusal arrives in `custom_outputs`, and its
         * sentence arrives in a text output item, where `extractLiveText` found
         * it and served it as prose with the stored demo answer's figures,
         * charts, sources and SQL attached. A reader refused on identity
         * grounds was shown the demo dataset with "could not be executed with
         * your permissions" as its takeaway.
         */
        const refused = readAgentRefusal(endpointResult, { requestId: identity.correlationId });
        if (refused) {
          console.warn(
            `[identity] Agent refused request ${identity.correlationId} with ${refused.code}` +
              `${refused.execution_identity ? `, executing as ${refused.execution_identity.mode}` : ''}. ` +
              'Returning unavailable rather than an answer.'
          );
          await settleRun(appkit, admission, { to: terminalStateFor(refused.code), code: refused.code });
          reply.status(unavailableHttpStatus(refused.code)).json(refused);
          return;
        }
        const plan = extractAnalysisPlan(endpointResult);
        if (plan && approvedPlanId === plan.id) {
          // The agent was handed an approval for this exact plan and answered with
          // the same plan again. Returning it would put the user in a loop:
          // approve, receive the identical plan, approve. Falling through is worse
          //. That was the old behaviour, and it answered a plan-approval request
          // with canned figures. So: neither, and say what happened.
          console.error(
            `[serving] Approved plan ${approvedPlanId} was re-proposed unchanged instead of being ` +
              'run. Refusing to loop the approval, and refusing to answer with representative ' +
              'figures the user did not ask for.'
          );
          // FAILED rather than parked. The approval was not run, and a run left
          // waiting on a person who has already answered is a run nothing will
          // ever finish.
          await settleRun(appkit, admission, { to: 'FAILED', code: 'DEPENDENCY_UNAVAILABLE' });
          reply.status(502).json({
            error: 'plan_not_executed',
            planId: plan.id,
            message:
              'The agent proposed the same plan again instead of running the one you approved. ' +
              'Nothing was run, and this is not an answer to your question. Start the question ' +
              'again to get a fresh plan.',
          });
          return;
        }
        if (plan) {
          /**
           * Two ways to arrive here, and the plan is the right response to both.
           *
           * With an approval carrying a *different* id, the agent has refused that
           * approval and re-issued. The id was stale, or it authorised a different
           * question. That refusal is the point of binding an approval to its plan,
           * so it has to reach the user as a plan to look at and approve. This used
           * to warn and fall through to the stored demo answer, which
           * answered the rejection with invented figures over HTTP 200. The client
           * already expects the plan here and explains the re-proposal; it was only
           * ever the server discarding it.
           */
          const reissued = Boolean(approvedPlanId);
          if (reissued) {
            console.warn(
              `[serving] Approval for plan ${approvedPlanId} was refused by the agent, which ` +
                `re-issued plan ${plan.id}. Returning the new plan for approval rather than ` +
                'answering a question the user has not authorised yet.'
            );
          }
          const planResponse = {
            type: 'plan' as const,
            mode: 'live' as const,
            plan,
            // Recorded on the response, and so into `response_json`, because a
            // re-issue is the interesting event when someone asks later why an
            // approval did not run.
            ...(reissued ? { supersededApprovalId: approvedPlanId } : {}),
          };
          await safeQuery(
            appkit,
            `INSERT INTO ${APP_SCHEMA}.messages
             (id, conversation_id, role, content, response_json,
              app_principal, serving_principal, serving_principal_observed_at, access_mode,
              execution_mode, execution_identity_verified)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              `msg-${crypto.randomUUID()}`,
              conversationId,
              'assistant',
              plan.summary,
              JSON.stringify(withAskRuntime(planResponse, askRuntime)),
              ...executionIdentityColumns(email, executionIdentityClaim(identity)),
            ]
          );
          // Parked, not finished. The run is waiting on a person now, and the
          // lease is released with it so the approval that follows is the same
          // run picked up again rather than a duplicate refused for being in
          // flight. The fingerprint is what the approval will resume on.
          await parkRun(appkit, admission, plan.id);
          reply.json(planResponse);
          return;
        }
        // Before the answer contract, deliberately. A clarification has no
        // takeaway, so the answer parse fails and the fall-through would serve a
        // representative answer to a question the agent had just said it could
        // not answer, with the figures of a different question, over HTTP 200.
        const clarification = extractClarification(endpointResult);
        if (clarification) {
          const clarificationResponse = {
            type: 'clarification' as const,
            mode: 'live' as const,
            clarification,
          };
          await safeQuery(
            appkit,
            `INSERT INTO ${APP_SCHEMA}.messages
             (id, conversation_id, role, content, response_json, trace_id,
              app_principal, serving_principal, serving_principal_observed_at, access_mode,
              execution_mode, execution_identity_verified)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              `msg-${clarification.id}`,
              conversationId,
              'assistant',
              clarification.question,
              JSON.stringify(withAskRuntime(clarificationResponse, askRuntime)),
              clarification.trace.id,
              ...executionIdentityColumns(email, executionIdentityClaim(identity)),
            ]
          );
          await settleRun(appkit, admission, {
            to: 'CLARIFICATION_REQUIRED',
            traceId: clarification.trace.id,
            messageId: `msg-${clarification.id}`,
          });
          reply.json(clarificationResponse);
          return;
        }
        const structuredAnswer = extractStructuredAnswer(endpointResult);
        const liveText = extractLiveText(endpointResult);
        if (structuredAnswer) {
          // Everything a reader will see came back from this run:
          // `LiveAnswerSchema` requires the figures, sources, SQL and trace, so
          // there is nothing here for the app to have filled in. This is the
          // only path allowed to say 'live', and saying it here is what makes
          // the silence on the path below mean something.
          answer = attachRecordedStages(
            { ...structuredAnswer, mode: 'live', provenance: 'live' },
            collectedStages
          );
        } else if (liveText) {
          // The endpoint replied in prose and sent no result contract. Its
          // words are kept and nothing is put under them -- except the steps
          // the stream already reported. Those used to be dropped here, which
          // is why a failed run that had taken many tools stored a card that
          // said "no steps".
          //
          // This used to build the answer on top of the stored demo answer, so
          // the figures, charts, sources, SQL and stage timings a reader saw
          // beneath a narrative about their own business were the demo seed.
          // `provenance: 'mixed'` and a caveat said so and neither was a
          // control, because the numbers were still on the screen. See
          // shared/prose-only-answer.ts for why this is not reported as an
          // evidence failure either.
          //
          // `provenance` is 'live' and that is not a downgrade of the claim: it
          // means every reader-facing part came from this run, which is now
          // true here because there are no parts that did not.
          answer = {
            ...proseOnlyAnswer(`msg-${crypto.randomUUID()}`, liveText, collectedStages),
            mode: 'live',
            provenance: 'live',
          };
        } else {
          // Not a warning. The app and the model version have drifted apart,
          // which is two artifacts released separately and in either order, and
          // this line is the only record of which shape actually arrived.
          const shape = describePayloadShape(endpointResult);
          console.error(
            '[serving] The endpoint answered, but with none of the four shapes this app can read ' +
              `(plan, clarification, structured answer, live text). ${shape}. Payload: ` +
              JSON.stringify(endpointResult).slice(0, 1200)
          );
          await settleRun(appkit, admission, {
            to: terminalStateFor('OUTPUT_SCHEMA_VIOLATION'),
            code: 'OUTPUT_SCHEMA_VIOLATION',
          });
          reply.status(unavailableHttpStatus('OUTPUT_SCHEMA_VIOLATION')).json(
            unavailableResult({
              code: 'OUTPUT_SCHEMA_VIOLATION',
              requestId: identity.correlationId,
              runId: null,
              // The endpoint answered, so a run happened. What did not happen
              // is anything this app could store as an answer, and claiming
              // `not_stored` would assert a write failure nobody attempted.
              persistence: 'not_stored',
              executionIdentity: executionIdentityClaim(identity),
              detail: shape,
              // The endpoint's status was 200 and saying so is the point: a
              // reader who has been told the app cannot read the reply needs to
              // know the reply arrived, or they go and check whether the
              // endpoint is up. The shape IS the error here, so it travels as
              // the provider message; there is no provider sentence to quote
              // because the provider did not think anything had gone wrong.
              evidence: {
                dependency: agentEndpointDependency(),
                status: 200,
                providerMessage: shape,
                ...(lastStage ? { stage: lastStage } : {}),
              },
            })
          );
          return;
        }
      } catch (error) {
        if (error instanceof TruncatedStreamError && error.stages > 0) {
          console.error(
            `[serving] The stream ended after ${error.stages} stage(s). The partial run was kept and no second invocation was started.`
          );
          await settleRun(appkit, admission, {
            to: terminalStateFor('STREAM_INTERRUPTED'),
            code: 'STREAM_INTERRUPTED',
          });
          reply.status(unavailableHttpStatus('STREAM_INTERRUPTED')).json(
            unavailableResult({
              code: 'STREAM_INTERRUPTED',
              requestId: identity.correlationId,
              runId: admission.run?.runId ?? null,
              persistence: admission.run ? 'stored' : 'not_stored',
              executionIdentity: executionIdentityClaim(identity),
              detail: error.message,
              evidence: agentEndpointEvidence(error, {
                principal: email,
                ...(lastStage ? { stage: lastStage } : {}),
              }),
            })
          );
          return;
        }
        // First, because an authorization denial and an endpoint that did not
        // answer send a reader to two different people. Both end in an
        // unavailable result now, so the ordering no longer decides whether the
        // demo dataset appears; it decides which sentence and which status the
        // reader gets, which is the thing it was always for.
        if (error instanceof AuthorizationRefused) {
          await settleRun(appkit, admission, { to: terminalStateFor(error.code), code: error.code });
          reply.status(error.httpStatus).json(
            unavailableResult({
              code: error.code,
              requestId: identity.correlationId,
              runId: null,
              persistence: 'not_stored',
              // What was asked for, and unverified, because the endpoint is the
              // thing that just declined to confirm it.
              executionIdentity: refusedIdentityClaim(),
              detail: error.disclosable,
              // Built here rather than through `agentEndpointEvidence`, which
              // forwards the provider's sentence unedited. This is the one path
              // that may not: for the reason set out on
              // `AuthorizationRefused.disclosable`, Unity Catalog names the
              // table, the privilege and its owner, and this body reaches the
              // person who has just been told they may not read that table.
              //
              // The STATUS still travels, and it is the part that resolves the
              // ambiguity a reader is actually stuck on -- 401 means their
              // session, 403 means their grants, and those are two different
              // people to go and see. It names nothing.
              evidence: {
                dependency: agentEndpointDependency(),
                // The endpoint's status, not the taxonomy's. They agree today
                // and they are different facts, and this panel is the one place
                // that has to say which one it is quoting.
                ...(error.providerStatus === undefined ? {} : { status: error.providerStatus }),
                providerMessage: error.disclosable,
                principal: email,
                ...(lastStage ? { stage: lastStage } : {}),
              },
            })
          );
          return;
        }
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[serving] The agent endpoint call failed and nothing ran. Cause: ${detail}`);
        await settleRun(appkit, admission, {
          to: terminalStateFor('DEPENDENCY_UNAVAILABLE'),
          code: 'DEPENDENCY_UNAVAILABLE',
        });
        reply.status(unavailableHttpStatus('DEPENDENCY_UNAVAILABLE')).json(
          unavailableResult({
            code: 'DEPENDENCY_UNAVAILABLE',
            requestId: identity.correlationId,
            runId: null,
            persistence: 'not_stored',
            executionIdentity: executionIdentityClaim(identity),
            detail,
            // Verbatim, and this is the path the failure the user reported came
            // down. Everything here describes our own infrastructure -- a
            // timeout, a socket, a Model Serving 5xx -- so there is nothing to
            // withhold, and the reader's alternative was "a service this needed
            // did not respond just now" over a payload that named the endpoint
            // and quoted its error.
            evidence: agentEndpointEvidence(error, {
              principal: email,
              ...(lastStage ? { stage: lastStage } : {}),
            }),
          })
        );
        return;
      }

      // Disclosed on the way out rather than only where the fallback is built,
      // so a stored answer reaching here by any route is covered rather than
      // whichever ones somebody remembered.
      const disclosed = discloseExecutingIdentity(discloseAnswerProvenance(answer), ranAsSignedInUser);
      // Not `safeQuery`, whose contract is that a failed write does not change
      // the response. It does change this one. This row IS the run: `/api/runs`
      // derives conversation runs from stored answers, so when the write is lost
      // the id below names nothing, and "Explore full run" links to a run the
      // Run Explorer cannot find. That is not a hypothetical. The answer comes
      // back complete, live and fully traced over HTTP 200, so nothing on screen
      // suggests anything went wrong until the link is followed.
      //
      // The answer is still returned. It is the agent's own work and the user
      // watched it happen; withholding it because a row was lost would be a
      // worse trade. What it must not do is claim to be addressable.
      const persisted = await readStored(
        appkit,
        'POST /api/insights/ask (answer)',
        `INSERT INTO ${APP_SCHEMA}.messages
         (id, conversation_id, role, content, response_json, trace_id,
          app_principal, serving_principal, serving_principal_observed_at, access_mode,
          execution_mode, execution_identity_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          disclosed.id,
          conversationId,
          'assistant',
          disclosed.narrative,
          JSON.stringify(withAskRuntime(disclosed, askRuntime)),
          disclosed.trace.id,
          // Recorded on the answer rather than on the question, because these
          // name the authority something RAN under and a question runs nothing.
          ...executionIdentityColumns(email, executionIdentityClaim(identity)),
        ]
      );
      const runStored = persisted.available && conversationAddressable;
      if (!runStored) {
        const cause =
          (!persisted.available && persisted.error) ||
          (!conversationWrite.available && conversationWrite.error) ||
          'the write reported no error';
        console.error(
          `[lakebase] The answer to this question was not stored, so run ${disclosed.id} does not ` +
            'exist for the Run Explorer to open and this turn is absent from the conversation ' +
            `history. The answer itself was returned. Last error: ${cause}`
        );
      }
      // SUCCEEDED only when the answer is addressable. A run marked as having
      // answered, naming a message that was never written, is a ledger that
      // disagrees with itself and a replay that finds nothing; PERSISTENCE_FAILED
      // is the state that says an answer happened and was not kept.
      await settleRun(
        appkit,
        admission,
        runStored
          ? { to: 'SUCCEEDED', traceId: disclosed.trace.id, messageId: disclosed.id }
          : { to: 'PERSISTENCE_FAILED', code: 'PERSISTENCE_UNAVAILABLE', traceId: disclosed.trace.id }
      );
      // Reported in the body rather than in a header, because the streaming
      // caller's headers were flushed before the agent was even invoked, by the
      // time this is known there is no status line or header left to say it with.
      // Beside `runStored` rather than inside `disclosed`, because both are
      // facts this server knows about the request and neither is part of the
      // agent's answer contract: folding them in would make every stored run
      // report fields the answer schema does not declare.
      reply.json({
        type: 'answer',
        ...disclosed,
        runStored,
        execution_identity: executionIdentityClaim(identity),
      });
    });

    app.get('/api/runs', async (req, res) => {
      await respondWithStored(appkit, res, 'GET /api/runs', RUNS_QUERY, [PLAN_APPROVAL_MESSAGE, userEmail(req)]);
    });

    /**
     * What the app itself can say about its own storage, without asking the
     * agent. The Sources page reads this beside the agent's preflight report so
     * an unreachable Lakebase is stated rather than left as "Not checked", and
     * the client polls it to decide whether the lists on screen are stored
     * records, an empty store, or a store it could not read.
     */
    app.get('/api/storage', (_req, res) => {
      const health = lakebaseHealth();
      res.status(health.state === 'unavailable' ? 503 : 200).json(health);
    });

    /**
     * The id a user quotes when a read route could not answer.
     *
     * Minted here when the caller sent none, rather than left blank: the point
     * of the field is that the sentence on screen and the line in the log can be
     * matched up, and an empty one is worse than a made-up one because it looks
     * like the log is missing rather than the header.
     */
    const traceRequestId = (req: Request) => req.get('x-request-id') ?? `req-${crypto.randomUUID()}`;

    /**
     * The trace behind one run, whichever kind of run it is.
     */
    app.get('/api/runs/:id/trace', async (req, res) => {
      const runId = req.params.id;
      const email = userEmail(req);
      // Read per request, not cached: `experiment-id` is an `app-runtime`
      // resource, so a value saved in the settings pane has to take effect on
      // the next trace opened rather than on the next deploy. Falls back to the
      // environment, and to no link at all, without throwing.
      const experimentId = await resolveExperimentId(appkit);
      let resolved: RunTrace | null = null;
      try {
        const message = await appkit.lakebase.query(RUN_TRACE_MESSAGE_QUERY, [runId, PLAN_APPROVAL_MESSAGE, email]);
        if (message.rows[0]) {
          resolved = conversationRunTrace(message.rows[0], experimentId);
        } else {
          const benchmark = await appkit.lakebase.query(RUN_TRACE_BENCHMARK_QUERY, [runId, email]);
          if (benchmark.rows[0]) resolved = benchmarkRunTrace(benchmark.rows[0]);
        }
      } catch (error) {
        console.warn('[lakebase] Run trace could not be read:', (error as Error).message);
        // A trace nobody could read is reported as unreadable rather than
        // answered from a fixture, because a reference trace under a run id the
        // user clicked reads as that run's own stages.
        res.status(unavailableHttpStatus('PERSISTENCE_UNAVAILABLE')).json(
          unavailableResult({
            code: 'PERSISTENCE_UNAVAILABLE',
            requestId: traceRequestId(req),
            runId,
            persistence: 'unknown',
            detail: (error as Error).message,
          })
        );
        return;
      }

      // The read succeeded, so whatever is missing here, the database is not it.
      if (!resolved) {
        res.status(404).json({
          error: 'run_not_found',
          runId,
          message: 'No run with this id is stored. It may have been created by a different workspace.',
        });
        return;
      }

      // Same posture as the answer contract: report a shape that has drifted,
      // never drop the body over it.
      const parsed = RunTraceSchema.safeParse(resolved);
      if (!parsed.success) {
        console.warn(
          `[runs] Trace for ${runId} does not match the run-trace contract:`,
          parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ')
        );
      }
      if (resolved.undeclaredKeys.length > 0) {
        console.warn(
          `[runs] Stored answer for ${runId} contains fields the app does not read:`,
          resolved.undeclaredKeys.join(', ')
        );
      }
      // The workspace link, withheld when this deployment has turned that path
      // off. Here rather than inside `runFromRecord`, which is a pure function
      // over a stored row with no store to ask: this is the response boundary,
      // and withholding at the boundary is what makes the URL never reach the
      // browser. The trace id and the experiment id stay, because they are
      // identifiers rather than a route, and Run Details already draws the id
      // without an anchor when there is no url. See lib/egress-store.ts.
      const payload = parsed.success ? parsed.data : resolved;
      if (payload.mlflow?.url && !(await workspaceLinksAllowed(appkit))) {
        payload.mlflow = { ...payload.mlflow, url: null };
      }
      res.json(payload);
    });

    /**
     * Record one rating, and only claim to have recorded it if something did.
     */
    app.post('/api/feedback', async (req, res) => {
      const parsed = FeedbackBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Feedback is invalid.' });
        return;
      }
      const feedback = { id: crypto.randomUUID(), ...parsed.data, userEmail: userEmail(req) };
      const written = await readStored(
        appkit,
        'POST /api/feedback',
        `INSERT INTO ${APP_SCHEMA}.feedback
         (id, message_id, user_email, sentiment, usefulness, comment) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          feedback.id,
          feedback.messageId,
          feedback.userEmail,
          feedback.sentiment ?? null,
          feedback.usefulness ?? null,
          feedback.comment ?? null,
        ]
      );
      if (!written.available) {
        markResponse(res, noSubstitution('storage_unavailable'));
        res.status(503).json({
          error: 'feedback_not_recorded',
          message:
            'This rating was not recorded, because the store did not accept it. Nothing was saved, so ' +
            'it is worth giving again shortly rather than assuming it landed.',
        });
        return;
      }
      // An INSERT answers with no rows, so `available` (not the row count), is
      // what says it landed.
      markResponse(res, noSubstitution());
      res.status(201).json(feedback);
    });

    /**
     * The suite's cases, so the Benchmark Lab can list what it is about to run.
     *
     * The questions live in a server-side catalog keyed by the ids
     * `benchmark_suites.cases_json` already holds, because that column carries
     * ids alone: the questions themselves only ever existed as a hardcoded
     * array in the client, next to hardcoded results. One source now, read by
     * both the list and the runner, so the scenario shown on screen and the
     * question sent to the agent cannot be different strings.
     */
    app.get('/api/benchmarks/suite', async (req, res) => {
      const requestedSuiteId = typeof req.query.suiteId === 'string' ? req.query.suiteId : CANONICAL_SUITE.id;
      const suite = canonicalSuite(requestedSuiteId);
      if (!suite) {
        res.status(404).json({
          error: 'unknown_suite',
          message: `No benchmark suite is known by the id "${requestedSuiteId}".`,
        });
        return;
      }
      const stored = await safeQuery(appkit, `SELECT cases_json FROM ${APP_SCHEMA}.benchmark_suites WHERE id = $1`, [
        suite.id,
      ]);
      const resolved = resolveSuiteCases(parseStoredJson(stored.rows[0]?.cases_json) ?? []);
      // Falls back to the catalog when the store cannot be read, and says which
      // it served, so a case list is never quietly a different one.
      const source = resolved.length > 0 ? 'suite-row' : 'catalog';
      const cases =
        resolved.length > 0
          ? resolved.map((entry) => ({
              id: entry.caseId,
              name: entry.definition?.name ?? entry.caseId,
              question: entry.question,
              intent: entry.definition?.intent ?? '',
              questionSource: entry.questionSource,
            }))
          : BENCHMARK_CASE_CATALOG.map((entry) => ({
              id: entry.id,
              name: entry.name,
              question: entry.question,
              intent: entry.intent,
              questionSource: 'catalog' as const,
            }));
      res.json({ suiteId: suite.id, suiteName: suite.name, caseListSource: source, cases });
    });

    /**
     * Starts a real run of the suite. Answers 202, not 201: the row exists, the
     * results do not yet.
     *
     * Six cases take about four and a half minutes, so the request returns as
     * soon as the `running` row is stored and the browser polls
     * `GET /api/runs/:id/trace`, which resolves benchmark runs already.
     */
    app.post('/api/benchmarks/run', async (req, res) => {
      const parsed = BenchmarkRunBody.safeParse(req.body);
      const requestedSuiteId = parsed.success ? (parsed.data.suiteId ?? CANONICAL_SUITE.id) : CANONICAL_SUITE.id;
      const email = userEmail(req);

      /**
       * A BENCHMARK RUNS AS THE PERSON WHO STARTED IT. There is no benchmark
       * identity and no exemption for one.
       *
       * This route used to call the endpoint through the bare transport with no
       * token, which resolves as the app's own service principal. That was
       * survivable only while the served model version had a service-principal
       * path at all. A version logged with PLAYER_INSIGHTS_USER_AUTHORIZATION
       * has none, so those invocations would have come back refused with
       * IDENTITY_REQUIRED and the whole page would have read as broken.
       *
       * The fix people reach for first is to exempt the benchmark as a named
       * non-user execution mode. That was considered and rejected: it would
       * make this the one surface in the app whose numbers come from a code
       * path no real question takes, so the suite would go on passing while the
       * thing it is supposed to measure was refusing every reader. Binding it
       * to the signed-in user costs a session and buys a benchmark that fails
       * when the product fails.
       */
      const identity = decideIdentity(req, { signedInAs: email, required: isDeployed() });
      if (!identity.ok) {
        console.error(describeRefusal(identity));
        res.status(unavailableHttpStatus(identity.code)).json(
          unavailableResult({
            code: identity.code,
            requestId: identity.correlationId,
            runId: null,
            persistence: 'not_stored',
            executionIdentity: refusedIdentityClaim(),
            // The ask route's change, applied to the route that was missed by
            // it. `IdentityRefused.detail` names the subject resolved from the
            // token beside the signed-in user, its own declaration says that is
            // the thing which must not reach the caller, and `detail` here is
            // carried in the response body. Starting a benchmark is not a
            // smaller disclosure than asking a question.
            detail: disclosableRefusal(identity),
          })
        );
        return;
      }

      const agentEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
      if (!agentEndpoint) {
        // Said plainly rather than answered with a representative run. Every
        // other read path in this file may fall back to demo data and label it;
        // a benchmark may not, because a benchmark of an endpoint that was never
        // called is a number about nothing.
        res.status(503).json({
          error: 'agent_endpoint_not_configured',
          message:
            'DATABRICKS_SERVING_ENDPOINT_NAME is not set, so there is no endpoint to benchmark. No run was ' +
            'started: scoring the offline fallback would report figures for an agent that never ran.',
        });
        return;
      }
      // Resolved per run rather than read straight from the environment, because
      // a saved value on the settings page is allowed to override it and the app
      // can be running more than one replica. See lib/app-settings.ts.
      const judgeEndpoint = await resolveJudgeEndpoint(appkit);
      const transport = appkit.servingTransport ?? workspaceServingTransport;

      const started = await startBenchmarkRun({
        // Direct, not through `safeQuery`. That helper degrades a failed read to
        // zero rows, and the runner needs to tell an empty store from an
        // unreachable one so it can report which.
        store: appkit.lakebase,
        identity: {
          email,
          mode: identity.mode,
          verified: identity.verified,
          // Read once, here, and carried for the life of the suite. The runner
          // needs it to decide whether the credential can cover the run and to
          // stop when it cannot; see lib/benchmark-identity.ts.
          lifetime: credentialLifetime(identity.token),
        },
        requestedSuiteId,
        askAgent: async (request) => {
          const payload = buildAskServingBody({
            history: [{ role: 'user', content: request.prompt }],
            prompt: request.prompt,
            conversationId: request.conversationId,
            approvedPlanId: request.approvedPlanId,
            executePlan: request.executePlan,
            attachmentText: '',
            requestId: identity.correlationId,
            runId: identity.requestId,
            // The same expression the ask route uses, so a benchmark turn and a
            // real turn declare the same identity contract to the agent. Empty
            // on a laptop, where there is no proxy and so no user to assert.
            expectedUser: identity.token ? email : '',
            runtimeSettings: await readRuntimeSettings(appkit),
          });
          let raw: unknown;
          try {
            // `invokeServingAsUser`, not the bare transport, and that is the
            // whole point of this route's change. It is the same function the
            // ask route calls, so a benchmark turn cannot diverge from a real
            // one, and it is the function with no second attempt in it: a 401
            // or a 403 becomes an AuthorizationRefused rather than a retry
            // under the app's own principal.
            raw = identity.token
              ? await invokeServingAsUser(appkit, payload, identity.token)
              : await invokeServing(appkit, payload);
          } catch (error) {
            if (!(error instanceof AuthorizationRefused)) throw error;
            // `disclosable`, not `message`, for the reason spelled out on the
            // getter. This route was missed when the ask route was changed, and
            // it is the same disclosure one page across: an identity-layer
            // refusal ends the suite, its `detail` is written to `truncation` in
            // the run's stored metrics, and those metrics are returned to the
            // browser whole. Nothing renders this field today, which is what
            // kept it from being noticed and is not what makes it safe.
            return {
              type: 'refused',
              code: error.code,
              message: FAILURE_TAXONOMY[error.code].uiMessage,
              detail: error.disclosable,
            };
          }
          /**
           * BEFORE the three shapes below, exactly as the ask route reads it
           * before its four.
           *
           * A refusal arrives inside an HTTP 200 and matches none of them, so
           * without this it fell through to `unrecognized` and every case of a
           * refused suite was recorded as "the endpoint returned no answer,
           * plan or clarification this app can read". That is a sentence about
           * app-versus-model skew, and it would have sent somebody debugging a
           * contract while the real answer was that the run had no user to be.
           */
          const refused = readAgentRefusal(raw, { requestId: identity.correlationId });
          if (refused) {
            return {
              type: 'refused',
              code: refused.code,
              message: refused.message ?? '',
              detail: refused.detail ?? '',
            };
          }
          // Same order as the ask path, for the same reason: a clarification
          // carries no takeaway, so checking the answer contract first would
          // fall through to a representative answer for a question the agent
          // had just declined to answer.
          const clarification = extractClarification(raw);
          if (clarification) {
            return { type: 'clarification', question: clarification.question, traceId: clarification.trace.id };
          }
          const plan = extractAnalysisPlan(raw);
          if (plan) return { type: 'plan', planId: plan.id };
          const answer = extractStructuredAnswer(raw);
          if (answer) return { type: 'answer', answer };
          return {
            type: 'unrecognized',
            detail: 'The endpoint returned no answer, plan or clarification this app can read.',
          };
        },
        judge: {
          // The same transport, one endpoint path along. Deliberately not a
          // second client, see the note on `workspaceServingTransport`.
          //
          // Carries the user's token too. The judge reads no governed data, so
          // this is not about grants; it is that a run which invoked one
          // endpoint as its reader and another as the application would leave
          // a service-principal path on this surface for somebody to widen
          // later. A reader without CAN QUERY on the judge endpoint gets
          // `errored` judgements, which the runner already refuses to count as
          // passes.
          invoke: (payload) =>
            transport({
              path: servingInvocationPath(judgeEndpoint),
              payload,
              userToken: identity.token || undefined,
            }),
          judgeEndpoint,
        },
        describeServedModel: async () => {
          const { WorkspaceClient } = await import('@databricks/sdk-experimental');
          // A read of the endpoint's configuration, not an invocation of it, so
          // this is not the `servingEndpoints.query()` the lint rule forbids.
          //
          // Deliberately still the app's own client while everything above runs
          // as the user. This reads which model version is serving, which is
          // the app's own deployment metadata rather than anybody's governed
          // data, and it is the line that attributes the scores to a version.
          // Running it as the reader would mean anybody without CAN VIEW on the
          // endpoint recorded a run whose version was "unknown", which degrades
          // the honesty of the record to buy no boundary at all.
          const endpoint = await new WorkspaceClient({}).servingEndpoints.get({ name: agentEndpoint });
          return parseServedModel(agentEndpoint, endpoint);
        },
      });

      if (started.status === 401 && started.refusal) {
        // The runner refused on identity grounds, so it is answered in the same
        // terminal shape the ask route uses rather than as a bare error body.
        // One event, one vocabulary, whichever page it happened on.
        console.error(
          `[identity] REFUSED ${started.refusal.code} (${identity.correlationId}): ` + `${started.refusal.detail}`
        );
        res.status(unavailableHttpStatus(started.refusal.code)).json(
          unavailableResult({
            code: started.refusal.code,
            requestId: identity.correlationId,
            runId: null,
            persistence: 'not_stored',
            executionIdentity: refusedIdentityClaim(),
            message: started.body.message,
            detail: started.refusal.detail,
          })
        );
        return;
      }
      if (started.status !== 202) {
        res.status(started.status).json(started.body);
        return;
      }
      // Not awaited. The suite takes minutes, the row is already stored as
      // `running`, and holding the request open for it is what this design
      // avoids. The runner records its own failures into that row; this catch is
      // for anything that escaped it entirely.
      started.completed.catch((error: unknown) => {
        console.error(`[benchmark] Run ${started.body.id} failed outside its own error handling:`, error);
      });
      res.status(202).json(started.body);
    });
  });

  // Handed back rather than awaited. See the note on this function: awaiting it
  // here would be the cold-start block this arrangement exists to remove.
  return Promise.resolve({ storeReady });
}
