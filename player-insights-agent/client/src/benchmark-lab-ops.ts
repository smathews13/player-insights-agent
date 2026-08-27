import {
  type AgentSideInput,
  type CaseOutcomePair,
  type GenieLaneInput,
  type PromoteTargetKind,
  type TraceLaneInput,
  toolErrorRate,
} from '../../shared/benchmark-bakeoff';
import {
  classifySpanKind,
  mlflowTraceHref,
  spanStatus,
  type ApplyTargetKind,
  type LabSpan,
} from '../../shared/benchmark-lab-v3';
import type { GenieAccuracyRunView } from '../../shared/eval-genie-run';
import type { ScorecardValue } from '../../shared/scorecard-contract';

export type ApplyTargetSeg = ApplyTargetKind;

export type LooseCase = {
  caseId?: string | null;
  question?: string | null;
  outcome?: string | null;
  errorStage?: string | null;
  durationMs?: number | null;
  agentTotalMs?: number | null;
  note?: string | null;
  mlflowTraceId?: string | null;
  answerId?: string | null;
  tokens?: number | null;
  stages?: { id?: string; name?: string; kind?: string; status?: string; duration?: number | null }[] | null;
  scores?: ScorecardValue[] | null;
  judgements?: { name?: string; rationale?: string; value?: string | null; state?: string; durationMs?: number | null }[];
};

export type FailureCase = {
  id: string;
  question: string;
  outcome: string;
  diagnosis: string;
  mlflowHref: string;
  sessionId: string;
  rationale: string;
  provisional: boolean;
  answerId: string;
  spans: LabSpan[];
};

type LooseMetrics = {
  passed?: number | null;
  total?: number | null;
  groundedness?: number | null;
  relevance?: number | null;
  guidelines?: number | null;
  durationMs?: number | null;
  medianCaseMs?: number | null;
  totalTokens?: number | null;
  configurationSnapshot?: {
    suiteId?: string;
    caseCount?: number;
    judgeEndpoint?: string;
    agentEndpoint?: string;
    enabledJudges?: string[];
  } | null;
  counts?: { errored?: number | null; attempted?: number | null; total?: number | null } | null;
  judgeRates?: {
    groundedness?: { scored?: number | null; notApplicable?: number | null; errored?: number | null } | null;
  } | null;
  cases?: LooseCase[] | null;
  extraJudgeRates?: Record<string, { rate?: number | null }> | null;
} | null;

export type BakeOffTrace = {
  runId: string;
  benchmark: LooseMetrics;
  note?: string;
};

export function applyTargetKind(seg: ApplyTargetSeg): PromoteTargetKind {
  if (seg === 'genie_space') return 'genie-space';
  if (seg === 'rag_config') return 'rag-config';
  return 'prompt-registry';
}

export function judgeCoverage(
  rate: { scored?: number | null; notApplicable?: number | null; errored?: number | null } | null | undefined
): number | null {
  if (!rate) return null;
  const scored = typeof rate.scored === 'number' ? rate.scored : 0;
  const denom =
    scored +
    (typeof rate.notApplicable === 'number' ? rate.notApplicable : 0) +
    (typeof rate.errored === 'number' ? rate.errored : 0);
  if (denom <= 0) return null;
  return scored / denom;
}

export function agentSideFromTrace(side: string, trace: BakeOffTrace | null): AgentSideInput {
  const metrics = trace?.benchmark ?? null;
  return {
    side,
    runId: trace?.runId ?? null,
    passed: numberOrNull(metrics?.passed),
    total: numberOrNull(metrics?.total),
    groundedness: numberOrNull(metrics?.groundedness),
    relevance: numberOrNull(metrics?.relevance),
    guidelines: numberOrNull(metrics?.guidelines),
    coverage: judgeCoverage(metrics?.judgeRates?.groundedness),
  };
}

export function traceLaneFromMetrics(metrics: LooseMetrics): TraceLaneInput {
  const cases = Array.isArray(metrics?.cases) ? metrics.cases : [];
  const errored = typeof metrics?.counts?.errored === 'number' ? metrics.counts.errored : null;
  const total =
    typeof metrics?.counts?.attempted === 'number'
      ? metrics.counts.attempted
      : typeof metrics?.total === 'number'
        ? metrics.total
        : cases.length || null;
  const withTrace = cases.filter((entry) => Boolean(entry.mlflowTraceId?.trim())).length;
  const caseTokens = cases
    .map((entry) => entry.tokens)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const summedTokens = caseTokens.length > 0 ? caseTokens.reduce((sum, value) => sum + value, 0) : null;
  return {
    durationMs: numberOrNull(metrics?.durationMs),
    medianCaseMs: numberOrNull(metrics?.medianCaseMs),
    tokens: numberOrNull(metrics?.totalTokens) ?? summedTokens,
    estimatedCost: null,
    toolErrorRate: toolErrorRate(errored, total),
    toolErrorCount: errored,
    toolErrorTotal: total,
    traceCoverage: total && total > 0 ? { withTrace, total } : null,
  };
}

const ONE_GENIE_NOTE =
  'One Genie suite is recorded. Run another after changing the space or instructions to compare.';

function emptyGenieLane(note: string): GenieLaneInput {
  return {
    accuracy: null,
    passed: null,
    scored: null,
    executionErrors: null,
    durationMs: null,
    note,
  };
}

function snapshotLane(
  input: {
    percent: number | null;
    passed: number;
    scored: number;
    errors?: number | null;
    durationMs?: number | null;
  },
  note: string
): GenieLaneInput {
  return {
    accuracy: typeof input.percent === 'number' ? input.percent / 100 : null,
    passed: input.passed,
    scored: input.scored,
    executionErrors: input.errors ?? null,
    durationMs: input.durationMs ?? null,
    note,
  };
}

function laneFromRun(run: GenieAccuracyRunView): GenieLaneInput {
  const errors = run.cases.filter((entry) => !entry.excluded && entry.outcome === 'error').length;
  const started = Date.parse(run.startedAt);
  const finished = Date.parse(run.finishedAt);
  const durationMs = Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : null;
  return snapshotLane(
    {
      percent: run.score.percent,
      passed: run.score.passed,
      scored: run.score.total,
      errors,
      durationMs,
    },
    `${run.id} · ${run.spaceLabel || run.spaceId || 'Genie space'}`
  );
}

function laneFromHistory(entry: {
  at?: string;
  spaceId?: string;
  spaceLabel?: string;
  percent: number | null;
  passed: number;
  scored: number;
}): GenieLaneInput {
  const when = entry.at?.slice(0, 10) || entry.at || '';
  return snapshotLane(
    {
      percent: entry.percent,
      passed: entry.passed,
      scored: entry.scored,
    },
    [when, entry.spaceLabel || entry.spaceId || 'Genie space'].filter(Boolean).join(' · ')
  );
}

function sameGenieSnap(
  run: GenieAccuracyRunView,
  snap: { at?: string; spaceId?: string; passed?: number; scored?: number; percent?: number | null }
): boolean {
  if (snap.spaceId && run.spaceId && snap.spaceId === run.spaceId) {
    if (snap.at && run.finishedAt && snap.at.slice(0, 19) === run.finishedAt.slice(0, 19)) return true;
    if (snap.passed === run.score.passed && snap.scored === run.score.total && snap.percent === run.score.percent) {
      return Boolean(snap.at && run.finishedAt && snap.at.slice(0, 10) === run.finishedAt.slice(0, 10));
    }
  }
  return false;
}

type GenieHistorySnap = {
  at?: string;
  spaceId?: string;
  spaceLabel?: string;
  percent: number | null;
  passed: number;
  scored: number;
};

/** Two real Genie suites when they exist. Never copies one snapshot onto both sides. */
export function genieLanePair(input: {
  lastRun: GenieAccuracyRunView | null;
  history: GenieHistorySnap[];
}): { baseline: GenieLaneInput; candidate: GenieLaneInput } | null {
  const run = input.lastRun;
  const history = input.history;
  if (run) {
    const candidate = laneFromRun(run);
    const prior = history.find((entry) => !sameGenieSnap(run, entry));
    if (!prior) {
      return { baseline: emptyGenieLane(ONE_GENIE_NOTE), candidate: { ...candidate, note: ONE_GENIE_NOTE } };
    }
    return { baseline: laneFromHistory(prior), candidate };
  }
  if (history.length >= 2) {
    return { baseline: laneFromHistory(history[1]!), candidate: laneFromHistory(history[0]!) };
  }
  if (history.length === 1) {
    return { baseline: emptyGenieLane(ONE_GENIE_NOTE), candidate: { ...laneFromHistory(history[0]!), note: ONE_GENIE_NOTE } };
  }
  return null;
}

export function genieLaneFromHistory(history: { percent: number | null; passed: number; scored: number }[]): {
  baseline: GenieLaneInput;
  candidate: GenieLaneInput;
} | null {
  return genieLanePair({ lastRun: null, history });
}

export function genieLaneFromRun(run: GenieAccuracyRunView | null): {
  baseline: GenieLaneInput;
  candidate: GenieLaneInput;
} | null {
  return genieLanePair({ lastRun: run, history: [] });
}

export function pairCaseOutcomes(baseline: LooseCase[], candidate: LooseCase[]): CaseOutcomePair[] {
  const right = new Map(candidate.map((entry) => [entry.caseId || '', entry]));
  const ids = new Set(
    [...baseline, ...candidate].map((entry) => entry.caseId || '').filter(Boolean)
  );
  return [...ids].map((caseId) => {
    const left = baseline.find((entry) => entry.caseId === caseId);
    const other = right.get(caseId);
    return {
      caseId,
      question: other?.question || left?.question || '',
      baseline: left?.outcome ?? null,
      candidate: other?.outcome ?? null,
    };
  });
}

export function spanTreeFromCase(entry: LooseCase): LabSpan[] {
  const id = entry.caseId?.trim() || 'case';
  const spans: LabSpan[] = [];
  const stages = Array.isArray(entry.stages) ? entry.stages : [];
  if (stages.length > 0) {
    for (const stage of stages) {
      const name = stage.name?.trim() || stage.kind?.trim() || 'span';
      const duration = typeof stage.duration === 'number' && Number.isFinite(stage.duration) ? stage.duration : null;
      spans.push({
        id: stage.id?.trim() || `${id}:${name}`,
        name,
        kind: classifySpanKind(name, stage.kind || ''),
        durationMs: duration,
        status: spanStatus({
          outcome: stage.status,
          durationMs: duration,
          failed: (stage.status || '').toLowerCase() === 'failed',
        }),
        tokens: null,
        cost: null,
      });
    }
  }
  const caseDuration = numberOrNull(entry.durationMs) ?? numberOrNull(entry.agentTotalMs);
  if (caseDuration != null && !spans.some((span) => span.kind === 'AGENT')) {
    spans.unshift({
      id: `${id}:agent`,
      name: `Case ${id}`,
      kind: 'AGENT',
      durationMs: caseDuration,
      status: spanStatus({ outcome: entry.outcome, durationMs: caseDuration }),
      tokens: numberOrNull(entry.tokens),
      cost: null,
    });
  }
  const judgements = Array.isArray(entry.judgements) ? entry.judgements : [];
  let tokensPlaced = spans.some((span) => span.kind === 'LLM' && span.tokens != null);
  for (const judgement of judgements) {
    const duration = numberOrNull(judgement.durationMs);
    if (duration == null) continue;
    const name = judgement.name?.trim() || 'judge';
    const tokens = !tokensPlaced ? numberOrNull(entry.tokens) : null;
    if (tokens != null) tokensPlaced = true;
    spans.push({
      id: `${id}:${name}`,
      name,
      kind: 'LLM',
      durationMs: duration,
      status: spanStatus({ failed: judgement.state === 'errored', durationMs: duration }),
      tokens,
      cost: null,
    });
  }
  if (!tokensPlaced) {
    const firstLlm = spans.find((span) => span.kind === 'LLM');
    if (firstLlm && firstLlm.tokens == null) firstLlm.tokens = numberOrNull(entry.tokens);
  }
  return spans;
}

export function investigationCases(cases: LooseCase[], sessionId = ''): FailureCase[] {
  return cases
    .filter((entry) => {
      const outcome = (entry.outcome || '').toLowerCase();
      const provisional = (entry.note || '').toLowerCase().includes('provisional');
      return (
        outcome === 'failed' ||
        outcome === 'errored' ||
        outcome === 'unresolved' ||
        outcome === 'skipped' ||
        outcome === 'slow' ||
        outcome === 'clarified' ||
        provisional
      );
    })
    .map((entry) => {
      const id = entry.caseId?.trim() || '';
      const rationale = judgeRationale(entry);
      const traceId = entry.mlflowTraceId?.trim() || '';
      return {
        id,
        question: entry.question?.trim() || 'The question was not recorded',
        outcome: outcomeLabel(entry.outcome),
        diagnosis: entry.note?.trim() || rationale || 'No diagnosis was recorded for this case.',
        mlflowHref: traceId ? mlflowTraceHref(traceId) : '',
        sessionId: sessionId.trim(),
        rationale,
        provisional: (entry.note || '').toLowerCase().includes('provisional'),
        answerId: entry.answerId?.trim() || '',
        spans: spanTreeFromCase(entry),
      };
    })
    .filter((entry) => entry.id);
}

export function failedCaseIds(cases: LooseCase[]): string[] {
  return cases
    .filter((entry) => {
      const outcome = (entry.outcome || '').toLowerCase();
      return outcome === 'failed' || outcome === 'errored';
    })
    .map((entry) => entry.caseId?.trim() || '')
    .filter(Boolean);
}

export function bakeOffPermalink(baselineId: string, candidateId: string): string {
  const url = new URL(typeof window === 'undefined' ? 'https://local.invalid/' : window.location.href);
  if (baselineId) url.searchParams.set('baseline', baselineId);
  else url.searchParams.delete('baseline');
  if (candidateId) url.searchParams.set('candidate', candidateId);
  else url.searchParams.delete('candidate');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function gateChip(runId: string | null, passed: number, total: number): string {
  const id = runId?.trim() ? runId.trim() : 'this run';
  if (total <= 0) return `${id} has no numeric gates set`;
  return `${id} passed ${passed} of ${total} gates`;
}

export function humanReviewedCaption(labelsReviewed: boolean | undefined, coverage: number | null): string {
  const reviewed = labelsReviewed ? 'human-reviewed' : '0 human-reviewed';
  if (coverage === null) return reviewed;
  return reviewed;
}

function judgeRationale(entry: LooseCase): string {
  const judgements = Array.isArray(entry.judgements) ? entry.judgements : [];
  const scored = judgements.find((row) => (row.rationale || '').trim());
  return scored?.rationale?.trim() || '';
}

function outcomeLabel(outcome: string | null | undefined): string {
  const value = (outcome || '').toLowerCase();
  if (value === 'failed') return 'Failed';
  if (value === 'errored') return 'Errored';
  if (value === 'unresolved') return 'Skipped';
  if (value === 'clarified') return 'Clarified';
  if (value === 'passed') return 'Passed';
  return outcome?.trim() || 'Unknown';
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function casesFromTrace(trace: BakeOffTrace | null): LooseCase[] {
  const cases = trace?.benchmark?.cases;
  return Array.isArray(cases) ? cases : [];
}

export function extraRateNote(
  extra: Record<string, { rate?: number | null }> | null | undefined
): string {
  if (!extra) return '';
  return Object.entries(extra)
    .map(([name, value]) => {
      const rate = typeof value?.rate === 'number' ? `${Math.round(value.rate * 100)}%` : 'not set';
      return `${name} ${rate}`;
    })
    .join(' · ');
}

export function resolvePromoteEndpoint(side: string, currentAgentEndpoint: string): string {
  const named = side.trim();
  if (!named || named === 'current') return currentAgentEndpoint.trim();
  return named;
}

export function readApiError(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const record = body as { detail?: unknown; message?: unknown };
  if (typeof record.detail === 'string' && record.detail.trim()) return record.detail.trim();
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
  return fallback;
}
