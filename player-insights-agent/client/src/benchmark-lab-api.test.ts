import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyLabCandidate, labFromPayload } from './benchmark-lab-api';

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

describe('apply-candidate errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  it('surfaces decision.note when apply answers 503 without a top-level message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(503, {
            decision: { note: 'The production alias was not moved: permission denied.' },
            apply: { note: 'The production alias was not moved: permission denied.' },
            lab: { cases: [] },
          })
        )
      )
    );
    await expect(applyLabCandidate({ approver: 'approver@example.com' })).rejects.toThrow(
      'The production alias was not moved: permission denied.'
    );
  });

  it('surfaces apply.note when decision.note is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(503, {
            apply: { note: 'Guidance stayed cached after the alias failed.' },
            lab: { cases: [] },
          })
        )
      )
    );
    await expect(applyLabCandidate({ approver: 'approver@example.com' })).rejects.toThrow(
      'Guidance stayed cached after the alias failed.'
    );
  });
});
