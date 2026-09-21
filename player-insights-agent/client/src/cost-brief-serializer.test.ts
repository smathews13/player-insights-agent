import { describe, expect, it } from 'vitest';
import type { AppSpendFigure, CostBriefPayload } from '../../shared/ops-contract';
import { serializeCostBriefMarkdown } from './cost-brief-serializer';

/**
 * The trailing-31-day cost brief is rendered to Markdown for the PDF export.
 * These cover the clean read (title, window caption, the attributed/standing
 * split, the per-resource table) and the states where there is nothing to
 * tabulate, which must print the reason rather than a table of dashes.
 */

function figure(amount: number | null, over: Partial<AppSpendFigure> = {}): AppSpendFigure {
  return {
    amount,
    dbus: null,
    currency: 'USD',
    sourceFrom: '2026-07-18',
    sourceThrough: '2026-08-16',
    completeness: amount === null ? 'unavailable' : 'complete',
    estimated: false,
    ...over,
  };
}

const ready: CostBriefPayload = {
  period: 'trailing_31d',
  state: 'ready',
  grant: null,
  reason: '',
  range: { from: '2026-07-18', to: '2026-08-17' },
  throughDay: '2026-08-16',
  currency: 'USD',
  billingLagDays: 1,
  total: figure(1234.5),
  spendBreakdown: { attributed: figure(900), standing: figure(334.5) },
  resources: [
    {
      id: 'serving-endpoint',
      label: 'Serving endpoint',
      population: 'This deployment',
      amount: 500,
      standingAmount: 200,
      quality: 'real',
    },
    {
      id: 'sql-warehouse',
      label: 'Ask SQL warehouse',
      population: 'This deployment',
      amount: 734.5,
      standingAmount: null,
      quality: 'real',
    },
  ],
  generatedAt: '2026-08-18T12:00:00.000Z',
};

describe('serializeCostBriefMarkdown', () => {
  it('renders the window, the attributed/standing split, and a per-resource table', () => {
    const markdown = serializeCostBriefMarkdown(ready);
    expect(markdown).toContain('# Cost breakdown — trailing 31 days');
    // The window is spelled out in full, not as a duration, with the complete-day count.
    expect(markdown).toContain('**Window:** 18 Jul 2026 to 17 Aug 2026 (31 complete days)');
    expect(markdown).toContain('**Through:** 2026-08-16 (billing lag: 1 day)');
    expect(markdown).toContain('**Generated:** 2026-08-18T12:00:00.000Z');
    expect(markdown).toContain('**Total:** 1,234.50 USD');
    expect(markdown).toContain('**Attributed to questions:** 900.00 USD');
    expect(markdown).toContain('**Standing infrastructure:** 334.50 USD');
    expect(markdown).toContain('| Serving endpoint | This deployment | 500.00 USD | 200.00 USD | real |');
    // A question-caused resource has no standing remainder, so its standing cell is a dash.
    expect(markdown).toContain('| Ask SQL warehouse | This deployment | 734.50 USD | — | real |');
    expect(markdown).toContain('reconciles to the total');
  });

  it('marks an incompletely-sourced figure as estimated', () => {
    const markdown = serializeCostBriefMarkdown({
      ...ready,
      total: figure(1000, { completeness: 'partial', estimated: true }),
    });
    expect(markdown).toContain('**Total:** 1,000.00 USD (estimated)');
  });

  it('explains a ready read whose figures could not be priced instead of showing bare dashes', () => {
    const markdown = serializeCostBriefMarkdown({
      ...ready,
      total: figure(null),
      spendBreakdown: { attributed: figure(null), standing: figure(null) },
    });
    expect(markdown).toContain('## Spend');
    expect(markdown).toContain('**Total:** Unavailable');
    expect(markdown).toContain('none could be priced or attributed to this deployment');
  });

  it('prints the reason instead of a table when nothing was read', () => {
    const markdown = serializeCostBriefMarkdown({
      ...ready,
      state: 'no-rows',
      reason: 'No billing rows have arrived for the last 31 days yet.',
      throughDay: '',
    });
    expect(markdown).toContain('# Cost breakdown — trailing 31 days');
    expect(markdown).toContain('_No billing rows have arrived for the last 31 days yet._');
    expect(markdown).not.toContain('## By resource');
    expect(markdown).not.toContain('## Spend');
  });
});
