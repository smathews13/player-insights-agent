/**
 * The Ask conversation this browser session last had open.
 *
 * React Router unmounts `HomePage` when another top-level tab opens. Component
 * state therefore cannot remember the selected thread, and the other tabs have
 * their own query strings, so `?c=` cannot travel through every route either.
 * This small session record bridges those mounts. The URL still wins whenever
 * it names a conversation, preserving deep links and Back/Forward.
 *
 * `sessionStorage` is deliberate: it survives route changes and a reload, but
 * not a new browser session. A module fallback covers blocked storage and keeps
 * the required same-tab navigation behavior working for the lifetime of this
 * JavaScript application.
 */

export const SELECTED_CONVERSATION_KEY = 'astrolabe.ask.selected-conversation';

let selectedInMemory: string | null = null;

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function validConversationId(value: string | null | undefined): string | null {
  const id = value?.trim() ?? '';
  return id ? id : null;
}

/** Remember a real selected thread. */
export function rememberSelectedConversation(conversationId: string): void {
  const id = validConversationId(conversationId);
  if (!id) return;
  selectedInMemory = id;
  try {
    storage()?.setItem(SELECTED_CONVERSATION_KEY, id);
  } catch {
    // The in-memory record still preserves navigation in this mounted app.
  }
}

/** The selected thread from this browser session, when one exists. */
export function readSelectedConversation(): string | null {
  try {
    const stored = validConversationId(storage()?.getItem(SELECTED_CONVERSATION_KEY));
    if (stored) {
      selectedInMemory = stored;
      return stored;
    }
  } catch {
    // Fall through to the in-memory record.
  }
  return selectedInMemory;
}

/**
 * Forget the selected thread.
 *
 * Called by “+ New conversation”, by deleting the selected conversation (which
 * invokes that same action), and by the header lockup's home control — the
 * routes back to the starter pane.
 */
export function clearSelectedConversation(): void {
  selectedInMemory = null;
  try {
    storage()?.removeItem(SELECTED_CONVERSATION_KEY);
  } catch {
    // The in-memory record is already clear.
  }
}

/** Test isolation for the module fallback when no browser storage exists. */
export function resetSelectedConversationForTests(): void {
  selectedInMemory = null;
}
