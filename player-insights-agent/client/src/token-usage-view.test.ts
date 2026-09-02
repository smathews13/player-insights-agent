import { describe, expect, it } from 'vitest';

import type { TraceSummary } from './answer-shape';
import { runTokenUsageView, stepTokenUsageView } from './token-usage-view';

const LIVE = {
  id: 'tr-live-example',
  totalMs: 74_500,
  toolCalls: 18,
  prompt_tokens: 81_159,
  completion_tokens: 3_417,
  total_tokens: 84_576,
  stages: [
    {
      id: 'step-1',
      name: 'Chose the next step',
      kind: 'agent',
      start: 0,
      duration: 1,
      status: 'complete',
      calls: 1,
      input: '',
      output: '',
      token_usage: {
        inputTokens: 81_159,
        outputTokens: 3_417,
        totalTokens: 84_576,
        cacheStatus: 'unavailable',
        attempts: 1,
        totalMismatch: false,
      },
    },
  ],
  token_reconciliation: {
    attributedTokens: 84_576,
    attributedCalls: 1,
    overviewTokens: 84_576,
    coveragePercent: 100,
    nestedAggregateTokens: 76_742,
    mismatchCount: 0,
  },
  token_invocations: [
    {
      invocationId: 'span-1',
      stageId: 'step-1',
      attempt: 1,
      inputTokens: 81_159,
      outputTokens: 3_417,
      totalTokens: 84_576,
      cacheStatus: 'unavailable',
      attempts: 1,
      totalMismatch: false,
    },
  ],
} satisfies TraceSummary;

describe('the shared Run Explorer token view', () => {
  it('keeps the redacted the demo workspace total consistent without inventing cache evidence', () => {
    const view = runTokenUsageView(LIVE);
    expect(view).toMatchObject({
      available: true,
      inputTokens: 81_159,
      outputTokens: 3_417,
      totalTokens: 84_576,
      cacheReported: false,
      attributedTokens: 84_576,
      coveragePercent: 100,
      unattributedTokens: 0,
    });
    expect(view.cachedReadTokens).toBeUndefined();
    expect(view.invocations[0]).toMatchObject({
      component: 'Orchestrator turn 1',
      attempt: 1,
      total: '84,576',
      cached: 'Not reported',
    });
  });

  it('returns one unavailable state for a legacy trace instead of zero usage', () => {
    expect(runTokenUsageView({ id: 'legacy', totalMs: 1, toolCalls: 0, stages: [] })).toMatchObject({
      available: false,
      cacheReported: false,
      invocations: [],
    });
  });

  it('uses the same step wording as Agent Map and Timeline', () => {
    expect(stepTokenUsageView(LIVE.stages[0].token_usage)).toMatchObject({
      summary: '85K tokens',
      total: '84,576',
      cacheStatus: 'Not reported',
    });
  });
});
