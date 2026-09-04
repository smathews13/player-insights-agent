import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { COST_BUDGETS_UNREADABLE, loadCostBudgets, saveCostBudgets } from './cost-budgets-api';
import {
  BudgetSaveNotice,
  COST_BUDGET_SAVED_MS,
  CostBudgetApplyButton,
  budgetAuditView,
  costBudgetNotice,
  scheduleCostBudgetSaveReset,
} from './CostBudgets';
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
    const audit = { appliedAt: '2026-09-02T16:51:00.000Z', appliedBy: '<your-username>@example.com' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ budgets, audit, readable: true })));
    await expect(loadCostBudgets()).resolves.toEqual({
      ok: true,
      budgets: {
        total: { USD: 90, DBU: null },
        resources: { 'app-compute': { USD: 12, DBU: null } },
      },
      audit,
    });
    vi.unstubAllGlobals();
  });

  it('turns an unreadable store into a failed load so Save can retry it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ budgets: { total: null, resources: {} }, readable: false }))
    );
    const result = await loadCostBudgets();
    expect(result.ok).toBe(false);
    expect(result.budgets).toBeNull();
    expect(saveRetryAfterLoad(result)).toEqual({ kind: 'failed', message: COST_BUDGETS_UNREADABLE });
    vi.unstubAllGlobals();
  });

  it('surfaces the server detail on a failed save', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          json(
            { error: 'cost_budgets_store_unavailable', detail: 'The budgets were not saved: permission denied' },
            503
          )
        )
    );
    await expect(saveCostBudgets({ total: { value: 10, unit: 'DBU' }, resources: {} })).rejects.toThrow(
      'The budgets were not saved: permission denied'
    );
    vi.unstubAllGlobals();
  });

  it('persists and reloads the selected unit without conversion', async () => {
    const budgets = {
      total: { USD: 90, DBU: 42 },
      resources: { 'app-compute': { USD: 9, DBU: 6 } },
    };
    const audit = { appliedAt: '2026-09-02T16:51:00.000Z', appliedBy: '<your-username>@example.com' };
    const fetch = vi.fn().mockResolvedValue(json({ budgets, audit, readable: true }));
    vi.stubGlobal('fetch', fetch);
    await expect(saveCostBudgets(budgets)).resolves.toEqual({ budgets, audit });
    const request = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const requestBody = request[1].body;
    expect(typeof requestBody).toBe('string');
    if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body.');
    expect(JSON.parse(requestBody)).toEqual(budgets);
    vi.unstubAllGlobals();
  });
});

describe('Cost budget Apply copy', () => {
  it('renders persisted apply metadata without exposing the full actor in visible text', () => {
    expect(
      budgetAuditView(
        { appliedAt: '2026-09-02T16:51:00.000Z', appliedBy: '<your-username>@example.com' },
        () => 'Sep 2, 10:51 AM'
      )
    ).toEqual({
      text: 'Last applied Sep 2, 10:51 AM by <your-username>',
      title: '<your-username>@example.com',
    });
    expect(budgetAuditView({ appliedAt: '', appliedBy: '' }, () => 'never')).toEqual({
      text: 'Last applied time and user unavailable',
      title: '',
    });
  });

  it('keeps save-success copy in the button only', () => {
    expect(costBudgetNotice(SETTINGS_SAVE_IDLE)).toBeNull();
    expect(costBudgetNotice({ kind: 'saved' })).toBeNull();
    expect(costBudgetNotice({ kind: 'failed', message: 'The endpoint answered 503.' })).toEqual({
      tone: 'error',
      text: 'The endpoint answered 503.',
    });
  });

  it('shows truthful per-button states and the Astrolabe flicker only while applying', () => {
    const markup = (state: Parameters<typeof CostBudgetApplyButton>[0]['state']) =>
      renderToStaticMarkup(createElement(CostBudgetApplyButton, { state }));
    expect(markup(SETTINGS_SAVE_IDLE)).toContain('>Apply</button>');
    expect(markup({ kind: 'saving' })).toContain('Applying');
    expect(markup({ kind: 'saving' })).toContain('pia-flick-slot--button');
    expect(markup({ kind: 'saving' })).toContain('disabled');
    const saved = markup({ kind: 'saved' });
    expect(saved.match(/Applied/g)).toHaveLength(1);
    expect(saved).toContain('aria-live="polite"');
    expect(saved).toContain('aria-atomic="true"');
    expect(markup({ kind: 'failed', message: 'no' })).toContain('Retry');
    expect(markup({ kind: 'failed', message: 'no' })).not.toContain('pia-flick-slot--button');
  });

  it('renders failures without a duplicate saved status', () => {
    const status = (state: Parameters<typeof BudgetSaveNotice>[0]['state']) =>
      renderToStaticMarkup(
        createElement(BudgetSaveNotice, {
          state,
          notice: costBudgetNotice(state),
          readable: true,
        })
      );
    expect(status({ kind: 'saved' })).toBe('');
    expect(status({ kind: 'failed', message: 'Atomic save failed.' })).toContain('ops-budget-save-error');
    expect(status({ kind: 'failed', message: 'Atomic save failed.' })).toContain('Atomic save failed.');
    expect(status({ kind: 'failed', message: 'Atomic save failed.' })).not.toContain('Observed:');
  });

  it('resets the latest successful save once after the visible confirmation delay', () => {
    vi.useFakeTimers();
    const timers = {};
    const first = vi.fn();
    const latest = vi.fn();
    scheduleCostBudgetSaveReset(timers, 'resources', first);
    scheduleCostBudgetSaveReset(timers, 'resources', latest);
    vi.advanceTimersByTime(COST_BUDGET_SAVED_MS);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

describe('Cost budget Apply-retry', () => {
  const source = readFileSync(new URL('CostBudgets.tsx', import.meta.url), 'utf8');

  it('uses the reload result after Save retries a failed load, not the stale failure', () => {
    expect(source).toContain('const current = await loadCostBudgets()');
    expect(source).toContain('saveRetryAfterLoad(current)');
    expect(source).not.toContain("state === 'failed'");
    expect(source).not.toContain('type="number"');
    expect(source).toContain('NumberTicker');
    expect(source).toContain('const current = await loadCostBudgets()');
    expect(source).toContain('mergeBudgetGroup(current.budgets, submitted, group, tileIds)');
  });
});
