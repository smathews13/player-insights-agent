import { readFileSync, readdirSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StageDetail, TraceDag } from './TraceDag';
import {
  cardCalls,
  cardTiming,
  isOrchestratorStep,
  describeResult,
  detailTiming,
  nameParts,
  railConnector,
  railGlyph,
  railLane,
  railTiming,
  rawIo,
  runContainerSummary,
  sqlLines,
  sqlTokens,
  stepNumber,
  tickingTiming,
  RAIL_CONNECTOR_HEIGHT,
  RAIL_INDENT,
  RAIL_LANE,
  RAIL_UNFINISHED,
} from './agent-map';
import { partial } from './styles/stylesheet';
import type { TraceStage } from './answer-shape';

/**
 * The two arrangements of the agent's stages, and the line between them.
 *
 * The map, on Run Explorer's full-width tab, drew every stage of a run in one
 * horizontal line inside a card, so an eight-stage run finished somewhere to the
 * right of the viewport behind a scrollbar on a container nothing announced as
 * scrollable. It wraps now, onto rows of four.
 *
 * The rail, on Ask PIA, is the same component in a 264px column, and the wrapping
 * broke it: the map's `flex: 1 1 190px` was written on the bare `.dag-step`, and a
 * basis in a column is a HEIGHT, so every step in the rail became a 190px box
 * around a 60px card. The pane shipped as cards separated by a card's worth of
 * nothing with the connector labels stranded in the gaps.
 *
 * So the tests come in pairs: what the map does, and what the rail does NOT
 * inherit from it. The leak was invisible to the first version of this file
 * because it exercised the wide case only.
 *
 * The map is now specified, in docs/design-handoff-pia-dubois-revamp/agent-map.md,
 * and the rail is not. That is why the two draw different cards rather than one
 * card bent into two shapes, and it is why this file's rail section is written as
 * a set of things the rail must be rather than a set of overrides it applies:
 * bending one card into both shapes is how the 190px basis came to be written.
 *
 * What is NOT verified here, and cannot be without a browser: where the rows
 * actually break, whether a name clamps at two lines in a given font, and how any
 * of it looks. The claims below are about the declarations that decide those
 * things and about the strings the component prints.
 */
const TRACE_CSS = partial('trace.css');
/** Where the connector's grey is defined, so the document's literal can be read. */
const TOKENS = partial('tokens.css');
const ANSWER_BODY_CSS = partial('answer-body.css');
const RESPONSIVE_CSS = partial('responsive.css');
const SOURCE = readFileSync(new URL('./TraceDag.tsx', import.meta.url), 'utf8');

/** The body of one rule, matched on the whole selector rather than a suffix. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(TRACE_CSS)?.[1] ?? '';
}

/** The first length in a declaration, so two rules can be compared as numbers. */
function px(body: string, property: string): number | null {
  const found = new RegExp(`${property}:[^;]*?(\\d+)px`).exec(body);
  return found ? Number(found[1]) : null;
}

/**
 * Every rule as one selector and the body it carries, at-rules skipped and each
 * selector in a comma-separated list treated as its own.
 *
 * A list is split because that is where a scoping claim is actually broken: one
 * arrangement named beside another in the same rule hands the second everything
 * the first asked for.
 */
function rules(): { selector: string; body: string }[] {
  const source = TRACE_CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => !selector.trim().startsWith('@'))
    .flatMap(([, selector, body]) => selector.split(',').map((one) => ({ selector: one.trim(), body })));
}

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
  stage({ id: 'step-1', name: 'Chose the next step' }),
  stage({
    id: 'step-1-1-search_semantics',
    name: 'Searched the semantic layer',
    kind: 'tool',
    depth: 1,
    parent_id: 'step-1',
  }),
  stage({ id: 'step-2', name: 'Chose the next step' }),
  stage({ id: 'step-2-1-describe_table', name: "Read a table's columns", kind: 'tool', depth: 1, parent_id: 'step-2' }),
  stage({ id: 'step-3', name: 'Chose the next step' }),
  stage({ id: 'step-3-1-data_genie', name: 'Queried governed data', kind: 'tool', depth: 1, parent_id: 'step-3' }),
  stage({ id: 'plot', name: 'Drew the chart', kind: 'tool' }),
  stage({ id: 'synthesis', name: 'Wrote the answer' }),
];

/**
 * The names on the cards, as a reader sees them.
 *
 * A name is one text node unless it carries a tool's identifier, in which case it
 * is a run of prose and a run of mono. Both shapes are read here, because a
 * helper that silently returns empty strings for one of them is how a test passes
 * for the wrong reason -- which is exactly what happened while this was two
 * helpers and the markup changed under one of them.
 */
function drawn(markup: string): string[] {
  const name = /<span class="dag-name"[^>]*>((?:[^<]|<(?:span|code)[^>]*>[^<]*<\/(?:span|code)>)*)<\/span>/g;
  return [...markup.matchAll(name)].map((match) =>
    match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&')
  );
}

/**
 * The rail's tiles, with the band above them cut off.
 *
 * `.agent-path` is the band and then the tiles, and the band now ships in two
 * views -- the night sky, and the daylight list light mode draws instead of it,
 * with one of the two `display: none` in any theme (constellation.css). Both are
 * in the markup, so a claim about what the TILES draw has to say so: this pane's
 * rules are about a 264px row, and the band above answers to `#18a` instead.
 *
 * Which of the two the rail shows is a stylesheet claim and is read back in
 * light-mode.test.tsx, including the one that matters here -- the daylight list is
 * hidden in this seating in BOTH themes, because these tiles already are the run
 * as a list and a reader would have been given it twice.
 */
function tiles(markup: string): string {
  const open = markup.indexOf('<div class="trace-dag compact">');
  return open === -1 ? markup : markup.slice(open);
}

describe('the agent map fits the page it is drawn on', () => {
  it('is the step map only, with no constellation stacked above it', () => {
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} />);
    expect(markup.match(/class="dag-node/g)).toHaveLength(run.length);
    expect(markup).not.toContain('ast-sky-map');
    expect(markup).not.toContain('ast-sky-path');
  });

  it('lays the steps on a grid of four rather than sharing out each row’s slack', () => {
    // The reported defect: row one held five cards, row two held five that lined
    // up under none of them, and row three held card 11 at the left with card 12
    // adrift in the middle. That is what `flex: 1 1 190px` does -- each row
    // divides its own leftover width, so no two rows agree on where a column is.
    // A grid track is the same width on every row by construction, and the
    // handoff's fixed count of four means the columns are in the same place on
    // every run rather than being a function of how many cards happened to fit.
    const map = rule('.trace-dag.map');
    expect(map).toMatch(/display: grid/);
    expect(map).toMatch(/grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
    expect(map).toMatch(/row-gap:/);
  });

  it('gives a track a zero minimum, so one long name cannot move a column', () => {
    // `1fr` alone is `minmax(auto, 1fr)`, and `auto` is the width of the widest
    // unbreakable thing in the track. A single card holding a long identifier
    // would then widen its own column and take the alignment of every row with
    // it, which is the defect this grid replaced wearing different clothes. Zero
    // is what hands that job to the clamp inside the card.
    expect(rule('.trace-dag.map')).toMatch(/minmax\(0, 1fr\)/);
    expect(rule('.trace-dag.map .dag-node')).toMatch(/min-width: 0/);
  });

  it('declares its narrow-width column count where every other width lives', () => {
    // Four cards on a phone are about 70px each, which is narrower than a step
    // number beside a duration. The reduction is real and it is in responsive.css,
    // because breakpoints.test.ts keeps every structural width query in that one
    // file -- a query here would be a second, invisible set of them.
    expect([...TRACE_CSS.matchAll(/@media\s*\((?:max|min)-width/g)]).toEqual([]);
    expect(RESPONSIVE_CSS).toMatch(/\.trace-dag\.map \{\n\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  });

  it('holds every card in a row at one height', () => {
    // Also reported: tops and bottoms did not line up, because a card was as tall
    // as its own contents and `align-items: center` floated the short ones in the
    // middle. Three declarations do it -- the track stretches its item, the item
    // stretches the card, and the card fills what it is given.
    expect(rule('.trace-dag.map')).toMatch(/align-items: stretch/);
    expect(rule('.trace-dag.map .dag-step')).toMatch(/align-items: stretch/);
    expect(rule('.trace-dag.map .dag-node')).toMatch(/height: 100%/);
  });

  it('keeps the basis that broke the rail out of both arrangements', () => {
    // It is not scoped away from the rail any more, it is gone: the grid track is
    // the width now, and a basis in either arrangement would be a second opinion
    // about it.
    expect(rule('.dag-step')).toMatch(/min-width: 0/);
    expect(rule('.dag-step')).not.toMatch(/flex: \d+ \d+ \d+px/);
    expect(rule('.trace-dag.map .dag-step')).not.toMatch(/flex: \d+ \d+ \d+px/);
  });

  it('declares no arrangement at all on either bare selector', () => {
    // The general form of the bug this file was written against, and it now covers
    // the card as well as the container. `display` is in the list because a grid
    // and a column are different values of it, and the one that was shared was the
    // one the other had to override. The card's own `display` was shared until the
    // two arrangements stopped drawing the same card; a bare `display: grid` with
    // a 13px first track is exactly the shape of the original leak.
    expect(rule('.trace-dag')).not.toMatch(/display|flex|grid|row-gap|column-gap/);
    expect(rule('.dag-node')).not.toMatch(/display|flex|grid|gap|padding/);
    // The one thing the container may share is vertical breathing room, and only
    // vertical: horizontal padding on the container would shrink the box the
    // row-end arrow has to fall outside of, and the arrow would come back.
    expect(rule('.trace-dag')).toMatch(/padding: 4px 0/);
  });

  it('reads a duration the way every other view of the same run does', () => {
    // The card divided by 1000 and fixed to one decimal, so a 78ms stage read
    // "0.1s" here and "78ms" on the Timeline tab and in the panel this card now
    // opens. Two roundings of one measurement is how the two surfaces came to
    // disagree, which is the defect Run Explorer's own header comment describes.
    const markup = renderToStaticMarkup(<TraceDag stages={[stage({ id: 'step-1', duration: 78 })]} activeIndex={-1} />);
    expect(markup).toContain('78ms');
    expect(markup).not.toContain('0.1s');
  });

  it('starts with the same Orchestrator run envelope as Timeline row 1', () => {
    const markup = renderToStaticMarkup(
      <TraceDag
        stages={run}
        activeIndex={-1}
        trace={{ id: 'trace-1', totalMs: 12_340, toolCalls: 3, stages: run }}
        question="Which source should we use?"
      />
    );
    expect(drawn(markup)[0]).toBe('Orchestrator run');
    expect(markup.match(/class="dag-node/g)).toHaveLength(run.length + 1);
    expect(markup).toContain('class="dag-step run-envelope"');
    expect(markup).toContain('12.34s');
    expect(markup).toContain('3 tool calls');
    expect(rule('.trace-dag.map .dag-step.run-envelope')).toMatch(/grid-column: 1 \/ -1/);
    expect(markup).toContain('class="trace-dag map has-run-envelope"');
    const wholeRun = rule('.trace-dag.map.has-run-envelope');
    // The envelope is the app's action blue, the same token the open card's 2px
    // edge and every other primary outline take -- not a second blue mixed for
    // this one rule, and not the grey connector it used to be, which read as
    // chrome around the run rather than a boundary belonging to it.
    expect(wholeRun).toMatch(/border: 1px dashed var\(--primary\)/);
    // DASHED, NOT DOTTED. 1px dots at a 1px pitch are a half-tone haze rather
    // than a line, and that fuzz is what this rule was changed to remove.
    expect(wholeRun).not.toMatch(/dotted/);
    expect(wholeRun).toMatch(/border-radius: var\(--radius-md\)/);
    // Even padding on all four sides: the gap between the perimeter and the
    // cards is the same everywhere, so a single shorthand and no per-side
    // override is the assertion.
    expect(wholeRun).toMatch(/padding: 14px;/);
    expect(wholeRun).not.toMatch(/padding-(top|right|bottom|left)/);
  });

  it('opens the aggregate root as a real run summary, never a fake empty result', () => {
    const stages = [
      ...run.slice(0, -1),
      stage({ id: 'synthesis', name: 'Prepared the answer', output: 'The requested answer is available.' }),
    ];
    const summary = runContainerSummary({
      stages,
      trace: { id: 'trace-summary-1', totalMs: 12_340, toolCalls: 3 },
      activeIndex: -1,
      runStatus: 'complete',
      verdict: 'complete',
    });
    const markup = renderToStaticMarkup(
      <StageDetail
        stage={stage({ id: '__run__', name: 'Orchestrator run', duration: 12_340, calls: 3 })}
        step={1}
        origin={0}
        id="run-summary"
        runSummary={summary}
      />
    );
    expect(markup).toContain('Run summary');
    expect(markup).toContain('aria-label="Run summary evidence"');
    expect(markup).toContain('8</span> stages');
    expect(markup).toContain('3</span> tool calls');
    expect(markup).toContain('12.34s</span> wall time');
    expect(markup).toContain('<dt>Final answer</dt><dd>Available</dd>');
    expect(markup).toContain('trace-summary-1');
    expect(markup).not.toContain('<dt>Result</dt>');
    expect(markup).not.toContain('(none recorded)');
  });

  it.each([
    ['running', 'running', 'Pending'],
    ['awaiting_approval', 'awaiting approval', 'Awaiting approval'],
    ['cancelled', 'cancelled', 'Not recorded'],
    ['failed', 'failed', 'Not recorded'],
    ['partial', 'partial', 'Not recorded'],
    ['complete', 'complete', 'Not recorded'],
  ])('states a %s root truthfully', (stored, expected, answer) => {
    const summary = runContainerSummary({
      stages: run,
      trace: { id: 'trace-state', totalMs: 12_340, toolCalls: 3 },
      activeIndex: stored === 'running' ? 0 : -1,
      runStatus: stored,
    });
    expect(summary.status).toBe(expected);
    expect(summary.answerAvailability).toBe(answer);
  });
});

/*
 * The card, as the handoff describes it: a kind chip, a two-digit step number and
 * a right-pinned duration on one line, and a clamped name under them.
 */
describe('a card says what kind of step, which step, and how long', () => {
  it('draws the kind chip at the handoff’s size and corner', () => {
    const chip = rule('.dag-chip');
    expect(px(chip, 'width')).toBe(22);
    expect(px(chip, 'height')).toBe(22);
    expect(chip).toMatch(/border-radius: 6px/);
  });

  it('separates an agent decision from a tool call by its fill, and by nothing else', () => {
    // The two fills are the whole distinction: Ice is §2's AI-context surface, the
    // one every agent-context object in this design sits on, and the neutral wash
    // is a tool. Which tool is the glyph's job.
    //
    // Ice replaces the oat this used to be, and the token name is what is asserted:
    // §2 says Ice "replaces oat everywhere", so a rule still reading `--db-warm`
    // here is a chip that did not migrate rather than a chip somebody preferred.
    expect(rule('.dag-chip.agent')).toMatch(/background: var\(--ast-ice\)/);
    expect(rule('.dag-chip.agent')).not.toMatch(/--db-warm/);
    expect(rule('.dag-chip.tool')).toMatch(/background: var\(--db-wash\)/);
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} />);
    expect(markup.match(/class="dag-chip agent"/g)).toHaveLength(4);
    expect(markup.match(/class="dag-chip tool"/g)).toHaveLength(4);
  });

  it('chips an agent decision with the mark, because the mark is the agent', () => {
    // THE ROBOT IS RETIRED. §1: "the mark is also the agent", and §9 lists the
    // orange robot among the things this design removes rather than restyles -- so
    // this chip is not the robot's chip restained, the figure in it is a different
    // figure. A robot here in any colour is the old identity still signing steps.
    expect(SOURCE).toContain('<AstrolabeMark size={13} />');
    expect(SOURCE).toContain("import { AstrolabeMark } from './AstrolabeMark'");
    expect(SOURCE).not.toMatch(/PiaRobotMark/);
    // THE SIZE PROP AND THE PAINTED SIZE HAVE TO AGREE, and 13 is both here.
    // `markElements` picks the drawing from `size` as well as the box -- below
    // GRADUATION_FLOOR it drops the graduation ring and thickens the rim -- while
    // the stylesheet paints whatever it paints. Ask for one number and paint
    // another and you get the wrong cut scaled to the right box, which looks
    // like nothing at all until somebody compares two seats side by side.
    //
    // Colour is the `ink` prop and `astrolabe-mark.css` behind it, never a rule
    // here: a `fill` at this seat would be a second astrolabe blue that no
    // palette check reaches. `light` is the default and is right on this chip,
    // which sits on Ice.
    const glyph = rule('.dag-chip.agent > svg');
    expect(px(glyph, 'width')).toBe(13);
    expect(glyph).not.toMatch(/fill|stroke|color/);
    expect(rule('.dag-chip.tool > svg')).toMatch(/color: var\(--db-slate-icon\)/);
  });

  it('draws the mark once, and nowhere else in the app', () => {
    // The same claim agent-mark.test.ts makes for the robot, for the same reason:
    // a second copy of the geometry is correct on the day it is pasted, drifts on
    // the first retune of either, and shows nothing on screen until somebody who
    // has seen both notices the chip's mark and the band's mark are not quite the
    // same figure -- which nobody will, because the two are never visible together.
    //
    // This has already happened once and is why the tell is what it is. This lane
    // drew its own AstrolabeMark, in parallel, with a rim at r26 -- so the string
    // searched for here was that rim, and the file that held it was this lane's
    // copy rather than the one on main. A duplicate check written against the
    // duplicate passes and means nothing. The tell is now a quadrant dot out of
    // SMALL_CUT in `astrolabe-mark.ts`, which is where the numbers actually live.
    const dot = 'cx: 41.5, cy: 22.5';
    const dir = new URL('./', import.meta.url);
    const holders = readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      .filter((name) => readFileSync(new URL(name, dir), 'utf8').includes(dot));
    expect(holders).toEqual(['astrolabe-mark.ts']);
  });

  it('reads which product ran from the shared map rather than from one of its own', () => {
    // This component used to declare the pairing itself, over three DuBois
    // INTERFACE glyphs -- a bookmarked document, the letters S/Q/L, a sparkle --
    // filed under Unity Catalog, Databricks SQL and Genie. Those are the icons
    // that sit beside carets and padlocks; they are not the product marks, and a
    // reader who knows the Databricks marks read one as a product mark and was
    // then wrong about which product ran.
    //
    // What is asserted here is the shape that stops it recurring: the mapping is
    // read, not declared, so this component cannot disagree with the Run
    // Explorer's strips or the Monitoring drawer's timeline about which product a
    // step called. This lane briefly had a `themeProductForTool` of its own that
    // delegated to `productForTool`; the delegation was honest but the second
    // module was not worth its existence, so the map is now read directly.
    expect(SOURCE).toContain("import { productForTool } from './brand-icons'");
    expect(SOURCE).toContain('const product = productForTool(toolNameFromId(stage.id));');
    // The map that used to be declared here. `RAIL_TOOL_GLYPHS` below it is a
    // different thing and stays: three lucide glyphs standing for three families
    // at 13px, which the handoff asks for by name rather than brand marks.
    expect(SOURCE).not.toMatch(/const TOOL_GLYPHS/);
    expect(SOURCE).not.toMatch(/assets\/dubois/);
    // An unmapped tool still falls back rather than being filed under a product
    // it does not call. That is the one case with no honest mark.
    expect(SOURCE).toContain('<Wrench aria-hidden="true" />');
  });

  it('chips a product with the published file rather than with a copy of its drawing', () => {
    // "Never redrawn" is the one thing the handoff says about these marks, and a
    // <path> typed back into JSX cannot be held to it: it starts out identical and
    // is then indented, minified or "tidied" by somebody with nothing to compare it
    // against. So the mark is inlined from the committed asset, and this reads the
    // file off disk and finds it in the rendered chip. The assertion fails on any
    // edit to the artwork, which is the point.
    //
    // The file it reads is now the recoloured cut under `assets/logo/theme/`,
    // which is what the app draws: §9 retires the full-colour marks from the UI
    // and §4 gives `-blue-light` as the cut for a white surface. That the cut is
    // the published geometry with only its fills substituted -- permitted, ruled
    // 2026-08-17, see assets/logo/README.md -- is held in brand-icons.test.tsx,
    // once, rather than restated at every placement.
    const asset = (file: string) =>
      readFileSync(new URL(`./assets/logo/theme/${file}`, import.meta.url), 'utf8').trim();
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} />);
    expect(markup).toContain(asset('unity-catalog-blue-light.svg'));
    expect(markup).toContain(asset('databricks-sql-blue-light.svg'));
    // Agents has a published mark, so the semantic search carries it. It used to
    // carry a lucide Radar, because the DuBois set has no icon of that name and
    // an approximate mark is worse than an honest glyph. The asset answers that
    // rather than the substitution being retried.
    expect(markup).toContain(asset('mosaic-ai-blue-light.svg'));
    // The run above never checks a field definition, so the Genie chip is drawn
    // from a stage of its own rather than asserted against a fixture that cannot
    // produce it.
    const genie = renderToStaticMarkup(
      <TraceDag
        stages={[stage({ id: 'step-1-1-dictionary_genie', name: 'Checked a field definition', kind: 'tool' })]}
        activeIndex={-1}
      />
    );
    expect(genie).toContain(asset('genie-blue-light.svg'));
    // Each chip still says which product it is. This is the one seating in the app
    // where no text label sits beside the mark -- the line below names the TOOL --
    // and four logos at 14px are not four things every reader can tell apart.
    expect(markup).toContain('title="Unity Catalog"');
    expect(markup).toContain('title="Databricks SQL"');
    // §4: the product is called Agents in all UI text, whatever the slug says.
    // The slug in the map is unchanged; the word a reader sees is not.
    expect(markup).toContain('title="Agents"');
    expect(markup).not.toContain('title="Mosaic AI"');
    expect(genie).toContain('title="Genie"');
  });

  it('leaves the marks in the palette, and the fallback glyph in the app’s', () => {
    // The `color` rule on this chip is for the lucide fallback and for nothing
    // else. The brand icons are not reached by it, because they are not direct
    // `svg` children of the chip -- which is what lets the marks carry the ink
    // their own files declare.
    //
    // That ink is the astrolabe blue now rather than the published #FF5F46. It
    // was settled on 2026-08-17: recolouring official geometry into one
    // palette is permitted, redrawing it is not. The claim this assertion makes
    // is therefore the same claim it always made -- the file's own ink reaches
    // the page unaltered by any rule -- against a different file.
    //
    // §2 leaves exactly one full-colour Databricks asset in the app, the bricks
    // symbol inside the Built on Databricks attribution, and this is not it. The
    // published pair `#FF5F46`/`#FABFBA` used to reach this chip unaltered and
    // deliberately; §9 retires it, and the DuBois orange with it.
    expect(rule('.dag-chip.tool > svg')).toMatch(/color: var\(--db-slate-icon\)/);
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} />);
    expect(markup).toContain('class="dag-chip tool"><span class="brand-icon"');
    expect(markup).toContain('#2272B4');
    expect(markup).not.toContain('#FF5F46');
    expect(markup).not.toContain('#FABFBA');
    expect(markup.toUpperCase()).not.toContain('#FF3621');
  });

  it('numbers every stage with a circular badge in the top-left corner', () => {
    // A wrapped grid takes reading order away from position, so the number is what
    // puts it back -- and a fixed width is what makes a column of them line up:
    // "1" beside "12" reads as a ragged edge before it reads as an index.
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} />);
    const numbers = [...markup.matchAll(/class="dag-index ast-num (?:agent|tool)">(\d+)</g)].map((match) => match[1]);
    expect(numbers).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
    // `ast-num` is not decoration on that class list. §3 puts every figure in a
    // column in DM Mono, and DM Sans declares no `tnum` feature at all -- so
    // `font-variant-numeric` on it is a no-op that reads as done, and a column of
    // step numbers set in it cannot line up however it is marked.
    expect(markup).not.toMatch(/class="dag-index"/);
    const badge = rule('.trace-dag.map .dag-index');
    expect(px(badge, 'width')).toBe(24);
    expect(px(badge, 'height')).toBe(24);
    expect(badge).toMatch(/border-radius: 50%/);
    expect(markup).toMatch(
      /<button[^>]*class="dag-node[^"]*"[^>]*><span class="dag-index ast-num agent">01<\/span><span class="dag-card-body">/
    );
    expect(stepNumber(9)).toBe('09');
    expect(stepNumber(10)).toBe('10');
    // A run past ninety-nine prints its real number rather than being clipped.
    expect(stepNumber(104)).toBe('104');
  });

  it('separates duration and call count into compact badges', () => {
    expect(cardTiming({ duration: 2510 })).toBe('2.51s');
    expect(cardTiming({ duration: 467 })).toBe('467ms');
    expect(cardCalls({ calls: 1 })).toBe('1 call');
    expect(cardCalls({ calls: 2 })).toBe('2 calls');
    const markup = renderToStaticMarkup(
      <TraceDag stages={[stage({ id: 'step-1', duration: 2510, calls: 2 })]} activeIndex={-1} />
    );
    expect(markup).toContain('dag-duration-badge');
    expect(markup).toContain('dag-call-badge');
    const metricBadge = rules().find(({ selector }) => selector === '.trace-dag.map .dag-metric-badge')?.body ?? '';
    expect(metricBadge).toMatch(/border-radius: var\(--radius-sm\)/);
  });

  it('keeps the numbered corner fixed and seats the icon beside the title', () => {
    const node = rule('.trace-dag.map .dag-node');
    expect(node).toMatch(/grid-template-columns: 24px minmax\(0, 1fr\)/);
    expect(node).toMatch(/column-gap: 10px/);
    expect(node).not.toMatch(/padding-left: calc/);
    expect(rule('.trace-dag.map .dag-card-body')).toMatch(/flex-direction: column/);
    expect(rule('.trace-dag.map .dag-card-title')).toMatch(/display: flex/);
    expect(rule('.trace-dag.map .dag-card-title')).toMatch(/gap: 8px/);
    expect(rule('.trace-dag.map .dag-index')).toMatch(/font-variant-numeric: tabular-nums/);
  });

  it('labels every decision turn as an Orchestrator step', () => {
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} />);
    expect(markup.match(/Orchestrator step/g)).toHaveLength(3);
    expect(isOrchestratorStep(run[0])).toBe(true);
    expect(isOrchestratorStep(run[1])).toBe(false);
  });

  it('sets the name at the app’s base size and the handoff’s weight', () => {
    const name = rule('.trace-dag.map .dag-name');
    expect(name).toMatch(/font-size: var\(--text-base\)/);
    expect(name).toMatch(/font-weight: 500/);
  });
});

describe('the arrows connect steps, and nothing else', () => {
  it('draws one connector per pair of neighbours, and none after the last', () => {
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} />);
    expect(markup.match(/class="dag-node/g)).toHaveLength(run.length);
    expect(markup.match(/class="dag-edge"/g)).toHaveLength(run.length - 1);
  });

  it('hangs the arrow in the column gutter rather than inside the step', () => {
    // The reported trailing arrow. Laid out inside the step, the connector was
    // drawn whether or not there was a card beside it to point at, so the last
    // card of every wrapped row kept one aimed at the margin. In the gutter it is
    // only ever between two cards -- for the last card of a row the same offset
    // lands past the end of the grid, because a gap exists only between tracks.
    const edge = rule('.trace-dag.map .dag-edge');
    expect(edge).toMatch(/position: absolute/);
    expect(edge).toMatch(/left: 100%/);
    expect(rule('.trace-dag.map .dag-edge::before')).toMatch(/content: '\\2192'/);
  });

  it('draws the arrow at the handoff’s size, in its own neutral', () => {
    // Lighter than the icon rung: an arrow between two cards is punctuation, and
    // at icon weight a row of them competed with the cards they join.
    const edge = rule('.trace-dag.map .dag-edge');
    expect(edge).toMatch(/font-size: 14px/);
    expect(edge).toMatch(/color: var\(--db-connector\)/);
  });

  it('measures the arrow’s lane and the column gap as one number', () => {
    // The arithmetic the row-end arrow's disappearance rests on. Narrower than the
    // gap and an arrow floats short of the next card; wider and it laps onto it,
    // and the one at a row's end is no longer entirely outside the grid.
    expect(px(rule('.trace-dag.map .dag-edge'), 'width')).toBe(px(rule('.trace-dag.map'), 'column-gap'));
  });

  it('clips the row-end arrow away, and cannot be scrolled to it', () => {
    const map = rule('.trace-dag.map');
    expect(map).toMatch(/overflow-x: clip/);
    // The vertical axis stays visible, so the focus ring and the active node's
    // halo are not cropped by the rule that removes the arrow.
    expect(map).toMatch(/overflow-y: visible/);
    // `clip` and not `hidden` or `auto`: a clip region cannot be scrolled, so the
    // scroller that parked half a run off-screen cannot return through this line.
    expect(map).not.toMatch(/overflow(-x)?: (auto|hidden|scroll)/);
  });

  it('says whether a connector is nesting or sequence, where it used to say nothing', () => {
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} />);
    // A tool under a step is "calls"; the next step after it is "then". Hidden
    // rather than dropped: the arrow is in a 26px gutter and cannot be lettered,
    // but a screen reader had been given neither word.
    expect(markup).toContain('<div class="dag-edge"><span>calls</span></div>');
    expect(markup).toContain('<div class="dag-edge"><span>then</span></div>');
    expect(rule('.trace-dag.map .dag-edge span')).toMatch(/clip-path: inset\(50%\)/);
  });
});

describe('the wrapped map still reads in order', () => {
  it('draws every stage in the order the run recorded them, and re-sorts none', () => {
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} />);
    expect(drawn(markup)).toEqual(run.map((item) => item.name));
  });

  it('keeps map icons aligned while preserving the rail’s nesting lanes', () => {
    // The indent used to be inline padding on the step, which in a grid pushes the
    // card out of the column its neighbours are in. It is the card's own padding
    // on the map and the step's in the rail, from one custom property, because the
    // two arrangements indent different boxes and a pixel value in the markup
    // could only be right for one of them.
    expect(SOURCE).toContain("'--dag-depth': depth");
    expect(rule('.trace-dag.map .dag-node')).not.toMatch(/padding-left: calc/);
    // The rail's own step, at its own figure: 26px a level rather than the map's
    // 16px, because the rail's connectors are drawn to the badge lanes that indent
    // produces and 16px would leave every elbow landing beside its card.
    expect(rule('.trace-dag.compact .dag-step')).toMatch(
      new RegExp(`padding-left: calc\\(var\\(--dag-depth, 0\\) \\* ${RAIL_INDENT}px\\)`)
    );
  });
});

/*
 * The tool name that split mid-word.
 *
 * `search_semantics` has no entry in `_TOOL_STAGE_NAMES`, so the agent names its
 * stage "Called search_semantics" -- and the shared `overflow-wrap: anywhere` list
 * in answer-body.css reaches that text and broke it as "search_semantic" with a
 * lone "s" underneath.
 */
describe('an identifier is not broken across two lines', () => {
  const unlabelled = [
    stage({ id: 'step-1', name: 'Chose the next step' }),
    stage({ id: 'step-1-1-search_semantics', name: 'Called search_semantics', kind: 'tool', depth: 1 }),
  ];

  it('breaks the name at spaces only, and clamps what will not fit', () => {
    const name = rule('.trace-dag.map .dag-name');
    expect(name).toMatch(/overflow-wrap: normal/);
    expect(name).toMatch(/-webkit-line-clamp: 2/);
    expect(name).toMatch(/overflow: hidden/);
  });

  it('overrides the shared rule rather than deleting it', () => {
    // `anywhere` is right for the agent's prose and for a fully qualified table
    // name in a narrow column, which is what that list is for. Taking `.dag-node`
    // out of it would fix this text by changing several others.
    expect(ANSWER_BODY_CSS).toMatch(/\.dag-node,\n\.dag-node strong,/);
    expect(ANSWER_BODY_CSS).toMatch(/overflow-wrap: anywhere/);
  });

  it('sets the identifier in mono, which is the second thing keeping it whole', () => {
    // The split is found in the stage id rather than by pattern, so a word that
    // merely looks like a tool name is left as prose.
    expect(nameParts('Called search_semantics', 'step-1-1-search_semantics')).toEqual([
      { text: 'Called ', mono: false },
      { text: 'search_semantics', mono: true },
    ]);
    expect(nameParts('Chose the next step', 'step-1')).toEqual([{ text: 'Chose the next step', mono: false }]);
    const markup = renderToStaticMarkup(<TraceDag stages={unlabelled} activeIndex={-1} />);
    expect(markup).toContain('class="answer-code semantic-inline-code dag-name-tool"');
    expect(markup).toContain('data-technical-entity="tool">search_semantics</code>');
    expect(rule('.trace-dag.map .dag-name-tool')).toMatch(/font-family: var\(--font-mono\)/);
  });

  it('keeps the whole name on the card, for a reader who only hovers', () => {
    const markup = renderToStaticMarkup(<TraceDag stages={unlabelled} activeIndex={-1} />);
    expect(markup).toContain('title="Called search_semantics"');
    expect(drawn(markup)).toEqual(['Chose the next step', 'Called search_semantics']);
  });

  it('does not lose the tool name that proved the vector index was in use', () => {
    // Step 2 of a live run showing `search_semantics` is how the semantic search
    // was confirmed to be running at all. Clamping the label must not be the thing
    // that takes it off the screen, so the panel spells it out in full.
    const markup = renderToStaticMarkup(<StageDetail stage={unlabelled[1]} step={2} origin={0} id="detail" />);
    expect(markup).toContain('search_semantics');
    expect(markup).toContain('<dt>Tool</dt>');
  });
});

/*
 * What a node opens.
 *
 * A card carries a chip, a number, a name and a duration, and the stage behind it
 * also carries the tool's real name, its offset into the run, the arguments it was
 * handed and what came back. Pressing the card shows those.
 *
 * The panel is rendered on its own here because the suite has no DOM to press a
 * button in. That is also why the toggle itself is read off the source.
 */
describe('a node opens what its stage recorded', () => {
  const genie = stage({
    id: 'step-3-1-data_genie',
    name: 'Queried governed data',
    kind: 'tool',
    depth: 1,
    start: 4210,
    duration: 8140,
    input: '{"question": "how many active players last week"}',
    output: 'label|value\nactive|1200',
  });

  it('makes every card on the map a button, and says whether it is open', () => {
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} />);
    expect(markup.match(/<button type="button" class="dag-node/g)).toHaveLength(run.length);
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(run.length + 1);
    // Nothing is open until the reader opens something.
    expect(markup).not.toContain('dag-detail');
  });

  it('presses closed again rather than trapping the reader in one step', () => {
    expect(SOURCE).toContain('current === item.id ? null : item.id');
  });

  it('holds the open step by id, not by position', () => {
    // Selecting a different run in the Explorer replaces the stage list under this
    // component. An index would then open whichever stage had moved into the slot.
    expect(SOURCE).toContain('displayedStages.findIndex((item) => item.id === openId)');
  });

  it('heads the panel with the step and its three measurements on one line', () => {
    // The handoff's arrangement, and it removes the two labelled rows a reader had
    // to scan a grid for. Asserted as the string as well as the absence, because
    // "no Started row" is only an improvement if the figure is still on screen.
    const markup = renderToStaticMarkup(<StageDetail stage={genie} step={6} origin={0} id="detail" />);
    expect(markup).toContain('Step 6 · ');
    expect(markup).toContain('started +4.21s · took 8.14s · 1 call');
    expect(markup).not.toContain('<dt>Started</dt>');
    expect(markup).not.toContain('<dt>Took</dt>');
    expect(rule('.trace-dag.map .dag-detail-measures')).toMatch(/margin-left: auto/);
    expect(detailTiming(stage({ id: 'plot', start: 0, duration: 400, calls: 3 }), 0)).toBe(
      'started +0.00ms · took 400ms · 3 calls'
    );
  });

  it('reads the arguments and the result the agent recorded', () => {
    const markup = renderToStaticMarkup(<StageDetail stage={genie} step={6} origin={0} id="detail" />);
    // "Asked", because the payload holds a question. A step handed a table name
    // and asked nothing keeps "Arguments" -- see the row below.
    expect(markup).toContain('<dt>Asked</dt>');
    expect(markup).toContain('<dt>Result</dt>');
    // Unwrapped into its keys, which is what turns a recorded payload back into
    // the question or the query it was. The reading is trace-payload.ts, shared
    // with the Timeline and the live step list.
    expect(markup).toContain('how many active players last week');
    expect(markup).toContain('active');
    // The question is a sentence and is drawn as one: the `question` key in front
    // of it was labelling the obvious.
    const asked = markup.slice(markup.indexOf('<dt>Asked</dt>'), markup.indexOf('<dt>Result</dt>'));
    expect(asked).not.toContain('<b>question</b>');
  });

  it('renders the answer chart inside the chart-building result as a static record', () => {
    const built = stage({
      id: 'plot',
      name: 'Built the charts',
      kind: 'tool',
      input: '1 tool result(s) to plot',
      output: 'Generated 1 chart.',
    });
    const markup = renderToStaticMarkup(
      <StageDetail
        stage={built}
        step={8}
        origin={0}
        id="detail"
        charts={[
          {
            id: 'chart-1',
            title: 'Bookings by title',
            kind: 'bar',
            data: [{ type: 'bar', x: ['A'], y: [12] }],
            layout: { xaxis: { title: 'Title' } },
          },
        ]}
      />
    );

    expect(markup).toContain('dag-result-charts');
    // The chart panel's own recipe, which is no longer `.chart-card`: that one is
    // the figure breakdown's, and the charted panel is a tinted surface with an
    // eyebrow instead of a card header. See styles/answer-charts.css.
    expect(markup).toContain('answer-chart-panel');
    expect(markup).toContain('answer-chart-eyebrow');
    // The agent's own title, and it is the whole of the head now: the chart-kind
    // badge that used to read "Bar chart" beside it has gone.
    expect(markup).toContain('Bookings by title');
    expect(markup).not.toContain('Bar chart');
    expect(rule('.trace-dag.map .dag-result-charts')).toMatch(/pointer-events: none/);
    expect(rule('.trace-dag.map .dag-result-charts')).toMatch(/user-select: none/);
  });

  it('explains when a stored chart step has no chart payload', () => {
    const built = stage({ id: 'plot', name: 'Built the charts', kind: 'tool', output: 'Generated 1 chart.' });
    const unavailable = renderToStaticMarkup(<StageDetail stage={built} step={8} origin={0} id="detail" />);
    const empty = renderToStaticMarkup(<StageDetail stage={built} step={8} origin={0} id="detail" charts={[]} />);

    expect(unavailable).toContain('The chart payload is unavailable for this stored run.');
    expect(empty).toContain('This step completed without a chart.');
  });

  it('names the row for what the step was given, and keeps "Arguments" when it was not asked', () => {
    const described = stage({
      id: 'step-2-1-describe_table',
      name: 'Called describe_table',
      kind: 'tool',
      input: '{"table": "silver_player_profiles"}',
      output: 'column|type\nplayer_id|string',
    });
    const searched = stage({
      id: 'step-2-1-search_semantics',
      name: 'Called search_semantics',
      kind: 'tool',
      input: '{"question": "players dataset player count", "kind": "table"}',
      output: 'nothing matched',
    });
    const wrote = stage({ id: 'step-7-agent', name: 'Prepared the findings', kind: 'agent', input: 'Evidence so far' });
    expect(renderToStaticMarkup(<StageDetail stage={described} step={2} origin={0} id="d" />)).toContain(
      '<dt>Arguments</dt>'
    );
    const search = renderToStaticMarkup(<StageDetail stage={searched} step={2} origin={0} id="d" />);
    expect(search).toContain('<dt>Searched for</dt>');
    // The filter is a chip beside the question rather than a second mono row: it
    // narrows the question, it is not another one.
    expect(search).toContain('tables only');
    expect(renderToStaticMarkup(<StageDetail stage={wrote} step={7} origin={0} id="d" />)).toContain(
      '<dt>Worked from</dt>'
    );
  });

  it('prints no character count above the arguments', () => {
    // The handoff is explicit about it, and the reason holds: the arguments are
    // short enough to read, so a count above them measures the display rather than
    // the run. The result's count stays, because a result can be two thousand
    // characters and how much there is decides whether to read it.
    const markup = renderToStaticMarkup(<StageDetail stage={genie} step={6} origin={0} id="detail" />);
    const args = markup.slice(markup.indexOf('<dt>Arguments</dt>'), markup.indexOf('<dt>Result</dt>'));
    expect(args).not.toMatch(/character/);
    expect(markup.slice(markup.indexOf('<dt>Result</dt>'))).toContain('characters');
  });

  it('offers Rendered and Raw as one segmented control, and opens on Rendered', () => {
    const markup = renderToStaticMarkup(<StageDetail stage={genie} step={6} origin={0} id="detail" />);
    expect(markup).toContain('aria-label="How to show this result"');
    expect(markup).toMatch(/<button type="button" aria-pressed="true">Rendered<\/button>/);
    // The size rides on the Raw segment, which is the only place it means
    // anything: it measures what pressing that button shows. Above a rendered
    // card it was the length of a payload the reader was no longer looking at.
    expect(markup).toMatch(/aria-pressed="false" title="2 lines · \d+ characters">Raw · 2 lines<\/button>/);
    // The app's one segmented treatment: an outlined group whose pressed segment
    // is filled from the shared token the timeline toggle also reads.
    const pressed = rule(".trace-dag.map .dag-seg button[aria-pressed='true']");
    expect(pressed).toMatch(/background: var\(--ast-seg-pressed\)/);
    expect(pressed).toMatch(/color: var\(--ast-seg-pressed-ink\)/);
  });

  it('draws a result that is a grid as a table, and one that is not as prose', () => {
    // A table printed as preformatted text is a table the reader has to align by
    // eye, which on a twenty-column `describe_table` is most of the work they
    // opened the step to do. The refusal is the important half: anything that is
    // not a consistent grid stays text, because half a table read as a table
    // silently drops the rows that did not parse.
    expect(describeResult('label|value\nactive|1200\nlapsed|0')).toMatchObject({
      kind: 'table',
      head: ['label', 'value'],
    });
    expect(describeResult('Two players matched.\n\nBoth are active.')).toEqual({
      kind: 'text',
      paragraphs: ['Two players matched.', 'Both are active.'],
    });
    expect(describeResult('label|value\nactive|1200\nbroken row').kind).toBe('text');
    const markup = renderToStaticMarkup(<StageDetail stage={genie} step={6} origin={0} id="detail" />);
    expect(markup).toContain('<th scope="col">label</th>');
  });

  it('does not paint Result as unanswered when the step already holds tables', () => {
    const tables = ['90-day headline totals:', '', '| Title | Players |', '| VLH Online | 9575 |'].join('\n');
    const markup = renderToStaticMarkup(
      <StageDetail
        stage={stage({
          id: 'synthesis',
          name: 'Prepared the answer',
          status: 'failed',
          input: tables,
          output: 'This question was not answered.',
        })}
        step={17}
        origin={0}
        id="detail"
      />
    );
    expect(markup).not.toContain('This question was not answered.');
    expect(markup).toContain('The run reached its time limit before the answer could be composed.');
    expect(markup).toContain('characters');
  });

  it('does not mark Prepared the answer partial when the run is Complete', () => {
    const markup = renderToStaticMarkup(
      <TraceDag
        stages={[stage({ id: 'synthesis', name: 'Prepared the answer', status: 'partial' })]}
        activeIndex={-1}
        verdict="complete"
      />
    );
    expect(markup).toContain('Prepared the answer');
    expect(markup).toContain('dag-node complete');
    expect(markup).not.toContain('dag-node partial');
  });

  it('keeps Prepared the answer partial when the write actually stopped short', () => {
    const markup = renderToStaticMarkup(
      <TraceDag
        stages={[stage({ id: 'synthesis', name: 'Prepared the answer', status: 'partial' })]}
        activeIndex={-1}
        verdict="partial"
      />
    );
    expect(markup).toContain('dag-node partial');
  });

  it('marks the rows with something to report, and folds the ones without', () => {
    // Derived from the numbers rather than from any knowledge of what the table is:
    // a table with nothing at zero has no findings to mark, because then every row
    // would be marked and the tint would say nothing.
    const scan = describeResult(
      ['column|null_rate', 'player_id|4.20', 'region|0.00', 'tier|0.00', 'plan|0.00', 'seat|0.00'].join('\n')
    );
    expect(scan).toMatchObject({ kind: 'table' });
    if (scan.kind !== 'table') throw new Error('unreachable');
    expect(scan.rows.map((row) => row.finding)).toEqual([true]);
    expect(scan.tail).toEqual({ count: 4, value: '0.00' });
    // A wash with a deep-enough rung on it as type, never the hue as type. The
    // family it names has moved with the palette and not only its hex: it was
    // DuBois' amber, #FFF9EB under #BE501E, and #BE501E is an orange, which this
    // palette does not have. Warning is #8A6A38 on #F9F6EF at 5.24:1, and it is
    // the same three values the guardrail chip below takes.
    expect(rule('.trace-dag.map .dag-result-table tr.finding')).toMatch(/background: var\(--ast-warn-fill\)/);
    expect(rule('.trace-dag.map .dag-result-table tr.finding td:last-child')).toMatch(/color: var\(--ast-warn-text\)/);
  });

  it('never folds a table that is uniform the whole way down', () => {
    // Collapsing that would leave the reader a count and no data: it is not a tail,
    // it is a single value.
    const flat = describeResult(['column|null_rate', 'a|0.00', 'b|0.00', 'c|0.00', 'd|0.00'].join('\n'));
    if (flat.kind !== 'table') throw new Error('unreachable');
    expect(flat.tail).toBeNull();
    expect(flat.rows).toHaveLength(4);
  });

  it('omits child argument and result rows the run recorded nothing for', () => {
    const markup = renderToStaticMarkup(
      <StageDetail stage={stage({ id: 'step-1' })} step={1} origin={0} id="detail" />
    );
    expect(markup).not.toContain('<dt>Worked from</dt>');
    expect(markup).not.toContain('<dt>Result</dt>');
    expect(markup).not.toContain('(none recorded)');
  });

  it('keeps only the child fields that contain real evidence', () => {
    const inputOnly = renderToStaticMarkup(
      <StageDetail
        stage={stage({ id: 'step-1', input: 'Choose the next governed step', output: '' })}
        step={1}
        origin={0}
        id="input"
      />
    );
    expect(inputOnly).toContain('<dt>Worked from</dt>');
    expect(inputOnly).not.toContain('<dt>Result</dt>');

    const resultOnly = renderToStaticMarkup(
      <StageDetail
        stage={stage({ id: 'step-1-1-run_sql', kind: 'tool', input: '', output: 'count|value\nplayers|12' })}
        step={2}
        origin={0}
        id="result"
      />
    );
    expect(resultOnly).not.toContain('<dt>Arguments</dt>');
    expect(resultOnly).toContain('<dt>Result</dt>');
    expect(resultOnly).toContain('<td>12</td>');
  });

  it('says a start was not recorded rather than printing it as zero', () => {
    // The same rule the Timeline follows, for the same reason `startMeasured`
    // exists: a missing start and a start of zero arrive as the same number, and
    // the first stage of every run legitimately starts at zero.
    const markup = renderToStaticMarkup(
      <StageDetail stage={stage({ id: 'step-1', startMeasured: false })} step={1} origin={0} id="detail" />
    );
    expect(markup).toContain('start not recorded');
    expect(markup).not.toContain('started +0');
  });

  it('claims no token count, because the agent meters those per run', () => {
    // A run's total attributed to whichever step the reader happened to open would
    // be a measurement of something else printed under this step's name.
    const markup = renderToStaticMarkup(<StageDetail stage={genie} step={6} origin={0} id="detail" />);
    expect(markup.toLowerCase()).not.toContain('token');
  });

  it('gives the panel a row of the grid rather than a place in a column', () => {
    // A card's worth of width cannot hold a SQL statement, and a panel spliced in
    // after the card that opened it would leave the rest of that row empty and
    // shift every later step into a different column.
    expect(rule('.trace-dag.map .dag-detail')).toMatch(/grid-column: 1 \/ -1/);
  });

  it('marks the open card with the handoff’s blue edge, and pays for its width', () => {
    const open = rule('.trace-dag.map .dag-node.open');
    expect(open).toMatch(/border: 2px solid var\(--primary\)/);
    expect(open).toMatch(/background: var\(--db-blue-faint\)/);
    // A pixel off each side, so a 2px border on an 11px padding does not make the
    // open card a pixel taller than its neighbours in the same row.
    expect(px(open, 'padding')).toBe(px(rule('.trace-dag.map .dag-node'), 'padding')! - 1);
    // The number and the duration go to the hover rung of the same blue, which
    // marks the open card's own figures without painting its name.
    const figures = rules().filter(({ selector }) => /\.dag-node\.open \.dag-(index|metric-badge)$/.test(selector));
    expect(figures).toHaveLength(2);
    expect(figures.every(({ body }) => /color: var\(--db-blue-700\)/.test(body))).toBe(true);
  });

  it('starts a different step on Rendered rather than on the last step’s segment', () => {
    // The panel keeps which segment is showing, and the panel is one element in one
    // position: without a key, opening a second step would inherit the first
    // step's choice, and a reader who had looked at one raw payload would be shown
    // raw text for everything after it.
    expect(SOURCE).toMatch(/<StageDetail\s+key=\{open\.id}/);
  });

  it('draws a focus ring inside the card, because the clip edge is its right edge', () => {
    const focus = rule('.trace-dag.map .dag-node:focus-visible');
    expect(focus).toMatch(/outline: 2px solid var\(--db-blue-600\)/);
    expect(focus).toMatch(/outline-offset: -2px/);
  });
});

/*
 * A step that did not finish.
 */
describe('a failed step keeps its card', () => {
  const failed = stage({
    id: 'step-4-1-data_genie',
    name: 'Queried governed data',
    kind: 'tool',
    status: 'failed',
    output: 'AnalysisException: cannot resolve `plyer_id`\n  at line 3',
  });

  it('draws the card in red, duration included, rather than dropping it', () => {
    // Dropping it would leave the run's numbering with a hole in it and no
    // explanation of the hole.
    expect(rule('.dag-node.failed')).toMatch(/border-color: var\(--db-red-600\)/);
    expect(rule('.trace-dag.map .dag-node.failed .dag-duration-badge')).toMatch(/color: var\(--db-red-600\)/);
    const markup = renderToStaticMarkup(<TraceDag stages={[failed]} activeIndex={-1} />);
    expect(markup).toContain('class="dag-node failed');
    expect(drawn(markup)).toEqual(['Queried governed data']);
  });

  it('quotes the server verbatim, and offers the record’s own reference', () => {
    // The handoff asks for a correlation id and the agent writes none, so the
    // reference is the stage's own id -- the only handle the record carries for
    // finding this step again. Inventing an id would be worse than naming the one
    // that exists.
    const markup = renderToStaticMarkup(<StageDetail stage={failed} step={7} origin={0} id="detail" />);
    expect(markup).toContain('<dt>Ended</dt>');
    expect(markup).toContain('<dt>Reference</dt>');
    expect(markup).toContain('step-4-1-data_genie');
    // Raw, not Rendered: an error message is neither prose nor a grid, and putting
    // one through a renderer is where a stack trace loses the line breaks that make
    // it legible.
    expect(markup).toMatch(/aria-pressed="true" title="[^"]*characters">Raw/);
    expect(markup).toContain('AnalysisException: cannot resolve `plyer_id`');
  });
});

/*
 * The statement a step generated, and the run's payloads underneath it.
 */
describe('the generated SQL block', () => {
  const query = stage({
    id: 'step-5-1-run_sql',
    name: 'Queried governed data',
    kind: 'tool',
    input: JSON.stringify({ sql: '\nSELECT\n  ROUND(SUM(spend), 2) AS total\nFROM sales\n' }),
    output: 'total\n42',
  });

  it('heads the block with its line count and a copy control', () => {
    const markup = renderToStaticMarkup(<StageDetail stage={query} step={5} origin={0} id="detail" />);
    expect(markup).toContain('<strong>Generated SQL</strong>');
    expect(markup).toContain('3 lines');
    expect(markup).toContain('aria-label="Copy the generated SQL"');
    expect(px(rule('.trace-dag.map .dag-sql-copy'), 'width')).toBe(24);
  });

  it('drops the leading blank the agent’s own payload opens on', () => {
    // The recorded value is `"\nSELECT\n..."`, so printing it as-is opens the block
    // on an empty line and puts the line count one over.
    expect(sqlLines('\nSELECT 1\nFROM t\n')).toEqual(['SELECT 1', 'FROM t']);
  });

  it('picks out the keywords the handoff lists, and nothing inside a name', () => {
    // Longest first is load-bearing rather than tidy: an alternation matches the
    // first branch that fits, so a bare `END` ahead of `CASE WHEN` would leave
    // `WHEN` uncoloured in the middle of a coloured pair.
    expect(sqlTokens('SELECT count_of_players FROM t')).toEqual([
      { text: 'SELECT', keyword: true },
      { text: ' count_of_players ', keyword: false },
      { text: 'FROM', keyword: true },
      { text: ' t', keyword: false },
    ]);
    expect(sqlTokens('CASE WHEN x IS NULL THEN 0 ELSE 1 END').filter((token) => token.keyword)).toEqual([
      { text: 'CASE WHEN', keyword: true },
      { text: 'IS NULL', keyword: true },
      { text: 'THEN', keyword: true },
      { text: 'ELSE', keyword: true },
      { text: 'END', keyword: true },
    ]);
    // #0E538B at 500, which the detail spec names for the keywords by value.
    expect(rule('.trace-dag.map .dag-sql-body pre b')).toMatch(/color: var\(--ast-info-text\)/);
  });

  it('clamps a long statement and offers the way past the clamp, rather than scrolling', () => {
    // A scroller here is the same defect this map was rebuilt out of, one axis
    // over: content parked outside a box nothing announces as scrollable.
    const body = rule('.trace-dag.map .dag-sql-body');
    expect(px(body, 'max-height')).toBe(196);
    expect(body).toMatch(/overflow: hidden/);
    expect(rule('.trace-dag.map .dag-sql.open .dag-sql-body')).toMatch(/max-height: none/);
    const long = stage({
      ...query,
      input: JSON.stringify({ sql: `SELECT\n${'  col,\n'.repeat(11)}FROM sales` }),
    });
    const markup = renderToStaticMarkup(<StageDetail stage={long} step={5} origin={0} id="detail" />);
    expect(markup).toContain('Show all 13 lines');
  });

  it('offers no way past a clamp that is not clamping anything', () => {
    // A fade and a "show all" over a statement that already fits is a control that
    // does nothing, drawn on top of the last line it is pretending to hide.
    const markup = renderToStaticMarkup(<StageDetail stage={query} step={5} origin={0} id="detail" />);
    expect(markup).not.toContain('Show all');
    expect(markup).toContain('class="dag-sql open"');
  });

  it('does not also print the statement among the arguments', () => {
    // One statement twice on one panel is worse than either placement alone. The
    // field is named rather than sniffed for keywords, so a question containing the
    // word "select" is never promoted into a SQL block.
    const markup = renderToStaticMarkup(<StageDetail stage={query} step={5} origin={0} id="detail" />);
    const args = markup.slice(markup.indexOf('<dt>Arguments</dt>'), markup.indexOf('<dt>Result</dt>'));
    expect(args).not.toContain('sales');
    // Once, in the block below. Counted on a word the tokeniser keeps whole rather
    // than on a phrase it splits into a keyword and a name.
    expect(markup.match(/sales/g)).toHaveLength(1);
    expect(SOURCE).toContain("field.key === 'sql' || field.key === 'query'");
  });

  it('copies the full sanitized statement rather than the clamped fragment on screen', () => {
    // Token markup and the clamp are presentation only. Comments and
    // credential-shaped literals still cannot ride the copy path.
    expect(SOURCE).toContain('navigator.clipboard?.writeText(safeSql)');
  });
});

describe('the run’s raw payloads, behind one row', () => {
  it('says how much there is, and shows none of it until asked', () => {
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} />);
    expect(markup).toContain('<span class="dag-raw-label">Raw I/O</span>');
    expect(markup).toContain('request and response of every stage');
    expect(markup).toContain('aria-expanded="false"');
    // The JSON itself is not in the markup at all, which is stronger than hiding
    // it: several hundred lines of payload are not shipped to be styled away.
    expect(markup).not.toContain('"request"');
  });

  it('carries every stage, in run order, and invents no field', () => {
    const io = rawIo(run);
    const parsed = JSON.parse(io.text) as { step: number; name: string; request: string; response: string }[];
    expect(parsed).toHaveLength(run.length);
    expect(parsed.map((entry) => entry.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parsed.map((entry) => entry.name)).toEqual(run.map((item) => item.name));
    expect(Object.keys(parsed[0])).toEqual(['step', 'name', 'request', 'response']);
    expect(io.lines).toBe(io.text.split('\n').length);
  });

  it('caps the one block that cannot be sized to its content', () => {
    // Everything else in the panel is short enough to print whole, which the
    // handoff asks for. This is the exception and it is capped where it is used
    // rather than on the shared block rule.
    expect(rule('.trace-dag.map .dag-block')).not.toMatch(/max-height/);
    expect(px(rule('.trace-dag.map .dag-raw .dag-block'), 'max-height')).toBe(320);
  });

  it('spans the grid rather than sitting in a column of it', () => {
    expect(rule('.trace-dag.map .dag-raw')).toMatch(/grid-column: 1 \/ -1/);
  });
});

/*
 * The rail, which is the same component in a narrow column.
 *
 * Every assertion here failed in the live app after the map learnt to wrap, and
 * none of them was expressible against the map: this is the half of the pair that
 * was missing. It is also the half that has now been broken twice, so it is
 * written as a positive description of the pane rather than as a list of the map's
 * declarations it happens not to inherit.
 */
describe('the narrow rail is one column of every step', () => {
  it('is a single column, with no second axis anywhere in its own rules', () => {
    // THE REGRESSION THIS PINS. Fixing the map broke this pane into a mangled grid
    // twice: once through a flex basis read as a height, and the arrangement is
    // now a fixed four-track grid, which read as four ROWS in a column would be
    // the same failure again. So the claim is not "the rail overrides the grid" --
    // it is that no rule scoped to the rail declares a grid, a wrap or a track at
    // all, whatever the map goes on to declare.
    const compact = rule('.trace-dag.compact');
    expect(compact).toMatch(/display: flex/);
    expect(compact).toMatch(/flex-direction: column/);
    // The container itself: a column, with no wrap and no track list. Everything
    // that put more than one card on a line came through one of those two.
    expect(compact).not.toMatch(/flex-wrap|grid/);
    // And nothing scoped to the rail may reintroduce either. `repeat(` is named
    // because the map's arrangement is a repeated track and a repeated track in a
    // column is a set of ROWS -- the same class of mistake as the flex basis, one
    // property along. The rail's own tile is a fixed two-track grid, an icon
    // beside a name, which is neither a wrap nor a repetition; it is asserted by
    // name further down rather than allowed by omission here.
    const railRules = rules().filter(({ selector }) => selector.includes('.compact'));
    expect(railRules.length).toBeGreaterThan(6);
    expect(
      railRules
        .filter(({ body }) => /flex-wrap|repeat\(|minmax\(|column-gap|row-gap/.test(body))
        .map(({ selector }) => selector)
    ).toEqual([]);
  });

  it('draws every stage the run reported, in the run’s order, one after another', () => {
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} compact />);
    expect(markup.match(/class="dag-node/g)).toHaveLength(run.length);
    expect(markup.match(/class="dag-edge /g)).toHaveLength(run.length - 1);
    expect(drawn(markup)).toEqual(run.map((item) => item.name));
    // Consecutive: every step is a direct child of the container in run order, so
    // there is nothing between two steps but the edge that joins them. Matched
    // without the closing bracket because a nested step carries its indent as an
    // inline custom property.
    expect(markup.match(/<div class="dag-step"/g)).toHaveLength(run.length);
    expect(markup.indexOf('dag-node')).toBeGreaterThan(markup.indexOf('dag-step'));
  });

  it('keeps the constellation up after the run, rather than substituting the list for it', () => {
    // THE REPORTED FAULT: "after the query ends, the live agent constellation path
    // is substituted out for the old one". The band was drawn only while
    // `activeIndex` named a step in progress, and the caller sets that to -1 the
    // instant the answer lands -- so the drawing a reader watched their run through
    // disappeared at the moment the run became a thing to read back, leaving the
    // plain tiles that had been underneath it all along.
    const settled = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} compact />);
    expect(settled).toContain('ast-sky-path');
    // The same band, not a second drawing of it: one sky, and the tiles still under
    // it, which is what makes a step openable from the run's own shape.
    expect(settled.match(/class="ast-sky ast-sky-path"/g)).toHaveLength(1);
    expect(settled.indexOf('ast-sky-path')).toBeLessThan(settled.indexOf('trace-dag compact'));
    expect(settled.match(/class="dag-node/g)).toHaveLength(run.length);
    // At rest, and that is the caller's word rather than this component's: -1 means
    // no step is in progress, so nothing draws, nothing pulses and nothing counts.
    expect(settled).not.toContain('ast-anim');
    expect(settled).not.toMatch(/ast-sky-status-elapsed/);
  });

  it('does not sample four stages and drop the rest', () => {
    // What the pane was doing, unnoticed until the nodes were numbered: four
    // evenly spread stages, so the reader was shown 1, 4, 7 and 10 of a ten-step
    // run with no indication the other six existed. live.css records the same
    // defect as the reason the live step list stopped using this rail.
    const long = Array.from({ length: 21 }, (_, index) => stage({ id: `step-${index}`, name: `Step ${index + 1}` }));
    const markup = renderToStaticMarkup(<TraceDag stages={long} activeIndex={-1} compact />);
    expect(markup.match(/class="dag-node/g)).toHaveLength(21);
    expect(drawn(markup)).toEqual(long.map((item) => item.name));
  });

  it('holds each step at the height of the card in it', () => {
    // The defect, exactly: a flex basis is a height in a column, so the map's
    // 190px basis drew a 190px box around a 60px card and the pane became four
    // cards with a card's worth of gap under each. The basis is gone from both
    // arrangements now, and the rail still states its own height.
    expect(rule('.trace-dag.compact .dag-step')).toMatch(/flex: 0 0 auto/);
    expect(rule('.dag-step')).not.toMatch(/flex: \d+ \d+ \d+px/);
  });

  it('takes no arrangement from a rule that names neither arrangement', () => {
    // The general form of the same bug. Anything that positions or sizes belongs
    // under `.map` or `.compact`; a bare rule is inherited by both, and the two
    // run on different axes.
    expect(rule('.trace-dag')).not.toMatch(/flex-wrap|flex-direction|row-gap/);
    expect(rule('.dag-edge')).not.toMatch(/width|padding|content/);
    expect(rule('.dag-node')).not.toMatch(/display|padding|gap/);
  });

  it('takes none of the map’s geometry, and is not clipped by it', () => {
    // The map's rebuild is scoped the way the first attempt should have been: every
    // rule that gives the grid its shape names `.map`. This is the assertion that
    // would have caught the original leak, generalised to the new geometry. Four
    // declarations describe the wide arrangement and nothing else: the track that
    // may shrink to nothing, the clip that eats the last arrow of a row, the fill
    // that squares a row's heights, and the offset that puts an arrow in a gutter.
    // A column has no tracks, no gutters and one card per row, so each of these is
    // wrong there -- and one of them, read as a height, is the bug that emptied
    // the rail out last time.
    const mapOnly = /minmax\(0, 1fr\)|overflow-x|height: 100%|left: 100%/;
    const leaked = rules().filter(({ selector, body }) => mapOnly.test(body) && !selector.includes('.map'));
    expect(leaked.map(({ selector }) => selector)).toEqual([]);

    // Scoped by name as well as by declaration, so a later rule added to the panel,
    // the chip's line or the result table cannot land somewhere the rail reads it.
    // The chip is the one shared name: it is 22px square in the map's card and the
    // rail draws its own 13px mark instead, so its size may be stated once.
    //
    // `dag-name` is NOT in this list, and that is the one deliberate omission: both
    // panes print a stage name and both must stop an identifier breaking mid-word,
    // so each declares its own rule for it. They are asserted separately below --
    // the map clamps at two lines, the rail keeps one.
    const mapParts =
      /dag-detail|dag-card-head|dag-index|dag-timing|dag-result|dag-seg|dag-sql|dag-raw|dag-block|dag-arg|dag-clipped/;
    const wide = rules().filter(({ selector }) => mapParts.test(selector));
    expect(wide.length).toBeGreaterThan(20);
    expect(wide.filter(({ selector }) => !selector.includes('.map')).map(({ selector }) => selector)).toEqual([]);
    // And the rail's own parts are scoped just as tightly the other way, so the
    // map cannot inherit a 20px badge into a card that has no track for it.
    const railParts = /dag-num|dag-mark|dag-elapsed/;
    const narrow = rules().filter(({ selector }) => railParts.test(selector));
    expect(narrow.length).toBeGreaterThan(5);
    expect(narrow.filter(({ selector }) => !selector.includes('.compact')).map(({ selector }) => selector)).toEqual([]);

    expect(rule('.trace-dag.compact')).toMatch(/overflow: visible/);
  });

  it('carries none of the map’s furniture', () => {
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} compact />);
    // The rail numbers its own steps now, but with its own badge: the map's index,
    // card head, kind chip and raw-payload row are the map's parts and stay there.
    expect(markup).not.toContain('dag-index');
    expect(markup).not.toContain('dag-chip');
    expect(markup).not.toContain('dag-card-head');
    expect(markup).not.toContain('dag-raw');
  });

  it('numbers every step, two digits, the same numbers the map prints', () => {
    // The design asks a reader to carry a step number between the two panes, so
    // both take it from `stepNumber` over the same list rather than counting for
    // themselves. Numbers are per-run and stable: nothing here renumbers.
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} compact />);
    const numbers = [...markup.matchAll(/<span class="dag-num ast-num [a-z]+">(\d+)<\/span>/g)].map((one) => one[1]);
    expect(numbers).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
    const wide = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} />);
    expect(
      [...wide.matchAll(/<span class="dag-index ast-num (?:agent|tool)">(\d+)<\/span>/g)].map((one) => one[1])
    ).toEqual(numbers);
  });

  it('fills the number badge by kind, warm for a decision and washed for a call', () => {
    // The badge's fill is the same two-fill distinction the map's chip makes: the
    // glyph says WHICH tool, the fill says whether the agent was deciding or
    // calling something.
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} compact />);
    expect([...markup.matchAll(/class="dag-num ast-num (\w+)"/g)].map((one) => one[1])).toEqual([
      'agent',
      'tool',
      'agent',
      'tool',
      'agent',
      'tool',
      'tool',
      'agent',
    ]);
    expect(rule('.trace-dag.compact .dag-num.agent')).toMatch(/background: var\(--ast-ice\)/);
    expect(rule('.trace-dag.compact .dag-num.tool')).toMatch(/background: var\(--db-wash\)/);
    expect(rule('.trace-dag.compact .dag-num')).toMatch(/font-family: var\(--font-mono\)/);
    expect(rule('.trace-dag.compact .dag-num')).toMatch(/font-variant-numeric: tabular-nums/);
  });

  it('marks an agent step with the mark the map chips it with, and no robot', () => {
    // The rail carried a lucide Bot, then the shared robot, and now the mark: §1
    // makes the mark the agent and §9 retires the robot outright. What has not
    // changed across all three is the property this asserts -- ONE drawing, shared
    // with the map's kind chip, because a reader who saw a different figure in the
    // two panes had no way to know they meant the same thing.
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} compact />);
    expect(markup.match(/class="dag-mark agent"/g)).toHaveLength(4);
    // `--light` is part of the claim rather than noise in it: the ink is a class
    // on the mark, so a seat that forgot to say which surface it is on renders
    // the navy-band cut on a white rail and this catches it.
    expect(markup).toContain('class="ast-mark ast-mark--light"');
    expect(markup).not.toContain('pia-robot');
    expect(/^import \{[^}]*\} from 'lucide-react';$/m.exec(SOURCE)?.[0]).not.toMatch(/\bBot\b/);
    // No colour on the agent mark's own rule, at all. A `stroke` or a `color` here
    // would be a second astrolabe blue that no palette check reaches;
    // `astrolabe-mark.css` is the one file that chooses the ink, off the class the
    // `ink` prop puts on the drawing.
    expect(rule('.trace-dag.compact .dag-mark.agent')).toBe('');
    expect(rule('.trace-dag.compact .dag-mark.tool > svg')).toMatch(/color: var\(--db-slate-icon\)/);
  });

  it('gives each tool family its own glyph, keyed on the tool’s real name', () => {
    // Search for the semantic lookups, a wrench for the definition reads, a
    // database for a governed query. Decided in agent-map.ts so it can be checked
    // without a DOM, and keyed on the name agent.py writes into the stage id, so
    // one tool cannot be filed under two marks.
    expect(railGlyph({ id: 'step-1', kind: 'agent' })).toBe('agent');
    expect(railGlyph({ id: 'step-1-1-search_semantics', kind: 'tool' })).toBe('search');
    expect(railGlyph({ id: 'step-1-1-search_tagged_assets', kind: 'tool' })).toBe('search');
    expect(railGlyph({ id: 'step-1-1-dictionary_genie', kind: 'tool' })).toBe('wrench');
    expect(railGlyph({ id: 'step-1-1-describe_table', kind: 'tool' })).toBe('wrench');
    expect(railGlyph({ id: 'step-1-1-data_genie', kind: 'tool' })).toBe('database');
    expect(railGlyph({ id: 'step-1-1-run_sql', kind: 'tool' })).toBe('database');
    // A tool nobody has mapped keeps the wrench rather than being guessed at.
    expect(railGlyph({ id: 'step-1-1-a_new_tool', kind: 'tool' })).toBe('wrench');
    expect(railGlyph({ id: 'plot', kind: 'tool' })).toBe('wrench');
  });

  it('pins the duration right and prints no call count beside it', () => {
    // The design's instruction, and the reading that matches the pane: a step that
    // made three calls shows the three as its own indented children, each
    // numbered, so "· 3 calls" on the parent counted them a second time.
    const markup = renderToStaticMarkup(
      <TraceDag stages={[stage({ id: 'step-1', duration: 478, calls: 3 })]} activeIndex={-1} compact />
    );
    expect(markup).toContain('<span class="dag-elapsed ast-num">478ms</span>');
    expect(markup).not.toContain('call');
    expect(railTiming({ duration: 478, status: 'complete' })).toBe('478ms');
    expect(railTiming({ duration: 18094, status: 'complete' })).toBe('18.09s');
    expect(rule('.trace-dag.compact .dag-elapsed')).toMatch(/font-variant-numeric: tabular-nums/);
  });

  it('indents a tool call one level under the step that called it', () => {
    // The relation is carried by the indent and the connector and by nothing else:
    // the words "calls" and "then" that used to sit between the cards are gone.
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} compact />);
    expect(markup.match(/style="--dag-depth:1"/g)).toHaveLength(3);
    expect(markup).not.toContain('>calls<');
    expect(markup).not.toContain('>then<');
    expect(railLane(0)).toBe(RAIL_LANE);
    expect(railLane(1)).toBe(RAIL_LANE + RAIL_INDENT);
  });

  it('draws the relation between two cards as one of three shapes', () => {
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} compact />);
    // The run alternates decision and nested call three times, then finishes with
    // the chart and the write-up at the left edge -- so out, back, three times
    // over, and one straight drop between the two last cards.
    expect([...markup.matchAll(/class="dag-edge (\w+)"/g)].map((one) => one[1])).toEqual([
      'out',
      'back',
      'out',
      'back',
      'out',
      'back',
      'down',
    ]);
    // Static paths, so the arrowheads stay crisp at any zoom, and decorative: the
    // shape restates an indent a reader can already see.
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toMatch(/stroke-width="1\.5"/);
    expect(markup).toMatch(/stroke-linecap="round"/);
    expect(rule('.trace-dag.compact .dag-edge')).toMatch(/color: var\(--db-connector\)/);
    expect(rule('.trace-dag.compact .dag-edge')).toMatch(/height: 16px/);
  });

  it('starts every connector on a badge, in the rail’s own coordinates', () => {
    // The arithmetic, rather than the picture: an elbow out leaves the decision's
    // lane and arrives in the indented one, an elbow back does the reverse and
    // turns down into the left edge, and a sibling drop stays in one lane.
    const out = railConnector(0, 1);
    expect(out.shape).toBe('out');
    expect(out.line).toBe(`M${railLane(0)} 1V8H${railLane(1)}`);
    const back = railConnector(1, 0);
    expect(back.shape).toBe('back');
    expect(back.line).toBe(`M${railLane(1)} 1V8H${railLane(0)}V15`);
    const down = railConnector(1, 1);
    expect(down.shape).toBe('down');
    expect(down.line).toBe(`M${railLane(1)} 1V15`);
    // Every head fits inside the box it is drawn in, which is what stops an
    // arrowhead being clipped to a flat edge.
    for (const connector of [out, back, down]) {
      const xs = [...connector.head.matchAll(/[ML]([\d.]+) /g)].map((one) => Number(one[1]));
      expect(Math.max(...xs)).toBeLessThanOrEqual(connector.width);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    }
    // A connector leaving an indented card sheds that card's indent again, from
    // the same custom property the indent came from: the paths above are measured
    // from the pane's left edge, not from the step's.
    expect(rule('.trace-dag.compact .dag-edge')).toMatch(
      new RegExp(`margin-left: calc\\(var\\(--dag-depth, 0\\) \\* -${RAIL_INDENT}px\\)`)
    );
  });

  it('lands the lanes on the numbers live-agent-path.md names, not on its own', () => {
    /*
     * The assertions above are written in terms of `railLane`, so they hold
     * whatever `railLane` returns: move `RAIL_LANE` to 21 and every one of them
     * still passes while every connector in the pane misses the badge it is
     * supposed to start under. The document gives two literals -- "19px from the
     * left" for a decision's badge and "45px for tool calls" -- and those are what
     * the drawing has to agree with, so they are written out here as numbers.
     */
    expect(railLane(0)).toBe(19);
    expect(railLane(1)).toBe(45);
  });

  it('points each arrowhead the way the shape is supposed to travel', () => {
    /*
     * The direction, which nothing checked. An elbow out reaches ACROSS into the
     * indented card and its head points right; a sibling drop and an elbow back
     * both arrive from above and point down. Every head here is three points and
     * the middle one is the tip, so the claim is that the tip is beyond both
     * wings on the axis the shape travels -- which stays true if the head is ever
     * redrawn at a different size, and fails if one is pasted from another shape.
     */
    const tip = (head: string) => [...head.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((p) => [+p[1], +p[2]]);
    for (const [from, to] of [
      [0, 1],
      [1, 2],
      [0, 2],
    ]) {
      const [left, apex, right] = tip(railConnector(from, to).head);
      expect(apex[0], `out ${from}->${to} tip is right of both wings`).toBeGreaterThan(left[0]);
      expect(apex[0]).toBeGreaterThan(right[0]);
    }
    for (const [from, to] of [
      [1, 0],
      [1, 1],
      [0, 0],
      [2, 1],
      [2, 0],
    ]) {
      const [left, apex, right] = tip(railConnector(from, to).head);
      expect(apex[1], `${from}->${to} tip is below both wings`).toBeGreaterThan(left[1]);
      expect(apex[1]).toBeGreaterThan(right[1]);
    }
  });

  it('keeps the whole stroke inside the connector row, at every depth', () => {
    /*
     * THE HALF-WIDTH IS THE POINT. An SVG path is the CENTRE of its stroke, so a
     * 1.5px line drawn on y=16 in a 16px box is clipped to 15.25 and the round cap
     * the document asks for arrives flat. That is why the paths run 1 to 15 rather
     * than 0 to 16, and nothing said so: the existing check reads the head's x
     * only, on three connectors, at one depth.
     *
     * Read at depth 2 as well, because a nested tool call is a real arrangement
     * and the width is computed rather than fixed -- `Math.max(from, to) + 6` has
     * to keep covering a head that sticks 3.5 past its own lane.
     */
    const STROKE = 1.5;
    for (const from of [0, 1, 2]) {
      for (const to of [0, 1, 2]) {
        const connector = railConnector(from, to);
        const points: number[][] = [];
        let x = 0;
        let y = 0;
        for (const move of [...connector.line.matchAll(/([MLVH])([\d.]+)(?: ([\d.]+))?/g)]) {
          if (move[1] === 'M' || move[1] === 'L') {
            x = Number(move[2]);
            y = Number(move[3]);
          } else if (move[1] === 'V') {
            y = Number(move[2]);
          } else {
            x = Number(move[2]);
          }
          points.push([x, y]);
        }
        for (const point of connector.head.matchAll(/[ML]([\d.]+) ([\d.]+)/g)) {
          points.push([Number(point[1]), Number(point[2])]);
        }
        const where = `${from}->${to} (${connector.shape})`;
        const xs = points.map((point) => point[0]);
        const ys = points.map((point) => point[1]);
        expect(Math.min(...xs) - STROKE / 2, `${where} clears the left edge`).toBeGreaterThanOrEqual(0);
        expect(Math.max(...xs) + STROKE / 2, `${where} clears the right edge`).toBeLessThanOrEqual(connector.width);
        expect(Math.min(...ys) - STROKE / 2, `${where} clears the top`).toBeGreaterThanOrEqual(0);
        expect(Math.max(...ys) + STROKE / 2, `${where} clears the bottom`).toBeLessThanOrEqual(RAIL_CONNECTOR_HEIGHT);
      }
    }
  });

  it('strokes them in the grey the document names, at the width it names', () => {
    // #A6A6A6, 1.5px, round caps. The colour is a token rather than a literal, so
    // the literal is checked where the token is defined. `--db-*` is not a retired
    // spelling here: palette.test.ts keeps that prefix live through the migration,
    // and this grey is not one of the colours the astrolabe palette moved.
    expect(TOKENS).toMatch(/--db-connector:\s*#a6a6a6/i);
    expect(rule('.trace-dag.compact .dag-edge')).toMatch(/color: var\(--db-connector\)/);
    expect(rule('.trace-dag.compact .dag-edge')).toMatch(new RegExp(`height: ${RAIL_CONNECTOR_HEIGHT}px`));
  });

  it('marks the step the agent is inside, and only while a run is in flight', () => {
    const live = renderToStaticMarkup(<TraceDag stages={run} activeIndex={run.length - 1} compact />);
    expect(live.match(/class="dag-node complete active"/g)).toHaveLength(1);
    // Exactly one, and it is the last card the run reported.
    expect(live.lastIndexOf('active')).toBeGreaterThan(live.lastIndexOf('dag-num agent') - 200);
    expect(renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} compact />)).not.toContain('active');
    // §2 removes orange from the palette and makes agent-at-work blue, so this is
    // `#12ar`'s own treatment: a 1px blue border on Ice. A hairline suffices where
    // the orange had to be a 2px mass -- blue is 4.6:1 on white against orange's
    // 3.62:1 -- and a BORDER rather than an outline because an outline is drawn
    // outside the box, so at 2px it overlapped the cards above and below it.
    expect(rule('.dag-node.active')).toMatch(/border-color: var\(--ast-blue\)/);
    expect(rule('.dag-node.active')).toMatch(/background: var\(--ast-ice\)/);
    expect(rule('.dag-node.active')).not.toMatch(/--db-orange|--db-warm/);
    // AND NO PULSE. The halo was a 1.4s box-shadow cycle in orange at 14%, the
    // longest-running animation in the app, held rather than stopped for a reader
    // who had asked for no motion. It went with the colour and is not restated in
    // blue: the edge and the moving counter say the same thing without moving.
    expect(rule('.dag-node.active')).not.toMatch(/animation/);
    expect(TRACE_CSS).not.toMatch(/@keyframes pulse/);
    // Its figures go to the warning family's text rung, which is what `#12ar`
    // draws: the one figure here that is not a completed measurement should not
    // read as one of the settled greys beside it.
    expect(rule('.trace-dag.compact .dag-node.active .dag-num')).toMatch(/color: var\(--ast-warn-text\)/);
    expect(rule('.trace-dag.compact .dag-node.active .dag-elapsed')).toMatch(/color: var\(--ast-warn-text\)/);
  });

  it('counts the step in progress up in whole seconds, truncated', () => {
    // The mockup's `07 Preparing the answer 12s…`. Whole seconds because it is a
    // figure the reader watches rather than compares, and the ellipsis because it
    // is the only figure in the pane that is not a completed measurement.
    const live = [
      ...run.slice(0, 6),
      stage({ id: 'synthesis', name: 'Preparing the answer', status: 'running', duration: 0 }),
    ];
    const markup = renderToStaticMarkup(
      <TraceDag stages={live} activeIndex={live.length - 1} compact elapsedMs={12_400} />
    );
    expect(markup).toContain('<span class="dag-elapsed ast-num">12s…</span>');
    expect(drawn(markup).at(-1)).toBe('Preparing the answer');
    // Numbered from its position like every other row, so the badge's "step 07"
    // and the ringed card agree.
    expect(markup).toContain('<span class="dag-num ast-num agent">07</span>');
    expect(markup).toContain('class="dag-node running active"');
    // No status badge. The ring and the moving counter already say it, in the two
    // places the design put it, and a third would take the row's width. Read off
    // the tiles: the band above them is `#18a` and the daylight list inside it
    // does print the word, because a list has no ring to say it with.
    expect(tiles(markup)).not.toContain('running</span>');
    expect(tiles(markup)).not.toContain('data-slot="badge"');
    // The reading, without a component: 0 is a real answer for the first second
    // and a negative clock skew is not printed as one.
    expect(tickingTiming(0)).toBe('0s…');
    expect(tickingTiming(999)).toBe('0s…');
    expect(tickingTiming(12_400)).toBe('12s…');
    expect(tickingTiming(-40)).toBe('0s…');
    // Its figure is warm whether or not it is still the live row, because it is
    // never a duration. Not red: a step whose report never arrived may well have
    // finished, and `.failed` is a claim nothing here has evidence for.
    expect(rule('.trace-dag.compact .dag-node.running .dag-elapsed')).toMatch(/color: var\(--db-warn-600\)/);
  });

  it('stops the count when the caller stops passing one, and says what it never measured', () => {
    // A run that died inside a step leaves that row standing and the badge names
    // it. There is no duration to print, `duration` is 0 for exactly that reason,
    // and keeping the ellipsis would read as a figure still moving on a run that
    // has ended.
    const dead = [
      stage({ id: 'step-1' }),
      stage({ id: 'step-2', name: 'Choosing the next step', status: 'running', duration: 0 }),
    ];
    const settled = renderToStaticMarkup(<TraceDag stages={dead} activeIndex={-1} compact />);
    expect(settled).toContain(`<span class="dag-elapsed ast-num">${RAIL_UNFINISHED}</span>`);
    expect(settled).not.toContain('…');
    expect(settled).not.toContain('0ms');
    expect(settled).not.toContain('active');
    // The same row, still going: the only difference is the number the caller
    // passes, which is what makes the counter something the page can stop.
    const live = renderToStaticMarkup(<TraceDag stages={dead} activeIndex={1} compact elapsedMs={3_000} />);
    expect(live).toContain('<span class="dag-elapsed ast-num">3s…</span>');
    expect(railTiming({ duration: 0, status: 'running' }, null)).toBe(RAIL_UNFINISHED);
    expect(railTiming({ duration: 0, status: 'running' }, 3_000)).toBe('3s…');
    // A measured step ignores the counter entirely, so a stage that reported a
    // duration cannot be overwritten by the row above it still running.
    expect(railTiming({ duration: 478, status: 'complete' }, 9_000)).toBe('478ms');
  });

  it('draws the run exactly as it did before against a model that announces nothing', () => {
    // THE STATE BETWEEN THE APP DEPLOY AND THE MODEL RE-LOG, which is the one a
    // reader will actually see if those land separately. No stage is ever
    // `running`, so there is no row to ring beyond the frontier, no counter to
    // start, and every figure is a completed measurement.
    const markup = renderToStaticMarkup(
      <TraceDag stages={run} activeIndex={run.length - 1} compact elapsedMs={null} />
    );
    expect(markup).not.toContain('running');
    expect(markup).not.toContain(RAIL_UNFINISHED);
    expect(markup).not.toContain('s…');
    expect(markup.match(/class="dag-node complete active"/g)).toHaveLength(1);
    // And passing a count anyway changes nothing, because every row has a duration
    // of its own: a page that kept ticking against an older model must not be able
    // to write that count onto a finished step.
    expect(
      renderToStaticMarkup(<TraceDag stages={run} activeIndex={run.length - 1} compact elapsedMs={20_000} />)
    ).toBe(markup);
  });

  it('reddens a failed step’s edge and its duration, and keeps the card', () => {
    const failed = renderToStaticMarkup(
      <TraceDag stages={[stage({ id: 'step-1', status: 'failed' })]} activeIndex={-1} compact />
    );
    expect(failed).toContain('class="dag-node failed');
    expect(failed).toContain('dag-elapsed');
    expect(rule('.dag-node.failed')).toMatch(/border-color: var\(--db-red-600\)/);
    expect(rule('.trace-dag.compact .dag-node.failed .dag-elapsed')).toMatch(/color: var\(--db-red-600\)/);
  });

  it('keeps the steps that ran after a step that failed', () => {
    // The design says later steps do not render, on the assumption that a failed
    // step ends the run. Most failures here are not that: a tool errors, the model
    // reads the error and picks another way round, and the run answers. Those later
    // steps are the recovery, the reader watched them arrive, and the answer under
    // the rail came out of them -- so hiding them hides the work that produced what
    // is on screen. Where the design's assumption does hold, the failure IS the last
    // step and there is nothing after it to hide, so the two rules agree.
    const recovered = [
      stage({ id: 'step-1', name: 'Chose the next step' }),
      stage({ id: 'step-1-1-data_genie', name: 'Called search_semantics', kind: 'tool', status: 'failed', depth: 1 }),
      stage({ id: 'step-2', name: 'Chose the next step' }),
      stage({ id: 'synthesis', name: 'Prepared the answer' }),
    ];
    const markup = renderToStaticMarkup(<TraceDag stages={recovered} activeIndex={-1} compact />);
    expect([...markup.matchAll(/class="dag-node/g)]).toHaveLength(4);
    expect(markup).toContain('Prepared the answer');
    expect(markup).toContain('04');
  });

  it('presses every step, the way a card on the map is pressed', () => {
    // The rail kept divs while it was 264px wide, because there was nowhere beside
    // a transcript to read a recorded SQL statement and a step that looks pressable
    // and is not is worse than the record it already is. The column is 340px now,
    // and the press is the map's own rather than a second kind: a real button, one
    // per step, `aria-expanded` on it, and `aria-controls` naming the panel only
    // while that panel exists to be named.
    const markup = renderToStaticMarkup(<TraceDag stages={run} activeIndex={-1} compact />);
    expect(markup.match(/<button type="button" class="dag-node/g)).toHaveLength(run.length);
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(run.length);
    expect(markup).not.toContain('aria-controls');
    // Shut on arrival, in both arrangements. A panel that opens itself on the
    // newest step is a payload pushing the run's own shape off the column.
    expect(markup).not.toContain('dag-detail');
    // The raw-payload row stays the map's: it is several hundred lines of JSON and
    // the rail has a transcript beside it.
    expect(markup).not.toContain('dag-raw');
  });

  it('seats the map’s own panel rather than a second copy of it', () => {
    // ONE PANEL, TWO SEATS. `.dag-detail` and everything under it is written once
    // in trace.css, under `.map`, so the rail renders it inside that container
    // instead of carrying a rail-shaped duplicate that would then have to be kept
    // level with it. The panel spans the seat, so it does not need to know how wide
    // the column it landed in is.
    expect(SOURCE).toMatch(/const railPanel = open \?/);
    expect(SOURCE).toMatch(/<div className="trace-dag map">/);
    expect(rule('.trace-dag.map .dag-detail')).toMatch(/grid-column: 1 \/ -1/);
    // And outside the rail's list rather than inside it: the list clips a name to
    // one line with an ellipsis, which is right for a tile and wrong for the one
    // place the whole name is spelled out.
    expect(SOURCE).toMatch(/\{steps\}\s*\n\s*\{railPanel\}/);
  });

  it('marks the open tile the way the map marks its open card', () => {
    const open = rule('.trace-dag.compact .dag-node.open');
    expect(open).toMatch(/border: 2px solid var\(--primary\)/);
    expect(open).toMatch(/background: var\(--db-blue-faint\)/);
    // A pixel off each side, so pressing a step cannot make its tile taller and
    // move the connector under it along with every step below.
    expect(px(open, 'padding')).toBe(px(rule('.trace-dag.compact .dag-node'), 'padding')! - 1);
    // Inset ring, because the tile's connector is drawn immediately below it.
    expect(rule('.trace-dag.compact .dag-node:focus-visible')).toMatch(/outline-offset: -2px/);
  });

  it('keeps a tool name whole and labels nothing it has room to print', () => {
    // `search_semantics` on one line down a 264px column is the fix this pane was
    // given once and must keep: mono, and breaking on spaces only, so the
    // underscore is not a break opportunity. One line rather than the map's two,
    // because a rail row is a row.
    const name = rule('.trace-dag.compact .dag-name');
    expect(name).toMatch(/white-space: nowrap/);
    expect(name).toMatch(/overflow: hidden/);
    expect(name).toMatch(/text-overflow: ellipsis/);
    expect(rule('.trace-dag.compact .dag-name-tool')).toMatch(/font-family: var\(--font-mono\)/);
    const markup = renderToStaticMarkup(
      <TraceDag
        stages={[stage({ id: 'step-1-1-search_semantics', name: 'Called search_semantics', kind: 'tool' })]}
        activeIndex={-1}
        compact
      />
    );
    expect(drawn(markup)).toEqual(['Called search_semantics']);
    expect(markup).toContain('dag-name-tool');
    expect(markup).not.toContain('title=');
  });

  it('keeps its own tile’s arrangement, stated rather than inherited', () => {
    // Four tracks now: the number, the mark, the name, and the measurement pinned
    // to the far end. Written out under `.compact` because the map's card is not
    // this shape, and a shared `display: grid` with a 20px first track would be
    // the original leak exactly.
    const node = rule('.trace-dag.compact .dag-node');
    expect(node).toMatch(/display: grid/);
    expect(node).toMatch(/grid-template-columns: 20px 13px 1fr auto/);
    expect(node).toMatch(/align-items: start/);
    expect(node).toMatch(/border-radius: var\(--radius-sm\)/);
    expect(rule('.trace-dag.compact .dag-mark > svg')).toMatch(/width: 13px/);
    // Optical nudge: start-aligned mark would otherwise sit high against the
    // bold title / numbered badge (same family as `.live-step-icon`).
    expect(rule('.trace-dag.compact .dag-mark')).toMatch(/margin-top: 3px/);
  });
});
