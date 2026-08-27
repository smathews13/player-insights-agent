import { describe, expect, it } from 'vitest';

import { COST_BUDGET_MAX } from '../../shared/cost-budgets';
import { budgetFieldText, moneyAmountFrom } from './cost-budget-amount';

describe('a Cost budget field', () => {
  it('treats an empty box as unset, not zero', () => {
    expect(moneyAmountFrom('', 40)).toBeNull();
    expect(moneyAmountFrom('   ', 40)).toBeNull();
    expect(budgetFieldText(null)).toBe('');
  });

  it('keeps a typed zero as a real zero budget', () => {
    expect(moneyAmountFrom('0', null)).toBe(0);
    expect(moneyAmountFrom('0.00', 12)).toBe(0);
    expect(budgetFieldText(0)).toBe('0');
  });

  it('holds a decimal without snapping back while the dot is being typed', () => {
    expect(moneyAmountFrom('12.', 12)).toBe(12);
    expect(moneyAmountFrom('12.5', 12)).toBe(12.5);
    expect(moneyAmountFrom('.', 12)).toBe(12);
  });

  it('ignores letters and refuses a negative amount', () => {
    expect(moneyAmountFrom('abc', 8)).toBe(8);
    expect(moneyAmountFrom('-5', 8)).toBe(5);
    expect(moneyAmountFrom('1e5', 8)).toBe(15);
  });

  it('caps a huge typo at the schema ceiling', () => {
    expect(moneyAmountFrom(String(COST_BUDGET_MAX + 99), null)).toBe(COST_BUDGET_MAX);
  });
});
