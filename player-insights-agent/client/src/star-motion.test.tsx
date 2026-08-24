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

  it('draws every line between the two stars it joins, at the same drifted point', () => {
    /*
     * THE REPORTED DEFECT: stars sitting a few pixels off the ends of their own
     * lines. Both halves of it are held here, because either one alone puts them
     * back.
     *
     * The coordinates agree -- every endpoint is some star's own centre, jitter
     * included, so nothing is drawn to where a star would have been.
     *
     * And the transform agrees, which is the half that was wrong. The drift is a
     * 14px translate with a negative delay, so a connector group outside the
     * drifting group is already offset on the first frame and goes on separating
     * for ninety seconds. One group carries both.
     */
    const markup = renderToStaticMarkup(<StarField pageId="/" surface="ask" seed="joined" />);
    expect(markup).toMatch(
      /<g class="star-motion-drift star-motion-drift-anchor"[^>]*><g class="star-motion-connectors">/
    );

    const stars = new Set(
      [...markup.matchAll(/<circle[^>]*class="app-sky-glyph"[^>]*cx="([^"]+)" cy="([^"]+)"/g)].map(
        (match) => `${match[1]},${match[2]}`
      )
    );
    const ends = [...markup.matchAll(/<line[^>]*x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/g)].flatMap(
      (match) => [`${match[1]},${match[2]}`, `${match[3]},${match[4]}`]
    );
    expect(ends.length).toBe(24);
    expect(ends.filter((end) => !stars.has(end))).toEqual([]);
  });

  it('switches nothing off for a reader who did not ask for less motion', () => {
    /*
     * `html:has(.first-open) .star-motion-drift { animation: none }` used to sit
     * in this file and stop the drift for the whole life of the login gate --
     * which is the screen looked at longest, and the reason the sky was reported
     * as static. What it was written for was the connectors not drifting with
     * their stars, so half the drawing slid; that is fixed above.
     *
     * Reduced motion is the one thing that freezes this layer. A `paused` state
     * is a different claim and stays allowed: the agent path takes over the
     * motion while a step is live, and it resumes on its own.
     */
    // Comments stripped first: the note above the guard explains why `animation:
    // none` is the right tool there, and reading it as a rule would fail this on
    // its own rationale.
    const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const ambient = rules.slice(0, rules.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(ambient).not.toMatch(/animation:\s*none/);
    expect(ambient).not.toContain('has(.first-open)');
  });

  it('keeps anchor fading active on every working tab', () => {
    /*
     * The global failure was one branch in `StarField`: a working surface
     * changed every anchor to `anchor-still` and removed its inline duration.
     * Every route except Ask uses that surface, so the main stars were static
     * on every working tab even though the keyframes were still in the CSS.
     *
     * Pin both halves. An animation name with the default 0s duration is still
     * motionless, so checking only the data attribute would miss the same
     * failure in a slightly different form.
     */
    const markup = renderToStaticMarkup(<StarField pageId="/runs" surface="working" seed="working-motion" />);
    const anchors = [...markup.matchAll(/<circle[^>]*data-star-motion="anchor"[^>]*>/g)].map((match) => match[0]);

    expect(anchors).toHaveLength(OPENING_CONSTELLATION.stars.length);
    expect(anchors.every((anchor) => /animation-duration:[^;"]+s/.test(anchor))).toBe(true);
    expect(markup).not.toContain('anchor-still');
  });

  it('fully freezes reduced motion at the named resting opacities', () => {
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\[data-star-motion='anchor'\]\s*\{[^}]*animation:\s*none;[^}]*opacity:\s*0\.7/s);
    expect(reduced).toMatch(
      /\[data-star-motion-field\] \.star-motion-faint\s*\{[^}]*animation:\s*none;[^}]*opacity:\s*0\.32/s
    );
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
