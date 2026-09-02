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
    spaceId: '',
    attributionMethod: 'unattributed',
    dbus: 40,
    paidUsd: 0,
    pricedRows: 0,
    unpricedRows: 0,
    correctionRows: 0,
    sourceRows: 1,
    throughDay: '2026-09-01',
    ...overrides,
  };
}

const SPACES = [
  { id: 'space-data', label: 'Data Genie', tileId: 'genie:data' },
  { id: 'space-dictionary', label: 'Dictionary Genie', tileId: 'genie:dictionary' },
] as const;

describe('Genie billing classification', () => {
  it('uses only verified the demo workspace fields and bounds the query to one calendar month', () => {
    const built = buildGenieAccountingStatement(
      'workspace-redacted',
      {
        from: '2026-08-26',
        to: '2026-09-01',
      },
      SPACES
    );
    expect(built?.statement).toContain('usage_metadata.genie.surface');
    expect(built?.statement).toContain('usage_metadata.genie.channel');
    expect(built?.statement).toContain('product_features.genie.offering_type');
    expect(built?.statement).toContain('identity_metadata.run_as');
    expect(built?.statement).toContain("DATE_TRUNC('MONTH', :through_day)");
    expect(built?.statement).toContain("LEAST(:from_day, DATE_TRUNC('MONTH', :through_day))");
    expect(built?.statement).toContain('query_source.genie_space_id');
    expect(built?.statement).toContain('GROUP BY record_id');
    expect(built?.statement).toContain('allocation_weight');
    expect(built?.statement).toContain('LEFT JOIN system.billing.list_prices');
    expect(built?.statement).toContain(`ON usage.sku_name <> '${GENIE_FREE_SKU}'`);
    expect(built?.statement).toContain(`WHEN sku_name = '${GENIE_FREE_SKU}' THEN CAST(0 AS DOUBLE)`);
    expect(built?.statement).toContain('SUM(allocation_weight) AS source_rows');
    expect(built?.parameters).toEqual(
      expect.arrayContaining([
        { name: 'from_day', value: '2026-08-26', type: 'DATE' },
        { name: 'genieSpace0', value: 'space-data', type: 'STRING' },
        { name: 'genieSpace1', value: 'space-dictionary', type: 'STRING' },
      ])
    );
  });

  it('attributes exact and allocated rows once and keeps unmapped usage separate', () => {
    const result = classifyGenieAccounting(
      [
        row({ spaceId: 'space-data', attributionMethod: 'query-history-exact', dbus: 30 }),
        row({
          spaceId: 'space-dictionary',
          attributionMethod: 'query-history-allocation',
          surface: 'GENIE_ONE',
          dbus: 20,
        }),
        row({
          spaceId: 'space-data',
          attributionMethod: 'query-history-allocation',
          skuName: 'ENTERPRISE_SERVERLESS_REAL_TIME_INFERENCE_REGION',
          dbus: 10,
          paidUsd: 2,
          pricedRows: 1,
        }),
        row({ identity: 'other@example.test', spaceId: '', attributionMethod: 'unattributed', dbus: 5 }),
      ],
      '2026-09-01',
      SPACES
    );
    expect(result.instances).toMatchObject([
      {
        spaceId: 'space-data',
        allowanceUsedDbus: 30,
        chargedEffectiveDbus: 10,
        paidUsd: 2,
      },
      {
        spaceId: 'space-dictionary',
        attribution: 'query-history-allocation',
        promotionalDbus: 20,
      },
    ]);
    expect(result.instances?.[0].surfaces.find((surface) => surface.surface === 'GENIE_CODE')?.allowanceUsedDbus).toBe(
      30
    );
    expect(result.instances?.[1].surfaces.find((surface) => surface.surface === 'GENIE_ONE')?.promotionalDbus).toBe(20);
    expect(result.unattributed?.allowanceUsedDbus).toBe(5);
    expect(result.reconciliation).toMatchObject({
      sourceDbus: 65,
      attributedDbus: 60,
      unattributedDbus: 5,
    });
    expect(result.reconciliation?.attributedShare).toBeCloseTo(60 / 65);
    expect(result.reconciliation?.classificationDifferenceDbus).toBeCloseTo(0);
    expect(
      (result.instances ?? []).reduce((total, instance) => total + instance.sourceDbus, 0) +
        (result.unattributed?.sourceDbus ?? 0)
    ).toBe(result.reconciliation?.sourceDbus);
  });

  it('caps each human once across spaces and distributes contributions proportionally', () => {
    const result = classifyGenieAccounting(
      [
        row({ spaceId: 'space-data', attributionMethod: 'query-history-exact', dbus: 100 }),
        row({ spaceId: 'space-dictionary', attributionMethod: 'query-history-allocation', dbus: 100 }),
        row({
          identity: 'second@example.test',
          spaceId: 'space-dictionary',
          attributionMethod: 'query-history-exact',
          dbus: 40,
        }),
      ],
      '2026-09-01',
      SPACES
    );
    expect(result.allowanceUsedDbus).toBe(190);
    expect(result.allowanceRemainingDbus).toBe(110);
    expect(result.instances?.map((instance) => instance.allowanceUsedDbus)).toEqual([75, 115]);
    expect(result.instances?.map((instance) => instance.unknownDbus)).toEqual([25, 25]);
    expect(result.users[0].allowanceRemainingDbus + result.users[1].allowanceRemainingDbus).toBe(110);
    expect(result.reconciliation?.classificationDifferenceDbus).toBe(0);
  });

  it('applies the human allowance independently in each calendar month of a selected period', () => {
    const result = classifyGenieAccounting(
      [
        row({ usageDay: '2026-08-31', throughDay: '2026-08-31', dbus: 100 }),
        row({ usageDay: '2026-09-01', throughDay: '2026-09-01', dbus: 100 }),
      ],
      '2026-09-01'
    );
    expect(result.allowanceUsedDbus).toBe(200);
    expect(result.allowanceRemainingDbus).toBe(100);
    expect(result.users).toHaveLength(2);
    expect(result.reconciliation?.classificationDifferenceDbus).toBe(0);
  });

  it('keeps prior measured rows when the selected current day has not arrived in billing', () => {
    const result = classifyGenieAccounting(
      [row({ usageDay: '2026-08-31', throughDay: '2026-08-31', dbus: 9 })],
      '2026-09-01'
    );
    expect(result.throughDay).toBe('2026-08-31');
    expect(result.allowanceUsedDbus).toBe(9);
    expect(result.underlyingTotalDbus).toBe(9);
  });

  it('supports one configured space and keeps no-space rows unattributed', () => {
    const one = classifyGenieAccounting(
      [row({ spaceId: 'space-data', attributionMethod: 'query-history-exact', dbus: 10 })],
      '2026-09-01',
      [SPACES[0]]
    );
    expect(one.instances).toHaveLength(1);
    expect(one.instances?.[0]).toMatchObject({ spaceId: 'space-data', allowanceUsedDbus: 10 });
    expect(one.unattributed).toBeNull();

    const none = classifyGenieAccounting([row({ dbus: 10 })], '2026-09-01', []);
    expect(none.instances).toEqual([]);
    expect(none.unattributed?.allowanceUsedDbus).toBe(10);
    expect(none.reconciliation?.attributedShare).toBe(0);
  });

  it('returns genuine classified zero only after a successful empty read', () => {
    const result = classifyGenieAccounting([], '2026-09-01', SPACES);
    expect(result.reconciliation).toMatchObject({
      sourceRows: 0,
      sourceDbus: 0,
      classifiedDbus: 0,
      classificationDifferenceDbus: 0,
    });
    expect(result.instances?.every((instance) => instance.underlyingTotalDbus === 0)).toBe(true);
    expect(result.unattributed).toBeNull();
  });

  it('does not duplicate usage when two configured roles point to one physical space', () => {
    const result = classifyGenieAccounting(
      [row({ spaceId: 'shared-space', attributionMethod: 'query-history-exact', dbus: 20 })],
      '2026-09-01',
      [
        { ...SPACES[0], id: 'shared-space' },
        { ...SPACES[1], id: 'shared-space' },
      ]
    );
    expect(result.instances).toHaveLength(1);
    expect(result.instances?.[0]).toMatchObject({
      spaceId: 'shared-space',
      label: 'Data Genie / Dictionary Genie',
      allowanceUsedDbus: 20,
    });
    expect(result.allowanceUsedDbus).toBe(20);
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
    expect(result.chargedEffectiveDbus).toBe(0);
    expect(result.chargedRawEquivalentDbus).toBe(0);
    expect(result.unknownDbus).toBe(75);
    expect(result.paidUsd).toBe(0);
    expect(result.pricingState).toBe('priced');
    expect(result.reconciliation?.classificationDifferenceDbus).toBe(0);
  });

  it('keeps free rows with unknown surface or identity in exact reconciliation', () => {
    const result = classifyGenieAccounting(
      [row({ surface: '', dbus: 12 }), row({ identity: '', identityKind: 'unknown', surface: 'GENIE_CODE', dbus: 8 })],
      '2026-09-01'
    );
    expect(result.unknownDbus).toBe(20);
    expect(result.underlyingTotalDbus).toBe(20);
    expect(result.paidUsd).toBe(0);
    expect(result.reconciliation).toMatchObject({
      sourceRows: 2,
      sourceDbus: 20,
      classifiedDbus: 20,
      classificationDifferenceDbus: 0,
    });
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

  it('keeps paid DBUs measured but USD unavailable when no list price matches', () => {
    const result = classifyGenieAccounting(
      [
        row({
          skuName: 'ENTERPRISE_SERVERLESS_REAL_TIME_INFERENCE_REGION',
          dbus: 10,
          paidUsd: null,
          pricedRows: 0,
          unpricedRows: 1,
        }),
      ],
      '2026-09-01'
    );
    expect(result.chargedEffectiveDbus).toBe(10);
    expect(result.chargedRawEquivalentDbus).toBe(7.5);
    expect(result.paidUsd).toBeNull();
    expect(result.pricingState).toBe('unpriced');
    expect(result.reconciliation?.classificationDifferenceDbus).toBe(0);
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

  it('parses the Statement API JSON_ARRAY production shape for free rows without a price', () => {
    const parsed = readGenieAccountingRows([
      [
        '2026-08-31',
        'person@example.test',
        'human',
        'GENIE_ONE',
        'UI',
        'PAYGO',
        GENIE_FREE_SKU,
        'space-data',
        'query-history-exact',
        '17.25',
        '0',
        '0',
        '0',
        '0',
        '1',
        '2026-08-31',
      ],
    ]);
    expect(parsed).toHaveLength(1);
    const result = classifyGenieAccounting(parsed, '2026-09-01', SPACES);
    expect(result.promotionalDbus).toBe(17.25);
    expect(result.instances?.[0]).toMatchObject({
      promotionalDbus: 17.25,
      paidUsd: 0,
      underlyingTotalDbus: 17.25,
    });
    expect(result.reconciliation?.classificationDifferenceDbus).toBe(0);
  });
});
