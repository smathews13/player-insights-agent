/**
 * Reading a money amount out of a text field, the same way Runtime reads a
 * whole number: never through `Number('')`, which is 0.
 *
 * An empty box is unset (null), which is not a request for a zero budget. A
 * box holding `0` is a real zero. Garbage mid-keystroke keeps the last
 * committed value so typing `12.` does not clear the budget.
 */
import { COST_BUDGET_MAX } from '../../shared/cost-budgets';

export function moneyAmountFrom(raw: string, fallback: number | null): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const cleaned = trimmed.replace(/[^0-9.]/g, '');
  if (cleaned === '' || cleaned === '.') return fallback;
  const firstDot = cleaned.indexOf('.');
  const normalised =
    firstDot === -1 ? cleaned : `${cleaned.slice(0, firstDot + 1)}${cleaned.slice(firstDot + 1).replace(/\./g, '')}`;
  const parsed = Number.parseFloat(normalised);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(COST_BUDGET_MAX, parsed);
}

export function budgetFieldText(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return '';
  return String(amount);
}
