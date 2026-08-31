/**
 * Where each node sits, and how the edges get between them.
 *
 * A HAND-ROLLED LAYOUT IN PIXELS, on a canvas of a fixed size, computed here
 * rather than measured in the DOM. The client bundle is already over 500 kB and
 * Databricks Apps forbids runtime CDNs, so there is no graph library to reach
 * for; and a layout that measured itself would be untestable without running a
 * browser, which is the one thing this work cannot do.
 *
 * IT USED TO BE PERCENTAGES ON A 0-100 SQUARE, and the reason it is not any more
 * is that a percentage layout has no fixed relationship between a card's width in
 * `ch` and the gap the edge labels need. Cards grew with their content, edge
 * captions ended up underneath them, and the graph reflowed into overlapping
 * boxes at the exact widths a laptop is set to. The design this now implements
 * states the canvas as {@link CANVAS_WIDTH} x {@link CANVAS_HEIGHT} and places
 * every card and every path in that one space, so a caption that clears a card
 * here clears it at every viewport. Narrow viewports SCROLL the canvas rather
 * than re-arranging it -- see architecture.css -- because a diagram that
 * rearranges itself is a second diagram nobody checked.
 *
 * SCROLLING IS THE BEHAVIOUR AT NARROW WIDTHS AND WAS ALSO THE BEHAVIOUR AT WIDE
 * ONES. The canvas was 1400 across and the widest the panel around it ever gets
 * is {@link CANVAS_MAX_WIDTH}, so every reader at every window size got a
 * horizontal scrollbar and the right-hand column against the edge. Nothing here
 * caught it: every check compared the layout to the canvas, and nothing compared
 * the canvas to the space it has to fit in. That check now exists, and the
 * drawing was tightened rather than scaled -- see the width table below.
 *
 * THE HEIGHTS USED TO BE ONE NUMBER FOR ALL TWELVE CARDS, and that number was
 * 140 while the columns were stacked on a 160px pitch. Both were wrong in the
 * same direction, and a card is as tall as the copy inside it: the ordinary
 * dependency cards come out at 157, the app's at 165, Lakebase's at 197 and the
 * Vector Search index card's at 229. Two things followed, and the checks in this
 * file could see neither, because every one of them reasoned about a card shorter
 * than any that is drawn:
 *
 *   - THE MIDDLE COLUMN RAN ON THREE PIXELS. 160 of pitch against 157 of card,
 *     three times over, where a caption needs twenty-four -- and `conversation`
 *     and `trace` are placed in gaps like those. Three pixels is not a layout, it
 *     is the distance to one. Any sentence added to a role paragraph, or a status
 *     word four characters longer, spent it and put a card over the title of the
 *     card beneath: the cards are opaque, and each is painted after the one above
 *     it in the middle column, so the one that loses is always the lower.
 *   - THE BOTTOM OF THE RIGHT COLUMN WAS CUT OFF. The Vector Search endpoint's
 *     card is 173 tall at top 620, which is 793 on a canvas that was 760 -- and
 *     `.arch-canvas-scroll` is `overflow-y: hidden`, so those 33px were not
 *     scrolled to, they were gone, and the "Open in Databricks" link in them with
 *     it. THE CANVAS HEIGHT IS A CLIP, not a bound the drawing is checked against
 *     for tidiness, which is why every card is now asserted to be inside it.
 *
 * Fitting the canvas to the panel -- the other half of what was reported, fixed
 * first -- scaled all of that down along with everything else.
 *
 * So the heights are now DERIVED, per card, from the box model in
 * architecture.css and the copy in architecture.ts -- see {@link nodeHeight} --
 * and the tops below are spaced to clear them by {@link ROW_GAP_MIN}. Nothing is
 * measured in the DOM and nothing needs to be: the one part that cannot be
 * computed is how wide a glyph sets, and that is an explicit upper bound which
 * errs towards a taller card. Growing downwards is free, because the page scrolls
 * vertically and only the sideways scroll was ever the complaint.
 *
 * THE LINES WERE THE HALF NOBODY HAD A RULE FOR, and "the paths are very mixed
 * and hard to follow, weirdly curved" is what that reads as. Every edge was a
 * literal path string, so each one was drawn by hand against the card positions
 * of the day it was written, and three habits followed from that:
 *
 *   - CUBICS WHOSE CONTROL POINTS WENT BACKWARDS. `C716 315 700 86` puts the
 *     first handle to the RIGHT of the second, so the curve leaves the card,
 *     turns back on itself and kinks. Four of the fourteen edges did this, each
 *     by a different amount, which is why no two of them looked related.
 *   - AN EDGE THAT SKIPPED A COLUMN AND WENT THROUGH IT. The finder's line to
 *     the warehouse ran across the whole middle column at one y, threading a gap
 *     between two cards that happened to be there, and crossed three other edges
 *     on the way in.
 *   - ENDS THAT HAD TO BE RE-TYPED WHENEVER A CARD MOVED, which the old comment
 *     on the geometry table says out loud.
 *
 * So the edges are DERIVED too. Each one names the card edge it leaves, the card
 * edge it arrives at, and which of four shapes it is -- see {@link Route} and
 * {@link edgePath} -- and the path string is computed from the placement table
 * above it. A card that moves takes its lines with it, every diagonal is the
 * same monotone cubic, and the one edge that has to cross a column crosses it in
 * a stated channel rather than wherever its handles happened to fall.
 */
import { ARCHITECTURE_EDGES, ARCHITECTURE_NODES } from './architecture';

/**
 * The widest the canvas may be drawn, which is the widest its container gets.
 *
 * Derived, not chosen, and the arithmetic is the whole point of stating it:
 *
 *     .page-shell   max-width 1440, padding 2 x clamp(20px, 4vw, 56px)  -> 1328
 *     .arch-flow    border 2 x 1px, padding 2 x 16px                    -> 1294
 *
 * `box-sizing: border-box` is global (styles/base.css), so the shell's max-width
 * INCLUDES its padding and the panel's padding comes out of what is left. Every
 * one of those numbers is read back out of the stylesheets by
 * architecture-layout.test.ts, so a change to the shell's padding or the panel's
 * fails here rather than reappearing as a scrollbar nobody asked for.
 *
 * This is a ceiling on the DRAWING, not a promise about the window. A narrow
 * window still scrolls the canvas sideways, which is the documented behaviour
 * and is fine; what is not fine is a canvas that cannot fit at ANY width.
 */
export const CANVAS_MAX_WIDTH = 1294;

/**
 * How much narrower than the panel the fitted canvas is drawn.
 *
 * `zoom` multiplies a stated pixel width by a fraction, and the result is laid
 * out against a panel width the engine measured for itself. Two roundings meet
 * there -- the panel's own fractional width, and the device-pixel snapping of
 * `1264 x s` -- and a fit computed as exactly `panelWidth / CANVAS_WIDTH` lands
 * on the wrong side of both about as often as the right one. What that produced
 * was the reported defect in its most confusing form: a horizontal scrollbar
 * over a drawing that fits, and, once the reader had nudged it, a left-hand card
 * with its first letter behind the frame. A scroll offset is not visibly
 * different from a clipped layout, which is why "the Browser card is cut off"
 * and "there is no room" read as the same report.
 *
 * Two pixels, because the hazard is rounding rather than space: it is a quarter
 * of a percent of the drawing at the widths where any fitting happens at all,
 * and it is applied ONLY where `zoom` is. A panel at least as wide as the canvas
 * draws at full size and needs no slack, because an integer width inside an
 * equal integer width does not overflow.
 */
export const CANVAS_FIT_SLACK = 2;

/**
 * The canvas every position below is stated in.
 *
 * WIDTH: 1264, which is 30px inside {@link CANVAS_MAX_WIDTH}. It was 1400, from
 * the design, and 1400 has never fitted -- see the note at the top of this file.
 * The 136px came out of gaps, margins and four of the five column widths rather
 * than out of a `transform: scale()`, because a scaled canvas draws 13px type at
 * 11.7px, softens every glyph on the page's densest surface, and puts each card's
 * click target a few pixels from where it is painted.
 *
 * THE SAME TRADE WAS MADE A SECOND TIME, and it is the whole of the answer to
 * "the bubbles are crowding each other". Every column got NARROWER again and
 * every gap got WIDER, at a canvas that did not grow by a pixel:
 *
 *     margin  8 ->  12    browser 152 -> 140    gap 52 ->  74
 *     app   196 -> 184    gap      46 ->  62    agent 220 -> 208
 *     gap    60 ->  68    middle  250 -> 232    gap   46 ->  62
 *     right 226 -> 210    margin    8 ->  12
 *
 * 70px came off the five cards and went into the four corridors, because a
 * corridor is where the captions are and a card that loses width only gets
 * taller. THE CARDS PAID FOR THE AIR IN THE ONE CURRENCY THIS DRAWING HAS
 * SPARE. Narrowing the middle column used to be refused here on the grounds
 * that a line added to a role paragraph was an overlap; that stopped being true
 * when the tops were spaced off the real heights, and this is the change that
 * spends what that bought. The four middle cards are 173, 157, 157 and 245 at
 * 232 wide, against 157, 157, 157 and 229 at 250, and every pixel of that went
 * downwards where the page already scrolls.
 *
 * EVERY GAP IS SIZED BY THE LONGEST WORD STANDING IN IT plus
 * {@link LABEL_CLEAR_MIN} at each end, which is the rule the old table was
 * missing rather than a number picked to look right. The first gap held
 * "question" -- 8 characters of 10px mono, 49.6px -- in 52, so the caption had
 * about a pixel of white on each side of it and read as touching both cards.
 * That passed every check in this file, because not-overlapping was all any of
 * them asked.
 *
 * THE 30px IS NOT SPARE AND SHOULD NOT BE SPENT. A desktop scrollbar takes its
 * width out of the layout viewport, so a 1440px window lays the shell out in
 * about 1425 and the panel offers about 1279 rather than the 1294 above. The
 * ceiling is the no-scrollbar case; the slack is what makes the real one fit.
 *
 * THE FOUR CORRIDORS ARE NOW ONE NUMBER, {@link COLUMN_GAP}, and the widths were
 * left alone to pay for it. They were 86, 74, 80 and 88, which is four
 * separations a reader compares across one drawing and finds four answers to; a
 * column pitch that changes as the eye travels right is read as the columns
 * meaning different amounts of distance. Nothing had to shrink for this: the five
 * card widths already summed to 912 and the four gaps to 328, and 328 divides by
 * four exactly. So every card keeps the width its copy was measured against --
 * and therefore its height, which is derived from that width -- and only the
 * lefts moved.
 *
 * HEIGHT: derived from the placement table, and it has to be recomputed by hand
 * whenever a top moves, which is what architecture-layout.test.ts asserts rather
 * than trusts: the lowest card's bottom plus the margin the highest card starts
 * at. The tallest column is no longer the one that decides it -- Lakebase hangs
 * lowest, on the storage row -- so the figure is a fact about the whole table
 * rather than about one stack.
 *
 * It was 760, then 832, then 939, and is 861 now that the re-space has taken the
 * slack out of the columns. 760 was not a margin short, it was a CLIP:
 * the scroller around this canvas is `overflow-y: hidden` and the canvas is given
 * this height in pixels, so the 33px by which the right-hand column overran it
 * were not reachable by scrolling. Height is the cheap dimension here -- the page
 * itself scrolls, and sideways scroll was the whole of the complaint -- which is
 * why the answer to a card that needs more room is always to give it more room.
 */
export const CANVAS_WIDTH = 1264;
export const CANVAS_HEIGHT = 861;

/**
 * The white between one column and the next, everywhere.
 *
 * 82, which is the 328px the five columns leave over divided by the four gaps
 * between them, and it is a floor as well as a pitch: every corridor has to seat
 * the longest caption standing in it plus {@link LABEL_CLEAR_MIN} at each end, so
 * a caption of more than 58px of 10px mono -- nine characters -- has to be placed
 * in a column's own vertical gap instead. Three are: "plan + prose",
 * "resolve + SQL" and "governed reads".
 */
export const COLUMN_GAP = 82;

/**
 * The air above the first card and below the last one.
 *
 * One number for both ends, because the canvas is a frame: 36 of white at the top
 * and 12 at the bottom reads as a drawing that slipped, and the check that the two
 * agree is the only thing that keeps the canvas height honest as cards move.
 */
export const CANVAS_MARGIN = 36;

/**
 * The smallest the drawing may be drawn at before scrolling is the better answer.
 *
 * A fixed canvas fits only the windows at least as wide as it is, and tightening
 * it to {@link CANVAS_WIDTH} only moved that threshold: below about 1294 of panel
 * the right-hand column was still cut off at the edge, which is what a reader
 * reports as labels hidden behind the frame. Scrolling was the documented answer
 * and it is the wrong one, because a diagram read through a letterbox is a
 * diagram whose right half nobody looks at.
 *
 * So the canvas is fitted to the panel instead, down to this floor. The floor was
 * 0.72, chosen for how small it draws the type: 13px at about 9px, "the point at
 * which shrinking further costs more than a scrollbar does". That is a judgement
 * about legibility with no arithmetic behind it, and it was one pixel on the
 * wrong side of the window it was presumably picked for -- a 1024px window lays
 * the shell out in 1024 - 2 x 41 and offers about 908 of panel, which needs
 * 908 / 1264 = 0.7185. At 0.72 that window draws 910 into 908 and gets a two
 * pixel scrollbar: all of the shrinking, none of the fit.
 *
 * So it is derived rather than chosen, and rounded DOWN, because the point of
 * the floor is that everything above it fits. Raising it instead was the other
 * option and is the wrong one: it buys back a fraction of a pixel of type by
 * reintroducing the horizontal scrollbar this whole mechanism exists to remove.
 * At the widths a reader is actually on -- see the table in
 * architecture-layout.test.ts -- the drawing is at full size or near it, so the
 * floor is what happens off the end of the range rather than what anybody sees.
 */
export const MIN_CANVAS_SCALE = 0.71;

/**
 * How much of full size to draw the canvas at, for a panel of a given width.
 *
 * A pure function of one number, so the decision is tested here rather than in a
 * browser. `0` means not measured yet -- the first paint, and every render on the
 * server -- and draws at full size, which is what the geometry in this file is
 * stated in and what every check above reasons about.
 *
 * Applied as `zoom` rather than `transform: scale()`. Zoom takes part in layout,
 * so the cards' click targets land where they are painted and the panel's height
 * follows the drawing; a transform paints somewhere other than where the element
 * is, which is how a scaled diagram ends up with hit targets a few pixels out.
 */
export function canvasScale(panelWidth: number): number {
  if (!Number.isFinite(panelWidth) || panelWidth <= 0) return 1;
  if (panelWidth >= CANVAS_WIDTH) return 1;
  return Math.max(MIN_CANVAS_SCALE, (panelWidth - CANVAS_FIT_SLACK) / CANVAS_WIDTH);
}

/**
 * The narrowest panel the whole drawing still fits in.
 *
 * The floor above is where shrinking stops; this is what that means in pixels.
 * Below it the drawing cannot be made to fit without going under the floor, so
 * something other than the drawing has to be shown. Rounded up to a CSS pixel so
 * the container-query threshold is stable rather than a long binary fraction.
 */
export const MIN_CANVAS_PANEL = Math.ceil(MIN_CANVAS_SCALE * CANVAS_WIDTH + CANVAS_FIT_SLACK);

/**
 * Whether the drawing can be shown at all in a panel this wide.
 *
 * SCROLLING WAS THE OLD ANSWER BELOW THE FLOOR AND IT IS THE WRONG ONE. The two
 * options a fixed drawing has in a panel too narrow for it are to shrink past
 * legibility or to be read through a letterbox, and both were tried here: the
 * canvas was 1400 and every reader got a bar, then it was fitted to the panel and
 * readers below about 1015px of window got the bar back at the floor. A diagram
 * whose right half is off the visible area is a diagram whose right half nobody
 * looks at, and at 480px -- which is a declared breakpoint of this app, not a
 * hypothetical -- fitting instead of scrolling would set the card titles at about
 * four pixels.
 *
 * So neither. Below this width the page shows the drawing's TEXT EQUIVALENT,
 * which is not a second diagram and not a fallback anybody has to maintain
 * separately: it is the same list, built by `describeArchitecture` off the same
 * readings and the same clock, that a screen reader is given at every width. The
 * only thing that changes below the floor is that it stops being offscreen.
 *
 * That is deliberately NOT the 1024px collapse this page used to have. That one
 * was a second ARRANGEMENT of the same cards -- eleven absolutely-positioned
 * boxes turned into a stack -- so the page had two layouts and the narrow one was
 * the one nobody had looked at. This has one drawing and one list, and the list
 * is already asserted, line for line, by architecture-honesty.test.ts.
 *
 * The threshold is a property of the drawing, so it is derived here and copied
 * verbatim into architecture.css's CONTAINER query. A viewport query could only
 * estimate the quantity that matters; the container query reads the same panel
 * whose width JavaScript uses for scale. architecture-responsive.test.ts compares
 * the CSS threshold to this value so the two cannot drift.
 */
export function canvasFits(panelWidth: number): boolean {
  if (!Number.isFinite(panelWidth) || panelWidth <= 0) return true;
  return panelWidth >= MIN_CANVAS_PANEL;
}

/* ---------------------------------------------------------------------------
   How tall a card is
   --------------------------------------------------------------------------- */

/**
 * The box model of one card, read out of the `.arch-node` rules in
 * architecture.css. Every figure here has a declaration behind it, and
 * architecture-layout.test.ts reads that declaration back out of the stylesheet,
 * so a change to the padding fails there rather than reappearing as an overlap.
 */
/** 1px border and 8px padding, top and bottom. */
export const CARD_CHROME_HEIGHT = 18;
/** 1px border either side, 12px padding left and 10px right. */
export const CARD_CHROME_WIDTH = 24;
/** The `gap` on `.arch-node` and on `.arch-node-main`, which are the same. */
export const CARD_ROW_GAP = 3;
/** `line-height` on `.arch-node`, inherited by everything inside it. */
export const CARD_LINE_HEIGHT = 1.35;
/** `--text-xs`, which the card sets and the role, value and pills inherit. */
export const CARD_TEXT = 11;
/** `--text-base`, which only `.arch-node-label` sets. */
export const CARD_TITLE_TEXT = 13;
/** 1px padding and 1px border, top and bottom, on a status pill. */
export const PILL_CHROME_HEIGHT = 4;
/** 6px padding and 1px border, either side. */
export const PILL_CHROME_WIDTH = 14;

/**
 * How wide a glyph sets: an upper bound, chosen against the real face.
 *
 * A character count times one advance, rather than a per-glyph sum, because the
 * copy is in architecture.ts and the model has to hold for whatever is written
 * there next. So it is deliberately WIDER than DM Sans sets, and the figure it
 * is wider THAN was read out of the font this app ships rather than guessed:
 * client/public/fonts/DMSans-variable.woff2, 1000 units per em, gives 0.551em
 * for `a`, 0.879 for `m`, 0.241 for `i` and 0.269 for the space, and the twelve
 * role paragraphs average between 0.456em and 0.506em per character. 0.58 clears
 * the worst of those by 15%.
 *
 * Erring wide errs towards more lines, a taller card and more air under it,
 * which is the direction a mistake here is harmless in -- and it is only ever
 * one line out: measured against the true advances, the model gives every one of
 * the twelve paragraphs its real line count or one more, and every card title
 * one line, which is what they set at.
 *
 * The mono figure is the same 0.62em the caption checks have always used.
 */
export const SANS_ADVANCE = 0.58;
export const SANS_BOLD_ADVANCE = 0.62;
export const MONO_ADVANCE = 0.62;

/** `font-size` on `.arch-edge-label`, which is the smallest type on the page. */
export const EDGE_LABEL_TEXT = 10;

/** The height of one line of type at a given size, per `line-height: 1.45`. */
export function lineBox(fontSize: number): number {
  return fontSize * CARD_LINE_HEIGHT;
}

/**
 * How many lines a paragraph takes in a box of a given width.
 *
 * Greedy, word by word, which is what every engine does, and it never breaks
 * inside a word -- a word wider than the box gets a line of its own and
 * overflows it, which is also what an engine does and is a copy problem rather
 * than a layout one.
 *
 * THE FIRST WORD ON A LINE GOES ON IT whether it fits or not, which is the
 * clause that has to be written out rather than falling out of the loop: a
 * single word wider than the whole box otherwise scores two lines, one of them
 * empty, and every paragraph in a narrow column reads as one line taller than it
 * sets. Erring tall is the safe direction everywhere else in this file, so this
 * one is only worth the words because it errs tall for a reason that is wrong.
 */
export function wrappedLines(text: string, fontSize: number, advance: number, width: number): number {
  const per = fontSize * advance;
  let lines = 1;
  let used = 0;
  for (const word of text.trim().split(/\s+/)) {
    const wide = word.length * per;
    if (used === 0) {
      used = wide;
      continue;
    }
    if (used + per + wide <= width) {
      used += per + wide;
      continue;
    }
    lines += 1;
    used = wide;
  }
  return lines;
}

/**
 * The pills a card can carry at once, as the longest each of them prints.
 *
 * In characters rather than as the strings themselves, because the strings
 * belong to connection-status.ts and semantic-freshness.ts and copying them here
 * would be a second place for them to be wrong. architecture-layout.test.ts
 * asserts these are no shorter than the real words those modules produce, which
 * is the check that keeps them true.
 *
 *     status   'Nothing to reach'      16
 *     drift    'Pending'                7
 *     age      'Rebuilt under 1 h ago' 21
 *
 * Only the one node with a rebuild schedule can show the third, and only a
 * dependency can show the first two -- the browser and the app server report
 * that they run here and nothing else.
 *
 * THE STATUS FIGURE WAS 12, from the semantic lane's 'Not reported', and the
 * longest word a status pill can print is `CONNECTION_STATUS_LABEL`'s 'Nothing
 * to reach' at sixteen. Four characters is a whole pill row in the narrowest
 * column: Lakebase's card carries two pills in 168px of content, they fit on one
 * row at twelve and wrap to two at sixteen, so the card is 24px taller than the
 * short figure said. That is the same class of mistake as the height estimate
 * this file exists to have removed, one level down, which is why the check that
 * these are no shorter than the real words is in the test rather than in a
 * comment here.
 */
export const PILL_CHARS = { status: 16, drift: 7, age: 21 } as const;

/** How many rows a card's pills wrap into, at a given content width. */
export function pillRows(chars: readonly number[], width: number): number {
  let rows = 1;
  let used = 0;
  for (const count of chars) {
    const wide = count * CARD_TEXT * SANS_ADVANCE + PILL_CHROME_WIDTH;
    const gap = used === 0 ? 0 : CARD_ROW_GAP;
    if (used + gap + wide <= width) {
      used += gap + wide;
      continue;
    }
    rows += 1;
    used = wide;
  }
  return rows;
}

/**
 * How tall the card for one node is drawn.
 *
 * Every row `ArchitectureNodeCard` can render, in the order it renders them:
 * the title, the pills, the identifier, the role paragraph, and the link out to
 * Databricks. The last two of those are conditional in the component and are
 * counted here for every DEPENDENCY, which is the upper bound -- Lakebase and the
 * Vector Search endpoint have no workspace path this app will guess, so their
 * cards come out 20px shorter than this says. Counting a row that may not appear
 * costs a card some air underneath it; not counting one that does costs a title.
 *
 * The role paragraph is the row that actually varies, and it is where the whole
 * defect was: the Vector Search index describes itself in two sentences and
 * takes six lines, which is 72px more than the single 140px estimate allowed for
 * any card at all.
 */
export function nodeHeight(id: string): number {
  const node = ARCHITECTURE_NODES.find((candidate) => candidate.id === id);
  if (!node) return 0;
  const content = (NODE_PLACEMENTS[id]?.width ?? 0) - CARD_CHROME_WIDTH;
  const dependency = node.presence === 'connection';
  const pills =
    node.presence !== 'connection'
      ? [PILL_CHARS.status]
      : node.rebuilt
        ? [PILL_CHARS.status, PILL_CHARS.drift, PILL_CHARS.age]
        : [PILL_CHARS.status, PILL_CHARS.drift];
  const rows = pillRows(pills, content);

  const title = wrappedLines(node.label, CARD_TITLE_TEXT, SANS_BOLD_ADVANCE, content) * lineBox(CARD_TITLE_TEXT);
  const chips = rows * (lineBox(CARD_TEXT) + PILL_CHROME_HEIGHT) + (rows - 1) * CARD_ROW_GAP;
  // One line, never two: `.arch-node-value` is `nowrap` and ellipsised, which is
  // the rule that keeps a long identifier from being a taller card.
  const identifier = dependency ? CARD_ROW_GAP + lineBox(CARD_TEXT) : 0;
  const role = wrappedLines(node.role, CARD_TEXT, SANS_ADVANCE, content) * lineBox(CARD_TEXT);
  const open = dependency ? CARD_ROW_GAP + lineBox(CARD_TEXT) : 0;

  const main = title + CARD_ROW_GAP + chips + identifier;
  // Whole pixels, upward. A fractional card height is a fractional gap, and the
  // gaps below are stated as integers.
  return Math.ceil(CARD_CHROME_HEIGHT + main + CARD_ROW_GAP + role + open);
}

/**
 * The least air between two cards stacked in the same column.
 *
 * Not a pitch: the tops below are spaced by each card's own height plus at least
 * this, so one tall card pushes what is under it down rather than being drawn
 * over it. It is also enough to seat an edge caption, which three of the gaps
 * have to do -- see `conversation`, `trace` and `governed reads`, all of which
 * are placed inside their column's own x range and are only clear of the cards
 * because they sit in the space between two of them.
 *
 * IT WAS 24, AND 24 CLEARED EVERY CHECK IN THIS FILE while the tab was reported
 * as crowded. That is the distinction worth keeping: not-overlapping is what a
 * geometry test can assert, and it is not what a reader is looking at. A caption
 * of 10px type is 11px tall with its descender, so a 24px gap holding one leaves
 * about six pixels of white above and below it -- arithmetically clear, and it
 * reads as a line of text jammed between two boxes. 36 is 11 plus twelve either
 * side, which is {@link LABEL_CLEAR_MIN} applied in the other axis, so the gaps
 * that hold a caption and the gaps that do not are spaced by one rule.
 */
export const ROW_GAP_MIN = 36;

/**
 * What an edge, a dot and a card's accent edge SAY, which is never a status.
 *
 * A colour here states what kind of connection this is -- the question's path,
 * the agent itself, a Genie space, the semantic index, governed data, or
 * storage that is written during a run and never read to answer one. Status
 * lives in the pills on the card and nowhere else, so a reader cannot mistake
 * "this is the governed half" for "this half is healthy".
 */
export type ArchitectureAccent = 'question' | 'agent' | 'genie' | 'search' | 'governed' | 'kept';

/**
 * The palette token each accent paints with, named rather than written out.
 *
 * THE AGENT WAS ORANGE AND THE PALETTE HAS NONE. `--db-orange` #FF3621 painted
 * the orchestrator's accent edge, its legend swatch and the dot on every edge
 * leaving it, which made the retired colour the most-drawn hue on the tab. §2 is
 * flat about it: no orange, and the only non-palette pixels in the app are the
 * bricks symbol in the attribution and the logo on the login gate.
 *
 * Navy rather than another blue, and it is not a fallback. The question path is
 * already `--ast-blue` and a second blue beside it would collapse the one
 * distinction this drawing's colour system exists to make. Navy is the palette's
 * structural ink, it is the darkest thing on the canvas so the orchestrator stays
 * the centre of mass the orange made it, and §1 says the mark IS the agent -- the
 * mark is ink and blue, which is what this now matches.
 *
 * The remaining three `--db-*` are the drawing's own relationship vocabulary
 * rather than palette status: teal for a Genie space, light blue for the semantic
 * index, grey for storage off the answer path. architecture-tab.md names each by
 * hex and none of them is a status rung, so they are not the astrolabe families
 * under another name and are left where they are.
 */
export const ACCENT_TOKEN: Readonly<Record<ArchitectureAccent, string>> = {
  question: '--ast-blue',
  agent: '--ast-navy',
  genie: '--db-teal-600',
  search: '--db-blue-500',
  governed: '--ast-neutral-text',
  kept: '--db-grey-blue-400',
};

export interface NodeBox {
  left: number;
  top: number;
  width: number;
  /** From {@link nodeHeight}: the card's own copy, not a shared estimate. */
  height: number;
  accent: ArchitectureAccent;
}

/**
 * The placement, left to right in the order a question travels.
 *
 * The reader, then the app, then the orchestrator, then everything the
 * orchestrator talks to, then the compute and the governed source behind Genie.
 *
 * STORAGE IS THE BOTTOM ROW, and that is load-bearing rather than tidy. Lakebase
 * and the MLflow experiment sit below the two things that WRITE them, off to the
 * side of the left-to-right path, because neither is ever read to produce an
 * answer. Drawing either in line would say it was.
 *
 * The two semantic cards are the exception to that row, and they always were:
 * the index is drawn low on the far right and is on the answer path, and the
 * endpoint that hosts it sits in the column to its right, beneath the warehouse
 * and the catalog. That column is what-runs-it -- Genie's SQL runs on the
 * warehouse, a search runs on the endpoint -- so the pairing is the one the rest
 * of the drawing already uses.
 *
 * THE TOPS ARE SPACED OFF THE HEIGHTS rather than off a pitch, which is the fix
 * for the overlap. Every one of them is still a literal, because where a card
 * sits is a decision the design made. What is no longer a decision is how much
 * room a card needs; architecture-layout.test.ts checks each column against
 * {@link nodeHeight} plus {@link ROW_GAP_MIN} rather than trusting the
 * arithmetic that produced these:
 *
 *     x=222    app 190 + 105 = 295      ->  lakebase 644     (349, the drop to
 *                                                             the storage row)
 *     x=476    agent 160 + 148 = 308    ->  finder 352       (44)
 *              finder 352 + 105 = 457   ->  experiment 644   (187, same drop)
 *     x=754    llm 36 + 126 = 162       ->  dictionary 206   (44)
 *              dictionary 206 + 126 = 332 -> data 396        (64, the channel)
 *              data 396 + 126 = 522     ->  index 566        (44)
 *     x=1054   warehouse 260 + 148 = 408 -> catalog 452      (44)
 *              catalog 452 + 148 = 600  ->  endpoint 644     (44)
 *
 * The columns do not overlap sideways, so those seven pairs are the whole of the
 * collision question for the cards.
 *
 * 44 IS THE RHYTHM AND THE TWO EXCEPTIONS BOTH SAY SOMETHING. The 64 between the
 * two Genie cards is the corridor the finder's line to the warehouse runs along:
 * that edge has to cross this column, so it crosses it in a gap widened to leave
 * 32px of white above and below the line rather than threading whatever the
 * minimum happened to leave. The 349 and the 187 are the drop to the storage row,
 * which is the one place in this drawing where distance carries meaning -- see
 * below.
 *
 * THE STORAGE ROW IS A ROW AGAIN. Lakebase, the experiment and the Vector Search
 * endpoint share one top, 644, so the bottom of the canvas reads as a single band
 * rather than as three cards that each drifted low by a different amount. 644 is
 * not chosen: it is where the right-hand column's own 44px rhythm puts the
 * endpoint, and the two stores are brought to it. Their tops have to be below
 * every card on the answer path for architecture-layout.test.ts to accept them as
 * the bottom row, and the lowest of those is the catalog at 452, so the band could
 * not have been raised much further anyway.
 *
 * THE LEFT SPINE IS FLAT. Browser, app and orchestrator are placed so that one y
 * -- 242 -- lies inside all three, which is what lets the first two edges be
 * straight horizontal lines instead of curves that correct for a 20px difference
 * nobody chose. The tops differ because the heights do.
 */
const NODE_PLACEMENTS: Readonly<Record<string, Omit<NodeBox, 'height'>>> = {
  browser: { left: 12, top: 186, width: 128, accent: 'question' },
  app: { left: 222, top: 190, width: 172, accent: 'question' },
  'agent-endpoint': { left: 476, top: 160, width: 196, accent: 'agent' },
  'data-source-finder': { left: 476, top: 352, width: 196, accent: 'agent' },
  lakebase: { left: 222, top: 644, width: 172, accent: 'kept' },
  'experiment-id': { left: 476, top: 644, width: 196, accent: 'kept' },
  'llm-endpoint': { left: 754, top: 36, width: 218, accent: 'agent' },
  'genie-dictionary': { left: 754, top: 206, width: 218, accent: 'genie' },
  'genie-data': { left: 754, top: 396, width: 218, accent: 'genie' },
  'semantic-index': { left: 754, top: 566, width: 218, accent: 'search' },
  'sql-warehouse': { left: 1054, top: 260, width: 198, accent: 'governed' },
  catalog: { left: 1054, top: 452, width: 198, accent: 'governed' },
  'semantic-index-endpoint': { left: 1054, top: 644, width: 198, accent: 'search' },
};

/**
 * The same table with each card's real height on it.
 *
 * Where the card sits is stated and how tall it is derived, which is the split
 * this file now turns on: the design chose the first, and the copy the
 * deployment reports decides the second.
 */
export const NODE_BOXES: Readonly<Record<string, NodeBox>> = Object.fromEntries(
  Object.entries(NODE_PLACEMENTS).map(([id, placement]) => [id, { ...placement, height: nodeHeight(id) }])
);

/** The ids of the nodes whose cards sit on the bottom row of the canvas. */
export const BOTTOM_ROW_NODES: readonly string[] = ['lakebase', 'experiment-id'];

export function nodeBox(id: string): NodeBox | undefined {
  return NODE_BOXES[id];
}

/** Where a caption sits relative to the point it is placed at. */
export type LabelAnchor = 'start' | 'middle' | 'end';

export interface DrawnEdge {
  id: string;
  from: string;
  to: string;
  /** Flow edges animate from `from` to `to`; hosting edges remain static. */
  relationship: 'flow' | 'hosting';
  /** The sentence this edge means, for the text the diagram is read as. */
  meaning: string;
  /** The two or three words drawn beside the line. */
  label: string;
  d: string;
  labelX: number;
  labelY: number;
  labelAnchor: LabelAnchor;
  /** The accent this connection is, which decides the travelling dot's colour. */
  accent: ArchitectureAccent;
  /** Seconds for one traversal, and how long after the others it starts. */
  duration: number;
  delay: number;
}

/* ---------------------------------------------------------------------------
   How a line gets from one card to another
   --------------------------------------------------------------------------- */

/** Which of a card's four edges a line leaves from, or arrives at. */
export type CardSide = 'top' | 'right' | 'bottom' | 'left';

/**
 * A point on a card's border, as the card's own measurement.
 *
 * `along` is the distance from the card's TOP-LEFT CORNER down its side, or
 * across its top or bottom. Stated that way rather than as a canvas coordinate
 * because it is the quantity that stays true when the card moves: "the second
 * line out of the finder leaves 32px down its right edge" survives a re-space,
 * and `y: 535` does not. Every arrival coordinate in the old table had to be
 * re-typed when the middle column was re-spaced, and the comment that said so
 * was sitting in this file.
 */
export interface EdgeEnd {
  side: CardSide;
  along: number;
}

/**
 * How far down a card a line arrives, by default.
 *
 * Under the title and level with the status pill, which is the row a reader's
 * eye is already on when they follow a line into a card. A card with two lines
 * into it gives the second one its own arrival further down; a card entered from
 * above or below is entered at the middle of that edge instead.
 */
export const ENTRY_DROP = 50;

/**
 * The four shapes an edge may be, and there are deliberately only four.
 *
 * A drawing whose connectors are each a one-off is a drawing a reader cannot
 * learn: fourteen hand-written cubics were fourteen different relationships
 * between a line's start, its handles and its end, and the reported symptom was
 * exactly that -- "the paths are very mixed and hard to follow, weirdly curved".
 *
 *   - `straight`  the two ends share an axis, so the line is one `H` or one `V`.
 *                 The plainest connector there is, and the first two edges of the
 *                 question path are now both of them.
 *   - `curve`     one cubic, with BOTH handles on the vertical line half way
 *                 between the two ends. That is the only cubic in this file, and
 *                 the constraint is what makes it readable: x moves one way for
 *                 the whole curve, the tangent is horizontal at both ends, and
 *                 two of them side by side are the same shape at different
 *                 scales. The old handles were at 716 and 700 -- the first to the
 *                 RIGHT of the second -- which is a curve that leaves the card,
 *                 turns back on itself, and kinks in the middle.
 *   - `channel`   for the one edge that skips a column. A `curve`'s worth of bend
 *                 in the corridor, onto the y it will arrive at, then a straight
 *                 run across the column it has to cross. A skip edge cannot avoid
 *                 crossing a column, so it crosses it as a horizontal line
 *                 through a gap widened for it rather than as a diagonal through
 *                 whatever room was left.
 *   - `bracket`   for the one edge that has to get past a card in its own column.
 *                 Out sideways into the corridor, down it, and back in at the
 *                 same x it left -- square, with rounded corners. The old path
 *                 did this as a single cubic bulging 120px left, which reads as a
 *                 line that has come loose rather than as a line going round
 *                 something.
 */
export type Route =
  | { kind: 'straight' }
  | { kind: 'curve' }
  | { kind: 'channel' }
  | { kind: 'bracket'; channelX: number };

/** The radius the `bracket` corners turn on. */
export const BRACKET_RADIUS = 14;

/** Whole pixels where the arithmetic gives them, and no trailing zeros. */
function coordinate(value: number): string {
  return `${Number(value.toFixed(2))}`;
}

/** Where an {@link EdgeEnd} lands on the canvas. */
export function edgePoint(box: NodeBox, end: EdgeEnd): { x: number; y: number } {
  switch (end.side) {
    case 'top':
      return { x: box.left + end.along, y: box.top };
    case 'bottom':
      return { x: box.left + end.along, y: box.top + box.height };
    case 'left':
      return { x: box.left, y: box.top + end.along };
    case 'right':
      return { x: box.left + box.width, y: box.top + end.along };
  }
}

/**
 * The path string for one edge, from the two cards it joins.
 *
 * Derived rather than written down, which is the whole of the fix for lines that
 * disagreed with the cards they claimed to touch. The dot travelling along an
 * edge is given THIS string as its motion path -- see ArchitecturePage -- so a
 * path derived from the boxes is also the only way the dot and the line cannot
 * be drawn from different ideas of where the edge is.
 */
export function edgePath(from: NodeBox, to: NodeBox, edge: { from: EdgeEnd; to: EdgeEnd; route: Route }): string {
  const start = edgePoint(from, edge.from);
  const end = edgePoint(to, edge.to);
  const open = `M ${coordinate(start.x)} ${coordinate(start.y)}`;

  switch (edge.route.kind) {
    case 'straight':
      return start.y === end.y ? `${open} H ${coordinate(end.x)}` : `${open} V ${coordinate(end.y)}`;
    case 'curve': {
      const handle = coordinate((start.x + end.x) / 2);
      return `${open} C ${handle} ${coordinate(start.y)} ${handle} ${coordinate(end.y)} ${coordinate(end.x)} ${coordinate(end.y)}`;
    }
    // The bend is spent in the corridor the edge leaves into, so the straight
    // run begins exactly at the column boundary and the crossing is level.
    case 'channel': {
      const sideways = end.x > start.x ? COLUMN_GAP : -COLUMN_GAP;
      const handle = coordinate(start.x + sideways / 2);
      const join = coordinate(start.x + sideways);
      return (
        `${open} C ${handle} ${coordinate(start.y)} ${handle} ${coordinate(end.y)} ${join} ${coordinate(end.y)}` +
        ` H ${coordinate(end.x)}`
      );
    }
    case 'bracket': {
      const channel = edge.route.channelX;
      // Which way the detour leaves, so one helper draws the mirror image too.
      const inward = channel < start.x ? BRACKET_RADIUS : -BRACKET_RADIUS;
      return [
        open,
        `H ${coordinate(channel + inward)}`,
        `Q ${coordinate(channel)} ${coordinate(start.y)} ${coordinate(channel)} ${coordinate(start.y + BRACKET_RADIUS)}`,
        `V ${coordinate(end.y - BRACKET_RADIUS)}`,
        `Q ${coordinate(channel)} ${coordinate(end.y)} ${coordinate(channel + inward)} ${coordinate(end.y)}`,
        `H ${coordinate(end.x)}`,
      ].join(' ');
    }
  }
}

/**
 * Where each edge leaves, where it arrives, what shape it is, and what it says.
 *
 * Keyed by the pair of nodes it joins, so this table answers the geometry
 * question for a connection the model already declares -- it does not decide
 * which connections exist.
 *
 * THE CAPTIONS ARE STILL PLACED BY HAND, and they are the one thing here that
 * should be: where a word reads best is a judgement, and the checks in
 * architecture-layout.test.ts are what keep the judgement honest -- every caption
 * has to stand {@link LABEL_CLEAR_MIN} clear of every card and of every other
 * caption, at every scale the drawing is fitted to.
 *
 * The captions name the RELATIONSHIP and never a measurement. Nothing in this
 * app times an individual dependency, so a duration on an edge would be a number
 * nobody read.
 */
const EDGE_GEOMETRY: Readonly<
  Record<
    string,
    {
      id: string;
      label: string;
      from: EdgeEnd;
      to: EdgeEnd;
      route: Route;
      labelX: number;
      labelY: number;
      labelAnchor?: LabelAnchor;
      accent: ArchitectureAccent;
      duration: number;
      delay: number;
    }
  >
> = {
  // The two straight ones. 242 lies inside all three cards of the left spine, so
  // these are horizontal lines and not corrections for a difference nobody chose.
  'browser->app': {
    id: 'pe1',
    label: 'question',
    from: { side: 'right', along: 56 },
    to: { side: 'left', along: 52 },
    route: { kind: 'straight' },
    labelX: 181,
    labelY: 232,
    labelAnchor: 'middle',
    accent: 'question',
    duration: 2.4,
    delay: 0,
  },
  'app->agent-endpoint': {
    id: 'pe2',
    label: 'invoke',
    from: { side: 'right', along: 52 },
    to: { side: 'left', along: 82 },
    route: { kind: 'straight' },
    labelX: 435,
    labelY: 232,
    labelAnchor: 'middle',
    accent: 'question',
    duration: 2.4,
    delay: 0.9,
  },
  // Both stores hang off the middle of the card that writes them, which is what
  // makes the drop read as "this is kept" rather than as another hop on the way
  // to an answer.
  'app->lakebase': {
    id: 'pe3',
    label: 'conversation',
    from: { side: 'bottom', along: 86 },
    to: { side: 'top', along: 86 },
    route: { kind: 'straight' },
    labelX: 322,
    labelY: 470,
    accent: 'kept',
    duration: 3.2,
    delay: 0,
  },
  // THE ONE EDGE WITH A CARD IN ITS WAY. The finder sits between the orchestrator
  // and the experiment in the same column, so the trace cannot go straight down;
  // it goes out into the corridor at 435, which is clear of the column by 41 on
  // one side and of the app's column by 41 on the other, and comes back in at the
  // x it left. Leaving from the LEFT edge rather than the bottom keeps it out of
  // the 44px gap that holds "delegate".
  'agent-endpoint->experiment-id': {
    id: 'pe4',
    label: 'trace',
    from: { side: 'left', along: 120 },
    to: { side: 'left', along: ENTRY_DROP },
    route: { kind: 'bracket', channelX: 435 },
    labelX: 480,
    labelY: 560,
    accent: 'kept',
    duration: 3.2,
    delay: 1.4,
  },
  'agent-endpoint->llm-endpoint': {
    id: 'pe5',
    label: 'plan + prose',
    from: { side: 'right', along: 40 },
    to: { side: 'left', along: ENTRY_DROP },
    route: { kind: 'curve' },
    // Above the orchestrator rather than beside the line: twelve characters do
    // not fit in an 82px corridor, and the space over the top of that column is
    // the nearest white this caption has.
    labelX: 700,
    labelY: 140,
    labelAnchor: 'middle',
    accent: 'agent',
    duration: 2.8,
    delay: 0,
  },
  'agent-endpoint->data-source-finder': {
    id: 'pe12',
    label: 'delegate',
    from: { side: 'bottom', along: 98 },
    to: { side: 'top', along: 98 },
    route: { kind: 'straight' },
    labelX: 586,
    labelY: 333,
    accent: 'agent',
    duration: 2.4,
    delay: 0.4,
  },
  /*
   * THE FAN, AND THE ONE RULE THAT KEEPS IT UNTANGLED. Five lines leave the
   * finder's right edge and the order they leave in is the order they arrive in,
   * top to bottom: the model at 14, the dictionary at 32, the warehouse channel
   * at 50, the data space at 68, the index at 86. Two lines out of one card
   * cross if and only if that ordering is broken, so the `along` figures below
   * are not spacing, they are the reason nothing here crosses anything.
   */
  'data-source-finder->llm-endpoint': {
    id: 'pe13',
    label: 'reason',
    from: { side: 'right', along: 14 },
    // 74 rather than 50: the model is the one card two lines arrive at, and the
    // second one takes its own row so the two do not meet at the border.
    to: { side: 'left', along: 74 },
    route: { kind: 'curve' },
    labelX: 713,
    labelY: 226,
    labelAnchor: 'middle',
    accent: 'agent',
    duration: 2.8,
    delay: 0.5,
  },
  'data-source-finder->genie-dictionary': {
    id: 'pe6',
    label: 'terms',
    from: { side: 'right', along: 32 },
    to: { side: 'left', along: ENTRY_DROP },
    route: { kind: 'curve' },
    labelX: 713,
    labelY: 320,
    labelAnchor: 'middle',
    accent: 'genie',
    duration: 2.8,
    delay: 0.7,
  },
  'data-source-finder->genie-data': {
    id: 'pe7',
    label: 'metrics',
    from: { side: 'right', along: 68 },
    to: { side: 'left', along: ENTRY_DROP },
    route: { kind: 'curve' },
    labelX: 713,
    labelY: 433,
    labelAnchor: 'middle',
    accent: 'genie',
    duration: 2.8,
    delay: 1.4,
  },
  'data-source-finder->semantic-index': {
    id: 'pe8',
    label: 'search',
    from: { side: 'right', along: 86 },
    to: { side: 'left', along: ENTRY_DROP },
    route: { kind: 'curve' },
    labelX: 713,
    labelY: 527,
    labelAnchor: 'middle',
    accent: 'search',
    duration: 2.8,
    delay: 1.8,
  },
  // The skip. It arrives 104 down the warehouse -- not the usual 50 -- because
  // the arrival y IS the channel: the run across the Genie column is level, and
  // the channel is the middle of the 64px gap those two cards are spaced by.
  'data-source-finder->sql-warehouse': {
    id: 'pe14',
    label: 'resolve + SQL',
    from: { side: 'right', along: ENTRY_DROP },
    to: { side: 'left', along: 104 },
    route: { kind: 'channel' },
    // In the gap it runs through rather than in a corridor: thirteen characters
    // need 105px of white and no corridor here is wider than 82.
    labelX: 863,
    labelY: 356,
    labelAnchor: 'middle',
    accent: 'governed',
    duration: 3,
    delay: 1.8,
  },
  // A static topology connector: the endpoint hosts the index, but no request or
  // result travels from the endpoint to the index along this line.
  'semantic-index-endpoint->semantic-index': {
    id: 'pe11',
    label: 'hosts',
    from: { side: 'left', along: ENTRY_DROP },
    to: { side: 'right', along: 94 },
    route: { kind: 'curve' },
    labelX: 1013,
    labelY: 645,
    labelAnchor: 'middle',
    accent: 'search',
    duration: 2.8,
    delay: 1.1,
  },
  'genie-data->sql-warehouse': {
    id: 'pe9',
    label: 'SQL',
    from: { side: 'right', along: 64 },
    // Below the channel the finder's line arrives on, so the warehouse's two
    // incoming lines stay 20px apart at the border instead of meeting on it.
    to: { side: 'left', along: 124 },
    route: { kind: 'curve' },
    labelX: 1013,
    labelY: 405,
    labelAnchor: 'middle',
    accent: 'governed',
    duration: 2.4,
    delay: 0,
  },
  // The one connector with a card above it AND a card below it, which is what
  // makes the 44px gap between the warehouse and the catalog load-bearing: this
  // line is all of it and its caption stands beside it in the same space.
  'sql-warehouse->catalog': {
    id: 'pe10',
    label: 'governed reads',
    from: { side: 'bottom', along: 99 },
    to: { side: 'top', along: 99 },
    route: { kind: 'straight' },
    labelX: 1165,
    labelY: 432,
    accent: 'governed',
    duration: 2.4,
    delay: 1.2,
  },
};

/**
 * Every edge in the model, with the geometry that draws it.
 *
 * Driven from `ARCHITECTURE_EDGES` rather than from the table above, so an edge
 * added to the model and not to the geometry is a missing line that
 * architecture-layout.test.ts names, rather than a line drawn to the origin that
 * looks like a connection to something unlabelled.
 */
export function drawnEdges(): DrawnEdge[] {
  const drawn: DrawnEdge[] = [];
  for (const edge of ARCHITECTURE_EDGES) {
    const geometry = EDGE_GEOMETRY[`${edge.from}->${edge.to}`];
    if (!geometry) continue;
    const from = NODE_BOXES[edge.from];
    const to = NODE_BOXES[edge.to];
    if (!from || !to) continue;
    drawn.push({
      id: geometry.id,
      from: edge.from,
      to: edge.to,
      relationship: edge.relationship,
      meaning: edge.meaning,
      label: geometry.label,
      d: edgePath(from, to, geometry),
      labelX: geometry.labelX,
      labelY: geometry.labelY,
      labelAnchor: geometry.labelAnchor ?? 'start',
      accent: geometry.accent,
      duration: geometry.duration,
      delay: geometry.delay,
    });
  }
  return drawn;
}

/** Every number in a path, in order, which is enough to check its ends. */
export function pathPoints(d: string): number[] {
  return (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
}

/**
 * A path as a run of straight segments, close enough to measure.
 *
 * THE CHECK THIS FILE COULD NOT MAKE. Everything about an edge was asserted from
 * the NUMBERS IN ITS PATH STRING -- the first pair, the last pair, and whether
 * any of them left the canvas -- and a curve is not its control points. That is
 * how an edge came to run across the whole middle column, over the gap between
 * two cards, crossing three other edges: every number in it was inside the
 * canvas and its ends were on the two cards it joined, and nothing here could
 * ask where it went in between.
 *
 * Flattened rather than solved, at 24 steps a curve, because the questions being
 * asked of it are "does this line cross a card" and "does this line cross that
 * line" and both are answered to the pixel by a fine enough polyline. Nothing
 * measures a path in the browser; this is the same arithmetic the engine does,
 * done here where a test can see it.
 */
export function pathPolyline(d: string, perCurve = 24): Array<{ x: number; y: number }> {
  const tokens = d.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) ?? [];
  const points: Array<{ x: number; y: number }> = [];
  let at = { x: 0, y: 0 };
  let read = 0;
  const next = () => Number(tokens[read++]);

  while (read < tokens.length) {
    const command = tokens[read++];
    switch (command) {
      case 'M':
      case 'L':
        at = { x: next(), y: next() };
        points.push(at);
        break;
      case 'H':
        at = { x: next(), y: at.y };
        points.push(at);
        break;
      case 'V':
        at = { x: at.x, y: next() };
        points.push(at);
        break;
      case 'C': {
        const first = { x: next(), y: next() };
        const second = { x: next(), y: next() };
        const end = { x: next(), y: next() };
        for (let step = 1; step <= perCurve; step += 1) {
          points.push(cubicPoint(at, first, second, end, step / perCurve));
        }
        at = end;
        break;
      }
      case 'Q': {
        const handle = { x: next(), y: next() };
        const end = { x: next(), y: next() };
        for (let step = 1; step <= perCurve; step += 1) {
          const t = step / perCurve;
          points.push(
            cubicPoint(
              at,
              { x: at.x + (2 / 3) * (handle.x - at.x), y: at.y + (2 / 3) * (handle.y - at.y) },
              { x: end.x + (2 / 3) * (handle.x - end.x), y: end.y + (2 / 3) * (handle.y - end.y) },
              end,
              t
            )
          );
        }
        at = end;
        break;
      }
      default:
        throw new Error(`the architecture paths use no ${command} command`);
    }
  }
  return points;
}

function cubicPoint(
  from: { x: number; y: number },
  first: { x: number; y: number },
  second: { x: number; y: number },
  to: { x: number; y: number },
  t: number
): { x: number; y: number } {
  const inverse = 1 - t;
  const a = inverse * inverse * inverse;
  const b = 3 * inverse * inverse * t;
  const c = 3 * inverse * t * t;
  const e = t * t * t;
  return {
    x: a * from.x + b * first.x + c * second.x + e * to.x,
    y: a * from.y + b * first.y + c * second.y + e * to.y,
  };
}

/**
 * Where a path starts and where it ends.
 *
 * Read off the flattened path rather than off its numbers, which is what lets an
 * edge be any of the four shapes above: the old version tested the string for an
 * `H` or a `V` and inherited the other axis from the start point, so a path with
 * both -- which the bracket and the channel are -- came back with an end point
 * that was never on it.
 */
export function pathEnds(d: string): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const points = pathPolyline(d);
  return { start: points[0], end: points[points.length - 1] };
}

/** Whether a point falls inside a card's footprint. */
export function insideBox(box: NodeBox, point: { x: number; y: number }): boolean {
  return point.x > box.left && point.x < box.left + box.width && point.y > box.top && point.y < box.top + box.height;
}

/** Whether two cards would be drawn over one another. */
export function boxesOverlap(a: NodeBox, b: NodeBox): boolean {
  return rectsOverlap(a, b);
}

/**
 * Whether a straight run of a path passes through a rectangle's inside.
 *
 * Liang-Barsky, against a rectangle pulled in by half a pixel at every edge,
 * because every edge on this drawing deliberately TOUCHES two cards -- it starts
 * on one border and ends on another. Without the inset, every line would be
 * reported as running through both of the cards it joins and the check would be
 * useless.
 */
function segmentEntersRect(
  from: { x: number; y: number },
  to: { x: number; y: number },
  rect: Rect,
  inset = 0.5
): boolean {
  const bounds: Array<[number, number]> = [
    [-(to.x - from.x), from.x - (rect.left + inset)],
    [to.x - from.x, rect.left + rect.width - inset - from.x],
    [-(to.y - from.y), from.y - (rect.top + inset)],
    [to.y - from.y, rect.top + rect.height - inset - from.y],
  ];
  let enters = 0;
  let leaves = 1;
  for (const [along, room] of bounds) {
    if (along === 0) {
      if (room < 0) return false;
      continue;
    }
    const at = room / along;
    if (along < 0) {
      if (at > leaves) return false;
      if (at > enters) enters = at;
    } else {
      if (at < enters) return false;
      if (at < leaves) leaves = at;
    }
  }
  return enters < leaves;
}

/**
 * Every edge that is drawn over a card, and which card.
 *
 * THE DEFECT NOTHING IN THIS FILE COULD SEE. A path was checked at its two ends
 * and at its control points, so an edge could leave the finder, cross the whole
 * Genie column and arrive at the warehouse while every assertion about it passed.
 * A line under a card is worse than a missing line: the card is opaque, so the
 * reader sees a connector that stops at one border and starts again at another
 * and reads it as two connections.
 */
export function edgesThroughCards(): Array<{ edge: string; node: string }> {
  const through: Array<{ edge: string; node: string }> = [];
  for (const edge of drawnEdges()) {
    for (const [id, box] of Object.entries(NODE_BOXES)) {
      if (edgeEntersCard(edge.d, box)) through.push({ edge: `${edge.id} "${edge.label}"`, node: id });
    }
  }
  return through;
}

/** Whether one path is drawn across the inside of one card. */
export function edgeEntersCard(d: string, box: Rect): boolean {
  const points = pathPolyline(d);
  return points.some((point, at) => at > 0 && segmentEntersRect(points[at - 1], point, box));
}

/**
 * Where two straight runs meet, if they meet anywhere.
 *
 * The point rather than a yes/no, because whether a meeting is a defect depends
 * on WHERE it is: two lines are allowed to meet on a card they both touch and are
 * not allowed to meet anywhere else. An earlier form of this answered "do they
 * properly cross" and dismissed anything that merely grazed, which threw away the
 * case it most needed to catch -- two curves that are each other's mirror image
 * meet at exactly one point in the middle, and a graze there is a crossing.
 *
 * Parallel runs return nothing. Two edges laid along the same corridor at the
 * same x would be an overlap rather than a crossing, and it is the rectangle
 * checks further down that are shaped to catch things drawn on top of each other.
 */
function segmentsMeet(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number }
): { x: number; y: number } | null {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const cdx = d.x - c.x;
  const cdy = d.y - c.y;
  const denominator = abx * cdy - aby * cdx;
  if (denominator === 0) return null;
  const along = ((c.x - a.x) * cdy - (c.y - a.y) * cdx) / denominator;
  const across = ((c.x - a.x) * aby - (c.y - a.y) * abx) / denominator;
  if (along < 0 || along > 1 || across < 0 || across > 1) return null;
  return { x: a.x + abx * along, y: a.y + aby * along };
}

/**
 * Every pair of edges that cross each other on the canvas.
 *
 * Zero is the answer this layout is arranged for, and it is arranged for it in
 * three ways rather than by luck: the five lines out of the finder leave in the
 * order they arrive, the edge that skips a column crosses it in its own channel,
 * and the edge that has to get past a card in its own column goes round it in the
 * corridor. Each of those is one decision in the tables above, and each of them
 * is undone by a plausible-looking edit -- so the consequence is asserted here
 * rather than left as three comments hoping to be read together.
 */
export function crossingEdges(): Array<[string, string]> {
  const lines = drawnEdges().map((edge) => ({ id: `${edge.id} "${edge.label}"`, d: edge.d }));
  const crossings: Array<[string, string]> = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      if (pathsCross(lines[i].d, lines[j].d)) crossings.push([lines[i].id, lines[j].id]);
    }
  }
  return crossings;
}

/**
 * Whether two paths cross, as opposed to meeting on a card they both touch.
 *
 * Two lines into one card meet at that card, and that is the drawing working: it
 * is how a reader sees that two things talk to the same thing. So a meeting is
 * only reported when it is somewhere other than a point that ends both paths.
 */
export function pathsCross(a: string, b: string): boolean {
  const one = pathPolyline(a);
  const other = pathPolyline(b);
  const terminals = [one[0], one[one.length - 1]];
  const far = [other[0], other[other.length - 1]];
  const shared = (point: { x: number; y: number }) =>
    terminals.some((end) => Math.hypot(end.x - point.x, end.y - point.y) < 0.001) &&
    far.some((end) => Math.hypot(end.x - point.x, end.y - point.y) < 0.001);

  for (let at = 1; at < one.length; at += 1) {
    for (let past = 1; past < other.length; past += 1) {
      const met = segmentsMeet(one[at - 1], one[at], other[past - 1], other[past]);
      if (met && !shared(met)) return true;
    }
  }
  return false;
}

/* ---------------------------------------------------------------------------
   What is drawn where, as rectangles

   THE CHECK THIS FILE DID NOT HAVE. Everything above compares a card to the
   canvas and a caption's ANCHOR POINT to a card. Neither of those notices two
   cards occupying the same pixels, which is what shipped: the Dictionary Genie
   card reached 8px into the Data Genie card below it, and because a card is
   opaque and painted in model order, the lower one lost its title. A drawing
   whose own geometry cannot answer "does anything overlap anything" is a drawing
   that will do it again.
   --------------------------------------------------------------------------- */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Whether two rectangles share any pixels. Touching edges do not count. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  const apart =
    a.left + a.width <= b.left || b.left + b.width <= a.left || a.top + a.height <= b.top || b.top + b.height <= a.top;
  return !apart;
}

/**
 * How far a caption's glyphs reach above and below the point it is placed at.
 *
 * `labelY` is an SVG baseline, not a top edge, so a caption occupies the band
 * above it plus a descender below. 8 and 3 at 10px are an upper bound on the
 * ascent and descent of a mono face at that size, in the same spirit as
 * {@link MONO_ADVANCE}: wider than the truth, in the direction that refuses a
 * placement which would in fact have fitted.
 */
export const LABEL_ASCENT = 8;
export const LABEL_DESCENT = 3;

/**
 * The least white a caption may have between it and any card beside it.
 *
 * THE NUMBER THAT WAS MISSING, and the reason "the labels sit on the cards" was
 * reported against a layout in which every check passed. Everything in this file
 * asked whether two rectangles INTERSECT. Nothing asked how far apart they are,
 * and the answers were: "question" 1.2px from both cards it stands between,
 * "invoke" and "serves" 4.4px, "metrics" 7px. None of those is an overlap and all
 * of them read as one, because a caption a pixel from a card's border looks like
 * a caption printed on it -- which is exactly why the halo in architecture.css
 * had to be added to keep them legible. The halo treated the symptom.
 *
 * 12px, which is a little over one line's worth of the 10px type the captions are
 * set in. Every corridor in the width table is now the longest word standing in
 * it plus this at each end, and {@link ROW_GAP_MIN} is the same rule turned
 * ninety degrees. Applied through {@link labelClearances}, which is asserted at
 * every scale the fit function produces -- `zoom` multiplies a clearance by the
 * same fraction it multiplies everything else, so 12px at full size is 8.5px at
 * the floor and that is the narrowest it ever gets.
 */
export const LABEL_CLEAR_MIN = 12;

/**
 * The rectangle a caption's words actually occupy.
 *
 * The anchor decides which end of that rectangle `labelX` is, which is the part
 * a check on the anchor point alone cannot see: "governed reads" anchored at
 * 1155 reaches to 1242, and whether that is clear of the card beside it is a
 * question about the width of the word rather than about the point.
 */
export function labelRect(edge: DrawnEdge): Rect {
  const width = edge.label.length * EDGE_LABEL_TEXT * MONO_ADVANCE;
  const left =
    edge.labelAnchor === 'end'
      ? edge.labelX - width
      : edge.labelAnchor === 'middle'
        ? edge.labelX - width / 2
        : edge.labelX;
  return { left, top: edge.labelY - LABEL_ASCENT, width, height: LABEL_ASCENT + LABEL_DESCENT };
}

/**
 * Everything the drawing puts on the canvas, named, as rectangles.
 *
 * The cards and the captions in one list, because the collision that broke this
 * tab was a card over a card and the collision it was rebuilt to prevent was a
 * card over a caption. Two checks over two lists is how one of them ends up
 * being the one nobody wrote.
 */
export function drawnRects(): Array<{ id: string; rect: Rect }> {
  const drawn: Array<{ id: string; rect: Rect }> = Object.entries(NODE_BOXES).map(([id, box]) => ({
    id,
    rect: { left: box.left, top: box.top, width: box.width, height: box.height },
  }));
  for (const edge of drawnEdges()) {
    drawn.push({ id: `${edge.id} "${edge.label}"`, rect: labelRect(edge) });
  }
  return drawn;
}

/** Every pair of things on the canvas that would be drawn on top of each other. */
export function overlappingRects(): Array<[string, string]> {
  const drawn = drawnRects();
  const collisions: Array<[string, string]> = [];
  for (let i = 0; i < drawn.length; i += 1) {
    for (let j = i + 1; j < drawn.length; j += 1) {
      if (rectsOverlap(drawn[i].rect, drawn[j].rect)) collisions.push([drawn[i].id, drawn[j].id]);
    }
  }
  return collisions;
}

/**
 * How much white lies between two rectangles, and `null` where they overlap.
 *
 * The straight-line distance between them, which is the one measure that matches
 * what a reader sees. Taking the smaller of the two axis separations instead --
 * which is the obvious thing to write, and was written here first -- scores
 * "question" as 9px from "invoke" because their bands of y are 9px apart, while
 * the two captions are two hundred pixels apart on the canvas and no reader could
 * relate them. Two rectangles offset on both axes are apart by their corners.
 *
 * `null` rather than 0 for an overlap, deliberately: an overlap is
 * {@link overlappingRects}'s to report, by name, and scoring it as a clearance of
 * zero would let a collision satisfy any floor stated as "at least".
 */
export function rectGap(a: Rect, b: Rect): number | null {
  const sideways = Math.max(b.left - (a.left + a.width), a.left - (b.left + b.width));
  const upright = Math.max(b.top - (a.top + a.height), a.top - (b.top + b.height));
  if (sideways < 0 && upright < 0) return null;
  return Math.hypot(Math.max(sideways, 0), Math.max(upright, 0));
}

/**
 * Every caption, with the tightest white between it and anything else drawn.
 *
 * Against the CARDS and against the OTHER CAPTIONS, in one list, because both
 * have gone wrong: the cards crowded the captions in the corridors between the
 * columns, and the three captions in the corridor beside the orchestrator are
 * stacked closely enough that a longer word in any of them would meet the one
 * below. A caption whose only neighbours are diagonally away from it reports
 * `Infinity`, which is the honest answer and passes any floor.
 */
export function labelClearances(scale = 1): Array<{ id: string; nearest: string; gap: number }> {
  const scaled = (rect: Rect): Rect => ({
    left: rect.left * scale,
    top: rect.top * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  });
  const cards = Object.entries(NODE_BOXES).map(([id, box]) => ({
    id,
    rect: scaled({ left: box.left, top: box.top, width: box.width, height: box.height }),
  }));
  const captions = drawnEdges().map((edge) => ({ id: `${edge.id} "${edge.label}"`, rect: scaled(labelRect(edge)) }));

  return captions.map((caption, index) => {
    let gap = Number.POSITIVE_INFINITY;
    let nearest = 'nothing';
    for (const other of [...cards, ...captions.filter((_, at) => at !== index)]) {
      const between = rectGap(caption.rect, other.rect);
      // `null` is an overlap, which overlappingRects reports by name. Scoring it
      // as 0 here would fold two different faults into one number.
      if (between === null || between >= gap) continue;
      gap = between;
      nearest = other.id;
    }
    return { id: caption.id, nearest, gap };
  });
}

/**
 * The drawing's own left and right edges once fitted into a panel of a width.
 *
 * The leftmost card's left and the rightmost card's right, scaled, which is what
 * a reader means by "the first card is cut off": not that the canvas overflowed,
 * but that a card did. Stated as a function so the check is over the composition
 * of {@link canvasScale} and the placement table rather than over either alone --
 * the two were each correct while a fit computed to the pixel put a scrollbar
 * under the drawing and a scroll offset over the left-hand card.
 */
export function fittedSpan(panelWidth: number): { left: number; right: number; width: number } {
  const scale = canvasScale(panelWidth);
  const boxes = Object.values(NODE_BOXES);
  return {
    left: Math.min(...boxes.map((box) => box.left)) * scale,
    right: Math.max(...boxes.map((box) => box.left + box.width)) * scale,
    width: CANVAS_WIDTH * scale,
  };
}

/** Every pair of cards that would be drawn on top of each other. */
export function overlappingNodes(): Array<[string, string]> {
  const ids = Object.keys(NODE_BOXES);
  const collisions: Array<[string, string]> = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (boxesOverlap(NODE_BOXES[ids[i]], NODE_BOXES[ids[j]])) collisions.push([ids[i], ids[j]]);
    }
  }
  return collisions;
}

/**
 * The cards in one column, top to bottom, with the air above each one.
 *
 * A pure function so the spacing that fixes the overlap is a fact a test can
 * assert rather than arithmetic in a comment. `null` above the first card in a
 * column: there is nothing over it but the canvas margin.
 */
export function columnStacks(): Array<{ left: number; cards: Array<{ id: string; gapAbove: number | null }> }> {
  const columns = new Map<number, Array<{ id: string; box: NodeBox }>>();
  for (const [id, box] of Object.entries(NODE_BOXES)) {
    const column = columns.get(box.left) ?? [];
    column.push({ id, box });
    columns.set(box.left, column);
  }
  return [...columns.entries()]
    .sort(([a], [b]) => a - b)
    .map(([left, cards]) => {
      const ordered = [...cards].sort((a, b) => a.box.top - b.box.top);
      let bottom: number | null = null;
      const stacked = ordered.map(({ id, box }) => {
        const gapAbove = bottom === null ? null : box.top - bottom;
        bottom = box.top + box.height;
        return { id, gapAbove };
      });
      return { left, cards: stacked };
    });
}
