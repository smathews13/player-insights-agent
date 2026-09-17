import type { ConversationMessage } from './app-types';
import type { NormalizedAnswer } from './answer-shape';
import type { Chart } from './AnswerCharts';
import type { Report } from '../../shared/report-contract';
import {
  answerCharts,
  safeExportFilename,
  serializeAnswerHtml,
  serializeAnswerJson,
  serializeAnswerMarkdown,
  serializeChartJson,
  serializeConversationMarkdown,
  serializeTableTsv,
  type ExportHtmlTheme,
  type ExportTable,
} from './export-serializers';
import { copyExportText, downloadExportBlob, downloadExportText } from './export-files';

/**
 * The answer's charts as PNG data URLs, keyed by id, or an empty map.
 *
 * The picture rendering lives behind a dynamic import: it pulls Plotly, which is
 * the 1.4 MB chunk, and only a download that actually carries a chart should pay
 * for it. An answer with no charts never loads it.
 */
async function answerChartImages(answer: NormalizedAnswer): Promise<Map<string, string>> {
  const charts = answerCharts(answer);
  if (charts.length === 0) return new Map();
  const { chartPngDataUrls } = await import('./chart-image');
  return chartPngDataUrls(charts);
}

/**
 * Copy stays text-only: charts are rasters, and a few hundred KB of base64 in the
 * clipboard is not what someone pasting into Slack or an editor wants. The download
 * paths below carry the pictures.
 */
export async function copyAnswerMarkdown(answer: NormalizedAnswer, question: string): Promise<void> {
  await copyExportText(serializeAnswerMarkdown(question, answer));
}

export async function downloadAnswerMarkdown(answer: NormalizedAnswer, question: string): Promise<void> {
  const filename = safeExportFilename(question || answer.takeaway, 'md');
  const markdown = serializeAnswerMarkdown(question, answer, await answerChartImages(answer));
  downloadExportText(markdown, filename);
}

export async function downloadAnswerPdf(answer: NormalizedAnswer, question: string): Promise<void> {
  // The PDF writer sets type-1 text only, so the PDF stays prose-and-tables; the
  // HTML export is the picture-bearing one.
  const filename = safeExportFilename(question || answer.takeaway, 'pdf');
  const markdown = serializeAnswerMarkdown(question, answer);
  const { markdownPdf } = await import('./export-binary');
  downloadExportBlob(markdownPdf(markdown), filename);
}

export async function downloadAnswerHtml(
  answer: NormalizedAnswer,
  question: string,
  theme: ExportHtmlTheme = 'page'
): Promise<void> {
  const filename = safeExportFilename(question || answer.takeaway, 'html');
  const html = serializeAnswerHtml(question, answer, await answerChartImages(answer), theme);
  downloadExportText(html, filename, 'text/html;charset=utf-8');
}

export function downloadAnswerJson(answer: NormalizedAnswer, question: string): void {
  const filename = safeExportFilename(question || answer.takeaway, 'json');
  downloadExportText(serializeAnswerJson(question, answer), filename, 'application/json;charset=utf-8');
}

/* ── Single-chart export ─────────────────────────────────────────────────────── */

/** Decodes a `data:...;base64,...` URL to a Blob so a rendered chart can be saved as a file. */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const mime = /data:([^;]+)/.exec(meta)?.[1] ?? 'application/octet-stream';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

export async function downloadChartPng(chart: Chart, name?: string): Promise<void> {
  const { chartPngDataUrl } = await import('./chart-image');
  const blob = dataUrlToBlob(await chartPngDataUrl(chart));
  downloadExportBlob(blob, safeExportFilename(name || chart.title || 'chart', 'png'));
}

export function downloadChartJson(chart: Chart, name?: string): void {
  downloadExportText(
    serializeChartJson(chart),
    safeExportFilename(name || chart.title || 'chart', 'json'),
    'application/json;charset=utf-8'
  );
}

/* ── Report export ───────────────────────────────────────────────────────────── */

/** The report's charts as PNG data URLs, keyed by id, behind the same lazy Plotly boundary. */
async function reportChartImages(report: Report): Promise<Map<string, string>> {
  const { reportCharts } = await import('./report-serializers');
  const charts = reportCharts(report);
  if (charts.length === 0) return new Map();
  const { chartPngDataUrls } = await import('./chart-image');
  return chartPngDataUrls(charts);
}

export async function copyReportMarkdown(report: Report): Promise<void> {
  const { serializeReportMarkdown } = await import('./report-serializers');
  await copyExportText(serializeReportMarkdown(report));
}

export async function downloadReportMarkdown(report: Report): Promise<void> {
  const { serializeReportMarkdown } = await import('./report-serializers');
  const markdown = serializeReportMarkdown(report, await reportChartImages(report));
  downloadExportText(markdown, safeExportFilename(report.title, 'md'));
}

export async function downloadReportHtml(report: Report, theme?: ExportHtmlTheme): Promise<void> {
  const { serializeReportHtml } = await import('./report-serializers');
  const html = serializeReportHtml(report, await reportChartImages(report), theme);
  downloadExportText(html, safeExportFilename(report.title, 'html'), 'text/html;charset=utf-8');
}

export async function downloadReportJson(report: Report): Promise<void> {
  const { serializeReportJson } = await import('./report-serializers');
  downloadExportText(
    serializeReportJson(report),
    safeExportFilename(report.title, 'json'),
    'application/json;charset=utf-8'
  );
}

export async function copyTableTsv(table: ExportTable): Promise<void> {
  await copyExportText(serializeTableTsv(table));
}

export async function downloadTablePng(table: ExportTable, name: string): Promise<void> {
  const { tablePng } = await import('./export-binary');
  const filename = safeExportFilename(name, 'png');
  downloadExportBlob(await tablePng(table), filename);
}

export async function downloadTablePdf(table: ExportTable, name: string): Promise<void> {
  const { tablePdf } = await import('./export-binary');
  const filename = safeExportFilename(name, 'pdf');
  downloadExportBlob(tablePdf(table), filename);
}

async function conversationExport(title: string, loadMessages: () => Promise<ConversationMessage[]>) {
  const markdown = serializeConversationMarkdown(title, await loadMessages());
  const filename = safeExportFilename(title, 'md');
  return { markdown, filename };
}

export async function copyConversationMarkdown(
  title: string,
  loadMessages: () => Promise<ConversationMessage[]>
): Promise<void> {
  await copyExportText((await conversationExport(title, loadMessages)).markdown);
}

export async function downloadConversationMarkdown(
  title: string,
  loadMessages: () => Promise<ConversationMessage[]>
): Promise<void> {
  const { markdown, filename } = await conversationExport(title, loadMessages);
  downloadExportText(markdown, filename);
}

export async function downloadConversationPdf(
  title: string,
  loadMessages: () => Promise<ConversationMessage[]>
): Promise<void> {
  const { markdown, filename } = await conversationExport(title, loadMessages);
  const { markdownPdf } = await import('./export-binary');
  downloadExportBlob(markdownPdf(markdown), filename.replace(/\.md$/, '.pdf'));
}
