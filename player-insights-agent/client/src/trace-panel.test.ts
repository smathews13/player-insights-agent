import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { ToolType } from './trace-timeline';
import { partial, partialNames, stylesheet } from './styles/stylesheet';

/**
 * The run process panel, as a reader meets it.
 *
 * Three complaints landed on this panel at once and each of them is a default
 * rather than a calculation, which is why they are asserted against the source
 * instead of against a rendered tree: the numbers were never wrong, they were
 * behind a click, laid out as a table to be read down, and buried in prose that
 * restated them. None of that shows up in a test of `buildTimeline`.
 */
const CARD = readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8');
const TIMELINE = readFileSync(new URL('./TraceTimeline.tsx', import.meta.url), 'utf8');
const HOME = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
const STORED_ANSWER = readFileSync(new URL('./StoredAnswerRenderer.tsx', import.meta.url), 'utf8');
const RUN_EXPLORER = readFileSync(new URL('./RunExplorer.tsx', import.meta.url), 'utf8');
const MONITORING = readFileSync(new URL('./MonitoringPage.tsx', import.meta.url), 'utf8');
const TRACE_DAG = readFileSync(new URL('./TraceDag.tsx', import.meta.url), 'utf8');
const STYLESHEET = stylesheet();
const TIMELINE_CSS = partial('timeline.css');
const TRACE_CSS = partial('trace.css');
const DARK = partial('dark-mode.css').replace(/\/\*[\s\S]*?\*\//g, ' ');

function cssBody(css: string, selector: string): string {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].split(',').some((candidate) => candidate.trim() === selector)) return match[2];
  }
  return '';
}

/** The body of one top-level function, so a claim can be scoped to it. */
function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

describe('the run process panel follows its surface', () => {
  it('defaults dedicated process views open and Ask answers closed', () => {
    expect(CARD).toContain('defaultRunProcessOpen = true');
    expect(CARD).toContain('readRunProcessPreference(runProcessPreferenceKey) ?? defaultRunProcessOpen');
    expect(STORED_ANSWER).toContain('defaultRunProcessOpen={false}');
    expect(STORED_ANSWER).toContain('runProcessPreferenceKey={preferenceKey}');
    expect(HOME).toContain('preferenceKey={message.id}');
    expect(MONITORING).not.toContain('defaultRunProcessOpen={false}');
    expect(CARD).toContain('<Collapsible open={showProcess} onOpenChange={changeProcessVisibility}>');
  });

  it('keeps the control, and says which way it will go', () => {
    expect(CARD).toContain("{showProcess ? 'Hide process' : 'View process'}");
    expect(CARD).toContain('<CollapsibleTrigger asChild>');
  });

  it('heads the bar with the label and the control, and no row of figures', () => {
    // The bar carried a run-together reconciliation line beside the heading --
    // "wall clock 51.61s · 10 rows · recorded activity 50.87s · unaccounted
    // 740ms" -- which is the shape this app keeps deleting: five measurements a
    // reader has to parse before reaching the one they came for. The figures
    // that survive are the ones on the tiles inside, where each is labelled. The
    // heading itself is pinned by 'names each section with what it holds' below.
    expect(CARD).not.toContain('traceSummary');
    expect(CARD).not.toContain('trace-headline');
    // Gone at the source too, not just at this call site.
    expect(CARD).not.toContain('traceHeadline');
    expect(TIMELINE).not.toContain('reconciliationParts');
    expect(TIMELINE).not.toContain('trace-reconciliation');
  });
});

describe('the roll-up reads as tiles at the head of the steps', () => {
  it('is not a table any more', () => {
    const rollUp = functionSource(TIMELINE, 'RollUp');
    expect(rollUp).toContain('trace-kpi');
    expect(rollUp).not.toMatch(/<t(able|head|body|r|d|h)[\s>]/);
  });

  it('carries the time, the share of wall clock and the call count on each tile', () => {
    const rollUp = functionSource(TIMELINE, 'RollUp');
    expect(rollUp).toContain('formatMs(row.totalMs)');
    expect(rollUp).toContain('Math.round(row.sharePct)');
    expect(rollUp).toContain('row.calls');
    // The chip is what names the type, and it is the existing one: the colours
    // are assigned per type in the stylesheet and are not re-invented here.
    expect(rollUp).toContain('<KindChip type={row.type} />');
  });

  it('keeps the call count and any partial count in one compact badge', () => {
    const rollUp = functionSource(TIMELINE, 'RollUp');
    expect(rollUp).toContain('className="trace-call-badge ast-num"');
    expect(rollUp).toContain('row.partialCalls > 0 && ` · ${row.partialCalls} partial`');
    const badge = TIMELINE_CSS.match(/\.trace-call-badge \{([^}]*)\}/)?.[1] ?? '';
    expect(badge).toMatch(/border-radius: var\(--radius-sm\)/);
    expect(badge).toMatch(/white-space: nowrap/);
    expect(badge).toMatch(/font-size: 9px/);
  });

  it('names every type a tile can be, in a word rather than in a hue on Ask', () => {
    // Ask keeps the neutral chip. Run Explorer paints kinds under
    // `.trace-timeline--explorer` so the notebook viz can match side by side.
    const types: ToolType[] = ['llm', 'sql', 'discovery', 'plot', 'clarify', 'agent', 'run'];
    for (const type of types) {
      expect(TIMELINE, `${type} is labelled`).toMatch(new RegExp(`${type}: '\\w+'`));
    }
    expect(STYLESHEET).not.toContain('--kind-');
    const chip = STYLESHEET.match(/\n\.trace-chip \{([^}]*)\}/)?.[1] ?? '';
    expect(chip).toMatch(/background: var\(--db-chip\)/);
    expect(chip).toMatch(/color: var\(--db-grey-blue\)/);
    expect(chip).toMatch(/text-transform: uppercase/);
  });

  it('gives the run envelope the outline chip, because it is not a kind of step', () => {
    const run = STYLESHEET.match(/\.trace-chip-run \{([^}]*)\}/)?.[1] ?? '';
    expect(run).toMatch(/background: transparent/);
    expect(run).toMatch(/border: 1px solid var\(--db-line-strong\)/);
  });

  it('reflows rather than naming a breakpoint, because it renders at two widths', () => {
    expect(STYLESHEET).toMatch(/\.trace-kpis \{[^}]*repeat\(auto-fit, minmax\(/);
  });

  it('heads the step listing instead of stacking above it', () => {
    const gantt = functionSource(TIMELINE, 'Gantt');
    expect(gantt).toContain('<RollUp rows={model.rollUp}');
    expect(gantt).toContain('<KindKpis rows={model.rollUp}');
    // Ahead of the heading for the steps, which is what makes it the header of
    // the listing rather than a section before it.
    expect(gantt.indexOf('<RollUp')).toBeLessThan(gantt.indexOf('Step timeline'));
  });

  it('puts Explorer kind totals in a compact badge row, not a full-width table', () => {
    const badges = functionSource(TIMELINE, 'KindKpis');
    expect(badges).toContain('trace-kind-kpis');
    expect(badges).toContain('formatMs(row.totalMs)');
    expect(badges).not.toMatch(/<t(able|head|body|r|d|h)[\s>]/);
    expect(STYLESHEET).toMatch(/\.trace-kind-kpis \{[^}]*display:\s*flex/s);
    expect(STYLESHEET).not.toMatch(/\.trace-kind-summary \{/);
  });

  it('keeps failed time on the explorer kind badges, not only on Ask tiles', () => {
    const badges = functionSource(TIMELINE, 'KindKpis');
    expect(badges).toContain('row.failedCalls > 0');
    expect(badges).toContain('counted in recorded activity, left out of the time above');
  });

  it('keeps notebook kind colour on Run Explorer only', () => {
    expect(TIMELINE).toContain("variant === 'explorer'");
    expect(TIMELINE).toContain('trace-timeline--explorer');
    expect(RUN_EXPLORER).toMatch(/variant="explorer"/);
    expect(CARD).not.toMatch(/variant="explorer"/);
    expect(STYLESHEET).toMatch(/\.trace-timeline--explorer \.trace-chip-llm \{/);
    expect(STYLESHEET).toMatch(/\.trace-kind-kpis \{/);
  });

  it('does not stack a second frosted pane on either surface that draws it', () => {
    /*
     * The panel is drawn twice -- nested in the answer card's run process on Ask,
     * and bare on the Run Explorer's Timeline tab -- from this one component. So
     * the de-stack belongs to the component's own classes, not to Ask's wrapper:
     * scoped to `.run-process` it fixed the card and left Explorer stacking.
     */
    for (const selector of ["html[data-theme='dark'] .trace-timeline", "html[data-theme='dark'] .trace-gantt"]) {
      expect(cssBody(DARK, selector)).toMatch(/background:\s*transparent[\s\S]*backdrop-filter:\s*none/);
    }
    expect(cssBody(DARK, "html[data-theme='dark'] .trace-kpi")).toMatch(/background:\s*var\(--ast-surface-muted\)/);
    expect(DARK, 'a wrapper-scoped twin covers one surface only').not.toMatch(
      /\.run-process \.trace-(?:timeline|gantt|kpi)/
    );
  });

  it('is styled on every surface that draws it, not only on the routes that own a stylesheet', () => {
    /*
     * THIS IS THE OVERLAP BUG, and it is one line of import graph.
     *
     * `timeline.css` was moved out of index.css into side-effect imports inside
     * the two lazy ROUTE modules that draw a timeline. `TraceTimeline` is not a
     * route's component: the answer card draws it on Ask and on Monitoring's
     * question modal, and neither of those imported the sheet. So both rendered
     * the roll-up tiles, the axis and the Gantt with NO RULES AT ALL -- an
     * unstyled table, tick labels that never took their absolute position, and
     * KPI tiles with no grid, which is the "Time by tool type" block landing on
     * top of the answer prose. Run Explorer looked correct throughout, because
     * Run Explorer is the surface that imported the sheet.
     *
     * The sheet is back in the entry cascade and no module imports it. A future
     * split of it has to answer this test, which is the question the last one
     * did not ask: which surfaces draw this component?
     */
    expect(partialNames(), 'timeline.css is in the entry cascade').toContain('timeline.css');
    expect(CARD, 'Ask and Monitoring share this card').toContain('<TraceTimeline');
    expect(MONITORING, 'Monitoring reuses the card rather than drawing a second timeline').toContain('<AnswerCard');
    expect(MONITORING).not.toContain('<TraceTimeline');
    expect(RUN_EXPLORER, 'Run Explorer draws TraceTimeline').toContain('<TraceTimeline');
    for (const [name, source] of [
      ['AnswerCard.tsx', CARD],
      ['MonitoringPage.tsx', MONITORING],
      ['RunExplorer.tsx', RUN_EXPLORER],
    ] as const) {
      expect(source, `${name} does not carry the sheet itself`).not.toContain("import './styles/timeline.css'");
    }
  });
});

/**
 * The Gantt is a table, and the reason is worth restating: every row is a labelled
 * record with a duration and the bar is one of its columns. That makes it selectable,
 * readable by a screen reader, and free of any charting dependency. An SVG would be
 * none of the three without a second implementation of all of it.
 */
describe('the Gantt is a table, with the semantics of one', () => {
  it('draws a header row of scoped column headers rather than a first row of cells', () => {
    const gantt = functionSource(TIMELINE, 'Gantt');
    expect(gantt).toContain('<thead>');
    expect(gantt).toContain('<tbody>');
    expect(gantt.match(/scope="col"/g)?.length).toBe(6);
    expect(gantt).toMatch(/<th scope="col" className="trace-num trace-tokens">\s*Tokens\s*<\/th>/);
  });

  it('names the bar column, which had only tick marks in its header', () => {
    // A column whose header holds nothing but absolutely positioned tick labels is a
    // column a screen reader announces by position. The ticks stay in that cell,
    // because sharing it with the bars is what keeps them in one coordinate space.
    const gantt = functionSource(TIMELINE, 'Gantt');
    expect(gantt).toContain('<span className="trace-axis-label">Timeline</span>');
    expect(gantt).toContain('className="trace-axis"');
  });

  it('keeps the number column readable when its heading is a symbol', () => {
    const gantt = functionSource(TIMELINE, 'Gantt');
    expect(gantt).toContain('<span aria-hidden="true">#</span>');
    expect(gantt).toContain('<span className="sr-only">Step</span>');
  });

  it('puts the disclosure control inside the event cell, one row at a time', () => {
    const row = functionSource(TIMELINE, 'GanttRow');
    expect(row).toMatch(/className="trace-event">\s*<button type="button" aria-expanded=\{expanded}/);
    expect(row).toContain('<ChevronDown aria-hidden="true" />');
    // One at a time is the state, not the markup: the id of the open row, or null.
    expect(TIMELINE).toMatch(/useState<string \| null>\(null\)/);
    expect(TIMELINE).toMatch(/current === id \? null : id/);
  });

  it('says the two things it cannot measure in words rather than leaving a blank', () => {
    const row = functionSource(TIMELINE, 'GanttRow');
    expect(row).toContain('start not recorded');
    expect(row).toContain("{row.startMs === null ? 'not recorded'");
    expect(functionSource(TIMELINE, 'PayloadView')).toContain('clipped by the agent');
  });

  it('lays the open row out as a definition list of what was recorded', () => {
    const row = functionSource(TIMELINE, 'GanttRow');
    for (const term of ['<dt>Started</dt>', '<dt>Took</dt>', 'label="Arguments"', 'label="Result"']) {
      expect(row).toContain(term);
    }
    expect(STYLESHEET).toMatch(/\.trace-detail dl \{[^}]*grid-template-columns: 90px minmax\(0, 1fr\)/);
  });
});

describe('the bars carry the outcome, and nothing else', () => {
  it('draws every step in the action colour on the default surface', () => {
    const bar = STYLESHEET.match(/\n\.trace-bar \{([^}]*)\}/)?.[1] ?? '';
    expect(bar).toMatch(/background: var\(--chart-1\)/);
    expect(bar).toMatch(/height: 10px/);
    expect(bar).toMatch(/min-width: 2px/);
    // Ask keeps one colour. Per-kind hues are scoped under the explorer shell.
    expect(STYLESHEET.match(/(?:^|\n)\.trace-bar-(llm|sql|discovery|plot|clarify) \{/)).toBeNull();
    expect(STYLESHEET).toMatch(/\.trace-timeline--explorer \.trace-bar-llm \{/);
    expect(STYLESHEET).toMatch(/\.trace-timeline--explorer \.trace-bar-sql \{/);
  });

  it('draws the run duration as a neutral solid hairline on every timeline surface', () => {
    const run = STYLESHEET.match(/\n\.trace-bar-run \{([^}]*)\}/)?.[1] ?? '';
    expect(run).toMatch(/background: transparent/);
    expect(run).toMatch(/border: 1px solid var\(--ast-border-input\)/);
    expect(run).not.toMatch(/dashed|dotted|primary|blue/i);
    const explorer = STYLESHEET.match(/\n\.trace-timeline--explorer \.trace-bar-run \{([^}]*)\}/)?.[1] ?? '';
    expect(explorer).toBe('');
  });

  it('ships no blue dashed run perimeter or run-envelope SVG dash array', () => {
    expect(TRACE_CSS).not.toContain('.trace-dag.map.has-run-envelope');
    expect(TRACE_DAG).not.toContain('has-run-envelope');
    for (const css of [TRACE_CSS, TIMELINE_CSS]) {
      const runRules = [...css.matchAll(/([^{}]*(?:run-envelope|trace-bar-run|trace-dag\.map)[^{}]*)\{([^}]*)\}/gi)];
      for (const [, selector, body] of runRules) {
        expect(body, selector).not.toMatch(/(?:border(?:-[a-z]+)?|stroke)[^;]*(?:dashed|dotted)[^;]*(?:primary|blue)/i);
      }
    }
    expect(`${TRACE_DAG}\n${TIMELINE}`).not.toMatch(/run[-A-Za-z]*envelope[\s\S]{0,120}strokeDasharray/i);
  });

  it('keeps the hatch on every bar that did not finish cleanly', () => {
    // The only reason those states do not depend on colour alone, and it has to stay
    // translucent: the bar under it is blue on a step that ran and red on one that
    // failed, so a hatch drawn in either would vanish on the other.
    const hatched = STYLESHEET.match(
      /\.trace-bar\.partial,\s*\.trace-bar\.running,\s*\.trace-bar\.failed \{([^}]*)\}/
    )?.[1];
    expect(hatched).toMatch(/repeating-linear-gradient\(\s*135deg/);
    expect(hatched).toMatch(/rgba\(255, 255, 255, 0\.85\)/);
    expect(STYLESHEET).toMatch(/\.trace-bar\.failed \{[^}]*background-color: var\(--db-red-600\)/);
  });

  it('puts partial and failed in one family, and lets the label tell them apart', () => {
    // They were amber and red, which made amber mean "not quite" in this panel and
    // "evaluation" everywhere else in the app.
    const status = STYLESHEET.match(/\n\.trace-status \{([^}]*)\}/)?.[1] ?? '';
    expect(status).toMatch(/background: var\(--db-red-wash\)/);
    expect(status).toMatch(/color: var\(--db-red-600\)/);
    expect(status).not.toMatch(/amber|gold/);
    expect(functionSource(TIMELINE, 'GanttRow')).toContain('{row.status}</span>');
  });
});

describe('the panel labels its parts rather than narrating them', () => {
  it('names each section with what it holds', () => {
    expect(TIMELINE).toContain('<h4>Time by tool type</h4>');
    expect(TIMELINE).toContain('<h4>Step timeline</h4>');
    expect(CARD).toContain('<p className="font-medium text-sm">Run process</p>');
  });

  it('heads the steps and stops, without a line telling the reader to click', () => {
    // "Click any row to expand its arguments and result." sat under the Step
    // timeline heading. The rows are a table of named events with a chevron in
    // each one and `aria-expanded` on the control, so the instruction described
    // an affordance already drawn, to a reader who reaches it by scrolling past
    // the tiles -- and it restated the heading two lines above it while doing so.
    //
    // Pinned as the shape rather than the sentence: both headings in this panel
    // hold their h4 and nothing else, so a reworded preamble under EITHER of
    // them fails here rather than only the wording that was removed.
    const headings = TIMELINE.match(/<div className="trace-panel-heading">[\s\S]*?<\/div>/g) ?? [];
    expect(headings).toHaveLength(2);
    for (const heading of headings) {
      expect(heading, 'a section heading carries no prose under it').not.toContain('<p');
    }
    // The other side: the rule that made such a paragraph look deliberate. Left
    // behind, it is a styled slot inviting the next one. `onClick` is untouched
    // by the word boundary -- it is the handler, not a sentence about it.
    expect(STYLESHEET).not.toContain('.trace-panel-heading p');
    expect(TIMELINE).not.toMatch(/\bClick\b/);
    expect(TIMELINE).not.toMatch(/\bHover\b/i);
  });

  it('has none of the phrases the reader asked us to drop', () => {
    for (const phrase of ['Where the time went', 'When each step ran', 'How it worked', 'A friendly view']) {
      expect(`${CARD}${TIMELINE}`).not.toContain(phrase);
    }
  });

  it('footnotes neither the drawing nor what the run might have done instead', () => {
    // Five paragraphs used to hang under the chart, and every one of them was
    // about the rendering or about a hypothetical: thin bars widened, turns that
    // could have run concurrently and what that would have saved, a plan turn
    // that records no trace. Asserted across the surfaces together, because the
    // point of one shared timeline is that Run Explorer cannot keep its own copy.
    //
    const surfaces = `${CARD}${TIMELINE}${HOME}${RUN_EXPLORER}`;
    for (const phrase of [
      'Bars thinner than',
      'the duration column is the true value',
      'Bar positions come from recorded timestamps',
      'would have saved up',
      'ran one after another',
      'plan you approved',
      'did not finish cleanly',
      'overlap another in time',
      '⇉',
    ]) {
      expect(surfaces, `${phrase} is gone`).not.toContain(phrase);
    }
    expect(TIMELINE).not.toContain('trace-geometry-note');
    expect(STYLESHEET).not.toContain('trace-geometry-note');
    // And the machinery, not just the sentences. A flag or a saving still being
    // computed is a sentence waiting to be written again.
    for (const symbol of ['TimelineNotes', 'afterPlanApproval', 'fanout', 'concurrencySavingMs']) {
      expect(surfaces, `${symbol} is gone`).not.toContain(symbol);
    }
    expect(STYLESHEET).not.toContain('trace-fanout');
  });

  it('keeps the caveat that stops failed time being misread, and no longer explains the call count', () => {
    // Failed time is in recorded activity but not in the type total, and nothing
    // on screen says so, so this one stays.
    expect(TIMELINE).toContain('counted in recorded activity, left out of the time above');
    // The external-call counter is the opposite case. It was printed here under a
    // sentence reconciling it against the row count -- an explanation of a
    // discrepancy no reader had asked about -- while both surfaces that show this
    // panel already print the same count in the heading directly above it:
    // `whatRanHeading` in the Monitoring drawer and `runHeadline` in Run Explorer.
    // So the sentence went and the figure was not kept, because keeping it would
    // put one number on one screen twice.
    expect(TIMELINE).not.toContain('external call');
    expect(TIMELINE).not.toContain('externalCalls');
  });
});

describe('the panel’s figures are set as figures', () => {
  /**
   * Every rule in the timeline's own stylesheet, as a selector and its body.
   *
   * A claim about numerals is a claim about individual rules rather than about the
   * file: `font-variant-numeric` in one rule and `font-family` in another is two
   * rules, and only one of them is doing anything.
   */
  function rules(): { selector: string; body: string }[] {
    const css = TIMELINE_CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((found) => ({
      selector: found[1].trim(),
      body: found[2],
    }));
  }

  it('asks for tabular numerals only in a face that has them', () => {
    /*
     * THE FAILURE MODE THIS CATCHES IS A DECLARATION THAT READS AS DONE.
     *
     * DMSans-variable.woff2 declares no `tnum` feature -- its GSUB carries calt,
     * ccmp, dnom, frac, liga, locl and numr and nothing else -- so
     * `font-variant-numeric: tabular-nums` on DM Sans switches nothing on and
     * reports no error. Its digits are proportional and not by a small margin: at
     * 1000 units per em a `1` is 342 against a `0` at 656, so a column of them
     * cannot line up however it is marked.
     *
     * Five rules in this file were in exactly that state, including the Gantt's
     * step column and the roll-up tile's value. The face now arrives as `.ast-num`
     * on the element, which is where §3's rule about WHERE a figure sits can be
     * stated once. What must not come back is a local `tabular-nums` beside a
     * proportional family.
     */
    for (const { selector, body } of rules()) {
      if (!body.includes('font-variant-numeric')) continue;
      expect(body, `${selector} asks for tabular figures without a mono family`).toContain(
        'font-family: var(--font-mono)'
      );
    }
  });

  it('marks the roll-up tile’s value and its meta line as numerals', () => {
    // A stat value and a right-aligned meta slot, which are two of the four
    // placements §3 makes binding.
    expect(TIMELINE).toContain('<strong className="ast-num">{formatMs(row.totalMs)}</strong>');
    expect(TIMELINE).toContain('className="trace-kpi-meta ast-num"');
  });

  it('marks the Gantt’s step and duration cells, and leaves their headings alone', () => {
    // The heading is the word "Step"; only the figures under it have to line up
    // with each other, and a mono heading over a mono column reads as a value.
    expect(TIMELINE).toContain('className="trace-step ast-num"');
    expect(TIMELINE).toContain('className="trace-num trace-duration ast-num"');
    expect(TIMELINE).toMatch(/<th scope="col" className="trace-step">/);
    expect(TIMELINE).toMatch(/<th scope="col" className="trace-num">/);
  });

  it('keeps the right-alignment on the column rather than on the cells', () => {
    // `.trace-num` is the column, heading included, so the alignment stays there
    // and only the face moved.
    const num = rules().find((one) => one.selector === '.trace-num');
    expect(num?.body).toContain('text-align: right');
    expect(num?.body).not.toContain('font-variant-numeric');
  });
});
