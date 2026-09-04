import { BadgeCheck, FlaskConical, Gauge, Network, Palette, ServerCog, type LucideIcon } from 'lucide-react';
import { showsEgressControls, type ExperimentalFeatures } from './experimental-features';

export type SettingsSection = 'identity' | 'runtime' | 'environment' | 'appearance' | 'egress' | 'experimental';

/** Every Settings destination owns one distinct, decorative navigation mark. */
export const SETTINGS_SECTION_ICONS = {
  identity: BadgeCheck,
  runtime: Gauge,
  environment: ServerCog,
  appearance: Palette,
  egress: Network,
  experimental: FlaskConical,
} satisfies Record<SettingsSection, LucideIcon>;

export const BASE_SETTINGS_SECTIONS: readonly { id: SettingsSection; label: string }[] = [
  { id: 'identity', label: 'Identity' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'environment', label: 'Environment' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'egress', label: 'Egress controls' },
  { id: 'experimental', label: 'Experimental' },
];

/** Only persisted feature preferences may make a Settings destination available. */
export function settingsSectionAvailable(section: SettingsSection, features: ExperimentalFeatures): boolean {
  return section !== 'egress' || showsEgressControls(features);
}

export function availableSettingsSections(
  features: ExperimentalFeatures
): readonly { id: SettingsSection; label: string }[] {
  return BASE_SETTINGS_SECTIONS.filter((section) => settingsSectionAvailable(section.id, features));
}

/** A hidden experimental section is never reachable through an initial/deep-link selection. */
export function normalizeSettingsSection(requested: SettingsSection, features: ExperimentalFeatures): SettingsSection {
  return settingsSectionAvailable(requested, features) ? requested : 'runtime';
}
