import { describe, expect, it } from 'vitest';
import { conversationFromTurnsOrPair, countedThreadTurns, formatConversationTurns } from './eval-conversation';

describe('full Ask thread transcript', () => {
  it('joins every user and assistant turn, not one Q+A pair', () => {
    expect(
      formatConversationTurns([
        { role: 'user', content: 'How many players?' },
        { role: 'assistant', content: 'Twelve.' },
        { role: 'user', content: 'And last month?' },
        { role: 'assistant', content: 'Eleven.' },
      ])
    ).toBe('User: How many players?\nAssistant: Twelve.\nUser: And last month?\nAssistant: Eleven.');
    expect(
      countedThreadTurns([
        { role: 'user', content: 'How many players?' },
        { role: 'assistant', content: 'Twelve.' },
        { role: 'user', content: 'And last month?' },
        { role: 'assistant', content: 'Eleven.' },
      ])
    ).toBe(4);
  });

  it('falls back to the current pair when the thread is empty', () => {
    expect(conversationFromTurnsOrPair([], 'How many?', 'Twelve.')).toBe('User: How many?\nAssistant: Twelve.');
  });
});
