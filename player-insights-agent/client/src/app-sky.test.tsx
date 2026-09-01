import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AppSky } from './AppSky';
import { OPENING_CONSTELLATION } from './constellation';
import { SKY_DOCUMENT_SEED } from './StarField';

const source = readFileSync(new URL('./AppSky.tsx', import.meta.url), 'utf8');
const gate = readFileSync(new URL('./FirstOpenGate.tsx', import.meta.url), 'utf8');
const layout = readFileSync(new URL('./Layout.tsx', import.meta.url), 'utf8');
const base = readFileSync(new URL('./styles/base.css', import.meta.url), 'utf8');
const motion = readFileSync(new URL('./styles/star-motion.css', import.meta.url), 'utf8');

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
}

describe('the dark-mode sky', () => {
  it('is decorative, static, and seated in the shell', () => {
    expect(layout).toContain('<AppSky />');
    expect(source).not.toContain('ast-anim');
    expect(source).toContain('SKY_PAGE_ID');
    expect(source).toContain('pageId={SKY_PAGE_ID}');
    expect(source).not.toMatch(/\bseed=/);
    expect(code(gate)).not.toContain('StarField');
    expect(code(gate)).not.toContain('GateSky');
    expect(source).not.toContain('window.location');
    const markup = renderToStaticMarkup(<AppSky />);
    expect(markup).toContain('class="app-sky"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain(`data-sky-seed="${SKY_DOCUMENT_SEED}"`);
  });

  it('mounts one sky only after startup has handed the viewport to the app', () => {
    const layoutCode = code(layout);
    expect(layoutCode.match(/<AppSky \/>/g)).toHaveLength(1);
    expect(layoutCode).toContain('className="app-sky-host"');
    expect(motion).toMatch(/\.app-sky-host\s*\{[^}]*isolation:\s*isolate/s);

    const frameAt = layoutCode.indexOf('app-frame');
    const skyAt = layoutCode.indexOf('<AppSky />');
    expect(skyAt).toBeGreaterThan(-1);
    expect(skyAt).toBeLessThan(frameAt);
    expect(layoutCode.slice(frameAt)).not.toContain('<AppSky');

    const markup = renderToStaticMarkup(<AppSky />);
    expect(markup).not.toContain('gate-star-motion');
    expect(markup.match(/data-sky-seed="([^"]+)"/)?.[1]).toBe(SKY_DOCUMENT_SEED);
    const field = readFileSync(new URL('./StarField.tsx', import.meta.url), 'utf8');
    expect(field).toContain('useState(() => seed ?? SKY_DOCUMENT_SEED)');
    expect(field).toContain('crypto.getRandomValues');
    expect(field.replace(/\/\*[\s\S]*?\*\//g, ' ')).not.toMatch(/sessionStorage/);
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
    expect(left.length).toBeGreaterThanOrEqual(6);
    expect(right.length).toBeGreaterThanOrEqual(6);

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
