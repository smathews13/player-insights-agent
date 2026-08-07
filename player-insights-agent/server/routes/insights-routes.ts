import { raw, type Application, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { extractPdfText, isPdfFilename } from '../lib/pdf-text';
import {
  chooseRows,
  GRANT_DENIED_LOG_REMEDY,
  isGrantDenialFailure,
  lakebaseHealth,
  lakebaseStorageCheck,
  markResponse,
  readStored,
  startLakebaseWatchdog,
} from '../lib/lakebase-store';
import {
  buildSql,
  buildSources,
  REPRESENTATIVE_ANSWER_CAVEAT,
  REPRESENTATIVE_CAVEATS,
  REPRESENTATIVE_FIGURES,
  REPRESENTATIVE_NARRATIVE,
  REPRESENTATIVE_TAKEAWAY,
  representativeFallbackCaveat,
  STORED_FIGURES_CAVEAT,
  type RepresentativeFallbackReason,
} from '../../shared/representative-answer';
import type { AnswerProvenance } from '../../shared/answer-provenance';
import { parseServedModel, startBenchmarkRun } from '../lib/benchmark-runner';
import {
  BENCHMARK_CASE_CATALOG,
  CANONICAL_SUITE,
  canonicalSuite,
  resolveSuiteCases,
} from '../lib/benchmark-suite';
import { DEPLOYMENT_SETTINGS_DDL, resolveExperimentId, resolveJudgeEndpoint } from '../lib/app-settings';
import { answerRatherThanExit } from '../lib/handler-failures';
import { withDeadline } from '../lib/deadline';
import { consumeServingStream, TruncatedStreamError, type StageSink } from '../lib/serving-stream';
import { createAskResponder } from '../lib/ask-responder';
import {
  accessDecisionFor,
  accessModeFor,
  appServicePrincipal,
  declareAccessMode,
  executionIdentityColumns,
  isAccessMode,
  observedServingPrincipal,
  recordVerifiedAccess,
  rememberServingPrincipal,
} from './execution-identity';
import {
  diagnoseUserToken,
  entitlementLookupVia,
  forwardedUserToken,
  genieSpaceProbeFor,
  isVerified,
  limitsOfThisCheck,
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
  };
  server: {
    extend(fn: (app: Application) => void): void;
  };
  /** Overridable so tests can assert the exact JSON that reaches Model Serving. */
  servingTransport?: ServingTransport;
}

/** Everything the app stores into, in the order it is created. */
export const schemaStatements = [
  `CREATE SCHEMA IF NOT EXISTS player_insights`,
  `CREATE TABLE IF NOT EXISTS player_insights.conversations (id TEXT PRIMARY KEY, user_email TEXT NOT NULL, title TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS player_insights.messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, response_json JSONB, trace_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Under whose authority each turn ran. Added by ALTER rather than folded into
  // the CREATE above: `CREATE TABLE IF NOT EXISTS` is a no-op against an existing
  // table, so a column added there would reach fresh deployments only. Nullable,
  // because turns recorded before these columns existed have no answer and
  // backfilling one would invent an audit trail.
  `ALTER TABLE player_insights.messages
     ADD COLUMN IF NOT EXISTS app_principal TEXT,
     ADD COLUMN IF NOT EXISTS serving_principal TEXT,
     ADD COLUMN IF NOT EXISTS serving_principal_observed_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS access_mode TEXT`,
  `CREATE TABLE IF NOT EXISTS player_insights.attachments (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, user_email TEXT NOT NULL,
    filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    extracted_text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS player_insights.benchmark_suites (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
    cases_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS player_insights.benchmark_runs (id TEXT PRIMARY KEY, suite_id TEXT NOT NULL, user_email TEXT NOT NULL,
    status TEXT NOT NULL, metrics_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS player_insights.feedback (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, user_email TEXT NOT NULL,
    sentiment TEXT, usefulness INTEGER, comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `INSERT INTO player_insights.benchmark_suites (id, name, description, cases_json)
   VALUES ('poc-benchmark', 'POC benchmark suite',
   'Quality, latency, ambiguity, visualization, and access-boundary checks',
   '[{"id":"player-count"},{"id":"dictionary-lookup"},{"id":"cross-title"},{"id":"data-quality"},{"id":"visualization"},{"id":"access-boundary"}]'::jsonb)
   ON CONFLICT (id) DO NOTHING`,
  // Declared here rather than in the module that reads it: preflight and the
  // grant script find the schema name by parsing this file, so a second CREATE
  // elsewhere would put those tables outside what they check.
  DEPLOYMENT_SETTINGS_DDL,
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
const SourceSchema = z.looseObject({ name: z.string(), freshness: z.string() });
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
const TraceSchema = z.looseObject({
  id: z.string(),
  totalMs: z.number(),
  toolCalls: z.number(),
  stages: z.array(StageSchema),
});
const LiveAnswerSchema = z.looseObject({
  id: z.string().min(1),
  takeaway: z.string().min(1),
  narrative: z.string().min(1),
  figures: z.array(FigureSchema),
  // Defaulted rather than required, so the agent and the app can ship separately:
  // an endpoint still running the previous agent returns no `charts` key at all,
  // and requiring it would drop every live answer back to a representative one.
  charts: z.array(ChartSchema).default([]),
  sources: z.array(SourceSchema),
  caveats: z.array(z.string()),
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

const conversations = [
  { id: 'conv-demo', title: 'Active players by title', updated_at: new Date().toISOString() },
  {
    id: 'conv-quality',
    title: 'Player activity data quality',
    updated_at: new Date(Date.now() - 86400000).toISOString(),
  },
  {
    id: 'conv-engagement',
    title: 'Cross-title engagement',
    updated_at: new Date(Date.now() - 5 * 86400000).toISOString(),
  },
];

const runs = [
  {
    id: 'run-1042',
    kind: 'conversation',
    conversation_id: 'conv-demo',
    prompt: 'Compare active players by title over the last 30 days.',
    // A neutral persona: these seed rows are what a user sees before any real
    // run is stored, so a real name would read as a colleague's own run.
    stakeholder: 'POC Tester',
    status: 'complete',
    duration_ms: 6840,
    rating: 5,
    created_at: new Date().toISOString(),
  },
  {
    id: 'run-1041',
    kind: 'conversation',
    conversation_id: 'conv-engagement',
    prompt: 'Compare engagement by title and platform',
    stakeholder: 'POC Tester',
    status: 'partial',
    duration_ms: 9210,
    rating: 4,
    created_at: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: 'run-1040',
    kind: 'conversation',
    conversation_id: 'conv-quality',
    prompt: 'Check null ratios in player activity',
    stakeholder: 'POC Tester',
    status: 'complete',
    duration_ms: 5120,
    rating: 5,
    created_at: new Date(Date.now() - 86400000).toISOString(),
  },
];

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
           m.response_json->'trace' AS trace, c.user_email
    FROM player_insights.messages m
    JOIN player_insights.conversations c ON c.id = m.conversation_id
    -- A plan proposal has no trace and is not yet a run; an answer always has one.
    WHERE m.role = 'assistant' AND jsonb_typeof(m.response_json->'trace') = 'object'
      AND c.user_email = $2
  )
  SELECT a.id, 'conversation' AS kind, a.conversation_id,
         COALESCE((SELECT u.content FROM player_insights.messages u
            WHERE u.conversation_id = a.conversation_id AND u.role = 'user'
              AND u.content <> $1 AND u.created_at <= a.created_at
            ORDER BY u.created_at DESC LIMIT 1),
           (SELECT c2.title FROM player_insights.conversations c2 WHERE c2.id = a.conversation_id)
         ) AS prompt,
         a.user_email AS stakeholder,
         CASE
           WHEN jsonb_path_exists(a.trace, '$.stages[*] ? (@.status == "failed")') THEN 'failed'
           WHEN jsonb_path_exists(a.trace, '$.stages[*] ? (@.status == "partial")') THEN 'partial'
           ELSE 'complete'
         END AS status,
         ROUND((a.trace->>'totalMs')::numeric)::int AS duration_ms,
         -- The caller's own rating. The feedback route accepts any message id,
         -- so without the user_email predicate this would show whatever score
         -- anyone else submitted against the same answer.
         (SELECT f.usefulness FROM player_insights.feedback f
          WHERE f.message_id = a.id AND f.user_email = $2 AND f.usefulness IS NOT NULL
          ORDER BY f.created_at DESC LIMIT 1) AS rating,
         a.created_at
  FROM answers a
  UNION ALL
  SELECT b.id, 'benchmark' AS kind, NULL AS conversation_id,
         b.metrics_json->>'prompt' AS prompt,
         CASE WHEN b.user_email = $2 THEN b.user_email ELSE '${SHARED_RUN_OWNER}' END AS stakeholder,
         b.status,
         (b.metrics_json->>'duration_ms')::int AS duration_ms,
         -- The caller's own rating, from the same table the conversation half
         -- reads. feedback.message_id carries no foreign key and the feedback
         -- route accepts any id, so a run id works here unchanged.
         (SELECT f.usefulness FROM player_insights.feedback f
          WHERE f.message_id = b.id AND f.user_email = $2 AND f.usefulness IS NOT NULL
          ORDER BY f.created_at DESC LIMIT 1) AS rating,
         b.created_at
  FROM player_insights.benchmark_runs b
  ORDER BY created_at DESC
  LIMIT 200`;

export function representativeAnswer(prompt: string) {
  const lower = prompt.toLowerCase();
  const quality = lower.includes('null') || lower.includes('quality');
  return discloseAnswerProvenance({
    id: `msg-${Date.now()}`,
    mode: 'representative',
    // Nothing on this answer was queried, wherever it ends up being served
    // from. The ask route overrides it to 'mixed' on the one path that keeps
    // this body and replaces the words on top of it.
    provenance: 'stored' as AnswerProvenance,
    takeaway: quality
      ? 'Player activity is analysis-ready, with expected nulls and cross-label markings visible for review.'
      : REPRESENTATIVE_TAKEAWAY,
    narrative: quality
      ? 'Session duration is null for 1.84% of gameplay records, and 1.20% of sessions are explicitly marked CROSS_LABEL_BLOCK. What that marking excludes from is a property of the views a deployment grants, not of this app.'
      : REPRESENTATIVE_NARRATIVE,
    figures: REPRESENTATIVE_FIGURES,
    sources: buildSources(),
    caveats: quality
      ? [
          // Scoped to the stored answer for the reason REPRESENTATIVE_CAVEATS is.
          // The narrative above quotes two rates to two decimal places, measured
          // off the demo seed; unqualified, that reads as a measurement of
          // whatever schema this deployment is pointed at.
          'The null and blocked-row rates in this stored answer are synthetic quality ' +
            'scenarios, not measurements of this deployment.',
        ]
      : REPRESENTATIVE_CAVEATS,
    sql: buildSql(),
    trace: {
      id: `trace-${Date.now()}`,
      totalMs: 6840,
      toolCalls: 6,
      stages: [
        {
          id: 'plan',
          name: 'Interpreted the question',
          kind: 'agent',
          start: 0,
          duration: 620,
          status: 'complete',
          calls: 1,
          input: prompt,
          output: 'Compare 30-day active players by label and title; preserve label scope.',
        },
        {
          id: 'discover',
          name: 'Found the right data',
          kind: 'agent',
          start: 620,
          duration: 1820,
          status: 'complete',
          calls: 2,
          input: 'active-player metric, title activity, and label scope',
          output: 'Selected silver_gameplay_activity and dictionary guardrails.',
        },
        {
          id: 'dictionary',
          name: 'Checked field definitions',
          kind: 'tool',
          start: 1180,
          duration: 740,
          status: 'complete',
          calls: 1,
          input: 'player_id, event_date, brand_scope_status',
          output: 'Resolved distinct-player semantics, the 30-day window, and how blocked rows are marked.',
        },
        {
          id: 'query',
          name: 'Analyzed players',
          kind: 'tool',
          start: 2440,
          duration: 2310,
          status: quality ? 'partial' : 'complete',
          calls: 1,
          input: 'Generated read-only SQL',
          output: quality ? 'Returned partial latest partition with warning.' : 'Returned 5 title-level aggregates.',
        },
        {
          id: 'quality',
          name: 'Checked answer quality',
          kind: 'tool',
          start: 4750,
          duration: 930,
          status: 'complete',
          calls: 1,
          input: 'Sources, null ratios, freshness',
          output: 'Groundedness 0.94; latest day marked partial.',
        },
        {
          id: 'synthesis',
          name: 'Prepared the answer',
          kind: 'agent',
          start: 5680,
          duration: 1160,
          status: 'complete',
          calls: 1,
          input: 'Verified figures and caveats',
          output: 'Answer summary, chart, sources, and caveats.',
        },
      ],
    },
  });
}

/**
 * The one way this app is allowed to put invented figures in front of a reader.
 *
 * `representativeAnswer` on its own is the demo content; this is the decision
 * to serve it in place of an answer nobody got, together with the reason. Ask
 * "why was this customer shown numbers that were never queried" and the answer
 * is a `representativeFallback(` call site, findable by grepping for it, each
 * one a statement somebody wrote rather than a value something inherited.
 *
 * The reason travels in the caveats rather than in a new field: the client
 * already lifts a `DEGRADED_ANSWER_MARKER` caveat out of the list and renders
 * it in red above the figures, and the caveats are stored in `response_json`,
 * so the attribution survives into the conversation history and the Run
 * Explorer without a schema change.
 */
export function representativeFallback(prompt: string, reason: RepresentativeFallbackReason) {
  const answer = representativeAnswer(prompt);
  return {
    ...answer,
    mode: 'representative' as const,
    // First, ahead of REPRESENTATIVE_ANSWER_CAVEAT, which says the same thing
    // more weakly: that one is derived from the shape of the trace id, this one
    // is the route reporting what it just did and what went wrong.
    caveats: [representativeFallbackCaveat(reason), ...answer.caveats],
  };
}

/**
 * Either thing `POST /api/insights/ask` can end up serving.
 *
 * Named so the variable that holds it can be declared without a value. See the
 * declaration in the ask handler for why that matters.
 */
type ServedAnswer = (LiveAnswer & { mode: 'live' }) | ReturnType<typeof representativeAnswer>;

/** The shape of a payload, for a log line and a caveat, without its contents. */
function describePayloadShape(value: unknown): string {
  if (value === null || typeof value !== 'object') return `the endpoint returned ${typeof value}`;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length > 0 ? `top-level keys: ${keys.join(', ')}` : 'the endpoint returned an empty object';
}

function representativeMessages(conversationId: string) {
  const prompts: Record<string, string> = {
    'conv-demo': 'Compare active players by title over the last 30 days.',
    'conv-quality': 'Check null ratios in the latest player activity data.',
    'conv-engagement': 'Compare cross-title engagement across our leading games.',
  };
  const prompt = prompts[conversationId];
  if (!prompt) return [];
  const answer = representativeAnswer(prompt);
  return [
    {
      id: `seed-user-${conversationId}`,
      role: 'user',
      content: prompt,
      response_json: null,
      trace_id: null,
      created_at: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      id: answer.id,
      role: 'assistant',
      content: answer.narrative,
      response_json: answer,
      trace_id: answer.trace.id,
      created_at: new Date().toISOString(),
    },
  ];
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
  sources: z.array(SourceSchema),
  trace: TraceDetailSchema.nullable(),
  /** Tool-tagged stages. The agent's own call counter is `trace.toolCalls`. */
  toolStages: z.array(ToolStageSchema),
  mlflow: MlflowReferenceSchema.nullable(),
  benchmark: BenchmarkMetricsSchema.nullable(),
  /** Plain-language reason the panes can render when `state` is 'no-trace'. */
  note: z.string(),
  undeclaredKeys: z.array(z.string()),
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

function workspaceHost() {
  const raw = (process.env.DATABRICKS_HOST ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
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
 */
export function discloseAnswerProvenance<T extends { caveats: string[]; trace: { id: string } }>(answer: T
): T {
  if (MLFLOW_TRACE_ID.test(answer.trace.id)) return answer;
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
export function discloseExecutingIdentity<T extends { caveats: string[]; trace: { id: string } }>(answer: T,
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

function runWithoutTrace(identity: RunTraceIdentity, note: string, mode: RunTrace['mode'] = null): RunTrace {
  return {
    ...identity,
    state: 'no-trace',
    mode,
    takeaway: '',
    narrative: '',
    sql: '',
    sources: [],
    trace: null,
    toolStages: [],
    mlflow: null,
    benchmark: null,
    note,
    undeclaredKeys: [],
  };
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
  const mode = record.mode === 'representative' ? 'representative' : record.mode === 'live' ? 'live' : null;
  if (record.type === 'plan') {
    return runWithoutTrace(identity,
      'This turn proposed an analysis plan and the plan was never approved, so no run was executed and there is no trace.',
      mode
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
        trace: asked.data,
        toolStages: toolStagesFromTrace(asked.data.stages),
        mlflow: mlflowReference(asked.data.id, experimentId),
        benchmark: null,
        note: 'This turn ended in a question back to the user rather than an answer, so the stages stop where it asked.',
        undeclaredKeys: [],
      };
    }
    return runWithoutTrace(identity,
      'This turn asked the user for a missing detail, and stored no trace of the steps that led there.',
      mode
    );
  }

  const answer = LiveAnswerSchema.safeParse(record);
  // A stored answer that no longer satisfies the whole contract can still hold a
  // perfectly good trace. Losing it to a schema mismatch would put the panes back
  // where they started, so the trace is read on its own before giving up.
  const trace = answer.success
    ? TraceDetailSchema.safeParse(answer.data.trace)
    : TraceDetailSchema.safeParse(record.trace);
  if (!trace.success) {
    return runWithoutTrace(identity, 'This run stored a response with no trace, so there are no stages to show.', mode);
  }

  return {
    ...identity,
    state: 'trace',
    mode,
    takeaway: typeof record.takeaway === 'string' ? record.takeaway : '',
    narrative: typeof record.narrative === 'string' ? record.narrative : '',
    sql: typeof record.sql === 'string' ? record.sql : '',
    sources: answer.success ? answer.data.sources : [],
    trace: trace.data,
    toolStages: toolStagesFromTrace(trace.data.stages),
    mlflow: mlflowReference(trace.data.id, experimentId),
    benchmark: null,
    note:
      mode === 'representative'
        ? 'This run was answered offline from the representative dataset, so these are reference stages rather than a live agent run.'
        : '',
    undeclaredKeys: answer.success ? undeclaredAnswerKeys(answer.data) : [],
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
    ...runWithoutTrace(identity,
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
 * The counterpart of the two above, for the representative rows `/api/runs`
 * serves when it cannot serve stored ones.
 *
 * `reason` is required rather than defaulted because the two conditions have
 * opposite remedies and the note is rendered verbatim. Defaulting it to an
 * outage makes a healthy but empty store report a database problem that does
 * not exist, in contradiction of the runs list beside it.
 */
export function representativeRunTrace(runId: string,
  reason: 'unreachable' | 'not-stored'
): RunTrace | null {
  const run = runs.find((candidate) => candidate.id === runId);
  if (!run) return null;
  const answer = representativeAnswer(run.prompt);
  const trace = TraceDetailSchema.parse(answer.trace);
  return {
    runId: run.id,
    kind: 'conversation',
    state: 'trace',
    mode: 'representative',
    conversationId: run.conversation_id,
    createdAt: run.created_at,
    prompt: run.prompt,
    stakeholder: run.stakeholder,
    takeaway: answer.takeaway,
    narrative: answer.narrative,
    sql: answer.sql,
    sources: answer.sources,
    trace,
    toolStages: toolStagesFromTrace(trace.stages),
    mlflow: null,
    benchmark: null,
    note:
      reason === 'unreachable'
        ? 'Lakebase is unavailable, so this is the representative reference trace rather than a stored run.'
        : 'No stored run has this id, so this is the representative reference trace. Ask a question, ' +
          'or run a benchmark suite, and your own runs will be stored here.',
    undeclaredKeys: [],
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
         COALESCE((SELECT u.content FROM player_insights.messages u
            WHERE u.conversation_id = m.conversation_id AND u.role = 'user'
              AND u.content <> $2 AND u.created_at <= m.created_at
            ORDER BY u.created_at DESC LIMIT 1),
           c.title
         ) AS prompt
  FROM player_insights.messages m
  JOIN player_insights.conversations c ON c.id = m.conversation_id
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
  FROM player_insights.benchmark_runs b
  WHERE b.id = $1`;

// ---------------------------------------------------------------------------
// Preflight

const PreflightStatus = z.enum(['ok', 'failed', 'unverified']);
const PreflightRemedySchema = z.looseObject({
  kind: z.enum(['sql', 'cli']),
  statement: z.string(),
  note: z.string(),
});
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
export type PreflightReport = z.infer<typeof PreflightReportSchema> & {
  counts: { ok: number; failed: number; unverified: number };
  /** 'agent' when the endpoint answered; 'app' when this server is all that ran. */
  source: 'agent' | 'app';
};

/**
 * The body that asks the endpoint to check its dependencies.
 *
 * The flag stays a bare `true` when there is no candidate, so a version logged
 * before any of this existed receives the same bytes it always did.
 */
export function buildPreflightServingBody(candidate?: Record<string, unknown>
): Record<string, unknown> {
  // The agent short-circuits on this flag before it looks for a question, but
  // a user turn is sent anyway so the payload stays a valid agent request.
  const preflight =
    candidate && Object.keys(candidate).length > 0 ? { candidate } : true;
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

/** The app's own service principal, as the `permissions update` CLI names it. */
function appPrincipal() {
  return process.env.DATABRICKS_CLIENT_ID?.trim() || '<app-service-principal>';
}

/**
 * Whether this server can invoke the agent: the one link in the chain the
 * agent cannot report on, because a failure here is why it never ran.
 */
export function agentEndpointCheck(endpointName: string,
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
            note:
              'The app service principal calls the agent endpoint. It is a workspace ' +
              'object, so this CLI call is the equivalent of a SQL GRANT.',
          }),
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
    super('This request carries no end-user identity. Databricks Apps sets x-forwarded-email on ' +
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
const IDENTITY_OPTIONAL_ROUTES = new Set(['/api/preflight', '/api/storage', '/api/settings']);

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
    console.error(`[identity] REFUSED ${req.method} ${req.path}: no x-forwarded-email on the request, so there is ` +
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
    console.error(`[rail] ${SHARED_CONVERSATION_RAIL_ENV} is set to ${JSON.stringify(resolution.raw)}, which is not a ` +
        'value this app recognises, so it has been IGNORED and the rail stays scoped to each user. ' +
        'The only value that turns sharing on is "true". Nothing is broken and nothing is exposed: ' +
        'but if a shared rail was intended, it is not on.'
    );
    return;
  }
  if (resolution.shared) {
    console.warn(`[rail] SHARED CONVERSATION RAIL IS ON (${SHARED_CONVERSATION_RAIL_ENV}=${JSON.stringify(resolution.raw)}). ` +
        'Every signed-in user can see, and open, every other user\'s conversations and the questions and ' +
        'answers inside them. This is a deliberate setting for a shared evaluation workspace and it is not ' +
        'the default. Deleting, asking and uploading remain scoped to the owner.'
    );
    return;
  }
  console.log(`[rail] Conversations are scoped to each user (${SHARED_CONVERSATION_RAIL_ENV} ` +
      `${resolution.reason === 'unset' ? 'is unset' : `= ${JSON.stringify(resolution.raw)}`}).`
  );
}

/**
 * The rail read, and the read of one conversation's messages.
 */
function conversationListQuery(email: string) {
  return sharedRail.shared
    ? {
        sql: 'SELECT id, title, updated_at, user_email FROM player_insights.conversations ORDER BY updated_at DESC',
        params: [] as unknown[],
      }
    : {
        sql:
          'SELECT id, title, updated_at, user_email FROM player_insights.conversations ' +
          'WHERE user_email = $1 ORDER BY updated_at DESC',
        params: [email] as unknown[],
      };
}

function conversationMessagesQuery(conversationId: string, email: string) {
  // `c.user_email AS asked_by` rather than a column on the message: the ask
  // route refuses a conversation somebody else owns, so the owner IS the asker
  // and storing it twice would be the same fact in two places. The join was
  // already here for the tenancy predicate, so the fourth identity costs a
  // column in the projection and nothing in the write path.
  const select = `SELECT m.id, m.role, m.content, m.response_json, m.trace_id, m.created_at,
                m.app_principal, m.serving_principal, m.serving_principal_observed_at,
                m.access_mode, c.user_email AS asked_by
         FROM player_insights.messages m
         JOIN player_insights.conversations c ON c.id = m.conversation_id`;
  return sharedRail.shared
    ? {
        sql: `${select}\n         WHERE m.conversation_id = $1\n         ORDER BY m.created_at`,
        params: [conversationId] as unknown[],
      }
    : {
        sql: `${select}\n         WHERE m.conversation_id = $1 AND c.user_email = $2\n         ORDER BY m.created_at`,
        params: [conversationId, email] as unknown[],
      };
}

function isEndpointError(record: Record<string, unknown>) {
  const status = record.status ?? record.statusCode;
  return (Boolean(record.error) ||
    typeof record.error_code === 'string' ||
    (typeof status === 'number' && status >= 400)
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
      console.warn('[serving] Answer contains fields the app does not read:',
        undeclared.join(', ')
      );
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
      console.warn('[serving] Endpoint asked for clarification in a shape the app cannot read:',
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
    .filter((row): row is HistoryRow & { role: 'user' | 'assistant'; content: string } =>
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
    executionIdentity: appServicePrincipal() ?? 'Player Insights service principal',
    // Was a literal, which was true of every deployment right up until the gate
    // gave a user something else to choose. It is now whatever this server last
    // established for this user, and established is the operative word: see
    // `declareAccessMode`, which refuses to take `user-verified` on trust.
    executionMode: accessModeFor(signedInAs),
    accessDecision: accessDecisionFor(signedInAs),
    // The identity that actually executes Genie and SQL, which is NOT the one
    // above. Null until a preflight has reported it, and that null is load
    // bearing: the endpoint's principal is only knowable from inside the
    // endpoint, so anything else here would be a guess at the hop the whole
    // feature exists to name.
    servingPrincipal: observedServingPrincipal(),
    // Reported so a rail carrying other people's conversations says so on the
    // page rather than only in the boot log. A widened scope that is only
    // visible to whoever reads stdout is the silent kind of configuration this
    // app keeps getting bitten by.
    sharedConversationRail: sharedConversationRail(),
  };
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
export function createServingTransport(resolveClient: (userToken?: string) => Promise<ServingApiClient>
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
      // The endpoint answered and then the stream died before the answer
      // reached us. The run itself has been observed completing normally and
      // recording an OK trace when this happens, so the work is not in doubt,
      // only the transport is. Asking again without streaming is therefore
      // worth one attempt, where re-asking an unreachable endpoint would not
      // be. The alternative is what the user saw: a representative answer
      // presented over a question that really did run.
      console.warn(`[serving] ${error.message} Asking again without streaming, which does not ` +
          'depend on the connection surviving the whole run.'
      );
      // `stream: true` lives inside the body, so it has to come back out or the
      // endpoint streams into a caller no longer reading events.
      const blocking = { ...(payload as Record<string, unknown>), stream: false };
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
}: AskServingInputs): Record<string, unknown> {
  const custom_inputs: Record<string, unknown> = { conversation_id: conversationId };
  if (approvedPlanId) custom_inputs.approved_plan_id = approvedPlanId;
  if (executePlan !== undefined) custom_inputs.execute_plan = executePlan;
  if (attachmentText) custom_inputs.attachment_text = attachmentText;

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
export async function invokeServing(appkit: InsightsAppKit,
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
  return withDeadline(transport({ path: servingInvocationPath(endpointName), payload, onStage, userToken }),
    timeoutMs,
    `The agent endpoint did not answer within ${timeoutMs} ms. The call was abandoned rather than ` +
      'cancelled, so it may still be running at the endpoint.'
  );
}

/**
 * The caveat an answer carries when the question ran as the application rather
 * than as the person who asked it.
 *
 * Exported because the disclosure has to be assertable. A fallback nobody can
 * see is the thing being fixed here, not a lesser version of it: the whole
 * value of running as the user is that an answer cannot show them data they
 * are not entitled to, and an answer that quietly reverted to the service
 * principal makes exactly that claim while not honouring it.
 */
export const SERVICE_PRINCIPAL_FALLBACK_CAVEAT =
  'This answer ran as the application, not as you. Your own permissions were not what the ' +
  'warehouse enforced, so it may include data your account cannot read directly.';

/**
 * Whether a failed invocation is the endpoint rejecting the identity, as
 * opposed to failing at the question.
 */
function isIdentityRejection(error: unknown): boolean {
  const status = (error as { statusCode?: number; status?: number })?.statusCode ??
    (error as { status?: number })?.status;
  if (status === 401 || status === 403) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /\b(401|403)\b|permission denied|unauthenticated|unauthorized|invalid access token/i.test(message
  );
}

/**
 * Invoke the endpoint as the signed-in user, falling back to the app.
 */
export async function invokeServingForUser(appkit: InsightsAppKit,
  payload: Record<string, unknown>,
  userToken: string | null,
  onStage?: StageSink,
  timeoutMs: number = SERVING_INVOKE_TIMEOUT_MS
): Promise<{ result: unknown; ranAsUser: boolean }> {
  if (!userToken) {
    return { result: await invokeServing(appkit, payload, onStage, timeoutMs), ranAsUser: false };
  }
  try {
    return {
      result: await invokeServing(appkit, payload, onStage, timeoutMs, userToken),
      ranAsUser: true,
    };
  } catch (error) {
    if (!isIdentityRejection(error)) throw error;
    console.warn(`[identity] The endpoint refused the forwarded user token (${
        error instanceof Error ? error.message : String(error)
      }). Retrying as the application, and the answer will say so.`
    );
    return { result: await invokeServing(appkit, payload, onStage, timeoutMs), ranAsUser: false };
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
 * A short, log-safe name for a statement: its verb and the object it touches.
 *
 * DDL is named as well as DML, because the schema statements are logged one by
 * one when they fail and "CREATE statement" identifies none of the eleven.
 * `TABLE`/`SCHEMA` are matched with their optional `IF NOT EXISTS` so a
 * refused `ALTER TABLE player_insights.messages` reads as exactly the object
 * somebody has to go and look at.
 */
function describeSql(sql: string) {
  const collapsed = sql.replace(/\s+/g, ' ').trim();
  const verb = collapsed.split(' ', 1)[0]?.toUpperCase() ?? 'QUERY';
  const object = /(?:FROM|INTO|UPDATE|TABLE(?:\s+IF\s+NOT\s+EXISTS)?|SCHEMA(?:\s+IF\s+NOT\s+EXISTS)?)\s+(player_insights(?:\.\w+)?)/i.exec(collapsed
  )?.[1];
  return object ? `${verb} ${object}` : `${verb} statement`;
}

/**
 * Answer a read route with stored rows, or with representative rows while
 * saying so, in the logs, and in headers the browser can act on.
 */
async function respondWithStored(appkit: InsightsAppKit,
  res: Response,
  route: string,
  sql: string,
  params: unknown[],
  representative: unknown[]
) {
  const read = await readStored(appkit, route, sql, params);
  const { rows, substitution } = chooseRows(route, read, representative);
  markResponse(res, substitution);
  res.json(rows);
}

/** One statement of {@link schemaStatements} that the database refused. */
export interface SchemaStatementFailure {
  /** 1-based, so it reads the same way as the log line and the list above. */
  position: number;
  /** `describeSql` of the statement: the verb and the object it touches. */
  label: string;
  message: string;
  /**
   * Postgres's SQLSTATE, when it gave one.
   *
   * Kept because the summary below has to tell two failures apart that read
   * identically in prose: a statement refused because the app's role does not
   * own the table it is altering, and a statement refused because the role has
   * no privilege on the schema at all. The first is the harmless boot-time
   * no-op this function's own docstring describes; the second is a deployment
   * whose one manual setup step was never performed. Only the second has a
   * remedy worth printing, and printing it for the first would train the
   * reader to skip it.
   */
  code: string;
}

/**
 * Create everything the app stores into, and say precisely what did not.
 *
 * Every statement is attempted, including the ones after a failure. The loop
 * used to `break`, which turned one refusal into seven statements that
 * silently never ran. That is not hypothetical: on this database every table
 * in `player_insights` is owned by the developer who first created it rather
 * than by the app's own Postgres role, and Postgres checks ownership before it
 * evaluates `IF NOT EXISTS`, so `ALTER TABLE player_insights.messages ADD
 * COLUMN IF NOT EXISTS ...` is refused at every single boot even though the
 * columns are already there and the statement would change nothing. A no-op
 * took the four remaining CREATEs, the benchmark seed and both settings tables
 * down with it. Nothing was broken only because those objects already existed
 * here; on a fresh deployment they would not, and the app would come up
 * half-built having said one line about it.
 */
export async function applySchema(appkit: InsightsAppKit): Promise<SchemaStatementFailure[]> {
  const failures: SchemaStatementFailure[] = [];
  const total = schemaStatements.length;

  for (const [index, statement] of schemaStatements.entries()) {
    try {
      await appkit.lakebase.query(statement);
    } catch (error) {
      const rawCode = (error as { code?: unknown }).code;
      const failure = {
        position: index + 1,
        label: describeSql(statement),
        message: (error as Error).message,
        code: typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : '',
      };
      failures.push(failure);
      const remaining = total - failure.position;
      console.error(`[lakebase] SCHEMA STATEMENT ${failure.position} of ${total} FAILED (${failure.label}): ` +
          `${failure.message}. ` +
          (remaining > 0
            ? `The remaining ${remaining} statement(s) still run: one refusal no longer stops them. `
            : '') +
          `If the object this statement maintains is already in place, nothing changed; if it is not, ` +
          `everything that reads it will fail.`
      );
    }
  }

  // The DDL is the app's first contact with Postgres, so it is also the first
  // place a deployment that never ran the grant script can be caught, earlier
  // than any route read, and early enough that the line is still near the top
  // of a fresh deploy's log where somebody is actually looking. A privilege
  // error here is unambiguous in a way it is not later: these statements are
  // issued by the app itself, as itself, against its own schema.
  const denied = failures.filter(isGrantDenialFailure);
  const grantRemedy = denied.length > 0 ? ` ${GRANT_DENIED_LOG_REMEDY}` : '';

  if (failures.length === total) {
    // Nothing was accepted, which on this list means the store never answered:
    // the first statement is `CREATE SCHEMA IF NOT EXISTS`, which succeeds
    // against any reachable database the app can write to. This is the only
    // case in which the old wording was true, and it keeps it.
    //
    // Unless it was refused rather than unanswered: a role with no CREATE on
    // the database fails that first statement too, and then every one after it,
    // which looks identical from the count alone. Saying "the store never
    // answered" of a store that answered eleven times to say no is the same
    // conflation this whole function was rewritten to remove.
    console.error(`[lakebase] SCHEMA SETUP ${denied.length === total ? 'REFUSED' : 'FAILED'}: all ${total} statements ` +
        `were ${denied.length === total ? 'refused by Postgres on privileges' : 'refused'}, so the app is ` +
        `starting without a usable store and every read below will serve representative data. First error ` +
        `(${failures[0].label}): ${failures[0].message}${grantRemedy}`
    );
  } else if (failures.length > 0) {
    // Deliberately not the sentence above. Some statements were accepted, so
    // the store is reachable and writable and the reads below will use it,
    // claiming otherwise sends whoever reads this log looking for a database
    // outage that is not happening, and teaches them to distrust the line that
    // means it.
    console.error(`[lakebase] SCHEMA SETUP INCOMPLETE: ${failures.length} of ${total} statements failed ` +
        `(${failures.map((failure) => failure.label).join(', ')}); the other ${total - failures.length} ` +
        `succeeded, so the store answered and reads and writes below will use it. This is NOT the app ` +
        `falling back to representative data. What is not established is whatever those statements ` +
        `maintain, check the objects named above exist and carry the columns this version expects. ` +
        `The usual cause on a database that already has these tables is ownership: ALTER requires the ` +
        `app's Postgres role to own the table, IF NOT EXISTS does not exempt it, because Postgres refuses ` +
        `on ownership before it decides the statement is a no-op. See scripts/grant-app-db-access.mjs.` +
        // Appended only when Postgres said `insufficient_privilege` and friends,
        // so the reader can tell "this is the harmless ownership no-op above"
        // from "the grant was never made". Without the split, the sentence
        // pointing at the script printed on every boot of a healthy deployment
        // and stopped meaning anything.
        (grantRemedy
          ? ` ${denied.length} of those refusals ${denied.length === 1 ? 'is' : 'are'} a privilege ` +
            `denial (${[...new Set(denied.map((failure) => failure.code))].join(', ')}) rather than the ` +
            `ownership no-op, which means the grant is missing rather than merely narrow.${grantRemedy}`
          : '')
    );
  }

  return failures;
}

export async function setupInsightsRoutes(appkit: InsightsAppKit) {
  await applySchema(appkit);

  // Reads are what the pages depend on, and a `CREATE TABLE IF NOT EXISTS` that
  // succeeds says nothing about whether the store still answers minutes later.
  // The watchdog dates an outage and its recovery even when nobody is looking.
  startLakebaseWatchdog(appkit);

  // Said at boot rather than left to be discovered from row contents. A
  // development session owns everything it writes as one synthetic address, so
  // anyone reading this database later needs to know which rows came from a
  // laptop, and anyone running the app needs to know they are not seeing a real
  // per-user view.
  // Resolved once, here, and announced the way the identity mode below is. The
  // failure this guards against is a flag that never reaches the container:
  // read at boot and logged, an app that is not sharing says so in its own
  // startup output, so "is it on?" is answerable from the app logs alone.
  announceSharedConversationRail(resolveSharedConversationRail(process.env[SHARED_CONVERSATION_RAIL_ENV]));

  if (isDeployed()) {
    console.log('[identity] Requiring x-forwarded-email on user-scoped routes; unidentified requests are refused with 401.'
    );
  } else if (process.env.NODE_ENV !== 'test') {
    // Every test boots the app, and a warning on each would be noise nobody
    // reads. A developer running the server is the audience for this.
    console.warn(`[identity] DEVELOPMENT MODE: requests without x-forwarded-email act as ${DEVELOPMENT_IDENTITY}, and ` +
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

    app.get('/api/identity', (req, res) => {
      res.json(identityPayload(req));
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
    app.post('/api/access-mode', async (req, res) => {
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
      const decision = declareAccessMode(email,
        requested,
        requested === 'skipped'
          ? 'The user skipped the access gate. Nothing was checked, and questions execute as the service principals exactly as they would have anyway.'
          : 'The user accepted service-principal execution, which is what the app does by design.'
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
                    note:
                      'Both states present identically from here (no token arrives either ' +
                      'way), so both steps are listed. Neither is a permission you are ' +
                      'missing.',
                  },
                }
              : {}),
          },
          mode: accessModeFor(email),
        });
        return;
      }

      // The app's own warehouse, from its app resource. The agent's table list
      // and Genie space ids are NOT available: both only ever existed in the
      // MLflow model artifact, reported by dependency checks the endpoint no
      // longer runs. So this checks whether the user can run a statement at
      // all, which is the failure people actually hit in a fresh workspace,
      // and `notChecked` carries what it could not establish.
      const warehouseId = appWarehouseId();
      const tables: readonly string[] = [];
      const genieSpaces: readonly { id: string; label: string }[] = [];
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
      const outcome = await verifyAccess({
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
        console.warn(`[access] ${email} not verified: ${
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
      const decision = recordVerifiedAccess(email, verificationSummary(outcome, serving?.id ?? null));
      console.log(`[access] ${email} → user-verified on warehouse ${warehouseId} (${outcome.ok} tables)`);
      res.json({ verified: true, ...outcome, decision, servingPrincipal: serving });
    });

    app.get('/api/preflight', async (_req, res) => {
      const endpointName = process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? '';
      let raw: unknown;
      try {
        raw = await invokePreflight(appkit);
      } catch (error) {
        const message = (error as Error).message;
        console.warn('[preflight] Agent endpoint could not be invoked:', message);
        res.status(503).json({
          ...withStorageCheck(preflightFailure(agentEndpointCheck(endpointName, {
                status: 'failed',
                detail: 'The app could not invoke the agent endpoint, so nothing behind it was checked.',
                error: message,
              }),
              'Nothing beyond the endpoint was checked, so the agent\u2019s own dependencies are unknown rather than healthy.'
            ),
            lakebaseStorageCheck()
          ),
          error: 'preflight_unavailable',
        });
        return;
      }

      const report = extractPreflightReport(raw);
      if (!report) {
        // The endpoint no longer runs dependency checks: it recognises this
        // request and answers without a report, on every version. There is
        // nothing here for an operator to fix, so this reports what the app can
        // still see for itself and offers no remedy. Re-logging the model does
        // not bring the report back. The newest version is the one that
        // retired it.
        res.status(200).json({
          ...withStorageCheck(preflightFailure(agentEndpointCheck(endpointName, {
                status: 'ok',
                detail: 'The app invoked the agent endpoint and it answered.',
              }),
              'The agent endpoint no longer reports on its dependencies. Whether a principal can ' +
                'reach a table, a warehouse or a Genie space is answered by Unity Catalog and the ' +
                'workspace, which hold the grants.'
            ),
            lakebaseStorageCheck()
          ),
          error: 'preflight_retired',
        });
        return;
      }

      // The one moment the app can learn what the endpoint runs as. The identity
      // is only visible from inside the endpoint, and the answer contract does
      // not carry it, so this report is the sole source, worth taking a note
      // from every time rather than only when something asks.
      rememberServingPrincipal(report);

      const checks = [
        agentEndpointCheck(endpointName, {
          status: 'ok',
          detail: 'The app invoked the agent endpoint and it returned a dependency report.',
        }),
        // The agent reports on what the agent can reach. Lakebase is the app's
        // own dependency, so a healthy agent must not be able to make the page
        // look green while the app is failing to read its store.
        lakebaseStorageCheck(),
        ...report.checks,
      ];
      res.json({
        ...report,
        checks,
        status: overallStatus(checks),
        counts: countChecks(checks),
        source: 'agent',
      } satisfies PreflightReport);
    });

    app.get('/api/conversations', async (req, res) => {
      const { sql, params } = conversationListQuery(userEmail(req));
      await respondWithStored(appkit, res, 'GET /api/conversations', sql, params, conversations);
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

      const ownership = await readStored(appkit,
        'DELETE /api/conversations/:id (owner)',
        'SELECT user_email FROM player_insights.conversations WHERE id = $1',
        [conversationId]
      );
      if (!ownership.available) {
        // A read that fails cannot establish ownership, and zero rows from a
        // failed read is indistinguishable from a conversation that does not
        // exist. Answering 404 here would report someone's conversation as
        // already gone during an outage.
        console.warn(`[lakebase] Conversation ${conversationId} could not be deleted: ownership unreadable (${ownership.code}).`
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
          console.warn(`[tenancy] Refused delete of conversation ${conversationId}: it belongs to another user.`
          );
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
        const feedback = await appkit.lakebase.query(`DELETE FROM player_insights.feedback
           WHERE message_id IN (SELECT id FROM player_insights.messages WHERE conversation_id = $1
           )
           RETURNING id`,
          [conversationId]
        );
        // Scoped by conversation rather than by owner, on purpose. An
        // attachment holds text extracted from an uploaded document, and one
        // left behind here would be unreachable (every read of it is scoped
        // through a conversation that no longer exists), while the document's
        // contents stayed in the store indefinitely.
        const attachments = await appkit.lakebase.query(`DELETE FROM player_insights.attachments WHERE conversation_id = $1 RETURNING id`,
          [conversationId]
        );
        const messages = await appkit.lakebase.query(`DELETE FROM player_insights.messages WHERE conversation_id = $1 RETURNING id`,
          [conversationId]
        );
        // The conversation row last, so that a failure part-way through leaves
        // the conversation listed and the delete retryable rather than leaving
        // orphaned children under an id the rail can no longer name. Every
        // statement above is keyed on the conversation id alone, so a retry
        // removes whatever the first attempt did not.
        const conversation = await appkit.lakebase.query(`DELETE FROM player_insights.conversations WHERE id = $1 AND user_email = $2 RETURNING id`,
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
        console.warn(`[lakebase] Conversation ${conversationId} could not be deleted:`,
          (error as Error).message
        );
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
      await respondWithStored(appkit,
        res,
        'GET /api/conversations/:id/messages',
        sql,
        params,
        representativeMessages(req.params.id)
      );
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
      const read = await readStored(appkit,
        'GET /api/conversations/:id/attachments',
        `SELECT id, filename, mime_type, size_bytes, created_at
         FROM player_insights.attachments
         WHERE conversation_id = $1 AND user_email = $2 ORDER BY created_at`,
        [req.params.id, userEmail(req)]
      );
      if (!read.available) {
        markResponse(res, { substituted: false, reason: 'storage_unavailable' });
        res.status(503).json({
          error: 'attachments_unavailable',
          conversationId: req.params.id,
          message:
            'The documents attached to this conversation could not be read just now, so this is not ' +
            'a list of them. Anything already attached is still attached. Try again shortly.',
        });
        return;
      }
      markResponse(res, { substituted: false, reason: null });
      res.json(read.rows);
    });

    /**
     * Attach a document to a conversation the caller owns.
     */
    app.post('/api/conversations/:id/attachments',
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
        const owner = await readStored(appkit,
          'POST /api/conversations/:id/attachments (owner)',
          'SELECT user_email FROM player_insights.conversations WHERE id = $1',
          [conversationId]
        );
        if (!owner.available) {
          console.warn(`[lakebase] Attachment for ${conversationId} was not stored: ownership unreadable (${owner.code}).`
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
          console.warn(`[tenancy] Refused attachment upload to conversation ${conversationId}: it belongs to another user.`
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
          await appkit.lakebase.query(`INSERT INTO player_insights.conversations (id, user_email, title)
             VALUES ($1,$2,'New conversation') ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
            [conversationId, email]
          );
          await appkit.lakebase.query(`INSERT INTO player_insights.attachments
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
        const result = await appkit.lakebase.query(`DELETE FROM player_insights.attachments
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
        const result = await appkit.lakebase.query(`DELETE FROM player_insights.attachments
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
      const userMessageId = crypto.randomUUID();

      // Checked before anything is written, because `messages` carries no owner
      // of its own: a message belongs to whoever owns its conversation, so an
      // upsert keyed on the id alone let a caller append turns to another user's
      // conversation and then read that user's history straight back as the
      // context for their own question. That is the write-side twin of the
      // unscoped read this route used to do.
      const ownership = await readStored(appkit,
        'POST /api/insights/ask (conversation owner)',
        'SELECT user_email FROM player_insights.conversations WHERE id = $1',
        [conversationId]
      );
      const owner = ownership.available ? ownership.rows[0]?.user_email : undefined;
      if (typeof owner === 'string' && owner !== email) {
        // 404 rather than 403: confirming the id exists but belongs to someone
        // else is itself a disclosure.
        console.warn(`[tenancy] Refused ask on conversation ${conversationId}: it belongs to another user.`
        );
        reply.status(404).json({
          error: 'conversation_not_found',
          message: 'No conversation with this id belongs to you.',
        });
        return;
      }

      // `messages` carries no owner, so every read of a turn resolves through
      // this row, including `RUNS_QUERY`, which joins it to scope runs to the
      // caller. A first turn whose conversation write is lost therefore stores an
      // answer that no query can reach: not in the Run Explorer, not in the
      // conversation, addressable by nothing. On a turn where the row already
      // exists the upsert only moves `updated_at`, so losing it costs an ordering
      // and nothing else, which is why this is not simply "did the write work".
      const conversationExisted = ownership.available && ownership.rows.length > 0;
      const conversationWrite = await readStored(appkit,
        'POST /api/insights/ask (conversation)',
        `INSERT INTO player_insights.conversations (id, user_email, title) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
        [conversationId, email, prompt.slice(0, 80)]
      );
      const conversationAddressable = conversationExisted || conversationWrite.available;
      await safeQuery(appkit,
        'INSERT INTO player_insights.messages (id, conversation_id, role, content) VALUES ($1,$2,$3,$4)',
        [
          userMessageId,
          conversationId,
          'user',
          approvedPlanId ? PLAN_APPROVAL_MESSAGE : prompt,
        ]
      );

      // Not `safeQuery`. Its own contract is that a failure does not change the
      // response, and these two change it entirely: zero rows from a failed read
      // are indistinguishable from a conversation with no history and no
      // attachments, so the question went to the agent stripped of both and came
      // back as `type: 'answer'`, `mode: 'live'`, with no degradation header on
      // it. Someone uploads a PDF, watches the chip appear, asks what it says,
      // and is answered confidently about something else.
      const refuseWithout = (missing: string) => {
        console.error(`[serving] Refusing to answer: ${missing} could not be read, so the agent would have been ` +
            'asked this question without the context it depends on.'
        );
        markResponse(res, { substituted: false, reason: 'storage_unavailable' });
        reply.status(503).json({
          error: 'context_unavailable',
          missing: [missing],
          message:
            `Your ${missing} could not be read just now, so this question was not sent to the ` +
            'agent: an answer without it could be confidently wrong. Storage is degraded; try ' +
            'again shortly.',
        });
      };

      const historyRead = await readStored(appkit,
        'POST /api/insights/ask (history)',
        `SELECT role, content, response_json FROM (SELECT m.role, m.content, m.response_json, m.created_at
           FROM player_insights.messages m
           JOIN player_insights.conversations c ON c.id = m.conversation_id
           WHERE m.conversation_id = $1 AND c.user_email = $2
           ORDER BY m.created_at DESC LIMIT 12
         ) recent ORDER BY created_at`,
        [conversationId, email]
      );
      if (!historyRead.available) {
        refuseWithout('conversation history');
        return;
      }
      const attachmentRead = await readStored(appkit,
        'POST /api/insights/ask (attachments)',
        `SELECT filename, extracted_text FROM player_insights.attachments
         WHERE conversation_id = $1 AND user_email = $2 ORDER BY created_at`,
        [conversationId, email]
      );
      if (!attachmentRead.available) {
        refuseWithout('uploaded documents');
        return;
      }
      const historyResult = { rows: historyRead.rows };
      const attachmentText = attachmentRead.rows
        .map((row) => `## ${String(row.filename)}\n${String(row.extracted_text)}`)
        .join('\n\n')
        .slice(0, MAX_CONVERSATION_ATTACHMENT_TEXT);

      /**
       * What this turn will answer with. Declared with no value on purpose.
       *
       * It used to be pre-seeded with `representativeAnswer(prompt)` and
       * overwritten by the two paths that had a live answer to put there. That
       * made canned figures the default outcome of the block below rather than
       * a decision inside it: any exception, and any payload matching none of
       * the four contracts, served the demo dataset over HTTP 200 as
       * `type: 'answer'`, and there was no statement anywhere saying so to find
       * when somebody asked why. Adding one `custom_outputs` shape to the agent
       * was enough to do it.
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
      try {
        const servingHistory = buildServingHistory(historyResult.rows);
        if (approvedPlanId && servingHistory.length > 0) {
          servingHistory[servingHistory.length - 1] = { role: 'user', content: prompt };
        }
        // Opened before the call rather than at the first stage, so the wait
        // before the agent's first step is inside the stream too. A turn that
        // is about to answer with a plan produces no stages at all, and the
        // client needs to be able to tell that from a request that never
        // arrived.
        reply.begin();
        const { result: endpointResult, ranAsUser } = await invokeServingForUser(appkit,
          buildAskServingBody({
            history: servingHistory,
            prompt,
            conversationId,
            approvedPlanId,
            executePlan,
            attachmentText,
            stream: reply.wantsStream,
          }),
          forwardedUserToken(req),
          reply.wantsStream ? (stage) => reply.stage(stage) : undefined
        );
        ranAsSignedInUser = ranAsUser;
        const plan = extractAnalysisPlan(endpointResult);
        if (plan && approvedPlanId === plan.id) {
          // The agent was handed an approval for this exact plan and answered with
          // the same plan again. Returning it would put the user in a loop:
          // approve, receive the identical plan, approve. Falling through is worse
          //. That was the old behaviour, and it answered a plan-approval request
          // with canned figures. So: neither, and say what happened.
          console.error(`[serving] Approved plan ${approvedPlanId} was re-proposed unchanged instead of being ` +
              'run. Refusing to loop the approval, and refusing to answer with representative ' +
              'figures the user did not ask for.'
          );
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
           * to warn and fall through to `representativeAnswer(prompt)`, which
           * answered the rejection with invented figures over HTTP 200. The client
           * already expects the plan here and explains the re-proposal; it was only
           * ever the server discarding it.
           */
          const reissued = Boolean(approvedPlanId);
          if (reissued) {
            console.warn(`[serving] Approval for plan ${approvedPlanId} was refused by the agent, which ` +
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
          await safeQuery(appkit,
            `INSERT INTO player_insights.messages
             (id, conversation_id, role, content, response_json,
              app_principal, serving_principal, serving_principal_observed_at, access_mode)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              `msg-${crypto.randomUUID()}`,
              conversationId,
              'assistant',
              plan.summary,
              JSON.stringify(planResponse),
              ...executionIdentityColumns(email),
            ]
          );
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
          await safeQuery(appkit,
            `INSERT INTO player_insights.messages
             (id, conversation_id, role, content, response_json, trace_id,
              app_principal, serving_principal, serving_principal_observed_at, access_mode)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              `msg-${clarification.id}`,
              conversationId,
              'assistant',
              clarification.question,
              JSON.stringify(clarificationResponse),
              clarification.trace.id,
              ...executionIdentityColumns(email),
            ]
          );
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
          answer = { ...structuredAnswer, mode: 'live', provenance: 'live' };
        } else if (liveText) {
          // The half-live case, and the one place a live answer is built on top
          // of the demo response deliberately: the endpoint replied in prose,
          // so the narrative is the agent's and the figures, sources, SQL and
          // stages under it are the app's own. Written out rather than reusing
          // whatever `answer` happened to hold, so the borrowing is visible
          // here instead of being a consequence of a line 130 lines up.
          //
          // `mode` stays 'live', because a run did happen and the words are its
          // own. `provenance` is what says the numbers are not, and the caveat
          // is the same statement for the person reading rather than for the
          // renderer. Both, because a client keying on the sentence is reading
          // prose for a fact, and a reader given only the field is told nothing.
          const scaffold = representativeAnswer(prompt);
          answer = {
            ...scaffold,
            mode: 'live',
            provenance: 'mixed',
            takeaway: liveText.split('\n')[0]?.slice(0, 220) ?? scaffold.takeaway,
            narrative: liveText,
            caveats: [STORED_FIGURES_CAVEAT, ...scaffold.caveats],
          };
        } else {
          // Not a warning. The user is about to read invented figures presented
          // as an answer to their question, and this is the only record that it
          // happened.
          const shape = describePayloadShape(endpointResult);
          console.error('[serving] The endpoint answered, but with none of the four shapes this app can read ' +
              '(plan, clarification, structured answer, live text). Serving the stored demo response ' +
              `instead: the figures this user is about to see were not queried. ${shape}. Payload: ` +
              JSON.stringify(endpointResult).slice(0, 1200)
          );
          answer = representativeFallback(prompt, { kind: 'unrecognised_response', detail: shape });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error('[serving] The agent endpoint call failed, so this question is being answered with the ' +
            'stored demo response over HTTP 200: the figures this user is about to see were not ' +
            `queried and nothing ran. Cause: ${detail}`
        );
        answer = representativeFallback(prompt, { kind: 'endpoint_error', detail });
      }

      // Disclosed on the way out rather than only where the fallback is built, so
      // the half-live case is covered too: a plain-text endpoint reply keeps the
      // representative figures, SQL, and stages, and needs to say so.
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
      const persisted = await readStored(appkit,
        'POST /api/insights/ask (answer)',
        `INSERT INTO player_insights.messages
         (id, conversation_id, role, content, response_json, trace_id,
          app_principal, serving_principal, serving_principal_observed_at, access_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          disclosed.id,
          conversationId,
          'assistant',
          disclosed.narrative,
          JSON.stringify(disclosed),
          disclosed.trace.id,
          // Recorded on the answer rather than on the question, because these
          // name the authority something RAN under and a question runs nothing.
          ...executionIdentityColumns(email),
        ]
      );
      const runStored = persisted.available && conversationAddressable;
      if (!runStored) {
        const cause =
          (!persisted.available && persisted.error) ||
          (!conversationWrite.available && conversationWrite.error) ||
          'the write reported no error';
        console.error(`[lakebase] The answer to this question was not stored, so run ${disclosed.id} does not ` +
            'exist for the Run Explorer to open and this turn is absent from the conversation ' +
            `history. The answer itself was returned. Last error: ${cause}`
        );
      }
      // Reported in the body rather than in a header, because the streaming
      // caller's headers were flushed before the agent was even invoked, by the
      // time this is known there is no status line or header left to say it with.
      reply.json({ type: 'answer', ...disclosed, runStored });
    });

    app.get('/api/runs', async (req, res) => {
      await respondWithStored(appkit,
        res,
        'GET /api/runs',
        RUNS_QUERY,
        [PLAN_APPROVAL_MESSAGE, userEmail(req)],
        runs
      );
    });

    /**
     * What the app itself can say about its own storage, without asking the
     * agent. The Sources page reads this beside the agent's preflight report so
     * an unreachable Lakebase is stated rather than left as "Not checked", and
     * the client polls it to decide whether the figures on screen are stored or
     * seeded.
     */
    app.get('/api/storage', (_req, res) => {
      const health = lakebaseHealth();
      res.status(health.state === 'unavailable' ? 503 : 200).json(health);
    });

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
        const message = await appkit.lakebase.query(RUN_TRACE_MESSAGE_QUERY, [
          runId,
          PLAN_APPROVAL_MESSAGE,
          email,
        ]);
        if (message.rows[0]) {
          resolved = conversationRunTrace(message.rows[0], experimentId);
        } else {
          const benchmark = await appkit.lakebase.query(RUN_TRACE_BENCHMARK_QUERY, [runId, email]);
          if (benchmark.rows[0]) resolved = benchmarkRunTrace(benchmark.rows[0]);
        }
      } catch (error) {
        console.warn('[lakebase] Run trace could not be read:', (error as Error).message);
        // The representative rows `/api/runs` serves while Lakebase is down are
        // the only runs that can be answered without it.
        const offline = representativeRunTrace(runId, 'unreachable');
        if (offline) {
          res.json(offline);
          return;
        }
        res.status(503).json({
          error: 'run_trace_unavailable',
          runId,
          message: 'Run storage is unavailable right now. Try again shortly.',
        });
        return;
      }

      // The read succeeded, so whatever is missing here, the database is not it.
      resolved ??= representativeRunTrace(runId, 'not-stored');
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
        console.warn(`[runs] Trace for ${runId} does not match the run-trace contract:`,
          parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ')
        );
      }
      if (resolved.undeclaredKeys.length > 0) {
        console.warn(`[runs] Stored answer for ${runId} contains fields the app does not read:`,
          resolved.undeclaredKeys.join(', ')
        );
      }
      res.json(parsed.success ? parsed.data : resolved);
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
      const written = await readStored(appkit,
        'POST /api/feedback',
        `INSERT INTO player_insights.feedback
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
        markResponse(res, { substituted: false, reason: 'storage_unavailable' });
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
      markResponse(res, { substituted: false, reason: null });
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
      const stored = await safeQuery(appkit,
        'SELECT cases_json FROM player_insights.benchmark_suites WHERE id = $1',
        [suite.id]
      );
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
        userEmail: userEmail(req),
        requestedSuiteId,
        askAgent: async (request) => {
          const payload = buildAskServingBody({
            history: [{ role: 'user', content: request.prompt }],
            prompt: request.prompt,
            conversationId: request.conversationId,
            approvedPlanId: request.approvedPlanId,
            executePlan: request.executePlan,
            attachmentText: '',
          });
          const raw = await transport({ path: servingInvocationPath(agentEndpoint), payload });
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
          invoke: (payload) => transport({ path: servingInvocationPath(judgeEndpoint), payload }),
          judgeEndpoint,
        },
        describeServedModel: async () => {
          const { WorkspaceClient } = await import('@databricks/sdk-experimental');
          // A read of the endpoint's configuration, not an invocation of it, so
          // this is not the `servingEndpoints.query()` the lint rule forbids.
          const endpoint = await new WorkspaceClient({}).servingEndpoints.get({ name: agentEndpoint });
          return parseServedModel(agentEndpoint, endpoint);
        },
      });

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
}
