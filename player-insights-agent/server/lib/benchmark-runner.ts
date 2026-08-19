import { APP_SCHEMA } from '../../shared/app-schema';
import {
  BENCHMARK_RUNNER_VERSION,
  BUDGET_TRUNCATION_CODE,
  GROUNDEDNESS_BASIS,
  judgeBadgeLabel,
  judgeDisclosure,
  MLFLOW_JUDGE_PROMPT_VERSION,
  type BenchmarkCaseResult,
  type BenchmarkCounts,
  type BenchmarkExecutionIdentity,
  type BenchmarkJudgement,
  type BenchmarkJudgeRate,
  type BenchmarkRunMetrics,
  type BenchmarkRunStatus,
  type BenchmarkStructuralCheck,
  type BenchmarkTruncation,
  type ServedModelReference,
} from '../../shared/benchmark-contract';
import { type FailureCode } from '../../shared/failure-taxonomy';
import { coverage, endsTheSuite, type CredentialLifetime } from './benchmark-identity';
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
import { scoreCase, type AnswerEnvelope, type CaseExpectations } from '../../shared/answer-scorers';
import {
  HELD_OUT_CASES,
  HELD_OUT_SUITE_ID,
  HELD_OUT_SUITE_NAME,
  heldOutCase,
} from '../../shared/held-out-suite';
import { SCORER_CATALOG, unimplementableScorers } from '../../shared/scorer-catalog';
import type { ScorecardValue, ScoredCaseFields, ScoredRunFields } from '../../shared/scorecard-contract';

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

/**
 * The subset of an agent answer this runner reads. Structural, so the route's
 * own `LiveAnswer` fits.
 *
 * THE OPTIONAL FIELDS ARE FOR THE SCORERS AND ARE OPTIONAL FOR A REASON. `role`,
 * `genie_spaces` and `total_tokens` are all present on a current model version
 * and all absent from one logged before they existed. Requiring them would drop
 * an older endpoint's answers out of the runner's own type; defaulting them
 * would invent a measurement, which is the specific failure `TraceSchema` in the
 * ask route already documents at length for these exact fields. So they are
 * optional here and every scorer that reads one abstains when it is missing.
 */
export interface BenchmarkAnswer {
  id: string;
  takeaway: string;
  narrative: string;
  sql: string;
  figures: { label: string; display: string; comparison: string }[];
  charts: { id: string; title: string }[];
  sources: { name: string; freshness: string; role?: string }[];
  caveats: string[];
  trace: {
    id: string;
    totalMs: number;
    toolCalls: number;
    stages: { id: string; name: string; kind: string; status: string; input: string; output: string }[];
    genie_spaces?: { id: string; title?: string }[];
    total_tokens?: number;
  };
  /** The agent's own account of whose grants were in force, when it reports one. */
  execution_identity?: { mode?: string; verified?: boolean };
  /** Which tables the semantic layer the run searched describes. */
  semantic_layer_tables?: string[];
}

/**
 * One turn's outcome, as the ask route already classifies it.
 *
 * A clarification is a first-class result rather than an error, because the
 * agent asking a question back is a legitimate end to a run and this app's
 * besetting defect is substituting one outcome for another.
 *
 * `refused` is here for the same reason and is the newest of them. The agent's
 * identity gate declines a turn from inside an HTTP 200, so before this variant
 * existed a refusal arrived as `unrecognized` and was recorded as "the endpoint
 * returned no answer, plan or clarification this app can read". That sentence
 * is not merely unhelpful, it is wrong in a specific and expensive direction:
 * it describes app-versus-model skew, so a whole suite refused for having no
 * user to attribute it to would have sent somebody to look for a contract bug.
 * See lib/agent-refusal.ts, which reads the refusal the caller passes here.
 */
export type AgentTurn =
  | { type: 'answer'; answer: BenchmarkAnswer }
  | { type: 'plan'; planId: string }
  | { type: 'clarification'; question: string; traceId: string | null }
  | { type: 'refused'; code: FailureCode; message: string; detail: string }
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

/**
 * Whose run this is, and what the credential behind it is good for.
 *
 * NOT OPTIONAL, and it replaced a bare `userEmail` rather than sitting beside
 * one. An email alone answers "who is this run filed under", which is a
 * question about the run list. The question that matters is "whose grants did
 * these scores come from", and while the two were separate fields the answer to
 * the second was the app's service principal on every run ever recorded while
 * the first said a person's name.
 */
export interface RunIdentity {
  /** The signed-in user the suite is attributed to AND executes as. */
  email: string;
  /** `signed_in_user`, or `app_service_principal` on a laptop with no proxy. */
  mode: string;
  /** Whether the forwarded token was proven to belong to `email`. */
  verified: boolean;
  lifetime: CredentialLifetime;
}

export interface BenchmarkRunnerDeps {
  store: BenchmarkStore;
  askAgent: AskAgent;
  judge: JudgeConfig;
  identity: RunIdentity;
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
  FROM ${APP_SCHEMA}.benchmark_suites
  WHERE id = ANY($1)`;

export const BENCHMARK_RUN_INSERT = `
  INSERT INTO ${APP_SCHEMA}.benchmark_runs (id, suite_id, user_email, status, metrics_json)
  VALUES ($1,$2,$3,$4,$5)`;

export const BENCHMARK_RUN_UPDATE = `
  UPDATE ${APP_SCHEMA}.benchmark_runs SET status = $2, metrics_json = $3 WHERE id = $1`;

/** The caller's own unfinished runs, for the stale sweep and the in-flight check. */
export const BENCHMARK_RUNNING_QUERY = `
  SELECT id, suite_id, metrics_json, created_at
  FROM ${APP_SCHEMA}.benchmark_runs
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

// ---------------------------------------------------------------------------
// The scorer set
//
// Runs on every case of every suite, beside the three MLflow judges rather than
// instead of them. The judges answer "was this answer any good"; the scorers
// answer "did the run hold the properties this product claims", which is a
// different question and mostly a deterministic one.
//
// NOTHING BELOW AFFECTS `decideOutcome`. A case's pass or fail is decided by the
// structural checks and the judges exactly as it was before the scorers existed,
// and a scorer saying no cannot fail a case. That is the non-gating decision in
// the one place it could most easily be lost: it would be a two-line change here
// to fold a scorer into the verdict, and the whole scope decision would be gone
// with no test failing. `benchmark-scorers.test.ts` pins it.
// ---------------------------------------------------------------------------

/**
 * The agent's answer, in the shape the scorers read.
 *
 * The scorers read the Python `custom_outputs` envelope rather than this
 * runner's `BenchmarkAnswer`, which is what lets one conformance fixture pin the
 * TypeScript scorers against the MLflow ones. See the header of
 * `shared/answer-scorers.ts`.
 *
 * `execution_identity` prefers the agent's own account of whose grants were in
 * force and falls back to what the app asserted when it sends one. The two
 * should agree -- the app forwards the caller's token and the agent reads it --
 * and the point of preferring the agent's is that a disagreement should surface
 * as a failing scorer rather than be papered over by the app grading itself.
 */
export function answerEnvelope(
  answer: BenchmarkAnswer | null,
  outcome: 'answer' | 'refusal' | 'clarification' | 'unavailable',
  identity: RunIdentity,
  extra?: { code?: string; message?: string }
): AnswerEnvelope {
  return {
    type: outcome,
    ...(answer ? { answer: answer as unknown as AnswerEnvelope['answer'] } : {}),
    ...(extra?.code ? { code: extra.code } : {}),
    ...(extra?.message ? { message: extra.message } : {}),
    execution_identity: answer?.execution_identity ?? { mode: identity.mode, verified: identity.verified },
    semantic_layer_tables: answer?.semantic_layer_tables ?? [],
  };
}

/** What a case was labelled as expecting, or nothing when it carries no labels. */
export function expectationsFor(caseId: string): CaseExpectations {
  return heldOutCase(caseId)?.expectations ?? {};
}

/**
 * One case's verdicts, in the scorecard's own vocabulary.
 *
 * The per-case shape reuses `ScorecardValue` with the counts collapsed to one
 * case, so the aggregate and the row are the same type and there is no second
 * definition of what a score is.
 */
export function scoreOneCase(
  envelope: AnswerEnvelope,
  caseId: string,
  judgements: BenchmarkJudgement[] = []
): ScorecardValue[] {
  const verdicts = scoreCase(envelope, expectationsFor(caseId));
  const rows: ScorecardValue[] = Object.entries(verdicts).map(([scorerId, verdict]) => ({
    scorerId,
    state: verdict.state,
    value: verdict.state === 'scored' ? Number(verdict.value) : null,
    scored: verdict.state === 'scored' ? 1 : 0,
    notApplicable: verdict.state === 'not-applicable' ? 1 : 0,
    errored: verdict.state === 'errored' ? 1 : 0,
    // CARRIED ON A PASS AS WELL AS A FAILURE. The first version of this dropped
    // the rationale whenever a scorer returned a value, on the reasoning that a
    // number speaks for itself. It does not: the first real run produced three
    // `sql_validity` failures and the scorecard could not say what was wrong
    // with any of them, which made the one genuinely actionable result on the
    // page unactionable.
    reason: verdict.rationale,
  }));
  rows.push(...judgedScores(caseId, judgements));
  // The three that cannot report here are listed on every case rather than
  // omitted, so an absent row never has to be noticed. See the catalog.
  for (const definition of unimplementableScorers()) {
    rows.push({
      scorerId: definition.id,
      state: 'unimplementable',
      value: null,
      scored: 0,
      notApplicable: 0,
      errored: 0,
      reason: definition.blockedReason,
    });
  }
  return rows;
}

/**
 * The two scorers that ask a model rather than check a property.
 *
 * BOTH READ A JUDGEMENT THE RUNNER ALREADY MADE rather than calling a judge
 * again. The held-out cases hand their own `expected_facts` to MLflow's
 * `guidelines` rubric as the rubric, so the verdict that rubric returns IS the
 * answer to "does this answer contain what the label says a good answer
 * contains". Asking a second time would double the judge spend to re-derive a
 * verdict already in hand, and the two answers would sometimes differ, leaving
 * nobody able to say which was the score.
 *
 * THEY NEVER BOTH REPORT ON THE SAME CASE, which is the point of splitting them.
 * On a refusal case the labelled facts are about conduct -- declined, explained,
 * published no restricted figure -- so the verdict is a refusal-quality verdict
 * and correctness abstains. On every other case it is the reverse. Scoring one
 * judgement under both names would put the same evidence into two rates and make
 * the pane look like it had measured twice.
 *
 * Both abstain outside the held-out set. A judgement against the POC suite's
 * guidelines is a real judgement, but it is not correctness against a labelled
 * set: those guidelines were written to demonstrate the product rather than to
 * be a standard, and reporting them under this name would quietly widen what the
 * word covers.
 */
export function judgedScores(caseId: string, judgements: BenchmarkJudgement[]): ScorecardValue[] {
  const held = heldOutCase(caseId);
  const scorerId = held?.expectations.is_refusal ? 'refusal_quality' : 'correctness';
  const other = scorerId === 'correctness' ? 'refusal_quality' : 'correctness';
  const abstain = (id: string, reason: string): ScorecardValue => ({
    scorerId: id,
    state: 'not-applicable',
    value: null,
    scored: 0,
    notApplicable: 1,
    errored: 0,
    reason,
  });

  if (!held) {
    const reason =
      'This case is not part of the held-out set, so it carries no label to be correct against and no ' +
      'expectation that the agent should decline.';
    return [abstain('correctness', reason), abstain('refusal_quality', reason)];
  }

  const paired = abstain(
    other,
    held.expectations.is_refusal
      ? "The correct behaviour on this case is to decline, so its labelled facts describe a refusal rather than " +
        'an answer. Scored under refusal_quality instead.'
      : 'This case does not ask for restricted data, so there is no refusal to judge.'
  );

  const judgement = judgements.find((entry) => entry.name === GUIDELINES_FEEDBACK_NAME);
  if (!judgement || judgement.state !== 'scored') {
    return [
      abstain(
        scorerId,
        judgement?.state === 'errored'
          ? `The judge could not be reached, so this case is unscored rather than failed: ${judgement.reason}`
          : 'No judgement was returned against this case\'s labelled facts.'
      ),
      paired,
    ];
  }
  return [
    {
      scorerId,
      state: 'scored',
      value: judgement.value === 'yes' ? 1 : 0,
      scored: 1,
      notApplicable: 0,
      errored: 0,
      reason: judgement.rationale || 'The judge returned no rationale.',
    },
    paired,
  ];
}

/**
 * A scorer's aggregate across the run.
 *
 * A RATE FOR A PASS-FAIL SCORER, A MEAN FOR AN OPERATIONAL ONE, and the catalog
 * decides which -- not the shape of the values. Both arrive here as numbers, and
 * inferring "this must be a rate because every value is 0 or 1" would silently
 * turn a token count that happened to be zero into a percentage.
 *
 * Abstentions and errors are in neither half of the denominator, for the reason
 * `summariseJudge` gives one screen up: a rubric that did not apply and a scorer
 * that threw are both absences of evidence, and folding either in makes a number
 * that reads as a rate out of a count nobody measured.
 */
export function aggregateScores(perCase: ScorecardValue[][]): ScorecardValue[] {
  return SCORER_CATALOG.map((definition) => {
    const mine = perCase.flatMap((row) => row.filter((entry) => entry.scorerId === definition.id));
    if (definition.availability === 'unimplementable') {
      return {
        scorerId: definition.id,
        state: 'unimplementable' as const,
        value: null,
        scored: 0,
        notApplicable: 0,
        errored: 0,
        reason: definition.blockedReason,
      };
    }
    const scored = mine.filter((entry) => entry.state === 'scored');
    const notApplicable = mine.filter((entry) => entry.state === 'not-applicable').length;
    const errored = mine.filter((entry) => entry.state === 'errored').length;
    if (scored.length === 0) {
      return {
        scorerId: definition.id,
        state: 'not-applicable' as const,
        value: null,
        scored: 0,
        notApplicable,
        errored,
        reason:
          mine.length === 0
            ? 'This scorer did not run on any case of this suite.'
            : `No case produced a value: ${notApplicable} abstained and ${errored} errored.`,
      };
    }
    const total = scored.reduce((sum, entry) => sum + (entry.value ?? 0), 0);
    const mean = total / scored.length;
    return {
      scorerId: definition.id,
      state: 'scored' as const,
      // Rates to four places, magnitudes to the nearest whole unit: a median
      // latency of 8123.4 ms claims a precision the measurement does not have.
      value: definition.unit === 'rate' ? Number(mean.toFixed(4)) : Math.round(mean),
      scored: scored.length,
      notApplicable,
      errored,
      reason: '',
    };
  });
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

/**
 * What one case produced, and whether the suite may continue after it.
 *
 * `fatal` is separate from the result rather than derivable from it because
 * they are different facts. The result says what happened to this question; the
 * fatal says whether asking the next one could tell anybody anything. Only an
 * identity-layer refusal sets it: see `endsTheSuite`.
 */
interface CaseOutcome {
  result: ScoredCase;
  fatal: { code: FailureCode; detail: string } | null;
}

/** A case result with the scorer set attached. See `ScoredCaseFields`. */
export type ScoredCase = BenchmarkCaseResult & ScoredCaseFields;

async function runCase(deps: BenchmarkRunnerDeps,
  runId: string,
  resolved: ResolvedCase
): Promise<CaseOutcome> {
  if (!resolved.question) return { result: unresolvedCase(resolved), fatal: null };
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

  /** The scorer set over whatever this case turned out to produce. */
  const score = (
    answer: BenchmarkAnswer | null,
    outcome: 'answer' | 'refusal' | 'clarification' | 'unavailable',
    extra?: { code?: string; message?: string; judgements?: BenchmarkJudgement[] }
  ): ScorecardValue[] =>
    scoreOneCase(answerEnvelope(answer, outcome, deps.identity, extra), resolved.caseId, extra?.judgements ?? []);

  let turns = 0;
  let answer: BenchmarkAnswer | null = null;
  let clarification: { question: string; traceId: string | null } | null = null;
  let refusal: { code: FailureCode; message: string; detail: string } | null = null;
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
    else if (turn.type === 'refused') refusal = { code: turn.code, message: turn.message, detail: turn.detail };
    else if (turn.type === 'plan') failure = `The agent proposed plan ${turn.planId} again after it was approved, so the case never ran.`;
    else failure = turn.detail;
  } catch (error) {
    failure = (error as Error).message;
  }

  const elapsed = now() - started;

  if (refusal) {
    // Never `failed`. The agent did not answer this question badly, it declined
    // to answer it, and folding a refusal into the failure count would make a
    // suite run by somebody without the grants read as an agent that gets
    // things wrong. Never `passed` either, for the obvious reason: nothing was
    // measured.
    const fatal = endsTheSuite(refusal.code);
    return {
      result: {
        ...base,
        outcome: 'errored',
        errorStage: 'identity',
        error: refusal.code,
        durationMs: elapsed,
        agentTotalMs: null,
        turns,
        mlflowTraceId: null,
        answerId: null,
        // THE ONE PLACE THE TWO KINDS OF REFUSAL HAVE TO BE TOLD APART. An
        // identity-layer refusal ends the suite: nothing was measured and the
        // error rate should say so. A scope refusal is the agent declining to
        // return restricted data, which is the behaviour this product exists to
        // demonstrate, and counting it as an error would report the agent's best
        // moment as its worst.
        scores: score(null, fatal ? 'unavailable' : 'refusal', { code: refusal.code, message: refusal.message }),
        note:
          `The agent refused this turn with ${refusal.code} rather than answering it` +
          `${refusal.message ? `: "${refusal.message}"` : ''}. Recorded as unscored. ` +
          (fatal
            ? 'This is a fact about the credential the whole run is executing under, not about this ' +
              'question, so the suite stopped here rather than asking the rest and being refused ' +
              'identically each time.'
            : 'This is a fact about the data this question needed and the grants of the person who ' +
              'started the run, so the remaining cases were still attempted.'),
      },
      fatal: fatal ? { code: refusal.code, detail: refusal.detail } : null,
    };
  }

  if (clarification) {
    return {
      result: {
        ...base,
        outcome: 'clarified',
        errorStage: null,
        error: null,
        durationMs: elapsed,
        agentTotalMs: null,
        turns,
        mlflowTraceId: clarification.traceId,
        answerId: null,
        scores: score(null, 'clarification', { message: clarification.question }),
        note:
          'The agent asked a question back instead of answering: ' +
          `"${clarification.question}". That is a real outcome of a run rather than a failure of one, so it is ` +
          'reported as its own state and is not counted as a pass.',
      },
      fatal: null,
    };
  }

  if (!answer) {
    return {
      result: {
        ...base,
        outcome: 'errored',
        errorStage: 'agent',
        error: failure ?? 'The agent endpoint returned nothing this runner could read.',
        durationMs: elapsed,
        agentTotalMs: null,
        turns,
        mlflowTraceId: null,
        answerId: null,
        scores: score(null, 'unavailable', { code: 'agent_returned_no_answer' }),
        note: `The agent produced no answer, so nothing was scored. ${failure ?? ''}`.trim(),
      },
      fatal: null,
    };
  }

  const context = buildRetrievalContext(answer);
  const structuralChecks = evaluateStructuralChecks(resolved.structuralChecks, answer);
  const judgements = await judgeCase(deps.judge, resolved, question, answer, context);
  const decided = decideOutcome(structuralChecks, judgements);

  return {
    result: {
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
      // Recorded beside the verdict, never folded into it. `decideOutcome` above
      // was given the checks and the judgements and not these.
      scores: score(answer, 'answer', { judgements }),
      note: context.truncated
        ? `${decided.note} The retrieved context was truncated to ${MAX_JUDGE_CONTEXT_CHARS} characters before judging.`
        : decided.note,
    },
    fatal: null,
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

/** What a run records about the identity it executed under. */
export function executionIdentityOf(identity: RunIdentity): BenchmarkExecutionIdentity {
  return {
    mode: identity.mode,
    email: identity.email,
    verified: identity.verified,
    credentialExpiresAt:
      identity.lifetime.expiresAtMs === null
        ? null
        : new Date(identity.lifetime.expiresAtMs).toISOString(),
  };
}

export function buildMetrics(input: {
  suite: SuiteIdentity;
  requestedSuiteId: string;
  cases: ScoredCase[];
  total: number;
  status: BenchmarkRunStatus;
  judgeEndpoint: string;
  servedModel: ServedModelReference;
  executedAs: BenchmarkExecutionIdentity;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  progress: { currentCaseId: string | null; currentCaseIndex: number | null };
  persistenceFailures: number;
  interrupted?: true;
  truncation?: BenchmarkTruncation;
}): BenchmarkRunMetrics & ScoredRunFields {
  const judgements = input.cases.flatMap((result) => result.judgements);
  const scoredCases = input.cases.filter((result) => Array.isArray(result.scores));
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
    executedAs: input.executedAs,
    // Present on every suite, absent only when no case has run yet. `nonGating`
    // is a literal on the record rather than a fact about the code: somebody
    // reading a stored run months from now should not have to find this file to
    // learn that none of these numbers stopped anything.
    ...(scoredCases.length > 0
      ? {
          scorecard: {
            aggregates: aggregateScores(scoredCases.map((result) => result.scores ?? [])),
            labelsReviewed: false,
            nonGating: true as const,
          },
        }
      : {}),
    startedAt: input.startedAt,
    heartbeatAt: input.heartbeatAt,
    finishedAt: input.finishedAt,
    // A truncated run is an interrupted one, so both are set from the one
    // event. `interrupted` is what the existing surfaces already read, and
    // `truncation` is what says why, so an older reader still gets the warning
    // even though it cannot render the reason.
    ...(input.interrupted || input.truncation ? { interrupted: true as const } : {}),
    ...(input.truncation ? { truncation: input.truncation } : {}),
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
  | {
      status: 400 | 401 | 409 | 503;
      body: { error: string; message: string; runId?: string };
      /**
       * Set only on an identity refusal, so the route can answer it in the same
       * terminal shape `POST /api/insights/ask` uses rather than inventing a
       * second vocabulary for the same event one page across.
       */
      refusal?: { code: FailureCode; detail: string };
    };

/**
 * The held-out set as the runner's own case list.
 *
 * DEFINED IN CODE RATHER THAN READ FROM LAKEBASE, unlike the POC suite, and the
 * difference is deliberate. A suite whose case list lives in a table can be
 * edited without a commit; an evaluation set that can be edited without a commit
 * is not held out from anything, because the cheapest response to a poor score
 * becomes changing the question. This list moves only through review.
 *
 * The guidelines handed to MLflow's `guidelines` judge are the case's own
 * `expected_facts`, so the rubric a case is judged against and the label a
 * reviewer would check are the same sentences rather than two paraphrases that
 * can drift.
 */
export function heldOutResolvedCases(): ResolvedCase[] {
  return HELD_OUT_CASES.map((entry) => ({
    caseId: entry.caseId,
    definition: null,
    question: entry.question,
    questionSource: 'catalog' as const,
    guidelines: [...entry.expectations.expected_facts],
    // Groundedness needs a retrieved document and a refusal retrieves nothing,
    // so the refusal cases carry the two rubrics that have a subject when the
    // correct behaviour is to decline. `refusal_quality` is the scorer that
    // judges those, and it abstains everywhere else.
    judges: entry.expectations.is_refusal
      ? [RELEVANCE_TO_QUERY_ASSESSMENT_NAME, GUIDELINES_FEEDBACK_NAME]
      : [GROUNDEDNESS_FEEDBACK_NAME, RELEVANCE_TO_QUERY_ASSESSMENT_NAME, GUIDELINES_FEEDBACK_NAME],
    // No structural check. Every one of them asserts that an answer carries
    // figures, charts, sources or SQL, and a correct refusal carries none of
    // those -- so on a third of this set they would fail the agent for behaving
    // exactly as it should. The scorers make the same assertions where they
    // apply and abstain where they do not, which is the shape this set needs.
    structuralChecks: [],
    judgeNotes: entry.expectations.is_refusal
      ? {
          [GROUNDEDNESS_FEEDBACK_NAME]:
            'The correct behaviour on this case is to decline, so the run retrieves no document and there is ' +
            'nothing for a groundedness rubric to check the response against.',
        }
      : {},
  }));
}

/**
 * The suite a requested id names, including the held-out set.
 *
 * Resolved here rather than by adding an entry to `SUITE_ALIASES`, because the
 * held-out set is not an alias of the POC suite and must never be confused with
 * it in the run list: the POC set is what this demo is tuned on and this one is
 * the set that is not.
 */
export function resolveSuiteIdentity(requestedId: string): SuiteIdentity | null {
  if (requestedId.trim() === HELD_OUT_SUITE_ID) {
    return { id: HELD_OUT_SUITE_ID, name: HELD_OUT_SUITE_NAME };
  }
  return canonicalSuite(requestedId);
}

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
  if (suite.id === HELD_OUT_SUITE_ID) {
    return { cases: heldOutResolvedCases(), source: 'catalog-fallback', suiteName: suite.name };
  }
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
  const budget = deps.suiteBudgetMs ?? DEFAULT_SUITE_BUDGET_MS;

  // BEFORE ANY READ OR WRITE, and before the suite id is even resolved, for the
  // reason the ask route states at the same point: a run that will not be
  // executed must leave nothing behind that says it was asked for.
  const covered = coverage(deps.identity.lifetime, now(), budget);
  if (!covered.covered) {
    return {
      status: 401,
      body: { error: 'benchmark_identity_expiring', message: covered.message },
      refusal: { code: covered.code, detail: covered.detail },
    };
  }

  const suite = resolveSuiteIdentity(deps.requestedSuiteId);
  if (!suite) {
    return {
      status: 400,
      body: {
        error: 'unknown_suite',
        message:
          `No benchmark suite is known by the id "${deps.requestedSuiteId}". Known ids: ` +
          `${[...Object.keys(SUITE_ALIASES), HELD_OUT_SUITE_ID].join(', ')}.`,
      },
    };
  }

  const sweep = await sweepStaleRuns({ store: deps.store, userEmail: deps.identity.email, now });
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
    executedAs: executionIdentityOf(deps.identity),
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
      deps.identity.email,
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
      `${servedModel.determinate ? `model version ${servedModel.version}` : 'an endpoint whose version is not determinate'}, ` +
      `executing as ${deps.identity.email} (${deps.identity.mode}). ${covered.note}`
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
  const results: ScoredCase[] = [];
  let persistenceFailures = 0;
  let truncation: BenchmarkTruncation | undefined;

  const persist = async (status: BenchmarkRunStatus, currentIndex: number | null, finished: boolean) => {
    const metrics = buildMetrics({
      suite: context.suite,
      requestedSuiteId: deps.requestedSuiteId,
      cases: results,
      total: context.cases.length,
      status,
      judgeEndpoint: deps.judge.judgeEndpoint,
      servedModel: context.servedModel,
      executedAs: executionIdentityOf(deps.identity),
      startedAt: context.startedAt,
      heartbeatAt: new Date(now()).toISOString(),
      finishedAt: finished ? new Date(now()).toISOString() : null,
      durationMs: finished ? now() - context.startedAtMs : null,
      progress: {
        currentCaseId: currentIndex === null ? null : (context.cases[currentIndex]?.caseId ?? null),
        currentCaseIndex: currentIndex,
      },
      persistenceFailures,
      ...(truncation ? { truncation } : {}),
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

  /**
   * Everything from `from` onwards, recorded as not attempted for a stated
   * reason.
   *
   * The alternative is a suite that finishes quietly on a shorter list than it
   * started with, which is the shape of every fabricated operational record
   * this project has had to remove: the numbers are all true and the
   * denominator is a lie.
   */
  const abandonFrom = (from: number, stage: 'budget' | 'identity', error: string, note: string) => {
    for (let remaining = from; remaining < context.cases.length; remaining += 1) {
      results.push({
        ...unresolvedCase(context.cases[remaining]),
        outcome: 'errored',
        errorStage: stage,
        error,
        question: context.cases[remaining].question,
        questionSource: context.cases[remaining].questionSource,
        note,
      });
    }
  };

  for (let index = 0; index < context.cases.length; index += 1) {
    const resolved = context.cases[index];
    if (now() - context.startedAtMs > budget) {
      const minutes = Math.round(budget / 60_000);
      // Recorded as a truncation, not only as a per-case error. Both stops leave
      // a run whose rates cover fewer cases than its total, and a reader has to
      // be told so before they compare the rates: without this, a suite that ran
      // out of time after two of ten cases showed a perfect groundedness rate
      // over two and said nothing about having stopped, because only the
      // identity refusal below set this field.
      truncation = {
        code: BUDGET_TRUNCATION_CODE,
        fromCaseIndex: index,
        unattempted: context.cases.length - index,
        detail: `the suite exceeded its ${minutes} minute budget after case ${index}`,
      };
      abandonFrom(index,
        'budget',
        `The suite exceeded its ${minutes} minute budget before this case ran.`,
        'The suite ran out of time before this case started, so it was not attempted. Counted as unscored, ' +
          'not as a pass and not dropped from the total.'
      );
      console.warn(`[benchmark] Run ${context.runId} stopped after case ${index}/${context.cases.length}: ` +
          `${minutes} minute budget exhausted. The remaining ${context.cases.length - index} case(s) were ` +
          'recorded as never attempted.'
      );
      break;
    }

    await persist('running', index, false);
    const { result, fatal } = await runCase(deps, context.runId, resolved);
    results.push(result);
    console.log(`[benchmark] Run ${context.runId} case ${index + 1}/${context.cases.length} ` +
        `${result.caseId}: ${result.outcome}${result.durationMs === null ? '' : ` in ${result.durationMs} ms`}`
    );
    if (fatal) {
      truncation = {
        code: fatal.code,
        fromCaseIndex: index + 1,
        unattempted: context.cases.length - index - 1,
        detail: fatal.detail,
      };
      abandonFrom(index + 1,
        'identity',
        fatal.code,
        `The suite stopped after case ${index + 1}: the endpoint refused the identity this run is ` +
          `executing under with ${fatal.code}, so no later case could have been answered either. ` +
          'Reported as never attempted rather than as failures of the agent.'
      );
      console.warn(`[benchmark] Run ${context.runId} stopped after case ${index + 1}/${context.cases.length}: ` +
          `the endpoint refused ${deps.identity.email} with ${fatal.code}. ${fatal.detail} Nothing was ` +
          "retried as the app's service principal."
      );
      break;
    }
  }

  const counts = countOutcomes(results, context.cases.length);
  const status = deriveStatus(counts);
  await persist(status, null, true);
  console.log(`[benchmark] Run ${context.runId} ${status}: ${counts.passed} passed, ${counts.failed} failed, ` +
      `${counts.errored} errored, ${counts.clarified} clarified, ${counts.unresolved} unresolved, of ` +
      `${counts.total} case(s) in ${now() - context.startedAtMs} ms` +
      `${truncation ? `, cut short after ${truncation.fromCaseIndex} by ${truncation.code}` : ''}. ` +
      'No rating was recorded. A rating is human input and this run has not been rated.'
  );
}
