import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AppSky } from './AppSky';
import { OPENING_CONSTELLATION } from './constellation';

const source = readFileSync(new URL('./AppSky.tsx', import.meta.url), 'utf8');
const layout = readFileSync(new URL('./Layout.tsx', import.meta.url), 'utf8');
const base = readFileSync(new URL('./styles/base.css', import.meta.url), 'utf8');

describe('the dark-mode sky', () => {
  it('is decorative, static, and seated in the shell', () => {
    expect(layout).toContain('<AppSky />');
    expect(source).not.toContain('ast-anim');
    const markup = renderToStaticMarkup(<AppSky />);
    expect(markup).toContain('class="app-sky"');
    expect(markup).toContain('aria-hidden="true"');
  });

  it('draws stars and connectors in both thirds of the canvas', () => {
    /*
     * The reported screen had a complete upper-left chain and empty dark space
     * on the right. The data already held right-side constellations; taking the
     * first six filtered hops discarded them because the source list starts
     * with the seven-hop left loop.
     */
    const { width } = OPENING_CONSTELLATION;
    const markup = renderToStaticMarkup(<AppSky />);
    const connectors = [...markup.matchAll(/<line[^>]*x1="([^"]+)"[^>]*x2="([^"]+)"/g)].map((match) => [
      Number(match[1]),
      Number(match[2]),
    ]);
    const left = connectors.filter(([x1, x2]) => Math.min(x1, x2) < width / 3);
    const right = connectors.filter(([x1, x2]) => Math.max(x1, x2) > (width * 2) / 3);
    expect(left).toHaveLength(6);
    expect(right).toHaveLength(6);

    const glyphCircles = [...markup.matchAll(/<circle[^>]*class="app-sky-glyph"[^>]*cx="([^"]+)"/g)].map((match) =>
      Number(match[1])
    );
    expect(glyphCircles.some((x) => x > (width * 2) / 3)).toBe(true);
    // Kept inside the outer tenth so `xMidYMid slice` does not immediately crop
    // the only right-side glyph at common narrow aspect ratios.
    expect(glyphCircles.some((x) => x > (width * 2) / 3 && x < width * 0.9)).toBe(true);
  });

  it('reserves the document scrollbar so a filter menu cannot shove the sky', () => {
    /*
     * Classic overflow used to toggle a page bar, shrink the viewport, and
     * slide every centered page plus this fixed sky left. The gutter lives on
     * `html` alone -- the same rule that already owns scroll-padding -- and
     * must not leak onto `*`, which would inset every inner scroller.
     */
    const htmlRule = base.match(/(?:^|\})[\s\S]*?^html\s*\{([^{}]*)\}/m)?.[1] ?? '';
    expect(htmlRule).toMatch(/scrollbar-gutter:\s*stable/);
    const universalScroll = base.match(/\*\s*\{[^}]*scrollbar-width:\s*thin[^}]*\}/)?.[0] ?? '';
    expect(universalScroll).toMatch(/scrollbar-width:\s*thin/);
    expect(universalScroll).not.toMatch(/scrollbar-gutter/);
  });
});
