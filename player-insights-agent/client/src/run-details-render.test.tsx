import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { RunDetails } from './RunDetails';
import { RunExplorer } from './RunExplorer';
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
const RUNS_CSS = readFileSync(new URL('./styles/runs.css', import.meta.url), 'utf8');

/** The page as the router mounts it, on the tab it opens on. */
function pageMarkup(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
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
  trace: {
    id: 'tr-feedface',
    totalMs: 43_740,
    toolCalls: 6,
    stages: [
      {
        id: 'run_sql-1',
        name: 'Querying governed data',
        kind: 'tool',
        start: 0,
        duration: 900,
        status: 'failed',
        calls: 2,
        input: '{"sql":"SELECT title FROM gold_title_daily_summary"}',
        output: 'The warehouse returned a retryable timeout.',
        retries: 1,
        error: 'WAREHOUSE_TIMEOUT',
      },
    ],
  },
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
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

/** The tab, drawn on its own, in whichever position the switch is in. */
function detailsMarkup(advanced: boolean, trace: RunTrace | null = TRACE): string {
  return renderToStaticMarkup(
    <RunDetails
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
    expect(markup).not.toContain('WAREHOUSE_TIMEOUT');
    expect(markup).not.toContain('retryable timeout');
  });
});

describe('what flipping it on does', () => {
  it('puts generated SQL and every stage payload on screen without another disclosure', () => {
    const markup = detailsMarkup(true);

    // Generated SQL remains its own readable block. Stage records are already
    // open: Advanced itself is the disclosure, so requiring every stage row to
    // be expanded again would leave the switch looking inert.
    expect(markup).toContain('semantic-code-keyword">SELECT</span>');
    expect(markup).toContain('Stage Raw I/O');
    expect(markup).toContain('Querying governed data');
    expect(markup).toContain('gold_title_daily_summary');
    expect(markup).toContain('retryable timeout');
    expect(markup).toContain('WAREHOUSE_TIMEOUT');
    expect(markup).toContain('<strong class="trace-payload-label">Retries</strong>');
    expect(markup).toContain('>1<');
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

  it('omits empty optional rows and renders a stored table listing with shared entity styling', () => {
    const table = '<your_catalog>.<your_schema>.gold_title_daily_summary';
    const trace = {
      ...TRACE,
      undeclaredKeys: [],
      trace: {
        ...TRACE.trace,
        stages: [
          {
            id: 'inventory',
            name: 'Listed available tables',
            kind: 'discovery',
            start: 0,
            duration: 1,
            status: 'complete',
            calls: 1,
            input: '{}',
            output: `Declared tables:\n  - ${table}  [franchise: Contoso]`,
            tables: [table],
            retries: 0,
            errors: [],
            unrelated_tool_payload: { authorization: 'Bearer do-not-render' },
          },
          {
            id: 'synthesis',
            name: 'Prepared the answer',
            kind: 'agent',
            start: 1,
            duration: 1,
            status: 'complete',
            calls: 1,
            input: '',
            output: '',
          },
        ],
      },
    } as unknown as RunTrace;

    const markup = detailsMarkup(true, trace);
    expect(markup).toContain('<span class="ast-num">1 stage</span>');
    expect(markup).toContain('gold_title_daily_summary');
    expect(markup).toContain('entity-table-mark');
    expect(markup).toContain('data-entity-part="table"');
    expect(markup).not.toContain('aria-label="Input payload"');
    expect(markup).not.toContain('aria-label="Retries payload"');
    expect(markup).not.toContain('aria-label="Errors payload"');
    expect(markup).not.toContain('not recorded');
    expect(markup).not.toContain('none recorded');
    expect(markup).not.toContain('do-not-render');
    expect(markup).not.toContain('unrelated_tool_payload');
  });

  it('keeps the trace id visible either way, because it is not payload', () => {
    // The MLflow handle is how anyone finds this run outside the app. It was
    // never behind the gate and must not end up there.
    for (const advanced of [false, true]) {
      expect(detailsMarkup(advanced)).toContain('tr-feedface');
    }
  });
});

describe('advanced token consumption', () => {
  const tokenTrace = {
    ...TRACE,
    trace: {
      ...TRACE.trace,
      prompt_tokens: 80_000,
      completion_tokens: 4_576,
      total_tokens: 84_576,
      stages: [
        {
          ...TRACE.trace!.stages[0],
          id: 'step-1',
          name: 'Chose the next step',
          token_usage: {
            inputTokens: 80_000,
            outputTokens: 4_576,
            totalTokens: 84_576,
            cacheStatus: 'unavailable',
            attempts: 2,
            totalMismatch: false,
          },
        },
      ],
      token_reconciliation: {
        attributedTokens: 84_576,
        attributedCalls: 2,
        overviewTokens: 84_576,
        coveragePercent: 100,
        nestedAggregateTokens: 0,
        mismatchCount: 0,
      },
      token_invocations: [
        {
          invocationId: 'span-1',
          stageId: 'step-1',
          attempt: 1,
          inputTokens: 40_000,
          outputTokens: 2_000,
          totalTokens: 42_000,
          cacheStatus: 'unavailable',
          attempts: 1,
          totalMismatch: false,
        },
        {
          invocationId: 'span-2',
          stageId: 'step-1',
          attempt: 2,
          inputTokens: 40_000,
          outputTokens: 2_576,
          totalTokens: 42_576,
          cacheStatus: 'unavailable',
          attempts: 1,
          totalMismatch: false,
        },
      ],
    },
  } as unknown as RunTrace;

  it('shows the reconciled the demo workspace total, one cache-unavailable state, and invocation attempts', () => {
    const markup = readable(detailsMarkup(true, tokenTrace));
    expect(markup).toContain('Token consumption 84,576 total');
    expect(markup).toContain('Run input 80,000');
    expect(markup).toContain('Run output 4,576');
    expect(markup).toContain('Run total 84,576');
    expect(markup).toContain('Cache Not reported');
    expect(markup).toContain('Attributed coverage 84,576 tokens · 100.0% of run total');
    expect(markup).toContain('Unattributed difference 0');
    expect(markup).toContain('Component and invocation token usage');
    expect(markup).toContain('Component / turn Attempt Input Output Total tokens Cached tokens');
    expect(markup).not.toContain('Cache status');
    expect(markup).toContain('Orchestrator turn 1 1 40,000 2,000 42,000 Not reported');
    expect(markup).toContain('Orchestrator turn 1 2 40,000 2,576 42,576 Not reported');
  });

  it('renders one unavailable state and no invocation table for a legacy trace', () => {
    const legacy = { ...TRACE, trace: { ...TRACE.trace, stages: [] } } as unknown as RunTrace;
    const markup = detailsMarkup(true, legacy);
    expect(markup).toContain('Token evidence is not available for this run.');
    expect(markup).not.toContain('Component and invocation token usage');
    expect(markup).not.toContain('Unattributed difference');
  });

  it('shows cached tokens after the authoritative total without adding them twice', () => {
    const cachedTrace = {
      ...tokenTrace,
      trace: {
        ...tokenTrace.trace!,
        token_invocations: tokenTrace.trace!.token_invocations!.map((invocation, index) =>
          index === 0 ? { ...invocation, cachedReadTokens: 12_345, cacheStatus: 'used' as const } : invocation
        ),
      },
    } as RunTrace;
    const markup = readable(detailsMarkup(true, cachedTrace));

    expect(markup).toContain('Orchestrator turn 1 1 40,000 2,000 42,000 12,345');
    expect(markup).toContain('Run total 84,576');
    expect(markup).not.toContain('96,921');
  });

  it('wraps the invocation table without creating another scroller', () => {
    expect(RUNS_CSS).toMatch(/\.token-invocations\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*visible/s);
    expect(RUNS_CSS).toMatch(/\.token-invocations table\s*\{[^}]*min-width:\s*0[^}]*table-layout:\s*fixed/s);
    expect(RUNS_CSS).toMatch(/\.token-invocations th:first-child\s*\{[^}]*width:\s*30%/s);
    expect(RUNS_CSS).toMatch(/\.token-invocations th:nth-child\(n \+ 3\)\s*\{[^}]*width:\s*15%/s);
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
    expect(markup).toContain('Open in MLflow experiment');
    expect(markup.indexOf('Open in MLflow experiment')).toBeLessThan(markup.indexOf('tr-deadbeef…beef'));
  });

  it('says how to get the link when no experiment is saved', () => {
    const markup = detailsMarkup(false);

    expect(markup).toContain('Save an MLflow experiment on the Connections page');
    expect(markup).not.toContain('Open in MLflow experiment');
  });
});

describe('the generated SQL block', () => {
  it('counts the statements and gives each one its own block', () => {
    const markup = detailsMarkup(true, LONG);

    expect(markup).toContain('Generated SQL');
    expect(markup).toContain('2 statements');
    expect(markup.match(/<pre class="semantic-sql-code semantic-sql-code--block"/g)).toHaveLength(2);
  });

  it('breaks a statement at its clauses instead of wrapping one long line', () => {
    const markup = detailsMarkup(true, LONG);

    for (const clause of ['SELECT', 'FROM', 'WHERE']) {
      expect(markup).toContain(
        `<span class="sql-line"><span class="semantic-code-token semantic-code-keyword">${clause}</span>`
      );
    }
  });

  it('colours the keywords and leaves the names alone', () => {
    const markup = detailsMarkup(true, LONG);

    expect(markup).toContain('semantic-code-keyword">ILIKE</span>');
    expect(markup).toContain('semantic-code-keyword">IS NOT NULL</span>');
    expect(markup).toContain('semantic-code-keyword">COUNT</span>');
    expect(markup).toContain('semantic-code-keyword">DISTINCT</span>');
    // A backticked identifier is the one thing on the line that is certainly not
    // the language, so it keeps the colour of a name even when it reads as a
    // keyword. `usage_guardrail` carries no keyword; `table_name` is the check
    // that the pattern is not matching inside backticks at all.
    expect(markup).not.toContain('semantic-code-keyword">table_name</span>');
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
  it('does not print a definition on the Overview tiles', () => {
    const markup = pageMarkup();
    expect(markup).not.toContain('How long this run took from end to end');
    expect(markup).not.toContain('How many tokens the model gateway metred');
  });
});
