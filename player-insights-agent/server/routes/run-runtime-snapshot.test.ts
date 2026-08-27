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

  it('keeps the agent’s tool-call count and wall time when MLflow never recorded', () => {
    const trace = conversationRunTrace(
      row({
        trace: {
          id: 'trace-local',
          totalMs: 150_500,
          toolCalls: 4,
          prompt_tokens: 111_872,
          completion_tokens: 2_340,
          total_tokens: 114_212,
          stages: [
            {
              id: 'step-1-1-run_sql',
              name: 'Ran a governed read-only query',
              kind: 'tool',
              status: 'failed',
              start: 0,
              duration: 110_000,
              calls: 1,
              input: 'SELECT 1',
              output: 'timeout',
            },
          ],
        },
      }),
      ''
    );
    expect(trace.trace?.toolCalls).toBe(4);
    expect(trace.trace?.totalMs).toBe(150_500);
    expect(trace.trace?.total_tokens).toBe(114_212);
    expect(trace.trace?.stages).toEqual([]);
    expect(trace.toolStages).toEqual([]);
  });
});
