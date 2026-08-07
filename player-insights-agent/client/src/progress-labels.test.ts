import { describe, expect, it } from 'vitest';
import { askElapsedLabel, slowestStageName } from './progress-labels';
import type { TraceStage } from './answer-shape';

function stage(id: string, name: string, duration: number): TraceStage {
  return {
    id,
    name,
    kind: 'agent',
    start: 0,
    duration,
    status: 'complete',
    calls: 0,
    input: '',
    output: '',
  };
}

/**
 * A real question took 27.5 seconds against a bar that filled in 2.6 and then sat
 * frozen and fully ticked for the remaining 23. These tests hold the replacement:
 * a wait that is counted rather than mimed.
 */
describe('askElapsedLabel', () => {
  it('counts the wait rather than miming it', () => {
    const start = 1_000_000;
    expect(askElapsedLabel(start, start + 5_000)).toBe('Working… 5s');
    expect(askElapsedLabel(start, start + 12_000)).toBe('Working… 12s');
  });

  it('keeps moving past the point the old bar froze at', () => {
    // The specific failure: 2.6 seconds in, the previous bar was full and static
    // for another 23 seconds. Every one of these must differ from the last.
    const start = 1_000_000;
    const labels = [3, 10, 20, 27].map((s) => askElapsedLabel(start, start + s * 1000));
    expect(new Set(labels).size).toBe(4);
    expect(labels.at(-1)).toContain('27s');
  });

  it('says outright that a long wait is not a hang', () => {
    const start = 1_000_000;
    expect(askElapsedLabel(start, start + 25_000)).toMatch(/still going/);
    expect(askElapsedLabel(start, start + 5_000)).not.toMatch(/still going/);
  });

  it('does not show a count before there is one worth showing', () => {
    const start = 1_000_000;
    expect(askElapsedLabel(start, start + 500)).toBe('Working…');
    expect(askElapsedLabel(null, start)).toBe('Working…');
  });

  it('never reports a negative wait if the clock moves backwards', () => {
    expect(askElapsedLabel(1_000_000, 999_000)).toBe('Working…');
  });
});

describe('slowestStageName', () => {
  it('names the longest stage from the run', () => {
    // Previously the word "Analysis" was hardcoded, so this metric described a
    // stage that need not exist and was wrong whenever another step dominated.
    const stages = [
      stage('s1', 'Chose the next step', 900),
      stage('s2', 'Called genie_query', 21_800),
      stage('s3', 'Prepared the findings', 4_400),
    ];
    expect(slowestStageName(stages)).toBe('Called genie_query');
  });

  it('is not the word Analysis unless a stage is called that', () => {
    expect(slowestStageName([stage('s1', 'Built the charts', 10)])).toBe('Built the charts');
  });

  it('reports nothing when there are no stages, rather than a default', () => {
    expect(slowestStageName([])).toBeNull();
  });

  it('picks a winner deterministically when durations tie', () => {
    const stages = [stage('a', 'First', 500), stage('b', 'Second', 500)];
    expect(slowestStageName(stages)).toBe('First');
  });
});
