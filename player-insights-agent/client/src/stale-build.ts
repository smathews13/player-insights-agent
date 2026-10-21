/**
 * Recovering a tab that was opened before the app was redeployed.
 *
 * Charts, export and most pages load their code on demand, from files whose names
 * change with every build. A tab opened before a redeploy still asks for the old
 * names, the server no longer has them, and the panel fails for good until somebody
 * reloads by hand. The answer behind it is fine; only the page's code is out of date.
 *
 * Two layers: a failed on-demand load reloads the page once on its own, and where a
 * failure still reaches a panel it says what happened and offers the reload, rather
 * than printing the browser's module error.
 */

const RELOAD_FLAG = 'pia.stale-build-reload-at';

/** A real outage must not turn into a reload loop: one automatic reload per window. */
export const STALE_BUILD_RELOAD_WINDOW_MS = 5 * 60_000;

export const STALE_BUILD_MESSAGE = 'The app was updated since this page opened. Reload to get the latest version.';

const STALE_BUILD_ERROR =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|unable to preload css/i;

/** Whether an error is a code file that no longer exists on the server. */
export function isStaleBuildError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return STALE_BUILD_ERROR.test(message);
}

interface FlagStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Reloads the page, once per window. Returns whether it did.
 *
 * Storage that cannot be read or written (a locked-down browser) counts as "already
 * tried": a reload that cannot be remembered could repeat forever.
 */
export function reloadOnceForStaleBuild({
  store,
  reload,
  now = Date.now,
}: {
  store: FlagStore | null;
  reload: () => void;
  now?: () => number;
}): boolean {
  if (!store) return false;
  try {
    const last = Number(store.getItem(RELOAD_FLAG));
    if (Number.isFinite(last) && last > 0 && now() - last < STALE_BUILD_RELOAD_WINDOW_MS) return false;
    store.setItem(RELOAD_FLAG, String(now()));
  } catch {
    return false;
  }
  reload();
  return true;
}

/** Listens for Vite's failed-preload event, once, at app start. */
export function installStaleBuildRecovery(target: Window = window): void {
  target.addEventListener('vite:preloadError', (event) => {
    let store: Storage | null = null;
    try {
      store = target.sessionStorage;
    } catch {
      store = null;
    }
    const reloaded = reloadOnceForStaleBuild({ store, reload: () => target.location.reload() });
    // Handled: the failed import is not rethrown into the panel that asked for it.
    if (reloaded) event.preventDefault();
  });
}
