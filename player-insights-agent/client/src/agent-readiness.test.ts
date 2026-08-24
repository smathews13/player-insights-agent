/**
 * That the readiness read always settles, so the Ask pill cannot sit on
 * "Checking agent" for the life of the page.
 *
 * WHY THIS IS TESTED AT THE MODULE RATHER THAN THROUGH A RENDER. The bug is not
 * a wrong verdict, it is the absence of one: `readPreflightOnce` memoises its
 * promise for the whole page load, so a metadata read that never lands leaves
 * every caller -- the pill and the tracked-table links -- awaiting a promise
 * that has nothing left to resolve it. `renderToStaticMarkup`, which the other
 * tests in this directory use, runs no effects and so cannot see a fetch at all.
 * The memo and the fetch are plain module state, so the rule is exercised for
 * real by hanging the route and advancing the clock.
 *
 * Each test re-imports the module because the memo is deliberately never
 * invalidated in the app: a shared one would make the second test read the first
 * test's answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_CHECK_TIMEOUT_MS } from './session-checks';

/** A body `isPreflightReport` accepts, carrying the check the pill reads. */
function reportBody(status: string) {
  return {
    checked_at: '2026-08-16T01:00:00.000Z',
    status: 'ok',
    checks: [{ id: 'agent-endpoint', status }],
    counts: { ok: 0, failed: 0, unverified: 0 },
    assumptions: [],
    source: 'app',
  };
}

/** A fresh module, so the page-scoped memo starts empty. */
async function loadReadiness() {
  vi.resetModules();
  return import('./agent-readiness');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the preflight read the Ask pill waits on', () => {
  it('settles on a verdict of "nobody answered" when the route never answers', async () => {
    vi.useFakeTimers();
    // Accepts the request and produces nothing, which is what a hung metadata
    // read looks like from the browser. Before the deadline this promise was
    // the pill's final state.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const { agentReadinessFrom, readPreflightOnce } = await loadReadiness();

    const pending = readPreflightOnce();
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_TIMEOUT_MS);
    const payload = await pending;

    // `unchecked`, not `unreachable`: nothing was learnt about the endpoint, and
    // a check that did not run is not a check that failed. What matters to the
    // reader is that it is not `checking`.
    expect(agentReadinessFrom(payload)).toBe('unchecked');
  });

  it('asks the route once and never wakes the serving endpoint', async () => {
    vi.useFakeTimers();
    const fetched = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetched);
    const { readPreflightOnce } = await loadReadiness();

    const first = readPreflightOnce();
    const second = readPreflightOnce();
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_TIMEOUT_MS);
    await Promise.all([first, second]);

    // One request, and it is the metadata route. A timeout that retried, or a
    // second caller that started its own read, would be a page load that pokes
    // the endpoint repeatedly to draw a pill.
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(String((fetched.mock.calls[0] as unknown[])[0])).toBe('/api/preflight');
  });

  it('settles when the route cannot be reached at all', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('the server is not answering'))));
    const { agentReadinessFrom, readPreflightOnce } = await loadReadiness();

    expect(agentReadinessFrom(await readPreflightOnce())).toBe('unchecked');
  });

  it('still reads the report when the route answers, deadline or no deadline', async () => {
    // The deadline must not have cost the good case. A 503 is included because
    // that is how the route reports an endpoint it could not invoke, and the
    // body is still a report saying so.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve(reportBody('failed')),
        } as unknown as Response)
      )
    );
    const { agentReadinessFrom, readPreflightOnce } = await loadReadiness();

    expect(agentReadinessFrom(await readPreflightOnce())).toBe('unreachable');
  });

  it('reports a reachable endpoint as ready', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(reportBody('ok')),
        } as unknown as Response)
      )
    );
    const { agentReadinessFrom, readPreflightOnce } = await loadReadiness();

    expect(agentReadinessFrom(await readPreflightOnce())).toBe('ready');
  });

  it('goes through the shared timeout helper rather than a bare fetch', async () => {
    // Structural, because the property is "this read has a deadline at all",
    // and a future edit that reverts to `fetch('/api/preflight')` would leave
    // every behavioural test above green except under fake timers. The identity
    // and session reads are held to the same rule in session-checks.test.ts.
    const source = await import('node:fs').then(({ readFileSync }) =>
      readFileSync(new URL('./agent-readiness.ts', import.meta.url), 'utf8')
    );

    expect(source).toContain('fetchWithTimeout(');
    expect(source).not.toMatch(/[^h]fetch\('\/api\/preflight'\)/);
  });
});
