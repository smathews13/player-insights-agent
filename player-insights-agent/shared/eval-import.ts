import { IMPORT_FILTERS, type ImportFilter } from './benchmark-lab-v3';
import { WAREHOUSE_BUDGET_MS } from './eval-flywheel';

/**
 * Why a real Ask or Monitoring turn is a candidate for the evaluation set.
 *
 * Filters are stated on the Evaluation set surface. A turn can match more
 * than one. Nothing is invented: a missing duration is not "fast", a missing
 * judge is not a low score, and an unrated turn is not customer feedback.
 */

export interface ImportTraceSignals {
  question: string;
  sourceTraceId?: string;
  durationMs?: number | null;
  outcome?: string | null;
  feedback?: 'up' | 'down' | null;
  judges?: readonly { value: 'yes' | 'no' | null }[];
  toolCalls?: number | null;
}

export function importReasonsFromTrace(input: ImportTraceSignals): ImportFilter[] {
  const reasons: ImportFilter[] = [];
  if ((input.judges ?? []).some((entry) => entry.value === 'no')) reasons.push('low_judge_score');
  const outcome = (input.outcome ?? '').toLowerCase();
  if (outcome === 'failed' || outcome === 'error') reasons.push('tool_failure');
  if (
    typeof input.durationMs === 'number' &&
    Number.isFinite(input.durationMs) &&
    input.durationMs >= WAREHOUSE_BUDGET_MS
  ) {
    reasons.push('latency');
  }
  if (input.feedback === 'down') reasons.push('customer_feedback');
  return reasons;
}

export function matchesImportFilters(reasons: readonly ImportFilter[], selected: readonly ImportFilter[]): boolean {
  if (selected.length === 0) return reasons.length > 0;
  return selected.some((filter) => reasons.includes(filter));
}

export const IMPORT_FILTER_ORDER: readonly ImportFilter[] = IMPORT_FILTERS;
