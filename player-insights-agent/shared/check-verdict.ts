/**
 * What one dependency check actually established, in the words for it.
 *
 * WHAT THIS FIXES. Every Unity Catalog table row on the live deployment read
 * Status `Not checked` beside Detail `HTTP 403`, and those two contradict each
 * other on the same line: a check the workspace answered with a refusal was
 * plainly attempted, so "not checked" is false about it. The declared-tables
 * summary strip above the same rows said `12 declared · 12 not checked`, so the
 * contradiction was stated twice and a reader could not tell which half to
 * believe.
 *
 * The status on the wire is not the bug and is not being widened. `unverified`
 * is this codebase's word for "nobody established it either way", and it is
 * correct about all of these: a scope refusal stops before the object, a timeout
 * never gets an answer, and an unasked probe asked nothing. DECISIONS.md D6 and
 * D8 exist because folding any of those into `failed` would print "Blocked" over
 * an object nothing reached. So the three-value status stays, and the WORD a
 * reader sees is derived here, once, from the status plus the one fact the status
 * cannot carry: which of the three ways this check failed to establish anything.
 *
 *   refused         we asked, and the workspace said no
 *   unreachable     we asked, and the call broke before an answer
 *   not checked yet we never asked
 *
 * Those need three different next moves -- a permission, a retry, and a run --
 * which is why they are three words rather than one. This module is the only
 * place that decides them, so a row and the strip counting the rows cannot
 * disagree about one check.
 */

/**
 * Why a check established nothing, set by whatever produced the check.
 *
 * On `PreflightCheck.stopped`, and only meaningful while the status is
 * `unverified`: a check that answered or was refused outright has a verdict of
 * its own and does not need one of these.
 */
export type CheckStop = 'refused' | 'unreachable' | 'unasked';

/** What a reader is shown about one check. */
export type CheckVerdict = 'reachable' | 'blocked' | CheckStop;

export const CHECK_VERDICT_LABEL: Record<CheckVerdict, string> = {
  reachable: 'Reachable',
  blocked: 'Blocked',
  // Not "Refused" alone. The word on its own reads as a verdict about the
  // reader, and the whole reason a scope refusal is not `failed` is that
  // nothing was established about whether they can reach the object.
  refused: 'Refused',
  unreachable: 'Unreachable',
  // "Yet", which is the difference between this and the two above. Nobody has
  // asked, so a later run may still answer; a refusal will not change on a
  // re-run and saying "not checked" over one invited exactly that retry.
  unasked: 'Not checked yet',
};

/**
 * The colour rung a verdict earns, in the tones the page already draws.
 *
 * Only a refusal takes amber. It is the one of the three that says something
 * happened -- the workspace answered, in the negative -- without establishing
 * that the reader cannot reach the object, and amber is this page's rung for
 * "worth a look, not settled". An unreachable call and an unasked one assert
 * nothing at all, so they are untinted: a third tint would make the two that
 * mean something harder to tell apart.
 */
export function checkVerdictTone(verdict: CheckVerdict): 'reachable' | 'blocked' | 'drifted' | 'plain' {
  if (verdict === 'reachable') return 'reachable';
  if (verdict === 'blocked') return 'blocked';
  if (verdict === 'refused') return 'drifted';
  return 'plain';
}

/**
 * One check's verdict, from its status and how it stopped.
 *
 * THE FALLBACK NEVER GUESSES A REFUSAL, and that is the whole of its design.
 * `stopped` is set by `dependency-probes.ts`, which is what produces every check
 * the app runs itself; a report that arrives from the serving endpoint predates
 * the field and carries none. For those, a non-empty `error` means something
 * answered and it was not usable, which is `unreachable`, and an empty one means
 * nothing was asked. Reading a bare error string for the word "403" would be
 * inferring the one verdict that changes what a reader is told to do, off prose
 * nobody promised to keep stable.
 */
export function checkVerdict(check: {
  status: 'ok' | 'failed' | 'unverified';
  error?: string;
  stopped?: CheckStop;
}): CheckVerdict {
  if (check.status === 'ok') return 'reachable';
  if (check.status === 'failed') return 'blocked';
  if (check.stopped) return check.stopped;
  return check.error?.trim() ? 'unreachable' : 'unasked';
}

/**
 * How many checks reached each verdict, for a strip that summarises rows.
 *
 * Off the same function the rows are drawn with, which is the point: the strip
 * and the rows under it were counted from two readings of one status and said
 * different things about the same twelve tables.
 */
export function countCheckVerdicts(
  checks: readonly Parameters<typeof checkVerdict>[0][]
): Record<CheckVerdict, number> {
  const counts: Record<CheckVerdict, number> = {
    reachable: 0,
    blocked: 0,
    refused: 0,
    unreachable: 0,
    unasked: 0,
  };
  for (const check of checks) counts[checkVerdict(check)] += 1;
  return counts;
}

/**
 * A verdict tally as a line, zero counts dropped.
 *
 * The order is the page's: what answered, then what is wrong, then what is
 * unsettled. A zero never renders, on the tab's own rule -- a strip reading
 * `0 blocked · 0 refused` spends two phrases on states the deployment is not in.
 */
export function verdictSummary(counts: Record<CheckVerdict, number>): string {
  const order: CheckVerdict[] = ['reachable', 'blocked', 'refused', 'unreachable', 'unasked'];
  return order
    .filter((verdict) => counts[verdict] > 0)
    .map((verdict) => `${counts[verdict]} ${CHECK_VERDICT_LABEL[verdict].toLowerCase()}`)
    .join(' \u00b7 ');
}
