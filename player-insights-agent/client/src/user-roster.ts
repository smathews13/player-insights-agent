/**
 * What the roster row says, decided away from the markup.
 *
 * The panel draws facts that can disagree -- the role somebody holds, the role
 * deployment configuration guarantees them, and whether the store can record a
 * change at all -- and every function here exists to stop that disagreement being
 * smoothed over. Unity Catalog is not among those facts: a role is a row, and this
 * panel stopped granting and reporting on grants.
 *
 * NO SENTENCE HERE EXPLAINS THE HIERARCHY. A reader who has opened this panel is
 * the person who administers the deployment; they do not need to be told what an
 * admin is. Each line carries live information about this deployment or it is not
 * here, which is the same test every other surface in this app was cut down to.
 *
 * Kept out of the component so the states can be asserted without rendering, and so
 * the words are in one place rather than spread through JSX.
 */
import { ROLE_WORD, type Role, type RosterEntry, type RosterPayload } from '../../shared/user-roster-contract';

export type { Role, RosterEntry, RosterPayload };

/** Browser-side normalization mirrors the server's identity key without changing
 * the value while somebody is still typing it. */
export function normalizeRosterEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Deliberately permissive, like the server: reject obvious mistakes without
 * pretending a browser regex can prove that a work mailbox exists. */
export function rosterEmailError(raw: string): string {
  const candidate = normalizeRosterEmail(raw);
  if (!candidate) return 'Enter a work email address.';
  if (candidate.length > 320) return 'That email address is too long.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) return 'Enter a valid work email address.';
  return '';
}

/** The word for a role, on a row and in a menu. */
export function roleWord(role: Role): string {
  return ROLE_WORD[role];
}

/**
 * Where a row's role came from, in three words, or empty when the row says it.
 *
 * A seeded row's origin is the reason it has no menu and no Remove button, so the
 * chip and the absent controls are one fact rather than two coincidences. A stored
 * row names who set it, which is the question asked of a role somebody did not
 * expect to find.
 */
export function originLabel(entry: RosterEntry): string {
  if (entry.seedFloor !== 'consumer') return 'Set at deployment';
  return entry.setBy ? `Set by ${entry.setBy}` : '';
}

/** The date under a row, or empty. Never a guess at a seeded row's date. */
export function setOn(entry: RosterEntry): string {
  if (!entry.setAt) return '';
  const when = new Date(entry.setAt);
  return Number.isNaN(when.getTime()) ? '' : when.toLocaleDateString();
}

/**
 * Why a row has no controls, or empty when it has them.
 *
 * ON THE ROW RATHER THAN AS A DISABLED MENU. A disabled control a reader can never
 * enable is a permanent invitation to file a support request, and this app has
 * already decided that once for the navigation. The line says what to change
 * instead.
 */
export function rowLocked(entry: RosterEntry, payload: RosterPayload): string {
  if (entry.assignable.length > 0 || entry.canRemove) return '';
  if (entry.seedFloor !== 'consumer') return 'Change this in the deployment configuration.';
  if (!payload.roleColumnPresent) return 'This roster cannot record other roles yet.';
  if (entry.role === 'super_admin' && payload.superAdminCount === 1) return 'The only super admin.';
  return '';
}

/**
 * Whether the reader is about to give up their own last privileged rank.
 *
 * The panel says so before the change rather than after it, because a super admin
 * who demotes themselves loses this panel in the same render and there is nowhere
 * left to explain it. The server refuses the case that would leave the deployment
 * with none; this covers the case it allows.
 */
export function stepsDownFrom(entry: RosterEntry, next: Role): string {
  if (!entry.isYou) return '';
  if (next === 'super_admin' || entry.role !== 'super_admin') return '';
  return next === 'consumer'
    ? 'You will lose Monitoring, Ops and these settings.'
    : 'You will no longer be able to change roles.';
}

/** Why Add is unavailable, also exposed as its accessible description. */
export function addDisabledReason(draft: string, role: Role, busy: boolean): string {
  if (busy) return 'Another identity change is still being saved.';
  const emailError = rosterEmailError(draft);
  if (emailError) return emailError;
  if (role !== 'admin' && role !== 'consumer') return 'Choose Consumer or Admin.';
  return '';
}

/** Whether Add can submit one complete, valid request. */
export function canSubmit(draft: string, busy: boolean, role: Role = 'admin'): boolean {
  return addDisabledReason(draft, role, busy) === '';
}

/** Claim a mutation before React has time to paint its disabled controls. */
export function claimRosterMutation(latch: { current: boolean }): boolean {
  if (latch.current) return false;
  latch.current = true;
  return true;
}

/** A late response may clear only the exact draft that started its request. */
export function submittedDraftIsCurrent(submittedVersion: number, currentVersion: number): boolean {
  return submittedVersion === currentVersion;
}
