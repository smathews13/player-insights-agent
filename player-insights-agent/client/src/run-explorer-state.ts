import type { TraceStage } from './answer-shape';
import type { Conversation, Run } from './app-types';
import { runLabel } from './run-label';
import { identityName } from './user-identity';

/** Withheld owner on a shared benchmark run. Not a username that has runs. */
const SHARED_RUN_OWNER = 'Another team member';

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

export function conversationRunNumber(runs: readonly Run[], selected: Run | null): number | undefined {
  if (!selected?.conversation_id) return undefined;
  const chronological = [...runs].reverse();
  const inConversation = chronological.filter((run) => run.conversation_id === selected.conversation_id);
  const run = inConversation.findIndex((item) => item.id === selected.id) + 1;
  return run > 0 ? run : undefined;
}

const CONVERSATION_SUMMARY_LIMIT = 56;

export function conversationSummary(run: Run): string {
  const summary = runLabel(run).replace(/\s+/g, ' ').trim();
  if (summary.length <= CONVERSATION_SUMMARY_LIMIT) return summary;
  const clipped = summary.slice(0, CONVERSATION_SUMMARY_LIMIT + 1);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, lastSpace > 0 ? lastSpace : CONVERSATION_SUMMARY_LIMIT).trimEnd()}…`;
}

/**
 * Which conversations the filter offers, and what each one is called.
 *
 * THE STORED ROWS DECIDE WHICH EXIST. This was built from the runs alone, so a
 * conversation appeared here only once a turn inside it had stored a trace, and
 * the Ask rail -- which reads the conversation rows -- listed a different set.
 * One store, two answers to "how many conversations are there", which is what
 * a reader saw as three on one page and six on the other.
 *
 * The runs still decide the LABEL, because a thread's opening question reads
 * better in a filter than its stored title. A conversation with no run yet
 * keeps its title rather than being dropped, which is the honest ordering: it
 * exists, and nothing has been asked in it.
 */
export function conversationFilterOptions(
  conversations: readonly Conversation[],
  runs: readonly Run[]
): Array<{ id: string; label: string }> {
  const firstRunByConversation = new Map<string, Run>();
  for (const run of [...runs].reverse()) {
    if (run.conversation_id && !firstRunByConversation.has(run.conversation_id)) {
      firstRunByConversation.set(run.conversation_id, run);
    }
  }
  const options = conversations.map((conversation) => {
    const firstRun = firstRunByConversation.get(conversation.id);
    return {
      id: conversation.id,
      label: firstRun ? conversationSummary(firstRun) : conversation.title,
    };
  });
  const seen = new Set(options.map((option) => option.id));
  for (const [id, run] of firstRunByConversation) {
    if (seen.has(id)) continue;
    options.push({ id, label: conversationSummary(run) });
    seen.add(id);
  }
  return options;
}

/**
 * Usernames that actually have a run in this list. Local part only, sorted,
 * never invented: a person who has not asked does not appear.
 */
export function usernameFilterOptions(runs: readonly Run[]): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>();
  for (const run of runs) {
    const raw = run.stakeholder?.trim() ?? '';
    if (!raw || raw === SHARED_RUN_OWNER) continue;
    const name = identityName(raw);
    if (!name || name === 'Unknown') continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen.entries()]
    .sort((left, right) => left[1].localeCompare(right[1]))
    .map(([value, label]) => ({ value, label }));
}

/**
 * The recent-runs list after conversation, username, and search all apply.
 */
export function matchingRuns(
  runs: readonly Run[],
  filters: { conversationId?: string; username?: string; search?: string }
): Run[] {
  const search = (filters.search ?? '').toLowerCase();
  const username = (filters.username ?? '').toLowerCase();
  return runs.filter((run) => {
    const inConversation = !filters.conversationId || run.conversation_id === filters.conversationId;
    const inUser = !username || identityName(run.stakeholder).toLowerCase() === username;
    const haystack = `${runLabel(run)} ${run.stakeholder ?? ''} ${run.conversation_id ?? ''} ${identityName(run.stakeholder)}`;
    const matchesSearch = haystack.toLowerCase().includes(search);
    return inConversation && inUser && matchesSearch;
  });
}
