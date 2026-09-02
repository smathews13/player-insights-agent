import { describe, expect, it } from 'vitest';
import servingResponses from './__fixtures__/serving-responses.json';
import { conversationRunTrace, extractStructuredAnswer } from './insights-routes';

const PROCESS_CAVEATS = [
  'No governed table was read for this answer, so it is not grounded in queried data.',
  'Review the generated SQL and source details before using this result.',
  'All 12 tables are untagged (no franchise label); this means franchise scope is unknown until a table is described or queried.',
  'Optional tail was clipped at the DSF handoff bound, so some metadata fields may be incomplete.',
  'All 12 tables are declared but read access depends on the caller’s Unity Catalog grants — a declared table is not a guarantee of row-level access.',
];

function endpointResponse(options: { sql?: string; sources?: unknown[] } = {}) {
  const response = structuredClone(servingResponses.liveAnswerResponse) as {
    custom_outputs: { answer: Record<string, unknown> };
  };
  response.custom_outputs.answer.caveats = [...PROCESS_CAVEATS];
  response.custom_outputs.answer.sql = options.sql ?? '';
  response.custom_outputs.answer.sources = options.sources ?? [];
  return response;
}

describe('server answer-content normalization', () => {
  it('normalizes the canonical live answer before persistence can consume it', () => {
    const raw = endpointResponse();
    const answer = extractStructuredAnswer(raw);
    expect(answer?.caveats).toEqual([]);
    // The source serving payload remains available unchanged for transport/audit
    // logging; normalization returns canonical app data without mutating it.
    expect(raw.custom_outputs.answer.caveats).toEqual(PROCESS_CAVEATS);
  });

  it('removes generic SQL/source validation even when those details exist', () => {
    const answer = extractStructuredAnswer(
      endpointResponse({
        sql: 'SELECT * FROM main.analytics.players',
        sources: [{ name: 'main.analytics.players', freshness: 'Current' }],
      })
    );
    expect(answer?.caveats).toEqual([]);
  });

  it('normalizes historical stored answers at read time without rewriting the row', () => {
    const stored = endpointResponse().custom_outputs.answer;
    const row = {
      id: 'msg-stored',
      conversation_id: 'conv-stored',
      created_at: '2026-09-01T00:00:00.000Z',
      prompt: 'What tables are available?',
      stakeholder: 'analyst@example.com',
      response_json: stored,
    };
    const view = conversationRunTrace(row, 'experiment-1');
    expect(view.caveats).toEqual([]);
    expect(row.response_json.caveats).toEqual(PROCESS_CAVEATS);
  });
});
