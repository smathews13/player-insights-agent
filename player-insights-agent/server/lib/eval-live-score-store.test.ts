import { describe, expect, it } from 'vitest';
import { APP_SCHEMA } from '../../shared/app-schema';
import type { LiveTraceScore } from '../../shared/eval-live-scoring';
import { appendLiveScore, EVAL_LIVE_SCORES_TABLE, listLiveScores } from './eval-live-score-store';

function score(id: string): LiveTraceScore {
  return {
    id,
    at: '2026-08-25T00:00:00.000Z',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    traceId: 'tr-abc',
    question: 'How many players?',
    turnCount: 1,
    sampled: true,
    sampleRate: 0.2,
    checks: [],
    judges: [],
  };
}

function client(rows: Record<string, unknown>[] = []) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  return {
    calls,
    lakebase: {
      query: (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return Promise.resolve({ rows });
      },
    },
  };
}

describe('live score store', () => {
  it('qualifies the table with APP_SCHEMA', () => {
    expect(EVAL_LIVE_SCORES_TABLE).toBe(`${APP_SCHEMA}.eval_live_scores`);
  });

  it('writes a sampled score and lists what was stored', async () => {
    const writer = client();
    await appendLiveScore(writer as never, score('live-1'));
    expect(writer.calls[0]?.values?.[0]).toBe('live-1');

    const listed = await listLiveScores(
      client([{ score: score('live-1') }]) as never
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe('live-1');
  });

  it('returns nothing rather than inventing scores when the table is missing', async () => {
    const broken = {
      lakebase: {
        query: () => Promise.reject(new Error('relation eval_live_scores does not exist')),
      },
    };
    expect(await listLiveScores(broken as never)).toEqual([]);
  });
});
