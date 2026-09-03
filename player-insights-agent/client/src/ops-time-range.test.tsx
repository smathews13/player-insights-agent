import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { opsCurrentMonthKey, opsCurrentMonthRange } from '../../shared/ops-contract';

describe('the retired Ops timeframe control', () => {
  it('is absent and legacy range parameters are canonicalized away', () => {
    const source = readFileSync(new URL('./OpsPage.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('TimeRangeControl');
    expect(source).not.toContain('rangeWindow(');
    expect(source).toContain("canonical.delete('range')");
    expect(source).toContain("canonical.delete('from')");
    expect(source).toContain("canonical.delete('to')");
  });

  it('starts on the first and rolls cache identity with the budget calendar month', () => {
    const september = Date.parse('2026-09-02T12:00:00Z');
    expect(opsCurrentMonthRange(september)).toEqual({ from: '2026-09-01', to: '2026-09-01' });
    expect(opsCurrentMonthKey(september)).toBe('current-month:2026-09');
    expect(opsCurrentMonthKey(Date.parse('2026-10-01T12:00:00Z'))).toBe('current-month:2026-10');
    expect(opsCurrentMonthRange(Date.parse('2028-03-01T12:00:00Z'))).toEqual({
      from: '2028-03-01',
      to: '2028-03-01',
    });
  });
});
