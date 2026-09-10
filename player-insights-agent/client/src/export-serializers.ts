import { normalizeReaderAnswer, normalizeReaderText } from '../../shared/answer-content-policy';
import type { NormalizedAnswer, SourceRef } from './answer-shape';
import { inlinePlainText, parseAnswerMarkdown, type Block, type Inline, type TableRow } from './answer-markdown';
import { readerFacingNarrative, readerFacingTakeaway, stripToolCallDumps } from './reader-facing-answer';
import { tableOriginLists } from './answer-table-origins';
import type { ConversationMessage } from './app-types';
import { normalizeAnswer, type WireAnswer } from './answer-shape';

export interface ExportTable {
  block: Extract<Block, { kind: 'table' }>;
  sources: SourceRef[];
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

/** Reader-facing question and answer only; trace, SQL, attachment text and diagnostics are intentionally absent. */
export function serializeAnswerMarkdown(question: string, answer: NormalizedAnswer): string {
  const normalized = normalizeReaderAnswer(answer);
  const bodies = answerBodies(normalized);
  const sections = [
    question.trim() ? `## Question\n${question.trim()}` : '',
    `## Answer\n${bodies.headline}`.trim(),
    serializeBlocksMarkdown(parseAnswerMarkdown(stripToolCallDumps(bodies.narrative))),
    serializeBlocksMarkdown(parseAnswerMarkdown(stripToolCallDumps(bodies.content))),
    normalized.figures.length
      ? `## Figures\n${normalized.figures
          .map(
            (figure) =>
              `- **${figure.label}:** ${figure.display ?? figure.value}${figure.comparison ? ` — ${figure.comparison}` : ''}`
          )
          .join('\n')}`
      : '',
    sourceMarkdown(normalized.sources),
    normalized.caveats.length ? `## Caveats\n${normalized.caveats.map((caveat) => `- ${caveat}`).join('\n')}` : '',
  ];
  return `${sections.filter((section) => section.trim()).join('\n\n')}\n`;
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
