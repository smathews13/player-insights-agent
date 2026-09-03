import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('reader-facing Partial terminology', () => {
  it('preserves Partial for the canonical run outcome', () => {
    expect(source('./MonitoringPage.tsx')).toContain("{ value: 'partial', label: 'Partial' }");
    expect(source('./run-header-labels.ts')).toContain("{ value: 'partial', label: 'Partial' }");
  });

  it('does not call metric, inventory, or source coverage Partial', () => {
    const production = [
      source('./MonitoringPage.tsx'),
      source('./ops-view.ts'),
      source('./EgressPanel.tsx'),
      source('./use-evaluation-lab.ts'),
      source('../../server/lib/ops-billing.ts'),
    ].join('\n');
    expect(production).not.toMatch(/Partial (?:coverage|list|suite)|Partial:/);
  });
});
