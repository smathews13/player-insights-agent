import { answerRunVerdict } from '../../shared/run-verdict';
import { settleActiveConversationRunById, updateActiveConversationRuns } from './active-conversation-runs';
import type { AgentResponse } from './app-types';
import { endLiveAsk } from './live-ask';
import type { RailRunSummary, RailStatusTone } from './rail-run-summary';

export interface AskTerminalSettlement {
  state: string;
  terminalMessageId?: string | null;
  terminalCode?: string | null;
  summary?: RailRunSummary | null;
}

function summary(
  runId: string,
  status: string,
  tone: RailStatusTone,
  durationMs: number | null,
  truncated = false
): RailRunSummary {
  return { runId, status, tone, durationMs, feedback: null, truncated };
}

/**
 * Terminal facts carried by an SSE result after the server persisted/settled it.
 *
 * This is intentionally derived from the result itself, not from a component's
 * last durable-poll closure. The stream and ledger use the same run id, while
 * the response names the exact message the server wrote before sending `result`.
 */
export function terminalSettlementForResponse(response: AgentResponse, raw: unknown): AskTerminalSettlement {
  if (response.type === 'plan') return { state: 'AWAITING_APPROVAL' };
  if (response.type === 'clarification') {
    const messageId = `msg-${response.clarification.id}`;
    return {
      state: 'CLARIFICATION_REQUIRED',
      terminalMessageId: messageId,
      summary: summary(messageId, 'Partial', 'ast-pill--warn', response.clarification.trace.totalMs),
    };
  }

  const runStored = !raw || typeof raw !== 'object' || (raw as { runStored?: unknown }).runStored !== false;
  if (!runStored) {
    return {
      state: 'PERSISTENCE_FAILED',
      terminalCode: 'PERSISTENCE_UNAVAILABLE',
    };
  }

  const verdict = answerRunVerdict({
    stages: response.trace.stages,
    caveats: response.caveats,
    figures: response.figures,
    narrative: response.narrative,
    content: response.content,
  });
  const presentation = {
    complete: ['Complete', 'ast-pill--pos'],
    partial: ['Partial', 'ast-pill--warn'],
    failed: ['Failed', 'ast-pill--neg'],
  } as const;
  const [status, tone] = presentation[verdict];
  return {
    state: 'SUCCEEDED',
    terminalMessageId: response.id,
    summary: summary(response.id, status, tone, response.trace.totalMs),
  };
}

export function failedAskSettlement(state = 'FAILED', terminalCode: string | null = null): AskTerminalSettlement {
  return { state, terminalCode };
}

/**
 * Remove both render-time Live sources for one exact run.
 *
 * Kept synchronous and called before any answer/message state update. React may
 * observe either registry notification, but at that point the answer is not yet
 * visible; once the caller appends it, both registries are already terminal.
 */
export function settleAskDisplay(conversationId: string, runId: string, terminal: AskTerminalSettlement): void {
  if (!runId) return;
  updateActiveConversationRuns((runs) => settleActiveConversationRunById(runs, conversationId, runId, terminal));
  endLiveAsk(conversationId, runId);
}
