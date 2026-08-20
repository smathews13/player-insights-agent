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
 * The line above the roster: what this deployment's administration currently is.
 *
 * The unreadable, the locked-out and the ordinary cases are different sentences on
 * purpose. The first two put few rows on screen and have different remedies, and
 * conflating them is what sends somebody looking for a person who was never removed.
 */
export function rosterSummary(payload: RosterPayload): string {
  if (!payload.storedRosterReadable) {
    return (
      'The stored half of this roster could not be read, so only roles set at deployment are shown. ' +
      'There may be more. Nobody has lost a role.'
    );
  }
  if (payload.entries.length === 0) {
    return 'This deployment has no administrators, and none can be added from here.';
  }
  const admins = payload.entries.filter((entry) => entry.role !== 'consumer').length;
  const roleCounts: string[] = [];
  if (admins > 0) roleCounts.push(`${admins} administrator${admins === 1 ? '' : 's'}`);
  if (payload.superAdminCount > 0) roleCounts.push(`${payload.superAdminCount} super`);
  const roster = `${payload.entries.length} ${payload.entries.length === 1 ? 'person' : 'people'} on the roster.`;
  return roleCounts.length > 0 ? `${roleCounts.join(', ')}. ${roster}` : roster;
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

/** Whether the Add button does anything yet. Kept here so the test does not render. */
export function canSubmit(draft: string, busy: boolean): boolean {
  return !busy && draft.trim().length > 0;
}
