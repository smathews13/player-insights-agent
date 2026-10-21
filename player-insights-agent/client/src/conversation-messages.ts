import type { ConversationMessage } from './app-types';

export const DEFAULT_MESSAGE_PAGE_SIZE = 50;

export interface ConversationMessagePage {
  messages: ConversationMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

export async function readConversationMessagePage(
  conversationId: string,
  options: { cursor?: string | null; signal?: AbortSignal; fetcher?: typeof fetch; limit?: number } = {}
): Promise<ConversationMessagePage> {
  const query = new URLSearchParams({ limit: String(options.limit ?? DEFAULT_MESSAGE_PAGE_SIZE) });
  if (options.cursor) query.set('cursor', options.cursor);
  const response = await (options.fetcher ?? fetch)(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?${query}`,
    { signal: options.signal }
  );
  if (!response.ok) throw new Error('Conversation unavailable');
  const payload = (await response.json()) as ConversationMessagePage | ConversationMessage[];
  // A rolling deploy can briefly pair the new client with the previous server.
  // Its unbounded array is already ascending and represents the complete thread.
  if (Array.isArray(payload)) return { messages: payload, nextCursor: null, hasMore: false };
  return {
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    nextCursor: typeof payload.nextCursor === 'string' ? payload.nextCursor : null,
    hasMore: payload.hasMore === true,
  };
}

/** Reads every bounded page in stable ascending order for whole-thread export. */
export async function readCompleteConversationMessages(
  conversationId: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch; limit?: number } = {}
): Promise<ConversationMessage[]> {
  let cursor: string | null = null;
  let hasMore = true;
  let messages: ConversationMessage[] = [];
  const seenCursors = new Set<string>();
  while (hasMore) {
    const page = await readConversationMessagePage(conversationId, { ...options, cursor });
    messages = prependConversationMessages(messages, page.messages);
    hasMore = page.hasMore;
    cursor = page.nextCursor;
    if (!hasMore) break;
    if (!cursor || seenCursors.has(cursor)) throw new Error('Conversation pagination did not advance.');
    seenCursors.add(cursor);
  }
  return messages;
}

function messageOrder(message: ConversationMessage): string {
  return `${typeof message.created_at === 'string' ? message.created_at : '\uffff'}\u0000${message.id}`;
}

/** Prepend an older page without disturbing messages that arrived meanwhile. */
export function prependConversationMessages(
  current: readonly ConversationMessage[],
  older: readonly ConversationMessage[]
): ConversationMessage[] {
  const seen = new Set<string>();
  return [...older, ...current].filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

/**
 * Reconcile a fresh newest page after a background run settles.
 *
 * Rows older than the page boundary stay mounted; everything at or after it is
 * replaced by the authoritative page. Local optimistic rows have no timestamp
 * and are discarded once the store returns a page containing their turn.
 */
export function mergeNewestConversationMessages(
  current: readonly ConversationMessage[],
  newest: readonly ConversationMessage[]
): ConversationMessage[] {
  if (newest.length === 0) return [...current];
  const boundary = messageOrder(newest[0]);
  const older = current.filter((message) => typeof message.created_at === 'string' && messageOrder(message) < boundary);
  const merged = prependConversationMessages(newest, older);
  // A question the store did not return is still the question that was asked. Its row is
  // written separately from the answer and can be lost on its own, and discarding the local
  // copy here is how a report's request vanished from above the report. Kept only when no
  // stored question says the same words, and seated just before the answer it led to.
  const stored = new Set(newest.filter((message) => message.role === 'user').map((message) => message.content));
  const orphans = current.filter(
    (message) =>
      typeof message.created_at !== 'string' &&
      message.role === 'user' &&
      message.content.trim() !== '' &&
      !stored.has(message.content)
  );
  if (orphans.length === 0) return merged;
  const lastAnswer = merged.map((message) => message.role).lastIndexOf('assistant');
  const at = lastAnswer === -1 ? merged.length : lastAnswer;
  return [...merged.slice(0, at), ...orphans, ...merged.slice(at)];
}

export interface PrependAnchor {
  id: string;
  top: number;
  restoreFocus: boolean;
}

/** Capture the first already-visible row before inserting content above it. */
export function capturePrependAnchor(
  firstMessage: ConversationMessage | undefined,
  root: Pick<Document, 'getElementById' | 'activeElement'> = document
): PrependAnchor | null {
  if (!firstMessage) return null;
  const row = root.getElementById(`conversation-message-${firstMessage.id}`);
  if (!row) return null;
  return {
    id: firstMessage.id,
    top: row.getBoundingClientRect().top,
    restoreFocus: (root.activeElement as HTMLElement | null)?.dataset.messagePagination === 'older',
  };
}

/** Keep the old first row under the same pixel and return focus to the thread. */
export function restorePrependAnchor(
  anchor: PrependAnchor | null,
  root: Pick<Document, 'getElementById'> = document,
  scroll: Pick<Window, 'scrollBy'> = window
) {
  if (!anchor) return;
  const row = root.getElementById(`conversation-message-${anchor.id}`);
  if (!row) return;
  const delta = row.getBoundingClientRect().top - anchor.top;
  if (delta) scroll.scrollBy({ top: delta, behavior: 'instant' });
  if (anchor.restoreFocus) row.focus({ preventScroll: true });
}
