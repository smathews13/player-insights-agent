/**
 * One vocabulary for a merged row, out of the two the merged pages spoke.
 *
 * Sources said `Reachable` / `Blocked` / `Not checked` about a dependency it had
 * probed. Connections said `ok` / `blocked` / `pending` / `unknown` about the
 * page as a whole, and separately graded each drift finding
 * `blocking` / `warning` / `pending` / `unknown` / `note`. A merged row is one
 * line, so those had to reconcile.
 *
 * THEY DO NOT RECONCILE INTO ONE BADGE, and the merge does not try. Reachability
 * and configuration agreement are answers to different questions with different
 * remedies, and the case that settles it is common rather than contrived: a
 * warehouse the endpoint reached, running under an id that is not the one this
 * deployment was configured with. One badge has to pick. `Reachable` hides a
 * blocking mismatch behind a green word. `Blocked` says a dependency is
 * unreachable when it demonstrably is not, and sends a reader after a GRANT for
 * a problem that a redeploy fixes. Collapsing them would reintroduce, in a
 * denser shape, the exact defect both pages were built to expose: a surface that
 * reads as verified while something underneath it is wrong.
 *
 * So a row carries a STATUS BADGE, which answers "did anything reach this, and
 * did it work", and a quieter DRIFT MARKER, which answers "does what it is using
 * match what it was configured with". The badge is loud because it is the fact a
 * reader scans for; the marker is quiet because it is meaningless until the row
 * is opened and the two values are read side by side.
 */
import type { PreflightStatus } from './preflight';

/**
 * What a row's badge can say.
 *
 * The first three are Sources' three words unchanged, deliberately: the Unity
 * Catalog table matrix survives the merge as a block on the same page and its
 * rows are badged from the same check statuses, so a second wording would have
 * the one page describing one kind of fact in two vocabularies.
 *
 * `nothing-to-reach` is the fourth, and it is not a synonym for `not-checked`.
 * "Nobody looked" and "there is nothing to look at" are different claims, and
 * the settings pane already refused to render them the same way, for the same
 * reason it refuses to render an unmeasured value as agreement. Twelve of the
 * eighteen resources have no check; badging the five the app both resolves and
 * applies as `Not checked` would invite a search for a discrepancy that cannot
 * exist, because there is no second reading to disagree with the first.
 */
export type ConnectionStatus = 'reachable' | 'blocked' | 'not-checked' | 'nothing-to-reach';

export const CONNECTION_STATUS_LABEL: Record<ConnectionStatus, string> = {
  reachable: 'Reachable',
  blocked: 'Blocked',
  'not-checked': 'Not checked',
  'nothing-to-reach': 'Nothing to reach',
};

/**
 * Why the badge says what it says, for the expanded row.
 *
 * A four-word badge on a collapsed line cannot carry its own justification, and
 * `Not checked` beside a value that is plainly in use reads as a bug unless the
 * page says which of the two it means.
 */
export const CONNECTION_STATUS_NOTE: Record<ConnectionStatus, string> = {
  reachable: 'A check ran inside the serving endpoint against this dependency and it answered.',
  blocked: 'A check ran inside the serving endpoint against this dependency and it failed.',
  'not-checked':
    'No check reports on this one, so whether it is reachable and whether it agrees with what was ' +
    'configured are both unknown rather than confirmed.',
  'nothing-to-reach':
    'The app both resolves and uses this value, so there is no remote end to probe and no second ' +
    'reading to compare the first with.',
};

export function connectionStatusVariant(status: ConnectionStatus) {
  if (status === 'reachable') return 'secondary' as const;
  if (status === 'blocked') return 'destructive' as const;
  return 'outline' as const;
}

/**
 * The badge for one resource row.
 *
 * `check` is the preflight check named by the resource's `actualFromCheck`, when
 * the report carried one. `appApplied` is the settings pane's existing test for
 * a value with no second reader: no orchestrator key and no check, so the app
 * resolves it and the app applies it.
 *
 * An `unverified` check outranks `appApplied`, because a check that ran and
 * could not decide is a fact about this deployment, and saying "nothing to
 * reach" over the top of it would discard it.
 */
export function connectionStatus(input: {
  check?: { status: PreflightStatus } | null;
  appApplied: boolean;
}): ConnectionStatus {
  const { check, appApplied } = input;
  if (check) {
    if (check.status === 'ok') return 'reachable';
    if (check.status === 'failed') return 'blocked';
    return 'not-checked';
  }
  return appApplied ? 'nothing-to-reach' : 'not-checked';
}

/**
 * The quieter half: whether this row's configuration disagrees with itself.
 *
 * `none` renders nothing at all. A marker on every row would cost the density
 * the merge exists to buy, and "no drift" is the state eighteen rows are
 * normally in.
 */
export type DriftMarker = 'none' | 'pending' | 'drift';

export const DRIFT_MARKER_LABEL: Record<Exclude<DriftMarker, 'none'>, string> = {
  drift: 'Drift',
  pending: 'Pending',
};

/**
 * Which marker one row carries.
 *
 * `pending-*` findings are excluded from the drift count on purpose, and were
 * before the merge: the finding says what the row's own Intended banner says,
 * and two statements of one fact read as two problems. A recorded intention is
 * reported instead as `pending`, which is a weaker claim than `drift` and is
 * ordered below it, because a value somebody saved and has not applied is a
 * decision waiting on a release rather than a deployment misbehaving.
 *
 * Every non-pending finding `app-settings.ts` raises for a resource is
 * `blocking`, so the marker does not grade them; the count is what varies and
 * the count is what it reports.
 */
export function driftMarker(input: {
  findingIds: readonly string[];
  intended: string | null;
}): DriftMarker {
  const problems = input.findingIds.filter((id) => !id.startsWith('pending-'));
  if (problems.length > 0) return 'drift';
  return input.intended ? 'pending' : 'none';
}

/** How many findings the marker is standing for, so a row can say "2". */
export function driftCount(findingIds: readonly string[]): number {
  return findingIds.filter((id) => !id.startsWith('pending-')).length;
}

/**
 * The value a collapsed row shows to the right of its badge.
 *
 * The point of the collapsed line is that a reader can scan eighteen of them
 * and see what this deployment is actually pointed at, so the value in use wins
 * over the configured one wherever something measured it. Where nothing did,
 * the configured value is shown and SAID to be the configured one, because a
 * bare string in the in-use column is a claim that it is in use.
 */
export function inUseSummary(input: {
  actual: string;
  actualObserved: boolean;
  configured: string;
}): { value: string; measured: boolean } {
  if (input.actualObserved && input.actual) return { value: input.actual, measured: true };
  return { value: input.configured, measured: false };
}

/**
 * The counts for the one status line that replaced two summary cards.
 *
 * Reachability counts come from the preflight report and configuration counts
 * from the settings payload, and they are reported side by side rather than
 * added together, for the same reason a row carries two marks.
 */
export function connectionCounts(input: {
  statuses: readonly ConnectionStatus[];
  markers: readonly DriftMarker[];
}) {
  const tally = (wanted: ConnectionStatus) => input.statuses.filter((status) => status === wanted).length;
  return {
    reachable: tally('reachable'),
    blocked: tally('blocked'),
    notChecked: tally('not-checked'),
    nothingToReach: tally('nothing-to-reach'),
    drifted: input.markers.filter((marker) => marker === 'drift').length,
    pending: input.markers.filter((marker) => marker === 'pending').length,
  };
}
