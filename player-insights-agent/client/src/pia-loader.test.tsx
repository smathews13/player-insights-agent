import { readFileSync } from 'node:fs';
import { Save } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DEFAULT_RUNTIME_SETTINGS } from '../../shared/runtime-settings';
import { PiaFlicker } from './PiaFlicker';
import { PiaBusyButtonContent, PiaLoader, PiaLoaderMark } from './PiaLoader';
import {
  PIA_LOADER_CYCLE_SECONDS,
  PIA_LOADER_GLYPH_ORDER,
  PIA_LOADER_HALF_SECONDS,
  PIA_LOADER_SIZES,
  piaLoaderGlyphDelay,
} from './pia-loader';
import { partial, partialNames } from './styles/stylesheet';

const CSS = partial('pia-loader.css');
const INDEX = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function keyframes(name: string): string {
  const start = CSS.indexOf(`@keyframes ${name} {`);
  return start < 0 ? '' : CSS.slice(start, CSS.indexOf('\n}\n', start) + 2);
}

describe('PIA D-pad and cluster loader contract', () => {
  it('runs one 6.4s cycle in two equal 3.2s phases', () => {
    expect(PIA_LOADER_CYCLE_SECONDS).toBe(6.4);
    expect(PIA_LOADER_HALF_SECONDS).toBe(3.2);
    expect(PIA_LOADER_GLYPH_ORDER).toEqual(['up', 'right', 'down', 'left']);
    expect(PIA_LOADER_GLYPH_ORDER.map((_, index) => piaLoaderGlyphDelay(index))).toEqual([-3.2, -2.4, -1.6, -0.8]);
    expect(CSS).toMatch(/\.pia-loader__phase\s*\{[^}]*animation:\s*pia-swap 6\.4s linear infinite/s);
    expect(CSS).toMatch(/\.pia-loader__phase--cluster\s*\{[^}]*animation-delay:\s*-3\.2s/s);
    expect(CSS).toMatch(/\.pia-loader__highlight\s*\{[^}]*animation:\s*pia-hl 3\.2s linear infinite/s);
    expect(CSS).toMatch(/\.pia-loader__button\s*\{[^}]*animation:\s*pia-btn-light 3\.2s linear infinite/s);
  });

  it('uses the specified fade/scale swap without dual marks above ten percent', () => {
    const swap = keyframes('pia-swap');
    expect(swap).toMatch(/0%,\s*2%\s*\{[^}]*opacity:\s*0;[^}]*scale\(0\.82\)/s);
    expect(swap).toMatch(/7%\s*\{[^}]*opacity:\s*1;[^}]*scale\(1\.06\)/s);
    expect(swap).toMatch(/10%,\s*44%\s*\{[^}]*opacity:\s*1;[^}]*scale\(1\)/s);
    expect(swap).toMatch(/49%,\s*100%\s*\{[^}]*opacity:\s*0;[^}]*scale\(0\.85\)/s);
  });

  it('locks every canonical seat to its specified geometry', () => {
    expect(PIA_LOADER_SIZES).toEqual({ panel: 112, compact: 32, inline: 20, button: 16, chip: 16 });
    expect(renderToStaticMarkup(<PiaLoader variant="panel" />)).toContain('width="112"');
    expect(renderToStaticMarkup(<PiaLoader variant="compact" />)).toContain('width="32"');
    expect(renderToStaticMarkup(<PiaLoader variant="inline" />)).toContain('width="20"');
    expect(renderToStaticMarkup(<PiaLoader variant="button" />)).toContain('width="16"');
    expect(renderToStaticMarkup(<PiaLoaderMark variant="button" size={12} />)).toContain('stroke-width="2"');
  });

  it('renders both marks around one persistent center dot', () => {
    const markup = renderToStaticMarkup(<PiaLoaderMark variant="panel" />);
    expect(markup).toContain('pia-loader__phase--dpad');
    expect(markup).toContain('pia-loader__phase--cluster');
    expect(markup.match(/pia-loader__center/g)).toHaveLength(1);
    expect(markup.match(/pia-loader__highlight/g)).toHaveLength(8);
    expect(markup.match(/class="pia-loader__button"/g)).toHaveLength(4);
    expect(markup.match(/animation-delay:-(?:3\.2|2\.4|1\.6|0\.8)s/g)).toHaveLength(12);
    expect(markup.match(/pia-loader__tip-pills/g)).toHaveLength(1);
    expect(CSS).toMatch(/\.pia-loader__button\s*\{[^}]*opacity:\s*0\.3[^}]*animation:\s*pia-btn-light 3\.2s/s);
    expect(CSS).toMatch(/\.pia-loader__diamond\s*\{[^}]*opacity:\s*0\.6/s);
  });

  it('keeps inline motion to two complete simplified marks and the center dot', () => {
    const markup = renderToStaticMarkup(<PiaLoader variant="inline" />);
    const dpad = markup.slice(markup.indexOf('pia-loader__phase--dpad'), markup.indexOf('pia-loader__phase--cluster'));
    expect(markup).toContain('pia-loader-mark--inline');
    expect(dpad).toContain('data-pia-role="arm"');
    expect(dpad).not.toContain('data-pia-role="glyph"');
    expect(markup).not.toContain('pia-loader__highlight');
    expect(markup).not.toContain('pia-loader__button');
    expect(markup).not.toContain('pia-loader__diamond');
  });

  it('uses swaps for panel/compact/inline and a fixed clockwise cluster for controls', () => {
    for (const seat of ['splash', 'compact', 'inline', 'strip'] as const) {
      const markup = renderToStaticMarkup(<PiaFlicker seat={seat} />);
      expect(markup, seat).toContain('pia-loader__phase--dpad');
      expect(markup, seat).toContain('pia-loader__phase--cluster');
      expect(markup, seat).toContain('pia-loader__center');
    }
    for (const seat of ['button', 'status'] as const) {
      const markup = renderToStaticMarkup(<PiaFlicker seat={seat} />);
      expect(markup, seat).toContain('pia-loader__button-cluster');
      expect(markup, seat).not.toContain('pia-loader__phase');
      expect(markup, seat).not.toContain('pia-loader__center');
    }
  });

  it('provides one polite status string, separate from decorative motion', () => {
    const markup = renderToStaticMarkup(<PiaLoader />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('Querying player data...');
  });

  it('keeps button width and accessible name stable without an overlay', () => {
    const idle = renderToStaticMarkup(
      <PiaBusyButtonContent
        busy={false}
        label="Save settings"
        busyLabel="Saving"
        icon={<Save data-testid="idle-icon" />}
      />
    );
    const busy = renderToStaticMarkup(
      <PiaBusyButtonContent busy label="Save settings" busyLabel="Saving" icon={<Save data-testid="idle-icon" />} />
    );
    for (const markup of [idle, busy]) {
      expect(markup).toContain('pia-button-state__idle');
      expect(markup).toContain('pia-button-state__busy');
      expect(markup).toContain('Save settings');
      expect(markup).toContain('pia-loader-mark--button');
      expect(markup).toContain('data-testid="idle-icon"');
      expect(markup.match(/pia-button-state/g)).toHaveLength(3);
    }
    expect(CSS).toMatch(/\.pia-button-state\s*\{[^}]*display:\s*inline-grid/s);
    expect(CSS).toMatch(/\.pia-button-state__idle,[\s\S]*\.pia-button-state__busy\s*\{[^}]*grid-area:\s*1 \/ 1/s);
    expect(CSS).toMatch(/\.pia-loader--button,[\s\S]*\.pia-loader--chip\s*\{[^}]*background:\s*transparent/s);
  });

  it('adapts to light, dark, and high-contrast surfaces', () => {
    expect(CSS).toContain('.pia-loader-mark--light');
    expect(CSS).toContain('.pia-loader-mark--dark');
    expect(CSS).toContain('@media (prefers-contrast: more)');
    expect(CSS).toContain('--pia-mark-ink: #11171c');
    expect(CSS).toContain('--pia-mark-accent: #b7d6ee');
  });
});

describe('motion accessibility', () => {
  it('loads the PIA loader stylesheet', () => {
    expect(partialNames()).toContain('pia-loader.css');
  });

  it('stops every descendant animation for reduced motion', () => {
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.pia-anim \*\s*\{\s*animation:\s*none !important;/);
  });

  it('rests on one simplified D-pad and the center dot instead of an empty frame or a pile', () => {
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.pia-loader__phase\s*\{[^}]*opacity:\s*0/s);
    expect(reduced).toMatch(/\.pia-loader__phase--dpad,[\s\S]*\.pia-loader__center\s*\{[^}]*opacity:\s*1/s);
    expect(reduced).toMatch(/\.pia-loader__phase--dpad \[data-pia-role='glyph'\]\s*\{[^}]*display:\s*none/s);
  });

  it('honors the in-app animation toggle and print with the same static frame', () => {
    expect(CSS).toContain("html[data-animations='off'] .pia-anim *");
    expect(CSS).toMatch(
      /html\[data-animations='off'\] \.pia-loader__phase--dpad \[data-pia-role='glyph'\]\s*\{[^}]*display:\s*none/s
    );
    expect(CSS).toContain('@media print');
    expect(CSS.match(/animation: none !important;/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('ships animation on by default while preserving both explicit motion vetoes', () => {
    expect(DEFAULT_RUNTIME_SETTINGS.animations).toBe(true);
    expect(INDEX).toContain('data-animations="on"');
    expect(INDEX).toContain("root.dataset.animations = saved.animations === false ? 'off' : 'on'");
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(CSS).toContain("html[data-animations='off'] .pia-anim *");
  });
});
