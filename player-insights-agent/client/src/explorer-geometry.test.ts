import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { partial, partialNames } from './styles/stylesheet';

/**
 * The two screens that read a recorded run: the Run Explorer and the Benchmark Lab.
 *
 * These tests hold the handful of properties on those screens that are decisions
 * rather than taste — a keyboard-reachable run row, an unrated run said in words,
 * a missing metric that is an em dash and not a zero, and the geometry the handoff
 * is specific about. They read the source and the stylesheet, in the pattern
 * `palette.test.ts` established, because the alternative is a browser and there
 * is no browser here.
 */

const RUNS = partial('runs.css');
const SHELL = partial('page-shell.css');
const BENCHMARK = partial('benchmark.css');
const TIMELINE = partial('timeline.css');
const RESPONSIVE = partial('responsive.css');
const EXPLORER = readFileSync(new URL('./RunExplorer.tsx', import.meta.url), 'utf8');
const KPIS = readFileSync(new URL('./RunOverviewKpis.tsx', import.meta.url), 'utf8');
const RATING_BADGE = readFileSync(new URL('./RunRatingBadge.tsx', import.meta.url), 'utf8');
const LAB = readFileSync(new URL('./BenchmarkLab.tsx', import.meta.url), 'utf8');

/** The declarations of one rule, by selector, so a claim can be made about one block. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} exists`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('the Run Explorer’s two columns', () => {
  it('gives the page title room under the nav', () => {
    // 40px left "Run Explorer" and the sky tight against the header hairline.
    // 56 is Ask's transcript inset, restated on this page so a later shell
    // shorthand cannot take it back. Regex rather than `rule()`, because
    // `.page-shell` opens the file and that helper needs a leading newline.
    expect(SHELL).toMatch(/\.page-shell\s*\{[^}]*padding:\s*56px\s+clamp/s);
    expect(rule(RUNS, '.run-explorer')).toMatch(/padding-top:\s*56px/);
  });

  it('gives the run list the width the handoff fixes it at', () => {
    // 340px is a number, not a fraction: the list holds a date, a status pill and
    // two or three lines of prompt, and it has to hold them at the same width
    // whatever is beside it.
    expect(rule(RUNS, '.explorer-layout')).toContain('grid-template-columns: 340px');
  });

  it('puts the username filter beside All conversations, not under it', () => {
    expect(rule(RUNS, '.run-list-filters')).toContain('display: grid');
    expect(rule(RUNS, '.run-list-filters')).toContain('minmax(0, 1.65fr) minmax(0, 1fr)');
    expect(EXPLORER).toContain('run-list-filters');
    expect(EXPLORER).toContain('Filter runs by username');
    expect(EXPLORER).toContain('All users');
  });

  it('bounds both filter tracks while preserving the chevron and ellipsis', () => {
    const field = rule(RUNS, '.run-filter-field');
    expect(field).toContain('min-width: 0');
    expect(field).toContain('max-width: 100%');
    const triggers = rule(RUNS, '.run-conversation-filter,\n.run-username-filter');
    expect(triggers).toContain('width: 100%');
    expect(triggers).toContain('max-width: 100%');
    expect(triggers).toContain('min-width: 0');
    expect(rule(RUNS, '.run-filter-label')).toContain('text-overflow: ellipsis');
    expect(EXPLORER).toContain('run-filter-label');
  });

  it('opens All conversations and All users as overlay popovers', () => {
    // A long conversation title used to widen the 340px column and shove the
    // detail pane. The menu is a popper overlay; opening it cannot change the
    // field of view, chrome width, or scrollbar.
    expect(EXPLORER).toMatch(/position="popper"/);
    expect(EXPLORER).toMatch(/className="app-select-content run-filter-menu"/);
    expect(rule(RUNS, '.explorer-layout')).toContain('overflow-x: clip');
    expect(rule(RUNS, 'html body[data-scroll-locked]')).toContain('margin-right: 0 !important');
    expect(rule(RUNS, 'html body[data-scroll-locked]')).toContain('padding-right: 0 !important');
  });

  it('gives the detail column a real pane, not a floating tint', () => {
    // Tabs plus the view they switch sit on one sheet. No hairline is what
    // made Overview, Agent map, Timeline and Details read as a square of
    // wash with only a line under the labels. Same family as the answer card.
    const pane = rule(RUNS, '.run-detail');
    expect(pane).toContain('border: 1px solid var(--ast-hairline)');
    expect(pane).toContain('border-radius: var(--ast-radius-card)');
    expect(pane).toContain('background: var(--ast-pane)');
  });

  it('makes a run row a bordered block at the smaller radius, not a list line', () => {
    const row = rule(RUNS, '.run-item');
    expect(row).toContain('border-radius: var(--radius-md)');
    expect(row).toContain('border: 1px solid var(--border)');
    // The prompt is the row's subject and carries the medium weight.
    expect(rule(RUNS, '.run-item-prompt')).toContain('font-weight: 500');
    // Dates are read down the column, so their digits have to be one width. The
    // face is on the element, for the reason the guard below this describes.
    expect(EXPLORER).toContain('className="run-item-date ast-num"');
  });

  it('asks for tabular numerals only in a face that has them', () => {
    /*
     * THE FAILURE MODE THIS CATCHES IS A DECLARATION THAT READS AS DONE.
     *
     * DMSans-variable.woff2 declares no `tnum` feature, so
     * `font-variant-numeric: tabular-nums` on DM Sans switches nothing on and
     * reports no error. Its digits are proportional and not by a small margin: at
     * 1000 units per em a `1` is 342 against a `0` at 656, so a column of them
     * cannot line up however it is marked.
     *
     * `.run-item-date` and `.run-item-rating` were both in that state -- the
     * stylesheet said the dates down the list were even and they were not. The
     * face arrives as `.ast-num` on the element instead, which is where §3's rule
     * about WHERE a figure sits is stated once. What must not come back is a
     * local `tabular-nums` beside a proportional family. The same guard runs over
     * timeline.css in trace-panel.test.ts.
     */
    const rules = [...RUNS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((found) => ({
      selector: found[1].trim(),
      body: found[2],
    }));
    for (const { selector, body } of rules) {
      if (!body.includes('font-variant-numeric')) continue;
      expect(body, `${selector} asks for tabular figures without a mono family`).toContain(
        'font-family: var(--font-mono)'
      );
    }
  });

  it('sets the row’s duration in mono and keeps feedback directional', () => {
    // The stakeholder's name shares the line with the duration and is not a
    // measurement, so the face goes on the figure rather than on the line.
    expect(EXPLORER).toContain('<span className="ast-num">{(run.duration_ms / 1000).toFixed(1)}s</span>');
    // Overview wall time uses the same printer as the Timeline envelope, so a
    // 24.009s run cannot read as 24.0s on one tab and 24.01s on the other.
    expect(KPIS).toContain('value={hasDuration ? formatMs(durationMs) : ABSENT}');
    expect(EXPLORER).toContain('<RunRatingBadge rating={run.rating} />');
    expect(EXPLORER).not.toContain('<Star');
  });

  it('marks the selected run with the blue edge on a faint blue ground', () => {
    // The same language the conversation rail uses. Both states carry a border, so
    // selecting a row cannot shift the rows under it by a border's width.
    const active = rule(RUNS, '.run-item.active');
    expect(active).toContain('border-color: var(--primary)');
    expect(active).toContain('background: var(--db-selected-tint)');
  });

  it('keeps the run’s identifiers in mono, where they are values rather than prose', () => {
    // The id chip still says it locally, because it is a value rather than a
    // figure in a slot. The run's own numbers moved to `.ast-num` on the element:
    // §3's rule is about WHERE a number sits, so it is stated in one class rather
    // than restated by every rule that happens to find one. See run-header.test.tsx.
    expect(rule(RUNS, '.run-id-short')).toContain('font-family: var(--font-mono)');
    expect(rule(RUNS, '.run-detail-meta')).not.toContain('font-variant-numeric');
  });

  it('sets the token split as a mono caption on the tile, not as a second value', () => {
    // Two metred numbers to be compared, so they are mono and small; the tile's
    // value stays the one figure a reader takes away.
    expect(rule(RUNS, '.run-explorer .summary-grid small.tile-mono')).toContain('font-family: var(--font-mono)');
    expect(KPIS).toContain('tile-mono');
  });

  it('cannot be left with a label welded to its figure', () => {
    /*
     * THE REGRESSION THIS GUARDS IS A SHARED RECIPE THAT STOPPED ARRIVING.
     *
     * The five measurements are `.summary-grid`, whose recipe is written in
     * benchmark.css. When the page partials were moved out of index.css and
     * into lazy route imports, this page kept the markup and lost the rules:
     * five unstyled AppKit cards, drawn as thin full-bleed bars, each with its
     * label hard against its value -- "Wall time100.4s".
     *
     * So the claim is made twice. The cascade has to reach this page, and the
     * page's own partial has to floor the arrangement if it ever stops.
     */
    expect(partialNames(), 'the shared tile recipe is in the cascade').toContain('benchmark.css');
    expect(partialNames(), 'this page’s own partial is in the cascade').toContain('runs.css');

    const grid = rule(RUNS, '.run-explorer .summary-grid');
    expect(grid).toContain('display: grid');
    expect(grid).toContain('repeat(auto-fit, minmax(148px, 1fr))');

    // A column with a gap: the label above its value, never beside it, and
    // never touching it.
    const row = rule(RUNS, ".run-explorer .summary-grid [data-slot='card-content']");
    expect(row).toContain('flex-direction: column');
    expect(row).toContain('gap: 6px');
    expect(row).toContain('padding: 16px');
    expect(row).toContain('min-height: 138px');
    // And the figure never breaks mid-value at the detail pane's width.
    expect(rule(RUNS, '.run-explorer .summary-grid strong')).toContain('white-space: nowrap');
  });

  it('reserves the same value and subtitle geometry in all five cards', () => {
    expect(rule(RUNS, ".run-explorer .summary-grid [data-slot='card']")).toContain('height: 100%');
    expect(
      rule(RUNS, '.run-explorer .summary-grid .run-kpi-value,\n.run-explorer .summary-grid .run-kpi-feedback')
    ).toContain('min-height: 34px');
    const subtitle = rule(RUNS, '.run-explorer .summary-grid .run-kpi-subtitle');
    expect(subtitle).toContain('min-height: 2.7em');
    expect(subtitle).toContain('text-wrap: balance');
    expect(subtitle).toContain('overflow-wrap: anywhere');
  });

  it('gives directional feedback the visual weight of a KPI without colouring no-rating as positive', () => {
    const feedback = rule(RUNS, '.run-explorer .summary-grid .run-rating-badge--kpi');
    expect(feedback).toContain('font-size: var(--text-kpi)');
    expect(feedback).toContain('min-height: 34px');
    const icon = rule(RUNS, '.run-explorer .summary-grid .run-rating-badge--kpi > svg');
    expect(icon).toContain('width: 26px');
    expect(icon).toContain('height: 26px');
    const unrated = rule(RUNS, '.run-explorer .summary-grid .run-rating-badge--none.run-rating-badge--kpi');
    expect(unrated).toContain('color: var(--muted-foreground)');
    expect(unrated).toContain('background: transparent');
  });

  it('lets the KPI row reflow at both intrinsic and phone widths', () => {
    expect(rule(RUNS, '.run-explorer .summary-grid')).toContain('repeat(auto-fit, minmax(148px, 1fr))');
    expect(RESPONSIVE).toMatch(
      /@media \(max-width: 800px\)[\s\S]*?\.summary-grid\s*\{[^}]*grid-template-columns:\s*1fr/
    );
  });

  it('keeps the MLflow mark attached to its left-aligned link', () => {
    const link = rule(RUNS, '.trace-id-row > a');
    expect(link).toContain('display: inline-flex');
    expect(link).toContain('gap: 6px');
    expect(link).not.toContain('margin-left: auto');
  });
});

describe('the two surfaces that read a recorded run', () => {
  /**
   * They now read it through one component.
   *
   * This page had a timing view of its own, a waterfall, and these tests used to
   * pin the handful of properties it had been made to share with the answer
   * card's Gantt: the same bar colour, the same mono duration column, the same
   * weight for an outlier. That is the arrangement two copies always end in, and
   * the copies still disagreed where nobody had thought to look. The waterfall
   * floored a bar at 4% of its track so a label would fit inside it, and scaled
   * its axis to the last stage's end rather than the run's measured envelope, so
   * the same run drew differently on the two screens.
   *
   * So the claim is the stronger one: there is one timing view, this page renders
   * it, and none of the waterfall is left to drift back out of step.
   */
  it('renders the answer card’s timeline rather than a second view of its own', () => {
    expect(EXPLORER).toContain("import { TraceTimeline } from './TraceTimeline'");
    expect(EXPLORER).toMatch(/variant="explorer"/);
    expect(EXPLORER).toMatch(/<TraceTimeline[\s\S]*?trace=\{runTrace\.trace}/);
    expect(EXPLORER).not.toContain('function Waterfall');
  });

  it('keeps none of the waterfall, in markup or in the stylesheet', () => {
    // Comments stripped first. The page still explains in prose why the view it
    // used to draw is gone, and a test that failed on that would be asking us to
    // delete the explanation along with the code.
    const code = EXPLORER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/waterfall/i);
    expect(TIMELINE).not.toMatch(/\.waterfall/);
  });

  it('heads the panel with nothing at all', () => {
    // The tab used to print a reconciliation footnote above the chart -- "wall
    // clock 94.47s · 13 rows · recorded activity 94.39s · unaccounted 87ms ·
    // every row is measured". Five measurements of the drawing, in front of the
    // drawing, for a reader who came to see where the time went.
    //
    // This page lost it first and the answer card kept it on the control that
    // opened its panel; that line is now gone from there too, and the function
    // that built it no longer exists. This page simply draws the chart. Both the
    // wrapper it needed and its style went with it, so there is no empty flex
    // column left standing.
    expect(EXPLORER).not.toContain('traceHeadline');
    expect(EXPLORER).not.toContain('run-timeline');
    expect(TIMELINE).not.toContain('.run-timeline');
  });

  it('draws a step bar in the action colour, and an outlier by weight not by hue', () => {
    expect(rule(TIMELINE, '.trace-bar')).toContain('background: var(--chart-1)');
    expect(rule(TIMELINE, '.trace-gantt tbody .trace-duration')).toContain('font-family: var(--font-mono)');
    expect(TIMELINE).not.toMatch(/\.trace-bar[^{]*\{[^}]*(amber|gold)/i);
  });
});

describe('a run nobody has rated', () => {
  it('says so in words, and offers the way to supply one', () => {
    // An empty star reads as a rating of zero, which is a claim nobody made. The
    // link is blue because supplying a rating is an action.
    expect(RATING_BADGE).toContain('Not rated');
    expect(KPIS).toContain('Rate this run');
    expect(rule(BENCHMARK, '.summary-grid .tile-link')).toContain('color: var(--primary)');
    // And in the Lab's table, the same fact in the same register.
    expect(LAB).toContain('Not rated yet');
  });

  it('never stands a zero in for a figure the run did not record', () => {
    // A plausible number in place of a missing one is the defect class this whole
    // derivation exists to prevent. The property is that a missing metric renders
    // as SOMETHING THAT IS NOT A NUMBER; which token stands there is the copy rule
    // below, and the two screens no longer answer it the same way.
    expect(KPIS).toContain("const ABSENT = 'not set'");
    expect(LAB).toMatch(/'—'/);
  });

  it('says a missing figure in words on the Explorer, per the rebuild spec', () => {
    // §7: no em dashes, and unset renders "not set" in mono. A dash has to be READ
    // as absence, which is a convention the reader has to already hold; the rating
    // tile beside it has said "Not rated" in words since it landed.
    expect(KPIS).not.toMatch(/—/);
    // In mono, and in the secondary ink that stops "not set" reading as a result.
    expect(KPIS).toContain("return absent ? 'run-kpi-value ast-num tile-absent' : 'run-kpi-value ast-num'");
    expect(rule(BENCHMARK, '.summary-grid strong.tile-absent')).toContain('var(--muted-foreground)');
  });

  it('leaves the Benchmark Lab’s dash alone, because that file is another lane’s', () => {
    // Recorded rather than fixed: BenchmarkLab.tsx dashes the same fact and belongs
    // to the lane that owns the Lab. Two screens that read a recorded run should
    // say a missing figure the same way, so this is a divergence to close, not a
    // decision. Closing it here would mean editing a file this lane does not own.
    expect(LAB).toMatch(/'—'/);
  });
});

describe('the recorded-run rows, which used to be unreachable by keyboard', () => {
  it('puts a real button in the row, so the row is in the tab order', () => {
    // The gap being closed: `<tr onClick>` is operable with a mouse and with
    // nothing else, on the control that selects which run every figure above the
    // table describes. A button answers Enter and Space for free, which is the
    // reason to use one rather than to add a keydown handler to the row.
    const row = LAB.slice(LAB.indexOf('bench-run-row'));
    expect(row).toContain('type="button"');
    expect(row).toContain('className="bench-run-open"');
    // Selecting a run is a state, not a navigation, so it is announced as one.
    expect(row).toContain('aria-pressed={isSelected}');
    // The row keeps its own click for the rest of its width, and the button stops
    // the event so one press is not two selections.
    expect(row).toContain('event.stopPropagation()');
  });

  it('gives the selected row the blue edge treatment', () => {
    const active = rule(BENCHMARK, '.bench-run-row.active');
    expect(active).toContain('var(--db-selected-tint)');
    expect(active).toContain('var(--primary)');
  });
});

describe('what amber is allowed to be on the evaluation screen', () => {
  /*
   * The astrolabe amber, which is a different colour rather than a rename. It was
   * DuBois #FFAB00, a bright gold that reads as the orange §2 removed from the
   * palette; the family is #8A6A38 on #F9F6EF with a #7A5E32 deep rung. The
   * saturated rung, not the #E0D3B8 hairline, because every one of §9's three
   * uses is a filled mass.
   */
  it('gives the guidelines tile the evaluation treatment: a thick rule and a wash', () => {
    // 4px is still 4px: the rule reads at that weight rather than despite it now,
    // #8A6A38 being 4.83:1 on white where #FFAB00 was 1.90.
    const tile = rule(BENCHMARK, ".summary-grid [data-slot='card'].benchmark-score");
    expect(tile).toContain('border-top: 4px solid var(--ast-warn-text)');
    expect(tile).toContain('background: var(--ast-warn-fill)');
    // The type on that wash takes the deep rung, which is 5.53:1 on it.
    expect(BENCHMARK).toContain('color: var(--ast-warn-deep)');
    expect(LAB).toContain('className="benchmark-score"');
  });

  it('underlines the Rating column rather than tinting its header', () => {
    // Scoped away from the per-case table, whose last column is a duration: amber
    // there would say a timing had been evaluated.
    expect(rule(BENCHMARK, ".table-scroll:not(.bench-cases) [data-slot='table'] thead th:last-child")).toContain(
      'border-bottom: 3px solid var(--ast-warn-text)'
    );
  });

  it('leaves the button that starts a suite blue, because it is an action', () => {
    // The temptation on an evaluation screen is to paint its main button in the
    // evaluation colour, which would say the button is being judged.
    const button = LAB.slice(LAB.indexOf('<Button'), LAB.indexOf('</Button>'));
    expect(button).not.toMatch(/gold|amber/i);
  });
});

describe('the qualification ledger and the region below it', () => {
  // The three token names below are the astrolabe spellings. The values did not
  // move for the first two -- `--ast-border-input` and `--ast-fill-band` are the
  // same #CBCBCB and #F7F7F7 -- and the third did: the danger wash was DuBois
  // #FFF5F7 and is the palette's own #FAF3F5, which is the negative family every
  // other red on the page now takes.
  it('is one bordered ledger with a washed head and hairline-separated rows', () => {
    expect(rule(BENCHMARK, '.bench-ledger')).toContain('border: 1px solid var(--ast-border-input)');
    expect(rule(BENCHMARK, '.bench-ledger-head')).toContain('background: var(--ast-fill-band)');
    expect(rule(BENCHMARK, '.bench-ledger-row')).toContain('border-top: 1px solid var(--border)');
  });

  it('keeps the danger rows red, so a regroup did not cost them their tone', () => {
    expect(rule(BENCHMARK, '.bench-ledger-row.tone-danger')).toContain('background: var(--ast-neg-fill)');
  });

  it('keeps a run error and an outage as their own alerts above the ledger', () => {
    // A failed run and an unreachable store are not qualifications on a score;
    // they are the reasons there is no score, and they read as alerts.
    // Read inside the page's own function, because the panels below it are now
    // components declared elsewhere in the file and a whole-file search finds a
    // component's definition rather than the position it is mounted at.
    const page = LAB.slice(LAB.indexOf('export function BenchmarkLab()'));
    expect(page.indexOf('{runError && (')).toBeLessThan(page.indexOf('<BenchmarkLedger'));
    expect(page.indexOf('UnavailablePanel')).toBeLessThan(page.indexOf('<BenchmarkLedger'));
  });

  it('states per-case results as a designed region that is waiting, not as an error', () => {
    expect(LAB).toContain('Not reported per case yet');
    expect(LAB).toContain('bench-percase');
    expect(rule(BENCHMARK, ".bench-percase [data-slot='empty-title']")).toContain('font-weight: 700');
  });

  it('says which kind of nothing the per-case panel is showing', () => {
    // This empty state used to be permanent, and it used to say a run records
    // suite-level totals only. That was true when it was written and stopped being
    // true when the runner started writing a `cases` array the trace projection
    // already forwards, which made the panel's own claim the least accurate
    // sentence on a screen whose subject is honest reporting. So the panel renders
    // the run's cases when the run has them, and this empty state now has to say
    // which of the two remaining kinds of nothing a reader is looking at: a suite
    // that has not finished a case yet, or a run stored before cases were kept.
    // Neither branch may promise what a later release will do.
    // Read with the comments dropped, because the comment beside this cut quotes
    // the clause it describes.
    const prose = LAB.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\s+/g, ' ');
    const percase = prose.slice(prose.indexOf('Not reported per case yet'));
    const description = percase.match(/<EmptyDescription>([\s\S]*?)<\/EmptyDescription>/)![1].trim();
    expect(description).toContain('No case in this run has finished yet');
    expect(description).toContain('This run recorded suite-level totals only');
    expect(description).not.toContain('will appear here when');
  });
});
