import { describe, expect, it } from 'vitest';

import { terminalSettlementForResponse } from './ask-terminal-state';
import type { ClarificationResponse, PlanResponse } from './app-types';

describe('SSE terminal response projection', () => {
  it('parks an approval response without leaving it Live', () => {
    const plan: PlanResponse = {
      type: 'plan',
      mode: 'live',
      plan: {
        id: 'plan-1',
        question: 'Compare titles',
        summary: 'Review the comparison plan.',
        steps: [],
        requires_approval: true,
        uses_conversation_context: false,
        uses_attachment_context: false,
      },
    };

    expect(terminalSettlementForResponse(plan, plan)).toEqual({ state: 'AWAITING_APPROVAL' });
  });

  it('matches a clarification to its persisted message id', () => {
    const clarification: ClarificationResponse = {
      type: 'clarification',
      mode: 'live',
      clarification: {
        id: 'clarification-1',
        question: 'Which period?',
        options: ['Last week'],
        trace: { id: 'tr-1234567890abcdef', totalMs: 42, toolCalls: 0, stages: [] },
      },
    };

    expect(terminalSettlementForResponse(clarification, clarification)).toMatchObject({
      state: 'CLARIFICATION_REQUIRED',
      terminalMessageId: 'msg-clarification-1',
      summary: { runId: 'msg-clarification-1', status: 'Partial' },
    });
  });
});
