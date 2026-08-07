/**
 * The single derivation of every headline the Benchmark Lab shows.
 */

/**
 * How many cases a judge actually reached a verdict on, and what happened to the
 * rest.
 *
 * `notApplicable` is the load-bearing field. The guidelines judge does not apply
 * to a case that has no guideline, and the governance refusal is scored by
 * guidelines alone, so a judge that did not apply must never be counted as, or
 * rendered as, a judge that said no. That distinction is the only reason a
 * correct refusal can pass.
 */
export interface BenchmarkJudgeRate {
  rate?: number | null;
  scored?: number | null;
  yes?: number | null;
  no?: number | null;
  notApplicable?: number | null;
  errored?: number | null;
}

/** Per-outcome case counts, which do not collapse into passed-versus-not. */
export interface BenchmarkCounts {
  total?: number | null;
  attempted?: number | null;
  passed?: number | null;
  failed?: number | null;
  errored?: number | null;
  clarified?: number | null;
  unresolved?: number | null;
}

/** The suite-level metrics a run records, exactly as `/api/runs/:id/trace` reports them. */
export interface BenchmarkMetrics {
  suiteId?: string | null;
  suiteName?: string | null;
  passed?: number | null;
  total?: number | null;
  groundedness?: number | null;
  relevance?: number | null;
  guidelines?: number | null;
  durationMs?: number | null;
  counts?: BenchmarkCounts | null;
  judgeRates?: {
    groundedness?: BenchmarkJudgeRate | null;
    relevance_to_context?: BenchmarkJudgeRate | null;
    guidelines?: BenchmarkJudgeRate | null;
  } | null;
  judge?: {
    endpoint?: string | null;
    promptVersion?: string | null;
    badge?: string | null;
    disclosure?: string | null;
    groundednessBasis?: string | null;
  } | null;
  servedModel?: {
    version?: string | null;
    entityName?: string | null;
    determinate?: boolean | null;
    note?: string | null;
  } | null;
}

/**
 * Where a run has got to.
 *
 * `partial` is first class, not a variety of failure: a suite where three cases
 * error and three answer is a real outcome that has to be reportable as such. It
 * is the outcome most likely to be quietly rounded into a pass rate.
 */
export type BenchmarkStatus = 'running' | 'complete' | 'partial' | 'failed' | 'unknown';

/** Anything not in this set means the run has not finished, so nothing is final yet. */
const TERMINAL_STATUSES = new Set<BenchmarkStatus>(['complete', 'partial', 'failed']);

export function benchmarkStatus(raw: string | null | undefined): BenchmarkStatus {
  const status = (raw ?? '').trim().toLowerCase();
  if (status === 'complete' || status === 'completed' || status === 'succeeded') return 'complete';
  if (status === 'partial') return 'partial';
  if (status === 'failed' || status === 'error') return 'failed';
  if (status === 'running' || status === 'pending' || status === 'queued' || status === 'in_progress') {
    return 'running';
  }
  return status ? 'unknown' : 'unknown';
}

export function isTerminal(status: BenchmarkStatus) {
  return TERMINAL_STATUSES.has(status);
}

export interface BenchmarkSummary {
  status: BenchmarkStatus;
  /** True while the run is still going, so the page must not present totals as final. */
  inProgress: boolean;
  /**
   * The pass count as a fraction of everything attempted, never as a bare rate.
   * A suite where three of ten cases error reads "5 of 10", so it can never be
   * reported as a score out of the seven that happened to produce an answer.
   */
  passedLabel: string;
  /**
   * The pass count is a verdict; this is the shape behind it. "2 of 6" alone
   * reads as a broken agent when relevance was 5 of 5 and the two cases the
   * demo turns on both passed, true, and misleading, which is its own kind of
   * dishonesty. Shown alongside so a reader gets the result rather than a grade.
   */
  outcomeLabel: string | null;
  /**
   * Whether every case actually produced an answer, which is a different question
   * from how the suite scored. A case that errored is the run not getting an
   * answer; a case that failed is a wrong answer. The status badge reports the
   * score, so this reports the execution, and neither speaks for the other.
   */
  executionNote: string | null;
  durationLabel: string;
  groundednessLabel: string;
  groundednessCoverage: string | null;
  relevanceLabel: string;
  relevanceCoverage: string | null;
  guidelinesLabel: string;
  guidelinesCoverage: string | null;
  /**
   * What scored this, on screen rather than only in `metrics_json`. A stakeholder
   * reading a score is entitled to know it came from MLflow's published prompt run
   * against a Claude endpoint and not from the Databricks managed judge service,
   * and to know which prompt version, because scores from different versions stop
   * being comparable and nobody remembers why.
   */
  judgeBadge: string | null;
  judgeDisclosure: string | null;
  groundednessBasis: string | null;
  /**
   * One execution against one model version, not a fixed grade. The agent varies
   * between runs while the judge is pinned at temperature zero, so anyone reading
   * a single run as a stable figure will be surprised later.
   */
  runCaveat: string | null;
  /**
   * Set when the stored numbers cannot all be true at once, more passes than
   * cases, a negative count, a rate outside 0–1. Shown to the reader rather than
   * silently rendered, because a self-contradicting run is a defect in whatever
   * wrote it and hiding that is how the fabricated tiles survived so long.
   */
  contradiction: string | null;
}

const ABSENT = 'Not reported';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Seconds below ninety, minutes and seconds above it.
 *
 * A suite takes four to five minutes, and "268.0s" makes the reader divide.
 */
export function formatDuration(ms: number) {
  if (ms < 90_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
}

/**
 * Formats a rubric's result over the cases its judge actually reached a verdict
 * on, which is not the same as the number of cases in the suite.
 */
function rateLabel(value: unknown, judge: BenchmarkJudgeRate | null | undefined) {
  if (!isFiniteNumber(value)) return ABSENT;
  if (value < 0 || value > 1) return ABSENT;
  const scored = judge?.scored;

  if (isFiniteNumber(scored) && scored > 0) {
    const yes = isFiniteNumber(judge?.yes) ? judge.yes : Math.round(value * scored);
    return `${yes} of ${scored} scored`;
  }
  // No per-judge detail, so the population is genuinely unknown. Said outright
  // rather than filled in from the case count, which is a different number.
  return `${Math.round(value * 100)}% (population not reported)`;
}

/**
 * What became of the cases a rubric did not score, said in words rather than
 * folded into the rate.
 */
function judgeCoverage(judge: BenchmarkJudgeRate | null | undefined, total: unknown): string | null {
  if (!judge) return null;
  const parts: string[] = [];
  if (isFiniteNumber(judge.notApplicable) && judge.notApplicable > 0) {
    parts.push(`${judge.notApplicable} did not apply`);
  }
  if (isFiniteNumber(judge.errored) && judge.errored > 0) {
    parts.push(`${judge.errored} could not be scored`);
  }
  if (parts.length === 0) {
    return isFiniteNumber(total) && total > 0 && isFiniteNumber(judge.scored) && judge.scored === total
      ? 'Scored on every case'
      : null;
  }
  return `${parts.join(', ')}, not counted as failures`;
}

export function benchmarkSummary(rawStatus: string | null | undefined,
  metrics: BenchmarkMetrics | null | undefined
): BenchmarkSummary {
  const status = benchmarkStatus(rawStatus);
  const inProgress = !isTerminal(status);
  const passed = metrics?.passed;
  const total = metrics?.total;
  const durationMs = metrics?.durationMs;

  const contradictions: string[] = [];
  if (isFiniteNumber(passed) && isFiniteNumber(total) && passed > total) {
    contradictions.push(`it records ${passed} passes out of ${total} cases`);
  }
  if (isFiniteNumber(passed) && passed < 0) contradictions.push('its pass count is negative');
  if (isFiniteNumber(total) && total < 0) contradictions.push('its case count is negative');
  if (isFiniteNumber(metrics?.groundedness) && (metrics.groundedness < 0 || metrics.groundedness > 1)) {
    contradictions.push('its groundedness is outside 0–1');
  }
  if (isFiniteNumber(metrics?.relevance) && (metrics.relevance < 0 || metrics.relevance > 1)) {
    contradictions.push('its relevance is outside 0–1');
  }

  // A pass count with no case count is not shown as a count. "8" alone reads as a
  // score, and the denominator is the whole point.
  const passedLabel =
    isFiniteNumber(passed) && isFiniteNumber(total) && passed <= total && total >= 0 ? `${passed} of ${total}` : ABSENT;

  const counts = metrics?.counts;
  const rates = metrics?.judgeRates;
  // Each outcome named, so an errored case is never read as a failed one. They
  // mean different things: one is the agent answering wrongly, the other is the
  // run not getting an answer at all, and averaging them hides a broken endpoint
  // behind a plausible-looking pass rate.
  const outcomeParts = ([
      ['passed', counts?.passed],
      ['failed', counts?.failed],
      ['errored', counts?.errored],
      ['asked to clarify', counts?.clarified],
      ['never ran', counts?.unresolved],
    ] as const
  )
    .filter(([, value]) => isFiniteNumber(value) && value > 0)
    .map(([name, value]) => `${value as number} ${name}`);

  // Cases that never produced an answer at all. Kept apart from cases that
  // answered wrongly, because a suite can score badly while running perfectly and
  // a broken endpoint can hide behind a plausible pass rate otherwise.
  const incomplete: string[] = [];
  if (isFiniteNumber(counts?.errored) && counts.errored > 0) {
    incomplete.push(`${counts.errored} ${counts.errored === 1 ? 'case' : 'cases'} errored`);
  }
  if (isFiniteNumber(counts?.unresolved) && counts.unresolved > 0) {
    incomplete.push(`${counts.unresolved} never ran`);
  }

  const servedVersion = metrics?.servedModel?.version;
  const runCaveat = inProgress
    ? null
    : `These are the results of one run${
        typeof servedVersion === 'string' && servedVersion
          ? ` against model version ${servedVersion}`
          : ' against the version then serving'
      }, not a fixed score for the agent. The agent varies between runs; the judge is pinned at temperature zero.`;

  return {
    status,
    inProgress,
    passedLabel,
    outcomeLabel: outcomeParts.length > 0 ? outcomeParts.join(' · ') : null,
    executionNote: incomplete.length > 0 ? `${incomplete.join(' and ')}, so this run did not fully execute.` : null,
    durationLabel: isFiniteNumber(durationMs) && durationMs >= 0 ? formatDuration(durationMs) : ABSENT,
    groundednessLabel: rateLabel(metrics?.groundedness, rates?.groundedness),
    groundednessCoverage: judgeCoverage(rates?.groundedness, total),
    relevanceLabel: rateLabel(metrics?.relevance, rates?.relevance_to_context),
    relevanceCoverage: judgeCoverage(rates?.relevance_to_context, total),
    guidelinesLabel: rateLabel(metrics?.guidelines, rates?.guidelines),
    guidelinesCoverage: judgeCoverage(rates?.guidelines, total),
    judgeBadge: metrics?.judge?.badge ?? null,
    judgeDisclosure: metrics?.judge?.disclosure ?? null,
    groundednessBasis: metrics?.judge?.groundednessBasis ?? null,
    runCaveat,
    contradiction:
      contradictions.length > 0
        ? `This run's stored metrics contradict each other: ${contradictions.join(', and ')}.`
        : null,
  };
}

/**
 * How a run's outcome is worded, so the badge and the sentence cannot drift apart.
 *
 * These describe how the suite *scored*, which is not the same as whether it
 * *ran*. The stored status is a scoring verdict (`partial` means some cases
 * passed and some did not), so wording it "Partly failed" said the run itself
 * broke, which for five of six passing is false and is the reading a customer
 * would take from the badge. Whether every case actually produced an answer is a
 * separate question, answered by `executionNote` and the outcome breakdown.
 */
export function benchmarkStatusLabel(status: BenchmarkStatus) {
  switch (status) {
    case 'complete':
      return 'All cases passed';
    case 'partial':
      return 'Mixed result';
    case 'failed':
      return 'No cases passed';
    case 'running':
      return 'Running';
    default:
      return 'Unknown';
  }
}

/**
 * A run's own rating, which is legitimately absent.
 *
 * The runner never invents one (a person rates a run afterwards through the
 * feedback path), so "nobody has rated this" is a normal state and must not render
 * as an empty star, which reads as a rating of zero.
 */
export function ratingLabel(rating: number | null | undefined) {
  return isFiniteNumber(rating) ? { rated: true as const, value: rating } : { rated: false as const };
}
