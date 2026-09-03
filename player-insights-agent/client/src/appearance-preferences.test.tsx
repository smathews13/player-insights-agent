import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RUNTIME_SETTINGS, FONT_FAMILY_STACKS, type RuntimeSettings } from '../../shared/runtime-settings';
import { RuntimeSettingsPanel } from './RuntimeSettingsPanel';
import {
  RUNTIME_APPEARANCE_CACHE_KEY,
  adoptRuntimeEntityStyles,
  cacheRuntimeAppearance,
  previewRuntimeAppearance,
  runtimeAppearanceFromCache,
  writeRuntimeAppearanceAttributes,
} from './runtime-entity-styles';
import { forgetLiveRuntimeSettings, recalledLiveRuntimeSettings } from './runtime-settings-live';

const PANEL = readFileSync(new URL('./RuntimeSettingsPanel.tsx', import.meta.url), 'utf8');
const ROOT_RUNTIME = readFileSync(new URL('./runtime-entity-styles.ts', import.meta.url), 'utf8');
const SETTINGS_STYLES = readFileSync(new URL('./styles/settings.css', import.meta.url), 'utf8');
const ROOT_STYLES = readFileSync(new URL('./styles/appearance-preferences.css', import.meta.url), 'utf8');
const DENSITY_STYLES = [
  ROOT_STYLES,
  ...['runs', 'monitoring', 'ops', 'connections', 'architecture', 'settings', 'benchmark'].map((route) =>
    readFileSync(new URL(`./styles/density-${route}.css`, import.meta.url), 'utf8')
  ),
].join('\n');
const RESPONSIVE = readFileSync(new URL('./styles/responsive-settings.css', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function appearanceDocument() {
  const attributes = new Map<string, string>();
  const variables = new Map<string, string>();
  const root = {
    classList: { add: vi.fn() },
    style: { setProperty: (name: string, value: string) => variables.set(name, value) },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };
  const themeColor = { setAttribute: vi.fn() };
  vi.stubGlobal('document', {
    documentElement: root,
    querySelector: (selector: string) => (selector === 'meta[name="theme-color"]' ? themeColor : null),
  });
  return { attributes, variables, root, themeColor };
}

afterEach(() => {
  forgetLiveRuntimeSettings();
  vi.unstubAllGlobals();
});

describe('Appearance preferences', () => {
  it('ends Display after Density and consolidates every text control with its preview', () => {
    const markup = renderToStaticMarkup(<RuntimeSettingsPanel section="appearance" />);
    const display = markup.slice(markup.indexOf('appearance-display-section'), markup.indexOf('appearance-text-panel'));
    const text = markup.slice(markup.indexOf('appearance-text-panel'), markup.indexOf('appearance-palette-section'));

    expect(display).toContain('>Display</h4>');
    expect(display).toContain('>Dark mode</span>');
    expect(display).toContain('>Background graphics</span>');
    expect(display).toContain('>Animations</span>');
    expect(display).toContain('>Density</span>');
    expect(display).not.toContain('>Body text</span>');
    expect(display).not.toContain('>Secondary</span>');
    expect(display).not.toContain('type="color"');
    expect(display.match(/>On</g)).toHaveLength(3);
    expect(display).toContain('role="radiogroup"');
    expect(display).toContain('role="radio"');
    expect(display).toContain('>Comfortable</button>');
    expect(display).toContain('>Compact</button>');
    expect(display).not.toContain('>Font</span>');
    expect(display).not.toContain('>Size</span>');

    const labels = ['Dark mode', 'Background graphics', 'Animations', 'Density'];
    for (let index = 1; index < labels.length; index += 1) {
      expect(display.indexOf(labels[index - 1])).toBeLessThan(display.indexOf(labels[index]));
    }

    expect(text).toContain('role="group" aria-label="Text"');
    expect(text).toContain('aria-label="Font: DM Sans"');
    expect(text).toContain('aria-label="Font size M"');
    expect(text).toContain('>Body text</span>');
    expect(text).toContain('>Secondary</span>');
    expect(text).toContain('type="color"');
    expect(text).toContain('>Preview</p>');
    for (const [previous, next] of [
      ['Font', 'Size'],
      ['Size', 'Body text'],
      ['Body text', 'Secondary'],
      ['Secondary', 'Preview'],
    ]) {
      expect(text.indexOf(previous)).toBeLessThan(text.indexOf(next));
    }
    expect(markup).not.toContain('>Typography</h4>');
    expect(markup).not.toContain(['appearance', 'typography', 'section'].join('-'));
    expect(markup).not.toContain('>Interface</h4>');
    expect(markup).not.toContain('appearance-interface-section');
  });

  it('uses roving keyboard radio semantics for density and font size', () => {
    expect(PANEL).toContain("event.key === 'ArrowRight' || event.key === 'ArrowDown'");
    expect(PANEL).toContain("event.key === 'ArrowLeft' || event.key === 'ArrowUp'");
    expect(PANEL).toContain('tabIndex={settings.density === density ? 0 : -1}');
    expect(PANEL).toContain('tabIndex={settings.fontSize === size ? 0 : -1}');
  });

  it('writes safe root attributes and caches only normalized settings', () => {
    const setAttribute = vi.fn();
    writeRuntimeAppearanceAttributes(
      { ...DEFAULT_RUNTIME_SETTINGS, backgroundGraphics: false, animations: false, density: 'compact' },
      { setAttribute }
    );
    expect(setAttribute.mock.calls).toEqual([
      ['data-background-graphics', 'off'],
      ['data-animations', 'off'],
      ['data-density', 'compact'],
    ]);

    const setItem = vi.fn();
    cacheRuntimeAppearance(DEFAULT_RUNTIME_SETTINGS, { setItem });
    expect(setItem).toHaveBeenCalledWith(RUNTIME_APPEARANCE_CACHE_KEY, JSON.stringify(DEFAULT_RUNTIME_SETTINGS));
    expect(runtimeAppearanceFromCache(JSON.stringify(DEFAULT_RUNTIME_SETTINGS))).toEqual(DEFAULT_RUNTIME_SETTINGS);
    expect(runtimeAppearanceFromCache('{"density":"dense"}')).toBeNull();

    const invalidLegacyDensity = JSON.stringify({ ...DEFAULT_RUNTIME_SETTINGS, density: 'dense' });
    expect(runtimeAppearanceFromCache(invalidLegacyDensity)).toEqual({
      ...DEFAULT_RUNTIME_SETTINGS,
      density: 'comfortable',
    });
  });

  it('toggles the one root density contract in both directions independently of theme', () => {
    const setAttribute = vi.fn();
    const compact = { ...DEFAULT_RUNTIME_SETTINGS, colorScheme: 'light' as const, density: 'compact' as const };

    writeRuntimeAppearanceAttributes(compact, { setAttribute });
    writeRuntimeAppearanceAttributes(DEFAULT_RUNTIME_SETTINGS, { setAttribute });

    expect(setAttribute.mock.calls.filter(([name]) => name === 'data-density')).toEqual([
      ['data-density', 'compact'],
      ['data-density', 'comfortable'],
    ]);
    expect(compact.colorScheme).toBe('light');
    expect(compact.density).toBe('compact');
  });

  it('renders consolidated controls and preview from a complete custom draft', () => {
    const draft: RuntimeSettings = {
      ...DEFAULT_RUNTIME_SETTINGS,
      colorScheme: 'light',
      fontBodyColor: '#123456',
      fontMutedColor: '#667788',
      fontFamily: 'dm-mono',
      fontSize: 'l',
      backgroundGraphics: false,
      animations: false,
      density: 'compact',
    };
    const markup = renderToStaticMarkup(<RuntimeSettingsPanel section="appearance" initialSettings={draft} />);
    const text = markup.slice(markup.indexOf('appearance-text-panel'), markup.indexOf('appearance-palette-section'));

    expect(markup).toContain('aria-label="Dark mode"');
    expect(markup).toContain('aria-label="Background graphics"');
    expect(markup).toContain('aria-label="Animations"');
    expect(markup).toContain('>Compact</button>');
    expect(text).toContain('aria-label="Font: DM Mono"');
    expect(text).toContain('aria-label="Font size L"');
    expect(text).toContain('aria-checked="true" tabindex="0" aria-label="Font size L"');
    expect(text).toContain('aria-label="Body text color"');
    expect(text).toContain('value="#123456"');
    expect(text).toContain('aria-label="Secondary text color"');
    expect(text).toContain('value="#667788"');
    expect(text).toContain('--appearance-preview-body:#123456');
    expect(text).toContain('--appearance-preview-muted:#667788');
    expect(text).toContain(`--appearance-preview-font:${FONT_FAMILY_STACKS['dm-mono'].replaceAll("'", '&#x27;')}`);
    expect(text).toContain('--appearance-preview-size:16px');
  });

  it('previews all root state, restores saved settings on cancel, and adopts the saved draft', () => {
    const { attributes, variables, root, themeColor } = appearanceDocument();
    const setItem = vi.fn();
    vi.stubGlobal('window', { localStorage: { setItem } });
    const draft: RuntimeSettings = {
      ...DEFAULT_RUNTIME_SETTINGS,
      colorScheme: 'light',
      fontBodyColor: '#123456',
      fontMutedColor: '#667788',
      fontFamily: 'dm-mono',
      fontSize: 'l',
      backgroundGraphics: false,
      animations: false,
      density: 'compact',
    };

    previewRuntimeAppearance(draft, root.style);
    expect(Object.fromEntries(attributes)).toMatchObject({
      'data-theme': 'light',
      'data-background-graphics': 'off',
      'data-animations': 'off',
      'data-density': 'compact',
    });
    expect(Object.fromEntries(variables)).toMatchObject({
      '--ast-text': '#123456',
      '--ast-text-secondary': '#667788',
      '--font-sans': FONT_FAMILY_STACKS['dm-mono'],
      '--text-base': '15px',
    });
    expect(themeColor.setAttribute).toHaveBeenLastCalledWith('content', '#ffffff');

    previewRuntimeAppearance(DEFAULT_RUNTIME_SETTINGS, root.style);
    expect(Object.fromEntries(attributes)).toMatchObject({
      'data-theme': 'dark',
      'data-background-graphics': 'on',
      'data-animations': 'on',
      'data-density': 'comfortable',
    });
    expect(Object.fromEntries(variables)).toMatchObject({
      '--ast-text': DEFAULT_RUNTIME_SETTINGS.fontBodyColor,
      '--ast-text-secondary': DEFAULT_RUNTIME_SETTINGS.fontMutedColor,
      '--font-sans': FONT_FAMILY_STACKS['dm-sans'],
      '--text-base': '13px',
    });

    adoptRuntimeEntityStyles(draft, root.style);
    expect(recalledLiveRuntimeSettings()).toBe(draft);
    expect(setItem).toHaveBeenCalledWith(RUNTIME_APPEARANCE_CACHE_KEY, JSON.stringify(draft));
  });

  it('adopts a valid cached appearance before startup and safely rejects malformed cache values', () => {
    expect(INDEX).toContain('data-background-graphics="on"');
    expect(INDEX).toContain('data-animations="on"');
    expect(INDEX).toContain('data-density="comfortable"');
    expect(INDEX.indexOf(RUNTIME_APPEARANCE_CACHE_KEY)).toBeLessThan(INDEX.indexOf('/src/main.tsx'));
    expect(INDEX).toContain("root.dataset.density = saved.density === 'compact' ? 'compact' : 'comfortable'");
    expect(INDEX).toContain('const sizeScale = { s: 0.92, m: 1, l: 1.15 }[saved.fontSize]');
    expect(INDEX).toContain('if (hex.test(saved.fontBodyColor))');
    expect(INDEX).toContain('if (families[saved.fontFamily])');
    expect(runtimeAppearanceFromCache(JSON.stringify(DEFAULT_RUNTIME_SETTINGS))).toEqual(DEFAULT_RUNTIME_SETTINGS);
    for (const malformed of [null, '{', '{"density":"dense"}', '{"fontBodyColor":"red"}']) {
      expect(runtimeAppearanceFromCache(malformed)).toBeNull();
    }
    expect(ROOT_RUNTIME).toContain("window.addEventListener('storage', onStorage)");
    expect(ROOT_RUNTIME).toContain('runtimeAppearanceFromCache(event.newValue)');
  });

  it('restores the saved appearance on cancel and adopts the server result on save', () => {
    expect(PANEL).toContain('previewRuntimeAppearance(settings)');
    expect(PANEL).toContain('previewRuntimeAppearance(savedSettings.current)');
    expect(PANEL).toContain('savedSettings.current = saved');
    expect(PANEL).toContain('adoptRuntimeEntityStyles(saved.settings)');
  });

  it('Background graphics Off hides only the decorative sky target', () => {
    expect(ROOT_STYLES).toMatch(/data-background-graphics='off'] \.app-sky\s*\{[^}]*display:\s*none/s);
    expect(ROOT_STYLES).not.toMatch(/data-background-graphics='off'][^{]*(ast-constellation|arch-canvas|ast-mark)/);
  });

  it('Animations Off suppresses transitions and active animation surfaces while retaining reduced motion', () => {
    expect(ROOT_STYLES).toMatch(
      /html\[data-animations='off'] \*\s*\{[^}]*transition-duration:\s*0ms !important[^}]*scroll-behavior:\s*auto !important/s
    );
    expect(ROOT_STYLES).toMatch(
      /data-animations='off'] \.app-sky\[data-star-motion-field] \*\s*\{[^}]*animation:\s*none/s
    );
    expect(ROOT_STYLES).toMatch(/data-animations='off'] \.arch-canvas \*\s*\{[^}]*animation:\s*none/s);
    expect(ROOT_STYLES).toMatch(
      /data-animations='off'] \.run-status\.is-alive \.run-status-dot\s*\{[^}]*animation:\s*none/s
    );
    expect(ROOT_STYLES).toMatch(/data-animations='off'] \.refresh-spin,[\s\S]*?animation:\s*none !important/s);
    expect(ROOT_STYLES).toMatch(
      /data-animations='off'] \[data-slot='progress']\[data-state='indeterminate'][\s\S]*?animation:\s*none !important[\s\S]*?opacity:\s*0\.45/s
    );
    expect(ROOT_STYLES).toMatch(/data-animations='off'] \[class\*='ast-anim-']\s*\{[^}]*animation:\s*none/s);
    const starMotion = readFileSync(new URL('./styles/star-motion.css', import.meta.url), 'utf8');
    expect(starMotion).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('Density changes targeted spacing tokens and surface classes without shrinking prose', () => {
    expect(ROOT_STYLES).toMatch(
      /html\[data-density='compact']\s*\{[^}]*--density-page-gap:\s*18px[^}]*--density-card-gap:\s*9px[^}]*--density-row-height:\s*36px[^}]*--density-control-height:\s*32px/s
    );
    for (const selector of [
      '.app-nav-tab',
      '.settings-data-table',
      '.conversation-row',
      '.run-item',
      '.monitoring-row',
      '.ops-block',
      '.connection-row-summary',
      '.arch-node',
      '.bench-region-head',
      '.summary-grid',
    ]) {
      expect(DENSITY_STYLES).toContain(selector);
    }
    expect(DENSITY_STYLES).toContain('--density-table-padding-block');
    expect(DENSITY_STYLES).toContain('--density-card-gap');
    expect(DENSITY_STYLES).not.toMatch(/data-density='compact'][^{]*\{[^}]*font-size/s);
    expect(DENSITY_STYLES).toContain('.answer-card-content');
    expect(ROOT_STYLES).toContain('@media (max-width: 800px)');
    expect(ROOT_STYLES).toContain('--density-control-height: 44px');
  });

  it('keeps Display rows aligned and stacks their controls cleanly at phone widths', () => {
    expect(SETTINGS_STYLES).toMatch(
      /\.appearance-text-controls\s*\{[^}]*grid-template-columns:\s*minmax\(190px,\s*1\.35fr\)\s*auto\s*repeat\(2,\s*minmax\(150px,\s*1fr\)\)/s
    );
    expect(SETTINGS_STYLES).toMatch(
      /\.appearance-display-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/s
    );
    expect(RESPONSIVE).toMatch(
      /@media \(max-width:\s*480px\)\s*\{[\s\S]*?\.appearance-display-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s
    );
    expect(RESPONSIVE).toMatch(
      /@media \(max-width:\s*800px\)\s*\{[\s\S]*?\.appearance-text-controls\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s
    );
    expect(RESPONSIVE).toMatch(
      /@media \(max-width:\s*480px\)\s*\{[\s\S]*?\.appearance-text-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s
    );
    expect(PANEL).toContain('Show decorative shell stars and constellation lines.');
    expect(PANEL).toContain('Show ambient motion and nonessential transitions.');
    expect(PANEL).toContain('Adjust tables, rails, settings rows, and card spacing.');
  });

  it('associates Display descriptions with their controls', () => {
    const markup = renderToStaticMarkup(<RuntimeSettingsPanel section="appearance" />);
    expect(markup).toContain('aria-describedby="appearance-background-graphics-help"');
    expect(markup).toContain('aria-describedby="appearance-animations-help"');
    expect(markup).toContain('aria-describedby="appearance-density-help"');
    expect(markup).toContain('aria-labelledby="appearance-density-label"');
  });
});
