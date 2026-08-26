import { describe, expect, it } from 'vitest';
import { DEFAULT_BENCHMARK_SETTINGS } from '../../shared/benchmark-settings';
import { shouldSampleLiveTrace } from '../../shared/eval-live-scoring';
import { scoreLiveDeterministic, scoreLiveJudges, scoreSampledAskTurn } from './live-ask-scoring';

const turn = {
  conversationId: 'conv-live',
  messageId: 'msg-live',
  question: 'How many players?',
  response: 'Twelve.',
  sql: 'SELECT count(*) FROM cat.sch.players',
  note: '',
  durationMs: 800,
};

describe('sampled Ask scoring', () => {
  it('scores only when traces are on and the turn is in the sample', () => {
    const inSample = shouldSampleLiveTrace('conv-live:msg-live', 0.2);
    const scored = scoreLiveDeterministic(turn, DEFAULT_BENCHMARK_SETTINGS);
    if (inSample) {
      expect(scored?.sampled).toBe(true);
      expect(scored?.checks.some((entry) => entry.id === 'fqn-present' && entry.passed === true)).toBe(true);
    } else {
      expect(scored).toBeNull();
    }
    expect(
      scoreLiveDeterministic(turn, { ...DEFAULT_BENCHMARK_SETTINGS, alwaysOnTraces: false })
    ).toBeNull();
  });

  it('does not fail Ask when the store write is lost', async () => {
    const scored = await scoreSampledAskTurn({
      client: {
        lakebase: {
          query: () => Promise.reject(new Error('relation eval_live_scores does not exist')),
        },
      } as never,
      settings: { ...DEFAULT_BENCHMARK_SETTINGS, alwaysOnTraces: true },
      turn: { ...turn, conversationId: 'always-in', messageId: 'rate-1' },
      sampleRate: 1,
    });
    expect(scored).toBeNull();
  });

  it('sends a free-form custom judge prompt instead of only Guidelines text', async () => {
    const seen: string[] = [];
    await scoreLiveJudges(
      turn,
      {
        ...DEFAULT_BENCHMARK_SETTINGS,
        enabledJudges: [],
        customJudges: [
          {
            name: 'tone',
            guidelines: '',
            prompt: 'Is {{response}} a complete answer to {{question}}?',
          },
        ],
      },
      async (payload) => {
        const content = (payload.messages as { content: string }[])[0]?.content ?? '';
        seen.push(content);
        return { choices: [{ message: { content: '{"result":"yes","rationale":"ok"}' } }] };
      }
    );
    expect(seen[0]).toContain('Is Twelve. a complete answer to How many players?');
    expect(seen[0]).toContain('"result": "yes|no"');
  });

  it('sends the whole Ask thread to a multi-turn judge', async () => {
    const seen: string[] = [];
    await scoreLiveJudges(
      {
        ...turn,
        turns: [
          { role: 'user', content: 'How many players?' },
          { role: 'assistant', content: 'Twelve.' },
          { role: 'user', content: 'And last month?' },
          { role: 'assistant', content: 'Eleven.' },
        ],
      },
      {
        ...DEFAULT_BENCHMARK_SETTINGS,
        enabledJudges: [],
        enabledMultiTurnJudges: ['conversation_completeness'],
      },
      async (payload) => {
        const content = (payload.messages as { content: string }[])[0]?.content ?? '';
        seen.push(content);
        return { choices: [{ message: { content: '{"result":"yes","rationale":"ok"}' } }] };
      }
    );
    expect(seen[0]).toContain('And last month?');
    expect(seen[0]).toContain('Eleven.');
  });
});
