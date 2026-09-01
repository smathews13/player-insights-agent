import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { appBudgetPeriod, emptyAppBudgetStatus, type AppBudgetStatus } from '../../shared/app-budget-guard';
import { BudgetGuardStatus } from './CostBudgets';

const period = appBudgetPeriod(Date.parse('2026-09-15T12:00:00Z'));

function status(level: AppBudgetStatus['level']): AppBudgetStatus {
  return emptyAppBudgetStatus(period, '2026-09-15T12:00:00Z', {
    level,
    measured: 100,
    budget: 100,
    unit: 'USD',
    ratio: 1,
    percent: 100,
    coverage: level === 'unavailable/partial' ? 'partial' : 'complete',
    budgetFingerprint: 'a'.repeat(64),
    code: level === 'approval-required' ? 'BUDGET_APPROVAL_REQUIRED' : 'APP_BUDGET_TEST',
    detail: level === 'unavailable/partial' ? 'Budget status unavailable/partial. New questions remain available.' : '',
    approval:
      level === 'approved-overage'
        ? {
            approved: true,
            approvedAt: '2026-09-15T12:01:00Z',
            approvedBy: 'An administrator',
            through: '2026-09-30',
            revokedAt: '',
          }
        : null,
  });
}

describe('app budget guard UI', () => {
  it('renders the required Cost status labels and progress', () => {
    expect(renderToStaticMarkup(<BudgetGuardStatus status={status('warning')} admin={false} />)).toContain(
      '80% warning'
    );
    const required = renderToStaticMarkup(<BudgetGuardStatus status={status('approval-required')} admin={false} />);
    expect(required).toContain('Approval required');
    expect(required).toContain('100.00%');
    expect(required).not.toContain('Approve continued usage');
    expect(renderToStaticMarkup(<BudgetGuardStatus status={status('unavailable/partial')} admin={false} />)).toContain(
      'Budget status unavailable/partial'
    );
  });

  it('offers approval only to admins and identifies bounded approved usage safely', () => {
    const admin = renderToStaticMarkup(<BudgetGuardStatus status={status('approval-required')} admin />);
    expect(admin).toContain('Approve continued usage');
    const approved = renderToStaticMarkup(<BudgetGuardStatus status={status('approved-overage')} admin={false} />);
    expect(approved).toContain('Over budget · Admin approved');
    expect(approved).toContain('An administrator approved continued usage through 2026-09-30');
    expect(approved).not.toContain('@');
  });

  it('preserves the composer draft and optimistic conversation on a raced server rejection', () => {
    const source = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
    expect(source).toContain("askError.result.code === 'BUDGET_APPROVAL_REQUIRED'");
    expect(source).toContain('setDraft(question)');
    expect(source).toContain('items.filter((item) => item.id !== userMessage.id)');
    expect(source).toContain('forgetActiveConversationRun(runs, runConversationId)');
    expect(source).toContain("const budgetBlocked = budgetStatus?.level === 'approval-required'");
    expect(source).toContain('An administrator must approve continued usage.');
  });

  it('states the guardrail methodology without calling it a hard ceiling', () => {
    const source = readFileSync(new URL('./OpsPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('Budget controls are guardrails, not hard billing ceilings.');
    expect(source).toContain('warns at 80% of the monthly app budget');
    expect(source).toContain('requires an administrator to approve new questions');
    expect(source).toContain('Billing data can lag, concurrent or in-flight requests may exceed the threshold');
    expect(source).toContain('resource budgets remain advisory');
  });

  it('keeps the app guard separate from AI Gateway enforcement metadata', () => {
    const source = readFileSync(new URL('../../shared/ai-gateway-contract.ts', import.meta.url), 'utf8');
    expect(source).toContain("source: z.literal('gateway-block-usage-budget')");
    expect(source).toContain("source: z.literal('advisory-resource-budget')");
    expect(source).not.toContain("source: z.literal('app-budget-guard')");
  });
});
