/**
 * The astrolabe mark, as geometry rather than as a picture.
 *
 * THE RULE THE WHOLE FILE EXISTS TO KEEP IS "NEVER REDRAW, NEVER RESTROKE"
 * (`astrolabe-rebuild-spec.md` §1, and `assets/logo/README.md` in as many words).
 * Every number below is read off the delivered SVG in `assets/logo/`, and
 * `astrolabe-mark.test.ts` reads those same files off disk and fails if one
 * coordinate, radius, stroke width or dash pattern here differs from them. So
 * this is not a second drawing of the mark; it is the delivered drawing, in a
 * form a component can size and ink.
 *
 * WHY NOT JUST `<img src="astrolabe-dpad.svg">`, which would make redrawing
 * impossible by construction. Three seatings the design asks for cannot be had
 * from the two delivered inks:
 *
 *   1. The in-button loader is ALL white -- rim, cross and accent dots -- on the
 *      blue primary button (`loading-suite.md`, Seatings). The `-white` files
 *      keep #6FAEDD on the accents, which disappears on blue.
 *   2. The small cut is a different drawing of the same mark and is not one of
 *      the delivered files: §1 specifies it numerically and nothing ships it.
 *   3. An `<img>` cannot be handed the two inks by CSS, so a mark that has to
 *      survive a repaint of the palette would be eight files instead of one.
 *
 * So the paints are named rather than written: every element says `ink` or
 * `accent`, and `--ast-mark-ink` / `--ast-mark-accent` in astrolabe-mark.css
 * decide what those are for the surface the mark is standing on. That is also
 * what keeps this file out of palette.test.ts's way -- there is no hex here.
 */

/** The four mark concepts. `dpad` is the identity mark; the other three are archive. */
export type MarkConcept = 'dpad' | 'rete' | 'reticle' | 'horizon';

/**
 * Which of the two inks an element takes.
 *
 * `ink` is the mark's structure and `accent` is the blue. What each resolves to
 * is the seating's business: navy and blue on white, white and #6FAEDD on navy,
 * white and white on the blue button.
 */
export type MarkPaint = 'ink' | 'accent';

export type MarkElement =
  | {
      kind: 'circle';
      cx: number;
      cy: number;
      r: number;
      fill?: MarkPaint;
      stroke?: MarkPaint;
      strokeWidth?: number;
      dash?: string;
      opacity?: number;
    }
  | { kind: 'rect'; x: number; y: number; width: number; height: number; rx: number; fill: MarkPaint }
  | {
      kind: 'path';
      d: string;
      fill?: MarkPaint;
      stroke?: MarkPaint;
      strokeWidth?: number;
      round?: boolean;
      opacity?: number;
    }
  | { kind: 'group'; stroke: MarkPaint; strokeWidth: number; opacity: number; children: MarkElement[] };

/** Every mark in this family is drawn on this grid, and none of them may leave it. */
export const MARK_VIEWBOX = 64;

/**
 * The identity mark, from `assets/logo/astrolabe-dpad.svg`.
 *
 * Ring, graduated reticle ring, d-pad cross, blue centre, four quadrant dots
 * (`#16d`). The graduation ring is the second circle: a 1.3-wide dashed stroke
 * whose `1.7 5.05` pattern is what makes it read as graduations rather than as a
 * dotted line, and it is the first thing the small cut drops.
 */
const DPAD: MarkElement[] = [
  { kind: 'circle', cx: 32, cy: 32, r: 27, stroke: 'ink', strokeWidth: 3.5 },
  { kind: 'circle', cx: 32, cy: 32, r: 21.5, stroke: 'ink', strokeWidth: 1.3, dash: '1.7 5.05', opacity: 0.7 },
  { kind: 'rect', x: 28.5, y: 17, width: 7, height: 30, rx: 3.5, fill: 'ink' },
  { kind: 'rect', x: 17, y: 28.5, width: 30, height: 7, rx: 3.5, fill: 'ink' },
  { kind: 'circle', cx: 32, cy: 32, r: 4.5, fill: 'accent' },
  { kind: 'circle', cx: 41.5, cy: 22.5, r: 3, fill: 'accent' },
  { kind: 'circle', cx: 41.5, cy: 41.5, r: 3, fill: 'accent' },
  { kind: 'circle', cx: 22.5, cy: 41.5, r: 3, fill: 'accent' },
  { kind: 'circle', cx: 22.5, cy: 22.5, r: 3, fill: 'accent' },
];

/** From `assets/logo/astrolabe-rete.svg`. Archive concept; the flicker seats it. */
const RETE: MarkElement[] = [
  { kind: 'circle', cx: 32, cy: 32, r: 27, stroke: 'ink', strokeWidth: 3.5 },
  { kind: 'circle', cx: 32, cy: 32, r: 22.5, stroke: 'ink', strokeWidth: 1.1, dash: '1.5 5.55', opacity: 0.5 },
  {
    kind: 'group',
    stroke: 'ink',
    strokeWidth: 1.4,
    opacity: 0.5,
    children: [
      { kind: 'path', d: 'M32 32 19 20' },
      { kind: 'path', d: 'M32 32 45 23' },
      { kind: 'path', d: 'M32 32 24 44' },
      { kind: 'path', d: 'M32 32 43 42' },
      { kind: 'path', d: 'M19 20 45 23' },
      { kind: 'path', d: 'M24 44 43 42' },
    ],
  },
  { kind: 'circle', cx: 19, cy: 20, r: 4, fill: 'accent' },
  { kind: 'circle', cx: 45, cy: 23, r: 4, fill: 'accent' },
  { kind: 'circle', cx: 24, cy: 44, r: 4, fill: 'accent' },
  { kind: 'circle', cx: 43, cy: 42, r: 4, fill: 'accent' },
  { kind: 'circle', cx: 32, cy: 32, r: 4, fill: 'ink' },
];

/** From `assets/logo/astrolabe-reticle.svg`. */
const RETICLE: MarkElement[] = [
  { kind: 'circle', cx: 32, cy: 32, r: 27, stroke: 'ink', strokeWidth: 3.5 },
  { kind: 'circle', cx: 32, cy: 32, r: 21, stroke: 'ink', strokeWidth: 1.5, dash: '1.8 6.45', opacity: 0.7 },
  { kind: 'path', d: 'M32 2v10', stroke: 'accent', strokeWidth: 4, round: true },
  { kind: 'path', d: 'M52 32h7M32 52v7M12 32H5', stroke: 'ink', strokeWidth: 3, round: true },
  { kind: 'circle', cx: 32, cy: 32, r: 4, fill: 'accent' },
  { kind: 'circle', cx: 41, cy: 23, r: 2.5, fill: 'ink' },
];

/** From `assets/logo/astrolabe-horizon.svg`. */
const HORIZON: MarkElement[] = [
  { kind: 'circle', cx: 32, cy: 32, r: 27, stroke: 'ink', strokeWidth: 3.5 },
  { kind: 'path', d: 'M8 40q24-10 48 0', stroke: 'ink', strokeWidth: 3, round: true },
  { kind: 'path', d: 'M14 31q18-7 36 0', stroke: 'ink', strokeWidth: 2, round: true, opacity: 0.55 },
  { kind: 'path', d: 'M44 24l2.6 5.9 5.9 2.6-5.9 2.6-2.6 5.9-2.6-5.9-5.9-2.6 5.9-2.6z', fill: 'accent' },
];

export const MARK_CONCEPTS: Readonly<Record<MarkConcept, readonly MarkElement[]>> = {
  dpad: DPAD,
  rete: RETE,
  reticle: RETICLE,
  horizon: HORIZON,
};

/**
 * The small cut, for 13-30px seatings: chips, the top bar's lockup, the gate's.
 *
 * NOT ONE OF THE DELIVERED FILES, and specified numerically instead, in
 * `astrolabe-rebuild-spec.md` §1: "drop the graduation ring; bold rim (6/64
 * viewBox units), cross rects 9x34 rx4.5, blue center r5.5, quadrant dots r3.5.
 * No graduation below 32px."
 *
 * The cross rects are the spec's 9 by 34 centred on the grid, so 32 - 4.5 = 27.5
 * across and 32 - 17 = 15 down; the centre, the four dots and both rects are the
 * design reference's `#16e` to the decimal. THE RIM IS THE ONE NUMBER WHERE THIS
 * FILE AND THE REFERENCE DISAGREE: §1 says 6 and `#16e` draws 4, while `#19a`
 * draws the same lockup at 5. The reference contradicts itself between two 22px
 * seatings of one mark and the spec does not, so the spec's number is the one
 * taken -- and "bold rim" is the phrase §1 uses for exactly this difference from
 * the full mark's 3.5. A stroke of 6 at r27 reaches 30 of the 32 available, so
 * the drawing still clears the grid.
 */
export const SMALL_CUT: readonly MarkElement[] = [
  { kind: 'circle', cx: 32, cy: 32, r: 27, stroke: 'ink', strokeWidth: 6 },
  { kind: 'rect', x: 27.5, y: 15, width: 9, height: 34, rx: 4.5, fill: 'ink' },
  { kind: 'rect', x: 15, y: 27.5, width: 34, height: 9, rx: 4.5, fill: 'ink' },
  { kind: 'circle', cx: 32, cy: 32, r: 5.5, fill: 'accent' },
  { kind: 'circle', cx: 41.5, cy: 22.5, r: 3.5, fill: 'accent' },
  { kind: 'circle', cx: 41.5, cy: 41.5, r: 3.5, fill: 'accent' },
  { kind: 'circle', cx: 22.5, cy: 41.5, r: 3.5, fill: 'accent' },
  { kind: 'circle', cx: 22.5, cy: 22.5, r: 3.5, fill: 'accent' },
];

/**
 * The size at or above which the graduation ring is drawn.
 *
 * §1: "No graduation below 32px". A 1.3-wide dash on a 64 grid is a third of a
 * device pixel at 16px, which renders as a grey smudge around the rim rather
 * than as graduations -- so the small cut is not a simplification for its own
 * sake, it is the drawing that survives being small.
 */
export const GRADUATION_FLOOR = 32;

/** Which drawing a seating gets, decided by its size and nothing else. */
export function markElements(size: number, concept: MarkConcept = 'dpad'): readonly MarkElement[] {
  if (concept !== 'dpad') return MARK_CONCEPTS[concept];
  return size >= GRADUATION_FLOOR ? DPAD : SMALL_CUT;
}

/* -------------------------------------------------------------------------- */
/* The lockup                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The two lockups, as PAIRS.
 *
 * §1: "mark at cap height x1.4, 8-9px gap. Top bar: 22px + 15px. Dark bands:
 * 26px + 17px." A pair rather than two numbers a caller supplies, because a 22px
 * mark beside a 17px wordmark is neither of the two lockups the design has, and
 * an API that can express it will eventually be asked to.
 *
 * Here rather than beside the component so that AstrolabeMark.tsx exports
 * components and nothing else, which is what lets a fast refresh replace it in
 * place.
 */
export const LOCKUP_SIZES = {
  bar: { mark: 22, wordmark: 15 },
  band: { mark: 26, wordmark: 17 },
  /* The login gate's, which `login-gate.md` states separately: "Astrolabe lockup
     (26px mark + 'astrolabe' 20px/700, -0.01em)". It is a light surface rather
     than a dark band, and it is the one place the lockup is the heading of a
     card rather than a corner of a frame, so it carries the band's mark at a
     larger wordmark. Its own spec names it; this file does not invent it. */
  gate: { mark: 26, wordmark: 20 },
} as const;

export type LockupSeat = keyof typeof LOCKUP_SIZES;

/**
 * The name, lowercase, everywhere it is set as a lockup, header or title.
 *
 * §1: "Renders lowercase in lockups, headers, titles; prose stays normally
 * capitalized." Lowercased in the string rather than by `text-transform`, so a
 * reader who copies it out of the page gets what the app is called rather than
 * what CSS made of it.
 */
export const WORDMARK = 'astrolabe';

/* -------------------------------------------------------------------------- */
/* The concept flicker                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The four concepts in the order they take the slot, and the delay each waits.
 *
 * `loading-suite.md` (`#17a`): one stacked slot, 0.8s a mark, 3.2s cycle,
 * delays 0 / 0.8 / 1.6 / 2.4. The order is the reference's, which is the order
 * the concepts were drawn in and ends on the d-pad -- so the cycle resolves on
 * the identity mark rather than on an archive one.
 */
export const FLICKER_ORDER: readonly MarkConcept[] = ['rete', 'reticle', 'horizon', 'dpad'];

/** The whole cycle, in seconds. One mark per quarter of it. */
export const FLICKER_CYCLE_SECONDS = 3.2;

/**
 * When each concept's turn begins, in seconds.
 *
 * Rounded to the hundredth because the result is a CSS duration and binary
 * floating point does not give 2.4 for three eighty-hundredths: the unrounded
 * expression is 2.4000000000000004, which is a legal `animation-delay` and an
 * illegible one.
 */
export function flickerDelay(concept: MarkConcept): number {
  const step = FLICKER_CYCLE_SECONDS / FLICKER_ORDER.length;
  return Math.round(FLICKER_ORDER.indexOf(concept) * step * 100) / 100;
}

/**
 * The concept a frozen slot shows.
 *
 * `prefers-reduced-motion: reduce` hides every child of a flicker slot except
 * the one carrying `data-ast-rest`, because CSS cannot choose which of four
 * stacked marks the still frame should be (see the guard at the foot of
 * astrolabe-animation.css). It is the d-pad, because a reader who has asked for
 * no motion should be looking at the app's mark rather than at an archive
 * concept they will never see again.
 */
export const FLICKER_REST: MarkConcept = 'dpad';

/**
 * Where a flicker slot is seated, and how big the mark is there.
 *
 * The `loading-suite.md` seatings, as data rather than as numbers typed into
 * that many components: the splash's 72px, the inline row's 20px, the 14px
 * inside the blue primary button, and the 18px on a navy strip.
 *
 * `status` is the agent path's own foot -- the ringed slot beside "Step 07 ·
 * Preparing the findings" -- and it is the one seating `loading-suite.md` does
 * not name, because the band outliving its run is later than that document. Its
 * 11px IS NOT AN INVENTED SIZE: `.ast-sky-status-mark svg` has painted that slot
 * at 11px since the band was drawn, and the static mark it stands in for asks
 * for the same 11. A seat's number has to be the number it is painted at, or the
 * seat gets a cut of the mark drawn for one size stretched to another.
 */
export type FlickerSeat = 'splash' | 'inline' | 'button' | 'strip' | 'status';

export const FLICKER_SIZES: Readonly<Record<FlickerSeat, number>> = {
  splash: 72,
  inline: 20,
  button: 14,
  strip: 18,
  status: 11,
};
