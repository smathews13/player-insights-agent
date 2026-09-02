import type { TraceStage, TraceSummary } from './answer-shape';
import type { CacheStatus, StepTokenUsage, TokenInvocationUsage } from '../../shared/llm-token-usage';

export const TOKEN_UNAVAILABLE = 'Not reported';

export interface StepTokenView {
  input: string;
  output: string;
  total: string;
  cachedRead: string;
  cacheWrite: string;
  cacheStatus: string;
  attempts: number;
  totalMismatch: boolean;
  summary: string;
  accessibleLabel: string;
}

export interface InvocationTokenView {
  id: string;
  stageId: string;
  component: string;
  attempt: number;
  input: string;
  output: string;
  cached: string;
  total: string;
  cacheStatus: string;
  totalMismatch: boolean;
}

export interface RunTokenView {
  available: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedReadTokens?: number;
  cacheWriteTokens?: number;
  cacheReported: boolean;
  cacheHitPercent?: number;
  attributedTokens?: number;
  attributedCalls?: number;
  coveragePercent?: number;
  unattributedTokens?: number;
  invocations: InvocationTokenView[];
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function sum(values: readonly (number | undefined)[]): number | undefined {
  const reported = values.filter((value): value is number => value !== undefined);
  return reported.length > 0 ? reported.reduce((total, value) => total + value, 0) : undefined;
}

function format(value: number | undefined): string {
  return value === undefined ? TOKEN_UNAVAILABLE : value.toLocaleString();
}

export function compactTokenCount(value: number): string {
  if (value < 1_000) return value.toLocaleString();
  if (value < 1_000_000) {
    const digits = value >= 10_000 ? 0 : 1;
    return `${(value / 1_000).toFixed(digits).replace(/\.0$/, '')}K`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function tokenTotalUsageView(value: number | null | undefined): {
  reported: boolean;
  compact: string;
  exactLabel: string;
} {
  const total = count(value);
  return total === undefined
    ? { reported: false, compact: '—', exactLabel: 'Total tokens not reported' }
    : {
        reported: true,
        compact:
          total < 1_000
            ? total.toLocaleString()
            : total < 1_000_000
              ? `${(total / 1_000).toFixed(1).replace(/\.0$/, '')}K`
              : `${(total / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`,
        exactLabel: `${total.toLocaleString()} total tokens`,
      };
}

export function cacheStatusLabel(status: CacheStatus): string {
  return status === 'used' ? 'Used' : status === 'not-used' ? 'Not used' : TOKEN_UNAVAILABLE;
}

export function stepTokenUsageView(usage: StepTokenUsage): StepTokenView {
  const total =
    usage.totalTokens ??
    (usage.inputTokens !== undefined && usage.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens
      : undefined);
  const summary = [
    total === undefined ? 'Token total unavailable' : `${compactTokenCount(total)} tokens`,
    usage.cachedReadTokens && usage.cachedReadTokens > 0 ? `${compactTokenCount(usage.cachedReadTokens)} cached` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const accessible = [
    usage.inputTokens === undefined
      ? 'Input tokens not reported'
      : `${usage.inputTokens.toLocaleString()} input tokens`,
    usage.outputTokens === undefined
      ? 'Output tokens not reported'
      : `${usage.outputTokens.toLocaleString()} output tokens`,
    total === undefined ? 'Total tokens not reported' : `${total.toLocaleString()} total tokens`,
  ];
  if (usage.cachedReadTokens !== undefined)
    accessible.push(`${usage.cachedReadTokens.toLocaleString()} cached input tokens`);
  if (usage.cacheWriteTokens !== undefined)
    accessible.push(`${usage.cacheWriteTokens.toLocaleString()} cache creation tokens`);
  if (usage.attempts > 1) accessible.push(`${usage.attempts} attempts`);
  if (usage.totalMismatch) accessible.push('Provider total differs from input plus output');
  return {
    input: format(usage.inputTokens),
    output: format(usage.outputTokens),
    total: format(total),
    cachedRead: format(usage.cachedReadTokens),
    cacheWrite: format(usage.cacheWriteTokens),
    cacheStatus: cacheStatusLabel(usage.cacheStatus),
    attempts: usage.attempts,
    totalMismatch: usage.totalMismatch,
    summary,
    accessibleLabel: accessible.join(', '),
  };
}

function componentName(stageId: string, stages: readonly TraceStage[]): string {
  const turn = /^step-(\d+)$/.exec(stageId)?.[1];
  if (turn) return `Orchestrator turn ${turn}`;
  if (stageId === 'synthesis') return 'Synthesis';
  return stages.find((stage) => stage.id === stageId)?.name || stageId;
}

function invocationView(invocation: TokenInvocationUsage, stages: readonly TraceStage[]): InvocationTokenView {
  const usage = stepTokenUsageView(invocation);
  return {
    id: invocation.invocationId,
    stageId: invocation.stageId,
    component: componentName(invocation.stageId, stages),
    attempt: invocation.attempt,
    input: usage.input,
    output: usage.output,
    cached: usage.cachedRead,
    total: usage.total,
    cacheStatus: usage.cacheStatus,
    totalMismatch: usage.totalMismatch,
  };
}

/**
 * One read model for every Run Explorer token surface.
 *
 * Run-level provider totals remain authoritative. Direct-stage sums are used
 * only when the provider omitted that run-level field.
 */
export function runTokenUsageView(trace: TraceSummary | null | undefined): RunTokenView {
  const stages = trace?.stages ?? [];
  const usage = stages.flatMap((stage) => (stage.token_usage ? [stage.token_usage] : []));
  const reconciliation = trace?.token_reconciliation;
  const inputTokens = count(trace?.prompt_tokens) ?? sum(usage.map((item) => item.inputTokens));
  const outputTokens = count(trace?.completion_tokens) ?? sum(usage.map((item) => item.outputTokens));
  const attributedTokens = count(reconciliation?.attributedTokens) ?? sum(usage.map((item) => item.totalTokens));
  const totalTokens =
    count(trace?.total_tokens) ??
    count(reconciliation?.overviewTokens) ??
    attributedTokens ??
    (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  const cachedReadTokens = count(reconciliation?.cachedReadTokens) ?? sum(usage.map((item) => item.cachedReadTokens));
  const cacheWriteTokens = sum(usage.map((item) => item.cacheWriteTokens));
  const cacheReported =
    reconciliation?.cachedReadTokens !== undefined ||
    usage.some((item) => item.cachedReadTokens !== undefined || item.cacheWriteTokens !== undefined);
  const invocations = (trace?.token_invocations ?? []).map((item) => invocationView(item, stages));
  const cacheCoveredInput =
    count(reconciliation?.cacheCoveredInputTokens) ??
    sum(usage.map((item) => (item.cachedReadTokens !== undefined ? item.inputTokens : undefined)));
  const cacheHitPercent =
    typeof reconciliation?.cacheHitPercent === 'number' && Number.isFinite(reconciliation.cacheHitPercent)
      ? reconciliation.cacheHitPercent
      : cachedReadTokens !== undefined && cacheCoveredInput !== undefined && cacheCoveredInput > 0
        ? Math.min(100, (cachedReadTokens / cacheCoveredInput) * 100)
        : undefined;
  const explicitUnattributed = count(reconciliation?.unattributedTokens);
  const unattributedTokens =
    explicitUnattributed ??
    (totalTokens !== undefined && attributedTokens !== undefined
      ? Math.max(0, totalTokens - attributedTokens)
      : undefined);
  return {
    available:
      totalTokens !== undefined ||
      inputTokens !== undefined ||
      outputTokens !== undefined ||
      usage.length > 0 ||
      invocations.length > 0,
    inputTokens,
    outputTokens,
    totalTokens,
    cachedReadTokens: cacheReported ? cachedReadTokens : undefined,
    cacheWriteTokens,
    cacheReported,
    cacheHitPercent,
    attributedTokens,
    attributedCalls: count(reconciliation?.attributedCalls),
    coveragePercent:
      typeof reconciliation?.coveragePercent === 'number' && Number.isFinite(reconciliation.coveragePercent)
        ? reconciliation.coveragePercent
        : undefined,
    unattributedTokens,
    invocations,
  };
}
