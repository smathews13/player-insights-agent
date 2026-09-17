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

export { serializeBlocksHtml } from './export-html';
export type { ExportHtmlTheme } from './export-html';

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
  const charts = answerCharts(normalized);
  const title = bodies.headline || question.trim() || 'Player Insights answer';
  const narrativeHtml = serializeBlocksHtml(parseAnswerMarkdown(stripToolCallDumps(bodies.narrative)));
  const contentHtml = serializeBlocksHtml(parseAnswerMarkdown(stripToolCallDumps(bodies.content)));
  const sourcesList = sourcesListHtml(normalized.sources);
  const caveatsList = bulletListHtml(normalized.caveats);
  const body = [
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
  return htmlDocument({ title, theme, body, footer: 'Exported from Player Insights.' });
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
export const ANSWER_EXPORT_SCHEMA_VERSION = 'pia.answer-export/1';

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
  const normalized = normalizeReaderAnswer(answer);
  const bodies = answerBodies(normalized);
  const document = {
    schema_version: ANSWER_EXPORT_SCHEMA_VERSION,
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
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** The wire version stamped into a standalone chart JSON export. */
export const CHART_EXPORT_SCHEMA_VERSION = 'pia.chart-export/1';

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
      ['plan', 'clarification'].includes(String((raw as { type?: unknown }).type))
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

/** Serializes every reader-visible stored turn while omitting traces, feedback and internal diagnostics. */
export function serializeConversationMarkdown(title: string, messages: readonly ConversationMessage[]): string {
  const turns: string[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const text = message.content.trim();
      if (text) turns.push(`## User\n${text}`);
      continue;
    }
    const answer = storedAnswer(message);
    if (answer) {
      turns.push(serializeAnswerMarkdown('', answer).trim());
      continue;
    }
    const payload = storedPayload(message);
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
  return `${stem || 'player-insights-export'}.${ext}`;
}
