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
    active = settleActiveConversationRun(active, 'conversation-a', false);
    expect(conversationIsLive(active, 'conversation-a')).toBe(true);

    active = settleActiveConversationRun(active, 'conversation-a', true);
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
});
