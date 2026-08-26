/**
 * A whole Ask thread, for multi-turn judges.
 *
 * One Q+A pair is a conversation of two lines. A real thread is every user
 * and assistant turn in order.
 */

export interface ConversationTurn {
  role: string;
  content: string;
}

export function formatConversationTurns(turns: readonly ConversationTurn[]): string {
  return turns
    .map((turn) => {
      const role = /assistant|agent/i.test(turn.role) ? 'Assistant' : 'User';
      const content = turn.content.replace(/\s+/g, ' ').trim();
      return content ? `${role}: ${content}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function conversationFromTurnsOrPair(
  turns: readonly ConversationTurn[] | undefined,
  question: string,
  response: string
): string {
  if (turns && turns.length > 0) {
    const transcript = formatConversationTurns(turns);
    if (transcript.trim()) return transcript;
  }
  const user = question.trim();
  const assistant = response.trim();
  if (!user && !assistant) return '';
  return [`User: ${user}`, `Assistant: ${assistant}`].filter((line) => !line.endsWith(': ')).join('\n');
}

export function countedThreadTurns(turns: readonly ConversationTurn[]): number {
  return turns.filter((turn) => turn.content.trim()).length;
}
