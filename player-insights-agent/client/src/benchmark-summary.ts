/**
 * The single derivation of every headline the Benchmark Lab shows.
 */
import { FAILURE_TAXONOMY } from '../../shared/failure-taxonomy';

/**
 * The truncation codes that are about the run's own credential.
 *
 * Read off the taxonomy's own `layer`, the way the runner decides which refusal
 * ends a suite, rather than from a list of codes written here: a code added to
 * the taxonomy later inherits the right wording instead of quietly falling into
 * the wrong branch of a list nobody updated.
 */
const IDENTITY_TRUNCATION_CODES = new Set<string>(
  Object.values(FAILURE_TAXONOMY)
    .filter((definition) => definition.layer === 'identity')
    .map((definition) => definition.code)
);

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

/**
 * One case's own record, as the run stored it.
 *
 * Read straight off `metrics_json`, which has carried a `cases` array since the
 * runner was rewritten: every field here is optional because a run recorded
 * before then has none of them, and an older run must render as a run with no
 * per-case record rather than as a run whose cases all failed.
 */
export interface BenchmarkCaseRecord {
  caseId?: string | null;
  question?: string | null;
  outcome?: string | null;
  /** Which half of the case produced the error, when one did. */
  errorStage?: string | null;
  durationMs?: number | null;
  /** The runner's own sentence about what happened, which is the honest part. */
  note?: string | null;
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
  /**
   * What each case did, when the run recorded it.
   *
   * The trace projection is a loose object and spreads the whole of
   * `metrics_json`, so this reaches the browser already. Declared here because
   * the Per-case results panel spent a release saying no such record existed
   * while the record was sitting in the payload it was reading.
   */
  cases?: BenchmarkCaseRecord[] | null;
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
  /**
   * Whose grants the suite executed under.
   *
   * Absent on any run recorded before benchmarks were bound to a user, and that
   * absence is not cosmetic: those suites ran as the app's own service
   * principal, so their scores describe the agent under an application's access
   * and are not comparable with anything since. The page says so rather than
   * rendering them alongside as though they were the same measurement.
   */
  executedAs?: {
    mode?: string | null;
    email?: string | null;
    verified?: boolean | null;
    credentialExpiresAt?: string | null;
  } | null;
  /** Set when the run stopped before attempting every case it named. */
  truncation?: {
    code?: string | null;
    fromCaseIndex?: number | null;
    unattempted?: number | null;
    detail?: string | null;
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
   * Which population the pass count is out of, said under the fraction.
   *
   * The tile's caption is the denominator's meaning, and it is the one thing on
   * this row that cannot be left to the reader: "9 / 12" is only "of cases that
   * ran" when all twelve were actually tried. A run that stopped early, or that
   * named a case with no question behind it, gets the shortfall named here
   * instead, because the fraction on its own reads as a score over a suite that
   * was never fully attempted.
   */
  passedCoverage: string | null;
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
  /** How many cases that duration covers, so a suite time is never read per case. */
  durationCoverage: string | null;
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
  /**
   * The serving endpoint that answered the judge prompts, and the prompt version
   * it answered, both as the run recorded them.
   *
   * Named on the ledger row rather than left in the badge's phrasing because
   * these are the two facts that decide whether two runs' scores can be compared
   * at all. Null on a run that did not record them, and null is rendered as
   * nothing rather than as a default endpoint name: the endpoint the app happens
   * to be configured with today is not evidence about a run from last week.
   */
  judgeEndpoint: string | null;
  judgePromptVersion: string | null;
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
  /**
   * Set when the run stopped before it had attempted every case it named.
   *
   * Its own field rather than folded into `executionNote`, because they answer
   * different questions and the difference is the one a reader most needs. A
   * case that errored is a case that was tried; a case in a truncated suite was
   * never tried at all, and the rates above it are counted over a population
   * that stopped early. A suite of ten cut short after two can show a perfect
   * groundedness rate over two scored cases, and without this sentence next to
   * it that reads like a good result.
   */
  truncationNote: string | null;
  /**
   * Whose grants produced these scores.
   *
   * A benchmark runs as the person who started it, so the same suite genuinely
   * scores differently for two readers with different access. That makes the
   * identity part of the result rather than metadata about it, and a score
   * shown without it invites a comparison between two runs that were never
   * measuring the same thing.
   */
  executedAsNote: string | null;
  /**
   * Who that identity was, as the ledger row's own lead.
   *
   * Split from the sentence so the row opens with the address rather than
   * burying it mid-paragraph: it is the fact a reader comparing two runs needs
   * first. Null when the run recorded no identity at all, which is its own row
   * and not a blank one.
   */
  executedAsIdentity: string | null;
  /** The model version these scores belong to, when the run pinned one down. */
  servedVersion: string | null;
}

const ABSENT = 'Not recorded';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A recorded string, or nothing. An empty string is a field nobody filled in. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * What the pass fraction's denominator actually is.
 *
 * "of cases that ran" is only sayable when every case in the suite was tried, so
 * the two ways that can be false each get named instead: a run cut short, and a
 * case the suite listed with no question behind it. Both leave the total intact
 * on purpose — a suite must not get shorter by failing — which is exactly why the
 * caption has to say so.
 */
function passedCoverage(
  passedLabel: string,
  total: unknown,
  unattempted: number | null,
  unresolved: unknown
): string | null {
  if (passedLabel === ABSENT || !isFiniteNumber(total)) return null;
  if (unattempted !== null && unattempted > 0) {
    return `of the ${total} in the suite · ${unattempted} never attempted`;
  }
  if (isFiniteNumber(unresolved) && unresolved > 0) {
    return `of the ${total} in the suite · ${unresolved} never ran`;
  }
  return 'of cases that ran';
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
 * What became of the cases a rubric did not score, said in words rather than
 * folded into the rate.
 */
function judgeExclusions(judge: BenchmarkJudgeRate | null | undefined): string | null {
  if (!judge) return null;
  const parts: string[] = [];
  if (isFiniteNumber(judge.notApplicable) && judge.notApplicable > 0) {
    parts.push(`${judge.notApplicable} did not apply`);
  }
  if (isFiniteNumber(judge.errored) && judge.errored > 0) {
    parts.push(`${judge.errored} could not be scored`);
  }
  return parts.length === 0 ? null : `${parts.join(', ')}, not counted as failures`;
}

/**
 * A rubric's result and the population it was measured over, as the two lines of
 * one tile.
 *
 * The pair is the point. A rate is only meaningful beside the count of cases the
 * judge actually reached a verdict on, so `coverage` is never null while there is
 * a rate to show: an unknown population is said outright, because filling it in
 * from the case count would state something the run does not claim. `form`
 * follows the design — the two rubrics that apply broadly read as a percentage
 * over a named population, and guidelines, whose population moves case by case,
 * reads as the fraction itself.
 */
function rateFigures(
  value: unknown,
  judge: BenchmarkJudgeRate | null | undefined,
  form: 'percent' | 'fraction',
  population: string
): { label: string; coverage: string } {
  const scored = judge?.scored;
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    return {
      label: ABSENT,
      // Which kind of absence, because they are different facts: a rubric no
      // case applied to was measured and found inapplicable, where a run with no
      // judge record never measured it.
      coverage:
        isFiniteNumber(scored) && scored === 0
          ? 'No case reached a verdict on this rubric'
          : 'Not recorded by this run',
    };
  }
  if (!isFiniteNumber(scored) || scored <= 0) {
    return { label: `${Math.round(value * 100)}%`, coverage: 'Population not reported' };
  }
  const yes = isFiniteNumber(judge?.yes) ? judge.yes : Math.round(value * scored);
  const exclusions = judgeExclusions(judge);
  const base = form === 'fraction' ? population : `of ${scored} judged ${scored === 1 ? 'case' : 'cases'}`;
  return {
    label: form === 'fraction' ? `${yes} / ${scored}` : `${Math.round(value * 100)}%`,
    coverage: exclusions ? `${base} · ${exclusions}` : base,
  };
}

export function benchmarkSummary(
  rawStatus: string | null | undefined,
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
    isFiniteNumber(passed) && isFiniteNumber(total) && passed <= total && total >= 0 ? `${passed} / ${total}` : ABSENT;

  const counts = metrics?.counts;
  const rates = metrics?.judgeRates;
  // Each outcome named, so an errored case is never read as a failed one. They
  // mean different things: one is the agent answering wrongly, the other is the
  // run not getting an answer at all, and averaging them hides a broken endpoint
  // behind a plausible-looking pass rate.
  const outcomeParts = (
    [
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

  // Read off the stored record rather than inferred from the counts. A suite
  // that was cut short and one that ran to the end and errored on its last
  // cases produce the same tallies, and only the writer knew which happened.
  const truncation = metrics?.truncation;
  const unattempted = truncation ? (isFiniteNumber(truncation.unattempted) ? truncation.unattempted : null) : null;
  // The cases the rates actually cover, from the suite total less the cases the
  // run never reached. Deliberately not `counts.attempted`, which counts an
  // abandoned case as attempted because the runner records one with an
  // `errorStage` rather than dropping it, so it is the wrong number for this
  // sentence by exactly the amount that matters.
  const ran = isFiniteNumber(total) && unattempted !== null ? total - unattempted : null;
  // The reason comes from the record, never from this file. It used to be
  // written here as "the endpoint refused the identity it was executing under",
  // which was true of the only truncation the runner then wrote and became a
  // false statement about a run that simply ran out of time.
  const truncationCause = truncation
    ? [
        truncation.code ? `The code recorded for it is ${truncation.code}` : 'The run recorded no code for it',
        textOrNull(truncation.detail),
      ]
        .filter((part): part is string => Boolean(part))
        .join(': ')
    : null;
  const truncationNote = truncation
    ? `${truncationCause}${truncationCause?.endsWith('.') ? '' : '.'} ` +
      `${
        unattempted === null
          ? 'The cases it never reached were not attempted'
          : `${unattempted} ${unattempted === 1 ? 'case was' : 'cases were'} never attempted`
      }, and are counted in the total rather than dropped from it. Rates below cover only the ` +
      `${ran === null ? 'cases' : `${ran} ${ran === 1 ? 'case' : 'cases'}`} that ran, not the whole suite.` +
      // Only where it answers a question the reader is actually asking. A
      // credential refused partway invites "did it fall back to the app's own
      // access, then?", and the answer is no. A suite that ran out of time
      // raises nothing of the kind, and the sentence there is noise.
      `${truncation.code && IDENTITY_TRUNCATION_CODES.has(truncation.code) ? ' Nothing was retried under any other identity.' : ''}`
    : null;

  const executedAs = metrics?.executedAs;
  const executedAsEmail = textOrNull(executedAs?.email) ?? '';
  let executedAsNote: string | null = null;
  let executedAsIdentity: string | null = null;
  if (executedAs && executedAs.mode === 'signed_in_user' && executedAsEmail) {
    executedAsIdentity = executedAsEmail;
    executedAsNote =
      `It ran under that account's own permissions, through the same path a question from the Ask page takes. ` +
      `The same suite genuinely scores differently for readers with different access.${
        executedAs.verified === true
          ? ''
          : ' The forwarded session could not be proven to belong to that address, so the attribution is the ' +
            "platform's word rather than something this app checked."
      }`;
  } else if (executedAs && executedAsEmail) {
    // The laptop case, and the only mode that is not a person. Named rather
    // than left blank: a score produced under an application's grants is not
    // comparable with one produced under a reader's.
    executedAsIdentity = 'the application, not as a person';
    executedAsNote =
      "Its scores reflect the app's own access and not any reader's, and that mode is only reachable with no " +
      'Apps proxy in front of the server.';
  } else if (metrics && !executedAs) {
    executedAsNote =
      'It predates benchmarks being bound to a user and ran as the application, so its scores are not ' +
      'comparable with a run that executed as a reader.';
  }

  const servedVersion = textOrNull(metrics?.servedModel?.version);
  const runCaveat = inProgress
    ? null
    : 'These are the results of a single run, not a fixed score for the agent. The agent varies between runs; ' +
      'the judge is pinned at temperature zero.';

  const groundedness = rateFigures(metrics?.groundedness, rates?.groundedness, 'percent', '');
  const relevance = rateFigures(metrics?.relevance, rates?.relevance_to_context, 'percent', '');
  // Guidelines reads as its own fraction rather than as a percentage, because it
  // is the rubric whose population moves most from run to run: it applies only to
  // cases that state a guideline, and "83%" over a population of six and over a
  // population of twelve are not the same claim.
  const guidelines = rateFigures(metrics?.guidelines, rates?.guidelines, 'fraction', 'followed · judge-scored');

  return {
    status,
    inProgress,
    passedLabel,
    passedCoverage: passedCoverage(passedLabel, total, unattempted, counts?.unresolved),
    outcomeLabel: outcomeParts.length > 0 ? outcomeParts.join(' · ') : null,
    executionNote: incomplete.length > 0 ? `${incomplete.join(' and ')}, so this run did not fully execute.` : null,
    durationLabel: isFiniteNumber(durationMs) && durationMs >= 0 ? formatDuration(durationMs) : ABSENT,
    durationCoverage: isFiniteNumber(total) && total >= 0 ? `${total} ${total === 1 ? 'case' : 'cases'}` : null,
    groundednessLabel: groundedness.label,
    groundednessCoverage: groundedness.coverage,
    relevanceLabel: relevance.label,
    relevanceCoverage: relevance.coverage,
    guidelinesLabel: guidelines.label,
    guidelinesCoverage: guidelines.coverage,
    judgeBadge: metrics?.judge?.badge ?? null,
    judgeDisclosure: metrics?.judge?.disclosure ?? null,
    judgeEndpoint: textOrNull(metrics?.judge?.endpoint),
    judgePromptVersion: textOrNull(metrics?.judge?.promptVersion),
    groundednessBasis: metrics?.judge?.groundednessBasis ?? null,
    runCaveat,
    contradiction:
      contradictions.length > 0
        ? `This run's stored metrics contradict each other: ${contradictions.join(', and ')}.`
        : null,
    truncationNote,
    executedAsNote,
    executedAsIdentity,
    servedVersion,
  };
}

/**
 * Every case the run recorded, in the order it ran them.
 *
 * A run's `metrics_json` has carried this array since the runner was rewritten,
 * and the trace projection spreads the whole of it, so these are the run's own
 * rows and not a client-held case list paired up with server results. That
 * pairing is how a six-row table came to disagree with the tile above it, and
 * nothing here reads a question, a duration or an outcome from anywhere but the
 * record.
 */
export function benchmarkCaseRows(metrics: BenchmarkMetrics | null | undefined): BenchmarkCaseRow[] {
  const cases = Array.isArray(metrics?.cases) ? metrics.cases : [];
  return cases
    .filter((record): record is BenchmarkCaseRecord => Boolean(record) && typeof record === 'object')
    .map((record, index) => {
      const outcome = (textOrNull(record.outcome) ?? '').toLowerCase();
      const stage = (textOrNull(record.errorStage) ?? '').toLowerCase();
      const { label, tone } = caseOutcome(outcome, stage);
      return {
        key: textOrNull(record.caseId) ?? `case-${index}`,
        caseId: textOrNull(record.caseId),
        // The question as asked, which is the only version of it this app has.
        // There is no fallback text: a case whose question was not recorded
        // renders as one, because inventing the question is how the invented
        // timings beside them got there.
        question: textOrNull(record.question),
        outcomeLabel: label,
        tone,
        durationLabel:
          isFiniteNumber(record.durationMs) && record.durationMs >= 0 ? formatDuration(record.durationMs) : ABSENT,
        note: textOrNull(record.note),
      };
    });
}

/** One case's row, already worded, so the screen holds no vocabulary of its own. */
export interface BenchmarkCaseRow {
  key: string;
  caseId: string | null;
  question: string | null;
  outcomeLabel: string;
  tone: 'tone-ok' | 'tone-bad' | 'tone-degraded' | 'tone-neutral';
  durationLabel: string;
  note: string | null;
}

/**
 * How one case's outcome is worded, which is where the five states must not
 * collapse into two.
 *
 * `errored` is read together with the stage that produced it, because they are
 * genuinely different events to whoever is reading: a case the suite never got
 * to, a case the agent never answered, and a case that was answered and could
 * not be scored all arrive as `errored`, and calling all three "Failed" would
 * blame the agent for two things it did not do. None of them is a pass either,
 * which is why none of them takes the green tone.
 */
function caseOutcome(outcome: string, stage: string): { label: string; tone: BenchmarkCaseRow['tone'] } {
  if (outcome === 'passed') return { label: 'Passed', tone: 'tone-ok' };
  if (outcome === 'failed') return { label: 'Failed', tone: 'tone-bad' };
  if (outcome === 'clarified') return { label: 'Asked to clarify', tone: 'tone-neutral' };
  if (outcome === 'unresolved') return { label: 'No question recorded', tone: 'tone-neutral' };
  if (outcome === 'errored') {
    if (stage === 'identity' || stage === 'budget') return { label: 'Never attempted', tone: 'tone-degraded' };
    if (stage === 'agent') return { label: 'No answer', tone: 'tone-degraded' };
    return { label: 'Not scored', tone: 'tone-degraded' };
  }
  return { label: 'Not recorded', tone: 'tone-neutral' };
}

/**
 * Every qualification a summary can carry, in the order they belong on screen.
 *
 * The order is the one the alert stack had and the reason for it is unchanged:
 * anything that changes how a *rate* should be read comes before the rates. What
 * changed is only that they are now rows of one ledger instead of six separate
 * alerts, which is a change of prominence and grouping and not of content.
 *
 * This list is the contract the ledger is checked against. A qualification added
 * to `BenchmarkSummary` and not added here is a qualification that would reach
 * nobody, and the test for that reads this array rather than trusting the screen.
 */
export const BENCHMARK_QUALIFICATION_FIELDS = [
  'judgeDisclosure',
  'contradiction',
  'truncationNote',
  'executionNote',
  'executedAsNote',
  'runCaveat',
] as const;

export type BenchmarkQualificationField = (typeof BENCHMARK_QUALIFICATION_FIELDS)[number];

/**
 * One row of the ledger: an icon's worth of tone, a lead to find it by, and the
 * sentence itself.
 *
 * `sentence` is the summary's own text, whole. The lead is a label added for
 * scanning and never a summary of the sentence, because a reader who takes the
 * lead for the whole row has to still be right.
 */
export interface BenchmarkQualification {
  /** Which summary field this row is. Carried so a test can prove none was lost. */
  field: BenchmarkQualificationField;
  /**
   * `info` for a qualification about the measurement, `identity` for one about
   * whose access produced it, `danger` for the two that say the run did not do
   * what its numbers imply it did.
   */
  tone: 'info' | 'identity' | 'danger';
  lead: string;
  /** A human identity rendered by the shared user chip rather than folded into prose. */
  identity?: string;
  sentence: string;
}

/** The lead and the tone for each qualification. The sentence comes from the run. */
const QUALIFICATION_PRESENTATION: Record<
  BenchmarkQualificationField,
  { tone: BenchmarkQualification['tone']; lead: string }
> = {
  judgeDisclosure: { tone: 'info', lead: 'Scored by a judge model' },
  contradiction: { tone: 'danger', lead: 'The stored metrics contradict each other' },
  truncationNote: { tone: 'danger', lead: 'The run stopped before attempting every case' },
  executionNote: { tone: 'danger', lead: 'Not every case produced an answer' },
  executedAsNote: { tone: 'identity', lead: 'The identity this ran under was not recorded' },
  runCaveat: { tone: 'info', lead: 'One run, not a fixed score' },
};

/**
 * How the rates on this page are counted, said once, next to what counted them.
 *
 * This is a statement about the arithmetic in `summariseJudge`: the denominator
 * of every rate is the cases that judge reached a verdict on, and the two kinds
 * of absence are held out of both halves of the fraction. It belongs on the
 * ledger because a reader cannot tell from "87%" which population it is over,
 * and the guess they would make is the wrong one.
 */
const JUDGE_COUNTING_RULE =
  'Judge rates count only the cases the judge reached a verdict on: "did not apply" and "could not be scored" ' +
  'are named separately under each figure and are not counted as failures.';

/**
 * The qualifications on one run, as the rows of the ledger above its scores.
 *
 * Two of them carry a sentence the page used to append in its own markup, and
 * both are load-bearing: a rate counted over the cases that were scored is not a
 * rate over the suite, and a contradiction shown as stored is not a contradiction
 * quietly corrected. They are composed here so that the row is the whole
 * qualification and nothing is left for a renderer to remember.
 */
export function benchmarkQualifications(summary: BenchmarkSummary): BenchmarkQualification[] {
  return BENCHMARK_QUALIFICATION_FIELDS.flatMap((field): BenchmarkQualification[] => {
    const text = summary[field];
    const { tone, lead } = QUALIFICATION_PRESENTATION[field];
    if (field === 'judgeDisclosure') {
      // What scored it, named on the row rather than only in the metrics nobody
      // reads: scores from two prompt versions are not comparable and this is
      // the only thing that says which this is. Both halves are omitted when the
      // run did not record them, rather than defaulted to whatever the app is
      // configured with now, which would be a claim about a run from a
      // configuration it never saw.
      const attribution = [
        summary.judgeEndpoint ? `Endpoint ${summary.judgeEndpoint}` : null,
        summary.judgePromptVersion
          ? `MLflow prompt version ${summary.judgePromptVersion.replace(/^mlflow-/, '')}`
          : null,
      ].filter((part): part is string => Boolean(part));
      // The row survives a missing disclosure sentence as long as the run named
      // what judged it. The attribution is the load-bearing half: a score whose
      // endpoint and prompt version are on screen can be compared with another,
      // and one missing the sentence about MLflow's prompts is less complete but
      // not unattributed. Gating the row on the sentence alone would have dropped
      // the attribution with it.
      if (!text && attribution.length === 0) return [];
      return [
        {
          field,
          tone,
          lead,
          sentence: [
            attribution.length > 0 ? `${attribution.join(', ')}.` : null,
            text,
            summary.groundednessBasis,
            JUDGE_COUNTING_RULE,
          ]
            .filter((part): part is string => Boolean(part))
            .join(' '),
        },
      ];
    }
    if (!text) return [];
    if (field === 'executedAsNote') {
      const identity = summary.executedAsIdentity?.includes('@') ? summary.executedAsIdentity : undefined;
      return [
        {
          field,
          tone,
          lead: identity
            ? 'This suite ran as'
            : summary.executedAsIdentity
              ? `This suite ran as ${summary.executedAsIdentity}`
              : lead,
          identity,
          sentence: text,
        },
      ];
    }
    if (field === 'runCaveat') {
      return [
        {
          field,
          tone,
          lead: summary.servedVersion
            ? `One run against model version ${summary.servedVersion}`
            : 'One run against the version then serving',
          sentence: text,
        },
      ];
    }
    if (field === 'contradiction') {
      return [
        {
          field,
          tone,
          lead,
          sentence: `${text} Nothing has been adjusted to hide it. The figures below are shown as stored.`,
        },
      ];
    }
    if (field === 'executionNote') {
      return [
        {
          field,
          tone,
          lead,
          sentence: `${text} The rates below are counted over the cases that were scored, not over the whole suite.`,
        },
      ];
    }
    return [{ field, tone, lead, sentence: text }];
  });
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

/**
 * The top of the scale a rating is given on.
 *
 * Not a choice made here: the feedback write path constrains the column to 1-5,
 * and `storedRating` in stored-feedback.ts treats anything outside that as absent.
 * This is that same 5, named, so the surfaces that print a rating can say what it
 * is out of without each one asserting the scale on its own.
 */
export const RATING_SCALE = 5;

/**
 * A rating with its scale attached.
 *
 * A star and a number alone read as a count -- "★ 5" was reported as unreadable
 * for exactly that reason, since it could as easily have been five stars, a score
 * out of ten, or five ratings. The denominator costs two characters and removes
 * the question.
 */
export function ratingOutOf(rating: number) {
  return `${rating}/${RATING_SCALE}`;
}
