/**
 * That the Monitoring list is read once per range per session, and that
 * Refresh is the only thing that reads it again.
 *
 * WHY THIS IS TESTED AT THE MODULE RATHER THAN THROUGH A RENDER. The rule is
 * about how many times a fetch happens across several mounts, and
 * `renderToStaticMarkup` -- what every other Monitoring test uses -- runs no
 * effects at all, so it cannot see a fetch. The decision itself is deliberately
 * not in a component for exactly this reason: `claimAutoLoad` and
 * `loadMonitoringQuestions` are plain functions over a module-level latch, so
 * the rule can be exercised for real, by counting calls.
 *
 * The three failures below are the ones that are easy to ship and hard to
 * notice, because each of them still LOOKS right on screen:
 *
 *   - keying the automatic run on the store being empty rather than on a latch,
 *     which re-runs it forever on a deployment where the first run fails
 *   - claiming the run after the fetch rather than before, which lets two
 *     mounts in one tick both fire
 *   - keying the store on the computed `from`/`to` timestamps, which move
 *     every remount and would make every visit look like a new range
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MonitoringQuestionsPayload } from '../../shared/monitoring-contract';
import { NO_FILTERS } from './monitoring-filters';
import {
  abortMonitoringRequestsExcept,
  autoLoadMonitoringQuestions,
  autoLoadClaimed,
  claimAutoLoad,
  forgetMonitoringSession,
  loadMonitoringQuestions,
  monitoringRangeId,
  monitoringRequestId,
  monitoringQuestionsUrl,
  monitoringTabHref,
  recallQuestions,
  rememberMonitoringSearch,
} from './monitoring-session';

function payload(readAt = '2026-08-24T12:00:00.000Z'): MonitoringQuestionsPayload {
  return {
    readState: 'ok',
    readAt,
    summary: {
      questionsAsked: 1,
      userThreads: 1,
      completed: 1,
      partial: 0,
      refused: 0,
      failed: 0,
      ratedUp: 0,
      ratedTotal: 0,
      medianMs: null,
      timedCount: 0,
    },
    questions: [],
    people: [],
    tables: [],
    grantsResolution: 'ok',
    pagination: { pageSize: 50, total: 1, hasMore: false, nextCursor: null },
  };
}

function request(rangeId = '7d', from = 'a', to = 'b') {
  return { rangeId, from, to, filters: NO_FILTERS, cursor: '' };
}

interface Route {
  ok?: boolean;
  status?: number;
  body?: unknown;
  throws?: boolean;
}

function stubFetch(route: Route = {}) {
  const paths: string[] = [];
  const impl = vi.fn((input: string) => {
    paths.push(typeof input === 'string' ? input : String(input));
    if (route.throws) return Promise.reject(new Error('the server is not answering'));
    const body = route.body ?? payload();
    return Promise.resolve({
      ok: route.ok ?? true,
      status: route.status ?? 200,
      json: () => Promise.resolve(body),
    } as Response);
  });
  vi.stubGlobal('fetch', impl);
  return { paths, impl };
}

function listReads(paths: readonly string[]): number {
  return paths.filter((path) => path.startsWith('/api/monitoring/questions?')).length;
}

beforeEach(() => {
  forgetMonitoringSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the automatic run is taken once per range', () => {
  it('is claimed by the first caller and refused to every caller after', () => {
    expect(autoLoadClaimed('7d')).toBe(false);
    expect(claimAutoLoad('7d')).toBe(true);
    expect(claimAutoLoad('7d')).toBe(false);
    expect(claimAutoLoad('7d')).toBe(false);
    expect(autoLoadClaimed('7d')).toBe(true);
  });

  it('is claimed synchronously, so two mounts in one tick cannot both fire', () => {
    const both = [claimAutoLoad('7d'), claimAutoLoad('7d')];
    expect(both).toEqual([true, false]);
  });

  it('lets a different range take its own first read', () => {
    expect(claimAutoLoad('7d')).toBe(true);
    expect(claimAutoLoad('30d')).toBe(true);
    expect(claimAutoLoad('7d')).toBe(false);
  });

  it('stays claimed after a run that FAILED, so a bad read is not retried forever', async () => {
    const { paths } = stubFetch({ throws: true });
    expect(claimAutoLoad('7d')).toBe(true);
    const asked = request('7d', 'from', 'to');
    await loadMonitoringQuestions(asked);

    expect(listReads(paths)).toBe(1);
    expect(recallQuestions(monitoringRequestId(asked))).toBeNull();
    expect(claimAutoLoad('7d')).toBe(false);
  });

  it('is released only by forgetMonitoringSession, which is for tests and nothing else', () => {
    claimAutoLoad('7d');
    forgetMonitoringSession();
    expect(autoLoadClaimed('7d')).toBe(false);
    expect(recallQuestions('7d')).toBeNull();
  });
});

describe('what one read keeps, and what a later visit reuses', () => {
  it('asks the list once and stores the payload', async () => {
    const { paths } = stubFetch();
    const asked = request('7d', '2026-08-17T00:00:00.000Z', '2026-08-24T00:00:00.000Z');
    const body = await loadMonitoringQuestions(asked);

    expect(listReads(paths)).toBe(1);
    expect(paths[0]).toContain('/api/monitoring/questions?');
    expect(recallQuestions(monitoringRequestId(asked))).toEqual(body);
  });

  it('joins an in-flight read rather than starting a second one', async () => {
    const { paths } = stubFetch();
    const first = loadMonitoringQuestions(request());
    const second = loadMonitoringQuestions(request());
    await Promise.all([first, second]);

    expect(listReads(paths)).toBe(1);
  });

  it('re-reads when asked again, which is what Refresh does', async () => {
    const { paths } = stubFetch();
    await loadMonitoringQuestions(request());
    await loadMonitoringQuestions(request());
    expect(listReads(paths)).toBe(2);
  });

  it('fetches on first open, then returns from another tab without another request', async () => {
    const { paths } = stubFetch({ body: payload('2026-08-24T12:00:00.000Z') });
    const firstOpen = request('7d', '2026-08-17T12:00:00.000Z', '2026-08-24T12:00:00.000Z');
    const returnVisit = request('7d', '2026-08-17T12:05:00.000Z', '2026-08-24T12:05:00.000Z');

    await autoLoadMonitoringQuestions(firstOpen);
    const returningLoad = autoLoadMonitoringQuestions(returnVisit);

    expect(returningLoad).toBeNull();
    expect(listReads(paths)).toBe(1);
    expect(monitoringRequestId(returnVisit)).toBe(monitoringRequestId(firstOpen));
    expect(recallQuestions(monitoringRequestId(returnVisit))?.readAt).toBe('2026-08-24T12:00:00.000Z');
  });

  it('fetches intentionally when a filter changes', async () => {
    const { paths } = stubFetch();
    const initial = request();
    const filtered = { ...initial, filters: { ...NO_FILTERS, person: 'reader@example.test' } };

    await autoLoadMonitoringQuestions(initial);
    await autoLoadMonitoringQuestions(filtered);

    expect(listReads(paths)).toBe(2);
    expect(paths[1]).toContain('person=reader%40example.test');
  });

  it('invalidates retained Monitoring data when the app session changes', async () => {
    const { paths } = stubFetch();
    const initial = request();

    await autoLoadMonitoringQuestions(initial);
    forgetMonitoringSession();
    await autoLoadMonitoringQuestions(initial);

    expect(listReads(paths)).toBe(2);
  });

  it('aborts a stale range read and leaves it eligible for a later fresh load', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string, init?: RequestInit) => {
        const signal = init?.signal;
        if (!signal) throw new Error('Monitoring fetch did not receive an abort signal');
        signals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      })
    );
    const stale = request('7d', '2026-08-17T00:00:00.000Z', '2026-08-24T00:00:00.000Z');
    const current = request('30d', '2026-07-25T00:00:00.000Z', '2026-08-24T00:00:00.000Z');
    const staleId = monitoringRequestId(stale);
    claimAutoLoad(staleId);

    const staleRead = loadMonitoringQuestions(stale);
    abortMonitoringRequestsExcept(monitoringRequestId(current));

    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    await expect(staleRead).resolves.toBeNull();
    expect(recallQuestions(staleId)).toBeNull();
    expect(autoLoadClaimed(staleId)).toBe(false);
  });

  it('cannot commit a late response after a newer range wins', async () => {
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
    const stale = request('7d', '2026-08-17T00:00:00.000Z', '2026-08-24T00:00:00.000Z');
    const current = request('30d', '2026-07-25T00:00:00.000Z', '2026-08-24T00:00:00.000Z');

    const staleRead = autoLoadMonitoringQuestions(stale);
    const currentRead = autoLoadMonitoringQuestions(current);
    const resolveCurrent = resolvers[1];
    const resolveStale = resolvers[0];
    if (!resolveCurrent || !resolveStale) throw new Error('Both Monitoring reads did not start');
    resolveCurrent(
      new Response(JSON.stringify(payload('2026-08-24T12:05:00.000Z')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await currentRead;
    resolveStale(
      new Response(JSON.stringify(payload('2026-08-24T11:55:00.000Z')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await staleRead;

    expect(recallQuestions(monitoringRequestId(current))?.readAt).toBe('2026-08-24T12:05:00.000Z');
    expect(recallQuestions(monitoringRequestId(stale))).toBeNull();
  });

  it('treats a 403 body as an unavailable payload rather than as a thrown read', async () => {
    stubFetch({ ok: false, status: 403, body: { ...payload(), readState: 'ok' } });
    const asked = request();
    const body = await loadMonitoringQuestions(asked);
    expect(body?.readState).toBe('unavailable');
    expect(recallQuestions(monitoringRequestId(asked))?.readState).toBe('unavailable');
  });

  it('keeps the last successful page visible through a failed explicit refresh', async () => {
    const asked = request();
    stubFetch({ body: payload('2026-08-24T12:00:00.000Z') });
    await loadMonitoringQuestions(asked);
    vi.unstubAllGlobals();
    stubFetch({ throws: true });

    await loadMonitoringQuestions({ ...asked, to: '2026-08-24T13:00:00.000Z' });

    expect(recallQuestions(monitoringRequestId(asked))?.readAt).toBe('2026-08-24T12:00:00.000Z');
  });
});

describe('paged list request contracts', () => {
  it('keys range, filters, and cursor so none can reuse another result', () => {
    const base = request('7d', '2026-08-01', '2026-08-08');
    const filtered = { ...base, filters: { ...NO_FILTERS, outcome: 'failed' as const } };
    const paged = { ...filtered, cursor: 'opaque-next' };
    const moved = { ...base, from: '2026-08-02' };

    expect(new Set([base, filtered, paged, moved].map(monitoringRequestId))).toHaveLength(3);
    expect(monitoringRequestId(moved)).toBe(monitoringRequestId(base));
  });

  it('sends every active filter and the opaque cursor to the server', () => {
    const url = monitoringQuestionsUrl({
      ...request('30d', '2026-08-01', '2026-08-31'),
      cursor: 'opaque-next',
      filters: {
        person: 'reader@example.test',
        outcome: 'refused',
        feedback: 'down',
        table: 'main.player.gold',
        search: 'refund rate',
      },
    });
    const params = new URL(url, 'https://example.test').searchParams;
    expect(Object.fromEntries(params)).toMatchObject({
      cursor: 'opaque-next',
      person: 'reader@example.test',
      outcome: 'refused',
      feedback: 'down',
      table: 'main.player.gold',
      q: 'refund rate',
      limit: '50',
    });
  });

  it('makes one request for each distinct page or filter and deduplicates exact repeats', async () => {
    const { paths } = stubFetch();
    const first = request();
    const failed = { ...first, filters: { ...NO_FILTERS, outcome: 'failed' as const } };
    const next = { ...failed, cursor: 'opaque-next' };
    await Promise.all([loadMonitoringQuestions(first), loadMonitoringQuestions(first)]);
    await loadMonitoringQuestions(failed);
    await loadMonitoringQuestions(next);

    expect(listReads(paths)).toBe(3);
  });
});

describe('the range identity a remount must reuse', () => {
  it('is the word in the URL, not the computed timestamps', () => {
    expect(monitoringRangeId(new URLSearchParams())).toBe('7d');
    expect(monitoringRangeId(new URLSearchParams('range=24h'))).toBe('24h');
    expect(monitoringRangeId(new URLSearchParams('range=30d'))).toBe('30d');
    expect(monitoringRangeId(new URLSearchParams('range=all'))).toBe('all');
  });

  it('uses the safe default key for a retired custom URL', () => {
    expect(monitoringRangeId(new URLSearchParams('range=custom&from=2026-01-01&to=2026-01-31'))).toBe('7d');
  });
});

describe('the Monitoring tab restores its view controls', () => {
  it('keeps range and filters but does not reopen detail panels', () => {
    rememberMonitoringSearch(
      '?range=30d&person=reader%40example.test&outcome=failed&feedback=down&table=main.gold.fact&q=refund&question=q1&who=reader'
    );

    expect(monitoringTabHref()).toBe(
      '/monitoring?range=30d&person=reader%40example.test&outcome=failed&feedback=down&table=main.gold.fact&q=refund'
    );
  });

  it('clears the restored view with the authenticated app session', () => {
    rememberMonitoringSearch('?range=all&outcome=refused');
    forgetMonitoringSession();
    expect(monitoringTabHref()).toBe('/monitoring');
  });
});

/**
 * The page through this mechanism, asserted on the source.
 *
 * Structural because the alternative is a render, and a render runs no effects
 * here. What this is really guarding is the regression that produced this
 * module: a useEffect that fetched the list on every mount.
 */
describe('the page no longer fetches the list itself', () => {
  const source = readFileSync(fileURLToPath(new URL('./MonitoringPage.tsx', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

  it('reads the list through useMonitoringQuestions', () => {
    expect(source).toContain('useMonitoringQuestions(');
    expect(source).toContain('rangeLabel(searchParams)');
    expect(source).toContain('loading: loading && !payload');
  });

  it('does not fetch /api/monitoring/questions itself', () => {
    expect(source).not.toContain('/api/monitoring/questions?');
  });

  it('still fetches a single open question and a person panel, which are not the list', () => {
    expect(source).toContain('questionDetailUrl(');
    expect(source).toContain('personDetailUrl(');
  });
});
