import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { appBudgetPeriod, emptyAppBudgetStatus, type AppBudgetStatus } from '../../shared/app-budget-guard';
import { APP_BUDGET_GUARDRAILS } from '../../shared/app-budget-contract';
import { ComposerBudgetStatus } from './ComposerBudgetStatus';
import { BudgetGuardStatus, RecentMonthlySpend, SavedAppBudgetSummary, monthlyBudgetProgress } from './CostBudgets';

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

  it('shows estimated remaining from useful partial MTD and never the selected-period total', () => {
    const partial = renderToStaticMarkup(
      <SavedAppBudgetSummary savedBudget={800} unit="USD" status={status('unavailable/partial', { budget: 800 })} />
    );
    expect(partial).toContain('$700.00 of $800.00 app budget remaining');
    expect(partial).not.toContain('Monthly app budget');
    expect(partial).not.toContain('Within budget');
    expect(partial).toContain('lucide-circle-check');
    expect(partial).toContain('ops-cost-summary-budget-outcome');
    expect(partial).toContain('data-budget-tone="normal"');
    expect(partial).not.toContain('Spent this calendar month');
    expect(partial).not.toMatch(/>Estimated</);
    expect(partial).toContain('enforcement remains fail-open until coverage is complete');
    expect(partial).toContain('aria-live="polite"');

    const complete = renderToStaticMarkup(
      <SavedAppBudgetSummary
        savedBudget={800}
        unit="USD"
        status={status('approval-required', { measured: 923.27, budget: 800, percent: 115.40875 })}
      />
    );
    expect(complete).toContain('$123.27 over $800.00 app budget');
    expect(complete).not.toContain('Budget exceeded');
    expect(complete).toContain('lucide-circle-x');
    expect(complete).toContain('data-budget-tone="danger"');
  });

  it.each([
    [10, 'normal'],
    [79, 'normal'],
    [80, 'normal'],
    [100, 'danger'],
    [120, 'danger'],
  ] as const)('colors complete MTD spend %s by budget status and pacing', (measured, tone) => {
    expect(monthlyBudgetProgress(status('below', { measured, budget: 100 }), 100, 'USD')?.tone).toBe(tone);
  });

  it('projects exhaustion from useful MTD pace without changing fail-open enforcement', () => {
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
    expect(crossing?.pace).toBe('Will exceed budget in 8 days');
    expect(crossing?.tone).toBe('normal');
    const crossingMarkup = renderToStaticMarkup(
      <SavedAppBudgetSummary
        savedBudget={900}
        unit="USD"
        status={status('below', {
          measured: 600,
          budget: 900,
          monthStart: '2026-09-01',
          measuredThrough: '2026-09-15',
          monthEnd: '2026-09-30',
        })}
      />
    );
    expect(crossingMarkup).toContain('Will exceed budget in 8 days');
    expect(crossingMarkup).toContain('lucide-circle-x');
    expect(crossingMarkup).toContain('ops-cost-summary-budget-outcome" data-budget-tone="normal"');
    expect(crossingMarkup).toContain('ops-cost-summary-budget-status" data-budget-tone="danger"');
    const styles = readFileSync(new URL('./styles/ops.css', import.meta.url), 'utf8');
    expect(styles).toMatch(
      /\.ops-cost-summary-budget-outcome\[data-budget-tone='normal'\]\s*\{[^}]*color:\s*var\(--ast-pos-text\)/
    );
    expect(styles).toMatch(
      /\.ops-cost-summary-budget-status\[data-budget-tone='danger'\]\s*\{[^}]*color:\s*var\(--ast-neg-text\)/
    );
    expect(styles).toMatch(/@media \(forced-colors: active\)\s*\{[^}]*\.ops-cost-summary-budget-outcome/s);
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
    ).toBe('');
    expect(monthlyBudgetProgress(status('unavailable/partial'), 100, 'USD')?.estimated).toBe(true);
    expect(
      monthlyBudgetProgress(status('unavailable/partial', { measured: null, coverage: 'unavailable' }), 100, 'USD')
    ).toBeNull();
  });

  it('keeps selected-period spend and the active unit out of authoritative MTD pacing', () => {
    const selectedPeriodSpend = 135.49;
    const usd = monthlyBudgetProgress(status('below', { measured: 180, budget: 900 }), 900, 'USD');
    expect(selectedPeriodSpend).not.toBe(180);
    expect(usd?.balance).toBe('$720.00 of $900.00 app budget remaining');
    expect(monthlyBudgetProgress(status('below', { measured: 45, budget: 90, unit: 'DBU' }), 90, 'DBU')?.balance).toBe(
      '45.00 of 90.00 DBU app budget remaining'
    );
    expect(monthlyBudgetProgress(status('below', { measured: 180, budget: 900 }), 90, 'DBU')).toBeNull();
  });

  it('renders the production-shaped 7-day screenshot from a separate MTD display snapshot', () => {
    const production = status('unavailable/partial', {
      measured: 135.49,
      budget: 900,
      coverage: 'partial',
      displayMtdSpend: {
        USD: {
          amount: 36.87,
          budget: 900,
          coverage: 'partial',
          sourceThrough: '2026-09-15',
        },
      },
    });
    const markup = renderToStaticMarkup(<SavedAppBudgetSummary savedBudget={900} unit="USD" status={production} />);
    expect(markup).not.toContain('Monthly app budget');
    expect(markup).toContain('$863.13 of $900.00 app budget remaining');
    expect(markup).not.toMatch(/>Estimated</);
    expect(markup).not.toContain('Spent this calendar month');
    expect(markup).not.toContain('$764.51');
    expect(monthlyBudgetProgress(production, 1_000, 'USD')?.balance).toBe('$963.13 of $1,000.00 app budget remaining');
  });

  it('renders three completed months in selected units, preserving missing and zero values', () => {
    const months = [
      { month: '2026-08', amount: 0, dbus: 0, currency: 'USD' },
      { month: '2026-07', amount: null, dbus: null, currency: '' },
      { month: '2026-06', amount: 12.5, dbus: 6.25, currency: 'USD' },
    ];
    const usd = renderToStaticMarkup(<RecentMonthlySpend months={months} unit="USD" />);
    expect(usd).toContain('Recent monthly spend');
    expect(usd.indexOf('Aug 2026')).toBeLessThan(usd.indexOf('Jul 2026'));
    expect(usd.indexOf('Jul 2026')).toBeLessThan(usd.indexOf('Jun 2026'));
    expect(usd).toContain('$0.00');
    expect(usd).toContain('>—<');
    expect(usd).toContain('$12.50');
    expect(usd).not.toContain('Month to date');
    const dbu = renderToStaticMarkup(<RecentMonthlySpend months={months} unit="DBU" />);
    expect(dbu).toContain('0.00 DBU');
    expect(dbu).toContain('6.25 DBU');
    expect(dbu).not.toContain('$');
    expect(renderToStaticMarkup(<SavedAppBudgetSummary savedBudget={null} unit="USD" status={null} />)).toBe('');
  });

  it('withholds history with a concise reason when first deployment cannot be proven', () => {
    const markup = renderToStaticMarkup(
      <RecentMonthlySpend
        months={[]}
        unit="USD"
        reason="Recent monthly spend is unavailable because the app’s first successful deployment could not be proven."
      />
    );
    expect(markup).toContain('first successful deployment could not be proven');
    expect(markup).not.toContain('Jun 2026');
    expect(markup).not.toContain('$0.00');
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
    expect(view?.pace).toBe('');
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

  it('renders balance and pacing in the Total app spend source pane', () => {
    const source = readFileSync(new URL('./CostBudgets.tsx', import.meta.url), 'utf8');
    const summary = source.slice(
      source.indexOf('export function CostSpendSummary'),
      source.indexOf('function budgetActorDisplay')
    );
    expect(summary).toContain('<SavedAppBudgetSummary');
    expect(summary).toContain('progress.balance');
    expect(summary).toContain('progress.pace');
    expect(summary).toContain('Spend estimate unavailable');
  });

  it('keeps the app guard separate from AI Gateway enforcement metadata', () => {
    const source = readFileSync(new URL('../../shared/ai-gateway-contract.ts', import.meta.url), 'utf8');
    expect(source).toContain("source: z.literal('gateway-block-usage-budget')");
    expect(source).toContain("source: z.literal('advisory-resource-budget')");
    expect(source).not.toContain("source: z.literal('app-budget-guard')");
  });
});
