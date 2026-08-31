/**
 * The durable state used when a browser reconnects to a conversation.
 *
 * This is deliberately a poll of Lakebase-backed state, not a restart of the
 * ask request. The server invocation continues after the original HTTP
 * connection closes; a returning client only needs to learn whether it is
 * still working, replay the steps it has taken, and then reload the stored
 * answer.
 */
import { normalizeStage, type TraceStage } from './answer-shape';

export interface ConversationRunStatus {
  run_id: string;
  state: string;
  created_at: string;
  updated_at: string;
  terminal_code: string | null;
  /**
   * The stored response this terminal ledger row points at.
   *
   * Optional so a client can outlive a server that predates the field. A
   * successful run without it stays Live rather than borrowing the previous
   * turn's summary.
   */
  terminal_message_id?: string | null;
  /**
   * The steps the run has reported so far, as the server recorded them.
   *
   * THE HALF THAT WAS MISSING. The state and the timestamps say a run is
   * working; they cannot say what it has done, and a reopened conversation
   * therefore showed a question, a shut composer and an empty agent path for
   * the rest of the run. Absent on a run recorded before the server stored its
   * narration, and absent on a turn that answers with a plan and takes no
   * steps -- both of which are the same thing to a reader: no steps to show.
   */
  stages?: unknown;
}

const WORKING_STATES = new Set(['RECEIVED', 'PLANNING', 'RUNNING', 'SYNTHESIZING']);

export type WorkingConversationRun = ConversationRunStatus & {
  state: 'RECEIVED' | 'PLANNING' | 'RUNNING' | 'SYNTHESIZING';
};

export function isWorkingConversationRun(status: ConversationRunStatus | null): status is WorkingConversationRun {
  return status !== null && WORKING_STATES.has(status.state);
}

/**
 * The steps a durable run carries, in the shape the live rail already draws.
 *
 * Normalized through the same `normalizeStage` the stream uses, so a replayed
 * step and a streamed one are the same object to every surface below: the rail
 * cannot come to draw them differently, and a row that arrived by replay and
 * is then superseded by its own completion off the live stream merges by id
 * rather than appearing twice.
 *
 * Anything that is not an array is no steps. A run whose narration could not
 * be read reports it as absent rather than as an outage, because that is what
 * it is to the reader: the run is still working and the app still says so.
 */
export function replayedStages(status: ConversationRunStatus | null): TraceStage[] {
  if (!status || !Array.isArray(status.stages)) return [];
  return status.stages.map((stage, index) => normalizeStage(stage, index));
}

/**
 * The parts of a durable run that materially move a live surface.
 *
 * `updated_at` is deliberately absent. Lease heartbeats can move that timestamp
 * without changing anything a reader sees; treating each heartbeat as progress
 * would pin fallback polling at its fastest cadence for an otherwise quiet run.
 */
export function conversationRunStateKey(status: ConversationRunStatus): string {
  return JSON.stringify({
    run: status.run_id,
    state: status.state,
    terminalCode: status.terminal_code,
    terminalMessage: status.terminal_message_id ?? null,
    stages: replayedStages(status).map((stage) => [
      stage.id,
      stage.status,
      stage.name,
      stage.start,
      stage.duration,
      stage.calls,
    ]),
  });
}

export async function readConversationRun(
  conversationId: string,
  fetchImpl: typeof fetch = fetch
): Promise<ConversationRunStatus | null> {
  const response = await fetchImpl(`/api/conversations/${encodeURIComponent(conversationId)}/run`);
  if (!response.ok) throw new Error('Conversation run unavailable');
  return (await response.json()) as ConversationRunStatus | null;
}
