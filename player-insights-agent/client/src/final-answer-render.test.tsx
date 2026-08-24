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
const IDENTITY =
  'This answer was produced as analyst@example.com and covers only the data that identity is granted.';
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
  it('titles a deadline-noted card as a final answer when the table already landed', () => {
    const html = markup();
    expect(html).toContain('Final answer');
    expect(html).toContain('data-tone="complete"');
    expect(html).not.toContain('Partial answer');
    expect(html).not.toContain('This question was not answered');
  });

  it('puts Live agent response at the true top-left, not under a mark', () => {
    const html = markup();
    const head = html.slice(html.indexOf('final-answer-head'), html.indexOf('final-answer-warnings'));
    expect(head).toContain('Live agent response');
    expect(head).toContain('Final answer');
    expect(head).toContain('data-tone="live"');
    expect(head).not.toContain('Partial answer');
    expect(head).not.toContain('final-answer-mark');
    expect(head).not.toContain('<svg');
    expect(html.indexOf('Live agent response')).toBeLessThan(html.indexOf('final-answer-takeaway'));
    const incomplete = markup({ truncated: false, caveats: [INCOMPLETE, IDENTITY] });
    expect(incomplete).toContain('Final answer');
    expect(incomplete).not.toContain('Incomplete answer');
  });

  it('lifts incomplete sources and the deadline into warning chips, not quiet bullets', () => {
    const html = markup();
    expect(html).toContain('Incomplete sources');
    expect(html).toContain('Turn deadline reached');
    expect(html).toContain('final-answer-warning');
    expect(html.indexOf('final-answer-warning')).toBeLessThan(html.indexOf('final-answer-takeaway'));
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

  it('lists each source as a path with one Open control, not a wrapping tangle', () => {
    const html = markup();
    expect(html).toContain('source-list');
    expect(html).toContain('silver_gameplay_activity');
    expect(html).not.toContain('source-line');
  });

  it('draws metric, window and filter as labeled rows, not one wrapping paragraph', () => {
    const html = markup();
    expect(html).toContain('source-list-derivation');
    expect(html).toContain('derivation-row');
    expect(html).toMatch(/<dt class="derivation-label">Metric<\/dt>/);
    expect(html).toMatch(/<dt class="derivation-label">Window<\/dt>/);
    expect(html).toMatch(/<dt class="derivation-label">Filter<\/dt>/);
    expect(html).toContain('unique_players');
    expect(html).not.toMatch(/<p class="source-list-derivation"/);
  });

  it('paints a real failure as a dark-red warning and identity as a secondary note', () => {
    const html = markup();
    expect(html).toContain('data-surface="failure"');
    expect(html).toContain('APITimeoutError');
    expect(html).toContain('data-surface="note"');
    expect(html).toContain('analyst@example.com');
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
});

describe('the Overview column width', () => {
  it('makes the Final Answer span the same column as the KPI tiles', () => {
    const css = partial('runs.css');
    expect(css).toMatch(/\.run-explorer \.final-answer \{[^}]*width:\s*100%/s);
    expect(css).toMatch(/\.run-explorer \.final-answer \{[^}]*max-width:\s*none/s);
  });
});

describe('the Overview warning family', () => {
  it('uses the Failed muted dark red, not the ochre warning wash', () => {
    const css = partial('runs.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(css).toMatch(/\.final-answer-warning \[data-slot='alert'\] \{[^}]*--ast-neg-fill/s);
    expect(css).toMatch(/\.final-answer-warning \[data-slot='alert'\] \{[^}]*--ast-neg-border/s);
    expect(css).not.toMatch(/\.final-answer-warning \{[^}]*--ast-warn-/s);
    expect(css).not.toMatch(/\.final-answer\[data-tone='partial'\] \{[^}]*--ast-warn-/s);
    const body = partial('answer-body.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(body).toMatch(/li\[data-surface='failure'\] \{[^}]*--ast-neg-fill/s);
    expect(body).toMatch(/li\[data-surface='note'\] \{[^}]*--ast-text-secondary/s);
  });

  it('pins the live badge at the start of the header row', () => {
    const css = partial('runs.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(css).toMatch(/\.final-answer-head \{[^}]*justify-self:\s*start/s);
    expect(css).toMatch(/\.final-answer-head \{[^}]*justify-content:\s*flex-start/s);
    expect(css).not.toMatch(/\.final-answer-mark/);
  });

  it('sits in the section corner with no padding gap under the KPI divider', () => {
    const css = partial('runs.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(css).toMatch(
      /\.final-answer \[data-slot='card-content'\] \{[^}]*padding:\s*0 20px 16px 8px/s
    );
    expect(css).not.toMatch(
      /\.final-answer \[data-slot='card-content'\] \{[^}]*padding:\s*18px/s
    );
  });
});
