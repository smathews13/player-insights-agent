import { describe, expect, it } from 'vitest';
import { normalizeAnswer } from './answer-shape';
import {
  CONVERSATION_EXPORT_SCHEMA_VERSION,
  serializeConversationHtml,
  serializeConversationJson,
  serializeConversationMarkdown,
} from './export-serializers';
import type { ConversationMessage } from './app-types';

const answerWithChart = normalizeAnswer({
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
  caveats: ['Figures exclude anonymous players.'],
  charts: [{ id: 'c1', title: 'Daily players', kind: 'line', data: [{ x: [1, 2], y: [3, 4] }], layout: {} }],
  sql: 'SELECT secret_internal_column FROM internal_table',
  trace: { id: 'tr-1', stages: [{ id: 'raw', input: 'private input', output: 'private output' }] },
});

const messages: ConversationMessage[] = [
  { id: 'q1', role: 'user', content: 'How many players?' },
  { id: 'a1', role: 'assistant', content: 'raw', response_json: answerWithChart },
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

const chartImages = new Map([['a1', new Map([['c1', 'data:image/png;base64,AAAABBBB']])]]);

describe('whole-conversation HTML export', () => {
  it('is a self-contained themed document that reuses the answer renderer for each turn', () => {
    const html = serializeConversationHtml('Player review', messages, chartImages);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<h1>Player review</h1>');
    expect(html).toContain('<h2>User</h2>');
    expect(html).toContain('Players increased');
    expect(html).toContain('<table>');
    expect(html).toContain('Proposed analysis plan');
    expect(html).toContain('Clarification requested');
    expect(html).toContain('Europe, please.');
    // The chart renders inline as the supplied data URL, not as a script.
    expect(html).toContain('src="data:image/png;base64,AAAABBBB"');
    expect(html).toContain('Exported from Player Insights.');
    // Turns are separated by the themed rule.
    expect(html).toContain('turn-separator');
  });

  it('omits trace, SQL and tool diagnostics at conversation scope', () => {
    const html = serializeConversationHtml('Player review', messages, chartImages);
    expect(html).not.toContain('data_genie');
    expect(html).not.toContain('secret_internal_column');
    expect(html).not.toContain('private input');
    expect(html).not.toContain('hidden-trace');
    expect(html).not.toContain('requires_approval');
  });
});

interface ExportedConversation {
  schema_version: string;
  title: string;
  turns: Record<string, unknown>[];
}

describe('whole-conversation JSON export', () => {
  it('emits an ordered list of typed, reader-safe turns with native chart specs', () => {
    const parsed = JSON.parse(serializeConversationJson('Player review', messages)) as ExportedConversation;
    expect(parsed.schema_version).toBe(CONVERSATION_EXPORT_SCHEMA_VERSION);
    expect(parsed.title).toBe('Player review');
    expect(parsed.turns.map((turn) => turn.type)).toEqual(['user', 'answer', 'plan', 'clarification', 'user']);
    const answerTurn = parsed.turns[1];
    expect(String(answerTurn.headline)).toContain('Players increased');
    // Charts survive as their native Plotly spec, not a raster.
    const charts = answerTurn.charts as { plotly: { data: { y: number[] }[] } }[];
    expect(charts[0].plotly.data[0].y).toEqual([3, 4]);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain('secret_internal_column');
    expect(serialized).not.toContain('data_genie');
    expect(serialized).not.toContain('hidden-trace');
  });
});

describe('whole-conversation Markdown charts', () => {
  it('embeds each answer turn chart as an image when pictures are supplied', () => {
    const markdown = serializeConversationMarkdown('Player review', messages, chartImages);
    expect(markdown).toContain('![Daily players](data:image/png;base64,AAAABBBB)');
    // Copy path (no images) leaves the transcript prose-and-tables.
    expect(serializeConversationMarkdown('Player review', messages)).not.toContain('data:image/png');
  });
});
