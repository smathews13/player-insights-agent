/**
 * The dependency checks, kept for as long as the app is loaded.
 *
 * WHAT WAS WRONG. Architecture holds its settings payload and its preflight
 * report in `useState`. React unmounts the page on navigation, so a reader who
 * ran the checks, looked at Connections and came back found every dependency on
 * `Not checked`, the tile strip back to em-dashes, the index-age pill gone, and
 * the freshness line back to "Not read yet" -- with no way to tell that from a
 * deployment nobody had ever checked. The work was not slow to redo; it was
 * invisible that it needed redoing.
 *
 * WHAT WAS WRONG A SECOND TIME, AND WHY THIS STORE NOW HAS A LATCH IN IT. Both
 * reads used to be behind the Refresh button on the reasoning that they are
 * expensive and nobody should pay for them unopened. The cost argument was
 * right and the conclusion was wrong. A tab that opens on `Not checked` down its
 * whole length does not read as "nobody has looked yet" to the person who opened
 * it; it reads as broken, and it read that way to the person this was built for,
 * twice, on two different tabs. A page whose honest empty state is
 * indistinguishable from a fault has not been made honest by the wording.
 *
 * So the checks run themselves ONCE, on the first page that wants them, and the
 * store is what makes that once rather than once-per-tab-per-visit. See
 * {@link claimAutoCheck}. Refresh keeps its meaning exactly: after the automatic
 * run, it is the only thing that re-reads anything.
 *
 * WHY A MODULE-LEVEL STORE RATHER THAN THE OTHER THREE OPTIONS.
 *
 * Not React state lifted into a provider. The checks are not layout and nothing
 * above the page needs them, so a context would re-render the whole tree on a
 * refresh to serve one page, and it would put a cache in the file that decides
 * navigation.
 *
 * Not sessionStorage or localStorage. Both would outlive the running copy of the
 * app, and results that outlive the build they were taken against can describe a
 * deployment that no longer exists -- after a redeploy, most of all, which is
 * exactly when somebody opens this page. Everything on screen here should have
 * been produced by the app instance that is drawing it. A reload is cheap and
 * honest; a restored verdict from before a deploy is neither.
 *
 * Not a refetch on mount. That is the distinction the latch draws: the checks
 * run once for the session, not once per mount. A refetch on mount would pay the
 * expensive pair of reads on every navigation between the two tabs that use
 * them, and it would do it silently.
 *
 * So: one object, in this module, for the lifetime of the loaded app. Route
 * changes do not touch it, a reload clears it, and no other tab can see it.
 *
 * THE TIMESTAMP IS NOT STORED HERE, and that is the point of the design. Both
 * cached payloads already carry the SERVER's own record of when the checks ran
 * -- `SettingsPayload.checkedAt` and `PreflightReport.checked_at` -- so the page
 * derives freshness from the restored data rather than from a clock it read.
 * A separately-remembered client timestamp is the shape that would let a
 * restored view claim it was checked at the moment the tab was reopened, which
 * is the specific lie this must not tell. There is no field here to backdate.
 */
import type { SettingsPayload } from './connection-model';
import type { PreflightReport } from './preflight';

/**
 * One run of the checks, exactly as the two routes answered it.
 *
 * `error` is carried with the rest because a partial run is a real outcome: one
 * route answers and the other does not, and restoring the half that worked
 * without the sentence explaining the half that did not would present a
 * deliberately incomplete page as a complete one.
 */
export interface CheckSession {
  settings: SettingsPayload | null;
  report: PreflightReport | null;
  error: string;
  load?: {
    firstLoad: boolean;
    settings: 'pending' | 'ready' | 'error';
    report: 'pending' | 'ready' | 'error';
  };
}

let remembered: CheckSession | null = null;

/**
 * Whether this session's one automatic run has been taken.
 *
 * WHY A LATCH AND NOT `remembered === null`. Those look interchangeable and are
 * not, in the case that matters: an automatic run that FAILS leaves nothing
 * worth remembering, so a page keyed on the store being empty would run it
 * again on the next visit, and again on the one after. Two tabs of the same page
 * would each get a go. The reader would be paying for the expensive pair of
 * reads on every navigation, which is the thing this store exists to stop.
 *
 * So the claim is separate from the result, and it is taken BEFORE the fetches
 * rather than after them. Claiming afterwards would let two mounts in one tick
 * -- which is what React does in development, and what two pages mounting
 * together does in production -- both find it unclaimed and both fire.
 */
let autoClaimed = false;

/**
 * Take this session's one automatic run. True for exactly one caller, ever.
 *
 * Synchronous and side-effecting on purpose: the caller that gets `true` owns
 * the run, and every later caller gets `false` whether the first one succeeded,
 * failed, or is still in flight. After that only a human pressing Refresh
 * re-reads anything.
 */
export function claimAutoCheck(): boolean {
  if (autoClaimed) return false;
  autoClaimed = true;
  return true;
}

/** Whether the automatic run has been claimed. For tests and for reporting. */
export function autoCheckClaimed(): boolean {
  return autoClaimed;
}

/** Keep this run. Called once per completed refresh, whatever the outcome. */
export function rememberChecks(session: CheckSession): void {
  remembered = session;
}

/**
 * The last run, or null where nothing has been run since the app loaded.
 *
 * Null is the honest answer and pages must render it as "Not checked" rather
 * than as an empty success. Since the checks run themselves this is a brief state
 * rather than a resting one, but it is still reachable -- while the first run is
 * in flight, and on a deployment where that run failed -- and it must not be
 * dressed as a passing verdict in either case.
 */
export function recallChecks(): CheckSession | null {
  return remembered;
}

/**
 * Drop it, and release the automatic run. For tests, and for nothing else.
 *
 * Both halves, because a test that emptied the store and left the latch claimed
 * would be testing the second visit while believing it was testing the first --
 * and the once-per-session rule is exactly the thing that would then go
 * unexercised.
 */
export function forgetChecks(): void {
  remembered = null;
  autoClaimed = false;
}

/**
 * When a remembered run actually happened, from the payloads themselves.
 *
 * The settings payload first and the report second, which is the order
 * ConnectionsPage reads them in, so the two pages cannot print different times
 * for one run. Empty where neither answered, which `readAgo` renders as "Not
 * read yet".
 */
export function checkedAtOf(session: CheckSession | null): string {
  if (!session) return '';
  return session.settings?.checkedAt || session.report?.checked_at || '';
}
