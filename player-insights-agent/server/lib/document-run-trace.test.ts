import { describe, expect, it } from 'vitest';

import { documentRunTrace } from './document-run-trace';

function stage(
  id: string,
  duration: number,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id,
    name: id,
    kind: id === 'orchestrator' ? 'agent' : 'tool',
    start: 0,
    duration,
    status: 'complete',
    calls: 1,
    input: '',
    output: '',
    depth: id === 'orchestrator' ? 0 : 1,
    parent_id: id === 'orchestrator' ? '' : 'orchestrator',
    ...overrides,
  };
}

describe('document run trace', () => {
  it('prefers a valid trace sent beside the document by the endpoint', () => {
    const sent = {
      id: 'tr-a87e1e2613d6b9bcdbb3e687766ba8b0',
      totalMs: 324_600,
      toolCalls: 2,
      stages: [stage('orchestrator', 324_600)],
      total_tokens: 1200,
    };
    expect(
      documentRunTrace(
        { custom_outputs: { type: 'dashboard', dashboard: {}, trace: sent } },
        [stage('orchestrator', 10_000)],
        'tr-other'
      )
    ).toEqual(sent);
  });

  it('builds a fallback trace whose duration is root wall time rather than nested duration sum', () => {
    const stages = [
      stage('orchestrator', 10_000),
      stage('first-tool', 4_000),
      stage('second-tool', 4_000, { start: 4_000 }),
    ];
    const trace = documentRunTrace({}, stages, 'tr-a87e1e2613d6b9bcdbb3e687766ba8b0');
    expect(trace).toMatchObject({
      id: 'tr-a87e1e2613d6b9bcdbb3e687766ba8b0',
      totalMs: 10_000,
      toolCalls: 2,
    });
    expect(trace.stages).toHaveLength(3);
  });

  it('stores a trailing running stage as failed on a terminal document', () => {
    const trace = documentRunTrace(
      {},
      [stage('orchestrator', 10_000), stage('dashboard-render', 4_000, { status: 'running' })],
      'tr-a87e1e2613d6b9bcdbb3e687766ba8b0'
    );
    expect(trace.stages).toEqual([
      expect.objectContaining({ id: 'orchestrator', status: 'complete' }),
      expect.objectContaining({ id: 'dashboard-render', status: 'failed' }),
    ]);
  });
});
