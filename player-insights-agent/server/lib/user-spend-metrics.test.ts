import { describe, expect, it } from 'vitest';
import { buildUserSpendMetrics } from './user-spend-metrics';

describe('user spend metrics', () => {
  it('derives selected-unit aggregates from comparable server totals', () => {
    const metrics = buildUserSpendMetrics({
      unit: 'USD',
      current: {
        amount: 120,
        comparable: true,
        questions: 24,
        coveredDays: 6,
        appTotal: 600,
        appComparable: true,
        totalTokens: 253_800,
        tokenCoveredRuns: 3,
        tokenCoveredQuestions: 2,
      },
    });
    expect(metrics.costPerQuestion.value).toBe(5);
    expect(metrics.averageDaily.value).toBe(20);
    expect(metrics.averageDaily.subtitle).toBe('');
    expect(metrics.appShare.value).toBe(20);
    expect(metrics.averageTokens).toEqual({
      totalTokens: 253_800,
      coveredRuns: 3,
      coveredQuestions: 2,
      perRun: 84_600,
      perQuestion: 126_900,
    });
    expect(Object.keys(metrics)).toEqual([
      'unit',
      'questions',
      'coveredDays',
      'costPerQuestion',
      'averageDaily',
      'averageTokens',
      'appShare',
    ]);
  });

  it('does not invent ratios from zero, missing, or incomparable values', () => {
    const metrics = buildUserSpendMetrics({
      unit: 'DBU',
      current: {
        amount: 10,
        comparable: true,
        questions: 0,
        coveredDays: 0,
        appTotal: null,
        appComparable: false,
        totalTokens: 0,
        tokenCoveredRuns: 1,
        tokenCoveredQuestions: 1,
      },
    });
    expect(metrics.costPerQuestion.state).toBe('unavailable');
    expect(metrics.averageDaily.state).toBe('unavailable');
    expect(metrics.averageDaily.subtitle).toBe('Average not available yet');
    expect(metrics.appShare.state).toBe('unavailable');
    expect(metrics.averageTokens?.perRun).toBe(0);
  });
});
