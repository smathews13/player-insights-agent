export const PREFERENCE_DEFAULT_OWNER = 'rida.qureshi@take2games.com';

export function ownsPreferenceDefaults(email: string): boolean {
  return email.trim().toLowerCase() === PREFERENCE_DEFAULT_OWNER;
}
