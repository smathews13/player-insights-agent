import { parseAnswerMarkdown } from './answer-markdown';
import { stripToolCallDumps } from './reader-facing-answer';
import type { Chart } from './AnswerCharts';
import type { Report, ReportFigure, ReportSection, ReportTable } from '../../shared/report-contract';
import { REPORT_SCHEMA_VERSION } from '../../shared/report-contract';
import {
  bulletListHtml,
  chartFigureHtml,
  escapeHtml,
  htmlDocument,
  kpiGridHtml,
  serializeBlocksHtml,
  sourcesListHtml,
  structuredTableHtml,
  type ExportHtmlTheme,
} from './export-html';

/**
 * A report rendered to the same three formats an answer exports to.
 *
 * The report is a document of sections; each renderer walks the same sections in
 * order. HTML and Markdown carry charts as rendered PNGs (passed in by the caller,
 * see chart-image.ts) because those formats show pictures; JSON keeps the native
 * Plotly spec because JSON is the format a reader takes to redraw one. All prose
 * runs through the same safe Markdown parser the on-screen answer uses, so nothing
 * the agent wrote reaches the document as raw markup.
 */

/** Every chart across the report's sections, as the Chart shape chart-image.ts rasterises. */
export function reportCharts(report: Report): Chart[] {
  return report.sections.flatMap((section) =>
    (section.charts ?? []).map((chart) => ({
      id: chart.id,
      title: chart.title,
      kind: chart.kind,
      data: chart.plotly.data,
      layout: chart.plotly.layout,
    }))
  );
}

function bodyHtml(body: string | undefined): string {
  if (!body) return '';
  return serializeBlocksHtml(parseAnswerMarkdown(stripToolCallDumps(body)));
}

function figuresToKpiHtml(figures: readonly ReportFigure[]): string {
  return kpiGridHtml(figures.map((figure) => ({ label: figure.label, value: figure.value, caption: figure.caption })));
}

function tableToHtml(table: ReportTable | undefined): string {
  if (!table) return '';
  const caption = table.sources?.length ? `Sources: ${table.sources.join(', ')}` : table.title;
  return structuredTableHtml({ columns: table.columns, rows: table.rows, align: table.align, caption });
}

function sectionChartsHtml(section: ReportSection, chartImages?: ReadonlyMap<string, string>): string {
  if (!chartImages || !section.charts?.length) return '';
  return section.charts
    .map((chart) => chartFigureHtml(chart.title, chartImages.get(chart.id)))
    .filter(Boolean)
    .join('\n');
}

function sectionHtml(section: ReportSection, chartImages?: ReadonlyMap<string, string>): string {
  const parts = [
    section.heading ? `<h3>${escapeHtml(section.heading)}</h3>` : '',
    bodyHtml(section.body),
    figuresToKpiHtml(section.figures ?? []),
    tableToHtml(section.table),
    sectionChartsHtml(section, chartImages),
    section.note ? `<p class="section-note">${escapeHtml(section.note)}</p>` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return parts ? `<section class="report-section">${parts}</section>` : '';
}

/**
 * A self-contained HTML document for the whole report.
 *
 * The theme resolves from the caller's override, then the agent's design hint, then
 * a white page. A request for a dark slide arrives as `report.theme = 'presentation'`
 * and lands on true black without the caller having to know that.
 */
export function serializeReportHtml(
  report: Report,
  chartImages?: ReadonlyMap<string, string>,
  themeOverride?: ExportHtmlTheme
): string {
  const theme: ExportHtmlTheme = themeOverride ?? report.theme ?? 'page';
  const header = [
    `<h1>${escapeHtml(report.title)}</h1>`,
    report.subtitle ? `<p class="subtitle">${escapeHtml(report.subtitle)}</p>` : '',
    bodyHtml(report.summary),
  ]
    .filter(Boolean)
    .join('\n');
  const sourcesList = sourcesListHtml(report.sources ?? []);
  const caveatsList = bulletListHtml(report.caveats ?? []);
  const body = [
    `<header>${header}</header>`,
    ...report.sections.map((section) => sectionHtml(section, chartImages)),
    sourcesList ? `<section class="sources"><h2>Sources</h2>${sourcesList}</section>` : '',
    caveatsList ? `<section class="caveats"><h2>Caveats</h2>${caveatsList}</section>` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const footer = report.generatedAt
    ? `Generated ${report.generatedAt} · Player Insights`
    : 'Exported from Player Insights.';
  return htmlDocument({ title: report.title, theme, body, footer });
}

/* ── Markdown ────────────────────────────────────────────────────────────────── */

function figuresToMarkdown(figures: readonly ReportFigure[]): string {
  if (figures.length === 0) return '';
  return figures
    .map((figure) => `- **${figure.label}:** ${figure.value}${figure.caption ? ` — ${figure.caption}` : ''}`)
    .join('\n');
}

function tableToMarkdown(table: ReportTable | undefined): string {
  if (!table) return '';
  const escapeCell = (value: string) => value.replaceAll('|', '\\|');
  const width = Math.max(table.columns.length, ...table.rows.map((row) => row.length), 1);
  const at = (row: readonly string[], index: number) => escapeCell(row[index] ?? '');
  const lines: string[] = [];
  if (table.title) lines.push(`**${table.title}**`, '');
  lines.push(`| ${Array.from({ length: width }, (_, index) => at(table.columns, index)).join(' | ')} |`);
  lines.push(
    `| ${Array.from({ length: width }, (_, index) => (table.align?.[index] === 'right' ? '---:' : table.align?.[index] === 'center' ? ':---:' : '---')).join(' | ')} |`
  );
  for (const row of table.rows) {
    lines.push(`| ${Array.from({ length: width }, (_, index) => at(row, index)).join(' | ')} |`);
  }
  if (table.sources?.length) lines.push('', `_Sources: ${table.sources.join(', ')}_`);
  return lines.join('\n');
}

function sectionChartsMarkdown(section: ReportSection, chartImages?: ReadonlyMap<string, string>): string {
  if (!chartImages || !section.charts?.length) return '';
  return section.charts
    .map((chart) => {
      const url = chartImages.get(chart.id);
      return url ? `![${chart.title.trim() || 'Chart'}](${url})` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function sectionMarkdown(section: ReportSection, chartImages?: ReadonlyMap<string, string>): string {
  return [
    section.heading ? `## ${section.heading}` : '',
    section.body ? stripToolCallDumps(section.body) : '',
    figuresToMarkdown(section.figures ?? []),
    tableToMarkdown(section.table),
    sectionChartsMarkdown(section, chartImages),
    section.note ? `_${section.note}_` : '',
  ]
    .filter((part) => part.trim())
    .join('\n\n');
}

export function serializeReportMarkdown(report: Report, chartImages?: ReadonlyMap<string, string>): string {
  const parts = [
    `# ${report.title}`,
    report.subtitle ?? '',
    report.summary ? stripToolCallDumps(report.summary) : '',
    ...report.sections.map((section) => sectionMarkdown(section, chartImages)),
    report.sources?.length
      ? `## Sources\n${report.sources.map((source) => `- \`${source.name}\`${source.freshness ? ` — ${source.freshness}` : ''}`).join('\n')}`
      : '',
    report.caveats?.length ? `## Caveats\n${report.caveats.map((caveat) => `- ${caveat}`).join('\n')}` : '',
  ];
  return `${parts.filter((part) => part.trim()).join('\n\n')}\n`;
}

/* ── JSON ────────────────────────────────────────────────────────────────────── */

/**
 * The report as canonical JSON, reader-safe and machine-readable.
 *
 * The normalised report is already exactly that -- reader-facing fields only, charts
 * as native Plotly specs -- so this echoes it under a stable schema version rather
 * than reshaping it. A reader keys off `schema_version` and gets the same document
 * the HTML drew, minus the layout.
 */
export function serializeReportJson(report: Report): string {
  return `${JSON.stringify({ ...report, schema_version: report.schema_version || REPORT_SCHEMA_VERSION }, null, 2)}\n`;
}
