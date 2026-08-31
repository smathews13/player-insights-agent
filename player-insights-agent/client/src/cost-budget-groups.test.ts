import { describe, expect, it } from 'vitest';

import { mergeBudgetGroup, resourceBudgetsDirty, sameCostBudget } from './CostBudgets';

const saved = {
  total: { USD: 100, DBU: 20 },
  resources: {
    endpoint: { USD: 40, DBU: 8 },
    'app-compute': { USD: 10, DBU: 2 },
  },
};

describe('independent atomic Cost budget groups', () => {
  it('merges only the app budget and preserves fresh server resources', () => {
    const draft = { ...saved, total: { USD: 125, DBU: 20 }, resources: { endpoint: { USD: 999, DBU: 8 } } };
    expect(mergeBudgetGroup(saved, draft, 'total', ['endpoint'])).toEqual({
      ...saved,
      total: { USD: 125, DBU: 20 },
    });
  });

  it('merges all visible resource edits in one document and preserves the app budget', () => {
    const draft = {
      total: { USD: 999, DBU: 20 },
      resources: { endpoint: { USD: 45, DBU: 8 }, 'app-compute': { USD: null, DBU: 2 } },
    };
    expect(mergeBudgetGroup(saved, draft, 'resources', ['endpoint', 'app-compute'])).toEqual({
      total: saved.total,
      resources: draft.resources,
    });
  });

  it('treats clearing as a dirty value and keeps the app group independent', () => {
    const cleared = {
      ...saved,
      resources: { ...saved.resources, endpoint: { USD: null, DBU: 8 } },
    };
    expect(resourceBudgetsDirty(cleared, saved, ['endpoint'])).toBe(true);
    expect(sameCostBudget(cleared.total, saved.total)).toBe(true);
  });
});
