import { useSyncExternalStore } from 'react';

import { isWorkingConversationRun, replayedStages, type ConversationRunStatus } from './conversation-run';
import { mergeReplayedStages } from './live-progress';
import type { RailRunSummary } from './rail-run-summary';

export interface ActiveConversationRun {
  /** The newest authoritative ledger row observed for this run. */
  status: ConversationRunStatus;
  /**
   * The terminal rail reading, present only after the ledger reached a terminal
   * state and any message-derived verdict was matched to that exact run.
   */
  summary: RailRunSummary | null;
}

export type ActiveConversationRuns = ReadonlyMap<string, ActiveConversationRun>;

const MAX_ACTIVE_RUNS = 32;
const DIRECT_TERMINALS = new Set(['REFUSED', 'FAILED', 'DEADLINE_EXCEEDED', 'PERSISTENCE_FAILED']);

function directLedgerSummary(status: ConversationRunStatus): RailRunSummary | null {
  if (status.state === 'AWAITING_APPROVAL') {
    return {
      runId: status.run_id,
      status: 'Approval needed',
      tone: 'ast-pill--neutral-outline',
      durationMs: null,
      rating: null,
      truncated: false,
    };
  }
  if (status.state === 'CANCELLED') {
    return {
      runId: status.run_id,
      status: 'Stopped',
      tone: 'ast-pill--neg',
      durationMs: null,
      rating: null,
      truncated: true,
    };
  }
  if (DIRECT_TERMINALS.has(status.state)) {
    return {
      runId: status.run_id,
      status: 'Failed',
      tone: 'ast-pill--neg',
      durationMs: null,
      rating: null,
      truncated: status.state === 'DEADLINE_EXCEEDED',
    };
  }
  return null;
}

/**
 * Resolve a non-executing rail reading without borrowing one from another turn.
 *
 * Approval waits, failures and cancellation are fully described by the ledger
 * row itself. Approval is deliberately not terminal, but it is equally
 * important that the browser stop calling it Live: no executor or lease remains
 * while a person reviews the plan.
 * Successful/clarifying runs need the message-derived verdict to distinguish
 * Complete from Partial, and that verdict is accepted only when its message id
 * is the terminal message id recorded on the same ledger row.
 */
export function terminalConversationRunSummary(
  status: ConversationRunStatus,
  summary: RailRunSummary | null = null
): RailRunSummary | null {
  const direct = directLedgerSummary(status);
  if (direct) return direct;
  if (status.state !== 'SUCCEEDED' && status.state !== 'CLARIFICATION_REQUIRED') return null;
  const messageId = status.terminal_message_id?.trim();
  if (messageId) return summary?.runId === messageId ? summary : null;
  // Rows written before terminal_message_id was added still carry an
  // authoritative terminal state. Do not leave those runs Live forever merely
  // because the older row cannot be joined to a message-level verdict.
  return {
    runId: status.run_id,
    status: status.state === 'SUCCEEDED' ? 'Complete' : 'Partial',
    tone: status.state === 'SUCCEEDED' ? 'ast-pill--pos' : 'ast-pill--warn',
    durationMs: null,
    rating: null,
    truncated: status.state === 'CLARIFICATION_REQUIRED',
  };
}

function sameStatus(a: ConversationRunStatus, b: ConversationRunStatus): boolean {
  const aStages = replayedStages(a);
  const bStages = replayedStages(b);
  return (
    a.run_id === b.run_id &&
    a.state === b.state &&
    a.updated_at === b.updated_at &&
    a.terminal_code === b.terminal_code &&
    a.terminal_message_id === b.terminal_message_id &&
    aStages.length === bStages.length &&
    aStages.every((stage, index) => {
      const other = bStages[index];
      return (
        stage.id === other.id &&
        stage.status === other.status &&
        stage.name === other.name &&
        stage.start === other.start &&
        stage.duration === other.duration
      );
    })
  );
}

function sameSummary(a: RailRunSummary, b: RailRunSummary): boolean {
  return (
    a.runId === b.runId &&
    a.status === b.status &&
    a.tone === b.tone &&
    a.durationMs === b.durationMs &&
    a.rating === b.rating &&
    a.truncated === b.truncated
  );
}

function newerRun(candidate: ConversationRunStatus, held: ConversationRunStatus): boolean {
  const candidateAt = Date.parse(candidate.created_at);
  const heldAt = Date.parse(held.created_at);
  if (Number.isFinite(candidateAt) && Number.isFinite(heldAt)) return candidateAt >= heldAt;
  return true;
}

export function trackActiveConversationRun(
  current: ActiveConversationRuns,
  conversationId: string,
  status: ConversationRunStatus
): ActiveConversationRuns {
  const held = current.get(conversationId);
  if (held) {
    if (held.status.run_id !== status.run_id && !newerRun(status, held.status)) return current;
    // A late working read cannot reopen a terminal ledger row. Approval is the
    // one summarized state that is intentionally resumable: the same run moves
    // from AWAITING_APPROVAL back into RUNNING when the person approves it.
    if (
      held.status.run_id === status.run_id &&
      held.summary &&
      held.status.state !== 'AWAITING_APPROVAL' &&
      isWorkingConversationRun(status)
    )
      return current;
    if (
      held.status.run_id === status.run_id &&
      isWorkingConversationRun(held.status) &&
      isWorkingConversationRun(status)
    ) {
      const stages = mergeReplayedStages(replayedStages(held.status), replayedStages(status));
      status = { ...status, stages };
    }
    if (held.summary === null && sameStatus(held.status, status)) return current;
  }
  const next = new Map(current);
  next.delete(conversationId);
  next.set(conversationId, { status, summary: null });
  while (next.size > MAX_ACTIVE_RUNS) {
    const oldest = next.keys().next().value;
    if (!oldest) break;
    next.delete(oldest);
  }
  return next;
}

export function forgetActiveConversationRun(
  current: ActiveConversationRuns,
  conversationId: string
): ActiveConversationRuns {
  if (!current.has(conversationId)) return current;
  const next = new Map(current);
  next.delete(conversationId);
  return next;
}

export function settleActiveConversationRun(
  current: ActiveConversationRuns,
  conversationId: string,
  status: ConversationRunStatus,
  summary: RailRunSummary | null = null
): ActiveConversationRuns {
  const held = current.get(conversationId);
  if (!held || held.status.run_id !== status.run_id) return current;
  const terminalSummary = terminalConversationRunSummary(status, summary);
  if (!terminalSummary) return current;
  if (held.summary && sameStatus(held.status, status) && sameSummary(held.summary, terminalSummary)) return current;
  const next = new Map(current);
  next.delete(conversationId);
  next.set(conversationId, { status, summary: terminalSummary });
  return next;
}

/**
 * Settle the exact run whose stream just delivered a terminal event.
 *
 * The caller supplies only terminal facts. Everything else is copied from the
 * registry row after its run id is matched, so a callback holding an old render's
 * status cannot manufacture a second run or overwrite a newer follow-up.
 */
export function settleActiveConversationRunById(
  current: ActiveConversationRuns,
  conversationId: string,
  runId: string,
  terminal: {
    state: string;
    terminalMessageId?: string | null;
    terminalCode?: string | null;
    summary?: RailRunSummary | null;
  }
): ActiveConversationRuns {
  const held = current.get(conversationId);
  if (!held || held.status.run_id !== runId) return current;
  const now = new Date().toISOString();
  return settleActiveConversationRun(
    current,
    conversationId,
    {
      ...held.status,
      state: terminal.state,
      updated_at: now,
      terminal_code: terminal.terminalCode ?? null,
      terminal_message_id: terminal.terminalMessageId ?? null,
    },
    terminal.summary ?? null
  );
}

export function conversationIsLive(current: ActiveConversationRuns, conversationId: string, streamed = false): boolean {
  return streamed || isWorkingConversationRun(current.get(conversationId)?.status ?? null);
}

type Listener = () => void;
const listeners = new Set<Listener>();
let snapshot: ActiveConversationRuns = new Map();

export function subscribeToActiveConversationRuns(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateActiveConversationRuns(
  update: (current: ActiveConversationRuns) => ActiveConversationRuns
): void {
  const next = update(snapshot);
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

export function useActiveConversationRuns(): ActiveConversationRuns {
  return useSyncExternalStore(
    subscribeToActiveConversationRuns,
    () => snapshot,
    () => snapshot
  );
}

/** Synchronous registry read for stream/poll race guards. */
export function readActiveConversationRuns(): ActiveConversationRuns {
  return snapshot;
}

/** Clear run summaries when their browser/app session ends. */
export function clearActiveConversationRuns(): void {
  snapshot = new Map();
  listeners.clear();
}

/** Test isolation alias. */
export const resetActiveConversationRunsForTests = clearActiveConversationRuns;
