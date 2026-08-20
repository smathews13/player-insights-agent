import { describe, expect, it } from 'vitest';

import { BILLING_TAG_KEY, buildCostStatement, type CostIdentifiers } from './ops-billing';

const IDS: CostIdentifiers = {
  appName: 'player-insights',
  endpointName: 'player-insights-agent',
  warehouseId: 'warehouse-1',
  vectorEndpoint: '',
  rebuildJobId: '',
  workspaceId: 'workspace-1',
  telemetryEnabled: false,
};

describe('billing attribution', () => {
  it('limits every cost figure to resources tagged for Astrolabe', () => {
    const query = buildCostStatement(IDS, { from: '2026-08-01', to: '2026-08-07' });

    expect(BILLING_TAG_KEY).toBe('astrolabe');
    expect(query?.statement).toContain("u.custom_tags['astrolabe'] IS NOT NULL");
  });
});
