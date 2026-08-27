import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { COST_BUDGETS_UNREADABLE, loadCostBudgets, saveCostBudgets } from './cost-budgets-api';
import { costBudgetNotice } from './CostBudgets';
import { SETTINGS_SAVE_IDLE, saveRetryAfterLoad } from './settings-save-state';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('cost budget API responses', () => {
  it('loads stored budgets when the store answered', async () => {
    const budgets = { total: 90, resources: { 'app-compute': 12 } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ budgets, readable: true })));
    await expect(loadCostBudgets()).resolves.toEqual({ ok: true, budgets });
    vi.unstubAllGlobals();
  });

  it('turns an unreadable store into a failed load so Save can retry it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ budgets: { total: null, resources: {} }, readable: false })));
    const result = await loadCostBudgets();
    expect(result.ok).toBe(false);
    expect(result.budgets).toBeNull();
    expect(saveRetryAfterLoad(result)).toEqual({ kind: 'failed', message: COST_BUDGETS_UNREADABLE });
    vi.unstubAllGlobals();
  });

  it('surfaces the server detail on a failed save', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({ error: 'cost_budgets_store_unavailable', detail: 'The budgets were not saved: permission denied' }, 503)
      )
    );
    await expect(saveCostBudgets({ total: 10, resources: {} })).rejects.toThrow(
      'The budgets were not saved: permission denied'
    );
    vi.unstubAllGlobals();
  });
});

describe('Cost budget Save copy', () => {
  it('confirms a save without claiming the next ask uses it', () => {
    expect(costBudgetNotice(SETTINGS_SAVE_IDLE)).toBeNull();
    expect(costBudgetNotice({ kind: 'saved' })).toEqual({ tone: 'ok', text: 'Saved.' });
    expect(costBudgetNotice({ kind: 'failed', message: 'The endpoint answered 503.' })).toEqual({
      tone: 'error',
      text: 'The endpoint answered 503.',
    });
  });
});

describe('Cost budget Save-retry', () => {
  const source = readFileSync(new URL('CostBudgets.tsx', import.meta.url), 'utf8');

  it('uses the reload result after Save retries a failed load, not the stale failure', () => {
    expect(source).toContain('const result = await loadCostBudgets()');
    expect(source).toContain('setSaveState(saveRetryAfterLoad(result))');
    expect(source).not.toContain("state === 'failed'");
    expect(source).not.toContain('type="number"');
    expect(source).toContain('inputMode="decimal"');
  });
});
