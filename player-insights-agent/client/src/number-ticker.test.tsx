import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { NumberTicker, stepTickerValue, tickerNumber } from './NumberTicker';

describe('shared NumberTicker', () => {
  it('preserves empty and invalid text without coercing either to zero', () => {
    expect(tickerNumber('')).toEqual({ empty: true, valid: true, value: null });
    expect(tickerNumber('12.')).toEqual({ empty: false, valid: true, value: 12 });
    expect(tickerNumber('12..3').valid).toBe(false);
    expect(tickerNumber('-1').valid).toBe(false);
  });

  it('steps decimals exactly with field precision and a zero floor', () => {
    expect(stepTickerValue('0.2', 1, { step: 0.1, precision: 1 })).toBe('0.3');
    expect(stepTickerValue('0.3', -1, { step: 0.1, precision: 1 })).toBe('0.2');
    expect(stepTickerValue('0', -1, { step: 0.01, precision: 2 })).toBe('0');
    expect(stepTickerValue('', 1, { step: 0.01, precision: 2 })).toBe('0.01');
    expect(stepTickerValue('1234567.89', 1, { step: 0.01, precision: 2 })).toBe('1234567.9');
  });

  it('renders visible accessible arrows and non-colliding USD and DBU affixes', () => {
    const usd = renderToStaticMarkup(
      <NumberTicker
        id="usd"
        label="App budget in USD"
        value="1234567.89"
        prefix="$"
        step={0.01}
        wide
        onChange={() => {}}
      />
    );
    const dbu = renderToStaticMarkup(
      <NumberTicker id="dbu" label="App budget in DBU" value="" suffix="DBU" step={0.01} wide onChange={() => {}} />
    );
    expect(usd).toContain('ops-number-ticker-prefix');
    expect(usd).toContain('Increase app budget in usd');
    expect(usd).toContain('Decrease app budget in usd');
    expect(dbu).toContain('ops-number-ticker-suffix');
    expect(dbu).not.toContain('ops-number-ticker-prefix');
    expect(dbu).toContain('value=""');
  });

  it('handles ArrowUp and ArrowDown through the same artifact-free step path', () => {
    const source = readFileSync(new URL('./NumberTicker.tsx', import.meta.url), 'utf8');
    expect(source).toContain("event.key !== 'ArrowUp' && event.key !== 'ArrowDown'");
    expect(source).toContain('changeBy(event.key');
    expect(source).toContain('stepTickerValue(value, direction');
  });

  it('is the one assumption field and grid implementation used by Forecasting and Cost', () => {
    const forecast = readFileSync(new URL('./ForecastingPanel.tsx', import.meta.url), 'utf8');
    const budgets = readFileSync(new URL('./CostBudgets.tsx', import.meta.url), 'utf8');
    for (const source of [forecast, budgets]) {
      expect(source).toContain('TickerAssumptionGrid');
      expect(source).toContain('TickerAssumptionField');
      expect(source).toContain('NumberTicker');
    }
    expect(forecast).not.toContain('ops-forecast-assumption-grid');
    expect(budgets).not.toContain('ops-budget-field');
  });
});
