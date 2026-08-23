/**
 * The constellations, as coordinates.
 *
 * `loading-suite.md` and the design reference give three of them -- the splash's
 * five hops (`#5ar`), the working strip's three (`#5br`) and the opening
 * sequence's five separate patterns (`#19a`) -- and every number here is
 * transcribed from that reference rather than composed. They are drawings, and
 * a constellation with its hops re-spaced by eye is a different drawing.
 *
 * WHY DATA RATHER THAN JSX. Three reasons, and the third is the one that pays:
 *
 *   1. The stagger is arithmetic on the hop's position in its chain, and a
 *      stagger typed per element is a stagger that goes wrong on the day a hop
 *      is inserted.
 *   2. Three surfaces draw these and one renderer serves all three, so a star
 *      pops the same way in the splash, the working strip and the opening.
 *   3. A test can read it. `constellation.test.ts` checks that every hop lands on
 *      a star, that no star is unreachable, and that nothing is drawn outside the
 *      panel it is drawn in -- none of which is visible in JSX and all of which
 *      is the kind of thing that ships.
 *
 * COLOUR IS NOT HERE. Each star names an `ink` or an `accent`, resolved by
 * astrolabe-loaders.css, for the same reason the mark's geometry names them: a
 * hex in a component is a colour no palette check can reach.
 */

/**
 * The game glyphs the constellation theme draws its stars as (`#16f`), plus the
 * two product icons the loaders seat.
 *
 * The product icons are the RECOLOURED copies in `assets/logo/theme/`, never the
 * full-colour marks: §2 permits exactly two full-colour Databricks assets in the
 * product and neither of them is a star in a night sky.
 */
export type StarGlyph =
  | 'dot'
  | 'cross'
  | 'circle'
  | 'square'
  | 'triangle'
  | 'dpad'
  | 'sparkle'
  | 'genie'
  | 'unity-catalog'
  | 'mosaic-ai'
  | 'databricks-sql';

/** The glyphs that are a Databricks product rather than a game button. */
export const PRODUCT_GLYPHS: readonly StarGlyph[] = ['genie', 'unity-catalog', 'mosaic-ai', 'databricks-sql'];

export interface Star {
  x: number;
  y: number;
  glyph: StarGlyph;
  /** When it pops, in seconds from the loop's start. */
  delay: number;
  /**
   * Half the glyph's drawn width. The reference draws the same glyph at two
   * sizes -- 5 in the 520px splash, 4 in the 56px strip -- because a strip 56px
   * tall cannot carry the splash's stars without them touching its edges.
   */
  size: number;
  /** Dots in the background of a wide panel are dimmer than dots on a chain. */
  opacity?: number;
}

export interface Hop {
  from: readonly [number, number];
  to: readonly [number, number];
  /** When the line starts drawing, in seconds from the loop's start. */
  delay: number;
}

export interface Constellation {
  /** The panel's own coordinate system, which is also its pixel size. */
  width: number;
  height: number;
  /** One full cycle, in seconds. Every delay below is inside it. */
  loopSeconds: number;
  /**
   * How visible a lit connector is. `loading-suite.md`: 0.55 while animating
   * against the static theme's 0.2, "because the line is the progress signal".
   */
  lineOpacity: number;
  hops: readonly Hop[];
  stars: readonly Star[];
  /**
   * The sky behind the constellation: fixed, unanimated, dim. Not stars in the
   * chain -- they never pop and nothing connects to them -- and the panel reads
   * as a night sky rather than as a diagram because of them.
   */
  backdrop: readonly { x: number; y: number; opacity: number }[];
}

/**
 * The splash's five hops (`#5ar`).
 *
 * 520x220 navy panel, 7s loop, 0.8s a hop: dot, cross, Genie, square, Unity
 * Catalog, sparkle. The two product icons are the point of the chain rather than
 * decoration in it -- they are the two things the agent actually calls.
 */
export const SPLASH_CONSTELLATION: Constellation = {
  width: 520,
  height: 220,
  loopSeconds: 7,
  lineOpacity: 0.55,
  hops: [
    { from: [60, 120], to: [150, 60], delay: 0 },
    { from: [150, 60], to: [250, 130], delay: 0.8 },
    { from: [250, 130], to: [340, 70], delay: 1.6 },
    { from: [340, 70], to: [420, 140], delay: 2.4 },
    { from: [420, 140], to: [480, 80], delay: 3.2 },
  ],
  stars: [
    { x: 60, y: 120, glyph: 'dot', delay: 0, size: 2 },
    { x: 150, y: 60, glyph: 'cross', delay: 0.8, size: 5 },
    { x: 250, y: 130, glyph: 'genie', delay: 1.6, size: 7 },
    { x: 340, y: 70, glyph: 'square', delay: 2.4, size: 5 },
    { x: 420, y: 140, glyph: 'unity-catalog', delay: 3.2, size: 7 },
    { x: 480, y: 80, glyph: 'sparkle', delay: 4, size: 8 },
  ],
  backdrop: [
    { x: 110, y: 40, opacity: 0.35 },
    { x: 210, y: 30, opacity: 0.3 },
    { x: 300, y: 185, opacity: 0.35 },
    { x: 390, y: 25, opacity: 0.3 },
    { x: 470, y: 180, opacity: 0.3 },
    { x: 70, y: 185, opacity: 0.3 },
  ],
};

/**
 * The working card's three hops (`#5br`).
 *
 * A 56px strip, 5s loop, 0.7s a hop, and everything sits in the right two thirds
 * because the left of the strip carries the flicker mark and the elapsed count.
 */
export const CARD_CONSTELLATION: Constellation = {
  width: 568,
  height: 56,
  loopSeconds: 5,
  lineOpacity: 0.5,
  hops: [
    { from: [300, 30], to: [365, 16], delay: 0 },
    { from: [365, 16], to: [430, 38], delay: 0.7 },
    { from: [430, 38], to: [495, 20], delay: 1.4 },
  ],
  stars: [
    { x: 300, y: 30, glyph: 'dot', delay: 0, size: 2 },
    { x: 365, y: 16, glyph: 'cross', delay: 0.7, size: 4 },
    { x: 430, y: 38, glyph: 'genie', delay: 1.4, size: 6 },
    { x: 495, y: 20, glyph: 'sparkle', delay: 2.1, size: 7 },
  ],
  backdrop: [
    { x: 335, y: 44, opacity: 0.35 },
    { x: 465, y: 45, opacity: 0.3 },
    { x: 540, y: 30, opacity: 0.35 },
  ],
};

/**
 * The opening sequence's sky (`#19a`).
 *
 * FIVE SEPARATE PATTERNS, not one chain, and that is what makes it a sky rather
 * than a diagram: a seven-hop loop upper left, a four-hop zigzag upper right, a
 * closed triangle with a spur lower left, a three-hop run lower right, and one
 * short pair in the middle right. They start at different times and none of them
 * connects to another.
 *
 * The middle of the canvas is deliberately empty of chains. The concepts cycle
 * there, the wordmark sits under them, and the gate rises over both.
 */
export const OPENING_CONSTELLATION: Constellation = {
  width: 1180,
  height: 700,
  loopSeconds: 10,
  lineOpacity: 0.5,
  hops: [
    // Upper left: a closed seven-hop loop.
    { from: [70, 120], to: [160, 80], delay: 0 },
    { from: [160, 80], to: [250, 110], delay: 0.5 },
    { from: [250, 110], to: [330, 170], delay: 1 },
    { from: [330, 170], to: [300, 260], delay: 1.5 },
    { from: [300, 260], to: [200, 300], delay: 2 },
    { from: [200, 300], to: [110, 260], delay: 2.5 },
    { from: [110, 260], to: [70, 120], delay: 3 },
    // Upper right: a four-hop zigzag.
    { from: [880, 120], to: [955, 195], delay: 0.9 },
    { from: [955, 195], to: [1030, 110], delay: 1.6 },
    { from: [1030, 110], to: [1100, 190], delay: 2.3 },
    { from: [1100, 190], to: [1150, 95], delay: 3 },
    // Lower left: a closed triangle with one spur.
    { from: [150, 520], to: [265, 565], delay: 2.6 },
    { from: [265, 565], to: [205, 650], delay: 3.2 },
    { from: [205, 650], to: [150, 520], delay: 3.8 },
    { from: [265, 565], to: [365, 610], delay: 4.4 },
    // Lower right: a three-hop run.
    { from: [895, 515], to: [985, 580], delay: 3.4 },
    { from: [985, 580], to: [1075, 525], delay: 4.05 },
    { from: [1075, 525], to: [1140, 620], delay: 4.7 },
    // Middle right: one pair, last to arrive.
    { from: [820, 250], to: [900, 300], delay: 5.2 },
  ],
  stars: [
    { x: 70, y: 120, glyph: 'dot', delay: 0, size: 2, opacity: 0.7 },
    { x: 160, y: 80, glyph: 'cross', delay: 0.45, size: 5 },
    { x: 250, y: 110, glyph: 'dot', delay: 0.9, size: 2, opacity: 0.7 },
    { x: 330, y: 170, glyph: 'genie', delay: 1.35, size: 7 },
    { x: 300, y: 260, glyph: 'dot', delay: 1.8, size: 2, opacity: 0.7 },
    { x: 200, y: 300, glyph: 'dot', delay: 2.25, size: 2, opacity: 0.7 },
    { x: 110, y: 260, glyph: 'triangle', delay: 2.7, size: 6 },
    { x: 880, y: 120, glyph: 'dot', delay: 0.9, size: 2, opacity: 0.7 },
    { x: 955, y: 195, glyph: 'square', delay: 1.53, size: 5 },
    { x: 1030, y: 110, glyph: 'dot', delay: 2.16, size: 2, opacity: 0.7 },
    { x: 1100, y: 190, glyph: 'unity-catalog', delay: 2.79, size: 7 },
    { x: 1150, y: 95, glyph: 'dot', delay: 3.42, size: 2, opacity: 0.7 },
    { x: 150, y: 520, glyph: 'dot', delay: 2.6, size: 2, opacity: 0.7 },
    { x: 265, y: 565, glyph: 'dot', delay: 3.14, size: 2, opacity: 0.7 },
    { x: 205, y: 650, glyph: 'dpad', delay: 3.68, size: 8 },
    /* 4.4 rather than the reference's 4.22, and the ONE number in this file that
       is not the reference's. The lower-left group's stars are staggered 0.54s
       apart independently of its hops, which works for the three on the closed
       triangle and does not for this one: the spur that reaches it starts at
       4.4, so at 4.22 the sparkle lit up before the line to it began drawing.
       working-animation.test.ts holds the rule -- a star pops no earlier than
       the first line to touch it -- because the story the animation tells is
       that the line arrives and the star lights up, and telling it backwards on
       one star of twenty-two is the kind of thing nobody sees and everybody
       feels. */
    { x: 365, y: 610, glyph: 'sparkle', delay: 4.4, size: 8 },
    { x: 895, y: 515, glyph: 'mosaic-ai', delay: 3.4, size: 7 },
    { x: 985, y: 580, glyph: 'databricks-sql', delay: 3.98, size: 7 },
    { x: 1075, y: 525, glyph: 'dot', delay: 4.57, size: 2, opacity: 0.7 },
    { x: 1140, y: 620, glyph: 'dot', delay: 5.16, size: 2, opacity: 0.7 },
    { x: 820, y: 250, glyph: 'cross', delay: 5.2, size: 4 },
    { x: 900, y: 300, glyph: 'dot', delay: 5.65, size: 2, opacity: 0.7 },
  ],
  backdrop: [
    { x: 420, y: 90, opacity: 0.3 },
    { x: 560, y: 60, opacity: 0.35 },
    { x: 700, y: 100, opacity: 0.3 },
    { x: 480, y: 250, opacity: 0.35 },
    { x: 720, y: 240, opacity: 0.3 },
    { x: 60, y: 420, opacity: 0.35 },
    { x: 340, y: 420, opacity: 0.3 },
    { x: 860, y: 420, opacity: 0.35 },
    { x: 1120, y: 350, opacity: 0.3 },
    { x: 500, y: 670, opacity: 0.35 },
    { x: 640, y: 650, opacity: 0.3 },
    { x: 780, y: 600, opacity: 0.35 },
    { x: 1040, y: 280, opacity: 0.3 },
    { x: 250, y: 450, opacity: 0.35 },
    { x: 1150, y: 480, opacity: 0.3 },
  ],
};

/**
 * The path for one hop, as an SVG `d`.
 *
 * `pathLength="1"` is what makes ONE keyframe draw lines of every length: the
 * dash offset runs 1 to 0 in normalised units rather than in user units, so a
 * 40px spur and a 140px chain finish together. Set by the renderer, not here.
 */
export function hopPath(hop: Hop): string {
  return `M${hop.from[0]} ${hop.from[1]} ${hop.to[0]} ${hop.to[1]}`;
}

/**
 * How a star is drawn, as a path or as a product icon.
 *
 * Every glyph is generated from its centre and its size rather than written out
 * per star, which is what lets one drawing serve the splash's 5-unit cross and
 * the strip's 4-unit one without the two being two drawings.
 */
export function glyphPath(star: Star): string | null {
  const { x, y, size: r } = star;
  switch (star.glyph) {
    case 'cross':
      return `M${x - r} ${y - r}l${r * 2} ${r * 2}M${x + r} ${y - r}l${-r * 2} ${r * 2}`;
    case 'triangle':
      return `M${x} ${y - r}l${r} ${r * 1.8}h${-r * 2}z`;
    case 'dpad':
      return `M${x} ${y - r}v${r * 2}M${x - r} ${y}h${r * 2}`;
    case 'sparkle': {
      // A four-point star: a long axis of `r` and a waist at `r * 0.275`, which
      // is the proportion the reference draws at both of its sizes.
      const w = +(r * 0.275).toFixed(2);
      const m = +(r * 0.725).toFixed(2);
      return `M${x} ${y - r}l${w} ${m} ${m} ${w} ${-m} ${w} ${-w} ${m} ${-w} ${-m} ${-m} ${-w} ${m} ${-w}z`;
    }
    default:
      return null;
  }
}

/** Whether a glyph is drawn in the accent rather than in white. */
export function glyphTakesAccent(glyph: StarGlyph): boolean {
  return glyph === 'square' || glyph === 'dpad' || glyph === 'sparkle';
}

/**
 * The stagger for a chain of hops, so a constellation added later cannot be
 * given a rhythm by eye.
 *
 * Not used by the three above, whose delays are the reference's own. It is here
 * because the next surface to seat one of these will have a different number of
 * hops, and `loading-suite.md`'s rule -- "stagger ~0.7s per hop along the main
 * chain, shorter (~0.4s) for spurs" -- is the thing to follow rather than a set
 * of numbers copied off a panel of a different width.
 */
export function chainDelays(hops: number, step: number): number[] {
  return Array.from({ length: hops }, (_, at) => Math.round(at * step * 100) / 100);
}
