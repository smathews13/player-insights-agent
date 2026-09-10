import type { ConversationMessage } from './app-types';

/**
 * The reader question an assistant row answers.
 *
 * Plan execution adds a synthetic user turn between the plan and its eventual
 * answer. That turn records approval, but it is not the analytical question and
 * must never become the title of a run or an answer export.
 */
export function answeredQuestion(
  messages: readonly ConversationMessage[],
  assistantIndex: number,
  approvalLabel: string
): string {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate.role !== 'user' || candidate.content === approvalLabel) continue;
    return candidate.content;
  }
  return '';
}
