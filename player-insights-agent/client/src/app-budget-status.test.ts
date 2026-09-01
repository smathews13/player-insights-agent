import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { appBudgetPeriod, emptyAppBudgetStatus } from '../../shared/app-budget-contract';
import { decodeAppBudgetStatus } from './app-budget-status';

const completeStatus = emptyAppBudgetStatus(
  appBudgetPeriod(Date.parse('2026-09-15T12:00:00Z')),
  '2026-09-15T12:00:00Z',
  {
    level: 'approval-required',
    measured: 100,
    budget: 100,
    unit: 'USD',
    ratio: 1,
    percent: 100,
    coverage: 'complete',
    budgetFingerprint: 'a'.repeat(64),
    code: 'BUDGET_APPROVAL_REQUIRED',
    detail: 'An administrator must approve continued usage.',
  }
);

describe('app budget status client decoder', () => {
  it('accepts the complete server status without recalculating it', () => {
    expect(decodeAppBudgetStatus(completeStatus)).toEqual(completeStatus);
  });

  it('fails open at the caller when required fields or numeric safety are invalid', () => {
    expect(decodeAppBudgetStatus({ ...completeStatus, level: 'blocked-forever' })).toBeNull();
    expect(decodeAppBudgetStatus({ ...completeStatus, measured: Number.NaN })).toBeNull();
    expect(decodeAppBudgetStatus({ ...completeStatus, approval: { approved: true } })).toBeNull();
  });

  it('keeps the eager Ask status module free of Zod and schema-bearing budget modules', () => {
    const source = readFileSync(new URL('./app-budget-status.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"]zod['"]/);
    expect(source).not.toMatch(/from ['"][^'"]*app-budget-guard['"]/);
    expect(source).not.toMatch(/from ['"][^'"]*cost-budgets['"]/);
    expect(source).toContain("from '../../shared/app-budget-contract'");
  });
});
