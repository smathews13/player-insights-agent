import crypto from 'node:crypto';
import type { StoredRole } from './user-roster';

export interface CanonicalUserIdentity {
  canonicalEmail: string | null;
  displayName: string;
  identityRevision: string;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function localPart(value: string): string {
  const at = value.indexOf('@');
  return at < 0 ? value : value.slice(0, at);
}

function validEmail(value: string): boolean {
  const [local, domain, ...rest] = value.split('@');
  return Boolean(local && domain?.includes('.') && rest.length === 0);
}

/**
 * Resolve the identity used for display and organization branding.
 *
 * A complete proxy-authenticated address is authoritative. A local-part-only
 * proxy value is completed only from one unique Identity-roster row. Token
 * claims are deliberately not an input: the existing auth contract treats
 * `x-forwarded-email` as the authenticated subject and JWT claims as an
 * unsigned correlation check, never as a directory.
 */
export function resolveCanonicalUserIdentity(
  authenticatedIdentity: string,
  roster: readonly StoredRole[]
): CanonicalUserIdentity {
  const forwarded = normalized(authenticatedIdentity);
  const revisionInput = roster
    .map((row) => `${normalized(row.email)}\u0000${row.role}\u0000${row.setAt}`)
    .sort()
    .join('\u0001');
  const identityRevision = crypto.createHash('sha256').update(revisionInput).digest('hex').slice(0, 24);

  if (validEmail(forwarded)) {
    return {
      canonicalEmail: forwarded,
      displayName: localPart(forwarded),
      identityRevision,
    };
  }

  const matches = roster
    .map((row) => normalized(row.email))
    .filter(validEmail)
    .filter((email) => localPart(email) === forwarded);
  const uniqueMatches = [...new Set(matches)];
  return {
    canonicalEmail: uniqueMatches.length === 1 ? uniqueMatches[0] : null,
    displayName: forwarded || 'Unknown',
    identityRevision,
  };
}
