import { describe, expect, it } from 'vitest';

import { genieDailyCharge } from './user-spend-refresh-source';

describe('daily canonical spend source', () => {
  it('keeps free Genie USD at measured zero and charged DBUs separate', () => {
    expect(genieDailyCharge({ paidUsd: 0, chargedEffectiveDbus: 0 }, null)).toEqual({ usd: 0, dbu: 0 });
    expect(
      genieDailyCharge({ paidUsd: 2.5, chargedEffectiveDbus: 5 }, { paidUsd: 0, chargedEffectiveDbus: 0 })
    ).toEqual({ usd: 2.5, dbu: 5 });
  });

  it('does not turn incomplete Genie pricing into zero', () => {
    expect(genieDailyCharge({ paidUsd: null, chargedEffectiveDbus: 5 }, null)).toEqual({ usd: null, dbu: 5 });
    expect(
      genieDailyCharge({ paidUsd: 3, chargedEffectiveDbus: 6 }, { paidUsd: null, chargedEffectiveDbus: 1 })
    ).toEqual({ usd: null, dbu: 5 });
  });
});
