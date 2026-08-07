import {
  BENCHMARK_RUNNER_VERSION,
  GROUNDEDNESS_BASIS,
  judgeBadgeLabel,
  judgeDisclosure,
  MLFLOW_JUDGE_PROMPT_VERSION,
  type BenchmarkCaseResult,
  type BenchmarkCounts,
  type BenchmarkJudgement,
  type BenchmarkJudgeRate,
  type BenchmarkRunMetrics,
  type BenchmarkRunStatus,
  type BenchmarkStructuralCheck,
  type ServedModelReference,
} from '../../shared/benchmark-contract';
import {
  GROUNDEDNESS_FEEDBACK_NAME,
  GUIDELINES_FEEDBACK_NAME,
  groundednessPrompt,
  guidelinesPrompt,
  notApplicable,
  RELEVANCE_TO_QUERY_ASSESSMENT_NAME,
  relevanceToQueryPrompt,
  runJudge,
  type JudgeConfig,
  type JudgeName,
} from './mlflow-judges';
import {
  canonicalSuite,
  catalogFallbackCases,
  resolveSuiteCases,
  SUITE_ALIASES,
  type ResolvedCase,
  type StructuralCheckId,
  type SuiteIdentity,
} from './benchmark-suite';
import { withDeadline } from './deadline';

/**
 * The benchmark runner: runs a suite against the live agent, scores it, and
 * stores what actually happened.
 *
 * THE TRANSPORT IS INJECTED, NOT BUILT. This module contains no HTTP client of
 * any kind and must not acquire one. The agent endpoint and the judge endpoint
 * are both reached through closures the caller supplies, bound to the same
 * `apiClient.request()` transport `POST /api/insights/ask` uses. That is not a
 * style preference: the SDK's `servingEndpoints.query()` and AppKit's
 * `serving()` plugin both rebuild the request body from an allowlist that has
 * no `custom_inputs`, which silently disables plan approval while every request
 * still returns 200. A second transport here would reintroduce exactly that,
 * one route further from the guards that exist to catch it, so
 * benchmark-runner.test.ts sweeps this file's source and fails if a client
 * appears in it.
 */

// ---------------------------------------------------------------------------
// What the caller must supply
// ---------------------------------------------------------------------------

/** The subset of an agent answer this runner reads. Structural, so the route's own `LiveAnswer` fits. */
export interface BenchmarkAnswer {
  id: string;
  takeaway: string;
  narrative: string;
  sql: string;
  figures: { label: string; display: string; comparison: string }[];
  charts: { id: string; title: string }[];
  sources: { name: string; freshness: string }[];
  caveats: string[];
  trace: {
    id: string;
    totalMs: number;
    toolCalls: number;
    stages: { id: string; name: string; kind: string; status: string; input: string; output: string }[];
  };
}

/**
 * One turn's outcome, as the ask route already classifies it.
 *
 * A clarification is a first-class result rather than an error, because the
 * agent asking a question back is a legitimate end to a run and this app's
 * besetting defect is substituting one outcome for another.
 */
export type AgentTurn =
  | { type: 'answer'; answer: BenchmarkAnswer }
  | { type: 'plan'; planId: string }
  | { type: 'clarification'; question: string; traceId: string | null }
  | { type: 'unrecognized'; detail: string };

export type AskAgent = (request: {
  prompt: string;
  conversationId: string;
  approvedPlanId?: string;
  executePlan?: boolean;
}) => Promise<AgentTurn>;

/** Matches `appkit.lakebase`, so the route passes it straight through. */
export interface BenchmarkStore {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface BenchmarkRunnerDeps {
  store: BenchmarkStore;
  askAgent: AskAgent;
  judge: JudgeConfig;
  userEmail: string;
  requestedSuiteId: string;
  /**
   * Which model version answered. Optional and never guessed: when the caller
   * cannot describe the endpoint, the run records that the version is unknown
   * rather than assuming the latest.
   */
  describeServedModel?: () => Promise<ServedModelReference | null>;
  /** Injected in tests so a suite can be simulated without waiting minutes. */
  now?: () => number;
  turnTimeoutMs?: number;
  suiteBudgetMs?: number;
  newId?: () => string;
}

export const DEFAULT_TURN_TIMEOUT_MS = 120_000;
export const DEFAULT_SUITE_BUDGET_MS = 20 * 60_000;

/**
 * How long a `running` row may go without a heartbeat before it is treated as
 * abandoned. Comfortably above the worst case for one case (two turns at the
 * turn timeout plus three judge calls), so a slow run is never swept as a dead
 * one.
 */
export const STALE_RUN_AFTER_MS = 15 * 60_000;

/** Upper bound on the document handed to the groundedness judge. */
export const MAX_JUDGE_CONTEXT_CHARS = 16_000;

// ---------------------------------------------------------------------------
// SQL
//
// Exported so it can be validated against the live schema with PREPARE, the way
// the route's statements already are.
// ---------------------------------------------------------------------------

export const BENCHMARK_SUITE_QUERY = `
  SELECT id, name, description, cases_json
  FROM player_insights.benchmark_suites
  WHERE id = ANY($1)`;

export const BENCHMARK_RUN_INSERT = `
  INSERT INTO player_insights.benchmark_runs (id, suite_id, user_email, status, metrics_json)
  VALUES ($1,$2,$3,$4,$5)`;

export const BENCHMARK_RUN_UPDATE = `
  UPDATE player_insights.benchmark_runs SET status = $2, metrics_json = $3 WHERE id = $1`;

/** The caller's own unfinished runs, for the stale sweep and the in-flight check. */
export const BENCHMARK_RUNNING_QUERY = `
  SELECT id, suite_id, metrics_json, created_at
  FROM player_insights.benchmark_runs
  WHERE user_email = $1 AND status = 'running'`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * The document the groundedness judge checks the answer against.
 *
 * Assembled from what the agent actually retrieved: the output of each stage
 * (the data stage carries the rows the warehouse or Genie returned), the SQL it
 * ran, and the figures it derived. Source *names* alone would not do: a
 * groundedness rubric needs content, and grading an answer against a list of
 * table names would produce a number that looked like a measurement and was
 * not.
 */
export function buildRetrievalContext(answer: BenchmarkAnswer): { text: string; truncated: boolean } {
  const parts: string[] = [];
  for (const stage of answer.trace.stages) {
    if (stage.output && stage.output.trim()) parts.push(`[${stage.name}]\n${stage.output}`);
  }
  if (answer.sql.trim()) parts.push(`[SQL executed]\n${answer.sql}`);
  for (const figure of answer.figures) {
    parts.push(`[figure] ${figure.label}: ${figure.display} (${figure.comparison})`);
  }
  for (const source of answer.sources) {
    parts.push(`[source] ${source.name} (${source.freshness})`);
  }
  const text = parts.join('\n\n');
  if (text.length <= MAX_JUDGE_CONTEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_JUDGE_CONTEXT_CHARS), truncated: true };
}

export function answerText(answer: BenchmarkAnswer): string {
  return `${answer.takeaway}\n\n${answer.narrative}`.trim();
}

const STRUCTURAL_CHECKS: Record<
  StructuralCheckId,
  { label: string; evaluate: (answer: BenchmarkAnswer) => { passed: boolean; detail: string } }
> = {
  'has-charts': {
    label: 'Returned at least one chart',
    evaluate: (answer) => ({
      passed: answer.charts.length > 0,
      detail:
        answer.charts.length > 0
          ? `${answer.charts.length} chart(s): ${answer.charts.map((chart) => chart.title).join(', ')}`
          : 'The answer carried no chart specification, so the browser has nothing to render.',
    }),
  },
  'has-figures': {
    label: 'Reported at least one figure',
    evaluate: (answer) => ({
      passed: answer.figures.length > 0,
      detail:
        answer.figures.length > 0
          ? `${answer.figures.length} figure(s): ${answer.figures.map((figure) => figure.label).join(', ')}`
          : 'The answer reported no figures, so there is no quantitative claim to check.',
    }),
  },
  'has-sources': {
    label: 'Named its sources',
    evaluate: (answer) => ({
      passed: answer.sources.length > 0,
      detail:
        answer.sources.length > 0
          ? answer.sources.map((source) => source.name).join(', ')
          : 'The answer named no source, so its provenance cannot be shown to a stakeholder.',
    }),
  },
  'has-sql': {
    label: 'Disclosed the SQL it ran',
    evaluate: (answer) => ({
      passed: answer.sql.trim().length > 0,
      detail: answer.sql.trim() ? 'SQL disclosed.' : 'No SQL was disclosed with the answer.',
    }),
  },
};

export function evaluateStructuralChecks(ids: StructuralCheckId[],
  answer: BenchmarkAnswer
): BenchmarkStructuralCheck[] {
  return ids.map((id) => {
    const check = STRUCTURAL_CHECKS[id];
    const outcome = check.evaluate(answer);
    return { id, label: check.label, passed: outcome.passed, detail: outcome.detail };
  });
}

/**
 * One judge's aggregate.
 *
 * `notApplicable` and `errored` are excluded from both numerator and
 * denominator: a rubric that did not apply and a judge that could not be
 * reached are both absences of evidence, and folding either into the rate would
 * make a number that reads as a percentage out of a count nobody measured.
 */
export function summariseJudge(judgements: BenchmarkJudgement[], name: JudgeName): BenchmarkJudgeRate {
  const mine = judgements.filter((judgement) => judgement.name === name);
  const yes = mine.filter((judgement) => judgement.state === 'scored' && judgement.value === 'yes').length;
  const no = mine.filter((judgement) => judgement.state === 'scored' && judgement.value === 'no').length;
  const scored = yes + no;
  return {
    rate: scored === 0 ? null : Number((yes / scored).toFixed(4)),
    scored,
    yes,
    no,
    notApplicable: mine.filter((judgement) => judgement.state === 'not-applicable').length,
    errored: mine.filter((judgement) => judgement.state === 'errored').length,
  };
}

export function countOutcomes(cases: BenchmarkCaseResult[], total: number): BenchmarkCounts {
  const of = (outcome: BenchmarkCaseResult['outcome']) =>
    cases.filter((result) => result.outcome === outcome).length;
  return {
    total,
    attempted: cases.filter((result) => result.outcome !== 'unresolved').length,
    passed: of('passed'),
    failed: of('failed'),
    errored: of('errored'),
    clarified: of('clarified'),
    unresolved: of('unresolved'),
  };
}

/**
 * The suite verdict.
 *
 * `complete` requires every case in the suite to have passed, not every case
 * that happened to produce a score. A suite where three of ten errored is not a
 * complete run of seven, which is the substitution this whole module exists to
 * remove.
 */
export function deriveStatus(counts: BenchmarkCounts): BenchmarkRunStatus {
  if (counts.passed === counts.total && counts.total > 0) return 'complete';
  if (counts.passed === 0) return 'failed';
  return 'partial';
}

// ---------------------------------------------------------------------------
// Scoring one case
// ---------------------------------------------------------------------------

async function judgeCase(judge: JudgeConfig,
  resolved: ResolvedCase,
  question: string,
  answer: BenchmarkAnswer,
  context: { text: string; truncated: boolean }
): Promise<BenchmarkJudgement[]> {
  const applicable = new Set(resolved.judges);
  const judgements: BenchmarkJudgement[] = [];
  const response = answerText(answer);

  const skip = (name: JudgeName, fallbackReason: string) =>
    judgements.push(notApplicable(name, judge.judgeEndpoint, resolved.judgeNotes[name] ?? fallbackReason));

  // Groundedness has a second, evidence-based gate on top of the catalog's
  // declaration: with nothing retrieved there is no document, so the rubric
  // cannot be applied to this particular answer whatever the case expected.
  if (!applicable.has(GROUNDEDNESS_FEEDBACK_NAME)) {
    skip(GROUNDEDNESS_FEEDBACK_NAME, 'This case does not apply the groundedness rubric.');
  } else if (!context.text.trim()) {
    skip(GROUNDEDNESS_FEEDBACK_NAME,
      'The answer carried no retrieved context (no stage output, no SQL and no figures), so there is no ' +
        'document to check its claims against. Unscored rather than scored against an empty document.'
    );
  } else {
    judgements.push(await runJudge(judge,
        GROUNDEDNESS_FEEDBACK_NAME,
        groundednessPrompt(question, response, context.text)
      )
    );
  }

  if (!applicable.has(RELEVANCE_TO_QUERY_ASSESSMENT_NAME)) {
    skip(RELEVANCE_TO_QUERY_ASSESSMENT_NAME, 'This case does not apply the relevance rubric.');
  } else {
    judgements.push(await runJudge(judge,
        RELEVANCE_TO_QUERY_ASSESSMENT_NAME,
        relevanceToQueryPrompt(question, response)
      )
    );
  }

  if (!applicable.has(GUIDELINES_FEEDBACK_NAME) || resolved.guidelines.length === 0) {
    skip(GUIDELINES_FEEDBACK_NAME,
      'This case declares no guideline, so there is no stated expectation to assess it against.'
    );
  } else {
    judgements.push(await runJudge(judge,
        GUIDELINES_FEEDBACK_NAME,
        guidelinesPrompt(resolved.guidelines, { request: question, response })
      )
    );
  }

  return judgements;
}

/**
 * Pass or fail, from evidence only.
 *
 * A case passes when it answered, every structural check held, at least one
 * judge produced a verdict, and every verdict was yes. The "at least one"
 * clause is what stops a case passing on an empty set: if every rubric was
 * skipped and every judge errored, nothing was measured, and a pass would be an
 * assertion with nothing behind it.
 */
export function decideOutcome(checks: BenchmarkStructuralCheck[],
  judgements: BenchmarkJudgement[]
): { outcome: 'passed' | 'failed' | 'errored'; errorStage: 'judge' | null; note: string } {
  const failedChecks = checks.filter((check) => !check.passed);
  const said = judgements.filter((judgement) => judgement.state === 'scored');
  const saidNo = said.filter((judgement) => judgement.value === 'no');
  const judgeErrors = judgements.filter((judgement) => judgement.state === 'errored');

  if (failedChecks.length > 0 || saidNo.length > 0) {
    const reasons = [
      ...failedChecks.map((check) => `${check.label} failed: ${check.detail}`),
      ...saidNo.map((judgement) => `the ${judgement.name} judge said no, ${judgement.rationale || 'no rationale given'}`),
    ];
    return { outcome: 'failed', errorStage: null, note: `The agent answered, and ${reasons.join('; ')}.` };
  }
  if (said.length === 0) {
    const detail =
      judgeErrors.length > 0
        ? `every judge that applied failed to answer (${judgeErrors.map((judgement) => judgement.reason).join('; ')})`
        : 'no rubric applied to this case';
    return {
      outcome: 'errored',
      errorStage: 'judge',
      note:
        `The agent answered and every structural check held, but ${detail}, so this case is unscored. ` +
        'Not counted as a pass: there is no measurement behind it.',
    };
  }
  if (judgeErrors.length > 0) {
    return {
      outcome: 'errored',
      errorStage: 'judge',
      note:
        `The agent answered and ${said.length} judge(s) said yes, but ${judgeErrors.length} judge(s) could not ` +
        `be reached (${judgeErrors.map((judgement) => judgement.reason).join('; ')}), so the case is not fully ` +
        'scored and is not claimed as a pass.',
    };
  }
  return {
    outcome: 'passed',
    errorStage: null,
    note: `Answered, ${checks.length} structural check(s) held, and all ${said.length} applicable judge(s) said yes.`,
  };
}

// ---------------------------------------------------------------------------
// Running one case
// ---------------------------------------------------------------------------

async function withTurnTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return withDeadline(work,
    ms,
    `The agent endpoint did not answer within ${ms} ms. The call was abandoned rather than cancelled, ` +
      'so it may still be running at the endpoint.'
  );
}

function unresolvedCase(resolved: ResolvedCase): BenchmarkCaseResult {
  return {
    caseId: resolved.caseId,
    question: null,
    questionSource: null,
    outcome: 'unresolved',
    errorStage: null,
    error: null,
    durationMs: null,
    agentTotalMs: null,
    turns: 0,
    mlflowTraceId: null,
    answerId: null,
    structuralChecks: [],
    judgements: [],
    note:
      `The suite names case "${resolved.caseId}", but no question was found for it: neither on the suite row ` +
      'nor in the server-side catalog. Nothing ran. It is still counted in the total, so the suite cannot get ' +
      'shorter by naming cases that do not exist.',
  };
}

async function runCase(deps: BenchmarkRunnerDeps,
  runId: string,
  resolved: ResolvedCase
): Promise<BenchmarkCaseResult> {
  if (!resolved.question) return unresolvedCase(resolved);
  const question = resolved.question;
  const now = deps.now ?? Date.now;
  const turnTimeout = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  // Its own conversation id per case, so no case can be answered with the
  // previous one's history. Not written to `conversations`: the runner talks to
  // the endpoint through the transport rather than through the ask route, so a
  // benchmark does not leave six conversations in the user's sidebar.
  const conversationId = `benchmark-${runId}-${resolved.caseId}`;
  const started = now();

  const base = {
    caseId: resolved.caseId,
    question,
    questionSource: resolved.questionSource,
    structuralChecks: [] as BenchmarkStructuralCheck[],
    judgements: [] as BenchmarkJudgement[],
  };

  let turns = 0;
  let answer: BenchmarkAnswer | null = null;
  let clarification: { question: string; traceId: string | null } | null = null;
  let failure: string | null = null;

  try {
    turns = 1;
    let turn = await withTurnTimeout(deps.askAgent({ prompt: question, conversationId }), turnTimeout);
    // The agent proposes a plan for anything non-trivial and waits for
    // approval. A benchmark that stopped there would be measuring the planner,
    // so the plan is approved and executed exactly as the ask route does.
    if (turn.type === 'plan') {
      turns = 2;
      turn = await withTurnTimeout(deps.askAgent({
          prompt: question,
          conversationId,
          approvedPlanId: turn.planId,
          executePlan: true,
        }),
        turnTimeout
      );
    }
    if (turn.type === 'answer') answer = turn.answer;
    else if (turn.type === 'clarification') clarification = { question: turn.question, traceId: turn.traceId };
    else if (turn.type === 'plan') failure = `The agent proposed plan ${turn.planId} again after it was approved, so the case never ran.`;
    else failure = turn.detail;
  } catch (error) {
    failure = (error as Error).message;
  }

  const elapsed = now() - started;

  if (clarification) {
    return {
      ...base,
      outcome: 'clarified',
      errorStage: null,
      error: null,
      durationMs: elapsed,
      agentTotalMs: null,
      turns,
      mlflowTraceId: clarification.traceId,
      answerId: null,
      note:
        'The agent asked a question back instead of answering: ' +
        `"${clarification.question}". That is a real outcome of a run rather than a failure of one, so it is ` +
        'reported as its own state and is not counted as a pass.',
    };
  }

  if (!answer) {
    return {
      ...base,
      outcome: 'errored',
      errorStage: 'agent',
      error: failure ?? 'The agent endpoint returned nothing this runner could read.',
      durationMs: elapsed,
      agentTotalMs: null,
      turns,
      mlflowTraceId: null,
      answerId: null,
      note: `The agent produced no answer, so nothing was scored. ${failure ?? ''}`.trim(),
    };
  }

  const context = buildRetrievalContext(answer);
  const structuralChecks = evaluateStructuralChecks(resolved.structuralChecks, answer);
  const judgements = await judgeCase(deps.judge, resolved, question, answer, context);
  const decided = decideOutcome(structuralChecks, judgements);

  return {
    caseId: resolved.caseId,
    question,
    questionSource: resolved.questionSource,
    outcome: decided.outcome,
    errorStage: decided.errorStage,
    error: null,
    // Measured here, around the transport. Deliberately not reconciled with the
    // agent's own `trace.totalMs` below: this one includes the network and both
    // turns, that one does not, and neither is a correction of the other.
    durationMs: now() - started,
    agentTotalMs: Math.round(answer.trace.totalMs),
    turns,
    mlflowTraceId: answer.trace.id,
    answerId: answer.id,
    structuralChecks,
    judgements,
    note: context.truncated
      ? `${decided.note} The retrieved context was truncated to ${MAX_JUDGE_CONTEXT_CHARS} characters before judging.`
      : decided.note,
  };
}

// ---------------------------------------------------------------------------
// Metrics assembly
// ---------------------------------------------------------------------------

const UNKNOWN_SERVED_MODEL: ServedModelReference = {
  endpoint: '',
  entityName: null,
  version: null,
  determinate: false,
  routes: [],
  note:
    'The served model version could not be read, so which version produced these scores is unknown. ' +
    'Recorded as unknown rather than assumed to be the latest.',
};

/**
 * Read which model version answered out of a serving endpoint description.
 */
export function parseServedModel(endpointName: string, endpoint: unknown): ServedModelReference {
  const config = ((endpoint as { config?: unknown } | null)?.config ?? {}) as Record<string, unknown>;
  const trafficConfig = (config.traffic_config ?? config.trafficConfig) as { routes?: unknown } | undefined;
  const rawRoutes = Array.isArray(trafficConfig?.routes) ? trafficConfig.routes : [];
  const routes = rawRoutes.map((route) => {
    const record = route as Record<string, unknown>;
    const name = textOf(record.served_model_name ?? record.servedModelName ?? record.served_entity_name);
    const percentage = record.traffic_percentage ?? record.trafficPercentage;
    return { name, trafficPercentage: typeof percentage === 'number' ? percentage : 0 };
  });

  const recordList = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? (value as unknown[]).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
  const entities = [
    ...recordList(config.served_entities),
    ...recordList(config.servedEntities),
    ...recordList(config.served_models),
  ];

  const live = routes.filter((route) => route.trafficPercentage > 0);
  if (live.length !== 1 || live[0].trafficPercentage !== 100) {
    return {
      endpoint: endpointName,
      entityName: null,
      version: null,
      determinate: false,
      routes,
      note:
        routes.length === 0
          ? 'The endpoint reported no traffic configuration, so which model version answered is unknown.'
          : 'Traffic is split across more than one route, so this run cannot be attributed to a single model ' +
            'version. Recorded as indeterminate rather than attributed to the majority route.',
    };
  }

  const entity = entities.find((candidate) => textOf(candidate.name) === live[0].name);
  const version = textOf(entity?.entity_version ?? entity?.entityVersion ?? entity?.model_version ?? entity?.modelVersion);
  const entityName = textOf(entity?.entity_name ?? entity?.entityName ?? entity?.model_name ?? entity?.modelName);
  return {
    endpoint: endpointName,
    entityName: entityName || null,
    version: version || null,
    determinate: version.length > 0,
    routes,
    note: version
      ? `All traffic is on ${live[0].name}, so this run is attributable to version ${version} of ${entityName}.`
      : `All traffic is on ${live[0].name}, but the endpoint did not report a model version for it.`,
  };
}

export function buildMetrics(input: {
  suite: SuiteIdentity;
  requestedSuiteId: string;
  cases: BenchmarkCaseResult[];
  total: number;
  status: BenchmarkRunStatus;
  judgeEndpoint: string;
  servedModel: ServedModelReference;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  progress: { currentCaseId: string | null; currentCaseIndex: number | null };
  persistenceFailures: number;
  interrupted?: true;
}): BenchmarkRunMetrics {
  const judgements = input.cases.flatMap((result) => result.judgements);
  const counts = countOutcomes(input.cases, input.total);
  const groundedness = summariseJudge(judgements, GROUNDEDNESS_FEEDBACK_NAME);
  const relevance = summariseJudge(judgements, RELEVANCE_TO_QUERY_ASSESSMENT_NAME);
  const guidelines = summariseJudge(judgements, GUIDELINES_FEEDBACK_NAME);
  const caseDurations = input.cases
    .map((result) => result.durationMs)
    .filter((value): value is number => typeof value === 'number');

  return {
    suiteId: input.suite.id,
    suiteName: input.suite.name,
    requestedSuiteId: input.requestedSuiteId,
    prompt: `Benchmark suite: ${input.suite.name}`,
    status: input.status,
    counts,
    groundedness: groundedness.rate,
    relevance: relevance.rate,
    guidelines: guidelines.rate,
    judgeRates: {
      groundedness,
      relevance_to_context: relevance,
      guidelines,
    },
    durationMs: input.durationMs,
    duration_ms: input.durationMs,
    medianCaseMs: median(caseDurations),
    // The two keys the existing trace-route projection reads. Real counts, so
    // that projection tells the truth even before it is widened.
    passed: counts.passed,
    total: counts.total,
    cases: input.cases,
    progress: {
      completed: input.cases.length,
      total: input.total,
      currentCaseId: input.progress.currentCaseId,
      currentCaseIndex: input.progress.currentCaseIndex,
    },
    judge: {
      endpoint: input.judgeEndpoint,
      promptVersion: MLFLOW_JUDGE_PROMPT_VERSION,
      badge: judgeBadgeLabel(input.judgeEndpoint),
      disclosure: judgeDisclosure(input.judgeEndpoint),
      groundednessBasis: GROUNDEDNESS_BASIS,
    },
    servedModel: input.servedModel,
    startedAt: input.startedAt,
    heartbeatAt: input.heartbeatAt,
    finishedAt: input.finishedAt,
    ...(input.interrupted ? { interrupted: input.interrupted as true } : {}),
    persistenceFailures: input.persistenceFailures,
    runnerVersion: BENCHMARK_RUNNER_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Stale runs
// ---------------------------------------------------------------------------

function heartbeatAge(metrics: unknown, nowMs: number): number | null {
  const record = parseJson(metrics);
  if (!record || typeof record !== 'object') return null;
  const stamp = (record as { heartbeatAt?: unknown; startedAt?: unknown }).heartbeatAt ??
    (record as { startedAt?: unknown }).startedAt;
  if (typeof stamp !== 'string') return null;
  const at = Date.parse(stamp);
  return Number.isFinite(at) ? nowMs - at : null;
}

/**
 * Close out the caller's own runs that a dead process left `running`.
 *
 * The app is one container: a redeploy or a crash mid-suite leaves a row that
 * says `running` and never moves, and Run Explorer would show it as in progress
 * indefinitely. Swept on the way into a new run, and marked `failed` with
 * `interrupted: true` rather than deleted, because a run that was cut off did
 * happen and the record of it is worth more than a tidy list.
 */
export async function sweepStaleRuns(deps: {
  store: BenchmarkStore;
  userEmail: string;
  now?: () => number;
}): Promise<{ swept: string[]; stillRunning: { id: string; suiteId: string }[] }> {
  const now = deps.now ?? Date.now;
  const swept: string[] = [];
  const stillRunning: { id: string; suiteId: string }[] = [];
  let rows: Record<string, unknown>[] = [];
  try {
    const result = await deps.store.query(BENCHMARK_RUNNING_QUERY, [deps.userEmail]);
    rows = result.rows;
  } catch (error) {
    console.warn('[benchmark] Could not read unfinished runs before starting:', (error as Error).message);
    return { swept, stillRunning };
  }

  for (const row of rows) {
    const id = textOf(row.id);
    const age = heartbeatAge(row.metrics_json, now());
    if (age === null || age <= STALE_RUN_AFTER_MS) {
      stillRunning.push({ id, suiteId: textOf(row.suite_id) });
      continue;
    }
    const metrics = parseJson(row.metrics_json);
    const patched = {
      ...(metrics && typeof metrics === 'object' ? (metrics as Record<string, unknown>) : {}),
      status: 'failed' as const,
      interrupted: true as const,
      finishedAt: new Date(now()).toISOString(),
    };
    try {
      await deps.store.query(BENCHMARK_RUN_UPDATE, [id, 'failed', JSON.stringify(patched)]);
      swept.push(id);
      console.warn(`[benchmark] Run ${id} was left running with no heartbeat for ${Math.round(age / 1000)}s, which means the ` +
          'process executing it stopped. Marked failed and interrupted rather than left in progress forever.'
      );
    } catch (error) {
      console.error(`[benchmark] Could not close out abandoned run ${id}:`, (error as Error).message);
      stillRunning.push({ id, suiteId: textOf(row.suite_id) });
    }
  }
  return { swept, stillRunning };
}

// ---------------------------------------------------------------------------
// Starting a run
// ---------------------------------------------------------------------------

export type StartBenchmarkResult =
  | { status: 202; body: { id: string; suiteId: string; suiteName: string; runStatus: 'running'; total: number; poll: string }; completed: Promise<void> }
  | { status: 400 | 409 | 503; body: { error: string; message: string; runId?: string } };

/**
 * Load the suite, or say why it could not be loaded.
 *
 * A Lakebase failure falls back to the catalog's six cases and the run records
 * that it did: a benchmark that silently ran a different case list from the
 * one requested would be the same defect as the constants it replaces.
 */
async function loadCases(store: BenchmarkStore,
  suite: SuiteIdentity,
  requestedSuiteId: string
): Promise<{ cases: ResolvedCase[]; source: 'suite-row' | 'catalog-fallback'; suiteName: string }> {
  const aliasIds = [...new Set([suite.id, requestedSuiteId])];
  try {
    const result = await store.query(BENCHMARK_SUITE_QUERY, [aliasIds]);
    const preferred =
      result.rows.find((row) => String(row.id) === suite.id) ?? result.rows[0];
    if (preferred) {
      const cases = resolveSuiteCases(parseJson(preferred.cases_json));
      if (cases.length > 0) {
        return { cases, source: 'suite-row', suiteName: suite.name };
      }
      console.warn(`[benchmark] Suite row ${String(preferred.id)} holds no usable cases, so the server-side catalog is ` +
          'being run instead. The run records this substitution.'
      );
    }
  } catch (error) {
    console.warn('[benchmark] Suite definitions could not be read, so the server-side catalog is being run instead:',
      (error as Error).message
    );
  }
  return { cases: catalogFallbackCases(), source: 'catalog-fallback', suiteName: suite.name };
}

/**
 * Start a suite. Returns as soon as the `running` row is stored; the suite
 * itself continues in the background.
 *
 * The returned `completed` promise exists for tests and for a caller that wants
 * to await the whole suite. The route ignores it, holding an HTTP request open
 * for four minutes is what this design avoids.
 */
export async function startBenchmarkRun(deps: BenchmarkRunnerDeps): Promise<StartBenchmarkResult> {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const suite = canonicalSuite(deps.requestedSuiteId);
  if (!suite) {
    return {
      status: 400,
      body: {
        error: 'unknown_suite',
        message:
          `No benchmark suite is known by the id "${deps.requestedSuiteId}". Known ids: ` +
          `${Object.keys(SUITE_ALIASES).join(', ')}.`,
      },
    };
  }

  const sweep = await sweepStaleRuns({ store: deps.store, userEmail: deps.userEmail, now });
  const inFlight = sweep.stillRunning.find((run) => run.suiteId === suite.id);
  if (inFlight) {
    return {
      status: 409,
      body: {
        error: 'benchmark_already_running',
        runId: inFlight.id,
        message:
          `A run of ${suite.name} is already in progress for you. A suite takes several minutes, so a second ` +
          'run would compete with it at the endpoint and both sets of latency figures would be wrong. Watch ' +
          'the run in progress, or wait for it to finish.',
      },
    };
  }

  const loaded = await loadCases(deps.store, suite, deps.requestedSuiteId);
  const runId = newId();
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const servedModel = await resolveServedModel(deps);

  const initial = buildMetrics({
    suite,
    requestedSuiteId: deps.requestedSuiteId,
    cases: [],
    total: loaded.cases.length,
    status: 'running',
    judgeEndpoint: deps.judge.judgeEndpoint,
    servedModel,
    startedAt,
    heartbeatAt: startedAt,
    finishedAt: null,
    durationMs: null,
    progress: { currentCaseId: loaded.cases[0]?.caseId ?? null, currentCaseIndex: loaded.cases.length > 0 ? 0 : null },
    persistenceFailures: 0,
  });
  if (loaded.source === 'catalog-fallback') {
    (initial as BenchmarkRunMetrics & { caseListSource: string }).caseListSource = 'catalog-fallback';
  }

  try {
    await deps.store.query(BENCHMARK_RUN_INSERT, [
      runId,
      suite.id,
      deps.userEmail,
      'running',
      JSON.stringify(initial),
    ]);
  } catch (error) {
    console.error('[benchmark] Refusing to start: the run row could not be written, so a suite would execute with nowhere ' +
        'to record what it found:',
      (error as Error).message
    );
    return {
      status: 503,
      body: {
        error: 'benchmark_storage_unavailable',
        message:
          'The benchmark could not be started because its run record could not be stored. Running it anyway ' +
          'would spend several minutes of agent time on results nobody could read. Try again shortly.',
      },
    };
  }

  console.log(`[benchmark] Run ${runId} started: ${loaded.cases.length} case(s) of ${suite.name}, judged by ` +
      `${deps.judge.judgeEndpoint} with MLflow ${MLFLOW_JUDGE_PROMPT_VERSION} prompts, against ` +
      `${servedModel.determinate ? `model version ${servedModel.version}` : 'an endpoint whose version is not determinate'}.`
  );

  const completed = executeRun(deps, {
    runId,
    suite,
    cases: loaded.cases,
    caseListSource: loaded.source,
    servedModel,
    startedAt,
    startedAtMs,
  });

  return {
    status: 202,
    body: {
      id: runId,
      suiteId: suite.id,
      suiteName: suite.name,
      runStatus: 'running',
      total: loaded.cases.length,
      poll: `/api/runs/${encodeURIComponent(runId)}/trace`,
    },
    completed,
  };
}

async function resolveServedModel(deps: BenchmarkRunnerDeps): Promise<ServedModelReference> {
  if (!deps.describeServedModel) return UNKNOWN_SERVED_MODEL;
  try {
    return (await deps.describeServedModel()) ?? UNKNOWN_SERVED_MODEL;
  } catch (error) {
    console.warn('[benchmark] Served model version could not be read:', (error as Error).message);
    return {
      ...UNKNOWN_SERVED_MODEL,
      note: `${UNKNOWN_SERVED_MODEL.note} The lookup failed: ${(error as Error).message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Executing a run
// ---------------------------------------------------------------------------

async function executeRun(deps: BenchmarkRunnerDeps,
  context: {
    runId: string;
    suite: SuiteIdentity;
    cases: ResolvedCase[];
    caseListSource: 'suite-row' | 'catalog-fallback';
    servedModel: ServedModelReference;
    startedAt: string;
    startedAtMs: number;
  }
): Promise<void> {
  const now = deps.now ?? Date.now;
  const budget = deps.suiteBudgetMs ?? DEFAULT_SUITE_BUDGET_MS;
  const results: BenchmarkCaseResult[] = [];
  let persistenceFailures = 0;

  const persist = async (status: BenchmarkRunStatus, currentIndex: number | null, finished: boolean) => {
    const metrics = buildMetrics({
      suite: context.suite,
      requestedSuiteId: deps.requestedSuiteId,
      cases: results,
      total: context.cases.length,
      status,
      judgeEndpoint: deps.judge.judgeEndpoint,
      servedModel: context.servedModel,
      startedAt: context.startedAt,
      heartbeatAt: new Date(now()).toISOString(),
      finishedAt: finished ? new Date(now()).toISOString() : null,
      durationMs: finished ? now() - context.startedAtMs : null,
      progress: {
        currentCaseId: currentIndex === null ? null : (context.cases[currentIndex]?.caseId ?? null),
        currentCaseIndex: currentIndex,
      },
      persistenceFailures,
    });
    if (context.caseListSource === 'catalog-fallback') {
      (metrics as BenchmarkRunMetrics & { caseListSource: string }).caseListSource = 'catalog-fallback';
    }
    try {
      await deps.store.query(BENCHMARK_RUN_UPDATE, [context.runId, status, JSON.stringify(metrics)]);
    } catch (error) {
      persistenceFailures += 1;
      // Loud, and with the payload, because this is the one failure mode where
      // the work was really done and the record of it is what went missing.
      console.error(`[benchmark] Run ${context.runId} could not be updated after ${results.length} case(s): ` +
          `${(error as Error).message}. Results so far, for recovery: ${JSON.stringify(metrics).slice(0, 4000)}`
      );
    }
  };

  for (let index = 0; index < context.cases.length; index += 1) {
    const resolved = context.cases[index];
    if (now() - context.startedAtMs > budget) {
      // Everything left is reported as unrun for a stated reason, rather than
      // the run finishing quietly on a shorter list than it started with.
      for (let remaining = index; remaining < context.cases.length; remaining += 1) {
        results.push({
          ...unresolvedCase(context.cases[remaining]),
          outcome: 'errored',
          errorStage: 'budget',
          error: `The suite exceeded its ${Math.round(budget / 60_000)} minute budget before this case ran.`,
          question: context.cases[remaining].question,
          questionSource: context.cases[remaining].questionSource,
          note:
            `The suite ran out of time before this case started, so it was not attempted. Counted as unscored, ` +
            'not as a pass and not dropped from the total.',
        });
      }
      break;
    }
    await persist('running', index, false);
    const result = await runCase(deps, context.runId, resolved);
    results.push(result);
    console.log(`[benchmark] Run ${context.runId} case ${index + 1}/${context.cases.length} ` +
        `${result.caseId}: ${result.outcome}${result.durationMs === null ? '' : ` in ${result.durationMs} ms`}`
    );
  }

  const counts = countOutcomes(results, context.cases.length);
  const status = deriveStatus(counts);
  await persist(status, null, true);
  console.log(`[benchmark] Run ${context.runId} ${status}: ${counts.passed} passed, ${counts.failed} failed, ` +
      `${counts.errored} errored, ${counts.clarified} clarified, ${counts.unresolved} unresolved, of ` +
      `${counts.total} case(s) in ${now() - context.startedAtMs} ms. No rating was recorded. A rating is ` +
      'human input and this run has not been rated.'
  );
}
