import type { TraceStage } from './answer-shape';
import type { Conversation, Run } from './app-types';
import { runLabel } from './run-label';
import { identityName } from './user-identity';

/** Withheld owner on a shared benchmark run. Not a username that has runs. */
const SHARED_RUN_OWNER = 'Another team member';

/**
 * Run ids are opaque, but they are still identifiers rather than arbitrary URL
 * payloads. This accepts the UUID/run_* forms the stores use while rejecting
 * empty, path-like, whitespace, and unreasonably large query values before they
 * can become a detail request.
 */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function validRunId(value: string | null): value is string {
  return typeof value === 'string' && RUN_ID.test(value);
}

export type RunSelection =
  | { state: 'empty'; run: null; automaticRunId: null }
  | { state: 'invalid'; run: null; automaticRunId: null }
  | { state: 'selected'; run: Run; automaticRunId: string | null };

/**
 * Resolve the detail pane from the address bar and the healthy run list.
 *
 * A named run is authoritative: if it is invalid or has disappeared, the page
 * does not silently substitute a different run. With no `run` parameter, the
 * conversation deep link picks its newest run and the ordinary entry picks the
 * newest run overall; callers replace the URL with that automatic choice.
 */
export function resolveRunSelection(
  runs: readonly Run[],
  requestedRunId: string | null,
  requestedConversationId: string | null
): RunSelection {
  if (runs.length === 0) return { state: 'empty', run: null, automaticRunId: null };
  if (requestedRunId !== null) {
    if (!validRunId(requestedRunId)) return { state: 'invalid', run: null, automaticRunId: null };
    const requested = runs.find((run) => run.id === requestedRunId);
    return requested
      ? { state: 'selected', run: requested, automaticRunId: null }
      : { state: 'invalid', run: null, automaticRunId: null };
  }
  const automatic =
    (requestedConversationId ? runs.find((run) => run.conversation_id === requestedConversationId) : undefined) ??
    runs[0];
  return { state: 'selected', run: automatic, automaticRunId: automatic.id };
}

/** Change only `run`; filters, conversation context, and unrelated deep-link data survive. */
export function searchWithRun(search: URLSearchParams, runId: string): URLSearchParams {
  const next = new URLSearchParams(search);
  next.set('run', runId);
  return next;
}

export type RunDetailMode = 'loading' | 'empty' | 'invalid' | 'missing' | 'error' | 'ready';

/** One exhaustive state for the whole detail pane, rather than per-widget guesses. */
export function runDetailMode(input: {
  listLoading: boolean;
  listOrigin: 'stored' | 'empty' | 'unavailable' | null;
  selection: RunSelection['state'];
  trace: 'idle' | 'loading' | 'ready' | 'missing' | 'error';
}): RunDetailMode {
  if (input.listLoading) return 'loading';
  if (input.listOrigin === 'unavailable') return 'error';
  if (input.selection === 'empty') return 'empty';
  if (input.selection === 'invalid') return 'invalid';
  if (input.trace === 'missing') return 'missing';
  if (input.trace === 'error') return 'error';
  if (input.trace === 'ready') return 'ready';
  return 'loading';
}

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
