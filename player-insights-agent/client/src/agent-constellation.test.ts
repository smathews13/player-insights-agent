import { describe, expect, it } from 'vitest';

import {
  boxesOverlap,
  buildMapConstellation,
  buildPathConstellation,
  elide,
  labelBudget,
  labelSide,
  labelWidth,
  mapHeight,
  mapRows,
  pathHeight,
  pathPitch,
  pathStarY,
  starBox,
  starLabel,
  starMeta,
  LABEL_REACH,
  MAP_PAD_X,
  MAP_ROW_GAP,
  MAP_STAR_BAND,
  MAP_WIDTH,
  MIN_STAR_GAP,
  PATH_BAND_LEFT,
  PATH_BAND_RIGHT,
  PATH_MAX_PITCH,
  PATH_MIN_PITCH,
  PATH_WIDTH,
  SELECTED_RING,
  STAR_REACH,
  type LabelBox,
} from './agent-constellation';
import type { TraceStage } from './answer-shape';

/**
 * Where the stars go, checked as arithmetic.
 *
 * THIS FILE IS THE REASON THE GEOMETRY IS A MODULE. The agent map has run off the
 * right-hand edge of the page twice. The first fix was one row with
 * `overflow-x: auto`, which parked the later stages of an ordinary eight-step run
 * behind a scrollbar on a container nothing announced as scrollable. The second
 * was a flex wrap, which shares out leftover width per row and so put nine cards
 * in nine places that lined up under nothing. Both were cosmetic, both passed
 * review, and both came back.
 *
 * So the claim this file holds is not "it looks right at the width I tried". It is
 * that EVERY COORDINATE IS DERIVED FROM THE BOX AND THE STEP COUNT, and that at
 * every step count a run can actually have, nothing lands outside the box. A
 * drawing that cannot overflow arithmetically cannot overflow on screen, and the
 * arithmetic is the part vitest can read on `node`.
 *
 * What is NOT checked here, because it cannot be without a browser: how any of it
 * looks, and where a proportional face actually ends a string. The label widths
 * below are computed from a deliberately generous upper bound on DM Sans's
 * advance, so a label this file calls "fitting" fits with room rather than
 * exactly. `agent-constellation.ts` says where that bound came from.
 */

function stage(overrides: Partial<TraceStage> & Pick<TraceStage, 'id'>): TraceStage {
  return {
    name: 'Chose the next step',
    kind: 'agent',
    start: 0,
    duration: 1829,
    status: 'complete',
    calls: 1,
    input: '',
    output: '',
    startMeasured: true,
    ...overrides,
  };
}

/** Eight stages, the length of an ordinary run of this agent. */
const run: TraceStage[] = [
  stage({ id: 'step-1' }),
  stage({ id: 'step-1-1-search_semantics', name: 'Searched the semantic layer', kind: 'tool', duration: 604 }),
  stage({ id: 'step-2' }),
  stage({ id: 'step-2-1-dictionary_genie', name: 'Checked a field definition', kind: 'tool', duration: 13400 }),
  stage({ id: 'step-3' }),
  stage({ id: 'step-3-1-data_genie', name: 'Queried governed data', kind: 'tool', duration: 11390 }),
  stage({ id: 'plot', name: 'Drew the chart', kind: 'tool', duration: 2920 }),
  stage({ id: 'synthesis', name: 'Wrote the answer', duration: 9880 }),
];

/**
 * A run of any length, alternating a decision with the longest real tool name.
 *
 * `search_tagged_assets` is the longest tool the app knows, at twenty characters,
 * so a run built from it is the widest set of labels a real trace can produce.
 */
function runOf(count: number): TraceStage[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? stage({ id: `step-${index + 1}` })
      : stage({
          id: `step-${index + 1}-1-search_tagged_assets`,
          name: 'Searched the tagged assets',
          kind: 'tool',
          duration: 12345,
        }),
  );
}

/** The counts a run can actually have, plus the ones either side of each wrap. */
const COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 17, 18, 19, 20, 27, 28, 36, 40, 64];

/** Whether a rectangle is wholly inside the panel. */
function inside(box: LabelBox, width: number, height: number): boolean {
  return box.x0 >= 0 && box.x1 <= width && box.y0 >= 0 && box.y1 <= height;
}

/** A label's own rectangle, named so a failure says which label it was. */
function describeBox(box: LabelBox): string {
  return `x ${box.x0.toFixed(1)}..${box.x1.toFixed(1)} y ${box.y0.toFixed(1)}..${box.y1.toFixed(1)}`;
}

describe('the agent map, as a box nothing can leave (#18b)', () => {
  it('keeps every star inside the panel at every step count', () => {
    for (const count of COUNTS) {
      const map = buildMapConstellation(runOf(count));
      for (const star of map.stars) {
        const box = starBox(star);
        expect(inside(box, map.width, map.height), `${count} steps, star ${star.step} at ${describeBox(box)}`).toBe(true);
      }
    }
  });

  it('keeps the ring around the selected star inside the panel too', () => {
    // The ring is drawn on one star and is nearly twice the glyph's reach, so a
    // star that fits can still be ringed off the edge of the band. It is checked
    // on every star rather than on one because any of them can be selected.
    for (const count of COUNTS) {
      const map = buildMapConstellation(runOf(count));
      for (const star of map.stars) {
        const box = starBox(star, SELECTED_RING);
        expect(inside(box, map.width, map.height), `${count} steps, ring on star ${star.step}`).toBe(true);
      }
    }
  });

  it('keeps every label inside the panel at every step count', () => {
    for (const count of COUNTS) {
      const map = buildMapConstellation(runOf(count));
      for (const label of map.labels) {
        expect(
          inside(label.box, map.width, map.height),
          `${count} steps, label ${label.step} "${label.name}" at ${describeBox(label.box)}`,
        ).toBe(true);
      }
    }
  });

  it('shortens a label that would cross the panel edge, even with nothing beside it', () => {
    /*
     * THE CASE THE COLLISION LOOP CANNOT SEE, and the one this module got wrong.
     * A two-step run has one neighbour per label and acres of room between them,
     * so nothing collides -- and its first label is still centred seventy units
     * from the left edge. A long enough name walked off the side of the panel on
     * the SPARSEST runs rather than the densest.
     *
     * The name below is not a real tool. It is the shape of the defect: the real
     * names cleared the edge by thirteen units, which is a margin the next tool
     * anybody adds could spend without anyone here hearing about it.
     */
    const long = 'search_across_the_semantic_layer_and_the_dictionary';
    const map = buildMapConstellation([
      stage({ id: `step-1-1-${long}`, kind: 'tool', name: 'Searched everything' }),
      stage({ id: 'step-2' }),
    ]);
    expect(map.labels[0].name.length).toBeLessThan(long.length);
    expect(map.labels[0].name.endsWith('\u2026')).toBe(true);
    expect(inside(map.labels[0].box, map.width, map.height)).toBe(true);
  });

  it('gives a label at the centre of the panel more room than one at its edge', () => {
    // The budget is a function of the room at that x, which is the distance to the
    // NEARER edge. Stated as a test because it is the property that makes the
    // clamp about the box rather than about a number somebody picked.
    expect(labelBudget(MAP_WIDTH / 2, MAP_WIDTH, false)).toBeGreaterThan(labelBudget(MAP_PAD_X, MAP_WIDTH, false));
    expect(labelBudget(MAP_PAD_X, MAP_WIDTH, false)).toBe(labelBudget(MAP_WIDTH - MAP_PAD_X, MAP_WIDTH, false));
  });

  it('never has to shorten the meta line, at the tightest seating and the longest run', () => {
    /*
     * The name is clamped and the meta line is not, and this is why: it is a step
     * number, the separator and a duration. The widest it gets is a three-digit
     * step and a duration in the hundreds of seconds, and at the narrowest x any
     * star sits at, that still fits with room. If this ever fails, the meta line
     * needs a budget of its own -- do not widen the panel to make it pass.
     */
    const widest = starMeta(999, 987_650);
    expect(labelWidth(widest, true) / 2).toBeLessThan(MAP_PAD_X);
  });

  it('overlaps no label with another label', () => {
    for (const count of COUNTS) {
      const map = buildMapConstellation(runOf(count));
      for (let a = 0; a < map.labels.length; a += 1) {
        for (let b = a + 1; b < map.labels.length; b += 1) {
          expect(
            boxesOverlap(map.labels[a].box, map.labels[b].box),
            `${count} steps, label ${map.labels[a].step} over label ${map.labels[b].step}`,
          ).toBe(false);
        }
      }
    }
  });

  it('overlaps no label with any star', () => {
    for (const count of COUNTS) {
      const map = buildMapConstellation(runOf(count));
      for (const label of map.labels) {
        for (const star of map.stars) {
          expect(
            boxesOverlap(label.box, starBox(star)),
            `${count} steps, label ${label.step} over star ${star.step}`,
          ).toBe(false);
        }
      }
    }
  });
});

describe('the agent map wraps rather than running off the page (#18b)', () => {
  it('never puts two stars closer together than a label needs', () => {
    // The pitch is the number that decides whether the map wraps. Below the
    // minimum a row stops being a constellation and becomes a dotted line, and
    // the labels have nowhere to go.
    for (const count of COUNTS) {
      const map = buildMapConstellation(runOf(count));
      const perRow = map.stars.filter((star) => star.row === 0);
      for (let index = 1; index < perRow.length; index += 1) {
        expect(perRow[index].x - perRow[index - 1].x, `${count} steps`).toBeGreaterThanOrEqual(MIN_STAR_GAP);
      }
    }
  });

  it('adds rows as a run gets longer instead of widening', () => {
    // The width is fixed and the height is not, which is the whole shape of the
    // answer to the overflow: there is no dimension here that can grow sideways.
    let rows = 0;
    for (const count of COUNTS) {
      const map = buildMapConstellation(runOf(count));
      expect(map.width).toBe(MAP_WIDTH);
      expect(map.rows).toBeGreaterThanOrEqual(rows);
      rows = map.rows;
    }
    expect(buildMapConstellation(runOf(40)).rows).toBeGreaterThan(buildMapConstellation(runOf(8)).rows);
  });

  it('balances the rows rather than filling them, so no row holds a single star', () => {
    /*
     * A nineteen-step run draws three rows of seven and not two full rows above a
     * row of one. A row of one is a star with no chain in it, which reads as a
     * step that happened somewhere else.
     */
    for (let count = 2; count <= 64; count += 1) {
      const { rows, perRow } = mapRows(count);
      const last = count - perRow * (rows - 1);
      expect(last, `${count} steps left ${last} on the last row`).toBeGreaterThan(rows > 1 ? 1 : 0);
    }
  });

  it('uses one pitch on every row, so the rows line up under each other', () => {
    // The flex-wrap version of the card grid shared out leftover width per row,
    // which put the cards of a short last row in places that lined up under
    // nothing. The pitch here comes from the widest row and is used on all of them.
    const map = buildMapConstellation(runOf(19));
    expect(map.rows).toBeGreaterThan(1);
    const columns = new Map<number, number>();
    for (const star of map.stars) {
      const column = star.step - 1 - star.row * map.perRow;
      const seen = columns.get(column);
      if (seen === undefined) columns.set(column, star.x);
      else expect(star.x, `column ${column}`).toBeCloseTo(seen, 6);
    }
  });

  it('draws no connector across a row boundary', () => {
    // A line from the end of one row to the start of the next crosses every star
    // between them. The step numbers on the labels already carry the order.
    for (const count of COUNTS) {
      const map = buildMapConstellation(runOf(count));
      const rowOf = new Map(map.stars.map((star) => [star.step, star.row]));
      for (const link of map.links) {
        expect(rowOf.get(link.from), `${count} steps, hop ${link.from}->${link.to}`).toBe(rowOf.get(link.to));
      }
    }
  });

  it('grows the panel taller for a longer run, and by the rows it added', () => {
    expect(mapHeight(19)).toBeGreaterThan(mapHeight(9));
    // Nine steps is the last one-row run, so the height is flat across a row and
    // steps exactly once at the wrap: a band and a row gap, not a guess.
    expect(mapHeight(8)).toBe(mapHeight(9));
    expect(mapHeight(10) - mapHeight(9)).toBe(MAP_STAR_BAND + 2 * LABEL_REACH + MAP_ROW_GAP);
  });
});

describe('what a star is called on the map (#18b)', () => {
  it('labels a tool call with its own identifier, in the mono face', () => {
    const map = buildMapConstellation(run);
    const search = map.labels[1];
    expect(search.name).toBe('search_semantics');
    expect(search.mono).toBe(true);
  });

  it('labels a decision with the agent’s own words, shortened, in the sans face', () => {
    // "Chose the next step" rather than a rewrite: the name is the agent's and
    // this is a band nine and a half units tall.
    const map = buildMapConstellation(run);
    expect(map.labels[0].name).toBe('Chose next step');
    expect(map.labels[0].mono).toBe(false);
  });

  it('never breaks a tool name mid-word', () => {
    /*
     * The regression this preserves: `search_semantics` split across two lines
     * inside a card, because the shared `overflow-wrap: anywhere` reached it. On
     * the band the name is one SVG text node, so the only way it can be cut is
     * this module cutting it -- and when it does, it cuts at the END and marks the
     * cut with one ellipsis glyph. A name is never split into two pieces both of
     * which render.
     */
    for (const count of COUNTS) {
      for (const label of buildMapConstellation(runOf(count)).labels) {
        expect(label.name).not.toContain('\n');
        expect(label.name.match(/\u2026/g)?.length ?? 0).toBeLessThanOrEqual(1);
        if (label.name.includes('\u2026')) expect(label.name.endsWith('\u2026')).toBe(true);
      }
    }
  });

  it('elides with one glyph and never below the floor', () => {
    expect(elide('search_semantics', 8)).toBe('search_\u2026');
    expect(elide('short', 40)).toBe('short');
    for (const count of COUNTS) {
      for (const label of buildMapConstellation(runOf(count)).labels) {
        expect(label.name.length, `label ${label.step}`).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('writes the separator as " · " and no em dash anywhere', () => {
    for (const label of buildMapConstellation(run).labels) {
      expect(label.meta).toContain(' \u00b7 ');
      expect(label.meta).not.toContain('\u2014');
      expect(label.name).not.toContain('\u2014');
    }
  });

  it('numbers the steps in run order, two digits, and never renumbers them', () => {
    const map = buildMapConstellation(run);
    expect(map.labels.map((label) => label.meta.slice(0, 2))).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
    expect(map.stars.map((star) => star.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('reads a duration under a second in ms and a longer one in seconds', () => {
    expect(starMeta(2, 604)).toBe('02 · 604ms');
    expect(starMeta(4, 13400)).toBe('04 · 13.40s');
  });

  it('takes the tool’s identifier from the step id rather than from its prose name', () => {
    // The prose name is the agent's sentence about the call; the identifier is the
    // call. A star drawn with a product's mark is labelled with the thing that ran.
    expect(starLabel({ id: 'step-1-1-data_genie', kind: 'tool', name: 'Queried governed data' })).toEqual({
      text: 'data_genie',
      mono: true,
    });
    // A tool with no identifier in its id keeps its prose name and the sans face.
    expect(starLabel({ id: 'plot', kind: 'tool', name: 'Drew the chart' })).toEqual({
      text: 'Drew chart',
      mono: false,
    });
  });
});

describe('labels sit opposite the line flow (#18b)', () => {
  it('drops the label below a star both of whose neighbours are above it', () => {
    // Both lines rise out of the star, so the space beneath it is the empty one.
    expect(labelSide(100, [40, 60], 100)).toBe('below');
  });

  it('lifts the label above a star both of whose neighbours are below it', () => {
    expect(labelSide(40, [100, 120], 100)).toBe('above');
  });

  it('breaks a tie towards whichever side has more panel left in it', () => {
    // A star on a monotone run carries a line on both sides, so there is no empty
    // side to find; the tie goes to the roomier one rather than to a fixed side.
    expect(labelSide(40, [20, 60], 100)).toBe('below');
    expect(labelSide(160, [140, 180], 100)).toBe('above');
  });

  it('places the two lines outward from the star, name nearest', () => {
    const map = buildMapConstellation(run);
    for (const label of map.labels) {
      const star = map.stars.find((one) => one.step === label.step);
      expect(star).toBeDefined();
      if (star === undefined) continue;
      const nameGap = Math.abs(label.nameY - star.y);
      const metaGap = Math.abs(label.metaY - star.y);
      expect(metaGap, `label ${label.step}`).toBeGreaterThan(nameGap);
      if (label.side === 'below') expect(label.nameY).toBeGreaterThan(star.y);
      else expect(label.nameY).toBeLessThan(star.y);
    }
  });
});

describe('the live agent path, as a box nothing can leave (#18a)', () => {
  it('keeps every star and its ring inside the panel at every step count', () => {
    for (const count of COUNTS) {
      const path = buildPathConstellation(runOf(count), 0);
      for (const star of path.stars) {
        expect(inside(starBox(star), path.width, path.height), `${count} steps, star ${star.step}`).toBe(true);
        expect(inside(starBox(star, SELECTED_RING), path.width, path.height), `${count} steps, ring ${star.step}`).toBe(
          true,
        );
      }
    }
  });

  it('keeps every step number inside the panel, running outward from its star', () => {
    // The number sits on the side of its star away from the centre, so it runs
    // into the margin rather than back across the chain -- which is also the only
    // reason it fits.
    for (const count of COUNTS) {
      const path = buildPathConstellation(runOf(count), 0);
      for (const number of path.numbers) {
        const star = path.stars.find((one) => one.step === number.step);
        expect(star).toBeDefined();
        if (star === undefined) continue;
        const width = labelWidth(number.label, true);
        const box: LabelBox =
          number.anchor === 'end'
            ? { x0: number.x - width, x1: number.x, y0: number.y - 7, y1: number.y + 2.5 }
            : { x0: number.x, x1: number.x + width, y0: number.y - 7, y1: number.y + 2.5 };
        expect(inside(box, path.width, path.height), `${count} steps, number ${number.label}`).toBe(true);
        expect(boxesOverlap(box, starBox(star)), `number ${number.label} over its own star`).toBe(false);
      }
    }
  });

  it('scatters the stars inside the band and never outside it', () => {
    for (const count of COUNTS) {
      for (const star of buildPathConstellation(runOf(count)).stars) {
        expect(star.x).toBeGreaterThanOrEqual(PATH_BAND_LEFT);
        expect(star.x).toBeLessThanOrEqual(PATH_BAND_RIGHT);
      }
    }
  });

  it('tightens the pitch on a long run instead of growing without limit', () => {
    expect(pathPitch(1)).toBe(PATH_MAX_PITCH);
    expect(pathPitch(8)).toBeLessThanOrEqual(PATH_MAX_PITCH);
    expect(pathPitch(64)).toBe(PATH_MIN_PITCH);
    for (const count of COUNTS) {
      expect(pathPitch(count), `${count} steps`).toBeGreaterThanOrEqual(PATH_MIN_PITCH);
      expect(pathPitch(count), `${count} steps`).toBeLessThanOrEqual(PATH_MAX_PITCH);
    }
  });

  it('draws a star for every step and drops none of them', () => {
    /*
     * The rail this replaced subsampled to four evenly spread stages, so a
     * twenty-one step run silently showed four of them. The panel grows instead.
     */
    for (const count of COUNTS) {
      const path = buildPathConstellation(runOf(count));
      expect(path.stars, `${count} steps`).toHaveLength(count);
      expect(path.links, `${count} steps`).toHaveLength(Math.max(0, count - 1));
    }
    expect(pathHeight(21)).toBeGreaterThan(pathHeight(7));
    expect(PATH_WIDTH).toBe(320);
  });

  it('is one panel wide whatever the run did, so there is no sideways to overflow in', () => {
    for (const count of COUNTS) {
      expect(buildPathConstellation(runOf(count)).width).toBe(PATH_WIDTH);
    }
  });
});

describe('a path that is still being built (#18a)', () => {
  /*
   * THE SHAKE, AS ARITHMETIC.
   *
   * The live band is redrawn on every announced step of a run that is happening,
   * and it used to place its stars at `PATH_PAD_TOP + index * (PATH_BODY / (count
   * - 1))` -- one pitch for the whole path, derived from how many steps had been
   * reported so far. So each new step moved every star already on screen: step 07
   * sat at y=362 while the run had eight steps, 326 at nine, 290 at ten. The
   * panel's foot moved too, and the rounding made it move BOTH WAYS -- 472 units
   * at eight steps, 478 at nine, 472 again at ten -- so the band grew, shrank and
   * grew while the reader watched the chain arrive.
   *
   * These are the invariants that make that impossible rather than unlikely.
   */
  it('leaves every placed star exactly where it was when the next step arrives', () => {
    for (let count = 1; count < 40; count += 1) {
      const before = buildPathConstellation(runOf(count), count - 1);
      const after = buildPathConstellation(runOf(count + 1), count);
      for (const star of before.stars) {
        const grown = after.stars.find((one) => one.step === star.step);
        expect(grown, `step ${star.step} of ${count}`).toBeDefined();
        expect(grown?.x, `step ${star.step} x at ${count} steps`).toBe(star.x);
        expect(grown?.y, `step ${star.step} y at ${count} steps`).toBe(star.y);
      }
    }
  });

  it('leaves the path string of every drawn hop untouched when the next step arrives', () => {
    // The connectors are the thing a reader is watching arrive, so a hop whose
    // `d` is rewritten is a line that jumps rather than one that extends.
    for (let count = 2; count < 40; count += 1) {
      const before = buildPathConstellation(runOf(count), count - 1);
      const after = buildPathConstellation(runOf(count + 1), count);
      for (const link of before.links) {
        const grown = after.links.find((one) => one.from === link.from && one.to === link.to);
        expect(grown?.d, `hop ${link.from}-${link.to} at ${count} steps`).toBe(link.d);
      }
    }
  });

  it('only ever adds to the foot of the panel, never takes off it', () => {
    for (let count = 1; count < 64; count += 1) {
      expect(pathHeight(count + 1), `${count} steps to ${count + 1}`).toBeGreaterThanOrEqual(pathHeight(count));
    }
  });

  it('places a star by its index alone, with no reading of how long the run is', () => {
    // `pathStarY` is the claim and the builder is the thing on screen. Two
    // agreeing functions is the point: a position that is stable in one and
    // recomputed in the other is the same defect wearing a different hat.
    for (const count of COUNTS) {
      const path = buildPathConstellation(runOf(count));
      path.stars.forEach((star, index) => {
        expect(star.y, `${count} steps, star ${star.step}`).toBe(pathStarY(index));
      });
    }
  });

  it('still tightens as the run goes on, forwards rather than retrospectively', () => {
    // The compression the old arithmetic existed for. It is spent on hops that
    // have not been drawn yet, which is what makes it free of the shake.
    expect(pathPitch(7)).toBe(PATH_MAX_PITCH);
    expect(pathPitch(8)).toBeLessThan(PATH_MAX_PITCH);
    expect(pathPitch(20)).toBe(PATH_MIN_PITCH);
    for (let step = 2; step < 64; step += 1) {
      expect(pathPitch(step + 1), `hop into ${step + 1}`).toBeLessThanOrEqual(pathPitch(step));
    }
  });

  it('draws the reference run of seven at the panel it was drawn in', () => {
    // #18a is a seven-step drawing. Whatever the tail does, that one is unchanged.
    expect(pathHeight(7)).toBe(430);
    for (const star of buildPathConstellation(runOf(7)).stars) {
      expect(star.y).toBe(38 + (star.step - 1) * PATH_MAX_PITCH);
    }
  });
});

describe('the line into the step in progress (#18a)', () => {
  it('animates exactly one hop, and it is the one arriving at the current step', () => {
    const path = buildPathConstellation(run, 5);
    const live = path.links.filter((link) => link.live);
    expect(live).toHaveLength(1);
    expect(live[0].to).toBe(6);
    expect(live[0].from).toBe(5);
  });

  it('animates nothing when no step is in progress', () => {
    // A line drawing into the last step of a finished run is the panel saying the
    // run is still going.
    expect(buildPathConstellation(run, -1).links.some((link) => link.live)).toBe(false);
  });

  it('animates nothing when the current step is the first one', () => {
    // There is no hop into step one, so there is nothing to draw. The star still
    // gets its ring; that is the component's business, not this module's.
    expect(buildPathConstellation(run, 0).links.some((link) => link.live)).toBe(false);
  });

  it('gives every hop a path string joining the two stars it names', () => {
    for (const link of buildPathConstellation(run, 3).links) {
      expect(link.d).toBe(`M${round(link.x1)} ${round(link.y1)} ${round(link.x2)} ${round(link.y2)}`);
    }
  });

  it('rounds coordinates rather than writing out a recurring decimal', () => {
    // The positions are divisions of a box width, so most of them recur. A tenth
    // of a viewBox unit is a fortieth of a pixel at the width this renders at.
    for (const link of buildMapConstellation(runOf(9)).links) {
      for (const figure of link.d.replace('M', '').split(/[\s]+/)) {
        expect(figure).toMatch(/^\d+(\.\d)?$/);
      }
    }
  });
});

describe('a run with almost nothing in it', () => {
  it('draws one star, centred, with no chain and no label collision', () => {
    const map = buildMapConstellation([stage({ id: 'step-1' })]);
    expect(map.stars).toHaveLength(1);
    expect(map.links).toHaveLength(0);
    expect(map.stars[0].x).toBe(MAP_WIDTH / 2);
    expect(inside(map.labels[0].box, map.width, map.height)).toBe(true);
  });

  it('draws the vertical path for a single step without a hop', () => {
    const path = buildPathConstellation([stage({ id: 'step-1' })], 0);
    expect(path.stars).toHaveLength(1);
    expect(path.links).toHaveLength(0);
    expect(inside(starBox(path.stars[0], SELECTED_RING), path.width, path.height)).toBe(true);
  });

  it('draws nothing at all for a run with no steps', () => {
    // Not a placeholder star. A plausible star beside no real ones is a drawing of
    // a run that did not happen.
    expect(buildMapConstellation([]).stars).toHaveLength(0);
    expect(buildPathConstellation([]).stars).toHaveLength(0);
  });
});

describe('the pieces the layout is built from', () => {
  it('measures a mono string by its fixed advance and a sans one by an upper bound', () => {
    // DM Mono gives every glyph an advance of 600 per 1000-unit em, so a mono
    // string's width is arithmetic. DM Sans is proportional and its number is a
    // bound, which is why it is the smaller of the two per character.
    expect(labelWidth('0000000000', true)).toBeCloseTo(57, 6);
    expect(labelWidth('aaaaaaaaaa', false)).toBeLessThan(labelWidth('0000000000', true));
  });

  it('finds an overlap only where two rectangles actually share area', () => {
    const a: LabelBox = { x0: 0, x1: 10, y0: 0, y1: 10 };
    expect(boxesOverlap(a, { x0: 5, x1: 15, y0: 5, y1: 15 })).toBe(true);
    // Touching is not overlapping: two labels whose boxes meet at an edge are two
    // labels with nothing between them, which is the tightest legal placement.
    expect(boxesOverlap(a, { x0: 10, x1: 20, y0: 0, y1: 10 })).toBe(false);
    expect(boxesOverlap(a, { x0: 20, x1: 30, y0: 20, y1: 30 })).toBe(false);
  });

  it('reserves the same reach for a star’s glyph whichever glyph it is', () => {
    // A sparkle is fourteen units across and a product mark is sixteen, so one
    // number covers both and the labels do not move when a step's kind changes.
    expect(STAR_REACH).toBe(8);
    expect(SELECTED_RING).toBeGreaterThan(STAR_REACH);
  });

  it('settles the labels rather than looping on a run it cannot shorten', () => {
    /*
     * The elision loop shortens one label per pass and stops at the floor, so a
     * pair that are both at the floor cannot be handed back to it. This is the
     * test that says so out loud: a long run of identical long names is the input
     * that would hang it, and it returns.
     */
    const identical = Array.from({ length: 40 }, (_, index) =>
      stage({
        id: `step-${index + 1}-1-search_tagged_assets`,
        kind: 'tool',
        name: 'Searched the tagged assets',
      }),
    );
    const map = buildMapConstellation(identical);
    expect(map.labels).toHaveLength(40);
    for (const label of map.labels) expect(label.name.length).toBeGreaterThanOrEqual(6);
  });
});

/** The module's own rounding, restated so the path-string test can check it. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

describe('a label’s box is the box the band actually draws in', () => {
  it('sizes the box to the wider of the two lines, not to the name alone', () => {
    /*
     * This is what every "nothing leaves the panel" assertion above is standing
     * on. If the box were measured from the name only, a short name over a long
     * meta line -- "Drew chart" above "07 · 123.45s" -- would report a box
     * narrower than the text inside it, and every overflow check in this file
     * would pass while the figures ran off the edge.
     */
    const map = buildMapConstellation(run);
    for (const label of map.labels) {
      const width = label.box.x1 - label.box.x0;
      expect(width, `label ${label.step}`).toBeCloseTo(
        Math.max(labelWidth(label.name, label.mono), labelWidth(label.meta, true)),
        6,
      );
      expect(width, `label ${label.step}`).toBeGreaterThanOrEqual(labelWidth(label.meta, true));
    }
  });

  it('centres the box on its star', () => {
    const map = buildMapConstellation(run);
    for (const label of map.labels) {
      const star = map.stars.find((one) => one.step === label.step);
      expect(star).toBeDefined();
      if (star === undefined) continue;
      expect((label.box.x0 + label.box.x1) / 2, `label ${label.step}`).toBeCloseTo(star.x, 6);
    }
  });

  it('covers both lines of text vertically, with room for the descender', () => {
    for (const label of buildMapConstellation(run).labels) {
      expect(label.box.y0).toBeLessThan(Math.min(label.nameY, label.metaY));
      expect(label.box.y1).toBeGreaterThan(Math.max(label.nameY, label.metaY));
    }
  });
});
