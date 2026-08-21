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
// Refused, unreachable and never-asked are three different things wearing one
// status, and telling them apart happens in exactly one module so a row, the
// section it sits in and the count line above it cannot disagree.
import { checkVerdict, type CheckStop } from '../../shared/check-verdict';

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
 * reason it refuses to render an unmeasured value as agreement. A token cap and
 * two lists of catalog patterns name no object anywhere; badging them
 * `Not checked` promises a verdict that no check could ever deliver, and invites
 * a search for a discrepancy that cannot exist.
 *
 * `refused` IS THE FIFTH, AND IT WAS THE HEADLINE CONTRADICTING THE ROWS. Every
 * Unity Catalog row was refused with an HTTP 403 and the count line above them
 * read "9 not checked", because a refusal is `unverified` on the wire -- rightly,
 * since a scope refusal stops before the object and establishes nothing about it
 * -- and this type read `unverified` as "nobody looked". Somebody looked. The
 * workspace answered. Fixing that in the row and leaving the line above it saying
 * the opposite is half a fix, and the line is the part a reader reads first.
 *
 * `unreachable` IS THE SIXTH, and it was folded into `not checked` for one round
 * on the argument that a timeout and an unrun probe both establish nothing. That
 * argument does not survive its own test: a refusal establishes nothing about the
 * object either, and it is still its own word. "Establishes nothing" is not the
 * distinction a reader needs. THE NEXT MOVE IS. Refused means get a permission,
 * unreachable means something is down and is worth a retry or an escalation, not
 * checked means run the checks. Three actions, so three words -- and the rows had
 * been saying `Unreachable` all along, so the line above them was disagreeing with
 * them in exactly the way it had for refused.
 *
 * The six partition the rows. Every row takes one and only one -- `checkVerdict`
 * returns one verdict per check and each verdict maps to one status here -- so the
 * counts below sum to the number of rows drawn, in every state.
 */
export type ConnectionStatus =
  | 'reachable'
  | 'blocked'
  | 'refused'
  | 'unreachable'
  | 'not-checked'
  | 'nothing-to-reach';

export const CONNECTION_STATUS_LABEL: Record<ConnectionStatus, string> = {
  reachable: 'Reachable',
  blocked: 'Blocked',
  refused: 'Refused',
  unreachable: 'Unreachable',
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
  // Deliberately no longer "a check ran inside the serving endpoint". Two
  // different things can answer for a row now -- the orchestrator, when a model
  // version still reports its dependencies, and the app, asking the workspace
  // under the signed-in user's own token -- and a note that names one of them is
  // wrong about the other. Which one answered, and what it established, is in
  // the check's own detail; see `connectionNote` below, which prefers it.
  reachable: 'Something reached this dependency and it answered.',
  blocked: 'Something tried to reach this dependency and could not.',
  // Both halves matter. The refusal is a fact -- the workspace answered, in the
  // negative -- and what it is NOT is a verdict about the object: a call stopped
  // at the permission layer never reached the thing it was asking about, which is
  // why this is not `blocked`.
  refused:
    'The workspace refused this call, so nothing was established about the object itself. A refusal ' +
    'is answered by a permission rather than by trying again.',
  // Not `blocked`, which is a check that ran to a verdict. This one never got an
  // answer -- it timed out, or the call broke -- so the dependency may be fine and
  // the thing in front of it may not be. Worth a retry, and worth escalating if it
  // persists, which is neither of the other two next moves on this line.
  unreachable:
    'This call did not complete, so nothing was established either way. Something in the path is ' +
    'down or timing out; it is worth trying again, and worth raising if it keeps happening.',
  'not-checked':
    'No check reports on this one, so whether it is reachable and whether it agrees with what was ' +
    'configured are both unknown rather than confirmed.',
  'nothing-to-reach':
    'This value names no remote object, so there is nothing to probe and no second reading to ' +
    'compare the first with.',
};

/**
 * The sentence a row shows under its badge.
 *
 * A check's own detail wherever there is one, because the detail carries what
 * the badge cannot: which identity was refused, the code and message the
 * workspace answered with, and -- on a pass -- the clause naming what the pass
 * does NOT prove. A four-word badge plus a generic note would let "Reachable"
 * stand unqualified over a metadata read, which is the overclaim this page
 * spends its whole length avoiding.
 */
export function connectionNote(input: {
  check?: { status: PreflightStatus; detail?: string } | null;
  status: ConnectionStatus;
}): string {
  const detail = input.check?.detail?.trim();
  return detail || CONNECTION_STATUS_NOTE[input.status];
}

export function connectionStatusVariant(status: ConnectionStatus) {
  if (status === 'reachable') return 'secondary' as const;
  if (status === 'blocked') return 'destructive' as const;
  return 'outline' as const;
}

/**
 * The badge for one resource row.
 *
 * `check` is the preflight check named by the resource's `actualFromCheck`, when
 * the report carried one. `hasRemoteEnd` is whether there is anything out there
 * to ask about at all: the registry says whether the value names a remote
 * object, and the row says whether this deployment set one.
 *
 * It replaced a test on the orchestrator key, which asked the wrong question.
 * `agentKey` records who OWNS a value, so a token cap and two lists of catalog
 * patterns -- owned by the orchestrator, naming nothing -- came out as
 * `Not checked`, which promises a verdict no check could ever deliver.
 *
 * An `unverified` check outranks `hasRemoteEnd`, because a check that ran and
 * could not decide is a fact about this deployment, and saying "nothing to
 * reach" over the top of it would discard it.
 *
 * WHY THE WHOLE CHECK AND NOT ITS STATUS. `unverified` covers three different
 * things -- refused, unreachable, never asked -- and this used to read all three
 * as "nobody looked", which put "9 not checked" in the headline over nine rows the
 * workspace had refused. `checkVerdict` is the one place that tells them apart, so
 * the resource verdict is derived through it rather than through a second reading
 * of the same status.
 */
export function connectionStatus(input: {
  check?: { status: PreflightStatus; error?: string; stopped?: CheckStop } | null;
  hasRemoteEnd: boolean;
}): ConnectionStatus {
  const { check, hasRemoteEnd } = input;
  if (check) {
    if (check.status === 'ok') return 'reachable';
    if (check.status === 'failed') return 'blocked';
    // One verdict in, one status out, and no default that could swallow a case:
    // `checkVerdict` returns exactly one of these three for an `unverified` check,
    // so nothing is double-counted and nothing falls through unbucketed.
    const verdict = checkVerdict(check);
    if (verdict === 'refused') return 'refused';
    if (verdict === 'unreachable') return 'unreachable';
    return 'not-checked';
  }
  return hasRemoteEnd ? 'not-checked' : 'nothing-to-reach';
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
 * The severities that mean something IS wrong, as opposed to unestablished.
 *
 * `app-settings.ts` raises four: `blocking` and `warning` assert that this
 * deployment is not using what it was configured with, and `unknown` and `note`
 * assert the opposite -- that nothing could be established, so no claim is being
 * made either way. Drift is a statement about a DISAGREEMENT, so only the first
 * two may produce one.
 *
 * This was found on the live deployment rather than reasoned about. The finding
 * `orchestrator-report-retired` is raised against `agent-endpoint` at severity
 * `unknown`, and its own headline reads "Everything is running. The settings
 * below are unconfirmed, not wrong" -- and the row it lands on was wearing a
 * "Drift" badge while its configured and in-use values were the same string. A
 * page that spends its whole length refusing to read absence of evidence as
 * agreement must not read it as disagreement either; the note belongs in the
 * row's own alert, which is where it already was, and not on the collapsed line
 * as a fault.
 */
const ASSERTS_DISAGREEMENT: ReadonlySet<string> = new Set(['blocking', 'warning']);

/**
 * The findings that earn a drift marker, out of the ones a resource carries.
 *
 * `pending-*` is excluded by id and was before the merge: the finding says what
 * the row's own Intended banner says, and two statements of one fact read as two
 * problems.
 *
 * `severities` is optional, and its absence is the LEGACY reading: count every
 * non-pending finding, which is what this did when the comment above said all of
 * them were `blocking`. Kept so a caller holding only ids -- the coupling test
 * that recomputes this marker to prove the diagram has not grown its own
 * interpretation -- keeps getting the answer it got before. A caller that knows
 * the severities passes them and gets the narrower, correct reading. An id the
 * map does not mention counts, because a finding of unstated severity is more
 * safely reported than silently dropped.
 */
function disagreeing(findingIds: readonly string[],
  severities?: Readonly<Record<string, string>>
): string[] {
  return findingIds.filter((id) => {
    if (id.startsWith('pending-')) return false;
    if (!severities) return true;
    return ASSERTS_DISAGREEMENT.has(severities[id] ?? 'blocking');
  });
}

/**
 * Which marker one row carries.
 *
 * A recorded intention is reported as `pending`, which is a weaker claim than
 * `drift` and is ordered below it, because a value somebody saved and has not
 * applied is a decision waiting on a release rather than a deployment
 * misbehaving.
 */
export function driftMarker(input: {
  findingIds: readonly string[];
  intended: string | null;
  /** Severity by finding id. See `disagreeing` for why this is optional. */
  severities?: Readonly<Record<string, string>>;
}): DriftMarker {
  if (disagreeing(input.findingIds, input.severities).length > 0) return 'drift';
  return input.intended ? 'pending' : 'none';
}

/** How many findings the marker is standing for, so a row can say "2". */
export function driftCount(findingIds: readonly string[],
  severities?: Readonly<Record<string, string>>
): number {
  return disagreeing(findingIds, severities).length;
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
    // Counted separately from `notChecked`, which is the whole point: these were
    // in that figure, and it read "9 not checked" over nine rows the workspace had
    // refused. `unreachable` was in it for the same reason and came out for the
    // same one -- the rows say `Unreachable`, and the line has to agree.
    refused: tally('refused'),
    unreachable: tally('unreachable'),
    notChecked: tally('not-checked'),
    nothingToReach: tally('nothing-to-reach'),
    drifted: input.markers.filter((marker) => marker === 'drift').length,
    pending: input.markers.filter((marker) => marker === 'pending').length,
  };
}

export type ConnectionCounts = ReturnType<typeof connectionCounts>;

/**
 * One count on the summary line: the figure, the word for it, and whether it is
 * tinted.
 *
 * THE FIGURE AND THE WORD ARE SEPARATE FIELDS, which is not tidiness. The line
 * has always meant to be tabular -- these counts change under the reader when a
 * refresh lands, and proportional figures make the whole line reflow as they do
 * -- but it asked for that with `font-variant-numeric` on DM Sans, which carries
 * no `tnum` feature and so did nothing at all. The fix is DM Mono on the digits,
 * and it has to be ONLY the digits: marking the whole phrase would set
 * "reachable" in mono too, and mono words in a 13px line read as a code span.
 */
export interface CountEntry {
  key: string;
  /** The figure, which renders in DM Mono. */
  count: number;
  /** What the figure counts, which stays in DM Sans. */
  word: string;
  tone?: 'reachable' | 'blocked' | 'drifted';
}

/**
 * The counts that describe something, in the order the design states them.
 *
 * A ZERO NEVER RENDERS. The line used to print all six whatever they were, so a
 * deployment with nothing wrong announced "0 blocked · 0 not checked · 0
 * drifted · 0 pending" under a headline that had just said everything answered.
 * Four of the six words on the line were then about states the deployment was
 * not in, and a reader has to read all four to find that out. `nothing to
 * reach` was already suppressed this way, for exactly the reason that applies to
 * the other five: there is nothing for "0 nothing to reach" to mean.
 *
 * Suppression is not the same as summing. Each state keeps its own word and its
 * own count wherever it has one, so a refusal is never added to a failure
 * (DECISIONS.md D6) and rows nobody checked are never folded into rows that
 * answered (D8).
 */
export function visibleCounts(counts: ConnectionCounts): CountEntry[] {
  return [
    { key: 'reachable', word: 'reachable', tone: 'reachable' as const, count: counts.reachable },
    { key: 'blocked', word: 'blocked', tone: 'blocked' as const, count: counts.blocked },
    { key: 'drifted', word: 'drifted', tone: 'drifted' as const, count: counts.drifted },
    // Above `not checked`, and tinted, because it is the actionable one of the
    // two: a refusal is answered by a permission and rows nobody asked about are
    // answered by a run. Amber rather than red, on the page's own rung for "worth
    // a look, not settled" -- nothing was established about the objects, so this
    // must not read as a dependency being down.
    { key: 'refused', word: 'refused', tone: 'drifted' as const, count: counts.refused },
    // Amber too, where `checkVerdictTone` leaves a single unreachable CHECK
    // untinted. Different job: there the tint separates one refusal out of a
    // twelve-row matrix, here the word is a whole dependency nothing could reach,
    // and the headline beside it no longer earns its tick in that state. An
    // untinted word under an unticked headline is the disagreement this file exists
    // to prevent.
    { key: 'unreachable', word: 'unreachable', tone: 'drifted' as const, count: counts.unreachable },
    { key: 'notChecked', word: 'not checked', count: counts.notChecked },
    // "Configuration only" rather than "nothing to reach", because the rows it
    // counts are now drawn under a Configuration heading of their own and a line
    // that named them differently from the section they are in would read as two
    // populations. The claim is the same one: the app resolves and applies these,
    // so there is no remote end and no second reading.
    { key: 'nothingToReach', word: 'configuration only', count: counts.nothingToReach },
    { key: 'pending', word: 'pending', count: counts.pending },
  ]
    .filter((entry) => entry.count > 0)
    .map(({ key, count, word, tone }) => (tone ? { key, count, word, tone } : { key, count, word }));
}

/**
 * A long value cut from the FRONT, keeping the end.
 *
 * Three-part table names and Genie space ids differ in their tails and agree in
 * their heads, so the ordinary trailing ellipsis truncates away the only part
 * that identifies the row: five rows reading `a_catalog.a_schema.gold_pl…` are
 * five rows a reader cannot tell apart. The whole value goes in a `title` and in
 * the expanded row, so nothing is lost by cutting here.
 */
export function truncateHead(value: string, max = 34): string {
  return value.length <= max ? value : `\u2026${value.slice(value.length - max + 1)}`;
}
