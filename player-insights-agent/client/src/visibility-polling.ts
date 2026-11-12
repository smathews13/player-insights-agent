/**
 * A repeating read that only runs while somebody is looking at the tab.
 *
 * WHY THIS IS A MODULE AND NOT SIX LINES INSIDE THE HOOK. This repository has no
 * jsdom and no React testing library, so a `setInterval` written inside
 * `useEffect` is code no test in this suite can observe: effects do not run
 * under `renderToStaticMarkup`, and there is no `document` to hide. The one
 * claim worth pinning here -- that a backgrounded tab stops asking -- would
 * therefore have been untestable, and it is exactly the kind of claim that fails
 * silently. Nothing breaks when a paused poll quietly keeps running; the tab
 * just spends somebody's battery and fills the app log with requests nobody
 * reads.
 *
 * So the timer, the visibility listener and the decision between them live here,
 * behind a {@link PollHost} the caller supplies. The app supplies one built from
 * `document`; a test supplies a fake and drives it.
 *
 * WHAT COUNTS AS HIDDEN is the browser's answer, not ours. `document.hidden` is
 * true when the tab is not the active one in its window, or the window is
 * minimised -- it is NOT true merely because another window is in front, which
 * is the case people expect it to cover and it does not. That is the right line
 * for this: a tab visible behind a code editor is still a tab somebody is
 * glancing at.
 */

/** Everything this needs from the outside world, so a test can be the outside world. */
export interface PollHost {
  /** Whether the page is hidden right now. */
  hidden: () => boolean;
  /** Subscribe to visibility changes. Returns the unsubscribe. */
  watch: (onChange: () => void) => () => void;
  /** Start a repeating call. Returns a handle for {@link PollHost.stop}. */
  start: (run: () => void, intervalMs: number) => number;
  stop: (handle: number) => void;
}

/**
 * The real one: `document` for visibility, the global timers for the interval.
 *
 * Tolerates there being no `document` at all rather than throwing, and reports
 * "not hidden" in that case, so a render outside a browser behaves the way this
 * did before visibility was consulted. Built by the caller inside an effect
 * rather than at module load, because module load happens in the test
 * environment too.
 */
export function browserPollHost(): PollHost {
  const visibility = typeof document === 'undefined' ? null : document;
  return {
    hidden: () => visibility?.hidden === true,
    watch: (onChange) => {
      if (!visibility) return () => undefined;
      visibility.addEventListener('visibilitychange', onChange);
      return () => visibility.removeEventListener('visibilitychange', onChange);
    },
    start: (run, intervalMs) => globalThis.setInterval(run, intervalMs) as unknown as number,
    stop: (handle) => globalThis.clearInterval(handle),
  };
}

/**
 * Run `read` now and every `intervalMs` after, but only while the tab is visible.
 *
 * Three behaviours, and each one is a decision rather than a detail:
 *
 *  - **Hidden at the start means nothing is read at all.** Not one request and
 *    no interval. A tab opened in the background has nobody to show an answer
 *    to, and the read it would have made is superseded by the one it makes the
 *    moment somebody actually looks.
 *  - **Becoming visible reads IMMEDIATELY**, then restarts the interval from
 *    that instant. Waiting up to a full interval to find out what happened while
 *    the tab was away is the worst of both worlds: it is the state a reader is
 *    most likely to be looking at stale numbers in.
 *  - **A second visibility event while already running changes nothing.** The
 *    handle guard is what makes that true. Without it a browser that fires
 *    `visibilitychange` twice -- and they do -- would leave two intervals
 *    running against one stop function, so the poll would silently double its
 *    rate and never come back down.
 *
 * Returns the teardown, which unsubscribes AND stops the interval. Both halves
 * matter: a listener left behind on an unmounted component would restart a
 * timer nothing is left to clear.
 */
export function pollWhileVisible(read: () => void, intervalMs: number, host: PollHost): () => void {
  let handle: number | null = null;

  const stop = () => {
    if (handle === null) return;
    host.stop(handle);
    handle = null;
  };

  const start = () => {
    if (handle !== null) return;
    read();
    handle = host.start(read, intervalMs);
  };

  const settle = () => {
    if (host.hidden()) stop();
    else start();
  };

  settle();
  const unwatch = host.watch(settle);
  return () => {
    unwatch();
    stop();
  };
}
