/** Characters shown for a conversation identifier in compact UI. */
const CONVERSATION_ID_PREFIX = 6;

/**
 * A stable, recognisable conversation-id prefix for display only.
 *
 * Callers must keep the original identifier for links, API requests, titles,
 * accessibility labels, and copy actions.
 */
export function abbreviatedConversationId(id: string): string {
  return id.length > CONVERSATION_ID_PREFIX ? id.slice(0, CONVERSATION_ID_PREFIX) : id;
}
