import { normalizeReaderAnswer, normalizeReaderText } from '../../shared/answer-content-policy';
import type { NormalizedAnswer, SourceRef } from './answer-shape';
import { inlinePlainText, parseAnswerMarkdown, type Block, type Inline, type TableRow } from './answer-markdown';
import { readerFacingNarrative, readerFacingTakeaway, stripToolCallDumps } from './reader-facing-answer';
import { tableOriginLists } from './answer-table-origins';
import type { ConversationMessage } from './app-types';
import type { Chart } from './AnswerCharts';
import {
  bulletListHtml,
  chartFigureHtml,
  escapeHtml,
  htmlDocument,
  kpiGridHtml,
  serializeBlocksHtml,
  sourcesListHtml,
  type ExportHtmlTheme,
} from './export-html';
import { normalizeAnswer, type WireAnswer } from './answer-shape';
import { EXPORT_BRAND } from './export-brand';
import { normalizeReport, type Report } from '../../shared/report-contract';
import { reportHtmlBody, serializeReportJson, serializeReportMarkdown } from './report-serializers';

export { serializeBlocksHtml } from './export-html';
export type { ExportHtmlTheme } from './export-html';

/**
 * Per-message chart pictures for a whole-conversation export.
 *
 * Keyed by message id (NOT chart id): every answer turn mints its own chart ids
 * (`chart-1`, `chart-2`, …), so two answers in one thread collide on `chart-1`.
 * Keying the outer map by the message the chart belongs to keeps each turn's
 * pictures its own. The caller renders these behind the lazy Plotly boundary
 * (see export-actions.ts) and passes them in, so the serializer stays a pure,
 * browserless string pass.
 */
export type ConversationChartImages = ReadonlyMap<string, ReadonlyMap<string, string>>;

export interface ExportTable {
  block: Extract<Block, { kind: 'table' }>;
  sources: SourceRef[];
}

/**
 * The charts an answer carries, coerced from the wire's open shape.
 *
 * `NormalizedAnswer.charts` is `unknown` on purpose -- the app hands the raw
 * Plotly payload to Plotly and validates it nowhere else -- so an export that
 * wants them has to establish the shape itself. A trace-less entry is dropped
 * because a chart with no data draws nothing, and a missing id is filled with a
 * positional one so the image map and the serializers can still refer to it.
 */
export function answerCharts(answer: NormalizedAnswer): Chart[] {
  if (!Array.isArray(answer.charts)) return [];
  const charts: Chart[] = [];
  for (const entry of answer.charts) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const data = Array.isArray(record.data)
      ? record.data.filter((trace): trace is Record<string, unknown> => Boolean(trace) && typeof trace === 'object')
      : [];
    if (data.length === 0) continue;
    const layout =
      record.layout && typeof record.layout === 'object' && !Array.isArray(record.layout)
        ? (record.layout as Record<string, unknown>)
        : {};
    charts.push({
      id: typeof record.id === 'string' && record.id ? record.id : `chart-${charts.length + 1}`,
      title: typeof record.title === 'string' ? record.title : '',
      kind: typeof record.kind === 'string' ? record.kind : '',
      data,
      layout,
    });
  }
  return charts;
}

/** A chart's reader-facing name, matching the eyebrow the answer card draws. */
function chartName(chart: Chart): string {
  return chart.title.trim() || 'Chart';
}

function markdownInline(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      if (node.kind === 'text') return node.runs.map((run) => run.text).join('');
      if (node.kind === 'code') return `\`${node.runs.map((run) => run.text).join('')}\``;
      if (node.kind === 'strong') return `**${markdownInline(node.children)}**`;
      if (node.kind === 'link') return `[${markdownInline(node.children)}](${node.href})`;
      return '  \n';
    })
    .join('');
}

function markdownRow(row: TableRow): string {
  return `| ${row.cells.map((cell) => markdownInline(cell.children).replaceAll('|', '\\|')).join(' | ')} |`;
}

/** Canonical Markdown for the safe answer AST. Raw HTML and hidden fields never enter this tree. */
export function serializeBlocksMarkdown(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'paragraph':
          return markdownInline(block.children);
        case 'heading':
          return `${'#'.repeat(block.level)} ${markdownInline(block.children)}`;
        case 'list':
          return block.items
            .map(
              (item, index) =>
                `${'  '.repeat(item.depth)}${block.ordered ? `${index + 1}.` : '-'} ${markdownInline(item.children)}`
            )
            .join('\n');
        case 'rule':
          return '---';
        case 'code':
          return `\`\`\`${block.language}\n${block.text}\n\`\`\``;
        case 'table': {
          const rows: string[] = [];
          if (block.header) {
            rows.push(markdownRow(block.header));
            rows.push(
              `| ${block.align.map((align) => (align === 'right' ? '---:' : align === 'center' ? ':---:' : '---')).join(' | ')} |`
            );
          }
          rows.push(...block.rows.map(markdownRow));
          return rows.join('\n');
        }
      }
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function answerBodies(answer: NormalizedAnswer): { headline: string; narrative: string; content: string } {
  const normalized = normalizeReaderAnswer(answer);
  return {
    headline: readerFacingTakeaway(normalized.takeaway, normalized.narrative, {
      figures: normalized.figures,
      content: normalized.content,
    }),
    narrative: readerFacingNarrative(normalized.takeaway, normalized.narrative, {
      figures: normalized.figures,
      content: normalized.content,
    }),
    content: normalized.content ?? '',
  };
}

function sourceMarkdown(sources: readonly SourceRef[]): string {
  if (sources.length === 0) return '';
  return `## Sources\n${sources
    .map((source) => `- \`${source.name}\`${source.freshness ? ` — ${source.freshness}` : ''}`)
    .join('\n')}`;
}

function figuresMarkdown(
  figures: readonly { label: string; value: number; display?: string; comparison: string }[]
): string {
  if (figures.length === 0) return '';
  return `## Figures\n${figures
    .map(
      (figure) =>
        `- **${figure.label}:** ${figure.display ?? figure.value}${figure.comparison ? ` — ${figure.comparison}` : ''}`
    )
    .join('\n')}`;
}

/**
 * The charts as Markdown images, or nothing when no picture was rendered.
 *
 * A Markdown chart is a raster: the agent's Plotly spec is a script, and Markdown
 * carries pictures, not scripts. The PNGs are rendered by the caller (see
 * `chart-image.ts`) and passed in as data URLs, so this stays a pure string pass a
 * unit test can drive without a browser. A chart whose picture is missing is
 * skipped rather than printed as a bare title, which would read as a heading over
 * nothing.
 */
function chartsMarkdown(charts: readonly Chart[], chartImages?: ReadonlyMap<string, string>): string {
  if (!chartImages || charts.length === 0) return '';
  const images = charts
    .map((chart) => {
      const url = chartImages.get(chart.id);
      return url ? `![${chartName(chart)}](${url})` : '';
    })
    .filter(Boolean);
  return images.length ? `## Charts\n${images.join('\n\n')}` : '';
}

/**
 * Reader-facing question and answer only; trace, SQL, attachment text and diagnostics are intentionally absent.
 *
 * `chartImages` upgrades the export from prose-and-tables to a dashboard: pass a
 * map of chart id to PNG data URL and the answer's charts render inline. Omit it
 * and the output is byte-for-byte what it was before charts were supported, which
 * is what keeps the clipboard-facing "Copy Markdown" path free of a wall of base64.
 */
export function serializeAnswerMarkdown(
  question: string,
  answer: NormalizedAnswer,
  chartImages?: ReadonlyMap<string, string>
): string {
  const normalized = normalizeReaderAnswer(answer);
  const bodies = answerBodies(normalized);
  const sections = [
    question.trim() ? `## Question\n${question.trim()}` : '',
    `## Answer\n${bodies.headline}`.trim(),
    serializeBlocksMarkdown(parseAnswerMarkdown(stripToolCallDumps(bodies.narrative))),
    serializeBlocksMarkdown(parseAnswerMarkdown(stripToolCallDumps(bodies.content))),
    chartsMarkdown(answerCharts(normalized), chartImages),
    figuresMarkdown(normalized.figures),
    sourceMarkdown(normalized.sources),
    normalized.caveats.length ? `## Caveats\n${normalized.caveats.map((caveat) => `- ${caveat}`).join('\n')}` : '',
  ];
  return `${sections.filter((section) => section.trim()).join('\n\n')}\n`;
}

/* ── HTML export (built on the shared toolkit in export-html.ts) ─────────────── */

function answerFiguresHtml(
  figures: readonly { label: string; value: number; display?: string; comparison: string }[]
): string {
  const grid = kpiGridHtml(
    figures.map((figure) => ({
      label: figure.label,
      value: figure.display ?? String(figure.value),
      caption: figure.comparison || undefined,
    }))
  );
  return grid ? `<section class="figures-section"><h2>Figures</h2>${grid}</section>` : '';
}

function answerChartsHtml(charts: readonly Chart[], chartImages?: ReadonlyMap<string, string>): string {
  if (!chartImages || charts.length === 0) return '';
  const panels = charts
    .map((chart) => chartFigureHtml(chartName(chart), chartImages.get(chart.id)))
    .filter(Boolean)
    .join('\n');
  return panels ? `<section class="charts-section"><h2>Charts</h2>${panels}</section>` : '';
}

/**
 * The inner HTML for one answer -- prose, tables, charts, figures, sources -- with
 * no surrounding `<html>` document.
 *
 * Split out from `serializeAnswerHtml` so the SAME markup can be a standalone
 * answer file OR one turn inside a whole-conversation document. A conversation
 * wraps many of these fragments in a single themed shell; an answer wraps one.
 * Keeping the fragment in one place is what keeps the two exports from drifting
 * into two subtly different renderings of the same answer.
 */
function answerHtmlSections(
  question: string,
  answer: NormalizedAnswer,
  chartImages?: ReadonlyMap<string, string>
): string {
  const normalized = normalizeReaderAnswer(answer);
  const bodies = answerBodies(normalized);
  const charts = answerCharts(normalized);
  const narrativeHtml = serializeBlocksHtml(parseAnswerMarkdown(stripToolCallDumps(bodies.narrative)));
  const contentHtml = serializeBlocksHtml(parseAnswerMarkdown(stripToolCallDumps(bodies.content)));
  const sourcesList = sourcesListHtml(normalized.sources);
  const caveatsList = bulletListHtml(normalized.caveats);
  return [
    question.trim() ? `<section class="question"><h2>Question</h2><p>${escapeHtml(question.trim())}</p></section>` : '',
    `<section class="answer"><h2>Answer</h2><p class="headline">${escapeHtml(bodies.headline)}</p></section>`,
    narrativeHtml ? `<section class="narrative">${narrativeHtml}</section>` : '',
    contentHtml ? `<section class="content">${contentHtml}</section>` : '',
    answerChartsHtml(charts, chartImages),
    answerFiguresHtml(normalized.figures),
    sourcesList ? `<section class="sources"><h2>Sources</h2>${sourcesList}</section>` : '',
    caveatsList ? `<section class="caveats"><h2>Caveats</h2>${caveatsList}</section>` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * A self-contained HTML document for one answer: prose, tables, charts, figures, sources.
 *
 * Everything is inlined -- the CSS in a `<style>` and the charts as data-URL PNGs --
 * so the file opens the same anywhere, offline, with no request back to the app.
 * `theme: 'presentation'` renders on black for pasting onto a slide.
 */
export function serializeAnswerHtml(
  question: string,
  answer: NormalizedAnswer,
  chartImages?: ReadonlyMap<string, string>,
  theme: ExportHtmlTheme = 'page'
): string {
  const normalized = normalizeReaderAnswer(answer);
  const bodies = answerBodies(normalized);
  const title = bodies.headline || question.trim() || `${EXPORT_BRAND.appName} answer`;
  const body = answerHtmlSections(question, answer, chartImages);
  return htmlDocument({ title, theme, body, footer: EXPORT_BRAND.htmlFooter });
}

/** The structured form of one answer table: header, alignment, rows as plain text, and source names. */
function structuredTable(table: ExportTable): {
  header: string[];
  align: readonly ('left' | 'right' | 'center')[];
  rows: string[][];
  sources: string[];
} {
  const cells = (row: TableRow): string[] =>
    row.cells.map((cell) => inlinePlainText(cell.children).replace(/\s+/g, ' ').trim());
  return {
    header: table.block.header ? cells(table.block.header) : [],
    align: table.block.align,
    rows: table.block.rows.map(cells),
    sources: table.sources.map((source) => source.name),
  };
}

/** The wire version this build writes into JSON exports, so a reader can key off a stable string. */
export const ANSWER_EXPORT_SCHEMA_VERSION = `${EXPORT_BRAND.jsonSchemaPrefix}.answer-export/1`;

/** The reader-safe object one answer serializes to, before it is stringified or nested in a conversation. */
function answerJsonDocument(question: string, answer: NormalizedAnswer): Record<string, unknown> {
  const normalized = normalizeReaderAnswer(answer);
  const bodies = answerBodies(normalized);
  return {
    question: question.trim(),
    headline: bodies.headline,
    narrative: stripToolCallDumps(bodies.narrative),
    content: stripToolCallDumps(bodies.content),
    figures: normalized.figures.map((figure) => ({
      label: figure.label,
      value: figure.value,
      display: figure.display ?? null,
      comparison: figure.comparison,
    })),
    tables: answerTables(normalized).map(structuredTable),
    charts: answerCharts(normalized).map((chart) => ({
      id: chart.id,
      title: chart.title,
      kind: chart.kind,
      plotly: { data: chart.data, layout: chart.layout },
    })),
    sources: normalized.sources.map((source) => ({
      name: source.name,
      freshness: source.freshness,
      role: source.role ?? null,
    })),
    caveats: normalized.caveats,
    provenance: normalized.provenance ?? null,
  };
}

/**
 * One answer as a canonical, reader-safe JSON document.
 *
 * The same reader-facing content the other two formats carry, structured rather
 * than laid out: prose as Markdown strings, figures and tables as data, and charts
 * as their native Plotly specs (NOT rasters -- JSON is the format a reader takes to
 * redraw a chart, so it keeps the machine-readable half the picture threw away).
 * Trace, SQL and diagnostics stay out, exactly as they do from the Markdown path.
 */
export function serializeAnswerJson(question: string, answer: NormalizedAnswer): string {
  const document = { schema_version: ANSWER_EXPORT_SCHEMA_VERSION, ...answerJsonDocument(question, answer) };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** The wire version stamped into a standalone chart JSON export. */
export const CHART_EXPORT_SCHEMA_VERSION = `${EXPORT_BRAND.jsonSchemaPrefix}.chart-export/1`;

/**
 * One chart on its own as canonical JSON: its id, title, kind and native Plotly spec.
 *
 * The spec is the point -- a reader downloads a chart's JSON to redraw or re-theme it,
 * so this keeps `data` and `layout` verbatim rather than a picture. The PNG export is
 * the picture; this is the recipe.
 */
export function serializeChartJson(chart: Chart): string {
  const document = {
    schema_version: CHART_EXPORT_SCHEMA_VERSION,
    id: chart.id,
    title: chart.title,
    kind: chart.kind,
    plotly: { data: chart.data, layout: chart.layout },
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function storedAnswer(message: ConversationMessage): NormalizedAnswer | null {
  if (!message.response_json) return null;
  try {
    const raw: unknown =
      typeof message.response_json === 'string' ? JSON.parse(message.response_json) : message.response_json;
    if (
      !raw ||
      typeof raw !== 'object' ||
      ['plan', 'clarification', 'dashboard', 'report'].includes(String((raw as { type?: unknown }).type))
    ) {
      return null;
    }
    return normalizeAnswer(raw as WireAnswer);
  } catch {
    return null;
  }
}

function storedPayload(message: ConversationMessage): Record<string, unknown> | null {
  if (!message.response_json) return null;
  try {
    const raw: unknown =
      typeof message.response_json === 'string' ? JSON.parse(message.response_json) : message.response_json;
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function storedReport(message: ConversationMessage): Report | null {
  const payload = storedPayload(message);
  return payload?.type === 'report' ? normalizeReport(payload.report) : null;
}

function reportCharts(report: Report): Chart[] {
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

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function planMarkdown(payload: Record<string, unknown>): string {
  const plan = payload.plan && typeof payload.plan === 'object' ? (payload.plan as Record<string, unknown>) : {};
  const summary = stringValue(plan.summary);
  const question = stringValue(plan.question);
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const visibleSteps = steps
    .map((step) => {
      if (!step || typeof step !== 'object') return '';
      const record = step as Record<string, unknown>;
      const title = stringValue(record.title);
      const description = stringValue(record.description);
      return title ? `- **${title}**${description ? ` — ${description}` : ''}` : '';
    })
    .filter(Boolean);
  return ['## Proposed analysis plan', question ? `**Question:** ${question}` : '', summary, visibleSteps.join('\n')]
    .filter(Boolean)
    .join('\n\n');
}

function clarificationMarkdown(payload: Record<string, unknown>): string {
  const clarification =
    payload.clarification && typeof payload.clarification === 'object'
      ? (payload.clarification as Record<string, unknown>)
      : {};
  const question = stringValue(clarification.question);
  const reason = stringValue(clarification.reason);
  const options = Array.isArray(clarification.options) ? clarification.options.map(stringValue).filter(Boolean) : [];
  return [
    '## Clarification requested',
    question,
    reason,
    options.length ? options.map((option) => `- ${option}`).join('\n') : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function rawAssistantMarkdown(message: ConversationMessage): string {
  return serializeBlocksMarkdown(
    parseAnswerMarkdown(stripToolCallDumps(normalizeReaderText(message.content, {}, 'raw')))
  );
}

/**
 * Serializes every reader-visible stored turn while omitting traces, feedback and internal diagnostics.
 *
 * Pass `chartImagesByMessage` (see `ConversationChartImages`) and each answer
 * turn's charts render inline exactly as they do in a single-answer export; omit
 * it and the transcript is prose-and-tables. The map is keyed by message id so
 * turns never share ids.
 */
export function serializeConversationMarkdown(
  title: string,
  messages: readonly ConversationMessage[],
  chartImagesByMessage?: ConversationChartImages
): string {
  const turns: string[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const text = message.content.trim();
      if (text) turns.push(`## User\n${text}`);
      continue;
    }
    const answer = storedAnswer(message);
    if (answer) {
      turns.push(serializeAnswerMarkdown('', answer, chartImagesByMessage?.get(message.id)).trim());
      continue;
    }
    const payload = storedPayload(message);
    const report = storedReport(message);
    if (report) {
      turns.push(serializeReportMarkdown(report, chartImagesByMessage?.get(message.id)).trim());
      continue;
    }
    if (payload?.type === 'plan') {
      turns.push(planMarkdown(payload));
      continue;
    }
    if (payload?.type === 'clarification') {
      turns.push(clarificationMarkdown(payload));
      continue;
    }
    const visible = rawAssistantMarkdown(message);
    if (visible) turns.push(`## Assistant\n${visible}`);
  }
  return `# ${title.trim() || 'Conversation'}\n\n${turns.join('\n\n---\n\n')}\n`;
}

/** A themed HTML thread separator matching the `---` rule the Markdown transcript uses between turns. */
const CONVERSATION_TURN_SEPARATOR_HTML = '<hr class="turn-separator" />';

/**
 * The whole conversation as one self-contained, themed HTML document.
 *
 * Each turn reuses the SAME renderers a single answer, plan or clarification
 * export uses, wrapped in one shared document shell -- so a thread reads as a
 * sequence of the answers a reader already recognises, not a second rendering of
 * them. Charts render inline when `chartImagesByMessage` is supplied.
 */
export function serializeConversationHtml(
  title: string,
  messages: readonly ConversationMessage[],
  chartImagesByMessage?: ConversationChartImages,
  theme: ExportHtmlTheme = 'page'
): string {
  const heading = title.trim() || 'Conversation';
  const turns: string[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const text = message.content.trim();
      if (text) turns.push(`<section class="turn turn-user"><h2>User</h2><p>${escapeHtml(text)}</p></section>`);
      continue;
    }
    const answer = storedAnswer(message);
    if (answer) {
      turns.push(
        `<section class="turn turn-answer">${answerHtmlSections('', answer, chartImagesByMessage?.get(message.id))}</section>`
      );
      continue;
    }
    const payload = storedPayload(message);
    const report = storedReport(message);
    if (report) {
      const body = reportHtmlBody(report, chartImagesByMessage?.get(message.id));
      if (body) turns.push(`<section class="turn turn-report">${body}</section>`);
      continue;
    }
    if (payload?.type === 'plan') {
      const blocks = serializeBlocksHtml(parseAnswerMarkdown(planMarkdown(payload)));
      if (blocks) turns.push(`<section class="turn turn-plan">${blocks}</section>`);
      continue;
    }
    if (payload?.type === 'clarification') {
      const blocks = serializeBlocksHtml(parseAnswerMarkdown(clarificationMarkdown(payload)));
      if (blocks) turns.push(`<section class="turn turn-clarification">${blocks}</section>`);
      continue;
    }
    const visible = serializeBlocksHtml(
      parseAnswerMarkdown(stripToolCallDumps(normalizeReaderText(message.content, {}, 'raw')))
    );
    if (visible) turns.push(`<section class="turn turn-assistant"><h2>Assistant</h2>${visible}</section>`);
  }
  const body = `<header><h1>${escapeHtml(heading)}</h1></header>\n${turns.join(`\n${CONVERSATION_TURN_SEPARATOR_HTML}\n`)}`;
  return htmlDocument({ title: heading, theme, body, footer: EXPORT_BRAND.htmlFooter });
}

/** The wire version stamped into a whole-conversation JSON export. */
export const CONVERSATION_EXPORT_SCHEMA_VERSION = `${EXPORT_BRAND.jsonSchemaPrefix}.conversation-export/1`;

/**
 * The whole conversation as canonical, reader-safe JSON: an ordered list of typed turns.
 *
 * Each turn is tagged (`user` | `answer` | `plan` | `clarification` | `assistant`)
 * so a reader can walk the thread structurally. Answer turns carry the same
 * object `serializeAnswerJson` emits (charts as native Plotly specs), so the
 * machine-readable half survives at conversation scope too. Trace, SQL, feedback
 * and diagnostics stay out, exactly as the other formats keep them out.
 */
export function serializeConversationJson(title: string, messages: readonly ConversationMessage[]): string {
  const turns: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const text = message.content.trim();
      if (text) turns.push({ role: 'user', type: 'user', text });
      continue;
    }
    const answer = storedAnswer(message);
    if (answer) {
      turns.push({ role: 'assistant', type: 'answer', ...answerJsonDocument('', answer) });
      continue;
    }
    const payload = storedPayload(message);
    const report = storedReport(message);
    if (report) {
      const document = JSON.parse(serializeReportJson(report)) as Record<string, unknown>;
      turns.push({ role: 'assistant', type: 'report', ...document });
      continue;
    }
    if (payload?.type === 'plan') {
      turns.push({ role: 'assistant', type: 'plan', markdown: planMarkdown(payload) });
      continue;
    }
    if (payload?.type === 'clarification') {
      turns.push({ role: 'assistant', type: 'clarification', markdown: clarificationMarkdown(payload) });
      continue;
    }
    const visible = rawAssistantMarkdown(message);
    if (visible) turns.push({ role: 'assistant', type: 'assistant', markdown: visible });
  }
  const document = {
    schema_version: CONVERSATION_EXPORT_SCHEMA_VERSION,
    title: title.trim() || 'Conversation',
    turns,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Each answer turn's charts, keyed by message id, for a conversation's picture pass.
 *
 * The action layer renders these to PNGs behind the lazy Plotly boundary and
 * feeds them back as `ConversationChartImages`. Kept here so the one place that
 * knows how to read a stored answer (`storedAnswer`) is also the one place that
 * enumerates its charts -- the serializer and the image pass never disagree on
 * which turn owns which chart.
 */
export function conversationChartsByMessage(messages: readonly ConversationMessage[]): Map<string, Chart[]> {
  const byMessage = new Map<string, Chart[]>();
  for (const message of messages) {
    if (message.role === 'user') continue;
    const answer = storedAnswer(message);
    const report = storedReport(message);
    const charts = answer ? answerCharts(answer) : report ? reportCharts(report) : [];
    if (charts.length) byMessage.set(message.id, charts);
  }
  return byMessage;
}

export function answerTables(answer: NormalizedAnswer): ExportTable[] {
  const normalized = normalizeReaderAnswer(answer);
  const bodies = answerBodies(normalized);
  const texts = [bodies.narrative, bodies.content];
  const origins = tableOriginLists(texts, normalized.sources);
  const tables = texts.flatMap((body) =>
    body
      ? parseAnswerMarkdown(stripToolCallDumps(body)).filter(
          (block): block is ExportTable['block'] => block.kind === 'table'
        )
      : []
  );
  return tables.map((block, index) => ({ block, sources: origins[index] ?? [] }));
}

export function serializeTableTsv(table: ExportTable): string {
  const rows = [table.block.header, ...table.block.rows].filter((row): row is TableRow => Boolean(row));
  const body = rows
    .map((row) =>
      row.cells.map((cell) => inlinePlainText(cell.children).replaceAll('\t', ' ').replace(/\r?\n/g, ' ')).join('\t')
    )
    .join('\n');
  const attribution = table.sources.length
    ? `\n\n# Sources\t${table.sources.map((source) => source.name).join(', ')}`
    : '';
  return `${body}${attribution}\n`;
}

function csvCell(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n');
  return /[",\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

/** A standalone answer table as interoperable CSV, with no UI-only source footer rows. */
export function serializeTableCsv(table: ExportTable): string {
  const rows = [table.block.header, ...table.block.rows].filter((row): row is TableRow => Boolean(row));
  return (
    rows.map((row) => row.cells.map((cell) => csvCell(inlinePlainText(cell.children))).join(',')).join('\n') + '\n'
  );
}

export function safeExportFilename(value: string, extension: string): string {
  const stem = value
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
    .toLowerCase();
  const ext = extension.replace(/^\.+/, '').toLowerCase();
  return `${stem || EXPORT_BRAND.filenameFallback}.${ext}`;
}
