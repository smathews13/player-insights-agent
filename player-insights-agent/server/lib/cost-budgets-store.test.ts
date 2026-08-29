import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { APP_SCHEMA } from '../../shared/app-schema';
import { EMPTY_COST_BUDGETS } from '../../shared/cost-budgets';
import { COST_BUDGETS_TABLE, forgetCostBudgets, readCostBudgets, writeCostBudgets } from './cost-budgets-store';

function client(rows: Record<string, unknown>[] = [], fail?: Error) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  return {
    calls,
    lakebase: {
      query: (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (fail) return Promise.reject(fail);
        return Promise.resolve({ rows });
      },
    },
  };
}

describe('cost budget persistence', () => {
  it('qualifies the table with APP_SCHEMA so a non-default schema still hits migrations', () => {
    expect(COST_BUDGETS_TABLE).toBe(`${APP_SCHEMA}.cost_budgets`);
    const source = fs.readFileSync(path.join(__dirname, 'cost-budgets-store.ts'), 'utf8');
    expect(source).toContain("appTable('cost_budgets')");
    expect(source).not.toContain("'player_insights.cost_budgets'");
  });

  it('uses unset budgets when no row exists', async () => {
    forgetCostBudgets();
    expect(await readCostBudgets(client() as never, { maxAgeMs: 0 })).toEqual({
      budgets: EMPTY_COST_BUDGETS,
      readable: true,
    });
  });

  it('prefers a stored valid row and writes JSON atomically', async () => {
    forgetCostBudgets();
    const legacy = { total: 250, resources: { 'app-compute': 40, 'serving-endpoint': 80 } };
    const stored = {
      total: { value: 250, unit: 'USD' as const },
      resources: {
        'app-compute': { value: 40, unit: 'USD' as const },
        'serving-endpoint': { value: 80, unit: 'USD' as const },
      },
    };
    expect((await readCostBudgets(client([{ settings: legacy }]) as never, { maxAgeMs: 0 })).budgets).toEqual(stored);

    const writer = client();
    await writeCostBudgets(writer as never, stored, 'admin@example.com');
    expect(writer.calls[0]?.sql).toContain(COST_BUDGETS_TABLE);
    expect(writer.calls[0]?.values).toEqual(['effective', JSON.stringify(stored), 'admin@example.com']);
  });

  it('does not invent figures when the store cannot be read', async () => {
    forgetCostBudgets();
    const result = await readCostBudgets(client([], new Error('permission denied')) as never, { maxAgeMs: 0 });
    expect(result).toEqual({ budgets: EMPTY_COST_BUDGETS, readable: false });
    expect(result.budgets.total).toEqual({ value: null, unit: 'USD' });
    expect(result.budgets.resources).toEqual({});
  });

  it('does not apply a corrupt stored row as a budget', async () => {
    forgetCostBudgets();
    const result = await readCostBudgets(client([{ settings: { total: -12, resources: {} } }]) as never, {
      maxAgeMs: 0,
    });
    expect(result.readable).toBe(false);
    expect(result.budgets).toEqual(EMPTY_COST_BUDGETS);
  });
});
