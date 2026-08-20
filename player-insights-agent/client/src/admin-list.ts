/**
 * What the administrator settings row says, decided away from the markup.
 *
 * ONE FACT PER PERSON: the address, where the row came from, and whether it may be
 * removed. This file used to carry a second fact, the Unity Catalog access behind
 * the role, with a state word and a copyable GRANT for each of two objects. It is
 * gone: the grant on `system.billing` needs a metastore admin, so the usual sight
 * on this card was PERMISSION_DENIED beside a colleague's name for read access the
 * role never required. Roles are people and roles.
 *
 * Kept out of the component so the states can be asserted without rendering, and
 * so the words are in one place rather than spread through JSX.
 */
import type { AdminListEntry } from '../../shared/admin-contract';

export type { AdminListEntry };

/**
 * Where a row came from, in three words.
 *
 * A seed row's origin is the reason it has no Remove button, so the chip and the
 * absent button are one fact rather than two coincidences.
 */
export function originLabel(entry: AdminListEntry): string {
  if (entry.origin === 'seed') return 'Set at deployment';
  return entry.addedBy ? `Added by ${entry.addedBy}` : 'Added here';
}

/** The date under an added row, or empty. Never a guess at a seed row's date. */
export function addedOn(entry: AdminListEntry): string {
  if (entry.origin === 'seed' || !entry.addedAt) return '';
  const when = new Date(entry.addedAt);
  return Number.isNaN(when.getTime()) ? '' : when.toLocaleDateString();
}

/**
 * The line above the list: what this deployment's administration currently is.
 *
 * The empty and the unreadable cases are different sentences on purpose. Both put
 * few rows on screen and they have different remedies, and conflating them is what
 * sends somebody looking for a person who was never removed.
 */
export function listSummary(input: {
  entries: readonly AdminListEntry[];
  addedAdminsReadable: boolean;
  seedAdminCount: number;
}): string {
  if (!input.addedAdminsReadable) {
    return (
      'The stored half of this list could not be read, so only administrators set at deployment are ' +
      'shown. There may be more. Nobody has lost the role.'
    );
  }
  if (input.entries.length === 0) {
    return (
      'This deployment has no administrators. Monitoring, Ops and this page refuse everybody, and ' +
      'nobody can be added from here. Set the administrators in the deployment configuration.'
    );
  }
  const added = input.entries.length - input.seedAdminCount;
  const parts = [`${input.seedAdminCount} set at deployment`];
  if (added > 0) parts.push(`${added} added here`);
  return `${input.entries.length} administrator${input.entries.length === 1 ? '' : 's'}: ${parts.join(', ')}.`;
}

/** Whether the Add button does anything yet. Kept here so the test does not render. */
export function canSubmit(draft: string, busy: boolean): boolean {
  return !busy && draft.trim().length > 0;
}
