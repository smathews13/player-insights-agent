import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { partial } from './styles/stylesheet';
import { FLICKER_ORDER } from './astrolabe-mark';
import { OPENING_CONSTELLATION } from './constellation';
import {
  CONCEPT_HOLD_SECONDS,
  CONCEPT_LEAD_SECONDS,
  CONCEPT_SIZE,
  GATE_RISE_FRACTION,
  OPENING_SECONDS,
  RISE_SETTLE_MS,
  conceptDelay,
  gateRiseMs,
  gateRiseStyle,
  prefersReducedMotion,
  showsOpeningSequence,
} from './opening-sequence';

/**
 * The app opening (`#19a`).
 *
 * Four claims are worth holding here and the rest of the sequence is a drawing
 * that `constellation.test.ts` and `working-animation.test.ts` already check:
 *
 *   1. It plays once per session, off the GATE's latch rather than a second one.
 *   2. Reduced motion does not freeze it, it skips it.
 *   3. The card is not in the document during the intro.
 *   4. The keyframe's fade-out tail never runs.
 *
 * The fourth is the one that would ship. `ast-gate-in` is verbatim from a demo
 * loop and ends by fading the card out so the loop can restart; run to completion
 * in the app it would dissolve the login card four seconds after it arrived, and
 * nothing else in the suite would notice.
 */

const HERE = new URL('.', import.meta.url);
const SEQUENCE = readFileSync(new URL('OpeningSequence.tsx', HERE), 'utf8');
const GATE = readFileSync(new URL('FirstOpenGate.tsx', HERE), 'utf8');
const MODULE = readFileSync(new URL('opening-sequence.ts', HERE), 'utf8');
const LOADERS = partial('astrolabe-loaders.css');

function withoutComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function body(selector: string, css: string = LOADERS) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return withoutComments(css).match(new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`))?.[1] ?? '';
}

describe('the sequence plays once, and not at all for a reader who asked for less', () => {
  it('plays only on a session that has not been through the gate', () => {
    expect(showsOpeningSequence({ acknowledged: false, reducedMotion: false })).toBe(true);
    expect(showsOpeningSequence({ acknowledged: true, reducedMotion: false })).toBe(false);
  });

  it('skips straight to the gate under reduced motion, rather than freezing', () => {
    // `loading-suite.md`: "prefers-reduced-motion skips straight to the gate."
    // Freezing would be the wrong tool for this one surface: it is a full-viewport
    // navy canvas whose entire content is animation, so a frozen copy leaves a
    // reader who asked for no motion looking at a still night sky behind a login
    // card, for no reason they could work out.
    expect(showsOpeningSequence({ acknowledged: false, reducedMotion: true })).toBe(false);
    expect(showsOpeningSequence({ acknowledged: true, reducedMotion: true })).toBe(false);
  });

  it('reads the preference through matchMedia, and fails open without one', () => {
    // No `window` in this run, which is the same branch a server renderer and a
    // browser too old for matchMedia take. It answers "no preference recorded",
    // which is the direction that shows the sequence rather than suppressing it
    // for everybody.
    expect(prefersReducedMotion()).toBe(false);
    expect(MODULE).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
  });

  it('takes the once-per-session answer from the gate rather than keeping its own', () => {
    // The sequence precedes the gate and the gate shows once a session, so the two
    // run on one clock by specification. A second storage key would be a second
    // answer to the same question, and the two would disagree the first time one
    // write failed and the other did not.
    expect(GATE).toContain('acknowledged: firstOpenAcknowledged()');
    expect(MODULE).not.toMatch(/sessionStorage|localStorage|setItem/);
  });
});

describe('the intro hands over to the real gate', () => {
  it('rises at the fraction the keyframe holds the card back for', () => {
    expect(GATE_RISE_FRACTION).toBe(0.6);
    expect(gateRiseMs()).toBe(6000);
    // And the keyframe agrees, which is the pair that could drift. The keyframe is
    // pinned to the design reference by astrolabe-keyframes.test.ts, so if that
    // 60% ever moves this is the assertion that notices.
    const keyframes = withoutComments(partial('astrolabe-animation.css'));
    const gateIn = keyframes.match(/@keyframes ast-gate-in \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(gateIn).toMatch(new RegExp(`${GATE_RISE_FRACTION * 100}%`));
  });

  it('draws no card during the intro, rather than an invisible one', () => {
    // An invisible dialog is still focusable and still read out. The reference
    // renders it at opacity 0 from the first frame because it is a demo loop, and
    // an app that copied that would put a login card nobody can see into the tab
    // order for six seconds.
    expect(GATE).toContain('const card = intro ? null : (');
    expect(withoutComments(SEQUENCE)).not.toContain('FirstOpenPanel');
  });

  it('stops the concepts and the wordmark once the card is up', () => {
    // The sky stays and the middle does not. A concept mark cycling behind a login
    // card would be the app still introducing itself to somebody who is trying to
    // read their own email address.
    expect(SEQUENCE).toContain('{intro ? (');
    expect(SEQUENCE).toContain('ast-opening-centre');
  });

  it('keeps something drawing behind the gate for the whole of its life', () => {
    // `loading-suite.md`, verbatim: "The constellation keeps drawing behind the
    // gate." So the sky is outside the `intro` branch and its own animations are
    // infinite loops.
    const sky = SEQUENCE.indexOf('ast-opening-sky');
    const introBranch = SEQUENCE.indexOf('{intro ? (');
    expect(sky).toBeGreaterThan(0);
    expect(sky).toBeLessThan(introBranch);
    expect(body('.ast-anim-draw')).toMatch(/animation-iteration-count:\s*infinite/);
    /*
     * WHICH drawing it is, is now settled once for the whole gate rather than
     * per stage. The gate mounts `StarField` unconditionally and the opening
     * layer goes ON it, transparent and carrying no field of its own.
     *
     * It used to be a swap: the intro drew `OPENING_CONSTELLATION` on its own
     * navy, and when the intro ended that layer was unmounted and the ambient
     * field mounted in its place, already complete. The reader watched a sky
     * with an undrawn right-hand side become a different, fully drawn sky at
     * the instant the card arrived. Reported as the opening being skewed left
     * with nothing on the right, and then stuttering into the login.
     */
    expect(GATE).toMatch(/<GateSky \/>\s*\{sequence && intro \? <OpeningSequence intro onSky \/> : null\}/);
    expect(GATE, 'the pending stage is on the same sky').toMatch(/<GateSky \/>\s*<OpeningSequence intro=\{intro\} onSky \/>/);
    expect(body('.ast-opening.ast-opening-on-sky')).toMatch(/background:\s*transparent/);
    // And the gate's backdrop goes transparent so the sky shows through it. Opaque
    // Ice is right when the gate is the first thing on screen and wrong here.
    expect(body('.first-open.on-sky')).toMatch(/background:\s*transparent/);
    /*
     * Unconditionally, where this once passed the opening-sequence latch. That
     * made the backdrop transparent only on a session's FIRST open: every open
     * after it drew an opaque card over a sky nobody could see, which is what
     * "no stars on the login screen" was as a report.
     *
     * There is always something drawing back there now -- the intro while it is
     * introducing, the ambient field once the card is readable -- so the card has
     * nothing left to be opaque for.
     */
    expect(GATE).not.toContain('onSky={sequence}');
    expect(GATE).toMatch(/<FirstOpenPanel[\s\S]*?\n\s+onSky\n/);
    // The field is named in one place, because four seatings have to agree on
    // its `pageId` for the drawing to be the same across all of them.
    expect(GATE).toMatch(/function GateSky\(\) \{\s*return <StarField pageId="login-gate"/);
  });

  it('layers the sky under the gate rather than over it', () => {
    // One pair of z-indexes in the app, and the card has to win. The sequence at 60
    // would draw the night sky over the login card.
    expect(body('.ast-opening')).toMatch(/z-index:\s*59/);
    expect(body('.first-open', partial('first-open.css'))).toMatch(/z-index:\s*60/);
  });
});

describe('the rise runs the keyframe without its tail', () => {
  it('starts the animation at its 60% mark with a negative delay', () => {
    expect(gateRiseStyle()).toEqual({ animationDuration: '10s', animationDelay: '-6s' });
  });

  it('gives the class up before the fade-out at 94%', () => {
    // THE CLAIM THIS FILE EXISTS FOR. `ast-gate-in` ends `94% { opacity: 1 } 100%
    // { opacity: 0 }`, which is the demo loop resetting. Started at 60% and left
    // to run, the card would fade out 4s after arriving.
    //
    // The rise is 60% to 68%, so 0.8s. The class is dropped after 1.2s, which
    // covers the rise with half of it again as margin for a late frame, and stops
    // a long way short of 94% -- that would be 3.4s in.
    expect(RISE_SETTLE_MS).toBe(1200);
    const riseEnds = (0.68 - GATE_RISE_FRACTION) * OPENING_SECONDS * 1000;
    const fadeBegins = (0.94 - GATE_RISE_FRACTION) * OPENING_SECONDS * 1000;
    expect(RISE_SETTLE_MS).toBeGreaterThan(riseEnds);
    expect(RISE_SETTLE_MS).toBeLessThan(fadeBegins);
    expect(GATE).toContain('setTimeout(() => setRising(false), RISE_SETTLE_MS)');
  });

  it('leaves the timing to the seating rather than to the animation class', () => {
    // The convention the rest of the suite follows: the same keyframes run at 7s on
    // the splash panel, 5s on the working strip and 10s here, so a duration written
    // into an `ast-anim-*` class would be one of the three being right.
    expect(withoutComments(LOADERS)).not.toMatch(/ast-anim-gate-in\s*\{[^}]*animation-duration/);
    expect(GATE).toContain('style={rise}');
    // The class is still there, which is what puts the card under the
    // reduced-motion guard that matches `[class*='ast-anim-']`.
    expect(GATE).toContain("' ast-anim-gate-in'");
  });
});

describe('the intro is skippable, and stops listening once it is over', () => {
  it('ends on any click or key', () => {
    // `loading-suite.md`: "skippable with any click or key". `pointerdown` rather
    // than `click` so a press registers on the frame it happens, and `capture` so
    // nothing between the canvas and the window can swallow it.
    expect(GATE).toContain("window.addEventListener('pointerdown', arrive, { capture: true })");
    expect(GATE).toContain("window.addEventListener('keydown', arrive, { capture: true })");
  });

  it('removes the listeners when the intro ends rather than when the gate closes', () => {
    // NOT TIDINESS. Past 60% the card is on screen and being read, and a listener
    // still treating a click as a skip would fire on the reader pressing Continue
    // or opening the source link. The effect is keyed on `intro`, so it tears down
    // the moment the intro is false.
    expect(GATE).toContain('if (!intro) return;');
    expect(GATE).toContain("window.removeEventListener('pointerdown', arrive, { capture: true })");
    expect(GATE).toContain('}, [intro]);');
  });

  it('clears its timer, so a dismissed gate cannot be woken by one', () => {
    expect(GATE).toContain('window.clearTimeout(timer)');
  });
});

describe('the centre of the canvas is the four concepts and the name', () => {
  it('cycles the same four marks the loaders do, in the same order', () => {
    // One order, from `FLICKER_ORDER`, and it ends on the d-pad -- so the sequence
    // resolves on the app's identity mark rather than on one of the three concepts
    // it was chosen from. A second list here would be a second order.
    expect(FLICKER_ORDER.at(-1)).toBe('dpad');
    expect(SEQUENCE).toContain('FLICKER_ORDER.map');
    expect(withoutComments(SEQUENCE)).not.toMatch(/\[['"]rete['"]/);
  });

  it('gives each concept its 1.6s turn, offset by the reference lead', () => {
    // The reference's delays are 0.3 / 1.9 / 3.5 / 5.1: the cycle starts three
    // tenths in rather than on the first frame, because the first hop of the
    // constellation starts at 0 and a mark arriving on the same frame reads as one
    // event instead of two.
    expect(CONCEPT_LEAD_SECONDS).toBe(0.3);
    expect(CONCEPT_HOLD_SECONDS).toBe(1.6);
    expect(FLICKER_ORDER.map((_, at) => conceptDelay(at))).toEqual([0.3, 1.9, 3.5, 5.1]);
  });

  it('rounds the delay, so a CSS duration is not sixteen digits long', () => {
    // 0.3 + 3 * 1.6 is 5.100000000000001 in binary floating point, which is a
    // legal `animation-delay` and an illegible one.
    for (const delay of FLICKER_ORDER.map((_, at) => conceptDelay(at))) {
      expect(String(delay).length).toBeLessThan(5);
    }
  });

  it('fits the four turns inside the sequence, with the gate rising after them', () => {
    // 0.3 + 4 * 1.6 is 6.7s of a ten second sequence. The concepts are done before
    // the card has finished rising at 6.8s, which is the handover the wordmark's
    // own window (`ast-hold`, out by 64%) is cut to.
    const cycleEnds = CONCEPT_LEAD_SECONDS + FLICKER_ORDER.length * CONCEPT_HOLD_SECONDS;
    expect(cycleEnds).toBeLessThan(OPENING_SECONDS);
    expect(cycleEnds).toBeGreaterThan(gateRiseMs() / 1000);
  });

  it('draws the marks at 96px on the dark cut', () => {
    // `loading-suite.md`: "96px". `ink="dark"` is the white-on-navy pair, because
    // the canvas is #11171C -- the light cut would be navy on navy.
    expect(CONCEPT_SIZE).toBe(96);
    expect(SEQUENCE).toContain('size={CONCEPT_SIZE}');
    expect(SEQUENCE).toContain('ink="dark"');
    expect(body('.ast-opening-concepts')).toMatch(/width:\s*96px/);
  });

  it('stacks the four in one slot rather than laying them out in a row', () => {
    // Four marks side by side would be a specimen sheet. Each starts at opacity 0
    // and `ast-concept` brings it in, so without the zero all four are drawn on the
    // first frame -- a pile rather than a cycle.
    expect(body('.ast-opening-concepts')).toMatch(/position:\s*relative/);
    expect(body('.ast-opening-concepts > *')).toMatch(/position:\s*absolute/);
    expect(body('.ast-opening-concepts > *')).toMatch(/opacity:\s*0/);
  });

  it('sets the wordmark as type, lowercase, and holds it under the marks', () => {
    // The name is type in the app's own face rather than a file, which is what
    // makes the lockup survive a font change and keeps a logotype out of a
    // repository that publishes publicly. Lowercase in the string rather than by
    // `text-transform`, so a reader who copies it gets what the app is called.
    expect(SEQUENCE).toContain('{WORDMARK}');
    expect(SEQUENCE).toContain('ast-anim-hold');
    expect(body('.ast-opening-wordmark')).toMatch(/font-size:\s*19px/);
    expect(body('.ast-opening-wordmark')).not.toMatch(/text-transform/);
    expect(body('.ast-opening-wordmark')).toMatch(/opacity:\s*0/);
  });
});

describe('the whole layer is decorative', () => {
  it('is aria-hidden, and adds no live region of its own', () => {
    // §5: everything decorative is aria-hidden with ONE `aria-live="polite"` status
    // string per surface. On this surface that one string is the gate's own copy,
    // and a live region announcing an animation would be read out over it.
    expect(SEQUENCE).toContain('aria-hidden="true"');
    expect(withoutComments(SEQUENCE)).not.toMatch(/aria-live|role="status"|role="alert"/);
  });

  it('lets a click through to the gate that arrives over it', () => {
    expect(body('.ast-opening-centre')).toMatch(/pointer-events:\s*none/);
  });

  it('crops the sky rather than distorting it or scrolling to it', () => {
    // A 1180x700 drawing on a viewport of another shape. The SVG asks for
    // `xMidYMid slice`, and the layer hides its overflow so the stars outside a
    // narrow window are cropped instead of reachable by a scrollbar.
    expect(OPENING_CONSTELLATION.width).toBe(1180);
    expect(OPENING_CONSTELLATION.height).toBe(700);
    expect(body('.ast-opening')).toMatch(/overflow:\s*hidden/);
    expect(body('.ast-opening')).toMatch(/position:\s*fixed/);
  });
});
