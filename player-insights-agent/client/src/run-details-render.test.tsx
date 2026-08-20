import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { RunDetails } from './RunDetails';
import { KPI_HINTS, RunExplorer } from './RunExplorer';
import type { RunTrace } from './app-types';

/**
 * Whether the Advanced switch can be on screen while doing nothing.
 *
 * It was, and it was reported as "advanced toggle here doesn't work or do
 * anything". The switch sat in the page header; the only thing that read it was
 * the Details tab; the page opens on Overview. So flipping it animated a control
 * and changed nothing anywhere in the document, which is indistinguishable from
 * a feature that is broken -- and is worse than a missing feature, because the
 * reader concludes the app lies about what it can do.
 *
 * Rendered rather than read, and that distinction is the reason this file exists
 * rather than three more assertions in a source-text test. Every statement about
 * this switch that anyone would have thought to write down was TRUE while it was
 * inert: it was bound to state, the state was read, the panels it governs were
 * conditioned on it correctly, and the empty state told the reader exactly what
 * to do. What was false was a relationship between two parts of the tree that no
 * single file could see. Only mounting the page can catch that.
 */

const CONTROL = 'role="switch"';
/** A sentence that appears on the Details tab and nowhere else on the page. */
const DETAILS = 'sanitized before display';

/** The page as the router mounts it, on the tab it opens on. */
function pageMarkup(): string {
  return renderToStaticMarkup(<MemoryRouter>
      <RunExplorer />
    </MemoryRouter>
  );
}

/**
 * A stored trace with something to show behind the gate. Cast because the shape
 * has twenty fields and this exercises four of them; every one that is here is
 * here because the Details tab reads it.
 */
const TRACE = {
  sql: 'SELECT title, SUM(active_players) FROM gold_title_daily_summary GROUP BY title',
  undeclaredKeys: ['retry_of'],
  mlflow: { traceId: 'tr-feedface', experimentId: null, url: null },
  trace: { id: 'tr-feedface', totalMs: 43_740, toolCalls: 6, stages: [] },
} as unknown as RunTrace;

/**
 * What the tab reads as, with the tags taken out.
 *
 * The summary line's three figures are each in their own `.ast-num` span now, so
 * a claim about the SENTENCE cannot be made against the markup: "9 tool calls" is
 * split across a tag boundary. What is being asserted is the wording a reader
 * sees, which is what this leaves behind.
 */
function readable(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
}

/** The tab, drawn on its own, in whichever position the switch is in. */
function detailsMarkup(advanced: boolean, trace: RunTrace | null = TRACE): string {
  return renderToStaticMarkup(<RunDetails
      trace={trace}
      advanced={advanced}
      onAdvancedChange={() => {}}
      unavailable={<p>No trace for this run</p>}
    />
  );
}

describe('the Advanced switch', () => {
  it('is not in the document on the tab the page opens on', () => {
    // The defect exactly. This assertion failed before the switch moved: the
    // control was in the header of every tab, and the header is drawn once.
    const markup = pageMarkup();

    expect(markup).not.toContain(CONTROL);
    expect(markup).not.toContain('Advanced');
  });

  it('is on screen only where the panels it governs are', () => {
    // The general form, and the property that has to survive future edits: the
    // control and its effect appear together or not at all. Stated as an
    // equality so that it is not satisfied by both of them being missing on some
    // future tab, nor by the control coming back to a header that outlives them.
    const page = pageMarkup();
    const tab = detailsMarkup(false);

    expect(page.includes(CONTROL)).toBe(page.includes(DETAILS));
    expect(tab.includes(CONTROL)).toBe(tab.includes(DETAILS));
    expect(tab).toContain(CONTROL);
  });

  it('is rendered in one place, so it cannot be given a second home', () => {
    // Source-level and deliberately so: the render tests above can only speak
    // about the tabs they mount. A switch added back to the page header would be
    // caught by the first of them, but one added to the run list or the detail
    // head would not, and the property being protected is that this control has
    // exactly one definition.
    const explorer = readFileSync(new URL('./RunExplorer.tsx', import.meta.url), 'utf8');

    expect(explorer).not.toContain('<Switch');
    expect(explorer).not.toContain('advanced-toggle');
  });
});

describe('what the Details tab says when the switch is off', () => {
  it('names the control and where it now is', () => {
    const markup = detailsMarkup(false);

    expect(markup).toContain('Advanced details are hidden');
    expect(markup).toContain('Turn on Advanced, at the top of this tab');
  });

  it('no longer points at a control on another part of the screen', () => {
    // "Turn on Advanced ABOVE" was the tell. It was a direction to the page
    // header, given on the one tab where following it would have worked, and it
    // is the sentence that shows the empty state and the switch were written by
    // someone who could see both and never checked whether the reader could.
    expect(detailsMarkup(false)).not.toContain('above');
  });

  it('shows nothing of the payload while it is off', () => {
    const markup = detailsMarkup(false);

    expect(markup).not.toContain('SELECT title');
    expect(markup).not.toContain('retry_of');
  });
});

describe('what flipping it on does', () => {
  it('puts the generated SQL and the raw trace on screen', () => {
    const markup = detailsMarkup(true);

    // `SELECT` is picked out from the name after it, so the statement is no
    // longer one run of text. The trace arrives as the figures read off it and a
    // shut caret rather than as ninety-six lines of JSON; both are below.
    expect(markup).toContain('<b>SELECT</b> title');
    expect(markup).toContain('Raw JSON');
    expect(markup).not.toContain('Advanced details are hidden');
  });

  it('says which undeclared fields the run carried', () => {
    expect(detailsMarkup(true)).toContain('fields the app does not render yet: retry_of');
  });

  it('says why there is nothing to show rather than showing an empty panel', () => {
    // A run with no stored trace. The switch is on, so the empty state above is
    // the wrong answer -- the reader asked for the payload and the honest reply
    // is that this run has none, not that they forgot to ask.
    const markup = detailsMarkup(true, null);

    expect(markup).toContain('No trace for this run');
    expect(markup).not.toContain('Advanced details are hidden');
  });

  it('keeps the trace id visible either way, because it is not payload', () => {
    // The MLflow handle is how anyone finds this run outside the app. It was
    // never behind the gate and must not end up there.
    for (const advanced of [false, true]) {
      expect(detailsMarkup(advanced)).toContain('tr-feedface');
    }
  });
});

/**
 * A trace with the parts the panel is built to show: a long enough id to be cut,
 * two statements recorded as one field, and stages to count.
 */
const LONG = {
  sql: "SELECT `table_name`, `usage_guardrail` FROM `<your_catalog>`.`data_dictionary` WHERE `column_name` ILIKE '%player_id%' AND `business_definition` IS NOT NULL; SELECT COUNT(DISTINCT `player_id`) AS distinct_players FROM `silver_player_profiles`",
  undeclaredKeys: [],
  mlflow: {
    traceId: 'tr-deadbeefdeadbeefdeadbeefdeadbeef',
    experimentId: 'e1',
    url: 'https://example.databricks.com/ml/experiments/e1',
  },
  trace: { id: 'tr-1', totalMs: 51_611.94, toolCalls: 9, stages: [{ id: 'step-1' }, { id: 'step-2' }] },
} as unknown as RunTrace;

describe('the trace id row', () => {
  it('cuts the id on the page and copies it whole', () => {
    const markup = detailsMarkup(false, LONG);

    expect(markup).toContain('tr-deadbeef…beef');
    expect(markup).toContain('title="tr-deadbeefdeadbeefdeadbeefdeadbeef"');
    expect(markup).toContain('Copy the full trace id');
  });

  it('is a row rather than a titled card', () => {
    // The title said "MLflow trace" over a wrapped 35-character id: a heading
    // and two lines to carry one value whose only uses are being copied and
    // being opened, both of which now sit on the row beside it.
    const markup = detailsMarkup(false, LONG);

    expect(markup).toContain('trace-id-row');
    expect(markup).not.toContain('MLflow trace</div>');
    expect(markup).toContain('Open in the MLflow experiment');
  });

  it('says how to get the link when no experiment is saved', () => {
    const markup = detailsMarkup(false);

    expect(markup).toContain('Save an MLflow experiment on the Connections page');
    expect(markup).not.toContain('Open in the MLflow experiment');
  });
});

describe('the generated SQL block', () => {
  it('counts the statements and gives each one its own block', () => {
    const markup = detailsMarkup(true, LONG);

    expect(markup).toContain('Generated SQL');
    expect(markup).toContain('2 statements');
    expect(markup.match(/<pre>/g)).toHaveLength(2);
  });

  it('breaks a statement at its clauses instead of wrapping one long line', () => {
    const markup = detailsMarkup(true, LONG);

    for (const clause of ['SELECT', 'FROM', 'WHERE']) {
      expect(markup).toContain(`<span class="sql-line"><b>${clause}</b>`);
    }
  });

  it('colours the keywords and leaves the names alone', () => {
    const markup = detailsMarkup(true, LONG);

    expect(markup).toContain('<b>ILIKE</b>');
    expect(markup).toContain('<b>IS NOT NULL</b>');
    expect(markup).toContain('<b>COUNT</b>');
    expect(markup).toContain('<b>DISTINCT</b>');
    // A backticked identifier is the one thing on the line that is certainly not
    // the language, so it keeps the colour of a name even when it reads as a
    // keyword. `usage_guardrail` carries no keyword; `table_name` is the check
    // that the pattern is not matching inside backticks at all.
    expect(markup).not.toContain('<b>table_name</b>');
  });

  it('offers the whole field on the clipboard, not the reformatted lines', () => {
    // Copy has to paste into a SQL editor and run. What is on screen is broken at
    // clauses for reading; what goes on the clipboard is what the run recorded.
    expect(detailsMarkup(true, LONG)).toContain('Copy the generated SQL');
  });

  it('draws nothing at all rather than an empty block when there is no SQL', () => {
    const markup = detailsMarkup(true, { ...LONG, sql: '   ' } as unknown as RunTrace);

    expect(markup).not.toContain('Generated SQL');
  });
});

describe('the trace summary', () => {
  it('states what the trace amounts to', () => {
    const markup = detailsMarkup(true, LONG);

    expect(readable(markup)).toContain('51.61s total · 9 tool calls · 2 stages');
    // Each figure in mono and the words around it in the body face, which is §3's
    // rule read the right way round. The whole line used to be mono, labels
    // included, from a font-family on `.trace-summary-head > span`.
    expect(markup).toContain('<span class="ast-num">51.61s</span> total');
  });

  it('keeps the JSON shut, and says how much is behind the caret', () => {
    // The dump used to render open, which put the whole stage record between the
    // reader and everything else on the tab. The line count is the measure of
    // what opening it costs.
    const markup = detailsMarkup(true, LONG);

    expect(markup).toContain('Raw JSON');
    expect(readable(markup)).toMatch(/· \d+ lines/);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('&quot;toolCalls&quot;: 9');
  });

  it('counts one stage and one call without a stray plural', () => {
    const one = { ...LONG, trace: { id: 'tr-1', totalMs: 900, toolCalls: 1, stages: [{ id: 'a' }] } };
    const markup = detailsMarkup(true, one as unknown as RunTrace);

    expect(readable(markup)).toContain('900ms total · 1 tool call · 1 stage');
  });
});

describe('what each figure on the Overview grid means', () => {
  it('carries its own definition into the document, on every one of the five tiles', () => {
    // Rendered rather than read, for the reason this file exists: the sentences
    // are handed to a component from another package, and a source-text test
    // would pass just as happily if that component dropped the attribute. Which
    // it would, if the tiles were ever rebuilt out of plain divs.
    const markup = pageMarkup();

    for (const hint of Object.values(KPI_HINTS)) {
      expect(markup).toContain(hint);
    }
  });
});
