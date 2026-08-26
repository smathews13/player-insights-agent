import { describe, expect, it } from 'vitest';
import { importReasonsFromTrace, matchesImportFilters } from './eval-import';

describe('evaluation set import filters', () => {
  it('names only the signals the turn actually carried', () => {
    expect(importReasonsFromTrace({ question: 'How many?' })).toEqual([]);
    expect(
      importReasonsFromTrace({
        question: 'How many?',
        durationMs: 51_000,
        outcome: 'failed',
        rating: 'down',
        judges: [{ value: 'no' }],
      })
    ).toEqual(['low_judge_score', 'tool_failure', 'latency', 'customer_feedback']);
  });

  it('does not treat a missing duration as latency', () => {
    expect(importReasonsFromTrace({ question: 'How many?', durationMs: 12_000 })).toEqual([]);
  });

  it('keeps a turn when any selected filter matches', () => {
    expect(matchesImportFilters(['latency'], ['latency', 'customer_feedback'])).toBe(true);
    expect(matchesImportFilters(['latency'], ['customer_feedback'])).toBe(false);
    expect(matchesImportFilters(['latency'], [])).toBe(true);
    expect(matchesImportFilters([], [])).toBe(false);
  });
});
