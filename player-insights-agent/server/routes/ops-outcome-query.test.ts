import { describe, expect, it } from 'vitest';
import { RUN_OUTCOMES_QUERY } from './ops-routes';
import { readTrafficBreakdowns } from '../lib/ops-traffic';

describe('Ops failure and refusal population', () => {
  it('combines durable ledger outcomes with stored-answer verdicts', () => {
    expect(RUN_OUTCOMES_QUERY).toContain('answers AS');
    expect(RUN_OUTCOMES_QUERY).toContain('ledger_population AS');
    expect(RUN_OUTCOMES_QUERY).toContain('legacy_population AS');
    expect(RUN_OUTCOMES_QUERY).toContain('UNION ALL');
  });

  it('deduplicates stored answers and tool stages across terminal message, trace, and run identities', () => {
    expect(RUN_OUTCOMES_QUERY).toContain('candidate.message_id = r.terminal_message_id');
    expect(RUN_OUTCOMES_QUERY).toContain('candidate.trace_id = r.trace_id');
    expect(RUN_OUTCOMES_QUERY).toContain('WHERE NOT EXISTS');
    expect(RUN_OUTCOMES_QUERY).toContain('r.terminal_message_id = a.message_id');
    expect(RUN_OUTCOMES_QUERY).toContain('durable_tool_events AS');
    expect(RUN_OUTCOMES_QUERY).toContain('DISTINCT ON (event_id, call_id)');
  });

  it('keeps terminal outcome classes distinct without reading failure causes', () => {
    expect(RUN_OUTCOMES_QUERY).toContain("r.state IN ('FAILED', 'DEADLINE_EXCEEDED', 'PERSISTENCE_FAILED')");
    expect(RUN_OUTCOMES_QUERY).toContain("WHEN a.answer_status = 'failed' THEN 'FAILED'");
    expect(RUN_OUTCOMES_QUERY).toContain("WHEN a.answer_status = 'partial' THEN 'PARTIAL'");
    expect(RUN_OUTCOMES_QUERY).not.toContain('UNKNOWN_FAILURE_CAUSE');
    expect(RUN_OUTCOMES_QUERY).not.toContain('UNKNOWN_REFUSAL_CAUSE');
  });

  it('prefers durable stage evidence when the stored answer repeats the same tool call', () => {
    expect(RUN_OUTCOMES_QUERY).toContain('source_priority DESC, status_priority DESC');
    expect(RUN_OUTCOMES_QUERY).toContain('status_priority DESC, seq DESC');
  });

  it('recognizes current and legacy external-tool shapes without counting agent lifecycle stages', () => {
    expect(RUN_OUTCOMES_QUERY).toContain("'(^|-)run_sql$'");
    expect(RUN_OUTCOMES_QUERY).toContain("'(^|-)search_semantics$'");
    expect(RUN_OUTCOMES_QUERY).toContain("'(^|-)dictionary_genie$'");
    expect(RUN_OUTCOMES_QUERY).toContain("->>'kind' IN ('tool', 'sql', 'discovery', 'genie')");
    expect(RUN_OUTCOMES_QUERY).toContain("THEN 'unknown_tool'");
    expect(RUN_OUTCOMES_QUERY).not.toContain("->>'kind' = 'agent' THEN");
  });

  it('uses one timezone-bounded population for outcomes, tools, and coverage', () => {
    expect(RUN_OUTCOMES_QUERY).toContain('FROM selected_population');
    expect(RUN_OUTCOMES_QUERY).toContain('FROM selected_tools');
    expect(RUN_OUTCOMES_QUERY).toContain("SELECT 'outcome_covered'");
    expect(RUN_OUTCOMES_QUERY).toContain("SELECT 'tool_covered'");
  });

  it('parses the production-shaped 32-run aggregate without losing names or counts', () => {
    const read = readTrafficBreakdowns([
      { kind: 'population', key: '', count: '32' },
      { kind: 'outcome_covered', key: '', count: '32' },
      { kind: 'tool_covered', key: '', count: '32' },
      { kind: 'failure', key: 'RUN_DEADLINE_EXCEEDED', count: '2' },
      { kind: 'failure', key: 'UNKNOWN_FAILURE_CAUSE', count: '1' },
      { kind: 'refusal', key: 'USER_NOT_AUTHORIZED', count: '3' },
      { kind: 'tool', key: 'Ran a governed read-only query', count: '19' },
      { kind: 'tool', key: 'Called search_semantics', count: '7' },
    ]);
    expect(read.runsInRange).toBe(32);
    expect(read.failuresByCause).toEqual([
      { key: 'RUN_DEADLINE_EXCEEDED', label: 'RUN_DEADLINE_EXCEEDED', count: 2 },
      { key: 'UNKNOWN_FAILURE_CAUSE', label: 'Unknown failure cause', count: 1 },
    ]);
    expect(read.refusalsByCause[0]).toMatchObject({
      key: 'REFUSAL_PERMISSION_ACCESS_SCOPE',
      label: 'Permission, access or scope',
      count: 3,
    });
    expect(read.toolCalls.map((row) => [row.label, row.count])).toEqual([
      ['Ran a governed read-only query', 19],
      ['Called search_semantics', 7],
    ]);
    expect(read.outcomesCoverage.state).toBe('complete');
  });

  it('parses canonical terminal outcomes without a cause query', () => {
    const read = readTrafficBreakdowns([
      { kind: 'population', key: '', count: '29' },
      { kind: 'outcome_covered', key: '', count: '28' },
      { kind: 'tool_covered', key: '', count: '27' },
      { kind: 'run_outcome', key: 'completed', count: '20' },
      { kind: 'run_outcome', key: 'partial', count: '4' },
      { kind: 'run_outcome', key: 'refused', count: '2' },
      { kind: 'run_outcome', key: 'failed', count: '2' },
      { kind: 'run_outcome', key: 'unclassified', count: '1' },
    ]);
    expect(read.runStatistics).toEqual({
      total: 29,
      completed: 20,
      partial: 4,
      refused: 2,
      failed: 2,
      unclassified: 1,
    });
    expect(RUN_OUTCOMES_QUERY).toContain("SELECT 'run_outcome'");
    expect(RUN_OUTCOMES_QUERY).not.toContain("SELECT 'failure'");
    expect(RUN_OUTCOMES_QUERY).not.toContain("SELECT 'refusal'");
  });

  it('never turns malformed or unavailable aggregate rows into a complete zero', () => {
    expect(readTrafficBreakdowns([]).outcomesCoverage.state).toBe('unavailable');
    const partial = readTrafficBreakdowns(
      [
        { kind: 'population', key: '', count: 32 },
        { kind: 'outcome_covered', key: '', count: 32 },
        { kind: 'tool_covered', key: '', count: 32 },
        { kind: 'tool', key: 'search_semantics', count: 'not-a-count' },
      ],
      { state: 'partial', reason: 'durable stages unavailable' }
    );
    expect(partial.toolCalls).toEqual([]);
    expect(partial.toolCallsCoverage).toMatchObject({ state: 'partial', coveredRuns: 32 });
  });

  it('keeps genuine retries and unknown external tools while reporting partial run coverage', () => {
    const read = readTrafficBreakdowns([
      { kind: 'population', key: '', count: 5 },
      { kind: 'outcome_covered', key: '', count: 4 },
      { kind: 'tool_covered', key: '', count: 3 },
      { kind: 'failure', key: 'SQL_UNRESOLVED_COLUMN', count: 1 },
      { kind: 'failure', key: 'UNKNOWN_STORED_ANSWER_FAILURE', count: 1 },
      { kind: 'tool', key: 'run_sql', count: 2 },
      { kind: 'tool', key: 'unknown_tool', count: 1 },
    ]);
    expect(read.toolCalls).toEqual([
      { key: 'run_sql', label: 'run_sql', count: 2 },
      { key: 'unknown_tool', label: 'Unknown tool', count: 1 },
    ]);
    expect(read.failuresByCause.map((item) => item.label)).toEqual([
      'SQL referenced a missing column',
      'Legacy failure · cause unavailable',
    ]);
    expect(read.outcomesCoverage).toEqual({
      state: 'partial',
      coveredRuns: 4,
      reason: '4 of 5 recorded runs have specific outcome evidence.',
    });
    expect(read.toolCallsCoverage).toEqual({
      state: 'partial',
      coveredRuns: 3,
      reason: '3 of 5 recorded runs have named stage evidence.',
    });
  });

  it('reports complete zero tool calls only with complete explicit coverage', () => {
    const read = readTrafficBreakdowns([
      { kind: 'population', key: '', count: 2 },
      { kind: 'outcome_covered', key: '', count: 2 },
      { kind: 'tool_covered', key: '', count: 2 },
    ]);
    expect(read.toolCalls).toEqual([]);
    expect(read.toolCallsCoverage).toEqual({ state: 'complete', coveredRuns: 2, reason: '' });
  });

  it('combines only canonical refusal codes into the compact refusal taxonomy', () => {
    const read = readTrafficBreakdowns([
      { kind: 'population', key: '', count: 8 },
      { kind: 'outcome_covered', key: '', count: 8 },
      { kind: 'tool_covered', key: '', count: 8 },
      { kind: 'refusal', key: 'IDENTITY_REQUIRED', count: 1 },
      { kind: 'refusal', key: 'USER_NOT_AUTHORIZED', count: 2 },
      { kind: 'refusal', key: 'COLUMN_POLICY_VIOLATION', count: 1 },
      { kind: 'refusal', key: 'IDEMPOTENCY_KEY_MALFORMED', count: 1 },
      { kind: 'refusal', key: 'NO_VALID_EVIDENCE', count: 1 },
      { kind: 'refusal', key: 'BUDGET_APPROVAL_REQUIRED', count: 1 },
      { kind: 'refusal', key: 'RELEASE_NOT_CERTIFIED', count: 1 },
    ]);
    expect(read.refusalsByCause).toEqual([
      { key: 'REFUSAL_PERMISSION_ACCESS_SCOPE', label: 'Permission, access or scope', count: 3 },
      { key: 'REFUSAL_BUDGET_GUARD', label: 'Budget guard', count: 1 },
      { key: 'REFUSAL_MISSING_INPUT', label: 'Missing input or clarification', count: 1 },
      { key: 'REFUSAL_POLICY_SAFETY', label: 'Policy or safety', count: 1 },
      { key: 'REFUSAL_UNSUPPORTED_REQUEST', label: 'Unsupported request', count: 1 },
      { key: 'REFUSAL_UPSTREAM_RESOURCE', label: 'Upstream or resource refusal', count: 1 },
    ]);
  });
});
