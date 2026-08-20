/**
 * The durable state used when a browser reconnects to a conversation.
 *
 * This is deliberately a poll of Lakebase-backed state, not a restart of the
 * ask request. The server invocation continues after the original HTTP
 * connection closes; a returning client only needs to learn whether it is
 * still working and then reload the stored answer.
 */
export interface ConversationRunStatus {
  run_id: string;
  state: string;
  created_at: string;
  updated_at: string;
  terminal_code: string | null;
}

const WORKING_STATES = new Set(['RECEIVED', 'PLANNING', 'RUNNING', 'SYNTHESIZING']);

export function isWorkingConversationRun(status: ConversationRunStatus | null): status is ConversationRunStatus {
  return status !== null && WORKING_STATES.has(status.state);
}

export async function readConversationRun(
  conversationId: string,
  fetchImpl: typeof fetch = fetch
): Promise<ConversationRunStatus | null> {
  const response = await fetchImpl(`/api/conversations/${encodeURIComponent(conversationId)}/run`);
  if (!response.ok) throw new Error('Conversation run unavailable');
  return (await response.json()) as ConversationRunStatus | null;
}
