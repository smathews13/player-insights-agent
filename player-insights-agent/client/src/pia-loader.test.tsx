import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PiaLoader, PiaLoaderMark } from './PiaLoader';
import {
  PIA_LOADER_CYCLE_SECONDS,
  PIA_LOADER_GLYPH_ORDER,
  PIA_LOADER_HALF_SECONDS,
  PIA_LOADER_SIZES,
  piaLoaderGlyphDelay,
} from './pia-loader';
import { partial, partialNames } from './styles/stylesheet';

const CSS = partial('pia-loader.css');

describe('PIA D-pad and cluster loader contract', () => {
  it('runs one 6.4s cycle in two equal 3.2s phases', () => {
    expect(PIA_LOADER_CYCLE_SECONDS).toBe(6.4);
    expect(PIA_LOADER_HALF_SECONDS).toBe(3.2);
    expect(PIA_LOADER_GLYPH_ORDER).toEqual(['up', 'right', 'down', 'left']);
    expect(PIA_LOADER_GLYPH_ORDER.map((_, index) => piaLoaderGlyphDelay(index))).toEqual([0, 0.8, 1.6, 2.4]);
    expect(CSS).toMatch(/\.pia-loader__phase\s*\{[^}]*animation:\s*pia-swap 6\.4s linear infinite/s);
    expect(CSS).toMatch(/\.pia-loader__phase--cluster\s*\{[^}]*animation-delay:\s*-3\.2s/s);
  });

  it('locks panel and inline seats to 112px and 20px', () => {
    expect(PIA_LOADER_SIZES).toEqual({ panel: 112, inline: 20 });
    expect(renderToStaticMarkup(<PiaLoader variant="panel" />)).toContain('width="112"');
    expect(renderToStaticMarkup(<PiaLoader variant="inline" />)).toContain('width="20"');
  });

  it('renders both marks around one persistent center dot', () => {
    const markup = renderToStaticMarkup(<PiaLoaderMark size={112} detailed />);
    expect(markup).toContain('pia-loader__phase--dpad');
    expect(markup).toContain('pia-loader__phase--cluster');
    expect(markup.match(/pia-loader__center/g)).toHaveLength(1);
    expect(markup.match(/pia-loader__highlight/g)).toHaveLength(4);
    expect(markup.match(/pia-loader__button/g)).toHaveLength(4);
    expect(markup.match(/animation-delay:-(?:3\.2|2\.4|1\.6|0\.8)s/g)).toHaveLength(8);
  });

  it('keeps inline motion to the mark swap and center dot', () => {
    const markup = renderToStaticMarkup(<PiaLoader variant="inline" />);
    expect(markup).toContain('pia-loader-mark--inline');
    expect(markup).not.toContain('pia-loader__highlight');
    expect(markup).not.toContain('pia-loader__button');
    expect(CSS).toContain('.pia-loader-mark--inline .pia-loader__diamond');
  });

  it('provides one polite status string, separate from decorative motion', () => {
    const markup = renderToStaticMarkup(<PiaLoader />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('Querying player data...');
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

  it('rests on one D-pad and the center dot instead of an empty frame or a pile', () => {
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.pia-loader__phase\s*\{[^}]*opacity:\s*0/s);
    expect(reduced).toMatch(/\.pia-loader__phase--dpad,[\s\S]*\.pia-loader__center\s*\{[^}]*opacity:\s*1/s);
    expect(reduced).toMatch(/\.pia-loader__highlight\s*\{[^}]*display:\s*none/s);
  });

  it('honors the in-app animation toggle and print with the same static frame', () => {
    expect(CSS).toContain("html[data-animations='off'] .pia-anim *");
    expect(CSS).toContain('@media print');
    expect(CSS.match(/animation: none !important;/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
