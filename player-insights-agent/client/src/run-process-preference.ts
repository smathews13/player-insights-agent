/**
 * A finished answer's process disclosure, remembered only for this browser tab.
 *
 * The message id makes the choice local to one answer. Session storage keeps an
 * explicit expansion through route changes and a reload, but a new tab/session
 * starts from the surface's default again.
 */
const RUN_PROCESS_KEY_PREFIX = 'astrolabe:run-process:';

function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readRunProcessPreference(key: string | undefined, storage = sessionStore()): boolean | null {
  if (!key || !storage) return null;
  try {
    const stored = storage.getItem(`${RUN_PROCESS_KEY_PREFIX}${key}`);
    return stored === 'open' ? true : stored === 'closed' ? false : null;
  } catch {
    return null;
  }
}

export function writeRunProcessPreference(key: string | undefined, open: boolean, storage = sessionStore()): void {
  if (!key || !storage) return;
  try {
    storage.setItem(`${RUN_PROCESS_KEY_PREFIX}${key}`, open ? 'open' : 'closed');
  } catch {
    // Storage may be unavailable or full. The mounted card still holds the choice.
  }
}
