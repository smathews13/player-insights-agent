import { describe, expect, it } from 'vitest';

import { conversationRunTrace } from './insights-routes';
import { DEFAULT_RUNTIME_SETTINGS } from '../../shared/runtime-settings';

const SENT = {
  ...DEFAULT_RUNTIME_SETTINGS,
  loop: { maxSteps: 10, maxToolCalls: 15, maxRunSeconds: 200 },
  answer: {
    ...DEFAULT_RUNTIME_SETTINGS.answer,
    takeaway: false,
    narrativeMaxCharacters: 800,
    figuresOrder: 'totals-first' as const,
  },
};

const TRACE = { id: 'tr-1', totalMs: 1200, toolCalls: 2, stages: [] };

function row(response: Record<string, unknown>) {
  return {
    id: 'msg-1',
    conversation_id: 'conv-1',
    created_at: '2026-08-20T12:00:00Z',
    prompt: 'How many players?',
    stakeholder: 'analyst@example.test',
    response_json: {
      type: 'answer',
      takeaway: 'Weekly actives fell 4 percent.',
      narrative: 'PC led.',
      sql: '',
      figures: [],
      sources: [],
      caveats: [],
      trace: TRACE,
      ...response,
    },
  };
}

describe('the run trace carries the runtime that Ask sent', () => {
  it('surfaces the snapshot on the run, including answer flags that affected it', () => {
    const trace = conversationRunTrace(row({ runtime_settings: SENT }), '');
    expect(trace.runtimeUsed?.loop).toEqual({ maxSteps: 10, maxToolCalls: 15, maxRunSeconds: 200 });
    expect(trace.runtimeUsed?.answer.takeaway).toBe(false);
    expect(trace.runtimeUsed?.answer.narrativeMaxCharacters).toBe(800);
    expect(trace.runtimeUsed?.answer.figuresOrder).toBe('totals-first');
  });

  it('says nothing rather than inventing 12/12/150 when the run stored no snapshot', () => {
    const trace = conversationRunTrace(row({}), '');
    expect(trace.runtimeUsed).toBeNull();
  });
});
