/**
 * The shape of a benchmark run, and the disclosure that has to travel with its
 * scores.
 *
 * Shared rather than server-only for the same reason `representative-answer.ts`
 * is: the Benchmark Lab and Run Explorer render these values, and the one thing
 * that must not drift between the two halves of the app is what a number means.
 * The previous benchmark route returned constants (8 of 10, groundedness 0.92,
 * a five-star rating nobody gave), and the panes rendered them with no caveat,
 * so there was nothing to disagree with. Now that the numbers are measured, the
 * vocabulary for describing them is declared once, here.
 */

// ---------------------------------------------------------------------------
// Judge provenance
//
// The scores are real, and they are NOT the Databricks managed MLflow judge.
// That distinction has to be visible wherever a score is displayed, because it
// is the first question anyone technical will ask, and the honest answer should
// not depend on someone remembering it.
// ---------------------------------------------------------------------------

/**
 * The MLflow release whose judge prompts were ported.
 */
export const MLFLOW_JUDGE_PROMPT_VERSION = 'mlflow-3.14.0';

/** The judge model endpoint used when nothing overrides it. */
export const DEFAULT_JUDGE_ENDPOINT = 'databricks-claude-sonnet-4-5';

/**
 * A short label for a score chip or table header. Must appear next to any
 * displayed judge score.
 */
export function judgeBadgeLabel(judgeEndpoint: string): string {
  return `LLM judge · MLflow prompt · ${judgeEndpoint}`;
}

/**
 * The full sentence, for a tooltip, a footnote, or a stakeholder asking what
 * scored this. Deliberately says what it is *not*, because "MLflow judge" alone
 * would be heard as the managed service.
 */
export function judgeDisclosure(judgeEndpoint: string): string {
  return (`Scored by MLflow ${MLFLOW_JUDGE_PROMPT_VERSION.replace('mlflow-', '')}'s published judge ` +
    `prompts, run against the ${judgeEndpoint} serving endpoint through the same transport the ` +
    `app uses to call the agent. This is not the Databricks managed judge service: the prompts ` +
    `and the yes/no parsing are MLflow's, the model answering them is ${judgeEndpoint}.`
  );
}

/**
 * What the groundedness score is a statement about. Rendered wherever a
 * groundedness number appears.
 */
export const GROUNDEDNESS_BASIS =
  "The groundedness document is what the agent's own trace disclosed for that answer: its stage output, the " +
  'SQL it ran, and the figures and sources it returned. A `no` therefore means the answer asserted something ' +
  'the app cannot substantiate from what it showed the user, which is not the same as contradicting the ' +
  'underlying data.';

/**
 * The per-case provenance string stored against every individual judgement.
 *
 * One sentence per score rather than one per run, so a rationale copied out of
 * the data carries its own attribution.
 */
export function judgeProvenance(judgeName: string, judgeEndpoint: string): string {
  return (`MLflow ${MLFLOW_JUDGE_PROMPT_VERSION.replace('mlflow-', '')} ${judgeName} prompt, ` +
    `run against databricks:/${judgeEndpoint}`
  );
}

// ---------------------------------------------------------------------------
// Per-case outcomes
// ---------------------------------------------------------------------------

/**
 * What happened to one benchmark case. Five states, none of which may be
 * collapsed into another.
 *
 * `passed`      the agent answered, every structural check held, and every
 *               applicable judge said yes.
 * `failed`      the agent answered and something measurable was wrong: a
 *               structural check, or a judge saying no.
 * `errored`     no usable measurement. See `errorStage`: an `agent` error means
 *               the endpoint never produced an answer; a `judge` error means it
 *               did and the scoring could not be obtained. Both are unknown
 *               rather than bad, which is why neither is `failed`.
 * `clarified`   the agent asked a question back instead of answering. A real
 *               and legitimate outcome of a run, not a failure of one.
 * `unresolved`  the suite named a case id with no question anywhere. Nothing
 *               ran, so it is neither pass nor fail, but it is counted, so a
 *               suite cannot get shorter by naming cases that do not exist.
 */
export type BenchmarkCaseOutcome = 'passed' | 'failed' | 'errored' | 'clarified' | 'unresolved';

/**
 * Which half of a case produced the error. Null unless `outcome` is `errored`.
 *
 * `identity` is separate from `agent` because they send a reader to different
 * places. An `agent` error is the endpoint failing to produce an answer, which
 * is a fault to investigate. An `identity` error is the run's own credential
 * being refused or having run out, which is a fact about who started the suite
 * and when, and is the expected outcome of a benchmark started by somebody
 * without the grants the questions need.
 */
export type BenchmarkErrorStage = 'agent' | 'judge' | 'budget' | 'identity' | 'cancel' | null;

/**
 * The state of one judgement.
 *
 * `not-applicable` is the load-bearing one. The access-boundary case is a
 * governance refusal, and the correct behaviour there is to decline: the
 * groundedness rubric has no document to check a claim against and the
 * relevance rubric has no supplied information to weigh, so neither applies.
 * Rendering that as a judge that failed would make a correct refusal look like
 * a defect, and rendering it as a judge that passed would credit a check that
 * never ran. It is its own state, it carries its own reason, and it is excluded
 * from both the numerator and the denominator of any rate.
 */
export type JudgeState = 'scored' | 'not-applicable' | 'errored';

export interface BenchmarkJudgement {
  /** MLflow's own assessment name: `groundedness`, `relevance_to_context`, `guidelines`. */
  name: string;
  state: JudgeState;
  /** MLflow's categorical verdict. Null unless `state` is `scored`. */
  value: 'yes' | 'no' | null;
  /** MLflow's rationale, with its `Let's think step by step` preamble stripped as MLflow does. */
  rationale: string;
  /** Why it did not apply, or what went wrong. Empty when `state` is `scored`. */
  reason: string;
  provenance: string;
  promptVersion: string;
  judgeEndpoint: string;
  durationMs: number | null;
}

/** A deterministic assertion about the answer's shape. Not an LLM opinion. */
export interface BenchmarkStructuralCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface BenchmarkCaseResult {
  caseId: string;
  /** Null when `outcome` is `unresolved`. */
  question: string | null;
  /** Where the question came from: the suite row, or the server-side catalog. */
  questionSource: 'suite-row' | 'catalog' | null;
  outcome: BenchmarkCaseOutcome;
  errorStage: BenchmarkErrorStage;
  error: string | null;
  /** Wall time this app measured across every turn of the case. */
  durationMs: number | null;
  /**
   * The agent's own `trace.totalMs`, kept separate rather than reconciled.
   * They measure different things (this one excludes the network and the plan
   * approval round trip), and this codebase already refuses to fold two such
   * numbers into one.
   */
  agentTotalMs: number | null;
  /** 1, or 2 when the agent proposed a plan that had to be approved first. */
  turns: number;
  mlflowTraceId: string | null;
  answerId: string | null;
  structuralChecks: BenchmarkStructuralCheck[];
  judgements: BenchmarkJudgement[];
  /** Tokens from the agent trace when it recorded them. Never invented. */
  tokens?: number | null;
  /** Compact per-stage kinds. No input or output (PII). Duration lives on the case. */
  stages?: { id: string; name: string; kind: string; status: string }[];
  /** Plain-language statement of why this case ended where it did. */
  note: string;
}

// ---------------------------------------------------------------------------
// Run-level shape
// ---------------------------------------------------------------------------

/**
 * `running` is a real, pollable state: a suite takes minutes, so the row exists
 * before it has results.
 */
export type BenchmarkRunStatus = 'running' | 'complete' | 'partial' | 'failed';

/** One judge's aggregate, with its denominator alongside it, always. */
export interface BenchmarkJudgeRate {
  /** yes ÷ scored, or null when nothing was scored. Never 0 for "unmeasured". */
  rate: number | null;
  /** Judgements that produced a verdict. The denominator of `rate`. */
  scored: number;
  yes: number;
  no: number;
  notApplicable: number;
  errored: number;
}

export interface BenchmarkCounts {
  /** Cases the suite names. The denominator that matters to a reader. */
  total: number;
  /** Cases with a question that were actually attempted. */
  attempted: number;
  passed: number;
  failed: number;
  errored: number;
  clarified: number;
  unresolved: number;
}

export interface BenchmarkProgress {
  completed: number;
  total: number;
  currentCaseId: string | null;
  currentCaseIndex: number | null;
}

/**
 * Which model version answered.
 *
 * `version` is populated only when one route carries all the traffic. A split
 * endpoint cannot attribute a run to a version, and guessing the majority
 * route would be a fabrication of exactly the kind this work removes, so
 * `determinate` says which case it is and `routes` shows the reader the split.
 */
export interface ServedModelReference {
  endpoint: string;
  entityName: string | null;
  version: string | null;
  determinate: boolean;
  routes: { name: string; trafficPercentage: number }[];
  note: string;
}

/**
 * Whose grants a suite executed under.
 *
 * A benchmark runs as the person who started it, so its scores are a statement
 * about the agent AS SEEN BY THAT ACCOUNT. There is no privileged benchmark
 * identity to compare against, deliberately: the alternative was exempting
 * benchmarks from the identity gate, which would have made this the one surface
 * in the app whose numbers came from a code path no real question takes.
 */
export interface BenchmarkExecutionIdentity {
  /** `signed_in_user`, or `app_service_principal` on a laptop with no proxy. */
  mode: string;
  /** The account the run is attributed to. */
  email: string;
  /** Whether the forwarded token was PROVEN to belong to `email`. */
  verified: boolean;
  /**
   * When the credential stops being accepted, or null when it would not say.
   *
   * Null is ordinary: an opaque token declares no expiry, so the runner cannot
   * check ahead and finds out at the endpoint instead. Recorded either way, so
   * a truncated run can be read against how much time it actually had.
   */
  credentialExpiresAt: string | null;
}

/**
 * The code recorded when a suite stopped because it ran out of time.
 *
 * Not a member of the failure taxonomy, deliberately: nothing refused anything,
 * the suite simply had a budget and reached it. Kept as a named constant because
 * the Benchmark Lab reads it to decide whether the truncation was about the run's
 * credential, and a string compared in two places drifts.
 */
export const BUDGET_TRUNCATION_CODE = 'SUITE_BUDGET_EXHAUSTED';

/**
 * Why a run stopped because the reader asked it to, rather than because the
 * suite ran out of time or the credential died.
 */
export const SUITE_CANCELLED_CODE = 'SUITE_CANCELLED';

/**
 * Why a run stopped before attempting every case it named.
 *
 * One shape rather than a reason enum, and `code` carries which reason it was.
 * Two of them are about the run's own credential: `IDENTITY_REQUIRED` is a run
 * that had no user to be, which is a deployment fault, and `USER_AUTH_REJECTED`
 * is a credential that stopped being accepted partway, which is a suite that
 * outlived the session that started it. In both, every later case would have been
 * refused the same way. The third, `BUDGET_TRUNCATION_CODE`, is the suite reaching
 * its time budget, which refuses nobody and still leaves the rates covering fewer
 * cases than the total — which is why it belongs here rather than only in the
 * abandoned cases' own notes, where it used to live alone.
 */
export interface BenchmarkTruncation {
  /** The taxonomy code, so this is triaged with every other identity failure. */
  code: string;
  /** Index of the first case that was not attempted. */
  fromCaseIndex: number;
  /** How many cases the suite never got to. */
  unattempted: number;
  detail: string;
}

/**
 * Everything written to `benchmark_runs.metrics_json`.
 *
 * NOTE THE ABSENT KEY. There is no `rating`. A rating is human input, the app
 * has a feedback path for it, and a benchmark run has none until a person gives
 * one. `RUNS_QUERY` reads `metrics_json->>'rating'`, so omitting the key is what
 * makes the run list render no stars rather than five nobody awarded.
 */
export interface BenchmarkRunMetrics {
  /** Canonical suite id, after alias reconciliation. */
  suiteId: string;
  suiteName: string;
  /** What the caller asked for, when it differed from the canonical id. */
  requestedSuiteId: string;
  /** The run-list label. `RUNS_QUERY` reads this key. */
  prompt: string;
  status: BenchmarkRunStatus;
  counts: BenchmarkCounts;
  groundedness: number | null;
  relevance: number | null;
  guidelines: number | null;
  judgeRates: {
    groundedness: BenchmarkJudgeRate;
    relevance_to_context: BenchmarkJudgeRate;
    guidelines: BenchmarkJudgeRate;
  };
  /** Named `Guidelines(name=…)` and multi-turn rates, keyed by assessment name. */
  extraJudgeRates?: Record<string, BenchmarkJudgeRate>;
  /** Suite wall time. `durationMs` for the trace route, `duration_ms` for `RUNS_QUERY`. */
  durationMs: number | null;
  duration_ms: number | null;
  medianCaseMs: number | null;
  /** Kept for the existing trace-route projection, which reads these two names. */
  passed: number;
  total: number;
  cases: BenchmarkCaseResult[];
  progress: BenchmarkProgress;
  judge: {
    endpoint: string;
    promptVersion: string;
    badge: string;
    disclosure: string;
    /**
     * What the groundedness rubric checked the answer against.
     */
    groundednessBasis: string;
  };
  servedModel: ServedModelReference;
  /**
   * Whose credential the suite executed under, and for how long it was good for.
   *
   * On the record rather than only in the server log, because "these scores were
   * produced under this person's grants" is the claim a benchmark makes, and a
   * suite run by an account with wider access scores differently from one run by
   * a reader. Absent on rows written before benchmarks were bound to a user.
   */
  executedAs?: BenchmarkExecutionIdentity;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  /**
   * True when the run did not get to the end of its own case list: a process
   * died mid-suite and the row was swept, or the credential it was executing
   * under ran out. See `truncation` for which.
   */
  interrupted?: true;
  /**
   * Why a run stopped before attempting every case it named.
   *
   * Absent on a run that attempted its whole list, however badly that went. A
   * suite that was cut short and one that ran to the end and scored zero are
   * different events, and only this distinguishes them once the row is stored.
   */
  truncation?: BenchmarkTruncation;
  /** Writes to Lakebase that failed during the run, so a gap is visible. */
  persistenceFailures: number;
  runnerVersion: string;
  /** Which bake-off side this run was started as, when the caller named one. */
  bakeOffSide?: 'baseline' | 'candidate';
  /** Dataset, judges, and endpoint as they stood when the run started. */
  configurationSnapshot?: {
    suiteId: string;
    caseCount: number;
    judgeEndpoint: string;
    agentEndpoint: string;
    enabledJudges: string[];
  };
  /** Set when the reader asked the suite to stop. Survives until the next persist merge. */
  cancelRequested?: true;
}

/**
 * The runner that produced a row, so a stored result can be read against the
 * code that made it. Bumped when the meaning of a field changes.
 *
 * `benchmark-runner-1` rows carry no `executedAs`, and that absence is load
 * bearing rather than cosmetic: those suites invoked the endpoint with the
 * app's own service principal, so their scores describe the agent under an
 * application's grants and are not comparable with anything recorded since.
 */
export const BENCHMARK_RUNNER_VERSION = 'benchmark-runner-2';
