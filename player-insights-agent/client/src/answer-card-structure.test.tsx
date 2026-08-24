import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnswerCard } from './AnswerCard';
import { AnswerProse } from './DataEntityLinks';
import { KeepInMind } from './KeepInMind';
import { SourcesModule } from './SourcesModule';
import { normalizeAnswer, type WireAnswer } from './answer-shape';
import { parseAnswerMarkdown, tableStoryMetadata } from './answer-markdown';
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

describe('compact provenance and caveats', () => {
  it('uses one source paragraph and includes recorded roles and derivation facts', () => {
    const markup = renderToStaticMarkup(
      <SourcesModule
        sources={[{ name: 'main.game.daily', freshness: '', role: 'reading' }]}
        caveats={[]}
        derivation={[{ source: 'main.game.daily', metric: 'sessions', window: '7 days', filter: 'title = A' }]}
      />
    );
    expect(markup.match(/<p class="source-line">/g)).toHaveLength(1);
    expect(markup).toContain('Queried for the figures');
    expect(markup).toContain('sessions');
    expect(markup).toContain('7 days');
    expect(markup).toContain('title = A');
  });

  it('shows exactly three caveats and reports the folded remainder', () => {
    const caveats = ['one', 'two', 'three', 'four', 'five'];
    const markup = renderToStaticMarkup(<KeepInMind caveats={caveats} sources={[]} />);
    expect(markup.match(/<li>/g)).toHaveLength(3);
    expect(markup).toContain('Show all 5 · 2 more');
  });
});

describe('responsive answer rail', () => {
  const css = partial('answer-body.css');
  it('wraps the stat rail below the card breakpoint without viewport coupling', () => {
    // Still a container query and not a media query: the card's width is what
    // decides this, and the card is one column of a three-column page, so a
    // viewport width cannot answer for it.
    expect(css).toMatch(/@container answer-card \(max-width: \d+px\)/);
    expect(css).toContain('grid-template-columns: repeat(auto-fit, minmax(190px, 1fr))');
    expect(css).not.toMatch(/@media[^{]*\{[^}]*\.answer-stat-rail/s);
  });

  it('gives the prose the whole card until a side rail still leaves it a measure', () => {
    /*
     * The threshold was 639px while `.answer-card` carries `min-width:
     * min(640px, 100%)`, so the stacked arrangement was unreachable on any
     * ordinary window and the 190px side rail was effectively unconditional.
     *
     * That is what "the answer cards are too narrow" was. The middle column is
     * `100vw` less a 264px rail and a 340px inspector, so a 1440px laptop gets a
     * card about 730px wide; take the card's insets, the rail and its gap off
     * that and the narrative is reading in roughly 450px.
     *
     * The number is derived, so this test states the derivation rather than the
     * number: furniture is the rail, its gap, both card insets and both borders,
     * and what is left at the threshold has to clear a real measure for 13px
     * prose.
     */
    const threshold = Number(css.match(/@container answer-card \(max-width: (\d+)px\)/)?.[1] ?? 0);
    const rail = Number(css.match(/\.answer-stat-rail \{[^}]*flex: 0 0 (\d+)px/s)?.[1] ?? 0);
    const gap = Number(css.match(/\.answer-main-row \{[^}]*gap: (\d+)px/s)?.[1] ?? 0);
    expect(rail).toBe(190);
    const furniture = rail + gap + 24 * 2 + 2;
    expect(threshold + 1 - furniture, 'the measure a side rail leaves the prose').toBeGreaterThanOrEqual(580);
    // And the rail's own width and value size are one decision: 190px of box is
    // 170px of text, and 16px DM Mono puts "3,118 player-days" at 163px. At the
    // old 172/18px pair the last break opportunity that fitted was the HYPHEN,
    // so the rail printed "3,118 player-" above "days".
    expect(css).toMatch(/\.answer-stat-value \{[^}]*font-size: var\(--ast-fs-16\)/s);
  });
});
