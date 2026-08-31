import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_RUNTIME_SETTINGS } from '../../shared/runtime-settings';
import { RuntimeSettingsPanel } from './RuntimeSettingsPanel';
import {
  RUNTIME_APPEARANCE_CACHE_KEY,
  cacheRuntimeAppearance,
  runtimeAppearanceFromCache,
  writeRuntimeAppearanceAttributes,
} from './runtime-entity-styles';

const PANEL = readFileSync(new URL('./RuntimeSettingsPanel.tsx', import.meta.url), 'utf8');
const ROOT_RUNTIME = readFileSync(new URL('./runtime-entity-styles.ts', import.meta.url), 'utf8');
const ROOT_STYLES = readFileSync(new URL('./styles/appearance-preferences.css', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

describe('Appearance preferences', () => {
  it('separates Display, Typography, Interface, and entity colors', () => {
    const markup = renderToStaticMarkup(<RuntimeSettingsPanel section="appearance" />);
    const display = markup.slice(
      markup.indexOf('appearance-display-section'),
      markup.indexOf('appearance-typography-section')
    );
    const typography = markup.slice(
      markup.indexOf('appearance-typography-section'),
      markup.indexOf('appearance-interface-section')
    );
    const interfaceSection = markup.slice(
      markup.indexOf('appearance-interface-section'),
      markup.indexOf('appearance-palette-section')
    );

    expect(display).toContain('>Display</h4>');
    expect(display).toContain('>Dark mode</span>');
    expect(display).toContain('>Body text</span>');
    expect(display).toContain('>Secondary</span>');
    expect(display).toContain('type="color"');
    expect(display).not.toContain('>Font</span>');
    expect(display).not.toContain('>Size</span>');

    expect(typography).toContain('>Typography</h4>');
    expect(typography).toContain('aria-label="Font: DM Sans"');
    expect(typography).toContain('aria-label="Font size M"');
    expect(typography).toContain('>Preview</p>');

    expect(interfaceSection).toContain('>Interface</h4>');
    expect(interfaceSection).toContain('>Background graphics</span>');
    expect(interfaceSection).toContain('>Animations</span>');
    expect(interfaceSection).toContain('>Density</span>');
    expect(interfaceSection.match(/>On</g)).toHaveLength(2);
    expect(interfaceSection).toContain('role="radiogroup"');
    expect(interfaceSection).toContain('role="radio"');
    expect(interfaceSection).toContain('>Comfortable</button>');
    expect(interfaceSection).toContain('>Compact</button>');
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
  });

  it('adopts cached root choices before the application module loads', () => {
    expect(INDEX).toContain('data-background-graphics="on"');
    expect(INDEX).toContain('data-animations="on"');
    expect(INDEX).toContain('data-density="comfortable"');
    expect(INDEX.indexOf(RUNTIME_APPEARANCE_CACHE_KEY)).toBeLessThan(INDEX.indexOf('/src/main.tsx'));
    expect(INDEX).toContain("root.dataset.density = saved.density === 'compact' ? 'compact' : 'comfortable'");
    expect(ROOT_RUNTIME).toContain("window.addEventListener('storage', onStorage)");
    expect(ROOT_RUNTIME).toContain('runtimeAppearanceFromCache(event.newValue)');
  });

  it('restores the saved appearance on cancel and adopts the server result on save', () => {
    expect(PANEL).toContain('previewRuntimeAppearance(settings)');
    expect(PANEL).toContain('previewRuntimeAppearance(savedSettings.current)');
    expect(PANEL).toContain('savedSettings.current = saved');
    expect(PANEL).toContain('adoptRuntimeEntityStyles(saved)');
  });

  it('targets decorative shell graphics without hiding diagrams or brand marks', () => {
    expect(ROOT_STYLES).toMatch(/data-background-graphics='off'] \.app-sky\s*\{[^}]*display:\s*none/s);
    expect(ROOT_STYLES).not.toMatch(/data-background-graphics='off'][^{]*(ast-constellation|arch-canvas|ast-mark)/);
  });

  it('lets user Off win while retaining the operating-system reduced-motion guard', () => {
    expect(ROOT_STYLES).toContain("html[data-animations='off']");
    expect(ROOT_STYLES).toMatch(
      /data-animations='off'] \.app-sky\[data-star-motion-field] \*\s*\{[^}]*animation:\s*none/s
    );
    expect(ROOT_STYLES).toMatch(/data-animations='off'] \.arch-canvas \*\s*\{[^}]*animation:\s*none/s);
    const starMotion = readFileSync(new URL('./styles/star-motion.css', import.meta.url), 'utf8');
    expect(starMotion).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('compacts data surfaces through shared spacing without shrinking prose', () => {
    for (const selector of [
      '.settings-data-table',
      '.conversation-row',
      '.run-item',
      '.monitoring-row',
      '.summary-grid',
    ]) {
      expect(ROOT_STYLES).toContain(selector);
    }
    expect(ROOT_STYLES).toContain('--density-table-padding');
    expect(ROOT_STYLES).toContain('--density-card-gap');
    expect(ROOT_STYLES).not.toMatch(/data-density='compact'][^{]*\{[^}]*font-size/s);
    expect(ROOT_STYLES).not.toContain('.answer-card-content');
  });

  it('keeps the new controls wrapping inside the scrolling modal at phone widths', () => {
    expect(ROOT_STYLES).toMatch(/\.appearance-typography-controls\s*\{[^}]*flex-wrap:\s*wrap/s);
    expect(ROOT_STYLES).toMatch(/\.appearance-interface-row\s*\{[^}]*flex-wrap:\s*wrap/s);
    expect(PANEL).toContain('Show decorative shell stars and constellation lines.');
    expect(PANEL).toContain('Show ambient motion and nonessential transitions.');
    expect(PANEL).toContain('Adjust tables, rails, settings rows, and card spacing.');
  });
});
