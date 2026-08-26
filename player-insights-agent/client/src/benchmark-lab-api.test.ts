import { describe, expect, it } from 'vitest';
import { labFromPayload } from './benchmark-lab-api';

describe('benchmark lab API payload', () => {
  it('reads the workspace object and refuses a fabricated review URL stand-in', () => {
    const lab = labFromPayload({
      lab: {
        cases: [],
        permalink: '/benchmarking?dataset=ds_v001',
        applyHistory: [],
      },
    });
    expect(lab.cases).toEqual([]);
    expect(lab.permalink).toBe('/benchmarking?dataset=ds_v001');
    expect(JSON.stringify(lab)).not.toContain('https://example.com/review');
  });

  it('rejects a payload with no cases array', () => {
    expect(() => labFromPayload({ lab: { permalink: '/benchmarking' } })).toThrow('missing cases');
  });
});
