import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('User Monitoring spend profile trend removal', () => {
  it('has no period-over-period cards, loaders, contracts, or API comparisons', () => {
    const production = [
      source('./MonitoringPage.tsx'),
      source('../../shared/user-spend-contract.ts'),
      source('../../server/lib/user-spend-metrics.ts'),
      source('../../server/routes/user-spend-read-model-routes.ts'),
      source('../../server/routes/ops-routes.ts'),
    ].join('\n');
    expect(production).not.toMatch(
      /Week over week|Month over month|No comparable period|prior 7 days|prior matched month|weekOverWeek|monthOverMonth|userSpendComparisonWindows|readComparisonSpend/
    );
  });

  it('keeps the responsive three, two, one-column spend grid', () => {
    expect(source('./styles/monitoring.css')).toMatch(
      /\.user-profile-modal-spend-kpis\s*\{[^}]*grid-template-columns:\s*repeat\(3,/s
    );
    const responsive = source('./styles/responsive-monitoring.css');
    expect(responsive).toMatch(/\.user-profile-modal-spend-kpis\s*\{[^}]*repeat\(2,/s);
    expect(responsive).toMatch(/\.user-profile-modal-spend-kpis\s*\{[^}]*minmax\(0,\s*1fr\)/s);
  });
});
