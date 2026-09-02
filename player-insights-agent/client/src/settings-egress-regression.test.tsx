import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SettingsPage } from './SettingsPage';
import { NO_EXPERIMENTS, withExperimentalFeature } from './experimental-features';
import { changedSettingKeys, navigateSettingsSection } from './settings-save-state';
import { availableSettingsSections, normalizeSettingsSection, type SettingsSection } from './settings-sections';

const PAGE = readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8');
const ADMIN = { state: 'admin', addedAdminsReadable: true } as const;

function sectionIds(features: typeof NO_EXPERIMENTS): SettingsSection[] {
  return availableSettingsSections(features).map((section) => section.id);
}

function settings(features: typeof NO_EXPERIMENTS, initialSection: SettingsSection): string {
  return renderToStaticMarkup(
    <SettingsPage
      features={features}
      initialSection={initialSection}
      role={ADMIN}
      setFeature={() => {}}
    />
  );
}

describe('Experimental Egress controls availability', () => {
  it('keeps the staged destination hidden and guarded until Save commits it', () => {
    const persisted = { ...NO_EXPERIMENTS };
    const draft = withExperimentalFeature(persisted, 'egressControls', true);
    let active: SettingsSection = 'experimental';

    expect(changedSettingKeys(persisted, draft)).toEqual(['egressControls']);
    expect(sectionIds(persisted)).not.toContain('egress');
    expect(
      navigateSettingsSection<SettingsSection>(active, 'runtime', 1, {
        select: (section) => {
          active = section;
        },
        clearPaneDirty: () => {},
        resetSaveState: () => {},
      })
    ).toBe(false);
    expect(active).toBe('experimental');

    const saved = { ...draft };
    expect(sectionIds(saved)).toContain('egress');
    expect(
      navigateSettingsSection<SettingsSection>(active, 'egress', 0, {
        select: (section) => {
          active = section;
        },
        clearPaneDirty: () => {},
        resetSaveState: () => {},
      })
    ).toBe(true);
    expect(active).toBe('egress');
    expect(settings(saved, active)).toContain('id="settings-egress-form"');
  });

  it('renders a persisted enabled Egress item as a normal clickable destination', () => {
    const enabled = { ...NO_EXPERIMENTS, egressControls: true };
    const markup = settings(enabled, 'runtime');
    const button = markup.match(/<button[^>]*>Egress controls<\/button>/)?.[0];

    expect(button).toBeDefined();
    expect(button).not.toContain('disabled');
    expect(settings(enabled, 'egress')).toContain('<h3>Egress controls</h3>');
  });

  it('hides disabled Egress and normalizes an attempted deep-link selection', () => {
    expect(sectionIds(NO_EXPERIMENTS)).not.toContain('egress');
    expect(normalizeSettingsSection('egress', NO_EXPERIMENTS)).toBe('runtime');

    const markup = settings(NO_EXPERIMENTS, 'egress');
    expect(markup).not.toContain('>Egress controls</button>');
    expect(markup).toContain('<h3>Runtime</h3>');
    expect(markup).not.toContain('id="settings-egress-form"');
  });

  it('wires availability to the saved snapshot rather than the visible draft', () => {
    expect(PAGE).toContain('availableSettingsSections(savedFeatures)');
    expect(PAGE).not.toContain('availableSettingsSections(draftFeatures)');
    expect(PAGE).toContain('setSavedFeatures({ ...document.settings })');
    expect(PAGE).toContain("active === 'egress' ? <EgressPanel");
  });
});
