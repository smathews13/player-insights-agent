import { describe, expect, it } from 'vitest';

import { normalizeStage, normalizeTrace } from './answer-shape';
import { normalizeRunTrace } from './app-state';
import type { RunTrace } from './app-types';

describe('token usage read boundaries', () => {
  it('normalizes stored and live stages through the same stage adapter', () => {
    const raw = {
      id: 'synthesis',
      token_usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedReadTokens: 40,
        cacheStatus: 'used',
        attempts: 1,
        totalMismatch: false,
      },
    };
    expect(normalizeStage(raw, 0).token_usage).toEqual(normalizeTrace({ stages: [raw] }).stages[0].token_usage);
  });

  it('keeps legacy absence absent and drops malformed evidence rather than printing zeroes', () => {
    expect(normalizeStage({ id: 'legacy' }, 0).token_usage).toBeUndefined();
    expect(
      normalizeStage(
        {
          id: 'malformed',
          token_usage: { totalTokens: '120', cachedReadTokens: -1, cacheStatus: 'used', attempts: 0 },
        },
        0
      ).token_usage
    ).toBeUndefined();
  });

  it('preserves reconciliation and attributed usage when a stored run is normalized', () => {
    const run = {
      trace: {
        id: 'tr-1',
        totalMs: 1,
        toolCalls: 0,
        total_tokens: 240,
        token_reconciliation: {
          attributedTokens: 120,
          attributedCalls: 1,
          overviewTokens: 240,
          coveragePercent: 50,
          unattributedTokens: 120,
          nestedAggregateTokens: 120,
          mismatchCount: 0,
        },
        stages: [
          {
            id: 'synthesis',
            token_usage: {
              inputTokens: 100,
              outputTokens: 20,
              totalTokens: 120,
              cacheStatus: 'unavailable',
              attempts: 1,
              totalMismatch: false,
            },
          },
        ],
      },
    } as unknown as RunTrace;
    const normalized = normalizeRunTrace(run);
    expect(normalized.trace?.stages[0].token_usage?.totalTokens).toBe(120);
    expect(normalized.trace?.token_reconciliation?.unattributedTokens).toBe(120);
  });
});
