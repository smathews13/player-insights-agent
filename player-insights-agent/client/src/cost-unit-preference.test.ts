import { describe, expect, it } from 'vitest';
import type { PreferenceStore } from './experimental-features';
import {
  adjacentCostDisplayUnit,
  COST_DISPLAY_UNIT_KEY,
  persistCostDisplayUnit,
  readCostDisplayUnit,
} from './cost-unit-preference';

function memory(): PreferenceStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe('the shared Cost display unit', () => {
  it('defaults invalid legacy preferences to USD and persists only the display choice', () => {
    const store = memory();
    expect(readCostDisplayUnit(store)).toBe('USD');
    store.values.set(COST_DISPLAY_UNIT_KEY, '$DBU');
    expect(readCostDisplayUnit(store)).toBe('USD');
    expect(persistCostDisplayUnit('DBU', store)).toBe(true);
    expect(readCostDisplayUnit(store)).toBe('DBU');
  });

  it('supports the segmented radio keyboard pattern', () => {
    expect(adjacentCostDisplayUnit('USD', 'ArrowRight')).toBe('DBU');
    expect(adjacentCostDisplayUnit('DBU', 'ArrowLeft')).toBe('USD');
    expect(adjacentCostDisplayUnit('DBU', 'Home')).toBe('USD');
    expect(adjacentCostDisplayUnit('USD', 'End')).toBe('DBU');
  });
});
