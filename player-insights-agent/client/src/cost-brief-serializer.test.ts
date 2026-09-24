import { describe, expect, it } from 'vitest';
import type { AppSpendFigure, CostBriefPayload } from '../../shared/ops-contract';
import {
  buildDevProdProjection,
  costBriefExportView,
  PROD_VARIABLE_USAGE_FACTOR,
  serializeCostBriefMarkdown,
} from './cost-brief-serializer';

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

describe('buildDevProdProjection', () => {
  it('reconciles a zero standing field to the residual of total minus attributed', () => {
    const inconsistent = {
      ...ready,
      total: figure(1494.16),
      spendBreakdown: { attributed: figure(942.12), standing: figure(0) },
    };
    expect(costBriefExportView(inconsistent)).toMatchObject({
      total: 1494.16,
      attributed: 942.12,
      standing: 552.04,
    });
    expect(buildDevProdProjection(inconsistent).prodProjected).toBeCloseTo(552.04 + 942.12 * 0.15, 6);
  });

  it('duplicates fixed hosting and applies the disclosed lower factor only to question-driven usage', () => {
    const projection = buildDevProdProjection(ready);

    expect(PROD_VARIABLE_USAGE_FACTOR).toBe(0.15);
    expect(projection.devObserved).toBe(1234.5);
    expect(projection.devStanding).toBe(334.5);
    expect(projection.devVariable).toBe(900);
    expect(projection.prodProjected).toBe(334.5 + 900 * 0.15);
    expect(projection.combined).toBe(1234.5 + 334.5 + 900 * 0.15);
    expect(projection.prodProjected).toBeLessThan(projection.devObserved!);
  });

  it('keeps existing resource categories and treats only their standing share as fixed', () => {
    const projection = buildDevProdProjection(ready);
    expect(projection.resources.map((resource) => resource.label)).toEqual([
      'Serving endpoint',
      'Ask SQL warehouse',
      'Reconciled fixed hosting',
    ]);
    expect(projection.resources[0]).toMatchObject({
      devObserved: 500,
      devStanding: 200,
      prodStanding: 200,
    });
    expect(projection.resources[1]).toMatchObject({
      devObserved: 734.5,
      devStanding: 0,
      prodStanding: 0,
    });
    expect(projection.resources[2]).toMatchObject({
      id: 'reconciled-standing',
      devStanding: 134.5,
      prodStanding: 134.5,
      prodVariable: 0,
      prodProjected: 134.5,
    });
    expect(projection.resources.reduce((sum, resource) => sum + (resource.prodProjected ?? 0), 0)).toBeCloseTo(
      projection.prodProjected!,
      6
    );
  });

  it('does not turn an unavailable observed category into zero projected spend', () => {
    const projection = buildDevProdProjection({
      ...ready,
      resources: [{ ...ready.resources[0], amount: null, standingAmount: null }],
    });
    expect(projection.resources[0]).toMatchObject({
      devObserved: null,
      prodProjected: null,
      combined: null,
    });
  });

  it('excludes Vector Search from rows, observed totals, and Prod projection math', () => {
    const withVectorSearch: CostBriefPayload = {
      ...ready,
      total: figure(1334.5),
      spendBreakdown: { attributed: figure(950), standing: figure(384.5) },
      resources: [
        ...ready.resources,
        {
          id: 'vector-search',
          label: 'Vector Search',
          population: 'This deployment',
          amount: 100,
          standingAmount: 50,
          quality: 'estimate',
        },
      ],
    };

    expect(costBriefExportView(withVectorSearch)).toMatchObject({
      total: 1234.5,
      attributed: 900,
      standing: 334.5,
    });
    const projection = buildDevProdProjection(withVectorSearch);
    expect(projection.resources.map((resource) => resource.id)).not.toContain('vector-search');
    expect(projection.devObserved).toBe(1234.5);
    expect(projection.prodProjected).toBe(334.5 + 900 * 0.15);

    const markdown = serializeCostBriefMarkdown(withVectorSearch);
    expect(markdown).toContain('**Total:** 1,234.50 USD');
    expect(markdown).not.toContain('Vector Search');
  });
});
