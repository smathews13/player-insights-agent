/**
 * That each Ops block is read once per session (cost once per range), and that
 * Refresh is the only thing that reads it again.
 *
 * WHY THIS IS TESTED AT THE MODULE RATHER THAN THROUGH A RENDER. The rule is
 * about how many times a fetch happens across several mounts, and
 * `renderToStaticMarkup` -- what every other Ops test uses -- runs no effects
 * at all, so it cannot see a fetch. The decision itself is deliberately not in
 * a component for exactly this reason: `claimOpsAutoLoad` and `loadOpsBlock`
 * are plain functions over a module-level latch, so the rule can be exercised
 * for real, by counting calls.
 *
 * The four failures below are the ones that are easy to ship and hard to
 * notice, because each of them still LOOKS right on screen:
 *
 *   - keying the automatic run on the store being empty rather than on a latch,
 *     which re-runs it forever on a deployment where the first run fails
 *   - claiming the run after the fetch rather than before, which lets two
 *     mounts in one tick both fire
 *   - keying cost on the computed `from`/`to` timestamps, which move every
 *     remount and would make every visit look like a new range
 *   - leaving the fetch in the page's own `useState`, which is what made Ops
 *     reload on every tab click
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkAllHealthResources,
  claimOpsAutoLoad,
  forgetOpsSession,
  loadOpsBlock,
  opsAutoLoadClaimed,
  opsBlockKey,
  recallOpsBlock,
} from './ops-session';

function stubFetch(route: { ok?: boolean; status?: number; body?: unknown; throws?: boolean } = {}) {
  const paths: string[] = [];
  const impl = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    paths.push(url);
    if (route.throws) return Promise.reject(new Error('the server is not answering'));
    return Promise.resolve({
      ok: route.ok ?? true,
      status: route.status ?? 200,
      json: () => Promise.resolve(route.body ?? { readAt: '2026-08-25T12:00:00.000Z' }),
    } as Response);
  });
  vi.stubGlobal('fetch', impl);
  return { paths, impl };
}

function opsReads(paths: readonly string[], prefix: string): number {
  return paths.filter((path) => path === prefix || path.startsWith(`${prefix}?`)).length;
}

beforeEach(() => {
  forgetOpsSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the automatic run is taken once per block', () => {
  it('is claimed by the first caller and refused to every caller after', () => {
    expect(opsAutoLoadClaimed('/api/ops/health')).toBe(false);
    expect(claimOpsAutoLoad('/api/ops/health')).toBe(true);
    expect(claimOpsAutoLoad('/api/ops/health')).toBe(false);
    expect(claimOpsAutoLoad('/api/ops/health')).toBe(false);
    expect(opsAutoLoadClaimed('/api/ops/health')).toBe(true);
  });

  it('is claimed synchronously, so two mounts in one tick cannot both fire', () => {
    const both = [claimOpsAutoLoad('/api/ops/health'), claimOpsAutoLoad('/api/ops/health')];
    expect(both).toEqual([true, false]);
  });

  it('lets each block take its own first read', () => {
    expect(claimOpsAutoLoad('/api/ops/health')).toBe(true);
    expect(claimOpsAutoLoad('/api/ops/cost:current-month:2026-09')).toBe(true);
    expect(claimOpsAutoLoad('/api/ops/traffic:current-month:2026-09')).toBe(true);
    expect(claimOpsAutoLoad('/api/ops/latency:current-month:2026-09')).toBe(true);
    expect(claimOpsAutoLoad('/api/ops/health')).toBe(false);
  });

  it('lets a new calendar month take its own first read', () => {
    expect(claimOpsAutoLoad(opsBlockKey('/api/ops/cost', 'current-month:2026-09'))).toBe(true);
    expect(claimOpsAutoLoad(opsBlockKey('/api/ops/cost', 'current-month:2026-10'))).toBe(true);
    expect(claimOpsAutoLoad(opsBlockKey('/api/ops/cost', 'current-month:2026-09'))).toBe(false);
  });

  it('stays claimed after a run that FAILED, so a bad read is not retried forever', async () => {
    const { paths } = stubFetch({ throws: true });
    const key = '/api/ops/cost:7d';
    expect(claimOpsAutoLoad(key)).toBe(true);
    await loadOpsBlock(key, '/api/ops/cost?from=a&to=b');

    expect(opsReads(paths, '/api/ops/cost')).toBe(1);
    expect(recallOpsBlock(key)).toEqual({ data: null, failed: 'the server is not answering' });
    expect(claimOpsAutoLoad(key)).toBe(false);
  });

  it('is released only by forgetOpsSession, which is for tests and nothing else', () => {
    claimOpsAutoLoad('/api/ops/health');
    forgetOpsSession();
    expect(opsAutoLoadClaimed('/api/ops/health')).toBe(false);
    expect(recallOpsBlock('/api/ops/health')).toBeNull();
  });
});

describe('the first Ops visit fetches; a later visit does not', () => {
  it('asks each block once and stores the payload', async () => {
    const { paths } = stubFetch({ body: { ok: true } });
    const body = await loadOpsBlock('/api/ops/health', '/api/ops/health');

    expect(opsReads(paths, '/api/ops/health')).toBe(1);
    expect(recallOpsBlock('/api/ops/health')).toEqual(body);
    expect(body).toEqual({ data: { ok: true }, failed: '' });
  });

  it('does not fetch again when the second visit finds the latch already taken', async () => {
    const { paths } = stubFetch({ body: { ok: true } });
    expect(claimOpsAutoLoad('/api/ops/health')).toBe(true);
    await loadOpsBlock('/api/ops/health', '/api/ops/health');

    expect(claimOpsAutoLoad('/api/ops/health')).toBe(false);
    expect(opsReads(paths, '/api/ops/health')).toBe(1);
    expect(recallOpsBlock('/api/ops/health')?.data).toEqual({ ok: true });
  });

  it('joins an in-flight read rather than starting a second one', async () => {
    const { paths } = stubFetch();
    const first = loadOpsBlock('/api/ops/traffic', '/api/ops/traffic');
    const second = loadOpsBlock('/api/ops/traffic', '/api/ops/traffic');
    await Promise.all([first, second]);

    expect(opsReads(paths, '/api/ops/traffic')).toBe(1);
  });

  it('re-reads when asked again, which is what Refresh does', async () => {
    const { paths } = stubFetch();
    await loadOpsBlock('/api/ops/latency', '/api/ops/latency');
    await loadOpsBlock('/api/ops/latency', '/api/ops/latency');
    expect(opsReads(paths, '/api/ops/latency')).toBe(2);
  });

  it('keeps the previous payload when a refresh fails', async () => {
    stubFetch({ body: { tiles: 1 } });
    await loadOpsBlock('/api/ops/cost:7d', '/api/ops/cost?from=a&to=b');
    vi.unstubAllGlobals();
    stubFetch({ throws: true });
    const again = await loadOpsBlock('/api/ops/cost:7d', '/api/ops/cost?from=a&to=b');

    expect(again).toEqual({ data: { tiles: 1 }, failed: 'the server is not answering' });
  });
});

describe('the current-month identity a remount must reuse', () => {
  it('keeps live health unkeyed and keys retrospective reads by month', () => {
    expect(opsBlockKey('/api/ops/health')).toBe('/api/ops/health');
    expect(opsBlockKey('/api/ops/cost', 'current-month:2026-09')).toBe('/api/ops/cost:current-month:2026-09');
  });
});

describe('the manual Health check', () => {
  it('POSTs the force endpoint while normal Refresh remains a GET', async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET');
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ checkedAt: methods.length === 1 ? 'old' : 'fresh' }),
        } as Response);
      })
    );
    await loadOpsBlock('/api/ops/health', '/api/ops/health');
    await checkAllHealthResources('/api/ops/health', '/api/ops/health/check');
    await loadOpsBlock('/api/ops/health', '/api/ops/health');
    expect(methods).toEqual(['GET', 'POST', 'GET']);
    expect(recallOpsBlock<{ checkedAt: string }>('/api/ops/health')?.data?.checkedAt).toBe('fresh');
  });

  it('deduplicates a double press into one request', async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    vi.stubGlobal('fetch', fetcher);
    const first = checkAllHealthResources('/api/ops/health', '/api/ops/health/check');
    const second = checkAllHealthResources('/api/ops/health', '/api/ops/health/check');
    expect(fetcher).toHaveBeenCalledTimes(1);
    release({ ok: true, status: 200, json: () => Promise.resolve({ checkedAt: 'fresh' }) } as Response);
    await Promise.all([first, second]);
  });

  it('keeps old rows on a total failure', async () => {
    stubFetch({ body: { checkedAt: 'old', dependencies: [{ id: 'warehouse' }] } });
    await loadOpsBlock('/api/ops/health', '/api/ops/health');
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ detail: 'The previous results are unchanged; try again.' }),
        } as Response)
      )
    );
    const result = await checkAllHealthResources('/api/ops/health', '/api/ops/health/check');
    expect(result.failed).toContain('previous results are unchanged');
    expect(recallOpsBlock<{ checkedAt: string }>('/api/ops/health')?.data?.checkedAt).toBe('old');
  });

  it('fences an older normal response from overwriting a newer forced result', async () => {
    let finishGet!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ checkedAt: 'fresh' }),
          } as Response);
        }
        return new Promise<Response>((resolve) => {
          finishGet = resolve;
        });
      })
    );
    const oldRead = loadOpsBlock('/api/ops/health', '/api/ops/health');
    await checkAllHealthResources('/api/ops/health', '/api/ops/health/check');
    finishGet({ ok: true, status: 200, json: () => Promise.resolve({ checkedAt: 'old' }) } as Response);
    await oldRead;
    expect(recallOpsBlock<{ checkedAt: string }>('/api/ops/health')?.data?.checkedAt).toBe('fresh');
  });
});

/**
 * The page through this mechanism, asserted on the source.
 *
 * Structural because the alternative is a render, and a render runs no effects
 * here. What this is really guarding is the regression that produced this
 * module: a useEffect that fetched every block on every mount.
 */
describe('the page no longer fetches the blocks itself', () => {
  const source = readFileSync(fileURLToPath(new URL('./OpsPage.tsx', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

  it('reads each block through useOpsBlock', () => {
    expect(source).toContain('useOpsBlock<OpsHealthPayload>');
    expect(source).toContain('useOpsBlock<OpsCostPayload>');
    expect(source).toContain('useOpsBlock<OpsTrafficPayload>');
    expect(source).toContain('useOpsBlock<OpsLatencyPayload>');
    expect(source).toContain('opsCurrentMonthKey(openedAt)');
  });

  it('does not fetch /api/ops itself', () => {
    expect(source).not.toContain('fetch(`${path}${search}`');
    expect(source).not.toMatch(/fetch\(['`]\/api\/ops\//);
  });
});
