import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { appBudgetPeriod, emptyAppBudgetStatus, type AppBudgetStatus } from '../../shared/app-budget-guard';
import { APP_BUDGET_GUARDRAILS } from '../../shared/app-budget-contract';
import { ComposerBudgetStatus } from './ComposerBudgetStatus';
import { AppBudgetMeasurement, BudgetGuardStatus, SavedAppBudgetSummary, monthlyBudgetProgress } from './CostBudgets';

const period = appBudgetPeriod(Date.parse('2026-09-15T12:00:00Z'));

function status(level: AppBudgetStatus['level'], overrides: Partial<AppBudgetStatus> = {}): AppBudgetStatus {
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
    detail: level === 'unavailable/partial' ? 'Coverage is incomplete.' : '',
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
    ...overrides,
  });
}

function composer(value: AppBudgetStatus | null, admin = false): string {
  return renderToStaticMarkup(
    <ComposerBudgetStatus status={value} admin={admin} busy={false} error="" onApprove={() => {}} />
  );
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
    expect(renderToStaticMarkup(<BudgetGuardStatus status={status('unavailable/partial')} admin={false} />)).toBe('');
  });

  it('offers approval only to admins and identifies bounded approved usage safely', () => {
    const admin = renderToStaticMarkup(<BudgetGuardStatus status={status('approval-required')} admin />);
    expect(admin).toContain('Approve continued usage');
    const approved = renderToStaticMarkup(<BudgetGuardStatus status={status('approved-overage')} admin={false} />);
    expect(approved).toContain('Admin approved');
    expect(approved).toContain('An administrator approved continued usage through 2026-09-30');
    expect(approved).not.toContain('@');
    expect(approved).not.toContain('UTC');
  });

  it('keeps non-actionable initial, refresh, navigation, and failed-read states out of the composer', () => {
    const silent = [
      null,
      status('unset'),
      status('below'),
      status('approved-overage'),
      status('unavailable/partial', { coverage: 'partial', code: 'APP_BUDGET_COVERAGE_PARTIAL' }),
      status('unavailable/partial', { coverage: 'unavailable', code: 'APP_BUDGET_MEASUREMENT_FAILED' }),
      status('unavailable/partial', { coverage: 'unavailable', code: 'APP_BUDGET_STATUS_UNAVAILABLE' }),
    ];
    for (const value of silent) {
      const markup = composer(value);
      expect(markup).toBe('');
      expect(markup).not.toMatch(/aria-live|role="(?:alert|status)"|composer-budget-status/);
    }
  });

  it('announces only actionable threshold changes and restores Ask after approval', () => {
    const warning = composer(status('warning', { measured: 80, ratio: 0.8, percent: 80 }));
    expect(warning).toContain('Monthly app budget is 80.00% used.');
    expect(warning).toContain('role="status"');
    expect(warning).not.toContain('New questions remain available');

    const blocked = composer(status('approval-required'), true);
    expect(blocked).toContain('role="alert"');
    expect(blocked).toContain('Approve continued usage');
    expect(composer(status('approved-overage'), true)).toBe('');
  });

  it('never turns a projected or partial Cost amount into an enforcement conclusion', () => {
    const partial = status('unavailable/partial', {
      measured: 923.27,
      budget: 800,
      ratio: null,
      percent: null,
      coverage: 'partial',
    });
    const partialMarkup = renderToStaticMarkup(<AppBudgetMeasurement status={partial} />);
    expect(partialMarkup).toBe('');
    expect(partialMarkup).not.toMatch(/923\.27|Over budget|Budget status/i);

    const complete = status('approval-required', {
      measured: 923.27,
      budget: 800,
      ratio: 923.27 / 800,
      percent: 115.40875,
    });
    const completeMarkup = renderToStaticMarkup(<AppBudgetMeasurement status={complete} />);
    expect(completeMarkup).toContain('Month to date');
    expect(completeMarkup).toContain('923.27 USD');
    expect(completeMarkup).toContain('800.00 USD');
    expect(renderToStaticMarkup(<BudgetGuardStatus status={complete} admin={false} />)).toContain('Approval required');
  });

  it('shows remaining or overage from complete actual MTD, never the selected-period total', () => {
    const partial = renderToStaticMarkup(
      <SavedAppBudgetSummary savedBudget={800} unit="USD" status={status('unavailable/partial')} />
    );
    expect(partial).toContain('Monthly app budget');
    expect(partial).toContain('800.00 USD');
    expect(partial).not.toMatch(/remaining|over budget|projected|Budget exhausted|aria-live/i);

    const complete = renderToStaticMarkup(
      <SavedAppBudgetSummary
        savedBudget={800}
        unit="USD"
        status={status('approval-required', { measured: 923.27, budget: 800, percent: 115.40875 })}
      />
    );
    expect(complete).toContain('123.27 USD over budget');
    expect(complete).toContain('Budget exhausted');
    expect(complete).toContain('data-budget-tone="danger"');
  });

  it.each([
    [79, 'normal'],
    [80, 'warning'],
    [100, 'danger'],
    [120, 'danger'],
  ] as const)('colors complete MTD spend %s by the shared guardrails', (measured, tone) => {
    expect(monthlyBudgetProgress(status('below', { measured, budget: 100 }), 100, 'USD')?.tone).toBe(tone);
  });

  it('projects exhaustion from complete MTD pace and fails open for incomplete coverage', () => {
    const crossing = monthlyBudgetProgress(
      status('below', {
        measured: 600,
        budget: 900,
        monthStart: '2026-09-01',
        measuredThrough: '2026-09-15',
        monthEnd: '2026-09-30',
      }),
      900,
      'USD'
    );
    expect(crossing?.pace).toBe('Budget exhausted in 8 days at current pace');
    expect(
      monthlyBudgetProgress(
        status('below', {
          measured: 100,
          budget: 900,
          monthStart: '2026-09-01',
          measuredThrough: '2026-09-15',
          monthEnd: '2026-09-30',
        }),
        900,
        'USD'
      )?.pace
    ).toBe('Not projected to exhaust this month');
    expect(monthlyBudgetProgress(status('unavailable/partial'), 100, 'USD')).toBeNull();
  });

  it('keeps selected-period spend and the active unit out of authoritative MTD pacing', () => {
    const selectedPeriodSpend = 135.49;
    const usd = monthlyBudgetProgress(status('below', { measured: 180, budget: 900 }), 900, 'USD');
    expect(selectedPeriodSpend).not.toBe(180);
    expect(usd?.balance).toBe('720.00 USD remaining');
    expect(monthlyBudgetProgress(status('below', { measured: 45, budget: 90, unit: 'DBU' }), 90, 'DBU')?.balance).toBe(
      '45.00 DBU remaining'
    );
    expect(monthlyBudgetProgress(status('below', { measured: 180, budget: 900 }), 90, 'DBU')).toBeNull();
  });

  it.each([
    ['2026-02-01', '2026-02-28', '2026-02-14'],
    ['2028-02-01', '2028-02-29', '2028-02-14'],
    ['2026-12-01', '2026-12-31', '2026-12-14'],
  ])('uses calendar month boundaries for %s', (monthStart, monthEnd, measuredThrough) => {
    const view = monthlyBudgetProgress(
      status('below', { measured: 140, budget: 500, monthStart, monthEnd, measuredThrough }),
      500,
      'USD'
    );
    expect(view?.pace).toBe('Not projected to exhaust this month');
  });

  it('preserves the composer draft and optimistic conversation on a raced server rejection', () => {
    const source = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
    expect(source).toContain("askError.result.code === 'BUDGET_APPROVAL_REQUIRED'");
    expect(source).toContain('setDraft(question)');
    expect(source).toContain('items.filter((item) => item.id !== userMessage.id)');
    expect(source).toContain('forgetActiveConversationRun(runs, runConversationId)');
    expect(source).toContain("const budgetBlocked = budgetStatus?.level === 'approval-required'");
    expect(source).toContain('<ComposerBudgetStatus');
    expect(readFileSync(new URL('./ComposerBudgetStatus.tsx', import.meta.url), 'utf8')).toContain(
      'An administrator must approve continued usage.'
    );
  });

  it('keeps enforcement constants while removing budget explanations from Cost methodology', () => {
    const source = readFileSync(new URL('./OpsPage.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Budget controls|Budget guardrails|hard billing ceiling|APP_BUDGET_GUARDRAILS/);
    expect(APP_BUDGET_GUARDRAILS).toContainEqual({ label: 'Warning', value: '80% — questions continue' });
    expect(APP_BUDGET_GUARDRAILS).toContainEqual({
      label: 'Approval required',
      value: '100% — new questions pause until an administrator approves',
    });
    expect(APP_BUDGET_GUARDRAILS.find((row) => row.label === 'Billing freshness')?.value).toContain(
      'billing can lag by hours'
    );
    expect(APP_BUDGET_GUARDRAILS).toContainEqual({ label: 'Resource budgets', value: 'Advisory only' });
  });

  it('keeps the app guard separate from AI Gateway enforcement metadata', () => {
    const source = readFileSync(new URL('../../shared/ai-gateway-contract.ts', import.meta.url), 'utf8');
    expect(source).toContain("source: z.literal('gateway-block-usage-budget')");
    expect(source).toContain("source: z.literal('advisory-resource-budget')");
    expect(source).not.toContain("source: z.literal('app-budget-guard')");
  });
});
