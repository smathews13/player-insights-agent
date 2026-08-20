import { readFileSync, readdirSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentMapConstellation, AgentPathConstellation } from './AgentConstellation';
import { partial } from './styles/stylesheet';
import { BRAND_PRODUCT_NAMES } from './brand-icons';
import type { TraceStage } from './answer-shape';

/**
 * What the two constellation bands are to a reader who is not looking at them.
 *
 * The geometry is checked next door, in `agent-constellation.test.ts`, and that
 * file is about a box nothing can leave. This one is about the other half of §5:
 * the finished map is `aria-hidden`, the live path exposes its step selectors,
 * there is ONE `aria-live="polite"` status string, and
 * `prefers-reduced-motion: reduce` freezes all animation.
 *
 * The reason those are tests rather than review notes is that they are invisible
 * on the surface they govern. A band that is animating for a reader who asked the
 * operating system for no animation looks completely correct to everybody else,
 * and so does a selector that has quietly disappeared from the tab order.
 *
 * A rule in a stylesheet cannot see whether its element carries `aria-hidden`, so
 * the split is: astrolabe-animation.css owns the guard and is tested for it there,
 * and the claims that are about the MARKUP are here.
 */

const PATH_SOURCE = readFileSync(new URL('./AgentConstellation.tsx', import.meta.url), 'utf8');
const CONSTELLATION_CSS = partial('constellation.css');
const ANIMATION_CSS = partial('astrolabe-animation.css');

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

/** A finished run of six steps, two products in it. */
const finished: TraceStage[] = [
  stage({ id: 'step-1' }),
  stage({ id: 'step-1-1-search_semantics', name: 'Searched the semantic layer', kind: 'tool', duration: 604 }),
  stage({ id: 'step-2' }),
  stage({ id: 'step-2-1-dictionary_genie', name: 'Checked a field definition', kind: 'tool', duration: 13400 }),
  stage({ id: 'step-3' }),
  stage({ id: 'step-3-1-data_genie', name: 'Queried governed data', kind: 'tool', duration: 11390 }),
];

/** The same run with its last step still going. */
const inFlight: TraceStage[] = [
  ...finished.slice(0, 5),
  stage({ id: 'step-3-1-data_genie', name: 'Queried governed data', kind: 'tool', status: 'running', duration: 0 }),
];

const path = (stages: TraceStage[], activeIndex: number, elapsedMs: number | null = null) =>
  renderToStaticMarkup(<AgentPathConstellation stages={stages} activeIndex={activeIndex} elapsedMs={elapsedMs} />);

const map = (stages: TraceStage[], selectedId: string | null = null) =>
  renderToStaticMarkup(<AgentMapConstellation stages={stages} selectedId={selectedId} />);

/** Every attribute value for one attribute, so a count can be asserted. */
function attrs(markup: string, name: string): string[] {
  return [...markup.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((found) => found[1]);
}

describe('the bands expose only the controls they own (§5)', () => {
  it('hides the finished map, whose cards own selection', () => {
    const markup = map(finished, 'step-2');
    expect(markup).toContain('<svg aria-hidden="true"');
    expect(attrs(markup, 'focusable')).toContain('false');
  });

  it('names the live path and makes every step keyboard operable', () => {
    const markup = path(inFlight, 5, 12_000);
    expect(markup).toContain('<svg role="group" aria-label="Agent steps"');
    expect(markup).not.toContain('<svg aria-hidden="true"');
    expect(attrs(markup, 'role').filter((role) => role === 'button')).toHaveLength(inFlight.length);
    expect(attrs(markup, 'tabindex').filter((value) => value === '0')).toHaveLength(inFlight.length);
    expect(attrs(markup, 'aria-label').filter((label) => label.startsWith('Select step '))).toHaveLength(
      inFlight.length
    );
  });

  it('carries exactly one live region, on the band that has something to report', () => {
    /*
     * The live path has one, because a run in flight changes and a reader who
     * cannot see the drawing still needs to know which step it is inside. The
     * finished map has NONE: nothing on it is changing, and a live region on a
     * settled drawing is a screen reader announcing a picture.
     */
    expect(attrs(path(inFlight, 5, 12_000), 'aria-live')).toEqual(['polite']);
    expect(attrs(map(finished, 'step-2'), 'aria-live')).toEqual([]);
  });

  it('puts no duplicate control inside the finished map', () => {
    /*
     * The regression this forecloses. The cards under the map are the thing a
     * reader operates -- real buttons, each opening a step panel -- so a second
     * set of click targets inside an `aria-hidden` drawing would be focusable
     * content a screen reader cannot see.
     */
    const markup = map(finished, 'step-2');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('tabindex');
    expect(markup).not.toContain('<a ');
    expect(markup).not.toContain('onclick');
    expect(markup).not.toContain('role="button"');
  });

  it('names the step in words rather than describing the animation in front of it', () => {
    const markup = path(inFlight, 5, 12_000);
    expect(markup).toContain('Step 06 · Queried governed data');
    // Not "connecting", not "drawing", not "loading". The sentence is about the run.
    expect(markup.toLowerCase()).not.toContain('animat');
    expect(markup.toLowerCase()).not.toContain('sparkle');
    expect(markup.toLowerCase()).not.toContain('constellation');
  });

  it('prints the whole name, over as many lines as it takes', () => {
    /*
     * The reported defect: "Step 05 · Checking field d…". The line was one line
     * with an ellipsis, on the argument that a wrap moves the band's own foot -- and
     * it does, which is affordable, because the band is a row in a column that
     * grows. What is not affordable is cutting the only sentence on this surface
     * that says what the agent is doing, at a width that has nothing to do with the
     * length of the agent's own step names.
     */
    const line = CONSTELLATION_CSS.slice(CONSTELLATION_CSS.indexOf('.ast-sky-status-text {'));
    const body = line.slice(0, line.indexOf('}'));
    expect(body).not.toMatch(/white-space:\s*nowrap/);
    expect(body).not.toMatch(/text-overflow/);
    expect(body).not.toMatch(/overflow:\s*hidden/);
    // The mark and the elapsed sit against the first line rather than halfway down
    // a wrapped sentence, which is what the row's own alignment decides.
    expect(CONSTELLATION_CSS).toMatch(/\.ast-sky-status \{[^}]*align-items: flex-start/);
  });
});

describe('what moves, and what stops moving (§5)', () => {
  it('animates only through classes the reduced-motion guard already covers', () => {
    /*
     * The guard is an attribute selector on `ast-anim-`, so it covers a class the
     * day it is written rather than the day somebody remembers to add it to a
     * list. That only holds if the animation arrives as one of those classes and
     * never as an inline `animation` style, which is what this checks.
     */
    const markup = path(inFlight, 5, 12_000);
    expect(markup).toContain('ast-anim-draw');
    expect(markup).toMatch(/ast-anim-(star|center)-pulse/);
    expect(markup).not.toMatch(/style="[^"]*animation/);
    expect(ANIMATION_CSS).toMatch(/\[class\*='ast-anim-'\] \{\n\s*animation: none !important;/);
  });

  it('freezes the drawn line as drawn rather than as invisible', () => {
    // `ast-draw` starts fully dashed out, so `animation: none` on its own would
    // leave the live connector missing instead of still.
    const guard = ANIMATION_CSS.slice(ANIMATION_CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(guard).toContain('.ast-anim-draw');
    expect(guard).toMatch(/stroke-dashoffset: 0/);
  });

  it('moves nothing at all once the run has stopped', () => {
    /*
     * A line animating into the last step of a finished run is the panel saying
     * the run is still going. The frontier keeps its ring, because the newest step
     * is worth marking and marking it is not the same as claiming it is happening.
     */
    const markup = path(finished, 5, null);
    expect(markup).not.toContain('ast-anim-');
    expect(markup).toContain('ast-star-ring');
  });

  it('draws the live connector with a normalised dash so one keyframe fits any length', () => {
    const markup = path(inFlight, 5, 12_000);
    expect(markup).toMatch(/pathLength="1"|pathlength="1"/);
    expect(markup).toContain('stroke-dasharray="1"');
    // One live hop, whatever else is on the band.
    expect(markup.match(/ast-link-live/g)).toHaveLength(1);
  });

  it('runs the draw on the design’s own 2.2s loop', () => {
    expect(CONSTELLATION_CSS).toMatch(/\.ast-anim-draw \{\s*animation: ast-draw 2\.2s linear infinite;/);
  });
});

describe('the elapsed figure is a measurement (§5, §3)', () => {
  it('prints real seconds in the mono face, and never a percentage', () => {
    /*
     * The figure is read out of its own span rather than out of the whole band:
     * the product stars are percent-encoded data URLs, so the markup is full of
     * `%` that has nothing to do with a progress figure. Matching the span is what
     * makes this claim about the number a reader sees.
     */
    const markup = path(inFlight, 5, 12_400);
    const elapsed = /<span class="ast-num ast-sky-status-elapsed">([^<]*)<\/span>/.exec(markup);
    expect(elapsed).not.toBeNull();
    expect(elapsed?.[1]).toBe('12s');
    expect(elapsed?.[1]).not.toContain('%');
  });

  it('prints no elapsed at all on a finished run', () => {
    // The browser's own count printed beside a step that finished and reported its
    // own duration is a moving number on a settled measurement.
    expect(path(finished, 5, 99_000)).not.toContain('99s');
  });

  it('prints no elapsed when the caller has no clock to offer', () => {
    expect(path(inFlight, 5, null)).not.toMatch(/ast-sky-status-elapsed/);
  });

  it('says the run is over rather than leaving a step described as happening', () => {
    expect(path([], -1, null)).toBe('');
    expect(path(finished, -1, null)).toContain('Every step recorded');
  });
});

describe('the status line of a run that has stopped', () => {
  /*
   * THE BAND OUTLIVES THE RUN NOW, which is what puts these four states on one
   * line rather than three of them off screen. It used to be drawn only while a
   * step was in progress, so the only settled reading it ever had to make was the
   * happy one -- and "Every step recorded" over a run that died is a reassurance
   * the list underneath it contradicts.
   *
   * `activeIndex` is -1 in every case below, because that is the caller saying no
   * step is in progress. What the line then reports is read off the stages.
   */
  const status = (stages: TraceStage[]) =>
    /<span class="ast-sky-status-text">([^<]*)<\/span>/.exec(path(stages, -1, null))?.[1] ?? '';

  const endingIn = (status_: TraceStage['status']) => [
    ...finished.slice(0, 5),
    stage({ id: 'step-3-1-data_genie', name: 'Queried governed data', kind: 'tool', status: status_ }),
  ];

  it('names a step the agent reported as failed, in the agent’s own word', () => {
    expect(status(endingIn('failed'))).toBe('Step 06 · Queried governed data · failed');
  });

  it('keeps partial apart from failed rather than calling both a failure', () => {
    // A step that returned some of what it was asked for is not a step that
    // errored, the tile below it prints the two words differently, and a band that
    // collapsed them would be the summary disagreeing with the record.
    expect(status(endingIn('partial'))).toBe('Step 06 · Queried governed data · partial');
  });

  it('says a step was never reported rather than that it is running', () => {
    // The one ending whose word is ours: the agent announces a step when it starts,
    // so a run killed mid-step leaves a `running` row that nothing will ever
    // complete. Drawn from `inFlight`, which is that row exactly -- the same stages
    // that read as a live run while the caller says one is in flight.
    expect(status(inFlight)).toBe('Step 06 · Queried governed data · never reported');
    // And nothing animates or counts on it, which is the fault this state is most
    // able to produce: a dead run pulsing at the reader.
    const settled = path(inFlight, -1, null);
    expect(settled).not.toContain('ast-anim');
    expect(settled).not.toContain('ast-star-current');
    expect(settled).not.toMatch(/ast-sky-status-elapsed/);
  });

  it('reports the last shortfall rather than the first, on a run that went on past one', () => {
    // A partial step in the middle of a run that then failed at the end: the line
    // is for where the record STOPS, so the later of the two is the one it names.
    const both = [
      ...finished.slice(0, 3),
      stage({ id: 'step-2-1-dictionary_genie', name: 'Checked a field definition', kind: 'tool', status: 'partial' }),
      stage({ id: 'step-3' }),
      stage({ id: 'step-3-1-data_genie', name: 'Queried governed data', kind: 'tool', status: 'failed' }),
    ];
    expect(status(both)).toBe('Step 06 · Queried governed data · failed');
  });

  it('claims a clean run only when every step of it completed', () => {
    expect(status(finished)).toBe('Every step recorded');
  });
});

describe('the selected star, on the finished map (§5)', () => {
  it('rings and tints it, and weights its label too', () => {
    // Never colour alone: the ring is the shape, the tint is the fill, and the
    // label goes to full weight and full opacity so the selected step is legible
    // as well as marked.
    const markup = map(finished, 'step-2-1-dictionary_genie');
    expect(markup).toContain('ast-star-selected');
    expect(markup).toMatch(/class="ast-sky-name mono selected"/);
    expect(CONSTELLATION_CSS).toMatch(/\.ast-star-selected \{[^}]*color-mix/);
    expect(CONSTELLATION_CSS).toMatch(/\.ast-sky-name\.selected \{[^}]*font-weight: 600/);
  });

  it('rings nothing when nothing is selected', () => {
    expect(map(finished, null)).not.toContain('ast-star-selected');
  });

  it('rings nothing when the selected id is not a step of this run', () => {
    // The Explorer replaces the stage list under the component when a different
    // run is opened, so a stale id is a real state rather than a hypothetical.
    expect(map(finished, 'step-99')).not.toContain('ast-star-selected');
  });
});

describe('the stars are the products that ran (§4)', () => {
  it('names only the products this run actually called, and at most three', () => {
    // A legend naming a product no star on the band is drawn with is a legend
    // describing a different run.
    const markup = map(finished, null);
    expect(markup).toContain(BRAND_PRODUCT_NAMES.genie);
    expect(markup).toContain(BRAND_PRODUCT_NAMES['mosaic-ai']);
    expect(markup).not.toContain(BRAND_PRODUCT_NAMES.lakebase);
    expect(markup).not.toContain(BRAND_PRODUCT_NAMES.apps);
  });

  it('calls Mosaic AI “Agents”, which is what §4 says every UI string calls it', () => {
    expect(BRAND_PRODUCT_NAMES['mosaic-ai']).toBe('Agents');
    expect(map(finished, null)).not.toContain('Mosaic');
  });

  it('gives an unclassified tool a plain dot rather than a mark that fits', () => {
    /*
     * A reader who knows the Databricks marks reads a lookalike as one and is then
     * wrong about which product ran.
     */
    const markup = map([stage({ id: 'step-1-1-some_new_tool', kind: 'tool', name: 'Did something' })], null);
    expect(markup).toContain('ast-star-plain');
    expect(markup).not.toContain('<image');
  });

  it('draws the product stars from the recoloured cuts, never the full-colour ones', () => {
    // §9 retires the full-colour marks from the UI. A navy band is the placement
    // that forces the issue rather than taste: a full-colour mark on #11171C is
    // the one seating that is actually unreadable.
    const markup = map(finished, null);
    expect(markup).toContain('<image');
    expect(markup).not.toContain('assets/brand/');
    expect(markup).not.toContain('databricks-symbol-color');
  });
});

describe('no orange, and no oat (§2)', () => {
  it('writes no orange in the band’s markup or its stylesheet', () => {
    const forbidden = [/#FF3621/i, /#F9F7F4/i, /--db-orange/, /--db-warm/, /orange/i];
    for (const pattern of forbidden) {
      expect(CONSTELLATION_CSS, `constellation.css matched ${pattern}`).not.toMatch(pattern);
      expect(path(inFlight, 5, 12_000), `live path matched ${pattern}`).not.toMatch(pattern);
      expect(map(finished, 'step-2'), `map matched ${pattern}`).not.toMatch(pattern);
    }
  });

  it('reads only astrolabe tokens, so the DuBois set can be retired under it', () => {
    expect(CONSTELLATION_CSS).not.toMatch(/var\(--db-/);
    expect(CONSTELLATION_CSS).toMatch(/var\(--ast-navy\)/);
  });

  it('writes no em dash on either band', () => {
    for (const markup of [path(inFlight, 5, 12_000), map(finished, 'step-2')]) {
      expect(markup).not.toContain('\u2014');
    }
    expect(PATH_SOURCE.match(/\u2014/g) ?? []).toEqual([]);
  });
});

describe('the mark is the agent, and there is one of it (§1)', () => {
  it('draws the status mark from the shared file rather than from a second copy', () => {
    expect(PATH_SOURCE).toContain("import { AstrolabeMark } from './AstrolabeMark'");
    // 18 twice, on purpose: `size` picks the drawing as well as the box, and
    // `.ast-sky-status-mark svg` paints 18px. A seat that asks for one number
    // and is painted another gets the wrong cut of the mark stretched to the
    // right size -- nothing looks broken, the graduations are just missing or
    // crowded at a size they were not drawn for.
    expect(PATH_SOURCE).toContain('<AstrolabeMark size={18} ink="dark" />');
    expect(CONSTELLATION_CSS).toMatch(/\.ast-sky-status-mark svg \{[^}]*width: 18px/);
    // Optical: same first-line family as live-step / compact dag marks.
    expect(CONSTELLATION_CSS).toMatch(/\.ast-sky-status-mark \{[^}]*margin-top: 1px/);
    // `dark` because the status line is on the navy band. The light cut's
    // #2272B4 is 1.9:1 there and the accent dots read as a texture (§2).
  });

  it('leaves no robot anywhere on either band', () => {
    // §9 lists the orange robot among the things this design retires rather than
    // restyles, and the bands are new surfaces: the way it comes back is somebody
    // reaching for the existing agent glyph.
    expect(PATH_SOURCE).not.toContain('PiaRobotMark');
    for (const markup of [path(inFlight, 5, 12_000), map(finished, 'step-2')]) {
      expect(markup).not.toContain('pia-robot');
    }
  });

  it('keeps the mark’s geometry out of every file but its own', () => {
    /*
     * A second copy is correct the day it is pasted and drifts on the first
     * retune, silently, because two seatings of one mark are never on screen
     * together for anybody to compare.
     *
     * The tell used to be `r="26"`, which was this lane's own rim: it had drawn
     * a second AstrolabeMark in parallel with the one landing on main, and the
     * one file this check found was the duplicate it was supposed to forbid. It
     * now reads a quadrant dot out of SMALL_CUT, in the module that holds the
     * numbers, so a pasted drawing is caught wherever it is pasted from.
     */
    const here = new URL('.', import.meta.url);
    const holders = readdirSync(here)
      .filter((name) => /\.tsx?$/.test(name) && !name.includes('.test.'))
      .filter((name) => readFileSync(new URL(name, here), 'utf8').includes('cx: 41.5, cy: 22.5'));
    expect(holders).toEqual(['astrolabe-mark.ts']);
  });
});

describe('the band cannot be given a width to overflow (§5)', () => {
  it('scales to its container and clips rather than scrolling', () => {
    /*
     * The two cosmetic fixes that came back were `overflow-x: auto` and a flex
     * wrap. `clip` is the declaration that forecloses the first: a clip region
     * cannot be scrolled, so later steps cannot be parked off-screen behind a
     * scrollbar on a container nothing announced as scrollable.
     */
    expect(CONSTELLATION_CSS).toMatch(/\.ast-sky \{[^}]*overflow: clip/);
    expect(CONSTELLATION_CSS).toMatch(/\.ast-sky-canvas \{[^}]*width: 100%/);
    expect(CONSTELLATION_CSS).not.toMatch(/overflow-x/);
    expect(CONSTELLATION_CSS).not.toMatch(/overflow: auto|overflow: scroll/);
  });

  it('writes no width and no min-width on either seating', () => {
    // The map's cards are a grid of fixed tracks and the band above them is an SVG
    // that scales, so neither can be wider than the pane. There is no declaration
    // here for a future breakpoint to have to correct.
    for (const selector of ['.agent-map', '.agent-path']) {
      const body = new RegExp(`\\${selector} \\{([^}]*)\\}`).exec(CONSTELLATION_CSS)?.[1] ?? '';
      expect(body, selector).toContain('min-width: 0');
      expect(body, selector).not.toMatch(/(?:^|[^-])width: (?!100%)/);
    }
  });

  it('carries the drawing’s size in the viewBox and not as pixels on the element', () => {
    const markup = map(finished, null);
    expect(markup).toMatch(/viewBox="0 0 820 \d+"/);
    expect(markup).not.toMatch(/<svg[^>]*\swidth="\d/);
    expect(markup).not.toMatch(/<svg[^>]*\sheight="\d/);
  });
});
