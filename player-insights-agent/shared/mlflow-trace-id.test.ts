import { describe, expect, it } from 'vitest';
import {
  bindServingMlflowTraceId,
  isMlflowTraceId,
  servingMlflowTraceId,
  withoutUntracedProcess,
  withoutUntracedTimeline,
} from './mlflow-trace-id';

describe('isMlflowTraceId', () => {
  it('accepts MLflow’s own tr-hex shape', () => {
    expect(isMlflowTraceId('tr-00000000000000000000000000000000')).toBe(true);
  });

  it('rejects the agent’s local fallback and anything else', () => {
    expect(isMlflowTraceId('trace-1042')).toBe(false);
    expect(isMlflowTraceId('')).toBe(false);
    expect(isMlflowTraceId('deadbeef-0000-4000-8000-000000000001')).toBe(false);
    expect(isMlflowTraceId(null)).toBe(false);
  });
});

describe('servingMlflowTraceId', () => {
  it('reads a tr- id off the serving envelope', () => {
    expect(
      servingMlflowTraceId({
        custom_outputs: { type: 'answer' },
        databricks_output: { databricks_request_id: 'tr-0123456789abcdef0123456789abcdef' },
      })
    ).toBe('tr-0123456789abcdef0123456789abcdef');
  });

  it('does not treat a UUID request id as an MLflow trace', () => {
    expect(
      servingMlflowTraceId({
        databricks_output: { databricks_request_id: 'deadbeef-0000-4000-8000-000000000001' },
      })
    ).toBe('');
  });
});

describe('bindServingMlflowTraceId', () => {
  it('fills a missing MLflow id from the envelope and leaves a real one alone', () => {
    const local = { trace: { id: 'trace-local', stages: [{}] } };
    const bound = bindServingMlflowTraceId(local, 'tr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(bound.trace.id).toBe('tr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(bound.trace.stages).toEqual([{}]);

    const live = { trace: { id: 'tr-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', stages: [{}] } };
    expect(bindServingMlflowTraceId(live, 'tr-cccccccccccccccccccccccccccccccc')).toBe(live);
  });
});

describe('withoutUntracedProcess', () => {
  it('strips local stages when there is no MLflow id but keeps the agent’s meters', () => {
    const stripped = withoutUntracedProcess({
      sql: 'SELECT 1',
      trace: { id: 'trace-local', stages: [{ id: 'discover' }], totalMs: 77_000, toolCalls: 4 },
    });
    expect(stripped.sql).toBe('SELECT 1');
    expect(stripped.trace).toEqual({ id: 'trace-local', stages: [], totalMs: 77_000, toolCalls: 4 });
  });

  it('leaves a recorded run’s process view intact', () => {
    const live = {
      trace: { id: 'tr-dddddddddddddddddddddddddddddddd', stages: [{ id: 'discover' }], totalMs: 1200, toolCalls: 2 },
    };
    expect(withoutUntracedProcess(live)).toBe(live);
  });
});

describe('withoutUntracedTimeline', () => {
  it('does not report 0 tools or a missing wall time on a run that measured both', () => {
    const kept = withoutUntracedTimeline({
      id: 'trace-local',
      stages: [{ id: 'step-1-1-run_sql' }],
      totalMs: 150_500,
      toolCalls: 4,
      prompt_tokens: 111_872,
      completion_tokens: 2_340,
      total_tokens: 114_212,
    });
    expect(kept.stages).toEqual([]);
    expect(kept.totalMs).toBe(150_500);
    expect(kept.toolCalls).toBe(4);
    expect(kept.total_tokens).toBe(114_212);
  });
});
