import type { TraceStage } from './answer-shape';
import type { Run } from './app-types';

function isDataWork(stage: TraceStage): boolean {
  return stage.kind === 'tool' || /data.source.finder|\bsql\b/i.test(`${stage.id} ${stage.name}`);
}

function enclosingIds(stage: TraceStage, byId: Map<string, TraceStage>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([stage.id]);
  let above = stage.parent_id ? byId.get(stage.parent_id) : undefined;
  while (above && !seen.has(above.id)) {
    chain.push(above.id);
    seen.add(above.id);
    above = above.parent_id ? byId.get(above.parent_id) : undefined;
  }
  return chain;
}

function coveredMs(spans: readonly { from: number; to: number }[]): number {
  const ordered = [...spans].filter((span) => span.to > span.from).sort((left, right) => left.from - right.from);
  let covered = 0;
  let open: { from: number; to: number } | null = null;
  for (const span of ordered) {
    if (!open || span.from > open.to) {
      if (open) covered += open.to - open.from;
      open = { from: span.from, to: span.to };
    } else if (span.to > open.to) {
      open.to = span.to;
    }
  }
  return open ? covered + (open.to - open.from) : covered;
}

export function toolStageDurationMs(stages: readonly TraceStage[], wallMs?: number | null): number | null {
  const dataWork = stages.filter(isDataWork);
  if (!dataWork.length) return null;
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const containers = new Set(dataWork.flatMap((stage) => enclosingIds(stage, byId)));
  const innermost = dataWork.filter((stage) => !containers.has(stage.id));
  const counted = innermost.length ? innermost : dataWork;
  const total = counted.every((stage) => stage.startMeasured === true)
    ? coveredMs(counted.map((stage) => ({ from: stage.start, to: stage.start + stage.duration })))
    : counted.reduce((sum, stage) => sum + stage.duration, 0);
  return typeof wallMs === 'number' && wallMs > 0 && total > wallMs ? wallMs : total;
}

export const KPI_HINTS = {
  wallTime: 'How long this run took from end to end, from the question arriving to the answer being stored.',
  toolStageTime:
    'How much of that run was spent in data work, counting nested and parallel steps once rather than twice.',
  agentToolCalls: 'How many external tool calls the agent recorded making while it answered this question.',
  llmTokens: 'How many tokens the model gateway metred for this run, split into the prompt and the reply.',
  userRating: 'What a person scored this answer out of five, or Not rated when nobody has scored it yet.',
} as const;

export function conversationRunTitle(runs: readonly Run[], selected: Run | null): string | undefined {
  if (!selected?.conversation_id) return undefined;
  const chronological = [...runs].reverse();
  const conversations = [...new Set(chronological.map((run) => run.conversation_id).filter(Boolean))];
  const conversation = conversations.indexOf(selected.conversation_id) + 1;
  const inConversation = chronological.filter((run) => run.conversation_id === selected.conversation_id);
  const run = inConversation.findIndex((item) => item.id === selected.id) + 1;
  return conversation > 0 && run > 0 ? `Conversation ${conversation}, Run ${run}` : undefined;
}

export function conversationFilterOptions(runs: readonly Run[]): Array<{ id: string; label: string }> {
  const ids = [...new Set([...runs].reverse().map((run) => run.conversation_id).filter((id): id is string => Boolean(id)))];
  return ids.map((id, index) => ({ id, label: `Conversation ${index + 1}` }));
}
