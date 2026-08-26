import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnswerEvidence } from './AnswerEvidence';
import { carriesTable } from './answer-markdown';
import type { Chart } from './AnswerCharts';

/**
 * That one answer is not drawn as rows on one surface and as pictures on another.
 *
 * The live card folded its tables in behind its charts. The Run Explorer, showing
 * the same stored answer, printed the narrative whole -- tables included -- and
 * handed the run's charts to the Agent map tab. So the reader who opened a past
 * run saw the numbers as a table on Overview and the same numbers as a chart one
 * tab across, with nothing on either tab saying they were the same measurements.
 * That is the surface someone opens once they have started to doubt a figure,
 * which is the worst place to be shown two unreconciled copies of it.
 *
 * The rule lives in one component now, so it cannot hold on one surface and not
 * the other. These tests are the reason it may not be inlined again.
 */

const SOURCES = [{ name: 'catalog.schema.games', freshness: 'fresh' }];

const CHART: Chart = { id: 'c1', title: 'Sessions by week', kind: 'line', data: [], layout: {} };

const WITH_TABLE = ['Sessions rose.', '', '| Week | Sessions |', '| --- | --- |', '| 1 | 10 |'].join('\n');

function markup(props: Parameters<typeof AnswerEvidence>[0]): string {
  return renderToStaticMarkup(<AnswerEvidence {...props} />);
}

describe('the evidence half of an answer', () => {
  it('draws the rows when there is no chart to draw instead', () => {
    const html = markup({ narrative: WITH_TABLE, sources: SOURCES });
    expect(html).toContain('Table evidence');
    expect(html).toContain('<table');
    // No fold: there is nothing the table is hiding behind, so a control that
    // offered to reveal it would be offering what is already on screen.
    expect(html).not.toContain('Show the rows behind this');
  });

  it('folds the rows in behind a chart rather than dropping them', () => {
    const html = markup({ narrative: WITH_TABLE, charts: [CHART], sources: SOURCES });
    expect(html).toContain('Chart evidence');
    // Reachable, so nothing the agent measured is only ever in a picture.
    expect(html).toContain('Show the rows behind this');
  });

  it('says nothing at all when the answer measured nothing', () => {
    expect(markup({ narrative: 'A sentence with no figures in it.', sources: SOURCES })).toBe('');
  });

  it('reads the tables out of the second body too', () => {
    expect(carriesTable('prose only', WITH_TABLE)).toBe(true);
    expect(carriesTable('prose only', null)).toBe(false);
    expect(carriesTable(undefined)).toBe(false);
  });
});

describe('both surfaces that show an answer', () => {
  /**
   * Read rather than rendered: the Run Explorer fetches its own trace, so
   * mounting it here would assert against a loading skeleton. What is at stake is
   * which component the narrative is handed to, and that is visible in the source.
   */
  const explorer = readFileSync(new URL('./RunExplorer.tsx', import.meta.url), 'utf8');
  const finalAnswer = readFileSync(new URL('./FinalAnswer.tsx', import.meta.url), 'utf8');
  const card = readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8');

  it('hands the narrative to the same evidence component', () => {
    for (const source of [finalAnswer, card]) expect(source).toContain('<AnswerEvidence');
    expect(explorer).toContain('<FinalAnswer');
  });

  it('prints only the prose of the narrative, leaving its tables to the evidence', () => {
    // Unqualified, this printed every block including the tables, which is how
    // the Explorer came to show rows a chart was already showing.
    expect(finalAnswer).toMatch(/text=\{story\}[\s\S]{0,80}blocks="prose"/);
  });

  it('keeps the charts-or-rows rule out of the card, so it cannot drift', () => {
    // The card held its own copy of this. Two copies is how the Explorer's went
    // stale without anyone noticing.
    expect(card).not.toContain('answer-evidence');
    expect(card).not.toContain('Show the rows behind this');
  });
});
