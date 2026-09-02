import { describe, expect, it } from 'vitest';
import { deriveCoreUserSpendMetrics } from './user-spend-metrics';

describe('core user spend metrics', () => {
  it('computes the production screenshot ratios without a comparability gate', () => {
    const metrics = deriveCoreUserSpendMetrics({ amount: 9.55, questions: 25, coveredDays: 7, unit: 'USD' });
    expect(metrics.costPerQuestion).toMatchObject({ state: 'value', value: 0.382 });
    expect(metrics.averageDaily.state).toBe('value');
    expect(metrics.averageDaily.value).toBeCloseTo(1.364285714, 8);
  });

  it('uses the same arithmetic for DBU and refuses zero denominators', () => {
    const dbu = deriveCoreUserSpendMetrics({ amount: 3.75, questions: 3, coveredDays: 2, unit: 'DBU' });
    expect(dbu.costPerQuestion.value).toBe(1.25);
    expect(dbu.averageDaily.value).toBe(1.875);
    const zero = deriveCoreUserSpendMetrics({ amount: 3.75, questions: 0, coveredDays: 0, unit: 'USD' });
    expect(zero.costPerQuestion.state).toBe('unavailable');
    expect(zero.averageDaily.state).toBe('unavailable');
  });

  it('does not derive ratios without an attributable total', () => {
    const metrics = deriveCoreUserSpendMetrics({ amount: null, questions: 25, coveredDays: 7, unit: 'USD' });
    expect(metrics.costPerQuestion.state).toBe('unavailable');
    expect(metrics.averageDaily.state).toBe('unavailable');
  });
});
