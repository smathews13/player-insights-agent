import { describe, expect, it } from 'vitest';

import {
  conversationIsLive,
  settleActiveConversationRun,
  trackActiveConversationRun,
  type ActiveConversationRuns,
} from './active-conversation-runs';
import type { ConversationRunStatus } from './conversation-run';

const runningA: ConversationRunStatus = {
  run_id: 'run-a',
  state: 'RUNNING',
  created_at: '2026-08-27T20:00:00Z',
  updated_at: '2026-08-27T20:00:05Z',
  terminal_code: null,
  stages: [{ id: 'step-05', name: 'Step 05', status: 'running' }],
};

describe('conversation-keyed rail runs', () => {
  it('keeps A live while B is open, then settles only A after its summary arrives', () => {
    let active: ActiveConversationRuns = new Map();
    active = trackActiveConversationRun(active, 'conversation-a', runningA);

    const selectedConversation = 'conversation-b';
    const transcripts = {
      'conversation-a': ['question A'],
      'conversation-b': ['question B', 'answer B'],
    };

    expect(selectedConversation).toBe('conversation-b');
    expect(conversationIsLive(active, 'conversation-a')).toBe(true);

    // A terminal status alone is not enough: the old Failed summary must remain
    // hidden until the fresh terminal `/api/runs` summary can replace it.
    const terminal = {
      ...runningA,
      state: 'SUCCEEDED',
      terminal_message_id: 'answer-a',
      updated_at: '2026-08-27T20:01:00Z',
    };
    active = settleActiveConversationRun(active, 'conversation-a', terminal, null);
    expect(conversationIsLive(active, 'conversation-a')).toBe(true);

    active = settleActiveConversationRun(active, 'conversation-a', terminal, {
      runId: 'answer-a',
      status: 'Complete',
      tone: 'ast-pill--pos',
      durationMs: 60_000,
      rating: null,
      truncated: false,
    });
    expect(conversationIsLive(active, 'conversation-a')).toBe(false);
    expect(transcripts['conversation-b']).toEqual(['question B', 'answer B']);
  });

  it('preserves Live across a transient status-read failure so polling can retry', () => {
    const active = trackActiveConversationRun(new Map(), 'conversation-a', runningA);

    // A rejected read produces no registry mutation.
    const afterFailedRead = active;

    expect(afterFailedRead).toBe(active);
    expect(conversationIsLive(afterFailedRead, 'conversation-a')).toBe(true);
  });

  it('settles legacy terminal rows that predate terminal message ids', () => {
    const active = trackActiveConversationRun(new Map(), 'conversation-a', runningA);
    const settled = settleActiveConversationRun(
      active,
      'conversation-a',
      {
        ...runningA,
        state: 'SUCCEEDED',
        updated_at: '2026-08-27T20:01:00Z',
      },
      null
    );

    expect(conversationIsLive(settled, 'conversation-a')).toBe(false);
    expect(settled.get('conversation-a')?.summary).toMatchObject({
      runId: 'run-a',
      status: 'Complete',
      tone: 'ast-pill--pos',
    });
  });

  it('parks a proposed plan as Approval needed instead of leaving a stale Live run', () => {
    const active = trackActiveConversationRun(new Map(), 'conversation-a', runningA);
    const waiting = {
      ...runningA,
      state: 'AWAITING_APPROVAL',
      updated_at: '2026-08-27T20:00:10Z',
    };
    const settled = settleActiveConversationRun(active, 'conversation-a', waiting, null);

    expect(conversationIsLive(settled, 'conversation-a')).toBe(false);
    expect(settled.get('conversation-a')).toMatchObject({
      status: waiting,
      summary: {
        runId: 'run-a',
        status: 'Approval needed',
        tone: 'ast-pill--neutral-outline',
      },
    });
  });

  it('resumes the same parked run when the plan is approved', () => {
    const active = trackActiveConversationRun(new Map(), 'conversation-a', runningA);
    const waiting = {
      ...runningA,
      state: 'AWAITING_APPROVAL',
      updated_at: '2026-08-27T20:00:10Z',
    };
    const parked = settleActiveConversationRun(active, 'conversation-a', waiting, null);
    const resumed = trackActiveConversationRun(parked, 'conversation-a', {
      ...runningA,
      state: 'RUNNING',
      updated_at: '2026-08-27T20:00:20Z',
    });

    expect(conversationIsLive(resumed, 'conversation-a')).toBe(true);
    expect(resumed.get('conversation-a')).toMatchObject({
      status: { state: 'RUNNING', run_id: 'run-a' },
      summary: null,
    });
  });
});
