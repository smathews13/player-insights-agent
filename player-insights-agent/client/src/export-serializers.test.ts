import { describe, expect, it, vi } from 'vitest';
import { parseAnswerMarkdown } from './answer-markdown';
import { normalizeAnswer } from './answer-shape';
import {
  answerTables,
  safeExportFilename,
  serializeAnswerMarkdown,
  serializeConversationMarkdown,
  serializeTableCsv,
  serializeTableTsv,
} from './export-serializers';
import type { ExportTable } from './export-serializers';
import { markdownPdf, tablePdf, tablePng, tablePngLayout, wrappedCanvasLines } from './export-binary';
import type { ConversationMessage } from './app-types';

const answer = normalizeAnswer({
  id: 'answer-1',
  takeaway: 'Players increased',
  narrative: [
    'The governed result follows.',
    'data_genie({"question":"secret diagnostics"})',
    '| Platform | Players |',
    '| --- | ---: |',
    '| PC | 42 |',
  ].join('\n'),
  figures: [{ label: 'Players', value: 42, display: '42', comparison: 'up 5%' }],
  sources: [{ name: 'catalog.schema.player_daily', freshness: '2026-09-09', role: 'reading' }],
  caveats: ['Figures exclude anonymous players.', 'No SQL was generated for this answer.'],
  document_snippets: [{ filename: 'hidden.pdf', quote: 'hidden attachment text', supports: 'claim' }],
  sql: 'SELECT secret_internal_column FROM internal_table',
  trace: {
    id: 'tr-1',
    stages: [{ id: 'raw', input: 'private input', output: 'private output' }],
  },
});

function parsedTable(markdown: string, sources: ExportTable['sources'] = []): ExportTable {
  const block = parseAnswerMarkdown(markdown).find((candidate) => candidate.kind === 'table');
  if (!block || block.kind !== 'table') throw new Error('Expected parsed table');
  return { block, sources };
}

describe('reader export serializers', () => {
  it('exports only normalized reader-facing answer material', () => {
    const markdown = serializeAnswerMarkdown('How many players?', answer);
    expect(markdown).toContain('## Question\nHow many players?');
    expect(markdown).toContain('| Platform | Players |');
    expect(markdown).toContain('**Players:** 42 — up 5%');
    expect(markdown).toContain('catalog.schema.player_daily');
    expect(markdown).toContain('Figures exclude anonymous players.');
    expect(markdown).not.toContain('data_genie');
    expect(markdown).not.toContain('secret_internal_column');
    expect(markdown).not.toContain('hidden attachment text');
    expect(markdown).not.toContain('private input');
    expect(markdown).not.toContain('No SQL was generated');
  });

  it('serializes one parsed table with its header and source attribution as TSV', () => {
    const [table] = answerTables(answer);
    expect(serializeTableTsv(table)).toBe('Platform\tPlayers\nPC\t42\n\n# Sources\tcatalog.schema.player_daily\n');
  });

  it('serializes a standalone table as clean CSV with escaped cells and no metadata rows', () => {
    const table = parsedTable(['| Platform | Players |', '| --- | ---: |', '| "PC, Console" | 42 |'].join('\n'), [
      { name: 'catalog.schema.player_daily', freshness: '2026-09-09' },
    ]);
    expect(serializeTableCsv(table)).toBe('Platform,Players\n"""PC, Console""",42\n');
  });

  it('uses stable filesystem-safe filenames', () => {
    expect(safeExportFilename('  Players / Revenue: Q3?  ', '.PDF')).toBe('players-revenue-q3.pdf');
    expect(safeExportFilename('💥', 'md')).toBe('player-insights-export.md');
  });

  it('preserves nested list indentation in Markdown exports', () => {
    const markdown = serializeAnswerMarkdown(
      '',
      normalizeAnswer({
        ...answer,
        narrative: ['- Parent finding', '    - Child detail', '        - Grandchild evidence', '- Next finding'].join(
          '\n'
        ),
      })
    );
    expect(markdown).toContain(
      ['- Parent finding', '  - Child detail', '    - Grandchild evidence', '- Next finding'].join('\n')
    );
  });

  it('exports every reader-visible stored turn in chronological order', () => {
    const messages: ConversationMessage[] = [
      { id: 'orphan', role: 'user', content: 'Unmatched opening question' },
      {
        id: 'plain',
        role: 'assistant',
        content: 'A reader-visible assistant note.\ndata_genie({"secret":"diagnostic"})',
      },
      { id: 'q1', role: 'user', content: 'How many players?' },
      { id: 'a1', role: 'assistant', content: 'raw', response_json: answer },
      {
        id: 'plan',
        role: 'assistant',
        content: 'plan',
        response_json: {
          type: 'plan',
          plan: {
            question: 'Compare regions',
            summary: 'I will compare governed regional totals.',
            steps: [{ title: 'Read totals', description: 'Compare the approved source.' }],
            requires_approval: true,
          },
        },
      },
      {
        id: 'clarification',
        role: 'assistant',
        content: 'clarification',
        response_json: {
          type: 'clarification',
          clarification: {
            question: 'Which region?',
            reason: 'The request names no region.',
            options: ['North America', 'Europe'],
            trace: { id: 'hidden-trace' },
          },
        },
      },
      { id: 'last-user', role: 'user', content: 'Europe, please.' },
    ];
    const markdown = serializeConversationMarkdown('Player review', messages);
    expect(markdown).toContain('# Player review');
    const visible = [
      'Unmatched opening question',
      'A reader-visible assistant note.',
      'How many players?',
      'Players increased',
      'Proposed analysis plan',
      'Compare regions',
      'Read totals',
      'Clarification requested',
      'Which region?',
      'North America',
      'Europe, please.',
    ];
    visible.forEach((text) => expect(markdown).toContain(text));
    expect(visible.map((text) => markdown.indexOf(text))).toEqual(
      [...visible.map((text) => markdown.indexOf(text))].sort((left, right) => left - right)
    );
    expect(markdown).not.toContain('diagnostic');
    expect(markdown).not.toContain('hidden-trace');
    expect(markdown).not.toContain('requires_approval');
    expect(markdown.match(/## Answer/g)).toHaveLength(1);
  });
});

describe('binary export signatures', () => {
  it('writes selectable-text PDF bytes for answers and multipage tables', async () => {
    const answerBytes = new Uint8Array(
      await markdownPdf('# Player report\n\n## Answer\n**Players:** 42\n\n'.repeat(40)).arrayBuffer()
    );
    expect(new TextDecoder().decode(answerBytes.slice(0, 8))).toBe('%PDF-1.4');
    const readableAnswer = new TextDecoder().decode(answerBytes);
    expect(readableAnswer).toContain('(Player report)');
    expect(readableAnswer).toContain('(Players: 42)');
    expect(readableAnswer).not.toContain('(## Answer)');
    expect(readableAnswer).not.toContain('(**Players:**');

    const [table] = answerTables(
      normalizeAnswer({
        ...answer,
        narrative: [
          '| Row | Value |',
          '| --- | ---: |',
          ...Array.from({ length: 100 }, (_, index) => `| ${index + 1} | ${index * 2} |`),
        ].join('\n'),
      })
    );
    const tableText = new TextDecoder().decode(await tablePdf(table).arrayBuffer());
    expect(Number(/\/Count (\d+)/.exec(tableText)?.[1])).toBeGreaterThan(1);
    expect(tableText).toContain('(Row');
  });

  it('preserves long table cells and source attribution in PDF output', async () => {
    const longCell =
      'This complete explanation contains every important regional cohort detail without dropping the final words';
    const longSource = 'catalog_with_a_long_name.schema_with_a_long_name.table_with_a_long_source_attribution_name';
    const [table] = answerTables(
      normalizeAnswer({
        ...answer,
        narrative: `| Region | Explanation |\n| --- | --- |\n| Europe | ${longCell} |`,
        sources: [{ name: longSource, freshness: '2026-09-09', role: 'reading' }],
      })
    );
    const pdf = new TextDecoder().decode(await tablePdf(table).arrayBuffer());
    for (const word of longCell.split(' ')) expect(pdf).toContain(word);
    for (let at = 0; at < longSource.length; at += 88) expect(pdf).toContain(longSource.slice(at, at + 88));
  });

  it('sends every wrapped cell and source word to the PNG canvas', async () => {
    const context = {
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn((text: string) => ({ width: text.length * 8 })),
      fillStyle: '',
      strokeStyle: '',
      font: '',
      textBaseline: '',
    };
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob([png], { type: 'image/png' })),
    };
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    const longCell = 'complete explanation with regional cohort details and final preserved words';
    const longSource = 'catalog.schema.an_extremely_long_source_attribution_that_must_be_preserved';
    const [table] = answerTables(
      normalizeAnswer({
        ...answer,
        narrative: `| Region | Explanation |\n| --- | --- |\n| Europe | ${longCell} |`,
        sources: [{ name: longSource, freshness: '2026-09-09', role: 'reading' }],
      })
    );

    const bytes = new Uint8Array(await (await tablePng(table)).arrayBuffer());
    const painted = context.fillText.mock.calls.map(([text]) => String(text)).join(' ');

    expect([...bytes]).toEqual([...png]);
    expect(canvas.getContext).toHaveBeenCalledWith('2d');
    expect(painted.replaceAll(' ', '')).toContain(longCell.replaceAll(' ', ''));
    expect(painted.replaceAll(' ', '')).toContain(longSource);
    expect(canvas.height).toBeGreaterThan(38 * 3);
    vi.unstubAllGlobals();
  });
});

describe('complete PNG table layout', () => {
  const measure = (text: string) => text.length * 8;

  it('wraps every cell and source character without clipping', () => {
    const longCell = `value-${'z'.repeat(800)}-end`;
    const longSource = `catalog.${'source'.repeat(120)}`;
    const table = parsedTable(`| Label | Value |\n| --- | --- |\n| Detail | ${longCell} |`, [
      { name: longSource, freshness: '2026-09-09', role: 'reading' },
    ]);
    const layout = tablePngLayout(table, measure);

    expect(wrappedCanvasLines(longCell, 80, measure).join('')).toBe(longCell);
    expect(layout.rowLines[1][1].join('')).toBe(longCell);
    expect(layout.sourceLines.join('')).toBe(`Sources: ${longSource}`);
    expect(layout.width).toBeLessThanOrEqual(16_384);
    expect(layout.height).toBeLessThanOrEqual(16_384);
  });

  it('fails clearly when canvas dimensions or area exceed browser limits', () => {
    const template = parsedTable('| Label | Value |\n| --- | --- |\n| row | value |');
    const header = template.block.header;
    if (!header) throw new Error('Expected table header');
    const wideTable: ExportTable = {
      ...template,
      block: {
        ...template.block,
        header: { ...header, cells: Array.from({ length: 200 }, (_, index) => header.cells[index % 2]) },
        align: Array.from({ length: 200 }, () => 'left'),
        rows: [],
      },
    };
    expect(() => tablePngLayout(wideTable, measure)).toThrow('too wide for a PNG');

    const tallTable: ExportTable = {
      ...template,
      block: { ...template.block, rows: Array.from({ length: 1_000 }, () => template.block.rows[0]) },
    };
    expect(() => tablePngLayout(tallTable, measure)).toThrow('too large for a PNG');
  });
});
