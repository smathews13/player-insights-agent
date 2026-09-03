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

describe('answer hierarchy', () => {
  it('keeps the supplied takeaway exact and renders ordered context bullets directly below it', () => {
    const supplied = '42 million unique users';
    const markup = card(
      answer({
        takeaway: supplied,
        narrative: [
          supplied,
          '- Lifetime window: `2013-10-01` through `2026-09-01`.',
          '- Counted by `brand_firstpartyid`.',
          '- Read from `main.game.daily_summary`.',
        ].join('\n'),
      })
    );
    const headline = /class="[^"]*answer-takeaway[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(markup)?.[1] ?? '';
    const plainHeadline = headline.replace(/<[^>]+>/g, '').trim();
    const visible = markup.replace(/<[^>]+>/g, '');
    const bullets = [...markup.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((match) =>
      match[1].replace(/<[^>]+>/g, '').trim()
    );

    expect(plainHeadline).toBe(supplied);
    expect(visible.split(supplied)).toHaveLength(2);
    expect(bullets.slice(0, 3).map((bullet) => bullet.replace(/&#x27;/g, "'"))).toEqual([
      'Lifetime window: 2013-10-01 through 2026-09-01.',
      'Counted by brand_firstpartyid.',
      'Read from main.game.daily_summary.',
    ]);
    expect(markup.indexOf('answer-takeaway')).toBeLessThan(markup.indexOf('<ul class="answer-list"'));
  });

  it('keeps legacy prose readable without heuristically turning it into claims', () => {
    const legacy =
      'Across the recorded period, returning players increased. The older payload stores this as one paragraph.';
    const markup = card(answer({ takeaway: 'Returning players increased.', narrative: legacy }));

    expect(markup).toContain(`<p>${legacy}</p>`);
    expect(markup).not.toMatch(/<li[^>]*>Across the recorded period/);
  });
});

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

  it('keeps figures in the answer data without rendering KPI tiles', () => {
    const markup = card(answer());
    expect(answer().figures).toHaveLength(5);
    expect(markup).not.toContain('answer-stat');
    expect(markup).not.toContain('Key figures');
    expect(markup).not.toContain('Historical extra');
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
    expect(css).toMatch(/\.answer-card > \[data-slot='card-content'\]\s*\{[^}]*padding-bottom:\s*24px/);
  });
});

describe('full-width answer body', () => {
  const css = partial('answer-body.css');
  it('reserves no second column at any card width', () => {
    expect(css).not.toContain('.answer-main-row');
    expect(css).not.toContain('.answer-stat-rail');
    expect(css).not.toContain('.answer-stat');
    expect(css).not.toMatch(/@container answer-card/);
  });

  it('lets narrative and evidence start at the full content width without a transition', () => {
    expect(css).toMatch(/\.answer-narrative \{[^}]*display:\s*grid[^}]*min-width:\s*0/s);
    expect(css).not.toMatch(/grid-template-columns:[^;]*(190px|230px)/);
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
    expect(ask).toMatch(/\.conversation-main \.answer-card > \[data-slot='card-header'\] \{[^}]*padding:\s*8px;/s);
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

  it('uses one monospace treatment and bolds the marked table segment', () => {
    expect(css).toMatch(/\.entity-token\s*\{[^}]*font-family:\s*var\(--font-mono\)/s);
    expect(css).toMatch(/\.entity-token\[data-entity-part='table'\]\s*\{[^}]*font-weight:\s*700/s);
  });

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
          id: 'tr-1',
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
    expect(markup).toContain('Answer incomplete');
    expect(markup).not.toContain('No steps recorded.');
    expect(markup).not.toContain('data-tone="stored"');
    expect(markup).toContain('data-tone="failed"');
  });

  it('does not draw a process view when stages arrived with no MLflow id', () => {
    const markup = processCard(
      answer({
        takeaway: 'Sessions reached 25 on the final day.',
        caveats: [],
        trace: {
          id: 'trace-local',
          totalMs: 77_000,
          toolCalls: 2,
          stages: [
            {
              id: 'step-1',
              name: 'Querying governed data',
              kind: 'tool',
              status: 'complete',
              start: 0,
              duration: 40_000,
              calls: 1,
              input: '',
              output: '',
            },
          ],
        },
      })
    );
    expect(markup).not.toContain('run-process');
    expect(markup).not.toContain('Querying governed data');
    expect(markup).not.toContain('Step timeline');
    expect(markup).not.toContain('Advanced trace details');
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
    expect(markup).toContain('The sources for this answer are incomplete');
    expect(markup).not.toContain('data-variant="destructive"');
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

  it('states the actionable retry when the response format is incomplete', () => {
    const markup = processCard(
      answer({
        takeaway: 'The agent did not return a structured result.',
        narrative: '',
        figures: [],
        sources: [],
        sql: '',
        caveats: [`${DEGRADED_ANSWER_MARKER} no structured result arrived and no tool steps were recorded.`],
        trace: { id: 'tr-1', stages: [] },
      })
    );
    expect(markup).toContain('Answer incomplete');
    expect(markup).toContain('data-tone="failed"');
    expect(markup).toContain('Retry the question before using this result.');
    expect(markup).not.toMatch(/No steps|no structured result/i);
  });
});
