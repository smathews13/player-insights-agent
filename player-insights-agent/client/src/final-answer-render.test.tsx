import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { FinalAnswer } from './FinalAnswer';
import { partial } from './styles/stylesheet';

/**
 * How a stored run's answer is read on the Overview tab.
 *
 * Rendered, because the defect was a card that looked finished: "FINAL ANSWER"
 * over a data_genie dump, an ASCII grid, tangled catalog paths, and quiet
 * bullets that said the turn had hit its deadline. Source-text assertions
 * cannot see that; composing the module can.
 */

const GRID = [
  'platform | total_distinct_players | avg_sessions',
  'PC | 18402 | 12.4',
  'PlayStation 5 | 15110 | 11.1',
  'Xbox Series X|S | 9804 | 10.8',
].join('\n');

const NARRATIVE = [
  'data_genie({"question": "For the title \\"Iron Frontier Reckoning 2\\", distinct players by platform"})',
  '',
  'PC led on distinct players over the window.',
  '',
  GRID,
].join('\n');

const INCOMPLETE =
  'The sources for this answer are incomplete: part of it came from a query whose tables could not be determined.';
const DEADLINE = 'The turn deadline was reached before the answer could be written.';
const IDENTITY = 'This answer was produced as analyst@example.com and covers only the data that identity is granted.';
const TIMEOUT =
  'The model that writes the answer was not reachable: the reasoning endpoint failed (APITimeoutError: Request timed out.).';

const SOURCE = {
  name: 'main.player_insights.silver_gameplay_activity',
  freshness: 'Read during this run',
};

function markup(extra: Partial<Parameters<typeof FinalAnswer>[0]> = {}): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <FinalAnswer
        takeaway="The analysis completed from assessed sources."
        narrative={NARRATIVE}
        sources={[SOURCE]}
        caveats={[INCOMPLETE, DEADLINE, IDENTITY, TIMEOUT]}
        derivation={[
          {
            source: SOURCE.name,
            metric: 'unique_players',
            window: 'all dates in dataset',
            filter: "title_name ilike '%vlh%'",
          },
        ]}
        truncated
        conversationId="conv-1"
        runId="run-1"
        {...extra}
      />
    </MemoryRouter>
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the Overview Final Answer module', () => {
  it('titles a writer-timeout card as a partial answer when the table already landed', () => {
    const html = markup();
    expect(html).toContain('Partial answer');
    expect(html).toContain('data-tone="partial"');
    expect(html).not.toContain('This question was not answered');
  });

  it('titles a finished catalog listing Complete when DSF clipped optional detail', () => {
    const html = markup({
      takeaway:
        'All 12 declared tables live in **`<your_catalog>.<your_schema>`** and are available to query.',
      narrative: '| Table | Purpose |\n| --- | --- |\n| gold_player_180d_summary | Aggregates |',
      caveats: [],
      truncated: false,
    });
    expect(html).toContain('Final answer');
    expect(html).not.toContain('Partial answer');
    expect(html).toMatch(/final-answer-takeaway[\s\S]*<strong[\s\S]*<code[\s\S]*<your_catalog>/);
    expect(html).not.toContain('**');
  });

  it('titles a finished answer Final when only a deadline note remains', () => {
    const html = markup({ caveats: [INCOMPLETE, DEADLINE, IDENTITY], truncated: true });
    expect(html).toContain('Final answer');
    expect(html).not.toContain('This question was not answered');
  });

  it('pairs Live agent response with one polished static PIA mark', () => {
    const html = markup();
    const head = html.slice(html.indexOf('final-answer-head'), html.indexOf('final-answer-takeaway'));
    expect(head).toContain('Live agent response');
    expect(head).toContain('Partial answer');
    expect(head).toContain('data-tone="live"');
    expect(head).toContain('final-answer-mark');
    expect(head).toContain('width="28"');
    expect(head).not.toContain('pia-anim');
    expect(html.indexOf('Live agent response')).toBeLessThan(html.indexOf('final-answer-takeaway'));
    const incomplete = markup({ truncated: false, caveats: [INCOMPLETE, IDENTITY] });
    expect(incomplete).toContain('Final answer');
    expect(incomplete).not.toContain('Incomplete answer');
  });

  it('keeps specific warnings under the exact Caveats heading without an inline banner', () => {
    const html = markup();
    expect(html).toContain('The sources for this answer are incomplete');
    expect(html).toContain('The turn deadline was reached');
    expect(html).toContain('>Caveats</h3>');
    expect(html).toContain('aria-label="Caveats"');
    expect(html).not.toContain('Keep in mind');
    expect(html).not.toContain('What to keep in mind');
    expect(html).not.toContain('Partial evidence');
    expect(html).not.toContain('final-answer-warning');
    expect(html).not.toContain('data-variant="destructive"');
  });

  it('never dumps the tool call as the story', () => {
    const html = markup();
    expect(html).not.toContain('data_genie');
    expect(text(html)).not.toContain('"question"');
    expect(html).toContain('PC led on distinct players');
  });

  it('draws the ASCII grid as a table', () => {
    const html = markup();
    expect(html).toContain('<table');
    expect(html).toContain('PC');
    expect(html).toContain('18402');
    expect(html).toContain('Xbox Series X|S');
    expect(html).not.toMatch(/platform \| total_distinct_players/);
  });

  it('lists each source as a bullet with one Open control, not a wrapping tangle', () => {
    const html = markup();
    expect(html).toContain('source-list');
    expect(html).toContain('source-list-row');
    expect(html).toContain('silver_gameplay_activity');
    expect(html).not.toContain('source-line');
  });

  it('draws metric, window and filter as nested bullets, not one wrapping paragraph', () => {
    const html = markup();
    expect(html).toContain('source-list-derivation');
    expect(html).toContain('derivation-fact');
    expect(html).toMatch(/<span class="derivation-label">Metric /);
    expect(html).toMatch(/<span class="derivation-label">Window /);
    expect(html).toMatch(/<span class="derivation-label">Filter /);
    expect(html).toContain('unique_players');
    expect(html).not.toMatch(/<p class="source-list-derivation"/);
  });

  it('paints a real failure as a dark-red warning and does not draw the identity lecture', () => {
    const html = markup();
    expect(html).toContain('data-surface="failure"');
    expect(html).toContain('APITimeoutError');
    expect(html).not.toContain('analyst@example.com');
    expect(html).not.toContain('covers only the data that identity is granted');
  });

  it('keeps Open full response inside the card', () => {
    const html = markup();
    expect(html).toContain('final-answer');
    expect(html).toMatch(/class="final-answer-open"[^>]*>Open full response →/);
    expect(html.indexOf('source-list')).toBeLessThan(html.indexOf('final-answer-open'));
  });

  it('leaves a clean finished run titled as a final answer', () => {
    const html = markup({
      takeaway: 'PC led on distinct players.',
      narrative: 'PC led on distinct players over the window.',
      caveats: [IDENTITY],
      truncated: false,
    });
    expect(html).toContain('Final answer');
    expect(html).toContain('data-tone="complete"');
    expect(html).not.toContain('final-answer-warning');
  });

  it('keeps a concise takeaway exact above its ordered supporting bullets', () => {
    const supplied = '42 million unique users';
    const html = markup({
      takeaway: supplied,
      narrative: '- Lifetime window.\n- Person-level counting key.\n- Governed source.',
      caveats: [],
      truncated: false,
    });
    const headline = /class="final-answer-takeaway"[^>]*>([\s\S]*?)<\/h4>/.exec(html)?.[1] ?? '';
    expect(headline.replace(/<[^>]+>/g, '').trim()).toBe(supplied);
    expect(html.indexOf(supplied)).toBeLessThan(html.indexOf('Lifetime window.'));
    expect(html.indexOf('Lifetime window.')).toBeLessThan(html.indexOf('Person-level counting key.'));
    expect(html.indexOf('Person-level counting key.')).toBeLessThan(html.indexOf('Governed source.'));
    const context = /<ul class="answer-list">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
    expect(context.match(/<li\b/g)).toHaveLength(3);
  });
});

describe('the Overview column width', () => {
  it('makes the Final Answer span the same column as the KPI tiles', () => {
    const css = partial('runs.css');
    expect(css).toMatch(/\.run-explorer \.final-answer \{[^}]*width:\s*100%/s);
    expect(css).toMatch(/\.run-explorer \.final-answer \{[^}]*max-width:\s*none/s);
  });

  it('reads the Final Answer body at the same 14px rung as AnswerCard', () => {
    const runs = partial('runs.css');
    const answer = partial('answer.css');
    expect(runs).toMatch(/\.final-answer \.answer-prose \{[^}]*font-size:\s*var\(--ast-fs-14\)/s);
    expect(answer).toMatch(/\.answer-prose \{[^}]*font-size:\s*var\(--ast-fs-14\)/s);
  });
});

describe('the Overview warning family', () => {
  it('uses caveat surfaces instead of an inline answer warning family', () => {
    const css = partial('runs.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(css).not.toContain('.final-answer-warning');
    expect(css).not.toMatch(/\.final-answer\[data-tone='partial'\] \{[^}]*--ast-warn-/s);
    const body = partial('answer-body.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(body).toMatch(/li\[data-surface='failure'\] \{[^}]*--ast-neg-fill/s);
    expect(body).toMatch(/li\[data-surface='note'\] \{[^}]*--ast-text-secondary/s);
  });

  it('pins the static mark and live badge at the start of the header row', () => {
    const css = partial('runs.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(css).toMatch(/\.final-answer-head \{[^}]*justify-self:\s*start/s);
    expect(css).toMatch(/\.final-answer-head \{[^}]*justify-content:\s*flex-start/s);
    expect(css).toMatch(/\.final-answer-mark\s*\{[^}]*width:\s*28px[^}]*height:\s*28px/s);
  });

  it('sits in the section corner with no padding gap under the KPI divider', () => {
    const css = partial('runs.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(css).toMatch(/\.final-answer \[data-slot='card-content'\][^}]*padding:\s*8px 20px 16px 8px/s);
    expect(css).not.toMatch(/\.final-answer-head \{[^}]*margin-inline:\s*-/s);
    expect(css).toMatch(/\.run-explorer \.final-answer \{[^}]*padding:\s*0/s);
    expect(css).not.toMatch(/\.final-answer \[data-slot='card-content'\] \{[^}]*padding:\s*18px/s);
  });

  it('lets compact-run Caveats expand inside the pane scroll owner', () => {
    const css = partial('runs.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const answer = partial('answer-body.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(css).toMatch(/\.run-detail \{[^}]*overflow-x:\s*clip[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.final-answer \[data-slot='card-content'\],[^{]*\{[^}]*display:\s*grid[^}]*gap:\s*14px/s);
    expect(answer).toMatch(
      /\.keep-in-mind \{[^}]*height:\s*auto[^}]*max-height:\s*none[^}]*overflow-x:\s*clip[^}]*overflow-y:\s*visible/s
    );
    expect(answer).toMatch(
      /\.keep-in-mind \.answer-list \{[^}]*gap:\s*8px[^}]*font-size:\s*var\(--ast-fs-13\)[^}]*line-height:\s*1\.5/s
    );
  });
});
