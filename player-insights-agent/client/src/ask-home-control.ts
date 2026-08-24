/**
 * The header lockup's home action: Ask with no conversation selected.
 *
 * Leaving Ask unmounts HomePage. The session record is what puts the last
 * thread back in the URL on return, so a link to `/` alone would restore it.
 * This module is the other half of that link: forget the thread, and tell a
 * mounted Ask page to show the starter. From any other tab there is no
 * listener; clearing the record is enough, because the remount finds nothing
 * to restore.
 */
import { ASK_HOME_HREF } from './conversation-links';
import { clearSelectedConversation } from './selected-conversation';

export { ASK_HOME_HREF };

type AskHomeListener = () => void;

const listeners = new Set<AskHomeListener>();

/** Ask subscribes so a home click on an open thread can clear the selection. */
export function subscribeAskHome(listener: AskHomeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forget the open thread and tell Ask, if it is mounted, to show the starter. */
export function goToAskHome(): void {
  clearSelectedConversation();
  for (const listener of listeners) listener();
}
