import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MethodologySections } from './MethodologySection';

describe('shared Cost and Forecasting methodology structure', () => {
  it('orders populated groups and omits empty groups', () => {
    const markup = renderToStaticMarkup(
      <MethodologySections
        groups={[
          { title: 'Limits', rows: [{ detail: 'A limit' }] },
          { title: 'Not included', rows: [] },
          { title: 'How totals are calculated', rows: [{ label: 'Vector Search', detail: 'Measured endpoint share' }] },
        ]}
      />
    );
    expect(markup).toContain('ops-methodology-sections');
    expect(markup).toContain('ops-methodology-rows');
    expect(markup.indexOf('How totals are calculated')).toBeLessThan(markup.indexOf('Limits'));
    expect(markup).not.toContain('Not included');
    expect(markup).toContain('Vector Search');
  });

  it('is the one structure rendered by both Cost and Forecasting disclosures', () => {
    const cost = readFileSync(new URL('./OpsPage.tsx', import.meta.url), 'utf8');
    const forecast = readFileSync(new URL('./ForecastingPanel.tsx', import.meta.url), 'utf8');
    expect(cost).toContain('<MethodologySections groups={groups} />');
    expect(forecast).toContain('<MethodologySections groups={methodologyGroups} />');
    expect(cost).toContain('Exact Vector Search endpoint billing');
    const costMethod = cost.slice(cost.indexOf('function CostMethodology'), cost.indexOf('/* ── Traffic'));
    expect(costMethod).not.toContain('<ul>');
  });
});
