import type { CostBudgetUnit } from '../../shared/cost-budgets';
import { browserPreferenceStore, type PreferenceStore } from './experimental-features';

export const COST_DISPLAY_UNIT_KEY = 'pia.ops.cost-display-unit';
export const DEFAULT_COST_DISPLAY_UNIT: CostBudgetUnit = 'USD';

export function readCostDisplayUnit(store: PreferenceStore | null = browserPreferenceStore()): CostBudgetUnit {
  const saved = store?.getItem(COST_DISPLAY_UNIT_KEY);
  return saved === 'DBU' || saved === 'USD' ? saved : DEFAULT_COST_DISPLAY_UNIT;
}

export function persistCostDisplayUnit(
  unit: CostBudgetUnit,
  store: PreferenceStore | null = browserPreferenceStore()
): boolean {
  if (!store) return false;
  try {
    store.setItem(COST_DISPLAY_UNIT_KEY, unit);
    return true;
  } catch {
    return false;
  }
}

export function adjacentCostDisplayUnit(
  unit: CostBudgetUnit,
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'
): CostBudgetUnit {
  if (key === 'Home' || key === 'ArrowLeft' || key === 'ArrowUp') return 'USD';
  if (key === 'End' || key === 'ArrowRight' || key === 'ArrowDown') return 'DBU';
  return unit;
}
