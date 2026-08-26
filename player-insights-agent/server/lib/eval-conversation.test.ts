import { describe, expect, it } from 'vitest';
import {
  findLatestAnsweredConversation,
  loadConversationTurns,
  loadTurnsForQuestion,
} from './eval-conversation';

function store(rows: { conversation_id?: string; role?: string; content?: string }[]) {
  return {
    lakebase: {
      query: async (_sql: string, params?: unknown[]) => {
        const asked = typeof params?.[0] === 'string' ? params[0] : '';
        const matched = asked
          ? rows.filter(
              (row) =>
                row.conversation_id === asked ||
                (row.role === 'user' && row.content?.toLowerCase() === asked.toLowerCase())
            )
          : rows;
        return { rows: matched };
      },
    },
  };
}

describe('Ask thread loading', () => {
  it('returns every turn in a conversation', async () => {
    const turns = await loadConversationTurns(
      store([
        { conversation_id: 'c1', role: 'user', content: 'How many players?' },
        { conversation_id: 'c1', role: 'assistant', content: 'Twelve.' },
        { conversation_id: 'c1', role: 'user', content: 'And last month?' },
        { conversation_id: 'other', role: 'user', content: 'skip' },
      ]) as never,
      'c1'
    );
    expect(turns).toHaveLength(3);
    expect(turns[2]?.content).toBe('And last month?');
  });

  it('finds the latest answered thread and a thread by question', async () => {
    const client = store([
      { conversation_id: 'c-last', role: 'assistant', content: 'Eleven.' },
      { conversation_id: 'c-q', role: 'user', content: 'How many players?' },
    ]) as never;
    expect(await findLatestAnsweredConversation(client)).toBe('c-last');
    expect(await loadTurnsForQuestion(client, 'How many players?')).toEqual([
      { role: 'user', content: 'How many players?' },
    ]);
  });
});
