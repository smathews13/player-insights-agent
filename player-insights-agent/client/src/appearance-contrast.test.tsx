import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENTITY_STYLES,
  DEFAULT_RUNTIME_SETTINGS,
  THEME_FONT_COLORS,
  type RuntimeSettings,
} from '../../shared/runtime-settings';
import {
  APPEARANCE_SURFACES,
  WCAG_AA_NORMAL_TEXT_RATIO,
  appearanceContrastChecks,
  contrastRatio,
  relativeLuminance,
  restoreSafeAppearancePalette,
} from './appearance-contrast';
import { RuntimeSettingsPanel } from './RuntimeSettingsPanel';

const PANEL = readFileSync(new URL('./RuntimeSettingsPanel.tsx', import.meta.url), 'utf8');

describe('WCAG color contrast math', () => {
  it('uses the normal-text AA boundary at 4.5:1', () => {
    expect(WCAG_AA_NORMAL_TEXT_RATIO).toBe(4.5);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.5422, 4);
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_RATIO);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.4781, 4);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(WCAG_AA_NORMAL_TEXT_RATIO);
  });

  it('handles luminance endpoints, letter case, order, and malformed values', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBe(1);
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#FFFFFF', '#000000')).toBe(21);
    expect(contrastRatio('#fff', '#000000')).toBeNull();
    expect(contrastRatio('transparent', '#000000')).toBeNull();
  });
});

describe('Appearance contrast feedback', () => {
  it('renders a live AA result and a restore action before Save', () => {
    const markup = renderToStaticMarkup(<RuntimeSettingsPanel section="appearance" />);
    expect(markup).toContain('aria-label="Color contrast"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('>AA contrast passed</strong>');
    expect(markup).toContain('All 8 editable color pairs meet 4.5:1.');
    expect(markup).toContain('>Restore safe palette</button>');
  });

  it('checks body and secondary text against the active light or dark app surface', () => {
    const dark = appearanceContrastChecks(DEFAULT_RUNTIME_SETTINGS);
    expect(dark[0]).toMatchObject({
      id: 'body',
      foreground: THEME_FONT_COLORS.dark.body,
      background: APPEARANCE_SURFACES.dark,
      passes: true,
    });
    expect(dark[1]).toMatchObject({
      id: 'secondary',
      foreground: THEME_FONT_COLORS.dark.muted,
      background: APPEARANCE_SURFACES.dark,
      passes: true,
    });

    const light = appearanceContrastChecks({
      ...DEFAULT_RUNTIME_SETTINGS,
      colorScheme: 'light',
      ...{
        fontBodyColor: THEME_FONT_COLORS.light.body,
        fontMutedColor: THEME_FONT_COLORS.light.muted,
      },
    });
    expect(light[0].background).toBe(APPEARANCE_SURFACES.light);
    expect(light[1].background).toBe(APPEARANCE_SURFACES.light);
    expect(light.every((result) => result.passes)).toBe(true);
  });

  it('identifies each failing foreground/background pair and invalid hex value', () => {
    const checks = appearanceContrastChecks({
      ...DEFAULT_RUNTIME_SETTINGS,
      fontBodyColor: '#111111',
      fontMutedColor: 'invalid',
      entityStyles: {
        ...DEFAULT_ENTITY_STYLES,
        catalog: { foreground: '#ffffff', background: '#ffffff' },
      },
    });
    expect(checks.filter((result) => !result.passes).map((result) => result.label)).toEqual([
      'Body text / dark app surface',
      'Secondary text / dark app surface',
      'Catalog text / highlight',
    ]);
    expect(checks.find((result) => result.id === 'secondary')?.ratio).toBeNull();
  });

  it('restores all editable colors atomically for the current scheme', () => {
    const unsafe: RuntimeSettings = {
      ...DEFAULT_RUNTIME_SETTINGS,
      colorScheme: 'light',
      fontBodyColor: '#ffffff',
      fontMutedColor: '#ffffff',
      entityStyles: Object.fromEntries(
        Object.keys(DEFAULT_ENTITY_STYLES).map((kind) => [kind, { foreground: '#777777', background: '#777777' }])
      ) as RuntimeSettings['entityStyles'],
    };
    const restored = restoreSafeAppearancePalette(unsafe);
    expect(restored.fontBodyColor).toBe(THEME_FONT_COLORS.light.body);
    expect(restored.fontMutedColor).toBe(THEME_FONT_COLORS.light.muted);
    expect(restored.entityStyles).toEqual(DEFAULT_ENTITY_STYLES);
    expect(restored.entityStyles).not.toBe(DEFAULT_ENTITY_STYLES);
    expect(restored.loop).toBe(unsafe.loop);
    expect(appearanceContrastChecks(restored).every((result) => result.passes)).toBe(true);
  });

  it('warns without blocking Save and keeps native picker and hex validation', () => {
    const savePath = PANEL.slice(PANEL.indexOf('const save = async'), PANEL.indexOf('const setLoop'));
    expect(savePath).toContain("fetch('/api/admin/runtime-settings'");
    expect(savePath).not.toContain('contrastFailures');
    expect(PANEL).toContain('type="color"');
    expect(PANEL.match(/pattern="#\[0-9a-fA-F\]\{6\}"/g) ?? []).toHaveLength(2);
    expect(PANEL).toContain('restoreSafeAppearancePalette(current)');
  });
});
