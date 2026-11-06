/** The one user whose Appearance settings are the deployment's defaults. */
export const PREFERENCE_DEFAULT_OWNER_ENV = 'PLAYER_INSIGHTS_PREFERENCE_DEFAULT_OWNER';

/** The owner before deployments stated one; recorded once so later artifacts need not name anybody. */
const LEGACY_PREFERENCE_DEFAULT_OWNER = 'rida.qureshi@take2games.com';

/** Name the legacy owner when neither the artifact nor the record does. */
export function applyLegacyPreferenceDefaultOwner(env: Record<string, string | undefined> = process.env): void {
  if (!(env[PREFERENCE_DEFAULT_OWNER_ENV] ?? '').trim())
    env[PREFERENCE_DEFAULT_OWNER_ENV] = LEGACY_PREFERENCE_DEFAULT_OWNER;
}

export function preferenceDefaultOwner(): string {
  return ((process.env[PREFERENCE_DEFAULT_OWNER_ENV] ?? '').trim() || LEGACY_PREFERENCE_DEFAULT_OWNER).toLowerCase();
}

export function ownsPreferenceDefaults(email: string): boolean {
  const owner = preferenceDefaultOwner();
  return Boolean(owner) && email.trim().toLowerCase() === owner;
}
