import { describe, expect, it, vi } from 'vitest';
import { normalizeAnswer } from './answer-shape';
import {
  answerTables,
  safeExportFilename,
  serializeAnswerMarkdown,
  serializeConversationMarkdown,
  serializeTableTsv,
} from './export-serializers';
import { markdownPdf, tablePdf, tablePng } from './export-binary';
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

  it('uses stable filesystem-safe filenames', () => {
    expect(safeExportFilename('  Players / Revenue: Q3?  ', '.PDF')).toBe('players-revenue-q3.pdf');
    expect(safeExportFilename('💥', 'md')).toBe('player-insights-export.md');
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
      scale: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
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
    vi.stubGlobal('window', { devicePixelRatio: 1 });
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
    for (const word of longCell.split(' ')) expect(painted).toContain(word);
    expect(painted.replaceAll(' ', '')).toContain(longSource);
    expect(canvas.height).toBeGreaterThan(38 * 3);
    vi.unstubAllGlobals();
  });
});
