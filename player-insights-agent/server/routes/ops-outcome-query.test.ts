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

  it('keeps refusals distinct and classifies missing terminal causes honestly', () => {
    expect(RUN_OUTCOMES_QUERY).toContain("r.state IN ('FAILED', 'DEADLINE_EXCEEDED', 'PERSISTENCE_FAILED')");
    expect(RUN_OUTCOMES_QUERY).toContain('UNKNOWN_FAILURE_CAUSE');
    expect(RUN_OUTCOMES_QUERY).toContain('UNKNOWN_REFUSAL_CAUSE');
    expect(RUN_OUTCOMES_QUERY).toContain('UNKNOWN_STORED_ANSWER_FAILURE');
    expect(RUN_OUTCOMES_QUERY).toContain("WHEN a.answer_status = 'failed' THEN 'FAILED'");
  });

  it('prefers durable stage evidence when the stored answer repeats the same tool call', () => {
    expect(RUN_OUTCOMES_QUERY).toContain('source_priority DESC');
  });

  it('parses the production-shaped 32-run aggregate without losing names or counts', () => {
    const read = readTrafficBreakdowns([
      { kind: 'population', key: '', count: '32' },
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
    expect(read.refusalsByCause[0]).toMatchObject({ key: 'USER_NOT_AUTHORIZED', count: 3 });
    expect(read.toolCalls.map((row) => [row.label, row.count])).toEqual([
      ['Ran a governed read-only query', 19],
      ['Called search_semantics', 7],
    ]);
    expect(read.outcomesCoverage.state).toBe('complete');
  });

  it('never turns malformed or unavailable aggregate rows into a complete zero', () => {
    expect(readTrafficBreakdowns([]).outcomesCoverage.state).toBe('unavailable');
    const partial = readTrafficBreakdowns(
      [
        { kind: 'population', key: '', count: 32 },
        { kind: 'tool', key: 'search_semantics', count: 'not-a-count' },
      ],
      { state: 'partial', reason: 'durable stages unavailable' }
    );
    expect(partial.toolCalls).toEqual([]);
    expect(partial.toolCallsCoverage).toMatchObject({ state: 'partial', coveredRuns: 32 });
  });
});
