import { describe, expect, it } from 'vitest';

import { attributeTokenUsage, invocationUsage, type TokenEvidenceSpan } from './llm-token-usage';

describe('provider token usage adapters', () => {
  it.each([
    [
      'MLflow chat',
      { 'mlflow.chat.tokenUsage': '{"input_tokens":120,"output_tokens":30,"total_tokens":150}' },
      { input: 120, output: 30, total: 150, cachedRead: undefined, cacheWrite: undefined },
    ],
    [
      'OpenAI',
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 60 },
        },
      },
      { input: 100, output: 20, total: 120, cachedRead: 60, cacheWrite: undefined },
    ],
    [
      'Anthropic',
      {
        usage: {
          input_tokens: 80,
          output_tokens: 10,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 12,
        },
      },
      { input: 80, output: 10, total: undefined, cachedRead: 40, cacheWrite: 12 },
    ],
    [
      'Databricks gen_ai',
      {
        'gen_ai.usage.input_tokens': 75,
        'gen_ai.usage.output_tokens': 25,
        'gen_ai.usage.total_tokens': 100,
        'gen_ai.usage.cached_input_tokens': 0,
      },
      { input: 75, output: 25, total: 100, cachedRead: 0, cacheWrite: undefined },
    ],
  ])('normalizes %s without changing provider totals', (_name, attributes, expected) => {
    expect(invocationUsage(attributes)).toEqual(expected);
  });

  it('rejects absent, negative, fractional, numeric-string, and malformed usage', () => {
    expect(invocationUsage({})).toBeNull();
    expect(
      invocationUsage({
        usage: {
          input_tokens: -1,
          output_tokens: 1.5,
          total_tokens: '200',
          cache_read_input_tokens: '{bad',
        },
      })
    ).toBeNull();
  });
});

function span(
  id: string,
  name: string,
  usage: Record<string, unknown> | null,
  overrides: Partial<TokenEvidenceSpan> = {}
): TokenEvidenceSpan {
  return {
    span_id: id,
    parent_span_id: '',
    name,
    attributes: {
      'mlflow.spanType': '"LLM"',
      ...(usage ? { 'mlflow.chat.tokenUsage': JSON.stringify(usage) } : {}),
    },
    ...overrides,
  };
}

describe('step attribution and reconciliation', () => {
  it('aggregates multiple calls and genuine retries while deduplicating exported copies by span id', () => {
    const first = span('call-1', 'data_source_finder.llm.step-1', {
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
      cache_read_input_tokens: 25,
    });
    const retry = span('call-2', 'data_source_finder.llm.step-1', {
      input_tokens: 120,
      output_tokens: 12,
      total_tokens: 132,
      cache_read_input_tokens: 0,
    });
    const result = attributeTokenUsage([first, first, retry], ['step-1'], 242);

    expect(result.stages['step-1']).toEqual({
      inputTokens: 220,
      outputTokens: 22,
      totalTokens: 242,
      cachedReadTokens: 25,
      cacheWriteTokens: undefined,
      cacheStatus: 'used',
      attempts: 2,
      totalMismatch: false,
    });
    expect(result.reconciliation).toMatchObject({
      attributedTokens: 242,
      attributedCalls: 2,
      coveragePercent: 100,
      cachedReadTokens: 25,
      cacheCoveredInputTokens: 220,
    });
    expect(result.invocations).toEqual([
      expect.objectContaining({
        invocationId: 'call-1',
        stageId: 'step-1',
        attempt: 1,
        totalTokens: 110,
        cachedReadTokens: 25,
        cacheStatus: 'used',
      }),
      expect.objectContaining({
        invocationId: 'call-2',
        stageId: 'step-1',
        attempt: 2,
        totalTokens: 132,
        cachedReadTokens: 0,
        cacheStatus: 'not-used',
      }),
    ]);
  });

  it('does not count a parent aggregate again and reports partial overview coverage', () => {
    const parent = span(
      'parent',
      'orchestrator.loop',
      { input_tokens: 200, output_tokens: 20, total_tokens: 220 },
      {
        attributes: {
          'mlflow.spanType': '"AGENT"',
          'mlflow.chat.tokenUsage': '{"input_tokens":200,"output_tokens":20,"total_tokens":220}',
        },
      }
    );
    const first = span(
      'first',
      'data_source_finder.llm.step-1',
      { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      { parent_span_id: 'parent' }
    );
    const second = span(
      'second',
      'data_source_finder.llm.step-2',
      { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      { parent_span_id: 'parent' }
    );
    const result = attributeTokenUsage([parent, first, second], ['step-1', 'step-2'], 440);

    expect(result.reconciliation).toMatchObject({
      attributedTokens: 220,
      overviewTokens: 440,
      coveragePercent: 50,
      unattributedTokens: 220,
      nestedAggregateTokens: 220,
    });
  });

  it('keeps explicit cache zero distinct from unavailable and preserves total mismatches', () => {
    const zero = span('zero', 'orchestrator.synthesis', {
      input_tokens: 50,
      output_tokens: 10,
      total_tokens: 70,
      cached_input_tokens: 0,
    });
    const absent = span('absent', 'orchestrator.narrative', {
      input_tokens: 20,
      output_tokens: 5,
      total_tokens: 25,
    });
    const result = attributeTokenUsage([zero, absent], ['synthesis', 'narrative'], 95);

    expect(result.stages.synthesis).toMatchObject({ cacheStatus: 'not-used', totalMismatch: true });
    expect(result.stages.narrative).toMatchObject({ cacheStatus: 'unavailable', totalMismatch: false });
    expect(result.reconciliation.mismatchCount).toBe(1);
  });

  it('leaves direct LLM calls unattributed rather than allocating them to a tool step', () => {
    const result = attributeTokenUsage(
      [span('judge', 'benchmark.judge', { input_tokens: 40, output_tokens: 5, total_tokens: 45 })],
      ['step-1-1-run_sql'],
      45
    );
    expect(result.stages).toEqual({});
    expect(result.reconciliation).toMatchObject({ attributedTokens: 0, unattributedTokens: 45 });
  });

  it('matches the redacted the demo workspace shape and excludes its aggregate orchestrator span', () => {
    const example = [
      span(
        'aggregate',
        'orchestrator.loop',
        { input_tokens: 74_741, output_tokens: 2_001, total_tokens: 76_742 },
        {
          attributes: {
            'mlflow.spanType': '"AGENT"',
            'mlflow.chat.tokenUsage': '{"input_tokens":74741,"output_tokens":2001,"total_tokens":76742}',
          },
        }
      ),
      span(
        'planner-1',
        'data_source_finder.llm.step-1',
        { input_tokens: 7_189, output_tokens: 78, total_tokens: 7_267 },
        { parent_span_id: 'aggregate' }
      ),
      span(
        'planner-2',
        'data_source_finder.llm.step-2',
        { input_tokens: 8_515, output_tokens: 132, total_tokens: 8_647 },
        { parent_span_id: 'aggregate' }
      ),
      span(
        'planner-3',
        'data_source_finder.llm.step-3',
        { input_tokens: 9_133, output_tokens: 67, total_tokens: 9_200 },
        { parent_span_id: 'aggregate' }
      ),
      span(
        'planner-4',
        'data_source_finder.llm.step-4',
        { input_tokens: 9_440, output_tokens: 94, total_tokens: 9_534 },
        { parent_span_id: 'aggregate' }
      ),
      span(
        'planner-5',
        'data_source_finder.llm.step-5',
        { input_tokens: 9_557, output_tokens: 258, total_tokens: 9_815 },
        { parent_span_id: 'aggregate' }
      ),
      span(
        'planner-6',
        'data_source_finder.llm.step-6',
        { input_tokens: 9_949, output_tokens: 172, total_tokens: 10_121 },
        { parent_span_id: 'aggregate' }
      ),
      span(
        'planner-7',
        'data_source_finder.llm.step-7',
        { input_tokens: 10_324, output_tokens: 131, total_tokens: 10_455 },
        { parent_span_id: 'aggregate' }
      ),
      span(
        'planner-8',
        'data_source_finder.llm.step-8',
        { input_tokens: 10_634, output_tokens: 1_069, total_tokens: 11_703 },
        { parent_span_id: 'aggregate' }
      ),
      span('answer', 'orchestrator.synthesis', { input_tokens: 6_418, output_tokens: 1_416, total_tokens: 7_834 }),
    ];
    const result = attributeTokenUsage(
      example,
      ['step-1', 'step-2', 'step-3', 'step-4', 'step-5', 'step-6', 'step-7', 'step-8', 'synthesis'],
      161_318
    );
    expect(result.stages['step-1'].totalTokens).toBe(7_267);
    expect(result.stages.synthesis.totalTokens).toBe(7_834);
    expect(result.reconciliation).toMatchObject({
      attributedTokens: 84_576,
      nestedAggregateTokens: 76_742,
      unattributedTokens: 76_742,
    });
    expect(result.reconciliation.cachedReadTokens).toBeUndefined();
  });
});
