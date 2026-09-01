import { describe, expect, it } from 'vitest';
import {
  buildGenieAccountingStatement,
  classifyGenieAccounting,
  GENIE_FREE_SKU,
  readGenieAccountingRows,
  type GenieAccountingRow,
} from './genie-accounting';

function row(overrides: Partial<GenieAccountingRow> = {}): GenieAccountingRow {
  return {
    usageDay: '2026-09-01',
    identity: 'person@example.test',
    identityKind: 'human',
    surface: 'GENIE_CODE',
    channel: 'UI',
    offeringType: 'PAYGO',
    skuName: GENIE_FREE_SKU,
    dbus: 40,
    paidUsd: 0,
    pricedRows: 0,
    unpricedRows: 0,
    correctionRows: 0,
    throughDay: '2026-09-01',
    ...overrides,
  };
}

describe('Genie billing classification', () => {
  it('uses only verified the demo workspace fields and bounds the query to one calendar month', () => {
    const built = buildGenieAccountingStatement('workspace-redacted', {
      from: '2026-08-26',
      to: '2026-09-01',
    });
    expect(built?.statement).toContain('usage_metadata.genie.surface');
    expect(built?.statement).toContain('usage_metadata.genie.channel');
    expect(built?.statement).toContain('product_features.genie.offering_type');
    expect(built?.statement).toContain('identity_metadata.run_as');
    expect(built?.statement).toContain("DATE_TRUNC('MONTH', :through_day)");
    expect(built?.statement).not.toContain('genie_space_id');
  });

  it('separates human allowance, promotional surfaces, and charged paid usage during promotion', () => {
    const result = classifyGenieAccounting(
      [
        row({ dbus: 120 }),
        row({ surface: 'GENIE_ONE', dbus: 30 }),
        row({ surface: 'GENIE_AGENTS', channel: 'API', dbus: 20 }),
        row({
          skuName: 'ENTERPRISE_SERVERLESS_REAL_TIME_INFERENCE_REGION',
          dbus: 40,
          paidUsd: 8,
          pricedRows: 1,
        }),
      ],
      '2026-09-01'
    );
    expect(result.allowanceUsedDbus).toBe(120);
    expect(result.allowanceRemainingDbus).toBe(30);
    expect(result.promotionalDbus).toBe(50);
    expect(result.chargedEffectiveDbus).toBe(40);
    expect(result.chargedRawEquivalentDbus).toBe(30);
    expect(result.paidUsd).toBe(8);
    expect(result.underlyingTotalDbus).toBe(200);
  });

  it('never grants service principals a human allowance', () => {
    const result = classifyGenieAccounting(
      [row({ identity: 'service-principal-id', identityKind: 'service_principal', dbus: 75 })],
      '2026-09-01'
    );
    expect(result.humanUsers).toBe(0);
    expect(result.allowanceUsedDbus).toBe(0);
    expect(result.promotionalDbus).toBe(0);
    expect(result.chargedEffectiveDbus).toBe(100);
    expect(result.chargedRawEquivalentDbus).toBe(75);
    expect(result.paidUsd).toBeNull();
    expect(result.pricingState).toBe('unpriced');
  });

  it('applies the allowance to all eligible surfaces and removes reconstruction after the promotion', () => {
    const result = classifyGenieAccounting(
      [
        row({ usageDay: '2027-02-01', throughDay: '2027-02-01', surface: 'GENIE_ONE', dbus: 60 }),
        row({
          usageDay: '2027-02-01',
          throughDay: '2027-02-01',
          skuName: 'ENTERPRISE_SERVERLESS_REAL_TIME_INFERENCE_REGION',
          dbus: 10,
          paidUsd: 2,
          pricedRows: 1,
        }),
      ],
      '2027-02-01'
    );
    expect(result.allowanceUsedDbus).toBe(60);
    expect(result.promotionalDbus).toBe(0);
    expect(result.chargedEffectiveDbus).toBe(10);
    expect(result.chargedRawEquivalentDbus).toBe(10);
    expect(result.underlyingTotalDbus).toBe(70);
  });

  it('withholds malformed rows instead of converting them to zero', () => {
    const parsed = readGenieAccountingRows([
      { identity_kind: 'human', dbus: 'bad' },
      {
        usage_day: '2026-09-01',
        identity: 'person@example.test',
        identity_kind: 'human',
        surface: 'GENIE_CODE',
        channel: 'UI',
        offering_type: 'PAYGO',
        sku_name: GENIE_FREE_SKU,
        dbus: '12.5',
        paid_usd: null,
        priced_rows: '0',
        unpriced_rows: '0',
        correction_rows: '0',
        through_day: '2026-09-01',
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].paidUsd).toBeNull();
  });
});
