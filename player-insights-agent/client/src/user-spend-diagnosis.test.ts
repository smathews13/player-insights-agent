import { describe, expect, it } from 'vitest';

import { userSpendHttpDiagnosis, userSpendPayloadDiagnosis } from './user-spend-diagnosis';

describe('user-spend diagnosis', () => {
  it.each([
    ['lakebase_update_required', 'Lakebase update required'],
    ['user_spend_preparing', 'Preparing user spend'],
    ['billing_access_required', 'Billing access required'],
    ['monitoring_user_not_rostered', 'User not added in Identity settings'],
  ] as const)('maps %s without exposing server detail', async (error, expected) => {
    const response = new Response(JSON.stringify({ error, detail: 'private database detail' }), {
      status: error === 'monitoring_user_not_rostered' ? 404 : 503,
      headers: { 'content-type': 'application/json' },
    });
    await expect(userSpendHttpDiagnosis(response)).resolves.toBe(expected);
  });

  it('distinguishes a preparing payload from genuine zero spend', () => {
    expect(
      userSpendPayloadDiagnosis({
        dataRevision: 2,
        readAt: '2026-09-03T20:00:00.000Z',
        requestedRange: { from: '2026-09-02', to: '2026-09-02' },
        range: { from: '2026-09-02', to: '2026-09-02' },
        state: 'unavailable',
        reason: 'Preparing user spend',
        users: [],
        unattributed: [],
        reconciliation: {
          usd: { unit: 'USD', appTotal: null, users: null, unattributed: null, difference: null },
          dbu: { unit: 'DBU', appTotal: null, users: null, unattributed: null, difference: null },
        },
      })
    ).toBe('Preparing user spend');

    expect(
      userSpendPayloadDiagnosis({
        dataRevision: 2,
        readAt: '2026-09-03T20:00:00.000Z',
        requestedRange: { from: '2026-09-02', to: '2026-09-02' },
        range: { from: '2026-09-02', to: '2026-09-02' },
        state: 'ready',
        reason: '',
        users: [
          {
            email: 'spend.user@example.test',
            total: {
              usd: { amount: 0, quality: 'direct' },
              dbu: { amount: 0, quality: 'direct' },
            },
            components: [],
          },
        ],
        unattributed: [],
        reconciliation: {
          usd: { unit: 'USD', appTotal: 0, users: 0, unattributed: 0, difference: 0 },
          dbu: { unit: 'DBU', appTotal: 0, users: 0, unattributed: 0, difference: 0 },
        },
      })
    ).toBeNull();
  });
});
