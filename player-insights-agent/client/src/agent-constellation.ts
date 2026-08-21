/**
 * Where the stars go.
 *
 * The run's steps drawn as a night sky, twice: `#18a` is the vertical live path,
 * connecting as the run happens, and `#18b` is the horizontal map of a finished
 * run. Both are laid out here rather than inside the markup, and that is a
 * decision about what can be checked rather than about tidiness -- vitest runs on
 * `node`, so a position that only exists as an attribute in JSX can be asserted
 * against a rendered tree and never against the arithmetic that produced it.
 *
 * WHAT THIS FILE EXISTS TO PREVENT. The agent map has run off the right-hand edge
 * of the page twice, and both times the fix was cosmetic and both times it came
 * back: once as one row with `overflow-x: auto`, so the later stages of an
 * ordinary eight-step run sat behind a scrollbar on a container nothing announced
 * as scrollable, and once as a flex wrap, which shares out leftover width per row
 * and so put nine cards in nine places that lined up under nothing. The card grid
 * was repaired by making it a grid of fixed tracks; a constellation has no tracks
 * to be fixed, so its equivalent is this: EVERY COORDINATE IS DERIVED FROM THE BOX
 * AND THE STEP COUNT, and `agent-constellation.test.ts` reads them back and checks
 * that nothing lands outside the box at any count. A drawing that cannot overflow
 * arithmetically cannot overflow on screen.
 *
 * Coordinates are viewBox units throughout, never pixels. The SVG scales to its
 * container, so the panel is as wide as the pane it is in and the geometry below
 * is the same at every rendered width -- which is the other half of why there is
 * no horizontal scrollbar to have.
 *
 * NOTHING HERE INVENTS A MEASUREMENT. A step's label is its recorded name and its
 * meta line is its recorded duration; a run with fewer steps gets fewer stars and
 * a shorter panel, never a padded one.
 */
import { formatMs, toolNameFromId } from './trace-timeline';
import { stepNumber } from './agent-map';
import type { TraceStage } from './answer-shape';

/* ------------------------------------------------------------------ *
 * The shared vocabulary
 * ------------------------------------------------------------------ */

/**
 * One step, as a star.
 *
 * `id` rather than an index, because the Explorer replaces the stage list under
 * the component when a different run is selected and an index would then select
 * whatever step had moved into that slot.
 */
export interface ConstellationStar {
  id: string;
  /** The step's place in the run, 1-based, matching the map and the rail. */
  step: number;
  x: number;
  y: number;
  /** An agent decision, drawn as a sparkle. A tool call is drawn as its product. */
  decision: boolean;
  /** The recoloured product mark this tool call is drawn with, when there is one. */
  tool: string;
  /** The row this star sits on. Always 0 on the vertical path. */
  row: number;
}

/** One hop of the chain, as a straight segment between two stars. */
export interface ConstellationLink {
  /** The step numbers either end, so a test can name the hop. */
  from: number;
  to: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  d: string;
  /**
   * Whether this is the hop into the step in progress, which draws on a loop.
   *
   * At most one link is ever live: `#18a` animates the line INTO the current
   * step, and a run has one current step.
   */
  live: boolean;
}

/** Which side of its star a label sits on. */
export type LabelSide = 'above' | 'below';

/**
 * A star's two lines of text, placed.
 *
 * The name is the near line and the meta line sits beyond it, on both sides, so
 * the pair always reads outward from the star.
 */
export interface ConstellationLabel {
  step: number;
  /** The centre the two lines are anchored on. */
  x: number;
  name: string;
  /** True when the name is a tool's own identifier and takes the mono face. */
  mono: boolean;
  meta: string;
  nameY: number;
  metaY: number;
  side: LabelSide;
  /** The rectangle both lines occupy, which is what the geometry test reads. */
  box: LabelBox;
}

/** A placed label's extent, in viewBox units. */
export interface LabelBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/* ------------------------------------------------------------------ *
 * Type metrics
 * ------------------------------------------------------------------ */

/**
 * How wide a character is, per face, at the 9.5-unit label size.
 *
 * DM Mono is exact: `docs/astrolabe-migration-inventory.md` measured every glyph
 * in both weights at an advance of 600 per 1000-unit em, so 9.5 * 0.6 = 5.7 and
 * a mono string's width is arithmetic rather than an estimate.
 *
 * DM Sans is proportional -- the same measurement found nine distinct advances
 * across ten digits, a `1` at 342 against a `0` at 656 -- so 5.4 is an upper
 * bound for the lowercase-heavy step names this draws rather than a mean. It is
 * deliberately generous: this number decides whether two labels are treated as
 * colliding, and a bound that is too small produces overlapping text while a
 * bound that is too large produces a label elided a character early.
 */
const MONO_ADVANCE = 5.7;
const SANS_ADVANCE = 5.4;

/** The cap height and the descender of the label face, for the label's box. */
const LABEL_ASCENT = 7;
const LABEL_DESCENT = 2.5;

/**
 * The shortest a label may be elided to.
 *
 * Six characters and an ellipsis still name the step, and the panel is an
 * overview: the full name is on the card beside it and in the step panel below.
 * It is also what makes the elision loop terminate -- see `settleLabels`.
 */
const MIN_LABEL_CHARS = 6;

/**
 * The half-width a label has at this x before it crosses the panel's edge.
 *
 * A label is centred on its star, so the room it has is the distance to the
 * NEARER edge: a star at 70 in an 820-unit box has 70 either side of it, not 750.
 */
function roomAt(x: number, boxWidth: number): number {
  return Math.min(x, boxWidth - x);
}

/**
 * How many characters a label may run to at this x without leaving the box.
 *
 * THIS IS THE HALF OF THE OVERFLOW RULE THAT COLLISIONS DO NOT COVER, and it was
 * missing. `settleLabels` shortens a label that runs into its NEIGHBOUR, which is
 * the crowded-run case; a run with only two steps has no neighbour to collide
 * with and its first label is still centred 70 units from the left edge. So a
 * long enough tool name walked off the side of the panel on the sparsest runs
 * rather than the densest, which is the opposite of where anyone would look.
 *
 * The real tool names cleared it -- `search_tagged_assets` is the longest at 20
 * characters, which leaves 13 units of margin at the first star -- so this was a
 * defect nothing on screen showed yet. That is exactly the kind this module is
 * meant to settle arithmetically: the margin is 13 units, the next tool anybody
 * names could spend it, and a caller cannot see this constant from the agent.
 *
 * The meta line is not clamped, and does not need to be: it is a two-digit step
 * number, the separator and a duration, so at most 11 characters and 63 units,
 * which is under the 140 the narrowest seating gives it. `agent-constellation.test.ts`
 * holds that rather than leaving it as an assumption in a comment.
 */
export function labelBudget(x: number, boxWidth: number, mono: boolean): number {
  const advance = mono ? MONO_ADVANCE : SANS_ADVANCE;
  return Math.max(MIN_LABEL_CHARS, Math.floor((2 * roomAt(x, boxWidth)) / advance));
}

/* ------------------------------------------------------------------ *
 * What a step is called on a band
 * ------------------------------------------------------------------ */

/**
 * The step's label: the tool's own name, or the decision shortened.
 *
 * A tool call is labelled with its identifier and nothing else, which is what the
 * design reference draws -- `search_semantics`, `dictionary_genie`, `data_genie`
 * -- because the product's own mark is the star and "Called" in front of it would
 * be a word spent saying what the sky already shows.
 *
 * A decision keeps its recorded name with the articles dropped: the reference
 * writes "Chose next step" and "Prepared findings" where the card grid writes
 * "Chose the next step" and "Prepared the findings". Two deterministic
 * substitutions rather than a rewrite, because the name is the agent's own words
 * and this is a band 9.5 units tall.
 */
export function starLabel(stage: Pick<TraceStage, 'id' | 'kind' | 'name'>): { text: string; mono: boolean } {
  const tool = toolNameFromId(stage.id);
  if (stage.kind !== 'agent' && tool !== '') return { text: tool, mono: true };
  return { text: stage.name.replace(/^Called\s+/, '').replace(/\bthe\s+/g, ''), mono: false };
}

/** The star's second line: which step it was and how long it took. */
export function starMeta(step: number, durationMs: number): string {
  return `${stepNumber(step)} · ${formatMs(durationMs)}`;
}

/** How wide a string renders at label size, in viewBox units. */
export function labelWidth(text: string, mono: boolean): number {
  return text.length * (mono ? MONO_ADVANCE : SANS_ADVANCE);
}

/**
 * A label elided to fit, with the ellipsis counted against the budget.
 *
 * One character, `…`, and not three dots: three dots in a 9.5-unit line are three
 * more characters of width spent saying the same thing, and the app writes the
 * single glyph everywhere else it elides.
 */
export function elide(text: string, chars: number): string {
  if (text.length <= chars) return text;
  return `${text.slice(0, Math.max(1, chars - 1)).trimEnd()}\u2026`;
}

/* ------------------------------------------------------------------ *
 * Label sides
 * ------------------------------------------------------------------ */

/**
 * Which side of a star its label sits on.
 *
 * "Labels opposite the line flow" is the design's rule, and this is the mechanical
 * reading of it: the connectors leave a star towards its neighbours, so the label
 * goes the other way. `lift` counts the neighbours that sit visually ABOVE the
 * star (a smaller y), one each, minus those below. A positive lift means both
 * lines rise out of the star, so the space beneath it is empty and the label goes
 * there.
 *
 * The design reference is hand-placed and this rule reproduces seven of its nine
 * labels; the two it differs on are a star five units off the panel's midline and
 * the selected star, whose ring the reference nudged its label clear of. Matching
 * a hand-drawn placement pixel for pixel is not what makes this readable, and it
 * is not checkable either. What is checkable is the set of invariants
 * `agent-constellation.test.ts` holds: every label inside the panel, no label
 * overlapping another, no label overlapping any star. Those are the failures a
 * reader would actually see.
 *
 * A lift of zero is a star on a monotone run, where both sides carry a line, so
 * the tie goes to whichever side has more of the panel left in it.
 */
export function labelSide(y: number, neighbours: number[], mid: number): LabelSide {
  const lift = neighbours.reduce((total, other) => total + Math.sign(y - other), 0);
  if (lift > 0) return 'below';
  if (lift < 0) return 'above';
  return y < mid ? 'below' : 'above';
}

/** Where the two lines sit, given the star and the side. */
function labelLines(y: number, side: LabelSide): { nameY: number; metaY: number } {
  return side === 'below' ? { nameY: y + 17, metaY: y + 29 } : { nameY: y - 20, metaY: y - 32 };
}

/** The rectangle a placed label occupies. */
function labelBox(x: number, width: number, nameY: number, metaY: number): LabelBox {
  return {
    x0: x - width / 2,
    x1: x + width / 2,
    y0: Math.min(nameY, metaY) - LABEL_ASCENT,
    y1: Math.max(nameY, metaY) + LABEL_DESCENT,
  };
}

/** How far above and below a star a label can reach, which the bands reserve for. */
export const LABEL_REACH = 32 + LABEL_ASCENT;

/**
 * How far a star's own glyph reaches from its centre.
 *
 * The sparkle is 14 units across and a product mark is 16, so 8 covers both. The
 * ring around a selected star is larger and is its own number, because it is
 * drawn on exactly one star and reserving its radius around all of them would
 * push every label a third further out for the sake of one.
 */
export const STAR_REACH = 8;
export const SELECTED_RING = 15;

/** The rectangle a star's glyph occupies, for the test that keeps labels off it. */
export function starBox(star: Pick<ConstellationStar, 'x' | 'y'>, reach = STAR_REACH): LabelBox {
  return { x0: star.x - reach, x1: star.x + reach, y0: star.y - reach, y1: star.y + reach };
}

/** Whether two rectangles share any area. */
export function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/**
 * Labels elided until none of them overlaps another.
 *
 * The alternative was a fixed character budget derived from the star pitch, which
 * is simpler and elides every label on every run: the scatter means most
 * neighbours are far enough apart vertically that their labels never met in the
 * first place, and shortening them all to guard against the pairs that would have
 * is paying the cost everywhere to fix it somewhere.
 *
 * So: place every label at the longest the BOX allows it -- `labelBudget` has
 * already had its say -- then shorten the longer of the first colliding pair by a
 * character and look again. `full` is the unshortened text, so a label that is
 * elided twice is cut from the name rather than from an earlier cut of it.
 *
 * IT TERMINATES, and the reason is worth stating because a settling loop that
 * does not is a hang rather than a wrong answer. Each pass either finds no
 * collision and stops, or removes at least one character from a label that is
 * above the minimum. A label at the minimum is `MIN_LABEL_CHARS` wide, and the
 * pitch between two stars is at least `MIN_STAR_GAP`, which is wider than two
 * such labels' half-widths -- so a pair that are both at the minimum cannot
 * overlap, and the loop cannot be handed a collision it may not shrink. The
 * `guard` is belt and braces for a caller who reaches past the layout functions
 * with a box narrower than the constants allow.
 */
function settleLabels(labels: ConstellationLabel[], chars: number[], mono: boolean[], full: string[]): void {
  for (let guard = 0; guard < 2000; guard += 1) {
    let clash: [number, number] | null = null;
    for (let a = 0; a < labels.length && clash === null; a += 1) {
      for (let b = a + 1; b < labels.length; b += 1) {
        if (boxesOverlap(labels[a].box, labels[b].box)) {
          clash = [a, b];
          break;
        }
      }
    }
    if (clash === null) return;
    const [a, b] = clash;
    const wider = labels[a].box.x1 - labels[a].box.x0 >= labels[b].box.x1 - labels[b].box.x0 ? a : b;
    const other = wider === a ? b : a;
    const victim = chars[wider] > MIN_LABEL_CHARS ? wider : other;
    if (chars[victim] <= MIN_LABEL_CHARS) return;
    chars[victim] -= 1;
    const label = labels[victim];
    label.name = elide(full[victim], chars[victim]);
    const width = Math.max(labelWidth(label.name, mono[victim]), labelWidth(label.meta, true));
    label.box = labelBox(label.x, width, label.nameY, label.metaY);
  }
}

/* ------------------------------------------------------------------ *
 * The horizontal map (#18b)
 * ------------------------------------------------------------------ */

/** The panel's width in viewBox units, which is also its aspect denominator. */
export const MAP_WIDTH = 820;

/** How much of each edge is margin rather than sky. */
export const MAP_PAD_X = 70;

/** The vertical band the stars themselves are scattered through, per row. */
export const MAP_STAR_BAND = 116;

/** Reserved above the first row's labels for the run's summary line. */
export const MAP_PAD_TOP = 34;

/** Reserved below the last row's labels for the legend. */
export const MAP_PAD_BOTTOM = 40;

/** Between two rows of stars. */
export const MAP_ROW_GAP = 8;

/**
 * The closest two stars may be along the row.
 *
 * This is the number that makes the map wrap. Below it a row stops being a
 * constellation and becomes a dotted line, and the labels have nowhere to go: the
 * shortest label the settling loop will produce is six characters, and two of
 * those plus a gutter is most of this. 78 also happens to be a shade under the
 * design reference's own tightest hop, which is the check that it is not merely a
 * number that makes the arithmetic work.
 */
export const MIN_STAR_GAP = 78;

/**
 * The scatter, as fractions of the star band.
 *
 * These are the design reference's own nine y positions at `#18b`, normalised
 * onto the band, so a nine-step run draws the shape that was designed. Runs
 * longer than nine repeat the pattern, offset by row so that two rows of the same
 * length are not the same drawing twice.
 *
 * A pattern rather than a hash of the step id: the sky has to be the same sky
 * every time a reader opens the same run, and it has to be the same sky in a test.
 */
const MAP_SCATTER = [0.48, 0, 0.28, 1, 0.72, 0.21, 0.91, 0.48, 0.07];

/** The whole placed map. */
export interface MapConstellation {
  width: number;
  height: number;
  stars: ConstellationStar[];
  links: ConstellationLink[];
  labels: ConstellationLabel[];
  /** How many rows the run wrapped onto, and how many stars fit on one. */
  rows: number;
  perRow: number;
}

/**
 * How many stars fit on one row, and therefore how many rows a run needs.
 *
 * Rows are BALANCED rather than filled: an eighteen-step run draws two rows of
 * nine and not a row of nine above a row of nine, which is the same thing, but a
 * nineteen-step run draws three rows of seven rather than two full rows and a row
 * of one. A row of one is a star with no chain in it, which reads as a step that
 * happened somewhere else.
 *
 * The pitch is then computed from the widest row and used on every row, so a
 * short last row ends early rather than spreading its stars out to fill the
 * width. Rows that do not line up vertically are what made the flex-wrap version
 * of the card grid unreadable.
 */
export function mapRows(count: number): { rows: number; perRow: number } {
  const fits = Math.max(1, Math.floor((MAP_WIDTH - 2 * MAP_PAD_X) / MIN_STAR_GAP) + 1);
  const rows = Math.max(1, Math.ceil(count / fits));
  return { rows, perRow: Math.max(1, Math.ceil(count / rows)) };
}

/** The height a map of this many steps needs, derived rather than assumed. */
export function mapHeight(count: number): number {
  const { rows } = mapRows(count);
  const band = MAP_STAR_BAND + 2 * LABEL_REACH;
  return MAP_PAD_TOP + rows * band + (rows - 1) * MAP_ROW_GAP + MAP_PAD_BOTTOM;
}

/**
 * The finished run as a horizontal scattered constellation.
 *
 * `#18b`. Stars are placed on an even pitch along each row and scattered through
 * the band vertically, which is where "scattered" lives: an even pitch is what
 * lets the label settling above reason about neighbours at all, and a jittered x
 * would buy a slightly less regular sky at the cost of the one property this
 * drawing has to have.
 *
 * NO LINK CROSSES A ROW BOUNDARY, which is `agent-map.md`'s own rule for the card
 * grid beside it -- "no connectors between rows" -- and holds here for the reason
 * it holds there: a line from the end of one row to the start of the next crosses
 * every star between them, and the step numbers on the labels already carry the
 * order.
 */
export function buildMapConstellation(stages: TraceStage[]): MapConstellation {
  const { rows, perRow } = mapRows(stages.length);
  const height = mapHeight(stages.length);
  const pitch = perRow > 1 ? (MAP_WIDTH - 2 * MAP_PAD_X) / (perRow - 1) : 0;
  const bandHeight = MAP_STAR_BAND + 2 * LABEL_REACH;

  const stars: ConstellationStar[] = stages.map((stage, index) => {
    const row = Math.floor(index / perRow);
    const column = index % perRow;
    const bandTop = MAP_PAD_TOP + row * (bandHeight + MAP_ROW_GAP) + LABEL_REACH;
    const scatter = MAP_SCATTER[(index + row * 4) % MAP_SCATTER.length];
    return {
      id: stage.id,
      step: index + 1,
      x: perRow > 1 ? MAP_PAD_X + column * pitch : MAP_WIDTH / 2,
      y: bandTop + scatter * MAP_STAR_BAND,
      decision: stage.kind === 'agent',
      tool: toolNameFromId(stage.id),
      row,
    };
  });

  const links: ConstellationLink[] = [];
  for (let index = 1; index < stars.length; index += 1) {
    const from = stars[index - 1];
    const to = stars[index];
    if (from.row !== to.row) continue;
    links.push({
      from: from.step,
      to: to.step,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      d: `M${round(from.x)} ${round(from.y)} ${round(to.x)} ${round(to.y)}`,
      live: false,
    });
  }

  const chars: number[] = [];
  const mono: boolean[] = [];
  const full: string[] = [];
  const labels = stars.map((star, index) => {
    const { text, mono: isMono } = starLabel(stages[index]);
    const meta = starMeta(star.step, stages[index].duration);
    // Only the stars on this row, and only the ones next to it: a star at the end
    // of a row has one neighbour, and the star below it on the next row is not one.
    const neighbours = [stars[index - 1], stars[index + 1]]
      .filter((other) => other !== undefined && other.row === star.row)
      .map((other) => other.y);
    const mid = MAP_PAD_TOP + star.row * (bandHeight + MAP_ROW_GAP) + LABEL_REACH + MAP_STAR_BAND / 2;
    const side = labelSide(star.y, neighbours, mid);
    const { nameY, metaY } = labelLines(star.y, side);
    // The box has its say before any neighbour does. A star near an edge gets a
    // shorter name whether or not anything is beside it; see `labelBudget`.
    const budget = Math.min(text.length, labelBudget(star.x, MAP_WIDTH, isMono));
    const name = elide(text, budget);
    const width = Math.max(labelWidth(name, isMono), labelWidth(meta, true));
    chars.push(budget);
    mono.push(isMono);
    full.push(text);
    return { step: star.step, x: star.x, name, mono: isMono, meta, nameY, metaY, side, box: labelBox(star.x, width, nameY, metaY) };
  });
  settleLabels(labels, chars, mono, full);

  return { width: MAP_WIDTH, height, stars, links, labels, rows, perRow };
}

/* ------------------------------------------------------------------ *
 * The vertical live path (#18a)
 * ------------------------------------------------------------------ */

/** The panel's width in viewBox units. */
export const PATH_WIDTH = 320;

/** The horizontal band the stars are scattered through. */
export const PATH_BAND_LEFT = 118;
export const PATH_BAND_RIGHT = 218;

/** Reserved above the first star. */
export const PATH_PAD_TOP = 38;

/**
 * Reserved below the last star.
 *
 * It holds two things: the ring around the step in progress, which reaches 15
 * units past the star, and the status overlay along the foot of the panel.
 */
export const PATH_PAD_BOTTOM = 56;

/** The furthest and closest two consecutive stars sit vertically. */
export const PATH_MAX_PITCH = 56;
export const PATH_MIN_PITCH = 30;

/**
 * How many hops are drawn at the full pitch before the path starts tightening.
 *
 * Six, so a run of seven steps -- the length `#18a` is drawn at -- is the
 * reference's own drawing, every hop at 56 and the panel 430 units tall.
 */
const PATH_FULL_PITCH_HOPS = 6;

/** What each hop past that one gives up, until it reaches the floor. */
const PATH_PITCH_DECAY = 6;

/**
 * The skies a run can be drawn on, as fractions of the band.
 *
 * The first row OPENS on the design reference's own seven x positions, so a run
 * of seven or fewer draws exactly what `#18a` draws. Its last four values are
 * the continuation the reference never had to specify, and the three rows under
 * it are whole alternative skies.
 *
 * WHY THERE IS MORE THAN ONE. Every run drew the same chain, so the band read as
 * a decoration of the app rather than a drawing of the run: a reader who had
 * watched two questions had seen the same seven-point zig-zag twice and stopped
 * reading it. Four skies is enough that consecutive runs differ and few enough
 * that each one is a shape somebody placed rather than noise -- which is the
 * whole distinction the design asks for, and the reason this is a short list of
 * hand-tuned rows and not a random walk.
 *
 * WHICH ROW A RUN GETS IS DECIDED BY ITS SEED AND NOTHING ELSE; see
 * `pathVariant`. It is emphatically not decided by the step count, the clock or
 * a render counter: the band is redrawn on every tick of the caller's clock and
 * on every step the agent announces, so a sky that were a function of any of
 * those would re-shuffle itself under a reader watching the chain arrive.
 *
 * EVERY VALUE IS IN [0, 1], which is what makes the overflow claim survive a new
 * row: a star's x is `PATH_BAND_LEFT + value * band`, so a value in range cannot
 * place a star outside the band, and a star inside the band cannot put its glyph,
 * its ring or its step number outside the panel. `agent-constellation.test.ts`
 * reads the rows back rather than trusting the next person to hold the range in
 * their head.
 *
 * EACH ROW IS CYCLICALLY WELL SPACED: no two adjacent values, INCLUDING the last
 * beside the first, are closer than `MIN_PATH_SWING`. Adjacency is checked
 * around the wrap because a run longer than a row repeats it -- `index % length`
 * and nothing cleverer -- so the wrap is an ordinary hop of a long run rather
 * than a seam. That property is what makes the chain a chain at any length: two
 * near-equal values in a row draw a vertical stub a reader reads as a missing
 * hop. The reference's own seventh value ran into its first at 0.08, which is
 * the stub an eight-step run used to draw, and extending the row past seven is
 * what removed it.
 */
export const PATH_SCATTERS: readonly (readonly number[])[] = [
  [0.42, 1, 0.78, 0, 0.22, 0.98, 0.5, 0.06, 0.68, 0.14, 0.9],
  [0.9, 0.12, 0.62, 0.04, 0.84, 0.3, 1, 0.46, 0.08, 0.72, 0.26],
  [0.2, 0.72, 0.02, 0.5, 0.96, 0.34, 0.66, 0.1, 0.88, 0.4, 0.76],
  [0.56, 0.04, 0.8, 0.24, 1, 0.44, 0.14, 0.7, 0.32, 0.94, 0.06],
];

/**
 * The narrowest hop any sky may draw, as a fraction of the band.
 *
 * A fifth of the band is 20 units against a pitch of at least 30, so the
 * shallowest hop still leaves the vertical clearly. Below that the two stars read
 * as one column and the connector between them as a tick rather than a hop.
 */
export const MIN_PATH_SWING = 0.2;

/**
 * Which sky this run is drawn on: the thread it belongs to, and its place in it.
 *
 * TWO INPUTS RATHER THAN ONE HASHED STRING, and the second one is the whole
 * reason this reads the way it does. Hashing "thread and turn" together spreads
 * runs across the four skies on average, and on average is not the claim worth
 * making: with four skies it still hands a reader the same chain twice in a row
 * one time in four, and two questions in a row is exactly when they are looking
 * for the difference. Adding the turn instead makes consecutive runs in one
 * thread draw different skies ALWAYS, because consecutive turns differ by one
 * and there is more than one sky. That is the same kind of guarantee the rest of
 * this module trades in: a property of the arithmetic rather than of the sample
 * somebody happened to try.
 *
 * The thread decides where in the cycle a conversation starts, so two threads
 * asking their first question usually differ too -- FNV-1a, which is four lines
 * and carries no dependency behind it. Nothing here is defending against
 * anything, so a spread is the only property being asked of it.
 *
 * NEITHER INPUT MAY MOVE WHILE A RUN IS GOING. See `AgentPathConstellation`,
 * which is where they come from and where that is argued.
 *
 * No thread and no turn is a caller with no name for this run, and draws the
 * design reference's own sky rather than an arbitrary one.
 */
export function pathVariant(thread: string, turn = 0): number {
  let hash = 0;
  if (thread !== '') {
    hash = 0x811c9dc5;
    for (let at = 0; at < thread.length; at += 1) {
      hash ^= thread.charCodeAt(at);
      hash = Math.imul(hash, 0x01000193);
    }
    hash >>>= 0;
  }
  return (hash + Math.max(0, turn)) % PATH_SCATTERS.length;
}

/**
 * Where the star at this index sits across the band, on this sky.
 *
 * A function of the index and the sky, and of nothing else, for the same reason
 * `pathStarY` is: the band is rebuilt from scratch every time the run reports a
 * step, so a star already on screen must land back on the x it was placed at.
 * `agent-constellation.test.ts` reads this back against the builder.
 */
export function pathStarX(index: number, variant = 0): number {
  const sky = PATH_SCATTERS[variant] ?? PATH_SCATTERS[0];
  return PATH_BAND_LEFT + sky[index % sky.length] * (PATH_BAND_RIGHT - PATH_BAND_LEFT);
}

/** The whole placed path. */
export interface PathConstellation {
  width: number;
  height: number;
  stars: ConstellationStar[];
  links: ConstellationLink[];
  /** The step numbers beside the stars, placed on whichever side has room. */
  numbers: PathNumber[];
  /**
   * The hop the newest star arrived on. Not a pitch for the whole path any
   * more -- see `pathPitch` -- and reported for the frontier because that is
   * the only hop a caller could want a figure for.
   */
  pitch: number;
  /** Which row of `PATH_SCATTERS` this run was drawn on. */
  variant: number;
}

/** A step number beside its star. */
export interface PathNumber {
  step: number;
  label: string;
  x: number;
  y: number;
  /** Which end of the text is anchored, so the label runs away from the star. */
  anchor: 'start' | 'end';
}

/**
 * The pitch of the hop that lands STEP `step` under the one before it.
 *
 * A PROPERTY OF THE HOP AND NEVER OF THE RUN, and that distinction is the whole
 * of this fix. It used to be `PATH_BODY / (count - 1)`: one pitch for the path,
 * derived from how many steps the run had reported SO FAR. On a finished trace
 * that is a fine way to fit a run into a panel. On the live path it meant every
 * star was re-placed each time the agent announced a step -- step 07 sat at
 * y=362 on an eight-step run, 326 on a nine, 290 on a ten -- so the chain
 * concertinaed upward every few seconds while the reader was watching it draw.
 * The panel's own foot moved with it, and not even monotonically: the rounding
 * put the height at 472 units on eight steps, 478 on nine and 472 again on ten,
 * so the band grew, shrank and grew as the run went on. That is the shake.
 *
 * Keyed on the hop instead, `pathStarY` is a function of a star's index alone,
 * so a star that has been placed stays where it was placed and a new step only
 * ever adds to the foot of the panel. The compression the old arithmetic was
 * there for survives -- the hops decay from 56 towards a floor of 30, so a long
 * run still tightens rather than spending 56 units a step forever -- it is just
 * spent forwards, on the hops that have not been drawn yet, rather than
 * retrospectively on the ones that have.
 *
 * `count` and `step` are the same number to every existing caller, which is why
 * the signature did not change: both ask "the path is this long, how far apart
 * are its stars at that end".
 */
export function pathPitch(step: number): number {
  if (step < 2) return PATH_MAX_PITCH;
  const past = Math.max(0, step - 1 - PATH_FULL_PITCH_HOPS);
  return Math.max(PATH_MIN_PITCH, Math.min(PATH_MAX_PITCH, PATH_MAX_PITCH - past * PATH_PITCH_DECAY));
}

/**
 * Where the star at this index sits, which depends on the index and nothing else.
 *
 * The one invariant the live path needs and did not have. `agent-constellation.test.ts`
 * reads it back against `buildPathConstellation` at every count, because a
 * position that is stable in this function and recomputed differently in the
 * builder is the same defect wearing a different hat.
 */
export function pathStarY(index: number): number {
  let y = PATH_PAD_TOP;
  for (let hop = 1; hop <= index; hop += 1) y += pathPitch(hop + 1);
  return y;
}

/**
 * The height a path of this many steps needs.
 *
 * Grows with the run and never shrinks, which is the other half of not shaking:
 * the band's foot is the last star plus the room reserved under it.
 */
export function pathHeight(count: number): number {
  return pathStarY(Math.max(1, count) - 1) + PATH_PAD_BOTTOM;
}

/**
 * The run so far as a vertical night-sky path.
 *
 * `#18a`. `activeIndex` is the step in progress, decided by the caller because the
 * caller is the only thing that knows whether the run is still going -- a
 * component that read the clock itself is how a finished run gets left counting.
 * The hop INTO that step is the one marked `live`, and it is the only one: it is
 * the line the reader is watching arrive.
 *
 * A step number sits on the side of its star away from the panel's centre, so it
 * runs outward into the margin rather than back across the chain.
 *
 * `variant` is which sky the run is drawn on, and it is the caller's decision
 * because a run's identity is the caller's to know -- see `pathVariant`. It
 * changes WHERE the stars are and nothing about what they mean, so every
 * invariant below holds on every sky and the test runs them over all of them.
 *
 * APPEND-ONLY. Every position here is a function of a star's INDEX and the sky,
 * and of nothing else -- `pathStarX` for the x, `pathStarY` for the y -- so
 * appending a step cannot move a star that is already on screen. That is a
 * property of this function rather than of the component, which is why it is
 * asserted here: the band is redrawn on every tick of the caller's clock, and a
 * layout that only happened to be stable would shake on a surface nobody would
 * think to check.
 */
export function buildPathConstellation(stages: TraceStage[], activeIndex = -1, variant = 0): PathConstellation {
  const centre = PATH_WIDTH / 2;

  /* Accumulated rather than `pathStarY` per star, so the walk is one pass; the
     two agree by construction and the test holds them to it. */
  let y = PATH_PAD_TOP;
  const stars: ConstellationStar[] = stages.map((stage, index) => {
    if (index > 0) y += pathPitch(index + 1);
    return {
      id: stage.id,
      step: index + 1,
      x: pathStarX(index, variant),
      y,
      decision: stage.kind === 'agent',
      tool: toolNameFromId(stage.id),
      row: 0,
    };
  });

  const links: ConstellationLink[] = stars.slice(1).map((to, index) => {
    const from = stars[index];
    return {
      from: from.step,
      to: to.step,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      d: `M${round(from.x)} ${round(from.y)} ${round(to.x)} ${round(to.y)}`,
      live: index + 1 === activeIndex,
    };
  });

  const numbers: PathNumber[] = stars.map((star) => ({
    step: star.step,
    label: stepNumber(star.step),
    x: star.x < centre ? star.x - 14 : star.x + 14,
    y: star.y + 4,
    anchor: star.x < centre ? 'end' : 'start',
  }));

  return {
    width: PATH_WIDTH,
    height: pathHeight(stages.length),
    stars,
    links,
    numbers,
    pitch: pathPitch(stages.length),
    variant,
  };
}

/**
 * Coordinates to a tenth of a unit in the path strings.
 *
 * The positions are divisions of a box width, so most of them are recurring
 * decimals, and a path attribute carrying seventeen significant figures is
 * seventeen figures in the markup and in every snapshot of it. A tenth of a
 * viewBox unit is a fortieth of a pixel at the width this renders at.
 */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}
