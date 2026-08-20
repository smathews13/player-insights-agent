import { describe, expect, it } from 'vitest';

import { conversationFilterOptions, conversationRunTitle, toolStageDurationMs } from './RunExplorer';
import type { Run } from './app-types';
import type { TraceStage } from './answer-shape';

const stage = (id: string, kind: string, duration: number, name = id): TraceStage => ({
  id, kind, duration, name, start: 0, status: 'complete', calls: 1, input: '', output: '',
});

describe('Run Explorer feedback', () => {
  it('sums tool, finder, and SQL durations instead of showing 0.0s', () => {
    expect(toolStageDurationMs([
      stage('orchestrator', 'agent', 10_000, 'Orchestrator'),
      stage('data_source_finder', 'agent', 2_000, 'Data Source Finder'),
      stage('step-1-1-data_genie', 'tool', 3_000),
      stage('sql-validation', 'agent', 500, 'Validated SQL'),
      stage('synthesis', 'agent', 1_000, 'Prepared the answer'),
    ])).toBe(5_500);
  });

  it('numbers a run inside its conversation', () => {
    const run = (id: string, conversation_id: string, created_at: string): Run => ({
      id, conversation_id, created_at, kind: 'conversation', prompt: id,
      stakeholder: 'sam@example.com', status: 'complete', duration_ms: 1, rating: null,
    });
    const runs = [
      run('c2-r1', 'c2', '2026-08-19T03:00:00Z'),
      run('c1-r2', 'c1', '2026-08-19T02:00:00Z'),
      run('c1-r1', 'c1', '2026-08-19T01:00:00Z'),
    ];
    expect(conversationRunTitle(runs, runs[1])).toBe('Conversation 1, Run 2');
    expect(conversationFilterOptions(runs)).toEqual([
      { id: 'c1', label: 'Conversation 1' },
      { id: 'c2', label: 'Conversation 2' },
    ]);
  });
});
