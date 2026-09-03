import type { SettingsSection } from './settings-sections';

export const ACCESS_GUIDE_SETTINGS_TARGET = 'access-guide';
export const ACCESS_GUIDE_SETTINGS_HREF = `/settings?section=environment#${ACCESS_GUIDE_SETTINGS_TARGET}`;

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'identity',
  'runtime',
  'environment',
  'appearance',
  'egress',
  'experimental',
];

function settingsSection(value: string | null): SettingsSection | null {
  return SETTINGS_SECTIONS.includes(value as SettingsSection) ? (value as SettingsSection) : null;
}

function decodedHash(hash: string): string {
  if (!hash.startsWith('#')) return '';
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return '';
  }
}

export interface SettingsDeepLink {
  section: SettingsSection;
  focusTarget: string | null;
  canonicalSearch: string;
}

/**
 * Select the pane from the URL and keep old guide links useful.
 *
 * `focus=access-guide` is accepted for links that cannot carry a fragment. The
 * canonical link uses the fragment so the destination remains visible and
 * copyable without exposing any asset location.
 */
export function settingsDeepLink(search: string, hash: string): SettingsDeepLink {
  const params = new URLSearchParams(search);
  const hashTarget = decodedHash(hash);
  const queryTarget = params.get('focus');
  const focusTarget =
    hashTarget === ACCESS_GUIDE_SETTINGS_TARGET || queryTarget === ACCESS_GUIDE_SETTINGS_TARGET
      ? ACCESS_GUIDE_SETTINGS_TARGET
      : hashTarget || queryTarget;

  if (focusTarget === ACCESS_GUIDE_SETTINGS_TARGET) {
    params.set('section', 'environment');
    const serialized = params.toString();
    return {
      section: 'environment',
      focusTarget,
      canonicalSearch: serialized ? `?${serialized}` : '',
    };
  }

  return {
    section: settingsSection(params.get('section')) ?? 'runtime',
    focusTarget: focusTarget || null,
    canonicalSearch: search,
  };
}
