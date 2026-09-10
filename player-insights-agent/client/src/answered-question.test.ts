import { describe, expect, it } from 'vitest';
import type { ConversationMessage } from './app-types';
import { answeredQuestion } from './answered-question';

const APPROVAL = 'Approved the proposed analysis plan.';

function message(id: string, role: ConversationMessage['role'], content: string): ConversationMessage {
  return { id, role, content };
}

describe('answeredQuestion', () => {
  it('uses the immediately preceding reader question for a normal answer', () => {
    const messages = [
      message('question', 'user', 'Which title grew fastest?'),
      message('answer', 'assistant', 'Halo.'),
    ];

    expect(answeredQuestion(messages, 1, APPROVAL)).toBe('Which title grew fastest?');
  });

  it('skips the synthetic plan approval turn', () => {
    const messages = [
      message('question', 'user', 'Which title grew fastest?'),
      message('plan', 'assistant', 'Plan'),
      message('approval', 'user', APPROVAL),
      message('answer', 'assistant', 'Halo.'),
    ];

    expect(answeredQuestion(messages, 3, APPROVAL)).toBe('Which title grew fastest?');
  });
});
