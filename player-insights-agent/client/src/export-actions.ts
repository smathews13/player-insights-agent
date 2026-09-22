import type { ConversationMessage } from './app-types';
import type { NormalizedAnswer } from './answer-shape';
import type { Chart } from './AnswerCharts';
import type { Report } from '../../shared/report-contract';
import {
  answerCharts,
  conversationChartsByMessage,
  safeExportFilename,
  serializeAnswerHtml,
  serializeAnswerJson,
  serializeAnswerMarkdown,
  serializeChartJson,
  serializeConversationHtml,
  serializeConversationJson,
  serializeConversationMarkdown,
  serializeTableTsv,
  type ConversationChartImages,
  type ExportHtmlTheme,
  type ExportTable,
} from './export-serializers';
import { copyExportText, downloadExportBlob, downloadExportText } from './export-files';
import type { CostBriefPayload } from '../../shared/ops-contract';

/**
 * The answer's charts as PNG data URLs, keyed by id, or an empty map.
 *
 * The picture rendering lives behind a dynamic import: it pulls Plotly, which is
 * the 1.4 MB chunk, and only a download that actually carries a chart should pay
 * for it. An answer with no charts never loads it.
 */
async function answerChartImages(
  answer: NormalizedAnswer,
  format: 'png' | 'jpeg' = 'png'
): Promise<Map<string, string>> {
  const charts = answerCharts(answer);
  if (charts.length === 0) return new Map();
  const { chartPngDataUrls } = await import('./chart-image');
  return chartPngDataUrls(charts, format);
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
  // Charts embed as JPEG (DCTDecode) image XObjects: the PDF writer's one
  // embeddable image filter. The Markdown carries them as jpeg data URLs and the
  // writer pulls the picture out of the `![…](data:image/jpeg;…)` line.
  const filename = safeExportFilename(question || answer.takeaway, 'pdf');
  const markdown = serializeAnswerMarkdown(question, answer, await answerChartImages(answer, 'jpeg'));
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

/* ── Cost brief export ───────────────────────────────────────────────────────── */

async function readCostBrief(): Promise<CostBriefPayload> {
  const response = await fetch('/api/ops/cost/brief', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('The cost brief could not be read.');
  return (await response.json()) as CostBriefPayload;
}

/**
 * Fetch the trailing-31-day cost breakdown and save the styled observed-spend PDF.
 *
 * The brief is its own on-demand read (`GET /api/ops/cost/brief`), separate from
 * the month-locked Cost block, so the button pays for the 31-day query only when
 * clicked. Its dedicated vector renderer stays behind the existing lazy binary
 * boundary and uses the same reader-facing attribution as the page.
 */
export async function downloadCostBriefPdf(): Promise<void> {
  const brief = await readCostBrief();
  const { costBriefPdf } = await import('./export-binary');
  downloadExportBlob(costBriefPdf(brief), safeExportFilename('cost-breakdown-31d', 'pdf'));
}

/**
 * Save the planning-only view that adds a lightly used second Prod deployment.
 *
 * Projection math lives with the cost serializer and is disclosed in the PDF:
 * fixed standing cost is duplicated, while question-driven usage is modeled at
 * the lower factor chosen for intermittent Prod testers. It never calls this
 * scenario actual spend.
 */
export async function downloadDevProdCostProjectionPdf(): Promise<void> {
  const brief = await readCostBrief();
  const { costBriefPdf } = await import('./export-binary');
  downloadExportBlob(
    costBriefPdf(brief, 'dev-prod-projection'),
    safeExportFilename('cost-dev-prod-projection-31d', 'pdf')
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

/**
 * Every answer turn's charts as PNG data URLs, keyed by message id.
 *
 * Same lazy-Plotly boundary as the single-answer path: a thread with no charts
 * never loads the 1.4 MB library. Keyed by message so two turns cannot collide
 * on the `chart-1` id each of them mints.
 */
async function conversationChartImages(
  messages: readonly ConversationMessage[],
  format: 'png' | 'jpeg' = 'png'
): Promise<ConversationChartImages> {
  const byMessage = conversationChartsByMessage(messages);
  if (byMessage.size === 0) return new Map();
  const { chartPngDataUrls } = await import('./chart-image');
  const entries = await Promise.all(
    [...byMessage].map(async ([id, charts]) => [id, await chartPngDataUrls(charts, format)] as const)
  );
  return new Map(entries);
}

/**
 * Copy stays text-only for the same reason the answer copy does: a transcript's
 * worth of base64 chart data is not what someone pasting into Slack wants.
 */
export async function copyConversationMarkdown(
  title: string,
  loadMessages: () => Promise<ConversationMessage[]>
): Promise<void> {
  await copyExportText(serializeConversationMarkdown(title, await loadMessages()));
}

export async function downloadConversationMarkdown(
  title: string,
  loadMessages: () => Promise<ConversationMessage[]>
): Promise<void> {
  const messages = await loadMessages();
  const markdown = serializeConversationMarkdown(title, messages, await conversationChartImages(messages));
  downloadExportText(markdown, safeExportFilename(title, 'md'));
}

export async function downloadConversationHtml(
  title: string,
  loadMessages: () => Promise<ConversationMessage[]>,
  theme: ExportHtmlTheme = 'page'
): Promise<void> {
  const messages = await loadMessages();
  const html = serializeConversationHtml(title, messages, await conversationChartImages(messages), theme);
  downloadExportText(html, safeExportFilename(title, 'html'), 'text/html;charset=utf-8');
}

export async function downloadConversationJson(
  title: string,
  loadMessages: () => Promise<ConversationMessage[]>
): Promise<void> {
  downloadExportText(
    serializeConversationJson(title, await loadMessages()),
    safeExportFilename(title, 'json'),
    'application/json;charset=utf-8'
  );
}

export async function downloadConversationPdf(
  title: string,
  loadMessages: () => Promise<ConversationMessage[]>
): Promise<void> {
  const messages = await loadMessages();
  const markdown = serializeConversationMarkdown(title, messages, await conversationChartImages(messages, 'jpeg'));
  const { markdownPdf } = await import('./export-binary');
  downloadExportBlob(markdownPdf(markdown), safeExportFilename(title, 'pdf'));
}
