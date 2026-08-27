import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OPENING_CONSTELLATION } from './constellation';
import {
  buildStarField,
  connectorPhaseAt,
  liveConnectorsAt,
  SKY_ANCHOR_MIN_SECONDS,
  SKY_ANCHOR_RADIUS_MAX,
  SKY_ANCHOR_RADIUS_MIN,
  SKY_APPEAR_STEP,
  SKY_DRAW_HOLD_UNTIL,
  SKY_DRAW_LIVE_UNTIL,
  SKY_DRAW_MIN_SECONDS,
  SKY_FAINT_MIN_SECONDS,
  SKY_FAINT_RADIUS_MAX,
  SKY_FAINT_RADIUS_MIN,
  SKY_PAGE_ID,
  StarField,
} from './StarField';

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
    expect(keyframes('ast-tw')).toMatch(
      /0%,\s*100%\s*\{\s*opacity:\s*0;[\s\S]*transform:\s*scale\(0\.45\)[\s\S]*50%\s*\{\s*opacity:\s*0\.85;[\s\S]*transform:\s*scale\(1\.2\)/
    );
    expect(keyframes('ast-tw2')).toMatch(
      /0%,\s*100%\s*\{\s*opacity:\s*0;[\s\S]*transform:\s*scale\(0\.4\)[\s\S]*50%\s*\{\s*opacity:\s*0\.55;[\s\S]*transform:\s*scale\(1\.15\)/
    );
    expect(keyframes('ast-drift')).toMatch(
      /from\s*\{\s*transform:\s*translate\(0,\s*0\);\s*\}[\s\S]*to\s*\{\s*transform:\s*translate\(-14px,\s*8px\)/
    );
    expect(keyframes('ast-drift2')).toMatch(
      /from\s*\{\s*transform:\s*translate\(0,\s*0\);\s*\}[\s\S]*to\s*\{\s*transform:\s*translate\(10px,\s*-6px\)/
    );
    expect(keyframes('ast-sky-draw')).toMatch(
      /0%\s*\{\s*stroke-dashoffset:\s*1;[\s\S]*12%\s*\{\s*stroke-dashoffset:\s*0;/
    );
    expect(keyframes('ast-sky-draw')).toMatch(
      /60%\s*\{\s*stroke-dashoffset:\s*0;[\s\S]*opacity:\s*0\.45;[\s\S]*80%\s*\{\s*stroke-dashoffset:\s*1;[\s\S]*opacity:\s*0;/
    );
    expect(keyframes('ast-sky-draw')).not.toMatch(/50%\s*\{\s*stroke-dashoffset:\s*0/);
    expect(keyframes('ast-sky-draw')).not.toMatch(/70%\s*\{\s*stroke-dashoffset:\s*0/);
    expect(keyframes('ast-sky-draw')).not.toMatch(/75%\s*\{\s*stroke-dashoffset:\s*1/);
    expect(CSS.match(/@keyframes\s+ast-(?:tw|tw2|drift|drift2|sky-draw)\b/g)).toHaveLength(5);
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
      expect(star.duration).toBeGreaterThanOrEqual(SKY_ANCHOR_MIN_SECONDS);
      expect(star.duration).toBeLessThanOrEqual(SKY_ANCHOR_MIN_SECONDS + 12);
      expect(star.r).toBeGreaterThanOrEqual(SKY_ANCHOR_RADIUS_MIN);
      expect(star.r).toBeLessThanOrEqual(SKY_ANCHOR_RADIUS_MAX);
      expect(Math.abs(star.x - OPENING_CONSTELLATION.stars[index].x)).toBeLessThanOrEqual(6);
      expect(Math.abs(star.y - OPENING_CONSTELLATION.stars[index].y)).toBeLessThanOrEqual(6);
    });
    sky.faint.forEach((star, index) => {
      expect(star.duration).toBeGreaterThanOrEqual(SKY_FAINT_MIN_SECONDS);
      expect(star.duration).toBeLessThanOrEqual(SKY_FAINT_MIN_SECONDS + 12);
      expect(star.r).toBeGreaterThanOrEqual(SKY_FAINT_RADIUS_MIN);
      expect(star.r).toBeLessThanOrEqual(SKY_FAINT_RADIUS_MAX);
      expect(Math.abs(star.x - OPENING_CONSTELLATION.backdrop[index].x)).toBeLessThanOrEqual(6);
      expect(Math.abs(star.y - OPENING_CONSTELLATION.backdrop[index].y)).toBeLessThanOrEqual(6);
    });
    sky.connectors.forEach((connector) => {
      expect(connector.duration).toBeGreaterThanOrEqual(SKY_DRAW_MIN_SECONDS);
      expect(connector.duration).toBeLessThanOrEqual(SKY_DRAW_MIN_SECONDS + 8);
    });

    const starDelays = [
      ...sky.anchors.map((star) => star.delay),
      ...sky.faint.map((star) => star.delay),
      sky.drift.anchorDelay,
      sky.drift.faintDelay,
    ];
    expect(starDelays.every((delay) => delay < 0)).toBe(true);
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
    expect(ends.filter((end) => !stars.has(end))).toEqual([]);
    expect(ends.length).toBeGreaterThan(24);
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
    expect(markup).toContain('star-motion-draw');
    expect(markup).toContain('pathLength="1"');
  });

  it('fully freezes reduced motion at the named resting opacities', () => {
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\[data-star-motion='anchor'\]\s*\{[^}]*animation:\s*none;[^}]*opacity:\s*0\.7/s);
    expect(reduced).toMatch(
      /\[data-star-motion-field\] \.star-motion-faint\s*\{[^}]*animation:\s*none;[^}]*opacity:\s*0\.32/s
    );
    expect(reduced).toMatch(
      /\[data-star-motion-field\] \.star-motion-draw\s*\{[^}]*animation:\s*none;[^}]*stroke-dashoffset:\s*0/s
    );
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
    const sky = buildStarField(SKY_PAGE_ID, 'full-width');
    const markup = renderToStaticMarkup(
      <StarField pageId={SKY_PAGE_ID} surface="ask" seed="full-width" className="gate-star-motion" />
    );
    expect(markup).toContain('class="app-sky gate-star-motion"');
    expect(markup).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(CSS).toMatch(
      /\[data-star-motion-field\]\s*\{[^}]*right:\s*auto;[^}]*bottom:\s*auto;[^}]*width:\s*100vw;[^}]*height:\s*100vh/s
    );
    expect(sky.anchors.some((star) => star.x > (OPENING_CONSTELLATION.width * 2) / 3)).toBe(true);
    expect(sky.connectors.length).toBeGreaterThanOrEqual(OPENING_CONSTELLATION.hops.length);
    expect(sky.connectors.some((connector) => Math.max(connector.from[0], connector.to[0]) > 900)).toBe(true);
  });

  it('draws new connectors after first paint instead of pulsing a finished sky', () => {
    /*
     * THE REPORTED DEFECT: the login sky was a still constellation. Every line
     * existed on first paint with a negative delay and an opacity pulse, so
     * nothing ever appeared -- the field just breathed. A later tick must show
     * edges that were not live at t=0, and those edges must be stroke-drawn
     * (dasharray / pathLength), not merely faded in.
     */
    const markup = renderToStaticMarkup(<StarField pageId={SKY_PAGE_ID} surface="ask" seed="living" />);
    expect(markup).toContain('star-motion-draw');
    expect(markup).toContain('pathLength="1"');
    expect(markup).toContain('stroke-dasharray="1"');
    expect(CSS).toMatch(/animation-fill-mode:\s*both/);
    expect(CSS).toMatch(/animation-name:\s*ast-sky-draw/);

    for (const seed of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
      const sky = buildStarField(SKY_PAGE_ID, seed);
      const now = liveConnectorsAt(sky, 0);
      const later = liveConnectorsAt(sky, 16);
      expect(later.length, `${seed} grows`).toBeGreaterThan(now.length);
      expect(sky.connectors.some((connector) => connector.delay > 2)).toBe(true);
      expect(now.length).toBeGreaterThan(0);
    }
  });

  it('is the same sky on the login gate and inside the app', () => {
    const login = renderToStaticMarkup(
      <StarField pageId={SKY_PAGE_ID} surface="ask" seed="session" className="gate-star-motion" />
    );
    const app = renderToStaticMarkup(<StarField pageId={SKY_PAGE_ID} surface="working" seed="session" />);
    const lines = (markup: string) =>
      [...markup.matchAll(/<line[^>]*x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/g)].map((match) =>
        match.slice(1).join(',')
      );
    expect(lines(login)).toEqual(lines(app));
    expect(login).toContain('star-motion-draw');
    expect(app).toContain('star-motion-draw');
    expect(login).toContain('pathLength="1"');
    expect(app).toContain('pathLength="1"');
  });

  it('starts new lines, retracts, and blinks slower than the e0e254a9 cadence', () => {
    expect(SKY_APPEAR_STEP).toBeGreaterThan(5);
    expect(SKY_APPEAR_STEP).toBe(10);
    expect(SKY_ANCHOR_MIN_SECONDS).toBeGreaterThan(12);
    expect(SKY_ANCHOR_MIN_SECONDS).toBe(24);
    expect(SKY_FAINT_MIN_SECONDS).toBeGreaterThan(14);
    expect(SKY_FAINT_MIN_SECONDS).toBe(28);
    expect(SKY_DRAW_MIN_SECONDS).toBeGreaterThan(44);
    expect(SKY_DRAW_MIN_SECONDS).toBe(72);
    expect(SKY_DRAW_HOLD_UNTIL).toBeGreaterThan(0.5);
    expect(SKY_DRAW_HOLD_UNTIL).toBe(0.6);
    expect(SKY_DRAW_LIVE_UNTIL).toBeGreaterThan(0.75);
    expect(SKY_DRAW_LIVE_UNTIL).toBe(0.8);

    const sky = buildStarField(SKY_PAGE_ID, 'cadence');
    const delays = [...sky.connectors.map((connector) => connector.delay)].sort((a, b) => a - b);
    const steps = delays.slice(1).map((delay, index) => delay - delays[index]);
    const mean = steps.reduce((sum, step) => sum + step, 0) / steps.length;
    expect(mean).toBeGreaterThan(9.7);
    expect(mean).toBeLessThan(10.3);
    expect(sky.connectors.every((connector) => connector.duration > 44)).toBe(true);
    expect(sky.anchors.every((star) => star.duration > 12)).toBe(true);
    expect(sky.faint.every((star) => star.duration > 14)).toBe(true);
  });

  it('retracts and fades lines instead of only adding them, without emptying the sky', () => {
    const draw = keyframes('ast-sky-draw');
    expect(draw).toMatch(/80%\s*\{[^}]*stroke-dashoffset:\s*1;[^}]*opacity:\s*0/s);

    for (const seed of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
      const sky = buildStarField(SKY_PAGE_ID, seed);
      let sawDrawing = false;
      let sawRetracting = false;
      let sawGrow = false;
      let sawShrink = false;
      let previous = liveConnectorsAt(sky, 0).length;
      expect(previous).toBeGreaterThan(0);

      for (let elapsed = 1; elapsed <= 90; elapsed += 1) {
        const live = liveConnectorsAt(sky, elapsed);
        expect(live.length, `${seed} at ${elapsed}s`).toBeGreaterThan(0);
        if (live.length > previous) sawGrow = true;
        if (live.length < previous) sawShrink = true;
        previous = live.length;
        for (const connector of sky.connectors) {
          const phase = connectorPhaseAt(connector, elapsed);
          if (phase === 'drawing') sawDrawing = true;
          if (phase === 'retracting') sawRetracting = true;
        }
      }

      expect(sawDrawing, `${seed} draws`).toBe(true);
      expect(sawRetracting, `${seed} retracts`).toBe(true);
      expect(sawGrow, `${seed} adds`).toBe(true);
      expect(sawShrink, `${seed} removes`).toBe(true);
    }
  });

  it('blinks stars in and out at mixed sizes, not only as line motion', () => {
    expect(CSS).toMatch(/transform-box:\s*fill-box/);
    expect(CSS).toMatch(/\[data-star-motion='anchor'\][^}]*animation-fill-mode:\s*both/s);
    expect(keyframes('ast-tw')).toMatch(/opacity:\s*0;/);
    expect(keyframes('ast-tw')).toMatch(/transform:\s*scale\(1\.2\)/);
    expect(keyframes('ast-tw2')).toMatch(/opacity:\s*0;/);

    expect(SKY_ANCHOR_RADIUS_MIN).toBe(1.4);
    expect(SKY_FAINT_RADIUS_MIN).toBe(0.8);
    expect(SKY_ANCHOR_RADIUS_MAX).toBeCloseTo(3.4 * 0.75);
    expect(SKY_FAINT_RADIUS_MAX).toBeCloseTo(2.2 * 0.75);

    const sky = buildStarField(SKY_PAGE_ID, 'sizes');
    const anchors = sky.anchors.map((star) => star.r);
    const faint = sky.faint.map((star) => star.r);
    expect(new Set(anchors).size).toBeGreaterThan(5);
    expect(new Set(faint).size).toBeGreaterThan(3);
    expect(Math.min(...anchors)).toBeLessThan(Math.max(...anchors));
    expect(Math.max(...anchors)).toBeLessThanOrEqual(SKY_ANCHOR_RADIUS_MAX);
    expect(Math.max(...faint)).toBeLessThanOrEqual(SKY_FAINT_RADIUS_MAX);

    const markup = renderToStaticMarkup(<StarField pageId={SKY_PAGE_ID} surface="ask" seed="sizes" />);
    const drawn = [...markup.matchAll(/class="app-sky-glyph"[^>]*r="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(drawn).size).toBeGreaterThan(5);
  });

  it('picks a different line foundation for each fresh visit, not a restagger of one default', () => {
    const layouts = ['visit-a', 'visit-b', 'visit-c', 'visit-d', 'visit-e'].map((seed) =>
      buildStarField(SKY_PAGE_ID, seed)
        .connectors.map((connector) => `${connector.from.join(',')}-${connector.to.join(',')}`)
        .sort()
        .join('|')
    );
    expect(new Set(layouts).size).toBeGreaterThan(1);
    expect(layouts[0]).not.toEqual(layouts[1]);
  });
});
