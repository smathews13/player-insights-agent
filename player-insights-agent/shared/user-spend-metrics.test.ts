import { describe, expect, it } from 'vitest';
import { deriveCoreUserSpendMetrics, deriveUserTokenAverages } from './user-spend-metrics';

describe('core user spend metrics', () => {
  it('computes the production screenshot ratios without a comparability gate', () => {
    const metrics = deriveCoreUserSpendMetrics({ amount: 9.55, questions: 25, coveredDays: 7, unit: 'USD' });
    expect(metrics.costPerQuestion).toMatchObject({ state: 'value', value: 0.382 });
    expect(metrics.averageDaily.state).toBe('value');
    expect(metrics.averageDaily.value).toBeCloseTo(1.364285714, 8);
    expect(metrics.averageDaily.subtitle).toBe('');
  });

  it('uses the same arithmetic for DBU and refuses zero denominators', () => {
    const dbu = deriveCoreUserSpendMetrics({ amount: 3.75, questions: 3, coveredDays: 2, unit: 'DBU' });
    expect(dbu.costPerQuestion.value).toBe(1.25);
    expect(dbu.averageDaily.value).toBe(1.875);
    const zero = deriveCoreUserSpendMetrics({ amount: 3.75, questions: 0, coveredDays: 0, unit: 'USD' });
    expect(zero.costPerQuestion.state).toBe('unavailable');
    expect(zero.averageDaily.state).toBe('unavailable');
    expect(zero.averageDaily.subtitle).toBe('Average not available yet');
  });

  it('does not derive ratios without an attributable total', () => {
    const metrics = deriveCoreUserSpendMetrics({ amount: null, questions: 25, coveredDays: 7, unit: 'USD' });
    expect(metrics.costPerQuestion.state).toBe('unavailable');
    expect(metrics.averageDaily.state).toBe('unavailable');
    expect(JSON.stringify(metrics)).not.toMatch(/covered days?|days? covered|covered billing days?/i);
  });

  it('treats an uncovered zero token sum as unmeasured rather than measured zero', () => {
    expect(
      deriveUserTokenAverages({
        totalTokens: 0,
        coveredRuns: 0,
        coveredQuestions: 0,
      })
    ).toEqual({
      totalTokens: null,
      coveredRuns: 0,
      coveredQuestions: 0,
      perRun: null,
      perQuestion: null,
    });
    expect(
      deriveUserTokenAverages({
        totalTokens: 0,
        coveredRuns: 1,
        coveredQuestions: 1,
      }).totalTokens
    ).toBe(0);
  });
});
