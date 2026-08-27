import { z } from 'zod';

/**
 * Bake-off comparison for Benchmark Lab v3: three lanes, signed deltas, gates
 * that count regressions, and a history line that does not invent a composite
 * score.
 */

export const PROMOTE_TARGET_KINDS = ['prompt-registry', 'genie-space', 'rag-config'] as const;
export type PromoteTargetKind = (typeof PROMOTE_TARGET_KINDS)[number];

export const BakeOffHistorySchema = z.strictObject({
  at: z.string().trim().min(1).max(40),
  datasetSuiteId: z.string().trim().max(80).default(''),
  baselineRunId: z.string().trim().max(80).default(''),
  candidateRunId: z.string().trim().max(80).default(''),
  changed: z.string().trim().max(200).default(''),
  winner: z.enum(['baseline', 'candidate', 'tie', 'none']).default('none'),
  gatesPassed: z.number().int().nonnegative().default(0),
  gatesTotal: z.number().int().nonnegative().default(0),
  note: z.string().trim().max(400).default(''),
});

export type BakeOffHistory = z.infer<typeof BakeOffHistorySchema>;

export function rememberBakeOff(history: BakeOffHistory[], next: BakeOffHistory): BakeOffHistory[] {
  return [next, ...history].slice(0, 50);
}

export function bakeOffHistoryLine(entry: BakeOffHistory): string {
  const when = entry.at.slice(0, 10) || entry.at;
  const gates =
    entry.gatesTotal > 0 ? ` · ${entry.gatesPassed} of ${entry.gatesTotal} gates` : '';
  const ids = [entry.baselineRunId, entry.candidateRunId].filter(Boolean).join(' vs ');
  return `${when}: ${entry.winner}${ids ? ` · ${ids}` : ''}${gates}${entry.note ? `. ${entry.note}` : ''}`;
}

export interface AgentSideInput {
  side: string;
  runId: string | null;
  passed: number | null;
  total: number | null;
  groundedness: number | null;
  relevance: number | null;
  guidelines: number | null;
  coverage?: number | null;
}

export type LaneId = 'genie' | 'agent' | 'trace';

export interface LaneMetric {
  key: string;
  label: string;
  lane: LaneId;
  baseline: number | null;
  candidate: number | null;
  unit: 'rate' | 'count' | 'ms' | 'tokens' | 'currency';
  gate: boolean;
}

export interface CaseOutcomePair {
  caseId: string;
  question: string;
  baseline: string | null;
  candidate: string | null;
}

export interface BakeOffComparison {
  changed: string;
  genie: LaneMetric[];
  agent: LaneMetric[];
  trace: LaneMetric[];
  newlyFixed: CaseOutcomePair[];
  newlyBroken: CaseOutcomePair[];
  regressionCaseId: string | null;
  gates: { id: string; label: string; passed: boolean; applicable: boolean }[];
}

export interface TraceLaneInput {
  durationMs: number | null;
  medianCaseMs: number | null;
  tokens: number | null;
  estimatedCost: number | null;
  toolErrorRate: number | null;
  toolErrorCount: number | null;
  toolErrorTotal: number | null;
  traceCoverage: { withTrace: number; total: number } | null;
}

export interface GenieLaneInput {
  accuracy: number | null;
  passed: number | null;
  scored: number | null;
  executionErrors: number | null;
  durationMs: number | null;
  note: string;
}

function signedDelta(baseline: number | null, candidate: number | null): number | null {
  if (typeof baseline !== 'number' || typeof candidate !== 'number') return null;
  if (!Number.isFinite(baseline) || !Number.isFinite(candidate)) return null;
  return candidate - baseline;
}

export function formatDelta(baseline: number | null, candidate: number | null, unit: LaneMetric['unit']): string {
  const delta = signedDelta(baseline, candidate);
  if (delta === null) return '–';
  const sign = delta > 0 ? '+' : '';
  if (unit === 'rate') return `${sign}${Math.round(delta * 100)} pt`;
  if (unit === 'ms') return `${sign}${Math.round(delta)} ms`;
  if (unit === 'currency') return `${sign}${delta.toFixed(2)}`;
  if (unit === 'tokens') return `${sign}${Math.round(delta)}`;
  return `${sign}${delta}`;
}

export function deltaTone(baseline: number | null, candidate: number | null, invert = false): 'pos' | 'neg' | 'none' {
  const delta = signedDelta(baseline, candidate);
  if (delta === null || delta === 0) return 'none';
  const improved = invert ? delta < 0 : delta > 0;
  return improved ? 'pos' : 'neg';
}

/** Latency, errors, tokens, and cost: a drop is an improvement. */
export function lowerIsBetter(metric: Pick<LaneMetric, 'key' | 'unit'>): boolean {
  if (metric.unit === 'ms' || metric.unit === 'tokens' || metric.unit === 'currency') return true;
  return metric.key === 'execution-errors' || metric.key === 'tool-error';
}

export function formatLaneValue(value: number | null, unit: LaneMetric['unit']): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '–';
  if (unit === 'rate') return `${Math.round(value * 100)}%`;
  if (unit === 'ms') return `${Math.round(value)} ms`;
  if (unit === 'currency') return value.toFixed(2);
  if (unit === 'tokens') return String(Math.round(value));
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function metric(
  key: string,
  label: string,
  lane: LaneId,
  baseline: number | null,
  candidate: number | null,
  unit: LaneMetric['unit'],
  gate = false
): LaneMetric {
  return { key, label, lane, baseline, candidate, unit, gate };
}

export function toolErrorRate(errored: number | null, total: number | null): number | null {
  if (typeof errored !== 'number' || typeof total !== 'number' || total <= 0) return null;
  return errored / total;
}

export function compareBakeOff(input: {
  baseline: AgentSideInput;
  candidate: AgentSideInput;
  changed?: string;
  genie?: { baseline: GenieLaneInput; candidate: GenieLaneInput } | null;
  trace?: { baseline: TraceLaneInput; candidate: TraceLaneInput } | null;
  cases?: CaseOutcomePair[];
}): BakeOffComparison {
  const agent: LaneMetric[] = [
    metric('groundedness', 'Groundedness', 'agent', input.baseline.groundedness, input.candidate.groundedness, 'rate', true),
    metric('relevance', 'Relevance', 'agent', input.baseline.relevance, input.candidate.relevance, 'rate'),
    metric('guidelines', 'Guidelines', 'agent', input.baseline.guidelines, input.candidate.guidelines, 'rate'),
    metric(
      'coverage',
      'Judge coverage',
      'agent',
      input.baseline.coverage ?? null,
      input.candidate.coverage ?? null,
      'rate'
    ),
  ];
  const geniePair = input.genie;
  const genie: LaneMetric[] = geniePair
    ? [
        metric('accuracy', 'Accuracy', 'genie', geniePair.baseline.accuracy, geniePair.candidate.accuracy, 'rate', true),
        metric('genie-passed', 'Cases passed', 'genie', geniePair.baseline.passed, geniePair.candidate.passed, 'count'),
        metric(
          'execution-errors',
          'Execution errors',
          'genie',
          geniePair.baseline.executionErrors,
          geniePair.candidate.executionErrors,
          'count'
        ),
        metric('genie-duration', 'Suite duration', 'genie', geniePair.baseline.durationMs, geniePair.candidate.durationMs, 'ms'),
      ]
    : [
        metric('accuracy', 'Accuracy', 'genie', null, null, 'rate', true),
        metric('genie-passed', 'Cases passed', 'genie', null, null, 'count'),
        metric('execution-errors', 'Execution errors', 'genie', null, null, 'count'),
        metric('genie-duration', 'Suite duration', 'genie', null, null, 'ms'),
      ];
  const tracePair = input.trace;
  const trace: LaneMetric[] = tracePair
    ? [
        metric('p50', 'p50 latency', 'trace', tracePair.baseline.medianCaseMs, tracePair.candidate.medianCaseMs, 'ms'),
        metric('tokens', 'Tokens', 'trace', tracePair.baseline.tokens, tracePair.candidate.tokens, 'tokens'),
        metric('cost', 'Estimated cost', 'trace', tracePair.baseline.estimatedCost, tracePair.candidate.estimatedCost, 'currency'),
        metric(
          'tool-error',
          'Tool-error rate',
          'trace',
          tracePair.baseline.toolErrorRate,
          tracePair.candidate.toolErrorRate,
          'rate'
        ),
      ]
    : [
        metric('p50', 'p50 latency', 'trace', null, null, 'ms'),
        metric('tokens', 'Tokens', 'trace', null, null, 'tokens'),
        metric('cost', 'Estimated cost', 'trace', null, null, 'currency'),
        metric('tool-error', 'Tool-error rate', 'trace', null, null, 'rate'),
      ];

  const cases = input.cases ?? [];
  const newlyFixed = cases.filter(
    (entry) => entry.baseline !== 'passed' && entry.candidate === 'passed'
  );
  const newlyBroken = cases.filter(
    (entry) => entry.baseline === 'passed' && entry.candidate !== 'passed' && entry.candidate !== null
  );

  const gates = [
    {
      id: 'groundedness',
      label: 'Groundedness did not regress',
      applicable: typeof input.baseline.groundedness === 'number' && typeof input.candidate.groundedness === 'number',
      passed:
        typeof input.baseline.groundedness === 'number' &&
        typeof input.candidate.groundedness === 'number' &&
        input.candidate.groundedness >= input.baseline.groundedness,
    },
    {
      id: 'accuracy',
      label: 'Genie accuracy did not regress',
      applicable: Boolean(
        geniePair &&
          typeof geniePair.baseline.accuracy === 'number' &&
          typeof geniePair.candidate.accuracy === 'number'
      ),
      passed: Boolean(
        geniePair &&
          typeof geniePair.baseline.accuracy === 'number' &&
          typeof geniePair.candidate.accuracy === 'number' &&
          geniePair.candidate.accuracy >= geniePair.baseline.accuracy
      ),
    },
  ];

  return {
    changed: input.changed?.trim() || changedVariable(input.baseline.side, input.candidate.side),
    genie,
    agent,
    trace,
    newlyFixed,
    newlyBroken,
    regressionCaseId: newlyBroken[0]?.caseId ?? null,
    gates,
  };
}

export function changedVariable(baselineSide: string, candidateSide: string): string {
  const left = baselineSide.trim() || 'current';
  const right = candidateSide.trim() || 'current';
  if (left === right) return 'Same endpoint on both sides';
  return `Agent endpoint: ${left} to ${right}`;
}

export function gatesSummary(comparison: BakeOffComparison): { passed: number; total: number; label: string } {
  const applicable = comparison.gates.filter((gate) => gate.applicable);
  const passed = applicable.filter((gate) => gate.passed).length;
  const total = applicable.length;
  if (total === 0) return { passed: 0, total: 0, label: 'No applicable gates on this bake-off' };
  return { passed, total, label: `Passed ${passed} of ${total} gates` };
}

export function judgeNeedTags(_input: {
  enabledJudges: readonly string[];
  multiTurn: readonly string[];
  customCount: number;
}): { id: string; label: string }[] {
  return [
    { id: 'response', label: 'Response per case' },
    { id: 'trace', label: 'Trace for step scorers' },
    { id: 'session', label: 'Session id for multi-turn' },
  ];
}

export function liveRunProgress(input: {
  runId: string | null;
  side: string;
  currentCaseIndex: number | null;
  total: number | null;
  inProgress: boolean;
}): string | null {
  if (!input.inProgress || !input.runId) return null;
  const total = input.total ?? 0;
  const index = typeof input.currentCaseIndex === 'number' ? input.currentCaseIndex + 1 : 0;
  if (total <= 0) return `${input.runId} ${input.side} in progress`;
  return `${input.runId} ${input.side} in progress · case ${index} of ${total}`;
}

export function promoteTargetCaption(kind: PromoteTargetKind): string {
  if (kind === 'prompt-registry') {
    return 'Moves the production alias after approval when this app can write Prompt Registry. Connections stay unchanged.';
  }
  if (kind === 'genie-space') {
    return 'Opens the instruction workflow. This app does not write Genie space instructions.';
  }
  return 'Not configured for this target. RAG config is owned by the deployment configuration.';
}

export function rollbackCaption(previous: { endpoint: string; side: string } | null): string {
  if (!previous?.endpoint) return 'No earlier promote to roll back to.';
  return `Restore ${previous.endpoint}${previous.side ? ` (${previous.side})` : ''} for the next Ask.`;
}

export function serializeEvidencePack(input: {
  datasetSuiteId: string;
  datasetVersionId?: string;
  configurationSnapshot?: unknown;
  changed: string;
  comparison: BakeOffComparison;
  baseline: AgentSideInput;
  candidate: AgentSideInput;
  failedCases: CaseOutcomePair[];
  traceLinks?: { caseId: string; href: string }[];
  reviewerStatus?: string;
}): string {
  return JSON.stringify(
    {
      datasetSuiteId: input.datasetSuiteId,
      datasetVersionId: input.datasetVersionId || '',
      configurationSnapshot: input.configurationSnapshot ?? null,
      changed: input.changed,
      baselineRunId: input.baseline.runId,
      candidateRunId: input.candidate.runId,
      gates: input.comparison.gates,
      genie: input.comparison.genie,
      agent: input.comparison.agent,
      trace: input.comparison.trace,
      newlyFixed: input.comparison.newlyFixed.map((entry) => entry.caseId),
      newlyBroken: input.comparison.newlyBroken.map((entry) => entry.caseId),
      failedCases: input.failedCases,
      traceLinks: input.traceLinks ?? [],
      reviewerStatus: input.reviewerStatus || '',
    },
    null,
    2
  );
}

export function pickWinnerFromComparison(comparison: BakeOffComparison): 'baseline' | 'candidate' | 'tie' | null {
  const grounded = comparison.agent.find((row) => row.key === 'groundedness');
  const left = grounded?.baseline;
  const right = grounded?.candidate;
  if (typeof left !== 'number' || typeof right !== 'number') return null;
  if (right > left) return 'candidate';
  if (left > right) return 'baseline';
  return 'tie';
}
