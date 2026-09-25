import { isMlflowTraceId } from '../../shared/mlflow-trace-id';
import { foldRecordedStages } from '../../shared/prose-only-answer';
import { TraceSchema } from '../../shared/run-trace-contract';

/**
 * The run trace stored beside a report or dashboard.
 *
 * The documents remain reader-facing and trace-free. Their stored envelope
 * still needs run evidence because the rail, Run Explorer, Monitoring, Ops and
 * spend views all read `response_json.trace`.
 */
export function documentRunTrace(
  endpointResult: unknown,
  collectedStages: readonly Record<string, unknown>[],
  platformTraceId: string | null | undefined
): Record<string, unknown> {
  const custom =
    endpointResult && typeof endpointResult === 'object'
      ? (endpointResult as { custom_outputs?: unknown }).custom_outputs
      : undefined;
  const sent = custom && typeof custom === 'object' ? (custom as Record<string, unknown>).trace : undefined;
  const parsed = TraceSchema.safeParse(sent);
  if (parsed.success) return parsed.data;

  const folded = foldRecordedStages(collectedStages);
  return {
    id: isMlflowTraceId(platformTraceId) ? platformTraceId : '',
    totalMs: documentWallClockMs(folded.stages, collectedStages),
    toolCalls: folded.toolCalls,
    stages: folded.stages,
  };
}

/** Wall time rather than the sum of nested stage durations. */
export function documentWallClockMs(
  folded: readonly { id?: string; duration: number }[],
  raw: readonly Record<string, unknown>[]
): number {
  const root = folded.find((stage) => stage.id === 'orchestrator');
  if (root && Number.isFinite(root.duration) && root.duration > 0) return root.duration;
  let end = 0;
  for (const stage of raw) {
    const start = typeof stage.start === 'number' && Number.isFinite(stage.start) ? stage.start : 0;
    const duration = typeof stage.duration === 'number' && Number.isFinite(stage.duration) ? stage.duration : 0;
    end = Math.max(end, start + duration);
  }
  return end;
}
