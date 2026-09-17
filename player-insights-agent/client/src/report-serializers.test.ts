import { describe, expect, it } from 'vitest';
import { normalizeReport, type Report } from '../../shared/report-contract';
import { reportCharts, serializeReportHtml, serializeReportJson, serializeReportMarkdown } from './report-serializers';

/**
 * A report is an agent-authored, multi-section document. These cover the two halves:
 * the contract normaliser that turns the wire's open shape into a report (dropping
 * empty sections, refusing a titleless payload), and the three serializers that lay
 * the same sections out as HTML, Markdown and JSON.
 */
const wire = {
  type: 'report',
  title: 'Major Contoso franchises: cross-play overlap',
  subtitle: 'Share of each franchise that has played another Acme title',
  theme: 'presentation',
  summary: 'Players rarely stay inside one franchise. The overlap below argues for reading the whole catalog.',
  sections: [
    {
      heading: 'WWE',
      figures: [
        { label: '% played another T2 franchise', value: '62%' },
        { label: '% played a Northwind franchise', value: '48%' },
        { label: '% played a Contoso franchise', value: '71%' },
      ],
      note: 'Highest Northwind crossover of the set.',
    },
    {
      heading: 'Overlap by franchise',
      table: {
        title: 'Cross-play by franchise',
        columns: ['Franchise', '% other T2', '% Northwind', '% other Contoso'],
        align: ['left', 'right', 'right', 'right'],
        rows: [
          ['WWE', '62%', '48%', '71%'],
          ['Hoops', '70%', '55%', '64%'],
        ],
        sources: ['cdp_share_prod.acme_xlabel_prod.t2_master_table'],
      },
      charts: [
        {
          id: 'overlap',
          title: 'Cross-play overlap',
          kind: 'bar',
          plotly: { data: [{ type: 'bar', x: ['WWE', 'Hoops'], y: [62, 70] }], layout: {} },
        },
      ],
    },
    { heading: 'Empty section that should be dropped' },
  ],
  sources: [{ name: 'cdp_share_prod.acme_xlabel_prod.t2_master_table', freshness: '2026-09-14' }],
  caveats: ['Overlap counts a player once per franchise pair.'],
  generatedAt: '2026-09-16',
};

const report = normalizeReport(wire) as Report;
const chartImages = new Map([['overlap', 'data:image/png;base64,ZZ==']]);

describe('report contract normalisation', () => {
  it('keeps only usable sections and carries the design hint', () => {
    expect(report).not.toBeNull();
    expect(report.theme).toBe('presentation');
    // The heading-only third section carried nothing and was dropped.
    expect(report.sections).toHaveLength(2);
    expect(report.sections[0].figures).toHaveLength(3);
    expect(report.sections[1].table?.columns).toEqual(['Franchise', '% other T2', '% Northwind', '% other Contoso']);
  });

  it('refuses a payload with no title or no section', () => {
    expect(normalizeReport({ title: '', sections: [] })).toBeNull();
    expect(normalizeReport({ title: 'Only a title', sections: [] })).toBeNull();
    expect(normalizeReport({ sections: [{ heading: 'x' }] })).toBeNull();
  });

  it('drops a chart with no traces and a figure with no value', () => {
    const normalized = normalizeReport({
      title: 'T',
      sections: [
        {
          heading: 'S',
          figures: [{ label: 'blank' }, { label: 'good', value: '5' }],
          charts: [{ id: 'empty', title: 'x', kind: 'bar', plotly: { data: [] } }],
        },
      ],
    });
    expect(normalized?.sections[0].figures).toEqual([{ label: 'good', value: '5' }]);
    expect(normalized?.sections[0].charts).toBeUndefined();
  });
});

describe('report HTML export', () => {
  const html = serializeReportHtml(report, chartImages);

  it('lays out the title, section headings, KPIs and the table', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Major Contoso franchises: cross-play overlap');
    expect(html).toContain('<h3>WWE</h3>');
    expect(html).toContain('class="kpi"');
    expect(html).toContain('62%');
    expect(html).toContain('<table>');
    expect(html).toContain('Sources: cdp_share_prod.acme_xlabel_prod.t2_master_table');
  });

  it('honours the presentation theme from the report and draws the chart image', () => {
    expect(html).toContain('background:#000000');
    expect(html).toContain('<img alt="Cross-play overlap" src="data:image/png;base64,ZZ=="');
  });

  it('lets the caller override the theme to a white page', () => {
    expect(serializeReportHtml(report, chartImages, 'page')).toContain('background:#ffffff');
  });
});

describe('report Markdown and JSON export', () => {
  it('writes headings, KPI bullets, a GFM table and the chart image in Markdown', () => {
    const markdown = serializeReportMarkdown(report, chartImages);
    expect(markdown).toContain('# Major Contoso franchises: cross-play overlap');
    expect(markdown).toContain('## WWE');
    expect(markdown).toContain('- **% played a Contoso franchise:** 71%');
    expect(markdown).toContain('| Franchise | % other T2 | % Northwind | % other Contoso |');
    expect(markdown).toContain('| WWE | 62% | 48% | 71% |');
    expect(markdown).toContain('![Cross-play overlap](data:image/png;base64,ZZ==)');
  });

  it('echoes a canonical JSON document with charts as specs', () => {
    const parsed = JSON.parse(serializeReportJson(report)) as {
      schema_version: string;
      title: string;
      sections: { charts: { plotly: { data: { y: number[] }[] } }[] }[];
    };
    expect(parsed.schema_version).toBe('pia.report/1');
    expect(parsed.title).toBe('Major Contoso franchises: cross-play overlap');
    expect(parsed.sections[1].charts[0].plotly.data[0].y).toEqual([62, 70]);
    expect(JSON.stringify(parsed)).not.toContain('data:image');
  });

  it('collects every section chart for rasterisation', () => {
    expect(reportCharts(report).map((chart) => chart.id)).toEqual(['overlap']);
  });

  it('gives every chart a unique id so id-less panels do not share an image', () => {
    const normalized = normalizeReport({
      title: 'Two blank-id charts',
      sections: [
        { heading: 'A', charts: [{ kind: 'bar', plotly: { data: [{ type: 'bar', x: ['a'], y: [1] }] } }] },
        { heading: 'B', charts: [{ kind: 'bar', plotly: { data: [{ type: 'bar', x: ['b'], y: [2] }] } }] },
      ],
    }) as Report;
    const ids = reportCharts(normalized).map((chart) => chart.id);
    expect(ids).toEqual(['chart-1', 'chart-2']);
    expect(new Set(ids).size).toBe(ids.length);

    // A distinct author id survives; a duplicate is renumbered rather than colliding.
    const withDupes = normalizeReport({
      title: 'Colliding ids',
      sections: [
        { heading: 'A', charts: [{ id: 'dup', kind: 'bar', plotly: { data: [{ type: 'bar', x: ['a'], y: [1] }] } }] },
        { heading: 'B', charts: [{ id: 'dup', kind: 'bar', plotly: { data: [{ type: 'bar', x: ['b'], y: [2] }] } }] },
      ],
    }) as Report;
    const dupIds = reportCharts(withDupes).map((chart) => chart.id);
    expect(dupIds[0]).toBe('dup');
    expect(new Set(dupIds).size).toBe(dupIds.length);
  });
});
