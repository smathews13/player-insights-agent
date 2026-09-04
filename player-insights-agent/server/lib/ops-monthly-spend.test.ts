import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CostIdentifiers } from './ops-billing';
import {
  buildRecentMonthlySpendStatement,
  cachedRecentMonthlySpend,
  forgetRecentMonthlySpend,
  readRecentMonthlySpendRows,
  RECENT_MONTHLY_SPEND_CACHE_MS,
  recentCompletedMonths,
} from './ops-monthly-spend';

const IDS: CostIdentifiers = {
  appName: 'player-insights',
  endpointName: 'agent-endpoint',
  foundationModel: 'foundation-endpoint',
  warehouseId: 'warehouse-id',
  vectorEndpoint: 'vector-endpoint',
  vectorIndex: 'catalog.schema.index',
  vectorEndpointIndexCount: 1,
  genieSpaces: [],
  workspaceId: 'workspace-id',
  telemetryEnabled: false,
  appBillingTag: 'matched',
};

describe('recent completed monthly spend', () => {
  beforeEach(forgetRecentMonthlySpend);

  it('uses full UTC calendar boundaries newest-first across year rollover', () => {
    expect(recentCompletedMonths(Date.parse('2026-01-15T12:00:00Z'))).toEqual([
      { month: '2025-12', from: '2025-12-01', to: '2025-12-31' },
      { month: '2025-11', from: '2025-11-01', to: '2025-11-30' },
      { month: '2025-10', from: '2025-10-01', to: '2025-10-31' },
    ]);
    expect(recentCompletedMonths(Date.parse('2026-09-01T00:30:00+14:00'))[0]?.month).toBe('2026-07');
  });

  it('builds one bounded three-row aggregate over app-attributed billing without unioning totals', () => {
    const built = buildRecentMonthlySpendStatement(IDS, Date.parse('2026-09-03T12:00:00Z'));
    expect(built?.statement).toContain('WITH requested_months AS');
    expect(built?.statement.match(/UNION ALL/g)).toHaveLength(2);
    expect(built?.statement).toContain('system.billing.usage');
    expect(built?.statement).toContain('system.billing.list_prices');
    expect(built?.statement).toContain("u.billing_origin_product = 'APPS'");
    expect(built?.statement).toContain("u.billing_origin_product = 'SQL'");
    expect(built?.statement).toContain("u.billing_origin_product IN ('MODEL_SERVING', 'AI_GATEWAY')");
    expect(built?.statement).toContain("u.billing_origin_product = 'VECTOR_SEARCH'");
    expect(built?.statement).toContain("u.custom_tags['system_billing'] = 'astrolabe'");
    expect(built?.statement).toContain('GROUP BY months.month_start');
    expect(built?.statement).toContain('ORDER BY months.month_start DESC');
    expect(built?.statement).toContain('LIMIT 3');
    expect(built?.parameters).toEqual(
      expect.arrayContaining([
        { name: 'month0From', value: '2026-08-01', type: 'DATE' },
        { name: 'month0To', value: '2026-08-31', type: 'DATE' },
        { name: 'month2From', value: '2026-06-01', type: 'DATE' },
        { name: 'month2To', value: '2026-06-30', type: 'DATE' },
      ])
    );
  });

  it('preserves ordering, missing months, and a genuine zero in both units', () => {
    const rows = readRecentMonthlySpendRows(
      [
        ['2026-06', '12.5', '6.25', 'USD'],
        ['2026-08', '0', '0', 'USD'],
      ],
      Date.parse('2026-09-03T12:00:00Z')
    );
    expect(rows).toEqual([
      { month: '2026-08', amount: 0, dbus: 0, currency: 'USD' },
      { month: '2026-07', amount: null, dbus: null, currency: '' },
      { month: '2026-06', amount: 12.5, dbus: 6.25, currency: 'USD' },
    ]);
  });

  it('coalesces and caches the aggregate with Cost payload reads', async () => {
    const value = readRecentMonthlySpendRows([], Date.parse('2026-09-03T12:00:00Z'));
    const read = vi.fn(() => Promise.resolve(value));
    const [first, second] = await Promise.all([
      cachedRecentMonthlySpend('caller|workspace|2026-09', 1_000, read),
      cachedRecentMonthlySpend('caller|workspace|2026-09', 1_000, read),
    ]);
    expect(first).toEqual(value);
    expect(second).toEqual(value);
    await cachedRecentMonthlySpend('caller|workspace|2026-09', 1_000 + RECENT_MONTHLY_SPEND_CACHE_MS - 1, read);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
