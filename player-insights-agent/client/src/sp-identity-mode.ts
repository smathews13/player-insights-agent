/**
 * The deployment-wide SP-identity pivot, as Settings must read it.
 *
 * Same flag the server uses (`sp-identity-enabled` / `isSpIdentityEnabled`).
 * The Experimental switch and the Identity pane both follow this. A leftover
 * per-browser preference must not decide either one: that is how the switch
 * could read Off while assigned people already ran as service principals.
 *
 * Absent, unreadable, or anything other than exact boolean `true` is off, so
 * OAuth stays the default until that server flag is on.
 */

/** Leftover localStorage key from when this was a per-browser experiment. */
export const LEGACY_SP_IDENTITIES_BROWSER_KEY = 'pia.experimental.sp-identities';

export function spIdentityEnabledFromPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  return (payload as { enabled?: unknown }).enabled === true;
}
