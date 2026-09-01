import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENTITY_STYLES,
  DEFAULT_RUNTIME_SETTINGS,
  THEME_FONT_COLORS,
  type RuntimeSettings,
} from '../../shared/runtime-settings';
import { RuntimeSettingsPanel } from './RuntimeSettingsPanel';

const PANEL = readFileSync(new URL('./RuntimeSettingsPanel.tsx', import.meta.url), 'utf8');
const PAGE = readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8');
const SECTIONS = readFileSync(new URL('./settings-sections.ts', import.meta.url), 'utf8');
const SETTINGS_STYLES = readFileSync(new URL('./styles/settings.css', import.meta.url), 'utf8');
const RESPONSIVE_STYLES = readFileSync(new URL('./styles/responsive-settings.css', import.meta.url), 'utf8');

const BANNED_LABELS = [
  ['AA', 'contrast', 'passed'].join(' '),
  ['AA', 'contrast', 'warning'].join(' '),
  ['editable', 'color', 'pairs'].join(' '),
  ['Restore', 'safe', 'palette'].join(' '),
  ['Color', 'contrast'].join(' '),
  ['Enter', 'two', 'six-digit', 'hex', 'colors.'].join(' '),
  ['needs', '4.5:1'].join(' '),
] as const;

const CUSTOM_SAFE_SETTINGS: RuntimeSettings = {
  ...DEFAULT_RUNTIME_SETTINGS,
  colorScheme: 'light',
  fontBodyColor: THEME_FONT_COLORS.light.body,
  fontMutedColor: THEME_FONT_COLORS.light.muted,
  entityStyles: Object.fromEntries(
    Object.entries(DEFAULT_ENTITY_STYLES).map(([kind, colors]) => [kind, { ...colors }])
  ) as RuntimeSettings['entityStyles'],
};

const CUSTOM_LOW_CONTRAST_SETTINGS: RuntimeSettings = {
  ...DEFAULT_RUNTIME_SETTINGS,
  fontBodyColor: '#111111',
  fontMutedColor: '#111111',
  entityStyles: {
    ...DEFAULT_ENTITY_STYLES,
    catalog: { foreground: '#ffffff', background: '#ffffff' },
  },
};

function expectAuditAbsent(content: string): void {
  for (const label of BANNED_LABELS) expect(content).not.toContain(label);
}

describe('removed Appearance contrast audit', () => {
  it.each([
    ['default palette', DEFAULT_RUNTIME_SETTINGS],
    ['custom passing palette', CUSTOM_SAFE_SETTINGS],
    ['custom failing palette', CUSTOM_LOW_CONTRAST_SETTINGS],
  ])('renders no audit status, copy, action, or accessible name for the %s', (_name, initialSettings) => {
    const markup = renderToStaticMarkup(
      <RuntimeSettingsPanel section="appearance" initialSettings={initialSettings} />
    );

    expectAuditAbsent(markup);
    expect(markup).not.toContain(['appearance', 'contrast'].join('-'));
    expect(markup).not.toContain(['appearance', 'restore', 'palette'].join('-'));
  });

  it('leaves Entity colors as the clean final section in default and custom states', () => {
    for (const initialSettings of [DEFAULT_RUNTIME_SETTINGS, CUSTOM_SAFE_SETTINGS, CUSTOM_LOW_CONTRAST_SETTINGS]) {
      const markup = renderToStaticMarkup(
        <RuntimeSettingsPanel section="appearance" initialSettings={initialSettings} />
      );
      const paletteTail = markup.slice(markup.indexOf('appearance-palette-section'));

      expect(markup).toContain('runtime-section runtime-section-last appearance-palette-section');
      expect(paletteTail).not.toContain('<section');
    }
  });

  it('removes desktop/mobile CSS and Settings navigation, help, and source references', () => {
    const settingsSurface = [PANEL, PAGE, SECTIONS, SETTINGS_STYLES, RESPONSIVE_STYLES].join('\n');

    expectAuditAbsent(settingsSurface);
    expect(settingsSurface).not.toContain(['appearance', 'contrast'].join('-'));
    expect(settingsSurface).not.toContain(['appearance', 'restore', 'palette'].join('-'));
    expect(existsSync(new URL(`./appearance-${['con', 'trast'].join('')}.ts`, import.meta.url))).toBe(false);
  });
});
