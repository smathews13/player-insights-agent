export const PREFERENCE_DEFAULT_OWNER = 'owner@example.com';

export function ownsPreferenceDefaults(email: string): boolean {
  return email.trim().toLowerCase() === PREFERENCE_DEFAULT_OWNER;
}
