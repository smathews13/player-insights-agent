import { readFileSync, readdirSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentMapConstellation, AgentPathConstellation } from './AgentConstellation';
import { partial } from './styles/stylesheet';
import { BRAND_PRODUCT_NAMES } from './brand-icons';
import type { TraceStage } from './answer-shape';
import { mergeLiveStage } from './live-progress';

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

/** A run of any length, for the claims that are about a path still growing. */
function runOf(count: number): TraceStage[] {
  return Array.from({ length: count }, (_, index) => stage({ id: `step-${index + 1}` }));
}

/** The same run with its last step still going. */
const inFlight: TraceStage[] = [
  ...finished.slice(0, 5),
  stage({ id: 'step-3-1-data_genie', name: 'Queried governed data', kind: 'tool', status: 'running', duration: 0 }),
];

const path = (
  stages: TraceStage[],
  activeIndex: number,
  elapsedMs: number | null = null,
  totalMs: number | null = null
) =>
  renderToStaticMarkup(
    <AgentPathConstellation stages={stages} activeIndex={activeIndex} elapsedMs={elapsedMs} totalMs={totalMs} />
  );

const map = (stages: TraceStage[], selectedId: string | null = null) =>
  renderToStaticMarkup(<AgentMapConstellation stages={stages} selectedId={selectedId} />);

/** Every attribute value for one attribute, so a count can be asserted. */
function attrs(markup: string, name: string): string[] {
  return [...markup.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((found) => found[1]);
}

/**
 * Which star carries the selected marking, zero-based, or -1 when none does.
 *
 * Read off the star groups in the order they are drawn, which is the order of the
 * stages: the class is what `.ast-star-select.selected` paints, so this is the
 * node a reader sees marked.
 */
function selectedStar(markup: string): number {
  return [...markup.matchAll(/class="ast-star-select ?([^"]*)"/g)].findIndex((found) => found[1].trim() === 'selected');
}

/** The one sentence on the band's status line. */
function statusLine(markup: string): string {
  return /<span class="ast-sky-status-text">([^<]*)<\/span>/.exec(markup)?.[1] ?? '';
}

/** The body of the band's one effect, up to its dependency list. */
function effectBody(source: string): string {
  const open = source.indexOf('useFollowEffect(() => {');
  expect(open, 'the band has an effect').toBeGreaterThan(-1);
  const body = source.slice(open);
  return body.slice(0, body.indexOf('}, ['));
}

describe('the bands expose only the controls they own (§5)', () => {
  it('adds a star when the approved continuation reports its next step', () => {
    // This is the state transition the approval regression froze: the stream's
    // stage is merged into the live run and that new array must produce a larger
    // constellation immediately, without waiting for the final answer.
    const first = [stage({ id: 'orchestrator', name: 'Orchestrator', status: 'running', duration: 0 })];
    const next = mergeLiveStage(
      first,
      stage({ id: 'step-1', name: 'Choosing the next step', status: 'running', duration: 0 })
    );

    expect(attrs(path(first, 0), 'aria-label').filter((label) => label.startsWith('Select step '))).toHaveLength(1);
    expect(attrs(path(next, 1), 'aria-label').filter((label) => label.startsWith('Select step '))).toHaveLength(2);
    expect(path(next, 1)).toContain('Step 02 · Choosing the next step');
  });

  it('marks the step the run is on, at whatever step count the run has reached', () => {
    /*
     * THE REPORTED DEFECT, as the reader met it: six stars on the band, the run
     * around step seven, and the ring and the status line both still on
     * "Step 01 · Orchestrator".
     *
     * The band follows the caller's `activeIndex`, so this is the claim that
     * nothing here pins step 01 -- and it is asserted at every length of the run
     * rather than at one, because the fault it forecloses was invisible on the
     * first step and wrong on every step after it.
     */
    const run: TraceStage[] = [stage({ id: 'orchestrator', name: 'Orchestrator', status: 'running', duration: 0 })];
    for (const [id, name] of [
      ['data_source_finder', 'Data Source Finder'],
      ['step-1', 'Choosing the next step'],
      ['step-1-1-data_genie', 'Querying governed data'],
      ['step-2', 'Chose the next step'],
      ['synthesis', 'Preparing the findings'],
      ['plot', 'Building the charts'],
    ] as const) {
      run.push(stage({ id, name, status: 'running', duration: 0 }));
      const markup = path(run, run.length - 1, 7_000);
      expect(selectedStar(markup)).toBe(run.length - 1);
      expect(statusLine(markup)).toBe(`Step 0${run.length} · ${name}`);
    }
    // Seven steps in, which is the state in the report, and not one of them is 01.
    expect(run).toHaveLength(7);
    expect(statusLine(path(run, 6, 7_000))).toBe('Step 07 · Building the charts');
    expect(statusLine(path(run, 6, 7_000))).not.toContain('Orchestrator');
  });

  it('marks the newest step even in the gap where none is running', () => {
    /*
     * Between one step reporting and the next being announced the frontier is a
     * COMPLETED step, and it keeps the ring: the newest step is worth marking, and
     * marking it is not the same as claiming it is happening. So the beat and the
     * elapsed figure go and the ring stays, rather than the mark jumping back to
     * whichever envelope is still open two rows up.
     */
    const gap: TraceStage[] = [
      stage({ id: 'orchestrator', name: 'Orchestrator', status: 'running', duration: 0 }),
      stage({ id: 'step-1', name: 'Chose the next step' }),
      stage({ id: 'step-1-1-data_genie', name: 'Queried governed data', kind: 'tool' }),
    ];
    const markup = path(gap, 2, 7_000);
    expect(selectedStar(markup)).toBe(2);
    expect(statusLine(markup)).toBe('Step 03 · Queried governed data');
    expect(markup).not.toContain('ast-anim-star-pulse');
    expect(markup).not.toMatch(/ast-sky-status-elapsed/);
  });

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
    /*
     * Not "connecting", not "drawing", not "loading". The sentence is about the
     * run.
     *
     * READ OFF THE VISIBLE TEXT rather than off the markup, which is what the
     * claim was always about: the words a reader reads. It was the raw markup as
     * a cheap proxy for them, and the proxy broke when the foot's mark became the
     * app's loader -- `ConceptFlicker` carries its cycle timing as an inline
     * `animation-duration`, on this surface exactly as on the splash and the
     * strip, so "animat" is now in an attribute on every running band. An
     * attribute is not a description of the animation; it is the animation.
     */
    const words = markup.replace(/<[^>]*>/g, ' ').toLowerCase();
    expect(words).not.toContain('animat');
    expect(words).not.toContain('sparkle');
    expect(words).not.toContain('constellation');
    expect(words).not.toContain('loading');
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
     * list. That only holds if the WHICH-ANIMATION arrives as one of those
     * classes, which is what this checks.
     *
     * Timing may arrive inline and does: a duration and a delay are properties of
     * a seating, and `ConceptFlicker` hands each of its four stacked marks the
     * same `ast-anim-flick` with a different `animation-delay` -- that stagger is
     * the whole mechanism, and it cannot live in a stylesheet that does not know
     * how many marks a slot holds. The guard still wins over both, because
     * `animation: none !important` is the shorthand and resets every longhand it
     * has. What must never arrive inline is a NAME, because a name with no
     * `ast-anim-` class on the element is an animation the guard cannot see.
     */
    const markup = path(inFlight, 5, 12_000);
    expect(markup).toContain('ast-anim-draw');
    expect(markup).toMatch(/ast-anim-(star|center)-pulse/);
    expect(markup).not.toMatch(/style="[^"]*animation-name/);
    expect(markup).not.toMatch(/style="[^"]*animation:/);
    // Every inline animation property on the band is timing, and every element
    // carrying one is also carrying a class the guard covers.
    for (const [, declaration, element] of markup.matchAll(/style="([^"]*animation[^"]*)"|(<[^>]*animation[^>]*>)/g)) {
      if (declaration) expect(declaration).toMatch(/^(animation-(duration|delay):[^;]*;?)+$/);
      if (element) expect(element).toMatch(/class="[^"]*ast-anim-/);
    }
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

  it('prints the recorded total beside the final step', () => {
    const markup = path(finished, -1, null, 193_000);
    expect(markup).toContain('Step 06 · Queried governed data');
    expect(markup).toContain('3m 13s');
    expect(markup).toContain('193,000 milliseconds');
  });

  it('moves not one coordinate on the band when only the clock has ticked', () => {
    /*
     * THE OTHER HALF OF THE SHAKE. The caller ticks `elapsedMs` once a second for
     * as long as a step is in flight, so the whole band is redrawn every second
     * of a run that can last a minute. Everything above the status line has to be
     * byte-identical across that tick: the geometry is derived from the stages
     * alone, and the second this stops being true the band twitches once a second
     * on a surface whose whole job is to be watched.
     */
    const early = path(inFlight, 5, 3_000);
    const late = path(inFlight, 5, 41_000);
    const geometry = (markup: string) => [
      ...attrs(markup, 'd'),
      ...attrs(markup, 'cx'),
      ...attrs(markup, 'cy'),
      ...attrs(markup, 'x'),
      ...attrs(markup, 'y'),
      ...attrs(markup, 'viewBox'),
      ...attrs(markup, 'style'),
    ];
    expect(geometry(late)).toEqual(geometry(early));
    // And the tick did land, so this is not two identical renders of nothing.
    expect(late).toContain('41s');
    expect(early).toContain('3s');
  });

  it('grows the band downward without disturbing the stars already on it', () => {
    /*
     * The reported defect: the steps shook and jittered while the constellation
     * built out. Every star was re-placed each time a step was announced, because
     * the pitch was the panel's body divided by the step count. The arithmetic is
     * held in agent-constellation.test.ts; this is the same claim about the markup
     * a reader is actually looking at.
     */
    const eight = path(runOf(8), 7, 12_000);
    const nine = path(runOf(9), 8, 12_000);
    // The connectors only. The stars are drawn after them and the newest run has
    // one more of each, so a flat list of every `d` on the band would not line up.
    const hops = (markup: string) => {
      const open = markup.indexOf('<g class="ast-links">');
      return attrs(markup.slice(open, markup.indexOf('</g>', open)), 'd');
    };
    expect(hops(eight)).toHaveLength(7);
    expect(hops(nine).slice(0, 7)).toEqual(hops(eight));
    // The panel got taller rather than being rescaled around its contents.
    const box = (markup: string) => attrs(markup, 'viewBox')[0].split(' ').map(Number);
    expect(box(nine)[2]).toBe(box(eight)[2]);
    expect(box(nine)[3]).toBeGreaterThan(box(eight)[3]);
  });

  it('refuses to be squashed by the column it sits in', () => {
    /*
     * The other way a growing band shakes, and the one that moves stars sideways.
     *
     * `.trace-inspector` is a flex column with a definite height and
     * `overflow-y: auto`, and `.ast-sky` sets `overflow: clip` -- which resolves a
     * flex item's automatic minimum size to zero. So the band could be squashed
     * instead of the column being scrolled, and a squashed band rescales: the SVG
     * is `xMidYMin meet`, so its scale becomes a function of the room left in the
     * column, and every reported step changes it.
     *
     * `flex: none` on both boxes is what makes the drawing keep its own height.
     * It is asserted here because nothing on screen distinguishes a band that is
     * scaled to fit from one that is not until a step lands and the sky slides.
     */
    const rule = (selector: string) => {
      const open = CONSTELLATION_CSS.indexOf(`${selector} {`);
      expect(open, `${selector} is in the stylesheet`).toBeGreaterThan(-1);
      return CONSTELLATION_CSS.slice(open, CONSTELLATION_CSS.indexOf('}', open));
    };
    expect(rule('.ast-sky')).toMatch(/flex:\s*none/);
    expect(rule('.ast-sky-canvas')).toMatch(/flex:\s*none/);
  });

  it('prints no elapsed when the caller has no clock to offer', () => {
    expect(path(inFlight, 5, null)).not.toMatch(/ast-sky-status-elapsed/);
  });

  it('names the final step after the run settles', () => {
    expect(path([], -1, null)).toBe('');
    expect(path(finished, -1, null)).toContain('Step 06 · Queried governed data');
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
    expect(status(finished)).toBe('Step 06 · Queried governed data');
  });
});

describe('a step the reader pinned outranks the step the run is on', () => {
  /*
   * Read as source rather than driven, in the pattern live-progress.test.ts
   * already uses for the same reason: the suite runs on `node`, so a press cannot
   * be dispatched here, and the wiring is the half of this behaviour that has
   * actually broken. The other half -- which node is marked for a given
   * `activeIndex` -- is rendered above.
   */
  it('pins by the step’s own id, so a run opened later cannot inherit the pin', () => {
    // By id and not by position, for the reason the tiles under the band are: the
    // stage list is replaced under this component when another run is opened, and
    // an index would pin whatever step had moved into that slot.
    expect(PATH_SOURCE).toContain('useState<string | null>(null)');
    expect(PATH_SOURCE).toContain('stages.findIndex((stage) => stage.id === pinnedId)');
    expect(PATH_SOURCE).toContain('onClick={() => pin(stages[index].id)}');
  });

  it('keeps the pin when the agent announces its next step', () => {
    /*
     * THE REPORTED DEFECT'S OTHER HALF. The pin used to be recorded alongside the
     * `activeIndex` it was made at and honoured only while that index held, so the
     * next step the run announced -- a second or two later -- dropped it and moved
     * the reader out of the step they had just opened.
     */
    expect(PATH_SOURCE).not.toContain('setSelection');
    expect(PATH_SOURCE).not.toContain('selection?.activeIndex === activeIndex');
    expect(PATH_SOURCE).toContain(
      'const shownIndex = pinnedIndex !== -1 ? pinnedIndex : current ? activeIndex : stages.length - 1;'
    );
  });

  it('releases the pin on a second press, which is the toggle the tiles take', () => {
    // One way to stop inspecting a step on this surface rather than two: the same
    // press that opened it hands the band back to the run. See `openId` in
    // TraceDag.tsx, which is the list under this band.
    expect(PATH_SOURCE).toContain('setPinnedId((held) => (held === id ? null : id))');
  });

  it('drops a pin whose step is not in the run on screen, rather than ignoring it', () => {
    // Ignoring it is what the render-time lookup does on its own, and it is not
    // enough: a new run repeats the ids of the old one, so a pin left in state
    // would go dormant while the list was short and reattach itself the moment the
    // new run reached a step with the same id.
    // Corrected while rendering rather than in an effect, which is React's own
    // "adjusting state when a prop changes": in an effect it would be a second
    // render after a first one that drew the wrong star.
    expect(PATH_SOURCE).toContain('if (pinnedId !== null && pinnedIndex === -1) setPinnedId(null);');
    // And the band's one effect does not touch the pin. This was
    // `not.toContain('useEffect')` outright, which stood in for the claim only
    // while the file had no effects at all -- it has one now, and what it does is
    // scroll the column, which is not a piece of state to adjust while rendering.
    expect(effectBody(PATH_SOURCE)).not.toContain('setPinnedId');
  });
});

describe('the column follows the step the band is marking', () => {
  /*
   * THE REPORTED DEFECT: a long run draws taller than the inspector, so the
   * newest star builds its way off the bottom of the column and the reader has
   * to chase the run by hand once a step.
   *
   * Read as source rather than driven. What a scroll does is layout, this repo
   * has no jsdom, and a rendered tree with no layout cannot answer where a star
   * is relative to the box around it. What IS checkable here is the wiring, and
   * the wiring is the half that breaks.
   */
  it('aims at where the geometry put the star, not at the box around the beat', () => {
    /*
     * THE STUTTER, AS REPORTED. The followed star is the one carrying the beat --
     * a scale animation on a 1.6s loop -- so `getBoundingClientRect` on it
     * answers a different size depending on when in that loop it is read, and
     * the follow aimed somewhere slightly different every step.
     *
     * `pathStarY` is the number the geometry module placed the star at, and the
     * canvas scales its viewBox to its own width, so the conversion is exact and
     * the animation cannot move the target.
     */
    const body = effectBody(PATH_SOURCE);
    expect(body).toContain('pathStarY(followIndex)');
    expect(body).toContain('canvasBox.width / PATH_WIDTH');
    expect(body).not.toMatch(/star\.getBoundingClientRect/);
  });

  it('lands the correction in the commit that grew the band, not a frame later', () => {
    /*
     * The other half of the stutter. In a passive effect the browser paints the
     * taller band at the old offset and the correction arrives a frame after, so
     * every step was a paint and then a jump. A layout effect writes before the
     * paint, and a `requestAnimationFrame` would put the lag straight back.
     */
    expect(PATH_SOURCE).toContain('useFollowEffect(() => {');
    expect(PATH_SOURCE).toContain("typeof document === 'undefined' ? useEffect : useLayoutEffect");
    expect(PATH_SOURCE).not.toMatch(/requestAnimationFrame\(/);
  });

  it('scrolls on a change of step rather than on every tick of the clock', () => {
    // The caller ticks `elapsedMs` once a second for as long as a step is in
    // flight. An effect that ran on every render would haul the column back once
    // a second while the reader was looking somewhere else in it.
    expect(PATH_SOURCE).toMatch(/\}, \[followIndex\]\);/);
    expect(effectBody(PATH_SOURCE)).not.toContain('elapsedMs');
  });

  it('writes nothing at all for a correction too small to see', () => {
    // A follow that writes a fraction of a pixel writes on every step for no
    // visible gain, and the writes are what reads as a twitch.
    expect(effectBody(PATH_SOURCE)).toContain('if (Math.abs(drop) < FOLLOW_DEAD_ZONE) return;');
    expect(PATH_SOURCE).toMatch(/const FOLLOW_DEAD_ZONE = 1;/);
  });

  it('reads every measurement before it writes the one it decided on', () => {
    // A read after a write in the same pass is what makes a scroll correction
    // thrash: the write invalidates layout and the next read forces it again.
    const body = effectBody(PATH_SOURCE);
    const write = body.indexOf('scroller.scrollTop +=');
    expect(write).toBeGreaterThan(-1);
    expect(body.slice(write)).not.toContain('getBoundingClientRect');
    expect(body.match(/scroller\.scrollTop \+?=/g)).toHaveLength(1);
  });

  it('takes the browser off the same scroll, so the two cannot fight', () => {
    /*
     * Scroll anchoring adjusts `scrollTop` to hold its anchor still when content
     * around it changes size, and this column changes size on every step. So a
     * step produced two moves -- the browser's compensation and the band's own
     * follow -- and two moves per step is what a reader sees as stutter.
     */
    expect(partial('rail.css')).toMatch(/\.trace-inspector \{[^}]*overflow-anchor: none/);
  });

  it('leaves the pinned reader where they are', () => {
    // A pin is the reader opening a settled step while the run goes on past it.
    // Scrolling them off it is the same defect the pin was written to end, so a
    // pinned band follows nothing until it is released.
    expect(PATH_SOURCE).toContain('const followIndex = pinnedIndex !== -1 ? -1 : shownIndex;');
    expect(effectBody(PATH_SOURCE)).toContain('if (followIndex < 0 || canvas === null) return;');
  });

  it('moves the nearest scroller only, and never the page under it', () => {
    /*
     * `scrollIntoView` walks every scrollable ancestor, so a step landing in the
     * rail could move the transcript in the middle pane -- the reader's own
     * answer, scrolled out from under them by a panel beside it. The walk stops
     * at the first box that can take the scroll and sets that box's `scrollTop`.
     */
    expect(PATH_SOURCE).not.toMatch(/\.scrollIntoView\(/);
    expect(PATH_SOURCE).toContain('function scrollParent(');
    expect(PATH_SOURCE).toMatch(/box\.scrollHeight > box\.clientHeight/);
    const body = effectBody(PATH_SOURCE);
    expect(body).toContain('scroller.scrollTop += drop;');
    expect(body).not.toContain('window.scroll');
  });

  it('keeps the status line on screen with the star it names', () => {
    // Parking the followed star on the column's bottom edge would scroll its own
    // caption -- "Step 17 · Built the charts" -- out of view.
    const body = effectBody(PATH_SOURCE);
    expect(body).toContain('statusRef.current?.getBoundingClientRect().height');
    expect(body).toContain('view.bottom - reserve - FOLLOW_MARGIN');
    expect(PATH_SOURCE).toContain('<p ref={statusRef} className="ast-sky-status" aria-live="polite">');
  });

  it('renders the same markup it always did, refs being nothing a reader sees', () => {
    // The follow is layout, not drawing: no attribute, no class and no wrapper
    // arrives with it, so nothing above the status line moved.
    const markup = path(runOf(18), 17, 12_000);
    expect(markup).not.toContain('ref=');
    expect(selectedStar(markup)).toBe(17);
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
    // The band's own surface. It was `--ast-navy`, the ink token, and it is
    // `--ast-sky-fill` now: the same darkness pitched as a blue rather than as a
    // near-black, which is the one colour decision this file makes.
    expect(CONSTELLATION_CSS).toMatch(/var\(--ast-sky-fill\)/);
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
    // 11 twice, on purpose: `size` picks the drawing as well as the box, and
    // `.ast-sky-status-mark svg` paints 11px. A seat that asks for one number
    // and is painted another gets the wrong cut of the mark stretched to the
    // right size -- nothing looks broken, the graduations are just missing or
    // crowded at a size they were not drawn for.
    expect(PATH_SOURCE).toContain('<AstrolabeMark size={11} ink="dark" />');
    expect(CONSTELLATION_CSS).toMatch(/\.ast-sky-status-mark \.brand-icon,[\s\S]*?width: 11px/);
    expect(CONSTELLATION_CSS).toMatch(/\.ast-sky-status-mark \{[^}]*border: 1px solid/);
    // `dark` because the status line is on the navy band. The light cut's
    // #2272B4 is 1.9:1 there and the accent dots read as a texture (§2).
  });

  it('flickers the foot’s mark while the run is inside the step the line names', () => {
    /*
     * THE REPORTED DEFECT: the one glyph on the foot of a running band was the
     * only thing on the surface not saying the run was going -- lines drawing,
     * star beating, ring breathing, and a still mark under all three.
     *
     * Asserted as the shared loader rather than as four `<svg>`s: what makes this
     * fixed is that the foot cycles THE SAME four concepts on THE SAME keyframes
     * the splash and the strip cycle, so a retune of `ast-flick` moves all three.
     * A second cycle written into this file would pass a test that counted marks.
     */
    const running = path(inFlight, 5, 12_000);
    expect(running).toContain('ast-flick-slot--status');
    // Four stacked concepts, one class, four staggered delays -- ConceptFlicker's
    // contract, checked here because this seat supplies the size it renders at.
    expect([...running.matchAll(/ast-anim-flick/g)]).toHaveLength(4);
    expect(running).toMatch(/animation-duration:\s*3\.2s/);
    // The seat's own number, painted at the number the slot has always painted.
    expect(running).toMatch(/class="ast-flick-slot ast-flick-slot--status"[^>]*width:\s*11px/);
  });

  it('freezes on the finished step’s real mark once the run stops', () => {
    /*
     * The other half, and the half that would rot first: a loader still cycling
     * over a settled run is the band saying the agent is still working, which is
     * exactly the claim `inFlight` exists to stop the ring and the lines making.
     *
     * `activeIndex` of -1 is the caller saying no step is in progress. A run whose
     * last step is `running` but which the caller has stopped reporting on is the
     * same state and is checked too: the flicker follows the caller's statement,
     * not the stage's own leftover status.
     */
    for (const markup of [path(finished, -1, null, 27_400), path(inFlight, -1)]) {
      expect(markup).not.toContain('ast-flick-slot');
      expect(markup).not.toContain('ast-anim-flick');
    }
    // And what it freezes on is the real thing: the last step of `finished` is a
    // Genie tool call, so the foot holds that product's mark rather than the
    // app's, which is the fallback for a step no product is behind.
    expect(path(finished, -1, null, 27_400)).toContain('brand-icon');
  });

  it('holds the real mark for a step the reader pinned, mid-run', () => {
    // A pin is the reader opening a settled step while the run goes on past it.
    // The line then names THAT step, so a loader beside it would be this band
    // claiming a finished step is happening -- the same substitution the ring
    // refuses. Read as source: the suite runs on `node` and a press cannot be
    // dispatched here, and the condition is the half that breaks.
    expect(PATH_SOURCE).toContain('const flickering = inFlight && pinnedIndex === -1;');
    expect(PATH_SOURCE).toContain('{flickering ? (');
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
