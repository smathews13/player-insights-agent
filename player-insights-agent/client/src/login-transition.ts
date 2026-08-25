/**
 * The transition out of the login gate and into Ask, as timing and one predicate.
 *
 * Built to `login-transition.md`. Apart from the components for the reason
 * `opening-sequence.ts` is apart from `OpeningSequence.tsx`: this suite has no DOM
 * and no browser, so a phase window expressed as a function is something a test
 * can read and a phase window expressed inline in JSX is not.
 *
 * THE KEYFRAMES ARE NOT IN THE DESIGN REFERENCE, and that is worth stating rather
 * than quietly working around. The spec says to copy `ast-x-click`, `ast-x-card`,
 * `ast-x-star`, `ast-x-sky`, `ast-x-app`, `ast-x-mark` and `ast-x-bar` verbatim
 * from the reference helmet; the reference this repository carries
 * (`docs/design-handoff-astrolabe/Databricks App UI.dc.html`) stops at anchor
 * `#20d`, has no `#21a` and declares none of the seven. So they are written from
 * the phase windows the spec states in milliseconds, which it gives precisely, and
 * they live in first-open.css rather than in astrolabe-animation.css --
 * `astrolabe-keyframes.test.ts` holds that partial equal to the reference value for
 * value, and an eighth animation the reference has never heard of would fail it,
 * correctly. If a newer export lands, replace these against it.
 *
 * WHY THE WINDOWS ARE MILLISECONDS AND NOT PERCENTAGES. The spec's own numbers are
 * production milliseconds ("Click (0-120ms)", "Card exit (120-360ms)") with the
 * note that the review mock loops at 7s and every phase scales proportionally.
 * Production is the thing being built, so production is what is written down, and
 * `MOCK_SECONDS` records the other end of that ratio so a reader comparing the two
 * has both numbers rather than one and a memory.
 */

/** The whole transition, and the point at which the gate stops being rendered. */
export const TRANSITION_MS = 1200;

/**
 * The review mock's loop, for scale only. Nothing here is derived from it.
 *
 * `login-transition.md`: "Production duration: ~1.2s total ... The review mock
 * loops at 7s; scale every phase below proportionally." A percentage read off the
 * mock is this ratio away from a production millisecond, which is the conversion a
 * reader will otherwise do in their head and get wrong once.
 */
export const MOCK_SECONDS = 7;

/**
 * One phase's window, in milliseconds from the click.
 *
 * `from` is the animation's delay and `to - from` is its duration, which is why
 * both ends are recorded rather than a start and a length: the spec states them as
 * windows, several of them overlap, and a duration on its own loses the overlap.
 */
export interface Phase {
  /** The keyframe's name, which is also the class with `ast-anim-` in front. */
  animation: string;
  from: number;
  to: number;
}

/**
 * The six phases, in the order `login-transition.md` lists them.
 *
 * The overlaps are the whole design and are not slack to be tidied out: the stars
 * are already travelling while the card is still sinking, the app surface is
 * already coming up while the sky is still going, and the mark lands into a
 * surface that is most of the way there. Squeezed into a sequence of
 * non-overlapping steps this becomes six things happening one at a time, which is
 * a slideshow rather than a transition.
 */
export const PHASES: readonly Phase[] = [
  { animation: 'ast-x-click', from: 0, to: 120 },
  { animation: 'ast-x-card', from: 120, to: 360 },
  { animation: 'ast-x-star', from: 200, to: 700 },
  { animation: 'ast-x-sky', from: 450, to: 800 },
  { animation: 'ast-x-app', from: 450, to: 800 },
  { animation: 'ast-x-mark', from: 600, to: 1000 },
  { animation: 'ast-x-bar', from: 700, to: 1100 },
];

export function phase(animation: string): Phase {
  const found = PHASES.find((entry) => entry.animation === animation);
  if (!found) throw new Error(`No such transition phase: ${animation}`);
  return found;
}

/**
 * How far one star's start is pushed back, in seconds.
 *
 * `login-transition.md`: "Stagger starts by ~10ms per star in sky order." In sky
 * order rather than by distance, because the sky drew itself in that order and the
 * eye has already followed it once; ordering the exit by distance would unpick a
 * sequence the reader has just watched.
 */
export const STAR_STAGGER_MS = 10;

export function starDelaySeconds(at: number): number {
  return Math.round((phase('ast-x-star').from + at * STAR_STAGGER_MS)) / 1000;
}

/**
 * Where the stars are going, in the opening sky's own coordinates.
 *
 * THE LOCKUP, NEVER THE CENTRE OF THE SCREEN (spec, Rules): "the point of the
 * animation is that the sky becomes the mark". The top bar's lockup sits 24px in
 * and 26px down, which is where the mark lands, and the sky's viewBox is
 * 1180x700 at `xMidYMid slice` -- so on a viewport of another shape the sky is
 * cropped and this point drifts by whatever the crop is. That is accepted rather
 * than solved: the readable claim is "everything converges on one point up in the
 * left corner, and the mark appears there", and it survives the drift. Solving it
 * would mean measuring the header in script on every frame of a 1.2s animation.
 */
export const LOCKUP_POINT = { x: 24, y: 26 } as const;

/** One star's journey to the lockup, as the two custom properties CSS reads. */
export function starTravel(star: { x: number; y: number }): { dx: number; dy: number } {
  return { dx: LOCKUP_POINT.x - star.x, dy: LOCKUP_POINT.y - star.y };
}

/**
 * Where the gate is in its life, which is also what the app is allowed to paint.
 *
 * FOUR STATES BECAUSE `pending` IS NOT `gate`, and the difference is the flicker
 * this module was written for. While the identity read is in flight the app does
 * not yet know what the card will say, and the app shell used to be drawn during
 * exactly that window: the reader got the Ask tab for about a second and then a
 * login gate dropped over it. `pending` is that window, named, with nothing of the
 * app in it.
 */
export type GateStage = 'pending' | 'gate' | 'arriving' | 'open';

/**
 * Whether the app shell may draw at all.
 *
 * NOT DURING `pending`. The gate covers the viewport opaquely once it is up, so
 * `gate` is the stage at which the shell can safely mount behind it -- and it has
 * to, because the spec's landing is explicit that the Ask tab is "already fully
 * rendered under the crossfade: no skeleton, no spinner, no second load". Mounting
 * it at the click instead would put a first paint inside the crossfade, which is
 * exactly the skeleton the spec forbids.
 */
export function drawsAppShell(stage: GateStage): boolean {
  return stage !== 'pending';
}

/** Whether any part of the gate is still on screen. */
export function drawsGate(stage: GateStage): boolean {
  return stage !== 'open';
}

/** Whether the shell is mid-crossfade, which is the only time it carries classes. */
export function isArriving(stage: GateStage): boolean {
  return stage === 'arriving';
}

/**
 * Whether the one sky sits over the shell, covering Ask while the login card is
 * still the thing being read.
 *
 * The card's overlay is transparent so the stars show through it. The shell is
 * already mounted behind that overlay (so Continue does not first-paint Ask
 * inside the fade). Without a covering sky those two facts fight: Ask would be
 * visible through the login. Login used to solve that with a second canvas, and
 * Continue then unmounted it and mounted the in-app one — every line restarted
 * from undrawn and the stars vanished. One `AppSky` now changes only its
 * stacking class: covering through the card, behind the chrome the moment
 * Continue starts the fade. Same element, same seed, same animation clock.
 */
export function skyCoversShell(stage: GateStage): boolean {
  return stage === 'pending' || stage === 'gate';
}

/**
 * Whether the animation runs at all.
 *
 * `login-transition.md`: "Reduced motion (`prefers-reduced-motion: reduce`): no
 * animation, instant cut from gate to Ask." Taken in script rather than left to
 * the stylesheet, because the media query is the wrong tool for this one: the
 * transition is a sequence of layers that only exist to move, and a frozen copy of
 * it would leave a reader who asked for no motion looking at a sunk card over a
 * half-faded sky. Skipping means never entering `arriving`, so nothing on the way
 * to Ask depends on an animation ending.
 */
export function transitionRuns({ reducedMotion }: { reducedMotion: boolean }): boolean {
  return !reducedMotion;
}

/**
 * The stage a click on Continue moves the gate to.
 *
 * One function rather than a conditional at the call site, so the reduced-motion
 * path is a thing a test can state instead of a branch a reader has to trust.
 */
export function stageAfterContinue({ reducedMotion }: { reducedMotion: boolean }): GateStage {
  return transitionRuns({ reducedMotion }) ? 'arriving' : 'open';
}

/**
 * The one thing said out loud on the way in (spec, Keyframes).
 *
 * Every decorative layer is `aria-hidden`, so without this the transition is a
 * second of silence for a reader on a screen reader and then a different page. One
 * `aria-live="polite"` string, announced once: "astrolabe" stays lowercase because
 * it is lowercase everywhere in this product, including at the start of a
 * sentence, and it is not at the start of this one.
 */
export const LANDED_ANNOUNCEMENT = 'Signed in. Ask astrolabe is ready.';
