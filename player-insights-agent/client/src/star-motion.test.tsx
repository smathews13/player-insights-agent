import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OPENING_CONSTELLATION } from './constellation';
import { buildStarField, StarField } from './StarField';

const CSS = readFileSync(new URL('./styles/star-motion.css', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

function keyframes(name: string): string {
  const start = CSS.indexOf(`@keyframes ${name}`);
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  let depth = 0;
  let opened = false;
  for (let at = start; at < CSS.length; at += 1) {
    if (CSS[at] === '{') {
      depth += 1;
      opened = true;
    } else if (CSS[at] === '}') {
      depth -= 1;
      if (opened && depth === 0) return CSS.slice(start, at + 1);
    }
  }
  throw new Error(`Unclosed keyframes: ${name}`);
}

describe('ambient star motion', () => {
  it('pins the five source-of-truth keyframes and uses ease-in-out only', () => {
    expect(keyframes('ast-tw')).toMatch(/0%,\s*100%\s*\{\s*opacity:\s*0\.25;\s*\}[\s\S]*50%\s*\{\s*opacity:\s*0\.85/);
    expect(keyframes('ast-tw2')).toMatch(/0%,\s*100%\s*\{\s*opacity:\s*0\.15;\s*\}[\s\S]*50%\s*\{\s*opacity:\s*0\.5/);
    expect(keyframes('ast-drift')).toMatch(
      /from\s*\{\s*transform:\s*translate\(0,\s*0\);\s*\}[\s\S]*to\s*\{\s*transform:\s*translate\(-14px,\s*8px\)/
    );
    expect(keyframes('ast-drift2')).toMatch(
      /from\s*\{\s*transform:\s*translate\(0,\s*0\);\s*\}[\s\S]*to\s*\{\s*transform:\s*translate\(10px,\s*-6px\)/
    );
    expect(keyframes('ast-glow')).toMatch(/0%,\s*100%\s*\{\s*opacity:\s*0\.35;\s*\}[\s\S]*50%\s*\{\s*opacity:\s*0\.75/);
    expect(CSS.match(/@keyframes\s+ast-(?:tw|tw2|drift|drift2|glow)\b/g)).toHaveLength(5);
    expect(CSS.match(/animation-timing-function:\s*ease-in-out/g)).toHaveLength(4);
    expect(CSS).not.toMatch(/animation-timing-function:\s*(?:linear|ease;|cubic-bezier)/);
    expect(CSS).not.toContain('will-change');
  });

  it('keeps every generated cycle, phase, position, and population inside its hard limits', () => {
    const sky = buildStarField('/runs', 'limits');
    expect(sky.anchors).toHaveLength(OPENING_CONSTELLATION.stars.length);
    expect(sky.faint.length).toBeGreaterThanOrEqual(OPENING_CONSTELLATION.backdrop.length - 2);
    expect(sky.faint.length).toBeLessThanOrEqual(OPENING_CONSTELLATION.backdrop.length);

    sky.anchors.forEach((star, index) => {
      expect(star.duration).toBeGreaterThanOrEqual(6);
      expect(star.duration).toBeLessThanOrEqual(12);
      expect(Math.abs(star.x - OPENING_CONSTELLATION.stars[index].x)).toBeLessThanOrEqual(6);
      expect(Math.abs(star.y - OPENING_CONSTELLATION.stars[index].y)).toBeLessThanOrEqual(6);
    });
    sky.faint.forEach((star, index) => {
      expect(star.duration).toBeGreaterThanOrEqual(7);
      expect(star.duration).toBeLessThanOrEqual(13);
      expect(Math.abs(star.x - OPENING_CONSTELLATION.backdrop[index].x)).toBeLessThanOrEqual(6);
      expect(Math.abs(star.y - OPENING_CONSTELLATION.backdrop[index].y)).toBeLessThanOrEqual(6);
    });
    sky.connectors.forEach((connector) => {
      expect(connector.duration).toBeGreaterThanOrEqual(10);
      expect(connector.duration).toBeLessThanOrEqual(13);
    });

    const delays = [
      ...sky.anchors.map((star) => star.delay),
      ...sky.faint.map((star) => star.delay),
      ...sky.connectors.map((connector) => connector.delay),
      sky.drift.anchorDelay,
      sky.drift.faintDelay,
    ];
    expect(delays.every((delay) => delay < 0)).toBe(true);
    const starPairs = [...sky.anchors, ...sky.faint].map((star) => `${star.duration}/${star.delay}`);
    expect(new Set(starPairs).size).toBe(starPairs.length);
    expect(CSS).toMatch(/animation-duration:\s*90s/);
    expect(CSS).toMatch(/animation-duration:\s*70s/);
    expect(CSS).not.toMatch(/opacity:\s*(?:0\.(?:0[0-9]|1[0-4])|0\.8[6-9]|0\.9|1(?:\.0)?)/);
  });

  it('is seeded and produces the same complete sky for the same input', () => {
    expect(buildStarField('/', 'one-tab')).toEqual(buildStarField('/', 'one-tab'));
    expect(buildStarField('/', 'one-tab')).not.toEqual(buildStarField('/', 'another-tab'));
    expect(buildStarField('/', 'one-tab')).not.toEqual(buildStarField('/runs', 'one-tab'));
  });

  it('fully freezes reduced motion at the named resting opacities', () => {
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\[data-star-motion='anchor-still'\]\s*\{[^}]*animation:\s*none;[^}]*opacity:\s*0\.7/s);
    expect(reduced).toMatch(/\[data-star-motion-field\] \.star-motion-faint\s*\{[^}]*animation:\s*none;[^}]*opacity:\s*0\.32/s);
    expect(reduced).toMatch(/\[data-star-motion-field\] \.star-motion-glow\s*\{[^}]*animation:\s*none/s);
    expect(reduced).toMatch(/\[data-star-motion-field\] \.star-motion-drift\s*\{[^}]*animation:\s*none/s);
  });

  it('is decorative, pointer transparent, and loaded after the existing dark sky rules', () => {
    const markup = renderToStaticMarkup(<StarField pageId="/" surface="ask" seed="markup" />);
    expect(markup.match(/<svg\b/g)).toHaveLength(1);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
    expect(CSS).toMatch(/\[data-star-motion-field\]\s*\{[^}]*pointer-events:\s*none/s);
    expect(INDEX.indexOf("@import './styles/star-motion.css'")).toBeGreaterThan(
      INDEX.indexOf("@import './styles/dark-mode.css'")
    );
  });

  it('covers the full login viewport and retains right-side stars and connectors', () => {
    const sky = buildStarField('login-gate', 'full-width');
    const markup = renderToStaticMarkup(
      <StarField pageId="login-gate" surface="ask" seed="full-width" className="gate-star-motion" />
    );
    expect(markup).toContain('class="app-sky gate-star-motion"');
    expect(markup).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(CSS).toMatch(/\[data-star-motion-field\]\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%/s);
    expect(sky.anchors.some((star) => star.x > (OPENING_CONSTELLATION.width * 2) / 3)).toBe(true);
    expect(sky.connectors).toHaveLength(12);
    expect(sky.connectors.some((connector) => Math.max(connector.from[0], connector.to[0]) > 900)).toBe(true);
  });
});
