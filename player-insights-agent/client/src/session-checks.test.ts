/**
 * That the checks run themselves exactly once per session, and that Refresh is
 * the only thing that runs them again.
 *
 * WHY THIS IS TESTED AT THE MODULE RATHER THAN THROUGH A RENDER. The rule is
 * about how many times a fetch happens across several mounts of two different
 * pages, and `renderToStaticMarkup` -- what every other test in this directory
 * uses -- runs no effects at all, so it cannot see a fetch. The decision itself
 * is deliberately not in a component for exactly this reason: `claimAutoCheck`
 * and `runSessionChecks` are plain functions over a module-level latch, so the
 * rule can be exercised for real, by counting calls, instead of by asserting the
 * shape of the source that is supposed to obey it.
 *
 * The three failures below are the ones that are easy to ship and hard to notice,
 * because each of them still LOOKS right on screen:
 *
 *   - keying the automatic run on the store being empty rather than on a latch,
 *     which re-runs it forever on a deployment where the first run fails
 *   - claiming the run after the fetch rather than before, which lets two mounts
 *     in one tick both fire
 *   - forgetting that a failed run has still been taken
 *
 * The page wiring is asserted separately, structurally, at the bottom: that both
 * pages go through this module and neither has kept a fetch of its own.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { autoCheckClaimed, claimAutoCheck, forgetChecks, recallChecks, rememberChecks } from './check-session';
import {
  beginConnectionMutation,
  commitConnectionAddition,
  commitConnectionDeletion,
  reloadSessionSettings,
  resetSessionChecks,
  runSessionChecks,
  SESSION_CHECK_TIMEOUT_MS,
} from './session-checks';

/** A settings payload with just enough on it to be stored and read back. */
function settingsBody(checkedAt = '2026-08-16T01:00:00.000Z') {
  return { resources: [], drift: [], status: 'ok', checkedAt, checks: [] };
}

/** A body `isPreflightReport` accepts, which is what the runner insists on. */
function reportBody(checkedAt = '2026-08-16T01:00:00.000Z') {
  return {
    checked_at: checkedAt,
    status: 'ok',
    checks: [],
    counts: { ok: 0, failed: 0, unverified: 0 },
    assumptions: [],
    source: 'app',
  };
}

interface Route {
  ok?: boolean;
  status?: number;
  body?: unknown;
  /** Reject the fetch itself, as an unreachable server does. */
  throws?: boolean;
  /** Accept the request but never produce a response. */
  hangs?: boolean;
}

/**
 * A fetch that records every path it was asked for.
 *
 * Returned rather than assigned to a variable the test then has to remember to
 * reset: the paths array IS the assertion, and every test below counts entries in
 * it rather than trusting a spy's call order.
 */
function stubFetch(routes: Record<string, Route> = {}) {
  const paths: string[] = [];
  const impl = vi.fn((input: string) => {
    paths.push(input);
    const route = routes[input] ?? {};
    if (route.throws) return Promise.reject(new Error('the server is not answering'));
    if (route.hangs) return new Promise<Response>(() => undefined);
    const body = route.body ?? (input === '/api/settings' ? settingsBody() : reportBody());
    return Promise.resolve({
      ok: route.ok ?? true,
      status: route.status ?? 200,
      json: () => Promise.resolve(body),
    } as unknown as Response);
  });
  vi.stubGlobal('fetch', impl);
  return { paths, impl };
}

/** How many times the expensive pair was asked for. */
function runs(paths: readonly string[]): number {
  return paths.filter((path) => path === '/api/preflight').length;
}

beforeEach(() => {
  forgetChecks();
  resetSessionChecks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the automatic run is taken once and only once', () => {
  it('is claimed by the first caller and refused to every caller after', () => {
    // The whole mechanism, in three lines. Every case below is a consequence of
    // this being a latch rather than a question about the store.
    expect(autoCheckClaimed()).toBe(false);
    expect(claimAutoCheck()).toBe(true);
    expect(claimAutoCheck()).toBe(false);
    expect(claimAutoCheck()).toBe(false);
    expect(autoCheckClaimed()).toBe(true);
  });

  it('is claimed synchronously, so two mounts in one tick cannot both fire', () => {
    // React's development double-invocation and two pages mounting together are
    // both this shape. If the claim were taken after the fetch resolved, both of
    // these would read `false` and both would run.
    const both = [claimAutoCheck(), claimAutoCheck()];
    expect(both).toEqual([true, false]);
  });

  it('stays claimed after a run that FAILED, so a bad deployment is not retried forever', async () => {
    // THE ONE THAT KEYING ON THE STORE GETS WRONG. A run whose fetches both fail
    // leaves nothing worth remembering, so an implementation asking "is the store
    // empty?" would run again on the next visit, and the one after, paying for
    // the expensive pair on every navigation with no button pressed.
    const { paths } = stubFetch({
      '/api/settings': { throws: true },
      '/api/preflight': { throws: true },
    });
    expect(claimAutoCheck()).toBe(true);
    await runSessionChecks();

    expect(runs(paths)).toBe(1);
    // Nothing usable was stored, and the claim is spent anyway.
    expect(recallChecks()?.settings).toBeNull();
    expect(claimAutoCheck()).toBe(false);
  });

  it('is released only by forgetChecks, which is for tests and nothing else', () => {
    claimAutoCheck();
    forgetChecks();
    expect(autoCheckClaimed()).toBe(false);
    // Both halves. A reset that emptied the store and left the latch claimed
    // would silently test the second visit while appearing to test the first.
    expect(recallChecks()).toBeNull();
  });
});

describe('what one run reads, and what it keeps', () => {
  it('asks both routes once and stores them as one object', async () => {
    const { paths } = stubFetch();
    await runSessionChecks();

    expect(paths.filter((path) => path === '/api/settings')).toHaveLength(1);
    expect(paths.filter((path) => path === '/api/preflight')).toHaveLength(1);
    const stored = recallChecks();
    expect(stored?.settings).not.toBeNull();
    expect(stored?.report).not.toBeNull();
    expect(stored?.error).toBe('');
  });

  it('caches the automatic MLflow result for the session and refreshes it only on request', async () => {
    const mlflow = {
      id: 'experiment-id',
      kind: 'observability',
      name: 'e1',
      label: 'MLflow experiment',
      status: 'ok',
      detail: 'Read as the application.',
      checked_with: 'GET experiment',
      duration_ms: 1,
      error: '',
      remedy: null,
    };
    const { paths } = stubFetch({
      '/api/settings': { body: { ...settingsBody(), checks: [mlflow] } },
    });

    expect(claimAutoCheck()).toBe(true);
    await runSessionChecks();
    expect(recallChecks()?.settings?.checks).toContainEqual(mlflow);

    // A second page reads the remembered result and cannot claim another run.
    expect(claimAutoCheck()).toBe(false);
    expect(paths.filter((path) => path === '/api/settings')).toHaveLength(1);

    // Refresh invokes the same canonical run and replaces the cache.
    await runSessionChecks();
    expect(paths.filter((path) => path === '/api/settings')).toHaveLength(2);
    expect(recallChecks()?.settings?.checks).toContainEqual(mlflow);
  });

  it('publishes settings evidence while preflight is still pending', async () => {
    let resolvePreflight!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) => {
        if (input === '/api/settings') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(settingsBody()),
          } as Response);
        }
        return new Promise<Response>((resolve) => {
          resolvePreflight = resolve;
        });
      })
    );

    const run = runSessionChecks();
    await vi.waitFor(() => expect(recallChecks()?.settings).not.toBeNull());
    expect(recallChecks()?.load).toEqual({ firstLoad: true, settings: 'ready', report: 'pending' });

    resolvePreflight({
      ok: true,
      status: 200,
      json: () => Promise.resolve(reportBody()),
    } as Response);
    await run;
    expect(recallChecks()?.load).toEqual({ firstLoad: false, settings: 'ready', report: 'ready' });
  });

  it('does not let a cancelled stale run repopulate the session', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve);
          })
      )
    );
    const run = runSessionChecks();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resetSessionChecks();
    forgetChecks();
    resolvers[0]({ ok: true, status: 200, json: () => Promise.resolve(settingsBody()) } as Response);
    resolvers[1]({ ok: true, status: 200, json: () => Promise.resolve(reportBody()) } as Response);
    await run;
    expect(recallChecks()).toBeNull();
  });

  it('drops a second request while the first is still in flight', async () => {
    // A second press cannot race the first: both land on the same store, and the
    // later answer has been able to arrive first.
    const { paths } = stubFetch();
    await Promise.all([runSessionChecks(), runSessionChecks(), runSessionChecks()]);
    expect(runs(paths)).toBe(1);
  });

  it('re-runs on request, which is what Refresh is now for', async () => {
    const { paths } = stubFetch();
    await runSessionChecks();
    await runSessionChecks();
    expect(runs(paths)).toBe(2);
  });

  it('keeps the half that answered when the other half fails', async () => {
    // A failed refresh must not turn into a page that has lost the results it
    // did have. The old answer stays up, under the sentence saying why.
    const { impl } = stubFetch();
    await runSessionChecks();
    const first = recallChecks()?.report;
    expect(first).not.toBeNull();

    impl.mockClear();
    vi.unstubAllGlobals();
    stubFetch({ '/api/preflight': { throws: true } });
    await runSessionChecks();

    const after = recallChecks();
    expect(after?.settings).not.toBeNull();
    expect(after?.report).toEqual(first);
    expect(after?.error).toContain('The dependency checks could not be run');
  });

  it('treats a body that is not a report as a failure of that read', async () => {
    // A 503 with a real report body is an ANSWER about a blocked dependency and
    // is kept. A body that is not a report at all -- the app mid-deploy serving
    // an error page -- is not, and must not be stored as a run.
    stubFetch({ '/api/preflight': { status: 503, ok: false, body: { detail: 'nope' } } });
    await runSessionChecks();
    expect(recallChecks()?.report).toBeNull();
    expect(recallChecks()?.error).toContain('not with a dependency report');
  });

  it('says what could not be read without claiming nothing is reachable', async () => {
    stubFetch({
      '/api/settings': { throws: true },
      '/api/preflight': { throws: true },
    });
    await runSessionChecks();
    const said = recallChecks()?.error ?? '';
    expect(said).toContain('still unchecked');
    expect(said).not.toMatch(/unreachable|nothing is reachable/i);
  });

  it('finishes when both routes accept the request and never answer', async () => {
    vi.useFakeTimers();
    stubFetch({
      '/api/settings': { hangs: true },
      '/api/preflight': { hangs: true },
    });

    const run = runSessionChecks();
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_TIMEOUT_MS);
    await run;

    expect(recallChecks()?.error).toContain(`within ${SESSION_CHECK_TIMEOUT_MS} ms`);
  });
});

describe('a write re-reads the configuration and nothing else', () => {
  it('does not re-probe every dependency to learn what a save already told it', async () => {
    const { paths } = stubFetch();
    await runSessionChecks();
    const before = runs(paths);

    expect(await reloadSessionSettings()).toBe('');
    // Settings again, preflight not.
    expect(paths.filter((path) => path === '/api/settings')).toHaveLength(2);
    expect(runs(paths)).toBe(before);
  });

  it('keeps the report it already had, rather than blanking the rows', async () => {
    stubFetch();
    await runSessionChecks();
    const report = recallChecks()?.report;
    await reloadSessionSettings();
    expect(recallChecks()?.report).toEqual(report);
  });

  it('reports a refusal instead of throwing into a render path', async () => {
    stubFetch({ '/api/settings': { ok: false, status: 500 } });
    const said = await reloadSessionSettings();
    expect(said).toContain('could not read its own configuration');
    expect(said).toContain('Nothing below is current');
  });
});

describe('a confirmed connection delete fences stale settings', () => {
  const connection = {
    connection: {
      id: 'roster-table',
      label: 'Title roster',
      kind: 'unity-catalog',
      value: 'analytics.players.roster',
      state: 'declared',
      origin: 'app',
      createdAt: '2026-08-31T12:00:00.000Z',
      createdBy: 'analyst@example.invalid',
      changedAt: '2026-08-31T12:00:00.000Z',
      changedBy: 'analyst@example.invalid',
    },
    impact: { headline: 'Delete it.', consequences: [], recoverable: false },
  };

  function withConnection() {
    return { ...settingsBody(), connections: [connection] };
  }

  it('adds a confirmed table to the session cache before a tab can remount', () => {
    rememberChecks({
      settings: { ...settingsBody(), connections: [] } as never,
      report: reportBody() as never,
      error: '',
    });
    beginConnectionMutation();
    commitConnectionAddition({
      ...connection,
      connection: { ...connection.connection, id: 'new-table', resourceType: 'table' },
    } as never);
    expect(recallChecks()?.settings?.connections?.map((entry) => entry.connection.id)).toEqual(['new-table']);
  });

  it('removes the row from the session cache before a tab can remount', () => {
    rememberChecks({ settings: withConnection() as never, report: reportBody() as never, error: '' });
    beginConnectionMutation();
    commitConnectionDeletion(['roster-table']);
    expect(recallChecks()?.settings?.connections).toEqual([]);
  });

  it('rejects a late list response that started before the delete', async () => {
    let resolveSettings!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) => {
        if (input === '/api/settings') {
          return new Promise<Response>((resolve) => {
            resolveSettings = resolve;
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(reportBody()) } as Response);
      })
    );
    rememberChecks({ settings: withConnection() as never, report: reportBody() as never, error: '' });
    const refresh = runSessionChecks();
    await vi.waitFor(() => expect(resolveSettings).toBeTypeOf('function'));

    beginConnectionMutation();
    commitConnectionDeletion(['roster-table']);
    resolveSettings({
      ok: true,
      status: 200,
      json: () => Promise.resolve(withConnection()),
    } as Response);
    await refresh;

    expect(recallChecks()?.settings?.connections).toEqual([]);
  });

  it('lets the newest post-delete revalidation win over an older overlapping list', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve);
          })
      )
    );
    rememberChecks({ settings: withConnection() as never, report: null, error: '' });
    const stale = reloadSessionSettings();
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    beginConnectionMutation();
    commitConnectionDeletion(['roster-table']);
    const current = reloadSessionSettings();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));

    resolvers[1]({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ...settingsBody(), connections: [] }),
    } as Response);
    await current;
    resolvers[0]({ ok: true, status: 200, json: () => Promise.resolve(withConnection()) } as Response);
    await stale;

    expect(recallChecks()?.settings?.connections).toEqual([]);
  });
});

/**
 * Both pages through one mechanism, asserted on the source.
 *
 * Structural because the alternative is a render, and a render runs no effects
 * here. What this is really guarding is the regression that produced this module:
 * two pages, each with its own idea of when to fetch, drifting apart until one
 * re-probed on every navigation and the other never probed at all.
 */
describe('neither page kept a fetch of its own', () => {
  const source = (name: string) =>
    readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ');

  for (const page of ['ConnectionsPage.tsx', 'ArchitecturePage.tsx']) {
    it(`${page} reads the checks through useSessionChecks`, () => {
      expect(source(page)).toContain('useSessionChecks()');
    });

    it(`${page} does not fetch /api/preflight or /api/settings itself`, () => {
      const text = source(page);
      expect(text).not.toContain("fetch('/api/preflight'");
      expect(text).not.toContain("fetch('/api/settings')");
    });
  }

  it('leaves Architecture its own cheap read, which is not a check', () => {
    // `/api/architecture` costs the app container's own configuration and no
    // round trip to the workspace. It was never the expensive half and is not
    // what this module governs.
    const architecture = source('ArchitecturePage.tsx');
    expect(architecture).toContain('fetchWithTimeout(');
    expect(architecture).toContain("'/api/architecture'");
  });

  it('no longer wires Connections to usePreflight, which fetched on every mount', () => {
    expect(source('ConnectionsPage.tsx')).not.toContain('usePreflight');
  });
});
