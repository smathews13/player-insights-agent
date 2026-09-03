export const FEEDBACK_CHANGED_EVENT = 'astrolabe:feedback-changed';
const STORAGE_KEY = 'astrolabe.feedback.revision';

export interface FeedbackEventTarget {
  dispatchEvent(event: Event): boolean;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  localStorage: Pick<Storage, 'setItem'>;
}

/** Invalidate feedback corpus reads only after the server accepted a new row. */
export function notifyFeedbackChanged(target: FeedbackEventTarget = window): void {
  target.dispatchEvent(new Event(FEEDBACK_CHANGED_EVENT));
  try {
    target.localStorage.setItem(STORAGE_KEY, `${Date.now()}`);
  } catch {
    // The same-page event still invalidates this session when storage is unavailable.
  }
}

export function listenForFeedbackChanges(listener: () => void, target: FeedbackEventTarget = window): () => void {
  const onFeedback = () => listener();
  const onStorage = (event: Event) => {
    if (event instanceof StorageEvent && event.key === STORAGE_KEY) listener();
  };
  target.addEventListener(FEEDBACK_CHANGED_EVENT, onFeedback);
  target.addEventListener('storage', onStorage);
  return () => {
    target.removeEventListener(FEEDBACK_CHANGED_EVENT, onFeedback);
    target.removeEventListener('storage', onStorage);
  };
}
