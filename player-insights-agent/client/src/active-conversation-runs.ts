import type { ConversationRunStatus } from './conversation-run';

export type ActiveConversationRuns = ReadonlyMap<string, ConversationRunStatus>;

const MAX_ACTIVE_RUNS = 32;

export function trackActiveConversationRun(
  current: ActiveConversationRuns,
  conversationId: string,
  status: ConversationRunStatus
): ActiveConversationRuns {
  const next = new Map(current);
  next.delete(conversationId);
  next.set(conversationId, status);
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
  terminalSummaryReady: boolean
): ActiveConversationRuns {
  return terminalSummaryReady ? forgetActiveConversationRun(current, conversationId) : current;
}

export function conversationIsLive(
  current: ActiveConversationRuns,
  conversationId: string,
  streamed = false
): boolean {
  return streamed || current.has(conversationId);
}
