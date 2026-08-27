import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnswerCard } from './AnswerCard';
import { AnswerProse } from './DataEntityLinks';
import { KeepInMind } from './KeepInMind';
import { SourcesModule } from './SourcesModule';
import { normalizeAnswer, type WireAnswer } from './answer-shape';
import { parseAnswerMarkdown, tableStoryMetadata } from './answer-markdown';
import { DEGRADED_ANSWER_MARKER } from './degraded-answer';
import { partial } from './styles/stylesheet';
import type { Answer, FeedbackEntry } from './app-types';

const TABLE = [
  'Opening sentence survives.',
  '',
  '- Sessions accelerated.',
  '',
  '| Date | Sessions |',
  '| --- | ---: |',
  '| 2026-08-01 | 10 |',
  '| 2026-08-02 | 25 |',
].join('\n');

const feedback: FeedbackEntry = {
  open: false,
  comment: '',
  saved: false,
  saving: false,
  error: null,
  usefulness: null,
};

function answer(extra: Partial<WireAnswer> = {}): Answer {
  return normalizeAnswer({
    id: 'answer-1',
    mode: 'live',
    provenance: 'live',
    takeaway: 'Sessions reached 25 on the final day.',
    narrative: TABLE,
    figures: [
      { label: 'Baseline', value: 10, display: '10', comparison: 'Aug 1' },
      { label: 'Peak', value: 25, display: '25', comparison: 'Aug 2' },
      { label: 'Delta', value: 150, display: '+150%', comparison: 'vs baseline' },
      { label: 'Window', value: 2, display: '2 days', comparison: 'complete' },
      { label: 'Historical extra', value: 7, display: '7', comparison: 'retained' },
    ],
    sources: [],
    caveats: [],
    sql: '',
    trace: { stages: [] },
    ...extra,
  }) as Answer;
}

function card(value: Answer): string {
  return renderToStaticMarkup(
    <AnswerCard
      answer={value}
      feedback={feedback}
      onFeedbackChange={() => {}}
      saveFeedback={async () => {}}
      showFeedback={false}
      showRunProcess={false}
    />
  );
}

describe('answer evidence variants', () => {
  it('renders prose plus table evidence when no chart exists', () => {
    const markup = card(answer());
    expect(markup).toContain('Opening sentence survives.');
    expect(markup).toContain('<table');
    expect(markup).toContain('aria-label="Table evidence"');
  });

  it('renders charts and folds the Markdown table away when a chart exists', () => {
    const markup = card(
      answer({
        charts: [{ id: 'chart-1', title: 'Daily sessions', kind: 'line', data: [], layout: {} }],
      })
    );
    expect(markup).toContain('Daily sessions');
    expect(markup).toContain('aria-label="Chart evidence"');
    // Charts XOR tables still holds on screen: the rows are not drawn beside the
    // panel they would duplicate.
    expect(markup).not.toContain('<table');
    expect(markup.match(/Opening sentence survives\./g)).toHaveLength(1);
  });

  it('leaves the folded rows reachable rather than dropping them', () => {
    /*
     * The rule is about what the reader is SHOWN, not about what the answer may
     * keep. A chart summarises -- the pair rule plots a full series beside a recent
     * window -- so the rows behind it can hold dates and values no panel plots, and
     * before this control there was nowhere to go for them. It also matters when a
     * panel will not draw: see the boundary test below.
     */
    const markup = card(
      answer({
        charts: [{ id: 'chart-1', title: 'Daily sessions', kind: 'line', data: [], layout: {} }],
      })
    );
    expect(markup).toContain('Show the rows behind this');
  });

  it('offers no rows control when the tables are the evidence already', () => {
    // Nothing is folded on a table answer, so a control promising rows that are
    // already on screen would be a disclosure over nothing.
    const markup = card(answer());
    expect(markup).not.toContain('Show the rows behind this');
    expect(markup).toContain('<table');
  });

  it('sends a chart that will not draw to the rows instead of to a dead end', () => {
    /*
     * Read off the source rather than by throwing from Plotly: the boundary is a
     * class component reached through `lazy`, and what has to be pinned is the wiring
     * -- the panel telling the evidence section, and that section opening the fold.
     * Rendered, this needs a failing dynamic import, which is a chunk fetch this
     * suite has no way to fail honestly.
     *
     * The wiring sits in AnswerEvidence.tsx, which the Run Explorer shows too, so
     * a chart that will not draw reaches its rows on both surfaces.
     */
    const evidenceSource = readFileSync(new URL('./AnswerEvidence.tsx', import.meta.url), 'utf8');
    const chartSource = readFileSync(new URL('./AnswerCharts.tsx', import.meta.url), 'utf8');
    expect(chartSource).toContain('this.props.onFailure?.()');
    expect(evidenceSource).toContain('onFailure={() => setShowRows(true)}');
  });

  it('keeps every figure in the stat rail, including historical extras', () => {
    const markup = card(answer());
    expect(markup.match(/class="answer-stat"/g)).toHaveLength(5);
    expect(markup).toContain('Historical extra');
    expect(markup).not.toContain('Result breakdown');
  });
});

describe('table story metadata', () => {
  function table(source: string) {
    const block = parseAnswerMarkdown(source).find((candidate) => candidate.kind === 'table');
    if (!block || block.kind !== 'table') throw new Error('expected a table');
    return block;
  }

  it('tags the baseline and measured peak for a genuine date series', () => {
    expect(tableStoryMetadata(table(TABLE)).timeSeries).toBe(true);
    const markup = renderToStaticMarkup(<AnswerProse text={TABLE} sources={[]} blocks="tables" />);
    expect(markup).toContain('data-story="baseline"');
    expect(markup).toContain('data-story="peak"');
    expect(markup).toContain('>baseline</span>');
    expect(markup).toContain('>peak</span>');
  });

  it('does not call the final date peak when the measured series declined', () => {
    const decline = [
      '| Date | Sessions |',
      '| --- | ---: |',
      '| 2026-08-01 | 10 |',
      '| 2026-08-02 | 25 |',
      '| 2026-08-03 | 18 |',
    ].join('\n');
    const metadata = tableStoryMetadata(table(decline));
    expect(metadata.timeSeries).toBe(true);
    expect(metadata.peakRowStart).not.toBe(metadata.baselineRowStart);
    const markup = renderToStaticMarkup(<AnswerProse text={decline} sources={[]} blocks="tables" />);
    expect(markup.match(/data-story="peak"/g)).toHaveLength(1);
    expect(markup).toMatch(/data-story="peak"[^>]*>[\s\S]*2026-08-02/);
  });

  it('still names the peak when the series only ever fell', () => {
    /*
     * A series that declines from its opening row peaks on that row, so the baseline
     * row and the peak row are one row. The renderer chose between the two labels and
     * the baseline branch won, so the peak went unlabelled on exactly the tables where
     * "this was the high point, and it has fallen since" is the finding.
     */
    const decline = [
      '| Date | Sessions |',
      '| --- | ---: |',
      '| 2026-08-01 | 25 |',
      '| 2026-08-02 | 18 |',
      '| 2026-08-03 | 10 |',
    ].join('\n');
    const metadata = tableStoryMetadata(table(decline));
    expect(metadata.peakRowStart).toBe(metadata.baselineRowStart);
    const markup = renderToStaticMarkup(<AnswerProse text={decline} sources={[]} blocks="tables" />);
    expect(markup).toContain('>baseline</span>');
    expect(markup).toContain('>peak</span>');
    // One row wears both, and no later row is relabelled to make that true.
    expect(markup.match(/answer-table-story-tag/g)).toHaveLength(2);
    expect(markup.match(/data-story=/g)).toHaveLength(1);
  });

  it('does not call inventory rows baseline or peak', () => {
    const inventory = '| Item | Count |\n| --- | ---: |\n| Swords | 10 |\n| Shields | 25 |';
    expect(tableStoryMetadata(table(inventory))).toEqual({ timeSeries: false });
    const markup = renderToStaticMarkup(<AnswerProse text={inventory} sources={[]} blocks="tables" />);
    expect(markup).not.toContain('data-story=');
    expect(markup).not.toContain('answer-table-story-tag');
  });
});

describe('bullet provenance and caveats', () => {
  it('lists each source as its own bullet and includes recorded roles and derivation facts', () => {
    const markup = renderToStaticMarkup(
      <SourcesModule
        sources={[{ name: 'main.game.daily', freshness: '', role: 'reading' }]}
        caveats={[]}
        derivation={[{ source: 'main.game.daily', metric: 'sessions', window: '7 days', filter: 'title = A' }]}
      />
    );
    expect(markup.match(/<ul class="answer-list source-list">/g)).toHaveLength(1);
    expect(markup.match(/<li class="source-list-row"/g)).toHaveLength(1);
    expect(markup).not.toContain('source-line');
    expect(markup).toContain('Queried for the figures');
    expect(markup).toContain('sessions');
    expect(markup).toContain('7 days');
    expect(markup).toContain('title = A');
  });

  it('shows exactly three caveats and reports the folded remainder', () => {
    const caveats = ['one', 'two', 'three', 'four', 'five'];
    const markup = renderToStaticMarkup(<KeepInMind caveats={caveats} sources={[]} />);
    expect(markup.match(/<li\b/g)).toHaveLength(3);
    expect(markup).toContain('show more');
    expect(markup).not.toMatch(/Show all \d/);
    expect(markup).not.toMatch(/\d more/);
  });
});

describe('the answer card remains the substantial reading surface', () => {
  const css = partial('answer.css').replace(/\/\*[\s\S]*?\*\//g, ' ');

  it('uses the thicker edge, inset, and minimum body height together', () => {
    expect(css).toMatch(
      /\.answer-card\s*\{[^}]*border:\s*1px solid var\(--ast-hairline\)[^}]*border-top:\s*4px solid var\(--ast-blue\)[^}]*min-height:\s*280px/
    );
    // A flex parent with a max-height (the Monitoring dialog, Ask's column)
    // used the 280px floor as permission to shrink the card and paint later
    // siblings through the tables. The card keeps its floor and does not shrink.
    expect(css).toMatch(/\.answer-card\s*\{[^}]*flex-shrink:\s*0/s);
    expect(css).toMatch(/\.answer-card\s*\{[^}]*overflow:\s*visible/s);
    // 28px inline is the body's frame. The header is no longer the pair to
    // that: the provenance chip sits in the top-left corner, not a gutter down.
    expect(css).toMatch(
      /\.answer-card > \[data-slot='card-header'\],\s*\.answer-card > \[data-slot='card-content'\]\s*\{[^}]*padding-inline:\s*28px/
    );
    expect(css).toMatch(
      /\.answer-card > \[data-slot='card-content'\]\s*\{[^}]*padding-bottom:\s*24px/
    );
  });
});

describe('responsive answer rail', () => {
  const css = partial('answer-body.css');
  it('gives the figures a column only on a card wide enough to spare one', () => {
    /*
     * The design's card is the narrative with the figures down its right-hand
     * side, and the card is drawn that way wherever it is wide enough to be.
     *
     * Both of the readings this rule has swung between are true, at different
     * widths. A fixed rail at every width left the narrative around 450px on a
     * laptop holding an open inspector, which is a bulleted claim wrapping every
     * eight words. No rail at any width is the design's card with its right-hand
     * column deleted. So the threshold is a CONTAINER query on the card -- the
     * only box whose width actually decides this -- and not a viewport query and
     * not a global choice.
     */
    expect(css).toMatch(/@container answer-card \(min-width: 840px\)/);
    const sideRail = css.slice(css.indexOf('@container answer-card (min-width: 840px)'));
    expect(sideRail).toMatch(/\.answer-main-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(190px, 230px\)/s);
    // Stacked is still the base rule, so a narrow card needs no override to get
    // it: the Monitoring drawer is 620px and never enters the query above.
    expect(css).toMatch(/\.answer-main-row \{[^}]*display: grid/s);
    // Not a viewport question. The transcript column is the window less two
    // rails and four insets, any of which can be absent.
    expect(css).not.toMatch(/@media[^{]*\{[^}]*\.answer-stat-rail/s);
    expect(css).not.toMatch(/\.answer-stat-rail \{[^}]*flex: 0 0/s);
  });

  it('lays the figures out in as many columns as the card can hold', () => {
    // `auto-fit` rather than one wide cell each: stacked, the rail is as wide as
    // the card, and two 340px cells holding a 163px figure is a scan row with
    // half its width unused.
    expect(css).toMatch(/\.answer-stat-rail \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(190px, 1fr\)\)/s);
    expect(css).toMatch(/\.answer-stat-rail \{[^}]*width: 100%/s);
    // 190px and the value's size are one decision: 190px of box is 170px of
    // text, and 16px DM Mono puts "3,118 player-days" at 163px. At the old
    // 172/18px pair the last break opportunity that fitted was the HYPHEN, so
    // the rail printed "3,118 player-" above "days".
    expect(css).toMatch(/\.answer-stat-value \{[^}]*font-size: var\(--ast-fs-16\)/s);
    // And one figure per row once the rail IS a rail: `auto-fit` inside a 230px
    // track would fit two 190px cells side by side and clip them both.
    const sideRail = css.slice(css.indexOf('@container answer-card (min-width: 840px)'));
    expect(sideRail).toMatch(/\.answer-stat-rail \{[^}]*grid-template-columns: minmax\(0, 1fr\)/s);
  });
});

describe('the answer card’s state chip sits in its top left corner', () => {
  const css = partial('answer.css').replace(/\/\*[\s\S]*?\*\//g, ' ');

  it('pins the mark and the badge row to the start of the header grid', () => {
    // The head is a grid, so this row stretches to its track by default and any
    // later `justify-content` on it could slide "Live agent response" inward.
    expect(css).toMatch(/\.answer-card-identity \{[^}]*justify-self: start/s);
    expect(css).toMatch(/\.answer-card-identity \{[^}]*justify-content: flex-start/s);
  });

  it('sits in the header start with no large padding-top gap under the card edge', () => {
    const header = css.slice(css.lastIndexOf(".answer-card > [data-slot='card-header'] {"));
    const rule = header.slice(0, header.indexOf('}'));
    expect(rule).toMatch(/padding:\s*8px;/);
    expect(rule).not.toMatch(/padding:\s*0;/);
    expect(rule).not.toMatch(/padding:\s*0 8px/);
    expect(rule).not.toMatch(/padding-top:\s*(1[2-9]|2[0-9])px/);
    const ask = partial('ask.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(ask).toMatch(
      /\.conversation-main \.answer-card > \[data-slot='card-header'\] \{[^}]*padding:\s*8px;/s
    );
    expect(ask).not.toMatch(
      /\.conversation-main \.answer-card > \[data-slot='card-header'\] \{[^}]*padding-top:\s*(1[2-9]|2[0-9])px/s
    );
    const monitoring = partial('monitoring.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(monitoring).toMatch(
      /\.monitoring-question-modal \.answer-card > \[data-slot='card-header'\] \{[^}]*padding:\s*8px;/s
    );
    expect(monitoring).not.toMatch(
      /\.monitoring-question-modal \.answer-card > \[data-slot='card-header'\] \{[^}]*padding-top:\s*(1[2-9]|2[0-9])px/s
    );
    expect(css).toMatch(/\.answer-card-identity \.identity-chip \{[^}]*max-width:\s*150px/s);
  });

  it('draws it before the takeaway rather than beside or under it', () => {
    const card = readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8');
    const head = card.slice(card.indexOf('answer-card-head'), card.indexOf('</CardHeader>'));
    expect(head.indexOf('answer-card-identity')).toBeLessThan(head.indexOf('answer-takeaway'));
  });
});

describe('an identifier chip is one chip, on one line', () => {
  const css = partial('answer.css').replace(/\/\*[\s\S]*?\*\//g, ' ');

  it('moves a chip down whole instead of tearing it across the break', () => {
    // `clone` keeps a fragment properly drawn if one ever happens; `nowrap` is
    // what stops `silver_gameplay_activity` becoming two boxes a reader has to
    // reassemble. Safe because a qualified name is one chip per segment.
    expect(css).toMatch(/\.entity-token,\s*\.entity-mark,\s*\.answer-badge \{[^}]*white-space: nowrap/s);
    expect(css).toMatch(/\.entity-token,\s*\.entity-mark,\s*\.answer-badge \{[^}]*box-decoration-break: clone/s);
  });
});

describe('a failed run’s process', () => {
  const failedCaveat = `${DEGRADED_ANSWER_MARKER} the run stopped after 2 steps without a structured result.`;

  function processCard(value: Answer): string {
    return renderToStaticMarkup(
      <AnswerCard
        answer={value}
        feedback={feedback}
        onFeedbackChange={() => {}}
        saveFeedback={async () => {}}
        showFeedback={false}
      />
    );
  }

  it('still draws the timeline when the run had stages', () => {
    const markup = processCard(
      answer({
        takeaway: 'This question was not answered.',
        narrative: '',
        figures: [],
        sources: [],
        sql: '',
        caveats: [failedCaveat],
        trace: {
          stages: [
            {
              id: 'step-1',
              name: 'Chose the next step',
              kind: 'agent',
              status: 'complete',
              start: 0,
              duration: 12,
              calls: 1,
              input: '',
              output: '',
            },
            {
              id: 'step-2',
              name: 'Querying governed data',
              kind: 'tool',
              status: 'failed',
              start: 12,
              duration: 40,
              calls: 1,
              input: '',
              output: '',
            },
          ],
        },
      })
    );
    expect(markup).toContain('Step timeline');
    expect(markup).toContain('Querying governed data');
    expect(markup).toContain('failed');
    expect(markup).toContain('Failed after 2 steps');
    expect(markup).not.toContain('This run recorded no steps');
    expect(markup).not.toContain('data-tone="stored"');
    expect(markup).toContain('data-tone="failed"');
  });

  it('does not call a tabled answer unanswered because sources were incomplete', () => {
    const markup = card(
      answer({
        takeaway: 'This question was not answered.',
        caveats: [
          'The sources for this answer are incomplete: part of it came from a query whose tables could not be determined.',
          'The turn deadline was reached before the answer could be written.',
        ],
        trace: {
          stages: [
            {
              id: 'synthesis',
              name: 'Wrote the answer',
              kind: 'agent',
              status: 'complete',
              start: 0,
              duration: 20,
              calls: 1,
              input: '',
              output: '',
            },
          ],
        },
      })
    );
    expect(markup).not.toContain('This question was not answered.');
    expect(markup).not.toContain('Incomplete answer');
    expect(markup).not.toContain('Partial answer');
    expect(markup).toContain('Incomplete sources');
    expect(markup).toContain('<table');
    expect(markup).toContain('Opening sentence survives.');
  });

  it('does not paint a successful table listing as Request refused', () => {
    const liveWording =
      'Declaring a table does not guarantee read access; Unity Catalog grants are evaluated per query and a refusal will be named explicitly if it occurs.';
    const markup = card(
      answer({
        takeaway: 'This deployment declares 12 tables in the player insights schema.',
        caveats: [
          'These 12 tables are declared by the deployment; Unity Catalog grant evaluation happens at query time, so the signed-in user may not have SELECT access to all of them. Any refused table will be named explicitly if a query against it fails.',
          liveWording,
        ],
      })
    );
    expect(markup).not.toContain('Request refused');
    expect(markup).not.toContain('does not guarantee read access');
    expect(markup).toContain('<table');
  });

  it('renders nested bold+code in the takeaway so the schema name has no asterisks', () => {
    const markup = card(
      answer({
        takeaway:
          'All 12 declared tables live in **`<your_catalog>.<your_schema>`** and are available to query.',
      })
    );
    expect(markup).toMatch(/answer-takeaway[\s\S]*<strong[\s\S]*<code[\s\S]*<your_catalog>\.<your_schema>/);
    expect(markup).not.toContain('**');
  });

  it('does not put Reference / Metadata in a list item', () => {
    const markup = renderToStaticMarkup(
      <AnswerProse
        text={[
          '**Gold (aggregates — preferred starting point)**',
          '- `gold_player_180d_summary`: Per-player aggregates.',
          '',
          '- **Reference / Metadata**',
          '- `data_dictionary`: Field definitions.',
        ].join('\n')}
        sources={[]}
      />
    );
    expect(markup).toContain('<p><strong>Reference / Metadata</strong></p>');
    expect(markup).not.toContain('<li><strong>Reference / Metadata</strong>');
    expect(markup).toMatch(/<li\b[^>]*>[\s\S]*data_dictionary/);
    expect(markup).toContain('<p><strong>Gold (aggregates — preferred starting point)</strong></p>');
  });

  it('still says no result was recorded when the run truly had no steps', () => {
    const markup = processCard(
      answer({
        takeaway: 'The agent did not return a structured result.',
        narrative: '',
        figures: [],
        sources: [],
        sql: '',
        caveats: [`${DEGRADED_ANSWER_MARKER} no structured result arrived and no tool steps were recorded.`],
        trace: { stages: [] },
      })
    );
    expect(markup).toContain('No result recorded');
    expect(markup).toContain('This run recorded no steps');
    expect(markup).toContain('data-tone="failed"');
    expect(markup.match(/No steps and no structured result were recorded/g)?.length).toBe(1);
  });
});
