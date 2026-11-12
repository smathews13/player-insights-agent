/** The one user whose Appearance settings are the deployment's defaults. */
export const PREFERENCE_DEFAULT_OWNER_ENV = 'PLAYER_INSIGHTS_PREFERENCE_DEFAULT_OWNER';

/**
 * Named by the deployment, or restored from its identity record on a Git deploy
 * that leaves it empty. Nobody owns the defaults when neither names anyone.
 */
export function preferenceDefaultOwner(): string {
  return (process.env[PREFERENCE_DEFAULT_OWNER_ENV] ?? '').trim().toLowerCase();
}

export function ownsPreferenceDefaults(email: string): boolean {
  const owner = preferenceDefaultOwner();
  return Boolean(owner) && email.trim().toLowerCase() === owner;
}
