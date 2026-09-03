import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ARCHITECTURE_EDGES, ARCHITECTURE_NODES, nodesInLane } from './architecture';
import {
  ACCENT_TOKEN,
  BOTTOM_ROW_NODES,
  CANVAS_FIT_SLACK,
  CANVAS_HEIGHT,
  CANVAS_MARGIN,
  CANVAS_MAX_WIDTH,
  CANVAS_WIDTH,
  COLUMN_GAP,
  CARD_CHROME_HEIGHT,
  CARD_CHROME_WIDTH,
  CARD_LINE_HEIGHT,
  CARD_ROW_GAP,
  CARD_TEXT,
  CARD_TITLE_TEXT,
  EDGE_LABEL_TEXT,
  LABEL_CLEAR_MIN,
  PILL_CHARS,
  PILL_CHROME_HEIGHT,
  PILL_CHROME_WIDTH,
  ROW_GAP_MIN,
  canvasFits,
  canvasScale,
  MIN_CANVAS_PANEL,
  MIN_CANVAS_SCALE,
  NODE_BOXES,
  boxesOverlap,
  columnStacks,
  crossingEdges,
  drawnEdges,
  drawnRects,
  edgeEntersCard,
  edgePath,
  edgesThroughCards,
  fittedSpan,
  insideBox,
  labelClearances,
  labelRect,
  nodeBox,
  nodeHeight,
  overlappingNodes,
  overlappingRects,
  pathEnds,
  pathPoints,
  pathPolyline,
  pathsCross,
  rectGap,
  rectsOverlap,
  wrappedLines,
  type Rect,
} from './architecture-layout';
import { CONNECTION_STATUS_LABEL, DRIFT_MARKER_LABEL } from './connection-status';
import { CONTENT_AGE_UNREPORTED_LABEL, CONTENT_AGE_UNUSABLE_LABEL, contentAge } from './semantic-freshness';

/**
 * The geometry, checked arithmetically because it cannot be checked visually.
 *
 * No browser runs here, so nothing in this repository can see the diagram. What
 * can be established without one is that the layout is internally consistent:
 * every node is placed, no two cards occupy the same space, every edge starts and
 * ends on the two cards it claims to join, and no caption is placed where a card
 * will be drawn over it. That is not the same as "it looks right" -- a human still
 * has to open it -- but it does catch the ways this kind of layout actually
 * breaks.
 *
 * THE CARD HEIGHTS USED TO BE OUT OF SCOPE HERE, and that is what let the tab
 * ship with its cards on top of one another. A single NODE_HEIGHT_ESTIMATE of 140
 * stood in for all twelve, the columns were stacked on a 160px pitch, and the
 * real cards are 157 to 229 -- so every check in this file agreed with itself
 * while the Data Genie space card was drawn underneath the Dictionary card and
 * lost its title. The heights are derived per card now, from the same stylesheet
 * this file reads its other arithmetic out of, and the check that two rectangles
 * do not intersect is at the bottom.
 */

const CSS = readFileSync(fileURLToPath(new URL('./styles/architecture.css', import.meta.url)), 'utf8');
/*
 * Both token files, because the accents are being converted one at a time.
 *
 * The claim this backs is "every accent names a token this app declares", and
 * after the orange came off the agent, two of the six are declared in
 * astrolabe-tokens.css and four in tokens.css. Reading only the first would have
 * failed a converted accent for being converted, which is the check disagreeing
 * with the direction of travel rather than catching anything.
 */
const TOKENS =
  readFileSync(fileURLToPath(new URL('./styles/tokens.css', import.meta.url)), 'utf8') +
  readFileSync(fileURLToPath(new URL('./styles/astrolabe-tokens.css', import.meta.url)), 'utf8');
/*
 * The shared pill recipe, which is where a status pill's border and vertical
 * padding live now. The three pills on a node card compose `.ast-pill` and
 * override its horizontal padding only, so the model's chrome figures have to be
 * read from both files rather than from this page's own rule.
 */
const AST = readFileSync(fileURLToPath(new URL('./styles/astrolabe-tokens.css', import.meta.url)), 'utf8');
const SHELL = readFileSync(fileURLToPath(new URL('./styles/page-shell.css', import.meta.url)), 'utf8');

/** The declarations inside one rule, by its selector, for the arithmetic below. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`${selector} is not in this stylesheet`);
  return css.slice(at, css.indexOf('}', at));
}

/** The first pixel figure a property is set to, or 0 where it sets none. */
function px(block: string, property: string): number {
  const found = new RegExp(`${property}:([^;]*)`).exec(block);
  return found ? Number(/(-?\d+(?:\.\d+)?)px/.exec(found[1])?.[1] ?? 0) : 0;
}

/** Every pixel figure a property is set to, for the shorthands. */
function pxList(block: string, property: string): number[] {
  const found = new RegExp(`${property}:([^;]*)`).exec(block);
  return [...(found?.[1] ?? '').matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
}

/** A unitless figure a property is set to, which is how line-height is stated. */
function unitless(block: string, property: string): number {
  const found = new RegExp(`${property}:\\s*(-?\\d+(?:\\.\\d+)?)\\s*;`).exec(block);
  return Number(found?.[1]);
}

/** What a `--text-*` token resolves to, in pixels. */
function token(name: string): number {
  const found = new RegExp(`--${name}:([^;]*)`).exec(TOKENS);
  return Number(/(-?\d+(?:\.\d+)?)px/.exec(found?.[1] ?? '')?.[1]);
}

/**
 * The panel the canvas is drawn in, for a window of a given width.
 *
 * `.page-shell` caps the page at 1440 and takes `clamp(20px, 4vw, 56px)` off
 * each side; the panel takes its border and padding out of what is left. 4vw is
 * of the VIEWPORT rather than of the capped shell, which is why a 1512px window
 * and a 1440px one both come out at the same panel width.
 */
function panelAt(window: number): number {
  const shell = rule(SHELL, '.page-shell');
  const flow = rule(CSS, '.arch-flow');
  const side = Math.min(clampCeiling(shell, 'padding'), Math.max(20, window * 0.04));
  const panel = 2 * (px(flow, 'padding') + px(flow, 'border'));
  return Math.min(px(shell, 'max-width'), window) - 2 * side - panel;
}

/**
 * The largest a `clamp(min, preferred, max)` can resolve to.
 *
 * The shell's side padding is `clamp(20px, 4vw, 56px)`, and 56 is the figure the
 * canvas has to survive: it is what a window wide enough to reach the shell's
 * own max-width gives, which is exactly the window the overflow was reported on.
 */
function clampCeiling(block: string, property: string): number {
  const found = new RegExp(`${property}:([^;]*)`).exec(block);
  const clamp = /clamp\(([^)]*)\)/.exec(found?.[1] ?? '');
  if (!clamp) throw new Error(`${property} is not a clamp()`);
  const last = clamp[1].split(',').pop() ?? '';
  return Number(/(-?\d+(?:\.\d+)?)px/.exec(last)?.[1]);
}

describe('every node is placed exactly once', () => {
  it('has a box for each node in the model', () => {
    for (const node of ARCHITECTURE_NODES) {
      expect(nodeBox(node.id), `${node.id} is placed`).toBeDefined();
    }
  });

  it('places nothing that is not a node', () => {
    const ids = new Set(ARCHITECTURE_NODES.map((node) => node.id));
    for (const id of Object.keys(NODE_BOXES)) {
      expect(ids.has(id), `${id} is a node`).toBe(true);
    }
  });

  it('keeps every card inside the canvas, its own width and height included', () => {
    for (const [id, box] of Object.entries(NODE_BOXES)) {
      expect(box.left, `${id} left`).toBeGreaterThanOrEqual(0);
      expect(box.left + box.width, `${id} right`).toBeLessThanOrEqual(CANVAS_WIDTH);
      expect(box.top, `${id} top`).toBeGreaterThanOrEqual(0);
      expect(box.top + box.height, `${id} bottom`).toBeLessThanOrEqual(CANVAS_HEIGHT);
    }
  });

  it('gives every card the height its own copy needs, not a shared one', () => {
    const heights = Object.entries(NODE_BOXES).map(([id, box]) => [id, box.height] as const);
    expect(new Set(heights.map(([, height]) => height)).size, 'the cards differ in height').toBeGreaterThan(1);
    // The copy and chrome were deliberately tightened; no card should return to
    // the oversized boxes the earlier paragraphs required.
    expect(Math.max(...heights.map(([, height]) => height))).toBeLessThan(190);
    // The spread remains, which is why one fixed height is still wrong.
    const tallest = Math.max(...heights.map(([, height]) => height));
    const shortest = Math.min(...heights.map(([, height]) => height));
    expect(tallest - shortest, 'the range no one constant covers').toBeGreaterThan(60);
  });

  /**
   * A CARD CANNOT CLIP ITS OWN COPY, and this is what makes that true.
   *
   * The heights above are a MODEL of the card, computed from the stylesheet and
   * the words. The card that gets drawn is sized by the browser from the same
   * words, and the only thing that could make those disagree destructively is a
   * height or an overflow on the card itself: with one, a paragraph the model
   * scored short is cut off at the border; without one, it simply grows and the
   * model is what has to keep up. So the component states left, top and width
   * and never a height, and this is the check that says so -- the failure it
   * guards against is invisible until a sentence is added to architecture.ts.
   */
  it('never gives a card a height, so a mis-modelled one grows instead of clipping', () => {
    const page = readFileSync(fileURLToPath(new URL('./ArchitecturePage.tsx', import.meta.url)), 'utf8');
    // The card's own inline style, from `style={{ left:` to the end of that line.
    // Read as a line rather than as a balanced brace expression because the value
    // of each property is a template literal and contains braces of its own.
    const placement = /style=\{\{ left:.*$/m.exec(page)?.[0] ?? '';
    expect(placement, 'the card is placed by left, top and width').toMatch(/left:.*top:.*width:/);
    expect(placement, 'and never by height').not.toMatch(/height:/);

    const card = rule(CSS, '.arch-node');
    for (const property of ['height', 'max-height', 'overflow']) {
      expect(card, `.arch-node sets no ${property}`).not.toMatch(new RegExp(`(?:^|[;{\\s])${property}:`));
    }
  });
});

describe('no two cards are drawn on top of each other', () => {
  it('finds no collisions at the real card heights', () => {
    expect(overlappingNodes()).toEqual([]);
  });

  it('would notice one', () => {
    // A layout check that cannot fail is how overlapping boxes ship, so this pins
    // that the detector reports a real collision and clears a real gap.
    const anchor = NODE_BOXES['agent-endpoint'];
    expect(boxesOverlap(anchor, { ...anchor, left: anchor.left + 10 })).toBe(true);
    expect(boxesOverlap(anchor, { ...anchor, left: anchor.left + anchor.width })).toBe(false);
    expect(boxesOverlap(anchor, { ...anchor, top: anchor.top + anchor.height })).toBe(false);
  });

  it('gives every card in a column the room its own copy needs', () => {
    // The columns do not overlap sideways, so this is the whole of the card
    // collision question stated positively: enough air, rather than merely not
    // touching. A gap of three pixels passes an intersection test and still puts
    // one card's border in another's padding on any engine that rounds a line
    // box the other way.
    for (const column of columnStacks()) {
      for (const card of column.cards) {
        if (card.gapAbove === null) continue;
        expect(card.gapAbove, `${card.id} clears the card above it`).toBeGreaterThanOrEqual(ROW_GAP_MIN);
      }
    }
  });

  it('leaves the Data Genie space card its own title, which is the defect reported', () => {
    // Named rather than left to the sweep above, because this is the pair that
    // shipped broken: the Dictionary card is opaque, is painted after the Data
    // Genie card, and reached down over its title and its Open in Databricks
    // link. A reader saw a card with no name on it.
    const dictionary = NODE_BOXES['genie-dictionary'];
    const data = NODE_BOXES['genie-data'];
    expect(dictionary.top + dictionary.height).toBeLessThanOrEqual(data.top);
    expect(data.top - (dictionary.top + dictionary.height)).toBeGreaterThanOrEqual(ROW_GAP_MIN);

    // The new one-line copy is genuinely compact, while the explicit placement
    // leaves much more than the minimum gap.
    expect(dictionary.height).toBeLessThan(140);
    expect(data.top - (dictionary.top + dictionary.height)).toBeGreaterThan(ROW_GAP_MIN + 20);
  });

  /**
   * FIVE COLUMNS, ONE PITCH, and the pitch is a number rather than four.
   *
   * "The paths are very mixed and hard to follow" was reported about the lines,
   * but a reader traces a line by the columns it crosses, and the corridors were
   * 86, 74, 80 and 88 wide. Four separations across one drawing are read as four
   * different amounts of distance, so the line that crosses the narrow one looks
   * like a different kind of connection from the line that crosses the wide one.
   *
   * The gap is asserted exactly rather than as a floor: a floor is what let them
   * drift apart in the first place, one column at a time, each edit locally
   * reasonable.
   */
  it('separates every column from the next by the same corridor', () => {
    const columns = [...new Set(Object.values(NODE_BOXES).map((box) => box.left))].sort((a, b) => a - b);
    expect(columns).toHaveLength(5);
    for (let at = 1; at < columns.length; at += 1) {
      const width = Math.max(
        ...Object.values(NODE_BOXES)
          .filter((box) => box.left === columns[at - 1])
          .map((box) => box.width)
      );
      expect(columns[at] - (columns[at - 1] + width), `the corridor left of x=${columns[at]}`).toBe(COLUMN_GAP);
    }
  });

  it('starts every column at the same height, so the drawing has a top edge', () => {
    // Not that every card starts there -- the columns are different lengths --
    // but that the highest card in the drawing sits exactly {@link CANVAS_MARGIN}
    // down, and the canvas ends the same distance below the lowest. A frame with
    // 36 of white above and 12 below reads as a drawing that has slipped in it.
    const tops = Object.values(NODE_BOXES).map((box) => box.top);
    const bottoms = Object.values(NODE_BOXES).map((box) => box.top + box.height);
    expect(Math.min(...tops)).toBe(CANVAS_MARGIN);
    expect(CANVAS_HEIGHT - Math.max(...bottoms)).toBe(CANVAS_MARGIN);
  });
});

/**
 * WHERE THE HEIGHTS COME FROM, which is the stylesheet and the copy.
 *
 * The model in architecture-layout.ts adds up rows of type inside a box. Every
 * figure it adds is a declaration in architecture.css or a token in tokens.css,
 * and each one is read back out here -- so adjusting the card's padding fails in
 * this file rather than reappearing as a hidden title three releases later. That
 * is the same discipline the canvas-fits-the-panel checks below already use.
 */
describe('a card is as tall as the stylesheet and the copy make it', () => {
  it('reads the card box model out of the stylesheet rather than remembering it', () => {
    const card = rule(CSS, '.arch-node');
    const [padTop, padRight, padBottom, padLeft] = pxList(card, 'padding');
    const border = px(card, 'border');
    expect(CARD_CHROME_HEIGHT).toBe(padTop + padBottom + 2 * border);
    expect(CARD_CHROME_WIDTH).toBe(padLeft + padRight + 2 * border);
    expect(CARD_ROW_GAP).toBe(px(card, 'gap'));
    // The same gap inside the card's own heading block, which the model counts
    // twice for that reason.
    expect(CARD_ROW_GAP).toBe(px(rule(CSS, '.arch-node-main'), 'gap'));
    expect(CARD_LINE_HEIGHT).toBe(unitless(card, 'line-height'));
    expect(CARD_LINE_HEIGHT).toBe(1.35);
    expect(card).toMatch(/font-size:\s*var\(--text-xs\)/);
    expect(CARD_TEXT).toBe(token('text-xs'));
    expect(rule(CSS, '.arch-node-label')).toMatch(/font-size:\s*var\(--text-base\)/);
    expect(CARD_TITLE_TEXT).toBe(token('text-base'));
    expect(EDGE_LABEL_TEXT).toBe(px(rule(CSS, '.arch-edge-label'), 'font-size'));
  });

  /**
   * THIS IS THE ONE THAT WAS DOUBLE-SPACED, and the check is on the role
   * paragraph specifically rather than on the card, because the card was already
   * right: `.arch-node` has said 1.35 the whole time and the check above has
   * always passed.
   *
   * What the check above cannot see is that a `<p>` never took that value.
   * AppKit's imported stylesheet carries a bare `p` rule at `line-height:
   * 1.75rem`, and a declaration whose selector matches the element beats an
   * inherited value at any specificity -- so the twelve role paragraphs set at
   * 28px while every figure in architecture-layout.ts was derived from 14.85px.
   * Titles, pills and the identifier are spans and were never affected, which is
   * why the defect read as the descriptions alone being loose.
   *
   * So the assertion is that the property is STATED on this selector. An
   * inherited 1.35 is not enough here and testing the computed cascade would
   * need a browser, which this suite does not have.
   */
  it('states the role paragraph line-height instead of inheriting it', () => {
    const role = rule(CSS, '.arch-node-role');
    expect(role).toMatch(/line-height:/);
    expect(unitless(role, 'line-height')).toBe(CARD_LINE_HEIGHT);

    // Unitless, so it is a multiple of the type rather than a fixed band. The
    // 1.75rem it was losing to is exactly the shape of mistake this refuses: a
    // length that stops tracking font-size at all.
    expect(role).not.toMatch(/line-height:[^;]*(rem|px|em)/);

    // And single-spaced in the sense the eye uses. 1.35 of 11px type is a 14.85px
    // line; anything at or above 1.6 is the doubled setting that was reported.
    const spacing = unitless(role, 'line-height');
    expect(spacing).toBeGreaterThanOrEqual(1.2);
    expect(spacing).toBeLessThanOrEqual(1.4);
    expect(CARD_TEXT * spacing).toBeLessThan(CARD_TEXT * 1.6);

    // The paragraph margin a `<p>` would otherwise carry stays off it: the model
    // adds one CARD_ROW_GAP above this row and counts nothing else.
    expect(pxList(role, 'margin')).toEqual([]);
    expect(role).toMatch(/margin:\s*0/);
  });

  it('reads a status pill the same way', () => {
    // The three pills share one rule, so the selector this finds is the last of
    // the three in the group. That rule now states the horizontal padding only:
    // the edge and the vertical padding are the shared `.ast-pill` recipe, so the
    // model's chrome is the sum of the two and both halves are read back here.
    const recipe = rule(AST, '.ast-pill');
    const pill = rule(CSS, '.arch-node-age');
    const padY = pxList(recipe, 'padding')[0];
    const padX = pxList(pill, 'padding')[1];
    const border = px(recipe, 'border');
    expect(PILL_CHROME_HEIGHT).toBe(2 * (padY + border));
    expect(PILL_CHROME_WIDTH).toBe(2 * (padX + border));
    // And the page's own rule genuinely overrides the recipe's horizontal
    // padding rather than restating it, which is the only reason to read the two
    // separately: 6px on a 250px card against the recipe's 8px.
    expect(padX).toBeLessThan(pxList(recipe, 'padding')[1]);
  });

  it('keeps the identifier to one line, which is the rule the model assumes', () => {
    // The model counts the identifier row once. `nowrap` is what makes that true
    // of a value of any length, and it is the reason a long warehouse id is an
    // ellipsis rather than a taller card.
    expect(rule(CSS, '.arch-node-value')).toMatch(/white-space:\s*nowrap/);
  });

  it('states a pill no shorter than the words those pills carry', () => {
    // THIS CHECK CAUGHT A REAL ONE, which is worth saying because a check on a
    // constant against the words behind it reads like bookkeeping. The status
    // figure was set from the semantic lane's "Not reported" at twelve, and
    // `CONNECTION_STATUS_LABEL` can print "Nothing to reach" at sixteen -- enough
    // to wrap Lakebase's two pills onto a second row and make that card 24px
    // taller than the model said. The model is only an upper bound if the words
    // it bounds are the real ones, so they are read from their own modules here
    // rather than copied into the layout.
    for (const label of Object.values(CONNECTION_STATUS_LABEL)) {
      expect(label.length, label).toBeLessThanOrEqual(PILL_CHARS.status);
    }
    for (const label of Object.values(DRIFT_MARKER_LABEL)) {
      expect(label.length, label).toBeLessThanOrEqual(PILL_CHARS.drift);
    }
    const now = Date.UTC(2026, 0, 2);
    for (const hours of [0, 5, 47, 100 * 24, 400 * 24]) {
      const age = contentAge(new Date(now - hours * 3_600_000).toISOString(), now);
      expect(age.label.length, age.label).toBeLessThanOrEqual(PILL_CHARS.age);
    }
    expect(CONTENT_AGE_UNREPORTED_LABEL.length).toBeLessThanOrEqual(PILL_CHARS.age);
    expect(CONTENT_AGE_UNUSABLE_LABEL.length).toBeLessThanOrEqual(PILL_CHARS.age);
  });

  it('wraps a paragraph the way an engine does, and would notice if it did not', () => {
    // The one part of the model that is an estimate rather than a reading, so it
    // is pinned on its own: a word too wide for the box takes a line and
    // overflows it, and words that fit share one.
    expect(wrappedLines('one', 11, 0.58, 400)).toBe(1);
    expect(wrappedLines('one two three', 11, 0.58, 400)).toBe(1);
    expect(wrappedLines('one two three', 11, 0.58, 40)).toBe(3);
    expect(wrappedLines('unbreakablelongword', 11, 0.58, 10)).toBe(1);
  });

  it('keeps the compact Vector Search description tied to its measured height', () => {
    const heights = Object.entries(NODE_BOXES).map(([id, box]) => [id, box.height] as const);
    expect(Math.max(...heights.map(([, height]) => height))).toBeLessThan(190);
    expect(nodeHeight('semantic-index')).toBe(NODE_BOXES['semantic-index'].height);
  });
});

/**
 * The claim the page makes in words, checked against the numbers that draw it.
 *
 * The flow sub-line on the page says storage sits on the bottom row. That is a
 * sentence about this table, and a layout change that moved either card upward
 * would leave the page asserting something untrue about its own picture -- which
 * is exactly the class of defect this screen exists to expose in the deployment.
 */
describe('storage is the bottom row, which is what the page says it is', () => {
  it('draws the two stores lower than every card that is not the semantic lane', () => {
    // The semantic lane is drawn low as well, on the far right, and it is on the
    // answer path rather than in storage. It is excluded BY LANE rather than by
    // name, so a future card placed low is still a failure here unless the model
    // itself says it belongs to the exception -- which is what stops the
    // exception from quietly becoming the rule.
    const exempt = new Set(nodesInLane('semantic').map((node) => node.id));
    const stores = BOTTOM_ROW_NODES.map((id) => NODE_BOXES[id]);
    const others = Object.entries(NODE_BOXES)
      .filter(([id]) => !BOTTOM_ROW_NODES.includes(id) && !exempt.has(id))
      .map(([, box]) => box);
    for (const store of stores) {
      for (const other of others) {
        expect(store.top).toBeGreaterThan(other.top);
      }
    }
  });

  it('keeps the exception to two cards, both of them semantic and both drawn', () => {
    // The lane the rule above exempts. Naming it here means a node added to it
    // has to be a deliberate act rather than a way past the bottom-row check.
    expect(nodesInLane('semantic').map((node) => node.id)).toEqual(['semantic-index', 'semantic-index-endpoint']);
    for (const node of nodesInLane('semantic')) {
      expect(nodeBox(node.id), `${node.id} is placed`).toBeDefined();
    }
  });

  it('names the same two nodes the model keeps off the answer path', () => {
    // Not a second list. `lane: 'record'` is the model's own statement about what
    // is written during a run and never read to answer one, and the bottom row is
    // that set drawn.
    expect([...BOTTOM_ROW_NODES].sort()).toEqual(
      nodesInLane('record')
        .map((node) => node.id)
        .sort()
    );
  });

  it('hangs each store below the thing that writes it', () => {
    // Down and not across: the edge into Lakebase leaves the app, and the edge
    // into the experiment leaves the orchestrator. An edge drawn left to right
    // into either would put storage on the path to an answer.
    for (const edge of drawnEdges().filter((candidate) => BOTTOM_ROW_NODES.includes(candidate.to))) {
      const ends = pathEnds(edge.d);
      expect(ends.end.y, edge.id).toBeGreaterThan(ends.start.y);
      expect(ends.end.x, edge.id).toBe(ends.start.x);
      expect(edge.accent, edge.id).toBe('kept');
    }
  });
});

describe('every connection in the model is drawn', () => {
  it('draws all of them, because all of them have geometry', () => {
    expect(drawnEdges()).toHaveLength(ARCHITECTURE_EDGES.length);
  });

  it('gives each edge its own path and its own identifier', () => {
    const edges = drawnEdges();
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(edges.length);
    expect(new Set(edges.map((edge) => edge.d)).size).toBe(edges.length);
  });

  it('starts and ends each path on the two cards it joins', () => {
    // One tolerance, in both directions: several paths stop two to six pixels
    // short of the card they point at, so the line does not disappear under the
    // border. Anything further than that is a line pointing at nothing.
    //
    // The downward end used to be checked against a flat 160 rather than the
    // card's own height, which meant a path could claim to leave a card it
    // stopped 20px below. It is the real height now, which is the whole reason
    // the four lines out of the orchestrator had to move when the middle column
    // was re-spaced.
    const reach = 6;
    for (const edge of drawnEdges()) {
      const from = nodeBox(edge.from)!;
      const to = nodeBox(edge.to)!;
      const ends = pathEnds(edge.d);
      const reaches = (box: typeof from, point: { x: number; y: number }) =>
        point.x >= box.left - reach &&
        point.x <= box.left + box.width + reach &&
        point.y >= box.top - reach &&
        point.y <= box.top + box.height + reach;
      expect(reaches(from, ends.start), `${edge.id} leaves ${edge.from}`).toBe(true);
      expect(reaches(to, ends.end), `${edge.id} arrives at ${edge.to}`).toBe(true);
    }
  });

  it('stays inside the canvas at every control point', () => {
    for (const edge of drawnEdges()) {
      for (const value of pathPoints(edge.d)) {
        expect(value, edge.d).toBeGreaterThanOrEqual(0);
        expect(value, edge.d).toBeLessThanOrEqual(CANVAS_WIDTH);
      }
    }
  });

  it('fits every caption in its gap, and not just its anchor point', () => {
    // The check above places the caption's ANCHOR clear of every card, which is
    // where a 10px word starts, ends or is centred rather than where it lies. A
    // gap tightened to within a few pixels of the word standing in it passes
    // that check and still draws "search" half under the card beside it, and
    // tightening the gaps is exactly what closing the horizontal overflow did.
    //
    // The advance is an upper bound rather than a measurement: 0.62em is wider
    // than any monospace face in common use sets at, and the captions are 10px
    // mono per .arch-edge-label. Nothing here can measure a font, so the
    // estimate errs towards refusing a gap that would in fact have fitted.
    expect(CSS).toMatch(/\.arch-edge-label\s*\{[^}]*font-size:\s*10px/);

    for (const edge of drawnEdges()) {
      const label = labelRect(edge);
      expect(label.left, `${edge.id} starts inside the canvas`).toBeGreaterThanOrEqual(0);
      expect(label.left + label.width, `${edge.id} ends inside the canvas`).toBeLessThanOrEqual(CANVAS_WIDTH);
      for (const [id, box] of Object.entries(NODE_BOXES)) {
        // Only the cards this caption is level with can be drawn over it. A
        // caption in the vertical gap between two cards in a column is clear of
        // both however wide it is, which is where the long ones are placed.
        const level = edge.labelY > box.top && edge.labelY < box.top + box.height;
        if (!level) continue;
        const clear = label.left + label.width <= box.left || label.left >= box.left + box.width;
        expect(clear, `${edge.id} caption "${edge.label}" is clear of ${id}`).toBe(true);
      }
    }
  });

  it('places every caption in a gap rather than under a card', () => {
    // The defect the fixed canvas replaced a percentage layout to fix: cards grew
    // with their content and the captions ended up underneath them, so the drawing
    // lost the words that say what each line means.
    for (const edge of drawnEdges()) {
      for (const [id, box] of Object.entries(NODE_BOXES)) {
        expect(insideBox(box, { x: edge.labelX, y: edge.labelY }), `${edge.id} caption is clear of ${id}`).toBe(false);
      }
    }
  });

  it('names no measurement in a caption, only the relationship', () => {
    for (const edge of drawnEdges()) {
      expect(edge.label, edge.id).not.toMatch(/\d/);
      expect(edge.label.length, edge.id).toBeLessThanOrEqual(16);
    }
  });

  it('staggers the dots rather than firing all of them together', () => {
    // Ten dots leaving at once reads as one pulse across the whole page, which
    // says the app does all of this at the same moment. It does not.
    const flows = drawnEdges().filter((edge) => edge.relationship === 'flow');
    const delays = flows.map((edge) => edge.delay);
    expect(new Set(delays).size).toBeGreaterThan(1);
    for (const edge of flows) {
      expect(edge.duration, edge.id).toBeGreaterThan(0);
      // Shorter than one traversal, or the line spends part of every loop empty
      // while its neighbours are busy, which reads as a connection that stopped.
      expect(edge.delay, edge.id).toBeLessThanOrEqual(edge.duration);
    }
  });
});

/**
 * WHERE A LINE GOES, not just where it starts and stops.
 *
 * Everything above this reads an edge's path as the numbers in its string: the
 * first pair, the last pair, and whether any of them left the canvas. A curve is
 * not its control points, so all of that passed while one edge ran from the
 * finder across the entire Genie column to the warehouse -- over the gap between
 * two cards, across three other edges -- and while four edges were cubics whose
 * first handle sat to the RIGHT of their second and therefore kinked. "The paths
 * are very mixed and hard to follow, weirdly curved" is what that looks like, and
 * nothing in this file could see any of it.
 *
 * So the paths are flattened and measured. These are the claims the arrangement
 * is FOR, rather than descriptions of it, and each of them is undone by a
 * plausible-looking edit to the tables in architecture-layout.ts.
 */
describe('every line can be followed from one card to the other', () => {
  it('draws no line across a card', () => {
    expect(edgesThroughCards()).toEqual([]);
  });

  it('would notice one, on a line moved over a card on purpose', () => {
    // The detector before it is trusted over the real table. A straight run
    // through the middle of a card is caught; the same run along the card's own
    // border is not, which is the case every edge on this drawing depends on --
    // each of them starts on one card's border and ends on another's.
    const box = NODE_BOXES['genie-data'];
    const across = `M 0 ${box.top + 40} H ${CANVAS_WIDTH}`;
    expect(pathPolyline(across).some((point, at) => at > 0 && point.y === box.top + 40)).toBe(true);
    expect(edgeEntersCard(across, box)).toBe(true);
    expect(edgeEntersCard(`M 0 ${box.top} H ${CANVAS_WIDTH}`, box)).toBe(false);
  });

  it('crosses no other line', () => {
    expect(crossingEdges()).toEqual([]);
  });

  it('would notice a crossing, on two lines drawn over each other', () => {
    // Two straight runs through the same corridor, one of them inverted, which
    // is exactly what breaking the fan's departure order does.
    const down = 'M 672 300 C 713 300 713 500 754 500';
    const up = 'M 672 500 C 713 500 713 300 754 300';
    expect(pathsCross(down, up)).toBe(true);
    expect(pathsCross(down, 'M 672 520 C 713 520 713 600 754 600')).toBe(false);
  });

  /**
   * NO LINE TURNS BACK ON ITSELF. The other half of "weirdly curved".
   *
   * A cubic whose handles are both on the vertical half way between its ends is
   * monotone in x by construction, which is the property that makes two of them
   * side by side read as the same shape. The old ones were not: handles at 716
   * and 700 make the curve leave the card, come back, and kink in the middle at
   * an amount that differed per edge.
   *
   * The bracket is the one exception and has to be, because going round a card
   * means going back the way you came. It is named here so that a second
   * non-monotone edge is a failure rather than a precedent.
   */
  it('moves each line one way across the canvas, bar the one that goes round a card', () => {
    const wandering: string[] = [];
    for (const edge of drawnEdges()) {
      const xs = pathPolyline(edge.d).map((point) => point.x);
      const rising = xs.every((x, at) => at === 0 || x >= xs[at - 1] - 0.001);
      const falling = xs.every((x, at) => at === 0 || x <= xs[at - 1] + 0.001);
      if (!rising && !falling) wandering.push(edge.id);
    }
    const bracket = drawnEdges().find((edge) => edge.from === 'agent-endpoint' && edge.to === 'experiment-id')!;
    expect(wandering).toEqual([bracket.id]);
  });

  it('leaves and arrives on the borders themselves, because the ends are derived', () => {
    // The old table stated every coordinate by hand, so the check above this one
    // allows six pixels of slack for a line that stops short of the card it
    // points at. Nothing needs that slack now: an end is a side of a card and a
    // distance along it, so it is ON the border or the arithmetic is wrong.
    for (const edge of drawnEdges()) {
      const from = nodeBox(edge.from)!;
      const to = nodeBox(edge.to)!;
      const ends = pathEnds(edge.d);
      const onBorder = (box: typeof from, point: { x: number; y: number }) =>
        ((point.x === box.left || point.x === box.left + box.width) &&
          point.y >= box.top &&
          point.y <= box.top + box.height) ||
        ((point.y === box.top || point.y === box.top + box.height) &&
          point.x >= box.left &&
          point.x <= box.left + box.width);
      expect(onBorder(from, ends.start), `${edge.id} leaves ${edge.from}`).toBe(true);
      expect(onBorder(to, ends.end), `${edge.id} arrives on ${edge.to}`).toBe(true);
    }
  });

  it('reads the ends off the path rather than off its string, for all four shapes', () => {
    // The old `pathEnds` tested the string for an `H` or a `V` and inherited the
    // other axis from the start point. That is right for a path with one of them
    // and wrong for a path with both, which the channel and the bracket are: the
    // channel's end came back as the start's y, on a line that changes y.
    expect(pathEnds('M 10 20 H 40')).toEqual({ start: { x: 10, y: 20 }, end: { x: 40, y: 20 } });
    expect(pathEnds('M 10 20 V 50')).toEqual({ start: { x: 10, y: 20 }, end: { x: 10, y: 50 } });
    expect(pathEnds('M 10 20 C 30 20 30 60 50 60')).toEqual({ start: { x: 10, y: 20 }, end: { x: 50, y: 60 } });
    expect(pathEnds('M 10 20 C 30 20 30 60 50 60 H 90')).toEqual({ start: { x: 10, y: 20 }, end: { x: 90, y: 60 } });
    expect(pathEnds('M 50 20 H 24 Q 10 20 10 34 V 76 Q 10 90 24 90 H 50')).toEqual({
      start: { x: 50, y: 20 },
      end: { x: 50, y: 90 },
    });
  });

  it('derives each path from the boxes, so a card that moves takes its line with it', () => {
    // The claim the whole derivation is for. The same route against a card moved
    // down by 100 draws the same shape 100 lower, rather than a line pointing at
    // where the card used to be -- which is the failure the old table's own
    // comment described.
    const from = NODE_BOXES['agent-endpoint'];
    const to = NODE_BOXES['llm-endpoint'];
    const route = {
      from: { side: 'right', along: 40 },
      to: { side: 'left', along: 50 },
      route: { kind: 'curve' },
    } as const;
    expect(edgePath(from, to, route)).toBe('M 672 200 C 713 200 713 86 754 86');
    expect(edgePath(from, { ...to, top: to.top + 100 }, route)).toBe('M 672 200 C 713 200 713 186 754 186');
  });
});

/**
 * THE DOT AND THE LINE ARE ONE THING, and they were drawn as two.
 *
 * The dot travelling along an edge is a `<span>` with the edge's own path string
 * as its `offset-path`, so the two cannot disagree about where the edge is. What
 * they CAN disagree about is where on the box the path is measured from, and that
 * is what shipped: `.arch-dot` carried both halves of two different centring
 * techniques at once and every dot on the tab was drawn 3.5px up and 3.5px left
 * of the line it belongs to -- half its own diameter, in both axes, on a 1.5px
 * line. It read as the dots belonging to a different drawing.
 *
 * A browser is the only thing that can position a motion path, and there is none
 * here. What can be checked is that the rule says what it means to: the box is at
 * the origin of the coordinate system the path is written in, its anchor is its
 * middle, and nothing else displaces it.
 */
describe('the travelling dot rides the line it belongs to', () => {
  const dot = rule(CSS, '.arch-dot');

  it('keeps hosting static while query and data edges flow', () => {
    const hosting = drawnEdges().find(
      (edge) => edge.from === 'semantic-index-endpoint' && edge.to === 'semantic-index'
    )!;
    const query = drawnEdges().find((edge) => edge.from === 'data-source-finder' && edge.to === 'semantic-index')!;
    const page = readFileSync(fileURLToPath(new URL('./ArchitecturePage.tsx', import.meta.url)), 'utf8');

    expect(hosting.relationship).toBe('hosting');
    expect(hosting.label).toBe('hosts');
    expect(query.relationship).toBe('flow');
    expect(page).toMatch(/edges\s*\.filter\(\(edge\) => edge\.relationship === 'flow'\)\s*\.map/);
    expect(rule(CSS, ".arch-edge[data-relationship='hosting']")).toMatch(/animation:\s*none/);
    expect(rule(CSS, ".arch-edge[data-relationship='hosting']")).toMatch(/stroke-dasharray:\s*none/);
  });

  it('places the box at the origin the path coordinates are stated in', () => {
    // A motion path is applied as a transform on top of the layout position, so
    // the layout position has to be (0, 0) of the canvas or every coordinate in
    // the path is out by wherever the box happened to sit.
    expect(dot).toMatch(/position:\s*absolute/);
    expect(px(dot, 'left')).toBe(0);
    expect(px(dot, 'top')).toBe(0);
  });

  it('displaces the box by nothing at all, which is what put the dots beside the lines', () => {
    // `margin: -3.5px` is the idiom for a marker whose TOP-LEFT is being placed.
    // With an anchor in the middle of the box it is applied on top of the
    // centring rather than instead of it, and the dot lands half its own width
    // off the path in both axes. Stated as an absence because the property is
    // harmless-looking and reappears every time somebody centres a dot from
    // memory.
    expect(pxList(dot, 'margin'), 'no margin on a box a motion path positions').toEqual([]);
    expect(dot, 'and no transform to fight the offset transform').not.toMatch(/[;{]\s*transform:/);
    expect(dot, 'and no inset beyond the origin').not.toMatch(/[;{]\s*(right|bottom):/);
  });

  it('anchors the middle of the dot to the path, and says so', () => {
    // `auto` resolves to `transform-origin`, which is the middle by default. The
    // default is not the claim being made, so the claim is written down.
    expect(dot).toMatch(/offset-anchor:\s*50%\s*50%/);
    expect(px(dot, 'width'), 'a round dot, so the anchor is its centre either way').toBe(px(dot, 'height'));
  });

  it('measures the dot and the line in the same coordinate space', () => {
    // The line is drawn in SVG user units and the dot is positioned in the
    // canvas's own pixels, and the two are only the same numbers because the
    // `<svg>` covers the canvas exactly and the viewBox is the canvas's size. A
    // padding on the canvas, a border, or an inset on the `<svg>` would shift one
    // of those spaces relative to the other and every dot would be off by that
    // amount -- the same symptom as the margin, from the other direction.
    const canvas = rule(CSS, '.arch-canvas');
    const edges = rule(CSS, '.arch-edges');
    expect(canvas).toMatch(/position:\s*relative/);
    expect(canvas, 'no padding or border to push the SVG off the canvas origin').not.toMatch(/padding|border/);
    expect(edges).toMatch(/inset:\s*0/);
    expect(edges).toMatch(/width:\s*100%/);
    expect(edges).toMatch(/height:\s*100%/);

    const page = readFileSync(fileURLToPath(new URL('./ArchitecturePage.tsx', import.meta.url)), 'utf8');
    expect(page).toMatch(/viewBox=\{`0 0 \$\{CANVAS_WIDTH\} \$\{CANVAS_HEIGHT\}`\}/);
  });

  it('gives each flow dot the path itself rather than a second copy of the geometry', () => {
    // The page hands each dot `edge.d` -- the same string the `<path>` is drawn
    // from -- and the assertion is on the source because there is no browser here
    // to read a computed motion path back out of. A dot positioned from its
    // node's box coordinates instead would be the same class of defect one level
    // up: two descriptions of one edge.
    const page = readFileSync(fileURLToPath(new URL('./ArchitecturePage.tsx', import.meta.url)), 'utf8');
    expect(page).toMatch(/offsetPath: `path\('\$\{edge\.d\}'\)`/);
    // The path now carries scope metadata after `d`; the geometry still comes
    // directly from `edge.d`, and no second path expression is introduced.
    expect(page).toMatch(/<path[\s\S]*?className="arch-edge"[\s\S]*?d=\{edge\.d\}[\s\S]*?\/>/);
    expect(page.match(/d=\{edge\.d\}/g)).toHaveLength(1);
  });
});

describe('the colours state what a connection is, and are the app\u2019s own', () => {
  it('paints every accent from a token this app declares', () => {
    for (const [accent, token] of Object.entries(ACCENT_TOKEN)) {
      expect(TOKENS, `${accent} names ${token}`).toContain(`${token}:`);
    }
  });

  it('gives each accent one colour, so two kinds of connection cannot look alike', () => {
    const tokens = Object.values(ACCENT_TOKEN);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('spends an accent on each card and each edge, and never on a status', () => {
    // Status has its own two treatments and they are the only coloured ones. This
    // is the same assertion architecture-honesty.test.ts makes from the other
    // side; here it is about the accents not leaking into the pills.
    for (const box of Object.values(NODE_BOXES)) {
      expect(ACCENT_TOKEN[box.accent]).toBeDefined();
    }
    for (const edge of drawnEdges()) {
      expect(ACCENT_TOKEN[edge.accent]).toBeDefined();
    }
  });
});

/**
 * The check that was missing, and the defect it now catches.
 *
 * Everything above compares the LAYOUT to the canvas: cards inside it, paths
 * inside it, captions clear of cards. Nothing compared the CANVAS to the space
 * it has to be drawn in, so a canvas 106px wider than its panel could ever be
 * satisfied every geometry test in this file while putting a horizontal
 * scrollbar under the drawing for every reader on every window size. It did,
 * from the day the tab was rebuilt until this was written.
 *
 * The ceiling is computed from the stylesheets rather than remembered, because a
 * remembered one goes stale the first time somebody adjusts the shell's padding
 * and nobody re-runs the arithmetic in their head.
 */
describe('the canvas fits the panel it is drawn in', () => {
  it('is no wider than the widest that panel ever gets', () => {
    expect(CANVAS_WIDTH).toBeLessThanOrEqual(CANVAS_MAX_WIDTH);
  });

  it('computes that ceiling from the stylesheets rather than remembering it', () => {
    // .page-shell caps the page and its side padding comes OUT of that cap:
    // box-sizing is border-box for everything (styles/base.css), which is the
    // one assumption in this sum that is not visible in the two rules below.
    expect(readFileSync(fileURLToPath(new URL('./styles/base.css', import.meta.url)), 'utf8')).toMatch(
      /\*\s*\{[^}]*box-sizing:\s*border-box/
    );

    const shell = rule(SHELL, '.page-shell');
    const panel = rule(CSS, '.arch-flow');
    const inner =
      px(shell, 'max-width') - 2 * clampCeiling(shell, 'padding') - 2 * (px(panel, 'padding') + px(panel, 'border'));

    expect(inner).toBe(CANVAS_MAX_WIDTH);
  });

  it('leaves room for a scrollbar to take its width out of the viewport', () => {
    // A classic desktop scrollbar is 15-17px and comes out of the layout
    // viewport, so the panel at a 1440px window is nearer 1279 than 1294. The
    // ceiling above is the no-scrollbar case; this is what makes the real one
    // fit, and it is why the last 30px must not be spent on a wider card.
    expect(CANVAS_MAX_WIDTH - CANVAS_WIDTH).toBeGreaterThanOrEqual(20);
  });

  it('has nothing between the panel and the canvas that eats width', () => {
    // The sum above goes straight from .arch-flow to the canvas. A padding or a
    // border on the scroller in between would make it wrong by that much, in
    // the direction that brings the scrollbar back.
    const scroller = rule(CSS, '.arch-canvas-scroll');
    expect(px(scroller, 'padding')).toBe(0);
    expect(px(scroller, 'border')).toBe(0);
  });

  it('spends none of that width on margin it does not need', () => {
    // The canvas is exactly the drawing plus a margin, and the same margin each
    // side. Stated as a test because the easy way to "fix" a future overflow is
    // to leave the cards alone and let the canvas keep its old number, which
    // gives back the scrollbar with a strip of white where the fix should be.
    const lefts = Object.values(NODE_BOXES).map((box) => box.left);
    const rights = Object.values(NODE_BOXES).map((box) => box.left + box.width);
    const before = Math.min(...lefts);
    const after = CANVAS_WIDTH - Math.max(...rights);
    expect(after, 'the margin on the right matches the one on the left').toBe(before);
    expect(before, 'and neither is room a card could have had').toBeLessThanOrEqual(12);
  });

  it('would notice a canvas that had outgrown the panel again', () => {
    // The arithmetic, not just the constant: this is the check failing on the
    // width the tab actually shipped with, which is the only way to know it
    // would have caught it.
    expect(1400).toBeGreaterThan(CANVAS_MAX_WIDTH);
  });

  it('is exactly as tall as the cards need, plus the margin above the first one', () => {
    // The height is not a design figure and must not become one: it is the
    // tallest column stacked, and the air under the last card matches the air
    // over the first. A canvas taller than that is a strip of white the page
    // scrolls past; shorter, and a card is drawn outside its own frame.
    const tops = Object.values(NODE_BOXES).map((box) => box.top);
    const bottoms = Object.values(NODE_BOXES).map((box) => box.top + box.height);
    expect(CANVAS_HEIGHT - Math.max(...bottoms)).toBe(Math.min(...tops));
  });

  it('grew downwards rather than sideways, which is the trade this fix made', () => {
    // Vertical space is free -- the page scrolls that way already -- and the
    // sideways scroll was the whole of the original complaint. So the canvas got
    // taller than the 760 it was and not one pixel wider.
    expect(CANVAS_HEIGHT).toBeGreaterThan(760);
    expect(CANVAS_WIDTH).toBe(1264);
  });
});

describe('the drawing keeps its shape at every width', () => {
  it('never rearranges itself into a second diagram', () => {
    // The version before this one collapsed into a stacked list below 1024px,
    // which is two diagrams where the design describes one, and the narrow one was
    // the one nobody had looked at. The drawing has ONE arrangement at every width
    // it is drawn at; what changes below the fit floor is whether it is drawn at
    // all, and what stands in for it is words rather than the same cards restacked.
    expect(CSS).not.toMatch(/\.arch-node\s*\{[^}]*position:\s*static/);
    // And the threshold below is not a width invented in this stylesheet, which
    // is what breakpoints.test.ts refuses and what the 1024px collapse was.
    expect(CSS.match(/@media\s*\((?:max|min)-width:/g) ?? []).toEqual([]);
  });

  it('keeps the scroller as a safety valve rather than as the answer', () => {
    // `auto`, so it shows nothing while the drawing fits -- which, with the stand
    // down below, is always. It stays because the failure it would catch is the
    // one that must not happen silently: if the arithmetic here were ever wrong,
    // a bar is an honest report and `overflow: hidden` would be a clipped label,
    // which is the defect this whole mechanism exists to remove.
    expect(CSS).toMatch(/\.arch-canvas-scroll\s*\{[^}]*overflow-x:\s*auto/);
  });

  /**
   * FITTING THE PANEL, which is what the fixed canvas never did below 1294px:
   * the right-hand column sat under the frame and a reader saw a drawing with its
   * labels cut off. The ceiling checks above are still the contract at full size;
   * this is what happens on the windows that are narrower than it.
   */
  it('draws at full size when the panel is at least as wide as the canvas', () => {
    // No slack at or above the canvas's own width, and none is needed: no `zoom`
    // is applied there, so an integer canvas inside an equal-or-wider panel
    // cannot round its way into an overflow.
    expect(canvasScale(CANVAS_WIDTH)).toBe(1);
    expect(canvasScale(CANVAS_MAX_WIDTH)).toBe(1);
    expect(canvasScale(1920)).toBe(1);
  });

  it('draws at full size before it has been measured, and on the server', () => {
    expect(canvasScale(0)).toBe(1);
    expect(canvasScale(Number.NaN)).toBe(1);
  });

  it('fits the whole drawing into a panel narrower than the canvas', () => {
    // 1100 of panel is a 1280 window, which is where the clipping was reported.
    const scale = canvasScale(1100);
    expect(scale).toBeLessThan(1);
    // The whole width fits, which is the only thing that stops a label being cut.
    expect(CANVAS_WIDTH * scale).toBeLessThanOrEqual(1100);
  });

  it('stops shrinking at the floor rather than drawing type nobody can read', () => {
    expect(canvasScale(400)).toBe(MIN_CANVAS_SCALE);
    // And at the floor the drawing is wider than the panel, which is precisely
    // why it is not drawn there at all. See the stand-down below.
    expect(CANVAS_WIDTH * canvasScale(400)).toBeGreaterThan(400);
  });

  /**
   * WHAT A READER ACTUALLY GETS, which is the table the floor should have been
   * derived from in the first place.
   *
   * Every common window, through the shell's own arithmetic. The point of stating
   * it as a test is that "the drawing is scaled" is not by itself a complaint --
   * at the two widest sizes there is no scaling at all -- and the floor is what
   * happens off the end of this range rather than what anybody sees.
   */
  it('draws at these scales, for the windows a reader is on', () => {
    const table: ReadonlyArray<[number, number]> = [
      [1512, 1],
      [1440, 1],
      [1366, 0.966],
      [1280, 0.903],
      [1024, 0.717],
    ];
    for (const [window, scale] of table) {
      expect(canvasScale(panelAt(window)), `${window}px window`).toBeCloseTo(scale, 3);
    }
  });

  it('derives the floor from the narrowest of those, so all of them fit', () => {
    // 0.72 was a judgement about legibility and was one pixel the wrong side of
    // the window it was picked for: 1264 x 0.72 is 910 drawn into 908 of panel,
    // which is all of the shrinking and none of the fit. Rounded down instead,
    // because the point of a floor is that everything above it fits.
    const narrowest = panelAt(1024);
    expect(CANVAS_WIDTH * canvasScale(narrowest)).toBeLessThanOrEqual(narrowest - CANVAS_FIT_SLACK);
    expect(MIN_CANVAS_SCALE).toBeLessThanOrEqual((narrowest - CANVAS_FIT_SLACK) / CANVAS_WIDTH);
    expect(CANVAS_WIDTH * 0.72, 'which the old floor did not').toBeGreaterThan(narrowest);
  });

  /**
   * NO HORIZONTAL SCROLLBAR, AND NOTHING OFF THE VISIBLE AREA. Sam's ruling, and
   * the one requirement here that no amount of tidy geometry establishes on its
   * own: the canvas can fit its panel while the card at either end does not,
   * because the fit is applied by `zoom` and the placement is stated in pixels,
   * and those are two mechanisms that were each checked alone.
   *
   * A fit computed as exactly `panelWidth / CANVAS_WIDTH` draws 1264 x s into s x
   * 1264 of panel, which is equal to it and therefore fits -- in arithmetic. In an
   * engine, the panel's measured width is fractional and the zoomed canvas is
   * snapped to device pixels, and the two round independently. When they round
   * apart the scroller shows a bar over a drawing that fits, and once the reader
   * has nudged it, the left-hand card loses its first letter behind the frame.
   * That is indistinguishable from a clipped layout, which is why it was reported
   * as the Browser card being cut off. {@link CANVAS_FIT_SLACK} is the answer, and
   * this is the check that keeps it.
   */
  it('fits the whole drawing, card edges included, at every width a reader has', () => {
    for (const window of [1920, 1512, 1440, 1366, 1280, 1152, 1024]) {
      const panel = panelAt(window);
      const span = fittedSpan(panel);
      expect(span.width, `${window}px window: the canvas fits the panel`).toBeLessThanOrEqual(panel);
      expect(span.left, `${window}px window: the leftmost card starts inside it`).toBeGreaterThan(0);
      expect(span.right, `${window}px window: the rightmost card ends inside it`).toBeLessThanOrEqual(panel);
      // And the fit is not to the pixel, which is the part that produced a bar.
      expect(panel - span.width, `${window}px window: room to round into`).toBeGreaterThanOrEqual(
        panel >= CANVAS_WIDTH ? 0 : CANVAS_FIT_SLACK
      );
    }
  });

  /**
   * NO HORIZONTAL SCROLLBAR AT ANY WIDTH, WHICH THE FIT ALONE NEVER GAVE.
   *
   * The check above stops at 1024px, and that was the honest limit of what the
   * fit could promise: below about 1015px of window the floor binds, the drawing
   * stays wider than the panel, and the scroller shows a bar. "Scrolls below the
   * floor" was written down as the documented behaviour, and it is the same defect
   * the fit was introduced to remove, just moved to narrower windows. 480px is a
   * declared breakpoint of this app, and there the drawing would be four times too
   * wide.
   *
   * So the drawing stands down instead. The claim below is the whole requirement,
   * over the WHOLE declared range rather than the comfortable end of it: at every
   * width, either the drawing fits with room to spare, or it is not drawn.
   */
  it('either fits with room to spare or is not drawn, at every declared width', () => {
    const windows = [1920, 1512, 1440, 1366, 1280, 1180, 1152, 1024, 900, 800, 600, 480, 375, 320];
    const drawn = windows.filter((window) => canvasFits(panelAt(window)));

    // The loop below is vacuous if the drawing stands down everywhere, and a
    // requirement met by never drawing anything is not the requirement. Every
    // window a reader is plausibly on keeps the diagram; the list takes over at
    // the tablet end, which is where the type would otherwise be unreadable.
    expect(drawn).toContain(1024);
    expect(drawn).toContain(1440);
    expect(drawn).not.toContain(800);
    expect(drawn).not.toContain(375);

    for (const window of windows) {
      const panel = panelAt(window);
      if (!canvasFits(panel)) continue;
      const span = fittedSpan(panel);
      expect(span.width, `${window}px window: the canvas fits the panel`).toBeLessThanOrEqual(panel);
      expect(span.left, `${window}px window: the leftmost card starts inside it`).toBeGreaterThan(0);
      expect(span.right, `${window}px window: the rightmost card ends inside it`).toBeLessThanOrEqual(panel);
      expect(panel - span.width, `${window}px window: room to round into`).toBeGreaterThanOrEqual(
        panel >= CANVAS_WIDTH ? 0 : CANVAS_FIT_SLACK
      );
    }
  });

  /**
   * And the two halves of that meet exactly, with nothing between them. A gap
   * would be a band of widths where the drawing is shown and does not fit, which
   * is the bar; an overlap would be widths where it stands down although it fits,
   * which is losing the diagram for nothing.
   */
  it('stands down exactly where the fit stops working, neither early nor late', () => {
    expect(canvasFits(MIN_CANVAS_PANEL)).toBe(true);
    expect(CANVAS_WIDTH * canvasScale(MIN_CANVAS_PANEL)).toBeLessThanOrEqual(MIN_CANVAS_PANEL - CANVAS_FIT_SLACK);

    const justUnder = MIN_CANVAS_PANEL - 1;
    expect(canvasFits(justUnder)).toBe(false);
    // Which it has to be, because at that width the drawing genuinely does not
    // fit: the floor holds the scale up and the canvas overruns the panel.
    expect(CANVAS_WIDTH * canvasScale(justUnder)).toBeGreaterThan(justUnder - CANVAS_FIT_SLACK);
  });

  it('draws at full size before the panel has been measured, rather than standing down', () => {
    // The server render and the first paint. Standing down on an unmeasured panel
    // would flash the list on every load of the tab.
    for (const width of [0, Number.NaN, -1]) expect(canvasFits(width)).toBe(true);
  });

  /**
   * What stands in for the drawing is the SAME list a screen reader is given, and
   * that is the whole reason this is not the 1024px collapse coming back. That one
   * was a second arrangement of the same eleven cards; this is one set of
   * sentences that was already being built, already asserted line for line in
   * architecture-honesty.test.ts, and already read by somebody at every width.
   */
  it('shows the list it already had rather than a second drawing', () => {
    expect(rule(CSS, '.arch-equivalent')).toMatch(/list-style:\s*decimal/);
    expect(CSS).toMatch(
      /@container architecture \(min-width:\s*900px\)\s*\{[\s\S]*\.arch-equivalent\s*\{[^}]*display:\s*none/
    );
    // The base state is the safe narrow state; the query changes visibility,
    // never the node arrangement.
    expect(rule(CSS, '.arch-canvas-scroll')).toMatch(/display:\s*none/);
  });

  it('would notice a fit computed to the pixel, which is what shipped', () => {
    // The check failing on the arithmetic it replaced. A panel one pixel narrower
    // than the canvas used to draw 1263 into 1263 and call it fitted; it now
    // leaves the slack, and the difference is the whole defect.
    const panel = CANVAS_WIDTH - 1;
    expect(CANVAS_WIDTH * (panel / CANVAS_WIDTH), 'the old fit left nothing').toBe(panel);
    expect(CANVAS_WIDTH * canvasScale(panel)).toBeLessThanOrEqual(panel - CANVAS_FIT_SLACK);
  });

  it('sizes the cards in the same space the paths are drawn in', () => {
    // `box-sizing: border-box` is not tidiness here: without it every card is
    // 27px wider than the width the captions were placed against.
    expect(CSS).toMatch(/\.arch-node\s*\{[^}]*box-sizing:\s*border-box/);
  });

  it('keeps a caption readable where it grazes a card, without moving it', () => {
    // A halo in the panel's colour, painted UNDER the glyphs so it thickens
    // nothing. The captions are placed in the gaps and the checks above keep
    // them there; this is what stops a graze becoming an unreadable caption.
    const label = rule(CSS, '.arch-edge-label');
    expect(label).toMatch(/paint-order:\s*stroke/);
    expect(label).toMatch(/stroke:\s*var\(--card\)/);
  });

  it('freezes the dashes and the dots for anyone who asked for less motion', () => {
    const guard = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    // `!important`, because each dot carries its timing as an inline style and
    // an ordinary rule cannot outrank one.
    expect(guard).toMatch(/animation: none !important/);
    expect(guard).toMatch(/stroke-dasharray: none/);
    expect(guard).toMatch(/\.arch-edge\[data-control-active='true'\],[\s\S]*transition:\s*none/);
    // The scope glow is static at every motion preference. There is no pulse to
    // leave running after the existing animation guard has frozen the diagram.
    expect(CSS).not.toMatch(/@keyframes\s+arch-(?:bound|scope|glow)/);
  });

  it('starts the dots invisible, so the frozen frame is not ten parked markers', () => {
    const dot = CSS.slice(CSS.indexOf('.arch-dot {'), CSS.indexOf('@keyframes arch-travel'));
    expect(dot).toMatch(/opacity:\s*0/);
  });
});

describe('the runtime-bound colour follows the architecture legend', () => {
  it('gives each KPI a legend family rather than three unrelated API colours', () => {
    expect(rule(CSS, ".arch-loop-tiles li[data-accent='agent']")).toMatch(
      /--arch-bound-color:\s*var\(--ast-primary-control-border\)/
    );
    expect(rule(CSS, ".arch-loop-tiles li[data-accent='genie']")).toMatch(/--arch-bound-color:\s*var\(--db-teal-600\)/);
    expect(rule(CSS, ".arch-loop-tiles li[data-accent='question']")).toMatch(/--arch-bound-color:\s*var\(--ast-blue\)/);
    expect(rule(CSS, ".arch-canvas[data-active-accent='agent']")).toMatch(
      /--arch-active-bound:\s*var\(--ast-primary-control-border\)/
    );
    expect(rule(CSS, ".arch-canvas[data-active-accent='genie']")).toMatch(
      /--arch-active-bound:\s*var\(--db-teal-600\)/
    );
    expect(rule(CSS, ".arch-canvas[data-active-accent='question']")).toMatch(
      /--arch-active-bound:\s*var\(--ast-blue\)/
    );
    expect(CSS).not.toMatch(/--arch-bound-(?:steps|tools|run)/);
  });

  it('paints a selected node as a sticky outline and a transparent wash, never a white fill', () => {
    // The unscoped paint rule, not the reduced-motion guard and not the
    // dark-theme restatement. Those share the class and would hide the outline.
    const at = CSS.indexOf('.arch-node.arch-node-selected {\n  outline:');
    expect(at).toBeGreaterThan(-1);
    const selected = CSS.slice(at, CSS.indexOf('}', at));
    expect(selected).toMatch(/outline:\s*3px solid var\(--arch-active-bound\)/);
    expect(selected).toMatch(/background:\s*color-mix\(in srgb, var\(--arch-active-bound\) 28%, transparent\)/);
    expect(selected).not.toMatch(/filter:/);
    expect(selected).not.toMatch(/#fff|#ffffff|white|--card|--ast-white|--background/i);
    expect(rule(CSS, "html[data-theme='dark'] .arch-node.arch-node-selected")).toMatch(
      /background:\s*color-mix\(in srgb, var\(--arch-active-bound\) 28%, transparent\)/
    );
    expect(rule(CSS, '.arch-loop-tiles li')).toMatch(/outline:\s*3px solid transparent/);
    expect(rule(CSS, '.arch-loop-tiles li.arch-bound-selected')).toMatch(/outline-color:\s*var\(--arch-bound-color\)/);
    expect(rule(CSS, '.arch-loop-tiles li.arch-bound-selected')).not.toMatch(/background:/);
    expect(rule(CSS, '.arch-loop-tiles li.arch-bound-selected')).not.toMatch(/filter:/);
    expect(
      rule(
        CSS,
        '.arch-bound-tile:hover,\n.arch-bound-tile:active,\n.arch-bound-tile:focus,\n.arch-bound-tile:focus-visible'
      )
    ).toMatch(/background:\s*transparent/);
    expect(CSS).not.toMatch(/--arch-active-bound:\s*var\(--ast-navy\)/);
    expect(CSS).not.toMatch(/--arch-bound-color:\s*var\(--ast-navy\)/);
  });

  it('gives the four dependency tiles the same pane fill as LIVE DATA FLOW', () => {
    // Outline-only left stars sitting on Dependencies / Reachable / Not checked
    // / Drift. `--card` is the Architecture pane token, shared with the flow
    // and the rails -- not a new gray and not the Connections slab mix.
    expect(rule(CSS, '.arch-loop-tiles li')).toMatch(/background:\s*var\(--card\)/);
    expect(rule(CSS, '.arch-flow')).toMatch(/background:\s*var\(--card\)/);
    expect(rule(CSS, '.arch-rail')).toMatch(/background:\s*var\(--card\)/);
  });
});

/**
 * NOTHING IS DRAWN ON TOP OF ANYTHING. The check this file did not have.
 *
 * Everything above compares one thing to the canvas, or a caption's single
 * ANCHOR POINT to a card. None of it can answer "do two things occupy the same
 * pixels", and that is the question the tab shipped wrong: twelve cards on a
 * 160px pitch, four of them taller than the pitch, each one painted over the one
 * before it in model order. What a reader saw was a card with no title.
 *
 * So: every card's rectangle and every caption's rectangle, in one list, and no
 * pair of them may intersect. The rectangles are the real ones -- a card's own
 * derived height, and a caption's width from its words and its anchor -- and the
 * cards are checked against the captions as well as against each other, because
 * both of those went wrong at different times in this file's history.
 */
describe('nothing on the canvas is drawn over anything else', () => {
  it('finds no pair of card or caption rectangles that intersect', () => {
    expect(overlappingRects()).toEqual([]);
  });

  it('has a rectangle for every card and every caption, and no others', () => {
    // A collision check over an incomplete list is the failure mode that put this
    // one here, so the list is counted rather than trusted.
    const rects = drawnRects();
    expect(rects).toHaveLength(ARCHITECTURE_NODES.length + ARCHITECTURE_EDGES.length);
    expect(new Set(rects.map((entry) => entry.id)).size).toBe(rects.length);
    for (const entry of rects) {
      expect(entry.rect.width, `${entry.id} has a width`).toBeGreaterThan(0);
      expect(entry.rect.height, `${entry.id} has a height`).toBeGreaterThan(0);
    }
  });

  it('would notice a collision, on a pair moved together on purpose', () => {
    // The detector itself, before it is trusted over the real table: a card
    // against a copy of itself nudged down overlaps, and the same copy moved by
    // exactly its own height does not, which pins both the test and the
    // touching-is-not-overlapping edge the row gaps are stated against.
    const dictionary = NODE_BOXES['genie-dictionary'];
    expect(rectsOverlap(dictionary, { ...dictionary, top: dictionary.top + 10 })).toBe(true);
    expect(rectsOverlap(dictionary, { ...dictionary, top: dictionary.top + dictionary.height })).toBe(false);
  });

  it('rejects the pitch the Dictionary and Data Genie cards shipped on', () => {
    // THE REGRESSION THIS FILE EXISTS TO PREVENT, stated as the rule it broke
    // rather than as an intersection, because at the shipped numbers it was not
    // one yet: 160 of pitch against a 157 card is three pixels of air. Asserting
    // those two rectangles intersect would be asserting something false, and a
    // test that lies about the bug it names is worse than no test -- so what is
    // pinned is that three pixels does not clear ROW_GAP_MIN, which is the check
    // that would have failed on the geometry as shipped.
    //
    // Three pixels is also why nothing looked wrong until it was: the pair had no
    // room for the caption between them, and the first sentence added to either
    // role paragraph -- or, as it turned out, one status word four characters
    // longer than the model allowed for -- spent it and put the Dictionary card
    // over the Data Genie title.
    const dictionary = NODE_BOXES['genie-dictionary'];
    const data = NODE_BOXES['genie-data'];
    const shippedPitch = 160;
    const shippedHeight = 157;
    expect(shippedPitch - shippedHeight, 'the air the old pitch left').toBe(3);
    expect(shippedPitch - shippedHeight).toBeLessThan(ROW_GAP_MIN);
    expect(dictionary.height).toBeLessThan(shippedHeight);
    // And what it is now, which is the rule holding on the real table.
    expect(data.top - (dictionary.top + dictionary.height)).toBeGreaterThanOrEqual(ROW_GAP_MIN);
  });

  it('keeps the card that was cut off by the old canvas inside this one', () => {
    // The other half of "hidden or clipped", and the half that WAS unambiguous:
    // the Vector Search endpoint card ended 33px below a canvas of 760, and the
    // scroller is `overflow-y: hidden` -- see architecture.css -- so those pixels,
    // its "Open in Databricks" link among them, were not scrolled to but simply
    // not drawn. Stated against the canvas rather than against the old bottom
    // edge, because that figure has moved twice since and the rule has not.
    const endpoint = NODE_BOXES['semantic-index-endpoint'];
    expect(endpoint.top + endpoint.height).toBeLessThanOrEqual(CANVAS_HEIGHT);
    expect(endpoint.top + endpoint.height, 'and it is the lowest card in its column').toBeGreaterThan(760);
    expect(rule(CSS, '.arch-canvas-scroll'), 'the clip is real').toMatch(/overflow-y:\s*hidden/);
  });

  /**
   * NOT TOUCHING IS NOT THE REQUIREMENT. The check this file did not have either.
   *
   * Everything above this asks whether two rectangles intersect, and the answer
   * was no while a reader was reporting captions sitting on card edges. Both
   * statements were true: "question" stood 1.2px clear of the two cards it runs
   * between, "invoke" and "serves" 4.4px, "metrics" 7px. A pixel of white does
   * not read as white -- it reads as a caption printed on a border -- and the
   * halo in architecture.css exists because of it, which is the tell that the
   * placement was being compensated for rather than fixed.
   *
   * So the floor is a DISTANCE, and it is checked at every scale, because `zoom`
   * shrinks a clearance by the same fraction it shrinks the cards.
   */
  it('leaves real white between every caption and everything beside it', () => {
    for (const entry of labelClearances()) {
      expect(entry.gap, `${entry.id} is clear of ${entry.nearest}`).toBeGreaterThanOrEqual(LABEL_CLEAR_MIN);
    }
  });

  it('holds that clearance at every scale, because zoom multiplies it too', () => {
    // Stated as the SCALING IDENTITY rather than by recomputing the floor at each
    // width, and the reason is worth recording: written the obvious way -- assert
    // every clearance at 0.71 against `LABEL_CLEAR_MIN * 0.71` -- the tightest
    // caption came out at 8.519999999999982 against a floor of 8.52 and the suite
    // failed on the last bit of a double. A test that can be satisfied by adding
    // an epsilon is a test that will be, so this asserts the thing that is
    // actually true instead: a clearance is a distance, zoom is a uniform scale,
    // so nothing that is open at full size can be closed at any other width.
    const full = labelClearances();
    for (const scale of [MIN_CANVAS_SCALE, 0.8, 0.903, 1]) {
      const scaled = labelClearances(scale);
      expect(scaled.map((entry) => entry.id)).toEqual(full.map((entry) => entry.id));
      for (const [at, entry] of scaled.entries()) {
        expect(entry.gap, `${entry.id} at ${scale}`).toBeCloseTo(full[at].gap * scale, 6);
      }
    }

    // And what the floor draws that minimum AS, which is the question the scale
    // identity does not answer: 12px at 0.71 is 8.5, and 8.5px of white between a
    // caption and a card is still white a reader reads as a gap.
    expect(Math.min(...full.map((entry) => entry.gap)) * MIN_CANVAS_SCALE).toBeGreaterThan(8);
  });

  it('measures that distance rather than trusting it, on a pair placed by hand', () => {
    // The detector before the table it judges. The diagonal case is the one worth
    // pinning: measured as the smaller axis separation -- which is the obvious
    // way to write this, and was how it was written first -- two things a corner
    // apart score as the height of the offset, and the sweep above then failed on
    // "question" being 9px from "invoke" while the two are 200px apart on screen.
    const box: Rect = { left: 0, top: 0, width: 10, height: 10 };
    expect(rectGap(box, { ...box, left: 25 })).toBe(15);
    expect(rectGap(box, { ...box, top: 25 })).toBe(15);
    expect(rectGap(box, { left: 25, top: 14, width: 10, height: 10 })).toBeCloseTo(Math.hypot(15, 4), 6);
    // And the overlap, which must NOT come back as a clearance of zero: that is
    // overlappingRects's to report by name, and folding it in here would let a
    // collision satisfy a floor stated as "at least".
    expect(rectGap(box, { ...box, left: 5 }), 'an overlap is not a small gap').toBeNull();
  });

  it('sizes every corridor for the longest caption standing in it', () => {
    // The rule the width table is derived from, asserted against the table: the
    // gap between two columns is at least the widest caption placed in it plus
    // the clearance at each end. Stated positively so a future edit that narrows
    // a corridor fails here with the arithmetic in hand, rather than in the sweep
    // above with one caption named and no reason given.
    const columns = [...new Set(Object.values(NODE_BOXES).map((box) => box.left))].sort((a, b) => a - b);
    const corridors = columns.slice(0, -1).map((left, at) => {
      const width = Math.max(
        ...Object.values(NODE_BOXES)
          .filter((box) => box.left === left)
          .map((box) => box.width)
      );
      return { from: left + width, to: columns[at + 1] };
    });

    for (const edge of drawnEdges()) {
      const label = labelRect(edge);
      const corridor = corridors.find((gap) => label.left >= gap.from && label.left + label.width <= gap.to);
      // Several captions hang in the VERTICAL gap inside a column instead --
      // `conversation`, `trace`, `governed reads`, `plan + prose` -- and the row
      // gaps are what clear those. This is about the ones in a corridor.
      if (!corridor) continue;
      expect(corridor.to - corridor.from, `the corridor holding "${edge.label}"`).toBeGreaterThanOrEqual(
        label.width + 2 * LABEL_CLEAR_MIN
      );
    }
  });

  it('holds at every width the fit function produces, because scale cannot fix it', () => {
    // `zoom` multiplies every coordinate by the same number, so an overlap at
    // full size is the same overlap at 0.71 and a gap is the same gap. That is
    // exactly why fitting the canvas to the panel -- the half of this defect that
    // was fixed first -- did nothing for the half that was not: it scaled the
    // overlap along with everything else.
    //
    // Stated as a test because "we fixed the width, why are the labels still
    // hidden" was a real question, and the answer is a property of the geometry
    // rather than of the panel.
    const scales = [0, 320, 640, 908, 1100, 1264, 1294, 1920].map((width) => canvasScale(width));
    expect(new Set(scales).size, 'the widths tried do produce different scales').toBeGreaterThan(1);
    for (const scale of scales) {
      const scaled = drawnRects().map(({ id, rect }) => ({
        id,
        rect: {
          left: rect.left * scale,
          top: rect.top * scale,
          width: rect.width * scale,
          height: rect.height * scale,
        },
      }));
      for (let i = 0; i < scaled.length; i += 1) {
        for (let j = i + 1; j < scaled.length; j += 1) {
          expect(rectsOverlap(scaled[i].rect, scaled[j].rect), `${scaled[i].id} and ${scaled[j].id} at ${scale}`).toBe(
            false
          );
        }
      }
    }
  });

  it('keeps the two captions that hang in a gap out from under both cards', () => {
    // `conversation` and `trace` are placed inside their own column's x range, so
    // unlike the captions in the corridors between columns they are only clear
    // because of the vertical space above the storage row. They were occluded
    // alongside the Data Genie title and for the same reason.
    for (const [label, above, below] of [
      ['conversation', 'app', 'lakebase'],
      ['trace', 'agent-endpoint', 'experiment-id'],
    ] as const) {
      const edge = drawnEdges().find((candidate) => candidate.label === label)!;
      const caption = labelRect(edge);
      const over = NODE_BOXES[above];
      const under = NODE_BOXES[below];
      expect(caption.top, `${label} clears ${above}`).toBeGreaterThanOrEqual(over.top + over.height);
      expect(caption.top + caption.height, `${label} clears ${below}`).toBeLessThanOrEqual(under.top);
      // And the anchor is inside the column, which is what makes the above the
      // only thing keeping the words readable.
      expect(edge.labelX).toBeGreaterThan(over.left);
      expect(edge.labelX).toBeLessThan(over.left + over.width);
    }
  });
});
