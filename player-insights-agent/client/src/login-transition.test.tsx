/**
 * The transition out of the login gate, and the flicker it was written beside.
 *
 * TWO CLAIMS, AND ONLY ONE OF THEM IS ABOUT AN ANIMATION.
 *
 * The first is the flicker, and it is fully testable here: on a cold open the app
 * used to draw its header, its tabs and the Ask tab for however long
 * `/api/identity` took, and then a full-viewport login gate landed over the lot.
 * This run has no DOM and no effects, so `renderToStaticMarkup` of the layout is
 * EXACTLY the first paint of a cold open -- the identity read has not come back,
 * because it has not been made. That makes the regression a one-line assertion
 * rather than something only a human with a stopwatch could see.
 *
 * The second is the animation, and NOTHING HERE VERIFIES THAT IT LOOKS RIGHT. No
 * browser is available to this repository and none is launched. What is asserted is
 * that each phase the spec names exists, is seated on the element the spec puts it
 * on, and is skipped under `prefers-reduced-motion`. Whether the stars actually
 * converge on the lockup is a thing a person has to look at; see the note at the
 * foot of this file.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

import { Layout } from './Layout';
import { OPENING_CONSTELLATION } from './constellation';
import { acknowledgeFirstOpen, forgetFirstOpen } from './first-open';
import { partial } from './styles/stylesheet';
import {
  LANDED_ANNOUNCEMENT,
  LOCKUP_POINT,
  MOCK_SECONDS,
  PHASES,
  STAR_STAGGER_MS,
  TRANSITION_MS,
  drawsAppShell,
  drawsGate,
  isArriving,
  phase,
  stageAfterContinue,
  starDelaySeconds,
  starTravel,
  transitionRuns,
} from './login-transition';

const CSS = partial('first-open.css');
const GATE = readFileSync(new URL('./FirstOpenGate.tsx', import.meta.url), 'utf8');
const LAYOUT = readFileSync(new URL('./Layout.tsx', import.meta.url), 'utf8');
const FIELD = readFileSync(new URL('./ConstellationField.tsx', import.meta.url), 'utf8');

/** Comments stripped, so prose about a class is not read as the class. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
}

/** One phase's rule body, and nothing after it. */
function ruleFor(animation: string): string {
  const selector = `.ast-anim-${animation.replace('ast-', '')} {`;
  const at = code(CSS).indexOf(selector);
  expect(at, selector).toBeGreaterThan(-1);
  return code(CSS).slice(at, code(CSS).indexOf('}', at));
}

/** The app's very first paint, with the identity read still in flight. */
function coldOpen(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Layout />
    </MemoryRouter>
  );
}

describe('the flicker: nothing of the app is drawn before the gate decision', () => {
  beforeEach(forgetFirstOpen);

  it('draws no header, no navigation and no page on the first paint', () => {
    const markup = coldOpen();
    // The three things the reader used to see and then lose. Each is asserted by
    // the mark it cannot be drawn without, rather than by a word that might move.
    expect(markup).not.toContain('app-header');
    expect(markup).not.toContain('app-nav-tab');
    expect(markup).not.toContain('data-testid="role-badge"');
    expect(markup).not.toContain('identity-chip');
    expect(markup).not.toContain('identity-avatar');
  });

  it('draws an opaque backdrop instead, from the first frame', () => {
    // Not "renders nothing", which is what it used to do and is the whole defect:
    // with nothing drawn, the app behind it was the thing on screen.
    const markup = coldOpen();
    expect(markup).toMatch(/ast-opening|first-open-hold/);
  });

  it('holds the card back until there is something true to put on it', () => {
    // The backdrop is up but the card is not, because the address and the scope
    // verdicts are what the pending request carries. A card that appeared and then
    // corrected itself is worse than one that appeared a beat late.
    const markup = coldOpen();
    expect(markup).not.toContain('You are signing in as');
    expect(markup).not.toContain('role="dialog"');
  });

  it('draws the shell once the reader is through the gate', () => {
    // The other end of the same claim, and the reason the assertions above are not
    // simply "the layout renders nothing": an acknowledged session gets the app.
    acknowledgeFirstOpen(null);
    const markup = coldOpen();
    expect(markup).toContain('app-header');
    expect(markup).toContain('app-nav-tab');
  });

  it('states the permission as a function rather than inline in the layout', () => {
    // So the stage that withholds it is a thing a test can name. The layout asks
    // and returns early; it does not re-derive the answer.
    expect(code(LAYOUT)).toContain('if (!drawsAppShell(firstOpen.stage)) return');
    expect(drawsAppShell('pending')).toBe(false);
    for (const stage of ['gate', 'arriving', 'open'] as const) {
      expect(drawsAppShell(stage), stage).toBe(true);
    }
  });

  /*
   * WHY THE SHELL IS BEHIND THE GATE RATHER THAN UNMOUNTED UNTIL CONTINUE. The
   * landing is explicit: the Ask tab is already fully rendered under the
   * crossfade -- top bar, hero chip, headline and the composer now seated directly
   * beneath it. The suggestion cards named by the earlier spec no longer exist;
   * removing them does not relax the real requirement here: no skeleton, no
   * spinner and no second load. Mounting the page at the click would put a first
   * paint inside the crossfade, which is the skeleton it forbids.
   */
  it('lets the app mount behind the gate once the gate is up', () => {
    expect(drawsAppShell('gate')).toBe(true);
    expect(drawsGate('gate')).toBe(true);
  });
});

describe('Continue advances to the app', () => {
  beforeEach(forgetFirstOpen);

  it('ends with the gate gone and the app drawing', () => {
    expect(drawsGate('open')).toBe(false);
    expect(drawsAppShell('open')).toBe(true);
    expect(isArriving('open')).toBe(false);
  });

  it('crossfades on the way there, with the app already rendered under it', () => {
    expect(drawsAppShell('arriving')).toBe(true);
    expect(drawsGate('arriving')).toBe(true);
    expect(isArriving('arriving')).toBe(true);
  });

  it('files the outcome before it starts the animation', () => {
    // Order, not tidiness: the latch is what makes a reload during the 1.2s land on
    // the app rather than on the gate a second time.
    expect(code(GATE)).toMatch(/record\(\);\s*if \(animates\) setLeaving\(true\);\s*else setDismissed\(true\);/);
  });

  it('unmounts the gate when the transition is over and not before', () => {
    expect(code(GATE)).toContain('window.setTimeout(land, TRANSITION_MS)');
    expect(TRANSITION_MS).toBe(1200);
  });

  /* "The animation never blocks input: a click anywhere during it cuts to the
     landed state" (spec, Rules). */
  it('can be cut short by a click or a key', () => {
    const leaving = code(GATE).slice(code(GATE).indexOf('const land ='));
    expect(leaving).toContain("window.addEventListener('pointerdown', land, { capture: true })");
    expect(leaving).toContain("window.addEventListener('keydown', land, { capture: true })");
    // And the listeners go with the phase. The app is live underneath by now, so a
    // listener that outlived the transition would eat the reader's first real click.
    expect(leaving).toContain("window.removeEventListener('pointerdown', land, { capture: true })");
  });
});

describe('reduced motion cuts straight to Ask', () => {
  it('does not enter the animating stage at all', () => {
    // `login-transition.md`: "Reduced motion: no animation, instant cut from gate to
    // Ask." Skipped in script rather than frozen in CSS, because a frozen copy of
    // this sequence is a sunk card over a half-faded sky.
    expect(transitionRuns({ reducedMotion: true })).toBe(false);
    expect(stageAfterContinue({ reducedMotion: true })).toBe('open');
    expect(stageAfterContinue({ reducedMotion: false })).toBe('arriving');
  });

  it('still gets the reader to the app, which is the part that must not be optional', () => {
    // The failure mode worth naming: an accessibility path that skips the animation
    // and the arrival with it, leaving a reader who asked for no motion on a gate
    // that will not close.
    expect(drawsAppShell(stageAfterContinue({ reducedMotion: true }))).toBe(true);
    expect(drawsGate(stageAfterContinue({ reducedMotion: true }))).toBe(false);
  });

  it('reads the preference once, on mount, rather than per render', () => {
    expect(code(GATE)).toContain('useState(() => transitionRuns({ reducedMotion: prefersReducedMotion() }))');
  });

  it('declares every phase only where motion is allowed', () => {
    // Belt and braces with the script path above. The declarations sit inside a
    // `no-preference` query, so under `reduce` these elements carry no animation at
    // all rather than carrying one that has been turned off -- which is the state
    // that leaves a layer stuck in an invisible first frame.
    const allowed = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: no-preference)'));
    for (const { animation } of PHASES) {
      expect(allowed, animation).toContain(`animation-name: ${animation}`);
    }
    const guarded = code(CSS).split('@media (prefers-reduced-motion: no-preference)');
    expect(guarded[0]).not.toMatch(/animation-name:\s*ast-x-/);
  });

  it('leaves the still frame of the holding backdrop to the mark the app already has', () => {
    // The holding frame is the app's four-glyph slot, which the reduced-motion guard
    // in astrolabe-animation.css already resolves to the single d-pad. A second
    // implementation of that cycling would be a second thing to keep in step.
    expect(code(GATE)).toContain('<ConceptFlicker seat="splash"');
  });
});

describe('the six phases the spec names', () => {
  it('has all seven keyframes, in the partial that may carry them', () => {
    // NOT astrolabe-animation.css: `astrolabe-keyframes.test.ts` holds that partial
    // equal to the design reference value for value, and these seven are not in the
    // reference -- it stops at anchor 20d and has no 21a. They are written from the
    // spec's own millisecond windows instead, which is recorded in
    // `login-transition.ts` so nobody has to rediscover it.
    for (const { animation } of PHASES) {
      expect(CSS, animation).toContain(`@keyframes ${animation}`);
    }
  });

  it('runs the windows the spec states, in production milliseconds', () => {
    expect(PHASES.map(({ animation, from, to }) => [animation, from, to])).toEqual([
      ['ast-x-click', 0, 120],
      ['ast-x-card', 120, 360],
      ['ast-x-star', 200, 700],
      ['ast-x-sky', 450, 800],
      ['ast-x-app', 450, 800],
      ['ast-x-mark', 600, 1000],
      ['ast-x-bar', 700, 1100],
    ]);
    // Every phase finishes inside the transition, or the gate unmounts mid-animation.
    for (const { animation, to } of PHASES) expect(to, animation).toBeLessThanOrEqual(TRANSITION_MS);
  });

  it('spends each window as a delay and a duration in the stylesheet', () => {
    // The window is the source and the two CSS numbers are derived from it, so a
    // phase cannot be moved in one place and left behind in the other. Bounded to
    // the one rule, or a duration further down the file would answer for a rule
    // that has none.
    for (const { animation, from, to } of PHASES) {
      const rule = ruleFor(animation);
      expect(rule, animation).toContain(`animation-duration: ${to - from}ms`);
      // Every phase but the stars': theirs is per star and staggered, so it is set
      // on the element in `ConstellationField` and asserted below.
      if (from > 0 && animation !== 'ast-x-star') {
        expect(rule, animation).toContain(`animation-delay: ${from}ms`);
      } else {
        expect(rule, animation).not.toContain('animation-delay');
      }
    }
  });

  it('records the mock loop it was scaled from, without deriving anything from it', () => {
    // The spec gives production milliseconds and notes that the review mock loops at
    // 7s. Both numbers are written down so the next reader comparing the two has the
    // ratio rather than a memory of it.
    expect(MOCK_SECONDS).toBe(7);
  });

  it('seats each phase on the element the spec puts it on', () => {
    const gate = code(GATE);
    const layout = code(LAYOUT);
    // The button dips, the card sinks: both the gate's.
    expect(gate).toContain("' ast-anim-x-click'");
    expect(gate).toContain("' ast-anim-x-card'");
    // The app surface, the lockup and the progress line: all three the shell's,
    // which is why the gate is a hook rather than a self-contained component.
    expect(layout).toContain("' ast-anim-x-app'");
    expect(layout).toContain("'ast-anim-x-mark'");
    expect(layout).toContain('ast-anim-x-bar');
    // The sky, and the stars inside it.
    expect(code(FIELD)).toContain("className=\"ast-anim-x-star\"");
  });

  it('names them through the prefix the app-wide freeze covers', () => {
    // The guard at the foot of astrolabe-animation.css matches [class*='ast-anim-'],
    // so a class named to the convention is covered the day it is written.
    for (const { animation } of PHASES) {
      expect(CSS, animation).toContain(`.ast-anim-${animation.replace('ast-', '')} {`);
    }
  });

  it('eases out and nothing else', () => {
    // Spec, Rules: "No orange, no easing bounces; ease-out only."
    const allowed = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: no-preference)'));
    const timings = [...allowed.matchAll(/animation-timing-function:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(timings.length).toBe(PHASES.length);
    expect([...new Set(timings)]).toEqual(['ease-out']);
  });
});

describe('the stars converge on the lockup, not on the middle of the screen', () => {
  it('gives every star its own vector to the lockup point', () => {
    // Spec, Rules: "The stars converge to the lockup, never to center screen; the
    // point of the animation is that the sky becomes the mark." Twenty-two stars
    // means twenty-two vectors, which is why the keyframe reads two custom
    // properties instead of there being twenty-two keyframes.
    const travels = OPENING_CONSTELLATION.stars.map(starTravel);
    expect(travels).toHaveLength(OPENING_CONSTELLATION.stars.length);
    for (const [at, star] of OPENING_CONSTELLATION.stars.entries()) {
      expect(travels[at]).toEqual({ dx: LOCKUP_POINT.x - star.x, dy: LOCKUP_POINT.y - star.y });
    }
    // Up and to the left, from everywhere: no star in this sky is above or left of
    // the lockup, so every vector is negative in both axes.
    for (const { dx, dy } of travels) {
      expect(dx).toBeLessThan(0);
      expect(dy).toBeLessThan(0);
    }
    expect(CSS).toContain('translate(var(--dx, 0), var(--dy, 0)) scale(0.3)');
  });

  it('staggers the starts by about ten milliseconds, in sky order', () => {
    expect(STAR_STAGGER_MS).toBe(10);
    expect(starDelaySeconds(0)).toBe(phase('ast-x-star').from / 1000);
    expect(starDelaySeconds(1)).toBe(0.21);
    expect(starDelaySeconds(21)).toBe(0.41);
    // The last star still has its full 500ms inside the transition.
    const last = starDelaySeconds(OPENING_CONSTELLATION.stars.length - 1) * 1000;
    expect(last + (phase('ast-x-star').to - phase('ast-x-star').from)).toBeLessThanOrEqual(TRANSITION_MS);
  });

  it('leaves the connectors where they are, to fade with the sky', () => {
    // Spec, phase 3: "Connector lines do not travel; they fade with the sky." So the
    // travel is passed per star and the fade is one class on the whole layer.
    const field = code(FIELD);
    const lines = field.slice(field.indexOf('ast-constellation-lines'), field.indexOf('shape.stars.map'));
    expect(lines).not.toContain('ast-anim-x-star');
  });

  it('adds the travel around the pop rather than on top of it', () => {
    // `animation-delay` is one list per element, so a travel delay written beside
    // the pop's would replace it and the star would pop as it left.
    expect(code(FIELD)).toContain('if (!exit) return pop;');
  });
});

describe('what the transition says out loud', () => {
  it('announces one status change, in the app\u2019s own lowercase', () => {
    expect(LANDED_ANNOUNCEMENT).toBe('Signed in. Ask astrolabe is ready.');
    // Lowercase everywhere, including at the start of a sentence; this one is not at
    // the start of one, but the rule is why it is not capitalised here either.
    expect(LANDED_ANNOUNCEMENT).not.toContain('Astrolabe');
    // No em dashes in anything a reader reads.
    expect(LANDED_ANNOUNCEMENT).not.toContain('\u2014');
  });

  it('puts it in a polite live region and hides every decorative layer', () => {
    const layout = code(LAYOUT);
    expect(layout).toContain('aria-live="polite"');
    expect(layout.match(/aria-live=/g)).toHaveLength(1);
    // The progress line is decoration, and the only loading signal in the sequence.
    expect(layout).toMatch(/ast-anim-x-bar[^>]*aria-hidden="true"/);
  });
});

/*
 * WHAT NOBODY HAS SEEN, and it has to be said here rather than only in a handover
 * note: no assertion in this file has watched the animation run. This repository
 * launches no browser, so the 1.2s sequence is verified as structure and timing
 * only. A person on the deployed app should watch a cold open in a fresh private
 * window and check four things: that the app is never visible before the gate,
 * that the stars travel up to the top-left lockup rather than to the middle of the
 * screen, that the Ask tab is complete the moment the sky clears with no skeleton
 * behind the crossfade, and that with "reduce motion" set in the OS the gate cuts
 * straight to Ask with nothing animating.
 */
