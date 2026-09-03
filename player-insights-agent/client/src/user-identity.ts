import type { Identity } from './app-types';

export function identityName(identity: string | null | undefined): string {
  const value = identity?.trim() ?? '';
  if (!value) return 'Unknown';
  const at = value.indexOf('@');
  return at > 0 ? value.slice(0, at) : value;
}

/** Complete identity for tooltips, copy actions, panels, and organization lookup. */
export function canonicalIdentityEmail(identity: Identity): string {
  return identity.canonicalEmail || identity.signedInAs;
}

/** Compact identity for the visible global account trigger. */
export function identityDisplayName(identity: Identity): string {
  return identity.displayName?.trim() || identityName(canonicalIdentityEmail(identity));
}

/**
 * A name in the possessive, for copy that addresses a person by their username.
 *
 * `<your-username>'` and not `<your-username>'s`: a name already ending in s takes the
 * apostrophe alone. `first.person's` keeps the s, because it does not.
 */
export function possessiveName(name: string): string {
  const value = name.trim();
  if (!value) return value;
  return /s$/i.test(value) ? `${value}'` : `${value}'s`;
}
