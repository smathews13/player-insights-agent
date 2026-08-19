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
 * HEIGHT: 912, which is the middle column stacked and a 36px margin under it,
 * matching the 36 it starts at. That column is the tallest: four cards of 173,
 * 157, 157 and 245 with {@link ROW_GAP_MIN} between them, so 36 + 173 + 36 + 157
 * + 36 + 157 + 36 + 245 = 876, and 36 under that.
 *
 * It was 760, then 832, and 760 was not a margin short, it was a CLIP: the
 * scroller around this canvas is `overflow-y: hidden` and the canvas is given
 * this height in pixels, so the 33px by which the right-hand column overran it
 * were not reachable by scrolling. Height is the cheap dimension here -- the page
 * itself scrolls, and sideways scroll was the whole of the complaint -- which is
 * why the answer to a card that needs more room is always to give it more room.
 */
export const CANVAS_WIDTH = 1264;
export const CANVAS_HEIGHT = 939;

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
 * something other than the drawing has to be shown.
 */
export const MIN_CANVAS_PANEL = MIN_CANVAS_SCALE * CANVAS_WIDTH + CANVAS_FIT_SLACK;

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
 * Decided here rather than in a media query for two reasons. The threshold is a
 * property of the drawing, so it belongs beside the drawing's own numbers, and a
 * width invented in architecture.css is exactly what breakpoints.test.ts refuses.
 * And the quantity that matters is the PANEL's width, which a viewport-width
 * query can only estimate: the component measures the panel already, for the fit.
 *
 * An unmeasured panel shows the drawing. That is the server render and the first
 * paint, where showing the list would flash it on every load.
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
  const pills = node.presence !== 'connection'
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
 * endpoint that serves it sits in the column to its right, beneath the warehouse
 * and the catalog. That column is what-runs-it -- Genie's SQL runs on the
 * warehouse, a search runs on the endpoint -- so the pairing is the one the rest
 * of the drawing already uses.
 *
 * THE TOPS ARE SPACED OFF THE HEIGHTS rather than off a pitch, which is the fix
 * for the overlap. Every one of them is still a literal, because where a card
 * sits is a decision the design made, and a computed top would drift away from
 * the literal paths below it. What is no longer a decision is how much room a
 * card needs; architecture-layout.test.ts checks each column against
 * {@link nodeHeight} plus {@link ROW_GAP_MIN} rather than trusting the
 * arithmetic that produced these:
 *
 *     x=226   app 300 + 181 = 481       ->  lakebase 541     (60, for a caption)
 *     x=472   agent 290 + 157 = 447     ->  experiment 541   (94; the two stores
 *                                                             share a row)
 *     x=748   llm 36 + 173 = 209        ->  dictionary 245   (36)
 *             dictionary 245 + 157 = 402 -> data 438         (36)
 *             data 438 + 157 = 595      ->  index 631        (36)
 *     x=1042  warehouse 260 + 173 = 433 ->  catalog 485      (52, for a caption)
 *             catalog 485 + 157 = 642   ->  endpoint 686     (44)
 *
 * The columns do not overlap sideways, so those seven pairs are the whole of the
 * collision question for the cards. THE 60 AND THE 52 ARE NOT SLACK:
 * "governed reads" is fourteen characters placed inside the right column's own x
 * range, so the only thing keeping it out from under a card is the gap it sits
 * in, and the same is true of "conversation" and "trace" above the storage row.
 * A gap holding a caption is sized for the caption plus {@link LABEL_CLEAR_MIN}
 * above and below it, which is why those three are wider than the rest.
 */
const NODE_PLACEMENTS: Readonly<Record<string, Omit<NodeBox, 'height'>>> = {
  browser: { left: 12, top: 320, width: 128, accent: 'question' },
  app: { left: 226, top: 300, width: 172, accent: 'question' },
  'agent-endpoint': { left: 472, top: 290, width: 196, accent: 'agent' },
  'data-source-finder': { left: 472, top: 485, width: 196, accent: 'agent' },
  lakebase: { left: 226, top: 541, width: 172, accent: 'kept' },
  'experiment-id': { left: 472, top: 740, width: 196, accent: 'kept' },
  'llm-endpoint': { left: 748, top: 36, width: 218, accent: 'agent' },
  'genie-dictionary': { left: 748, top: 245, width: 218, accent: 'genie' },
  'genie-data': { left: 748, top: 438, width: 218, accent: 'genie' },
  'semantic-index': { left: 748, top: 631, width: 218, accent: 'search' },
  'sql-warehouse': { left: 1054, top: 260, width: 198, accent: 'governed' },
  catalog: { left: 1054, top: 485, width: 198, accent: 'governed' },
  'semantic-index-endpoint': { left: 1054, top: 686, width: 198, accent: 'search' },
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

/**
 * The geometry of each edge, keyed by the pair of nodes it joins.
 *
 * Stated as literal paths rather than derived from the boxes, because the design
 * chose where each line leaves a card and where each caption sits in the gaps
 * between them. A generated orthogonal route would put four of these on top of
 * one another in the corridor between the orchestrator and the four services it
 * calls, which is the one part of this drawing that is genuinely crowded.
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
      d: string;
      labelX: number;
      labelY: number;
      labelAnchor?: LabelAnchor;
      accent: ArchitectureAccent;
      duration: number;
      delay: number;
    }
  >
> = {
  'browser->app': {
    id: 'pe1',
    label: 'question',
    d: 'M140 400 H226',
    labelX: 183,
    labelY: 390,
    labelAnchor: 'middle',
    accent: 'question',
    duration: 2.4,
    delay: 0,
  },
  'app->agent-endpoint': {
    id: 'pe2',
    label: 'invoke',
    d: 'M398 380 H472',
    labelX: 435,
    labelY: 370,
    labelAnchor: 'middle',
    accent: 'question',
    duration: 2.4,
    delay: 0.9,
  },
  // Both of these leave a card's real bottom edge rather than a point part-way
  // down it. They used to stop at 415 and 427, which was inside the card on the
  // old 140px estimate and is inside it on the real height too -- the card paints
  // over the line, so the drawn result was a connector that started at the
  // border either way. Stated at the edge now so the geometry says what is drawn.
  'app->lakebase': {
    id: 'pe3',
    label: 'conversation',
    d: 'M312 405 V541',
    labelX: 328,
    labelY: 478,
    accent: 'kept',
    duration: 3.2,
    delay: 0,
  },
  'agent-endpoint->experiment-id': {
    id: 'pe4',
    label: 'trace',
    d: 'M570 438 C450 438 450 740 570 740',
    labelX: 584,
    labelY: 715,
    accent: 'kept',
    duration: 3.2,
    delay: 1.4,
  },
  'agent-endpoint->llm-endpoint': {
    id: 'pe5',
    label: 'plan + prose',
    d: 'M668 315 C716 315 700 86 748 86',
    labelX: 645,
    labelY: 170,
    accent: 'agent',
    duration: 2.8,
    delay: 0,
  },
  'agent-endpoint->data-source-finder': {
    id: 'pe12',
    label: 'delegate',
    d: 'M570 438 V485',
    labelX: 582,
    labelY: 468,
    accent: 'agent',
    duration: 2.4,
    delay: 0.4,
  },
  'data-source-finder->llm-endpoint': {
    id: 'pe13',
    label: 'reason',
    d: 'M668 510 C724 510 700 110 748 110',
    labelX: 696,
    labelY: 222,
    accent: 'agent',
    duration: 2.8,
    delay: 0.5,
  },
  // The lines out of the finder arrive 50px down each card they point
  // at, which is under its title and level with its status pill. That is why
  // every one of these end coordinates moved when the middle column was
  // re-spaced: the arrival point is relative to a card, not to the canvas.
  'data-source-finder->genie-dictionary': {
    id: 'pe6',
    label: 'terms',
    d: 'M668 535 C716 535 700 295 748 295',
    labelX: 692,
    labelY: 318,
    accent: 'genie',
    duration: 2.8,
    delay: 0.7,
  },
  'data-source-finder->genie-data': {
    id: 'pe7',
    label: 'metrics',
    d: 'M668 560 C716 560 700 488 748 488',
    labelX: 736,
    labelY: 480,
    labelAnchor: 'end',
    accent: 'genie',
    duration: 2.8,
    delay: 1.4,
  },
  'data-source-finder->semantic-index': {
    id: 'pe8',
    label: 'search',
    d: 'M668 585 C716 585 700 681 748 681',
    labelX: 692,
    labelY: 560,
    accent: 'search',
    duration: 2.8,
    delay: 2.1,
  },
  'data-source-finder->sql-warehouse': {
    id: 'pe14',
    label: 'resolve + SQL',
    d: 'M668 520 C710 520 700 220 1010 220 C1034 220 1028 300 1054 300',
    labelX: 870,
    labelY: 210,
    labelAnchor: 'middle',
    accent: 'governed',
    duration: 3,
    delay: 1.8,
  },
  // Drawn from the endpoint to the index, in the same shape as the warehouse
  // pairing above it, because the endpoint is what a search of the index runs
  // on. The caption sits in the 62px corridor between the two columns, which is
  // "serves" plus LABEL_CLEAR_MIN at each end.
  'semantic-index-endpoint->semantic-index': {
    id: 'pe11',
    label: 'serves',
    d: 'M1054 746 C1010 746 1010 681 966 681',
    labelX: 1010,
    labelY: 670,
    labelAnchor: 'middle',
    accent: 'search',
    duration: 2.8,
    delay: 1.1,
  },
  'genie-data->sql-warehouse': {
    id: 'pe9',
    label: 'SQL',
    d: 'M966 483 C1010 483 1010 320 1054 320',
    labelX: 1010,
    labelY: 400,
    labelAnchor: 'middle',
    accent: 'governed',
    duration: 2.4,
    delay: 0,
  },
  // The one connector with a card above it AND a card below it, which is what
  // makes the 52px gap between the warehouse and the catalog load-bearing: this
  // line is 48 of it and its caption stands beside it in the same space.
  'sql-warehouse->catalog': {
    id: 'pe10',
    label: 'governed reads',
    d: 'M1153 408 V485',
    labelX: 1165,
    labelY: 450,
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
    drawn.push({
      id: geometry.id,
      from: edge.from,
      to: edge.to,
      meaning: edge.meaning,
      label: geometry.label,
      d: geometry.d,
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
 * Where a path starts and where it ends.
 *
 * `H` and `V` carry one coordinate rather than two, so the end point of a
 * horizontal or vertical segment inherits the other axis from where it started.
 * Reading that back is what lets the tests check both ends of every edge against
 * the cards it is supposed to join.
 */
export function pathEnds(d: string): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const numbers = pathPoints(d);
  const start = { x: numbers[0], y: numbers[1] };
  const horizontal = /H\s*-?\d/.test(d);
  const vertical = /V\s*-?\d/.test(d);
  const last = numbers[numbers.length - 1];
  if (horizontal) return { start, end: { x: last, y: start.y } };
  if (vertical) return { start, end: { x: start.x, y: last } };
  return { start, end: { x: numbers[numbers.length - 2], y: last } };
}

/** Whether a point falls inside a card's footprint. */
export function insideBox(box: NodeBox, point: { x: number; y: number }): boolean {
  return (
    point.x > box.left &&
    point.x < box.left + box.width &&
    point.y > box.top &&
    point.y < box.top + box.height
  );
}

/** Whether two cards would be drawn over one another. */
export function boxesOverlap(a: NodeBox, b: NodeBox): boolean {
  return rectsOverlap(a, b);
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
    a.left + a.width <= b.left ||
    b.left + b.width <= a.left ||
    a.top + a.height <= b.top ||
    b.top + b.height <= a.top;
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
    edge.labelAnchor === 'end' ? edge.labelX - width : edge.labelAnchor === 'middle' ? edge.labelX - width / 2 : edge.labelX;
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
