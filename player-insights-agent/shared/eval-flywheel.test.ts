import { describe, expect, it } from 'vitest';
import { alignGuidelinesFromLabels, type EvalRow } from './eval-dataset';
import {
  classifyGenieMiss,
  compareSidesSummary,
  compareTileRates,
  deterministicChecks,
  historyLine,
  pickWinner,
  scoredAccuracy,
  sqlHasFqn,
} from './eval-flywheel';

const row = (overrides: Partial<EvalRow>): EvalRow => ({
  id: '1',
  question: 'How many players?',
  groundTruthSql: 'SELECT 1',
  expectedAnswer: 'Twelve',
  sqlCorrect: '',
  thumbs: '',
  ...overrides,
});

describe('warehouse and timeout misses', () => {
  it('does not treat a starting warehouse as Genie getting SQL wrong', () => {
    expect(classifyGenieMiss('warehouse is starting')).toBe('warehouse');
    expect(classifyGenieMiss('Genie finished with status CANCELLED.')).toBe('timeout');
    expect(classifyGenieMiss('Genie did not finish before the wait ran out.')).toBe('timeout');
  });

  it('keeps those misses out of the accuracy fraction', () => {
    const score = scoredAccuracy(9, 10, 2);
    expect(score.percent).toBe(90);
    expect(score.label).toContain('9/10 = 90%');
    expect(score.label).toContain('2 not scored');
  });
});

describe('baseline vs candidate', () => {
  it('picks the higher pass rate and says so in one line', () => {
    const baseline = { side: 'current', runId: 'a', passed: 6, total: 10, groundedness: 0.6, relevance: 0.6, guidelines: 0.6 };
    const candidate = { side: 'other-agent', runId: 'b', passed: 9, total: 10, groundedness: 0.9, relevance: 0.9, guidelines: 0.9 };
    expect(pickWinner(baseline, candidate)).toBe('candidate');
    expect(compareSidesSummary(baseline, candidate)).toContain('6/10');
    expect(compareSidesSummary(baseline, candidate)).toContain('9/10');
    expect(compareTileRates(baseline)).toBe('Groundedness 60% · Relevance 60% · Guidelines 60%');
    expect(compareTileRates({ ...candidate, guidelines: null })).toBe(
      'Groundedness 90% · Relevance 90% · Guidelines —'
    );
  });
});

describe('human label alignment', () => {
  it('adds labelled sentences to the guidelines instead of inventing a score', () => {
    const aligned = alignGuidelinesFromLabels('Be professional.', [
      row({ sqlCorrect: 'yes' }),
      row({ id: '2', thumbs: 'up' }),
    ]);
    expect(aligned).toContain('Be professional.');
    expect(aligned).toContain('Human labels:');
    expect(aligned).toContain('How many players?');
  });

  it('leaves the base text alone when nobody has labelled a row', () => {
    expect(alignGuidelinesFromLabels('Be professional.', [row({})])).toBe('Be professional.');
  });
});

describe('deterministic checks beside the judges', () => {
  it('notices a fully qualified table name without touching the SQL gate', () => {
    expect(sqlHasFqn('SELECT count(*) FROM cat.sch.players')).toBe(true);
    expect(sqlHasFqn('SELECT count(*) FROM players')).toBe(false);
  });

  it('flags a 50s run as over budget rather than as a wrong answer', () => {
    const checks = deterministicChecks({
      sql: 'SELECT 1 FROM cat.sch.players',
      note: '',
      durationMs: 51_000,
    });
    expect(checks.find((entry) => entry.id === 'fqn-present')?.passed).toBe(true);
    expect(checks.find((entry) => entry.id === 'latency-under-budget')?.passed).toBe(false);
  });
});

describe('history lines', () => {
  it('keeps last Tuesday readable next to a later miss', () => {
    expect(
      historyLine({
        at: '2026-08-19T12:00:00.000Z',
        spaceId: 'space-data',
        spaceLabel: 'Player data',
        passed: 9,
        scored: 10,
        excluded: 0,
        percent: 90,
        label: '9/10 = 90%',
        note: '',
      })
    ).toBe('2026-08-19: 9/10 = 90%');
  });
});
