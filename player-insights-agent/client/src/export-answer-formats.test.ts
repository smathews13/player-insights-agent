import { describe, expect, it } from 'vitest';
import { normalizeAnswer } from './answer-shape';
import {
  serializeAnswerHtml,
  serializeAnswerJson,
  serializeAnswerMarkdown,
  serializeChartJson,
} from './export-serializers';
import type { Chart } from './AnswerCharts';

/**
 * The three formats an answer exports to, beyond the Markdown the older suite covers.
 *
 * The through-line of every assertion is the same governance the Markdown path has:
 * tool-call JSON, generated SQL, attachment text and trace payloads never reach a
 * downloaded file. On top of that, each format has one job: HTML lays the answer out
 * as a document with the chart drawn in, JSON keeps the chart as a redrawable spec,
 * and the presentation theme paints the page black for a slide.
 */
const answer = normalizeAnswer({
  id: 'answer-1',
  takeaway: 'PC leads on players',
  narrative: [
    'The governed result follows.',
    'data_genie({"question":"secret diagnostics"})',
    '| Platform | Players |',
    '| --- | ---: |',
    '| PC | 42 |',
    '| PlayStation | 30 |',
  ].join('\n'),
  figures: [{ label: 'Players', value: 42, display: '42', comparison: 'up 5%' }],
  charts: [
    {
      id: 'c1',
      title: 'Players by platform',
      kind: 'bar',
      data: [{ type: 'bar', x: ['PC', 'PlayStation'], y: [42, 30] }],
      layout: { title: { text: 'Players by platform' } },
    },
  ],
  sources: [{ name: 'catalog.schema.player_daily', freshness: '2026-09-09', role: 'reading' }],
  caveats: ['Figures exclude anonymous players.'],
  document_snippets: [{ filename: 'hidden.pdf', quote: 'hidden attachment text', supports: 'claim' }],
  sql: 'SELECT secret_internal_column FROM internal_table',
  trace: { id: 'tr-1', stages: [{ id: 'raw', input: 'private input', output: 'private output' }] },
});

const chartImages = new Map([['c1', 'data:image/png;base64,AAAAB3NCatch']]);

interface AnswerJson {
  schema_version: string;
  question: string;
  headline: string;
  figures: { label: string; value: number; display: string | null; comparison: string }[];
  tables: { header: string[]; rows: string[][] }[];
  charts: { id: string; plotly: { data: { y: number[] }[] } }[];
  sources: { name: string }[];
  caveats: string[];
}

const parseAnswerJson = (json: string): AnswerJson => JSON.parse(json) as AnswerJson;

describe('answer HTML export', () => {
  it('is a self-contained document with prose, a real table, KPIs and sources', () => {
    const html = serializeAnswerHtml('How many players?', answer, chartImages);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('How many players?');
    expect(html).toContain('<table>');
    expect(html).toContain('<th');
    expect(html).toContain('>Platform<');
    expect(html).toContain('class="kpi"');
    expect(html).toContain('catalog.schema.player_daily');
  });

  it('draws the chart as an inlined image', () => {
    const html = serializeAnswerHtml('How many players?', answer, chartImages);
    expect(html).toContain('<img alt="Players by platform" src="data:image/png;base64,AAAAB3NCatch"');
  });

  it('omits the chart section when no image was rendered', () => {
    const html = serializeAnswerHtml('How many players?', answer);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('charts-section');
  });

  it('paints the page black under the presentation theme', () => {
    const slide = serializeAnswerHtml('How many players?', answer, chartImages, 'presentation');
    expect(slide).toContain('background:#000000');
    expect(slide).toContain('color-scheme:dark');
    const page = serializeAnswerHtml('How many players?', answer, chartImages, 'page');
    expect(page).toContain('background:#ffffff');
  });

  it('never leaks tool calls, SQL, attachment text or trace payloads', () => {
    const html = serializeAnswerHtml('How many players?', answer, chartImages);
    expect(html).not.toContain('data_genie');
    expect(html).not.toContain('secret_internal_column');
    expect(html).not.toContain('hidden attachment text');
    expect(html).not.toContain('private input');
  });
});

describe('answer JSON export', () => {
  it('is a canonical reader-safe document keyed by schema version', () => {
    const parsed = parseAnswerJson(serializeAnswerJson('How many players?', answer));
    expect(parsed.schema_version).toBe('pia.answer-export/1');
    expect(parsed.question).toBe('How many players?');
    expect(parsed.headline).toContain('PC leads on players');
    expect(parsed.figures).toEqual([{ label: 'Players', value: 42, display: '42', comparison: 'up 5%' }]);
    expect(parsed.sources[0].name).toBe('catalog.schema.player_daily');
    expect(parsed.caveats).toContain('Figures exclude anonymous players.');
  });

  it('carries tables as structured rows and charts as native Plotly specs, not images', () => {
    const parsed = parseAnswerJson(serializeAnswerJson('How many players?', answer));
    expect(parsed.tables[0].header).toEqual(['Platform', 'Players']);
    expect(parsed.tables[0].rows).toEqual([
      ['PC', '42'],
      ['PlayStation', '30'],
    ]);
    expect(parsed.charts[0].id).toBe('c1');
    expect(parsed.charts[0].plotly.data[0].y).toEqual([42, 30]);
    expect(JSON.stringify(parsed.charts)).not.toContain('data:image');
  });

  it('never leaks tool calls, SQL or trace payloads', () => {
    const json = serializeAnswerJson('How many players?', answer);
    expect(json).not.toContain('data_genie');
    expect(json).not.toContain('secret_internal_column');
    expect(json).not.toContain('private input');
  });
});

describe('single chart JSON export', () => {
  it('carries the native Plotly spec under a stable schema version', () => {
    const chart: Chart = {
      id: 'c1',
      title: 'Players by platform',
      kind: 'bar',
      data: [{ type: 'bar', x: ['PC', 'PlayStation'], y: [42, 30] }],
      layout: { title: { text: 'Players by platform' } },
    };
    const parsed = JSON.parse(serializeChartJson(chart)) as {
      schema_version: string;
      id: string;
      kind: string;
      plotly: { data: { y: number[] }[]; layout: Record<string, unknown> };
    };
    expect(parsed.schema_version).toBe('pia.chart-export/1');
    expect(parsed.id).toBe('c1');
    expect(parsed.kind).toBe('bar');
    expect(parsed.plotly.data[0].y).toEqual([42, 30]);
    expect(JSON.stringify(parsed)).not.toContain('data:image');
  });
});

describe('answer Markdown export with charts', () => {
  it('adds a charts section only when chart images are supplied', () => {
    expect(serializeAnswerMarkdown('How many players?', answer)).not.toContain('## Charts');
    const withCharts = serializeAnswerMarkdown('How many players?', answer, chartImages);
    expect(withCharts).toContain('## Charts');
    expect(withCharts).toContain('![Players by platform](data:image/png;base64,AAAAB3NCatch)');
    // Tables still ride along in the prose either way.
    expect(withCharts).toContain('| Platform | Players |');
  });
});
