import type { TraceStage } from './answer-shape';
import { toolNameFromId } from './trace-timeline';

/**
 * Count only tool identities that the trace actually recorded.
 *
 * Current tool stages carry a stable name after `step-{n}-{index}-`; older
 * top-level stages such as `plot` use their id. If either the call counter or
 * the identities are incomplete, the subtitle stays generic instead of
 * presenting a made-up reconciliation.
 */
export function agentToolCallSubtitle(calls: number | null | undefined, stages: readonly TraceStage[]): string {
  if (typeof calls !== 'number' || !Number.isFinite(calls) || calls < 0) return 'Governed tool invocations';

  const toolStages = stages.filter((stage) => stage.kind === 'tool');
  const tools = new Set(toolStages.map((stage) => toolNameFromId(stage.id) || stage.id.trim()).filter(Boolean));
  const identifiedCalls = toolStages.reduce(
    (sum, stage) => sum + (Number.isFinite(stage.calls) && stage.calls >= 0 ? stage.calls : 0),
    0
  );
  if (calls <= 0 || tools.size <= 0 || identifiedCalls !== calls) return 'Governed tool invocations';

  return `${calls.toLocaleString()} call${calls === 1 ? '' : 's'} across ${tools.size.toLocaleString()} tool${
    tools.size === 1 ? '' : 's'
  }`;
}
