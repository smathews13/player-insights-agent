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
import {
  autoLoadClaimed,
  claimAutoLoad,
  forgetMonitoringSession,
  loadMonitoringQuestions,
  monitoringRangeId,
  recallQuestions,
} from './monitoring-session';

function payload(readAt = '2026-08-24T12:00:00.000Z'): MonitoringQuestionsPayload {
  return {
    readState: 'ok',
    readAt,
    summary: {
      questionsAsked: 1,
      peopleAsking: 1,
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
  };
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
    await loadMonitoringQuestions('7d', 'from', 'to');

    expect(listReads(paths)).toBe(1);
    expect(recallQuestions('7d')).toBeNull();
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
    const body = await loadMonitoringQuestions('7d', '2026-08-17T00:00:00.000Z', '2026-08-24T00:00:00.000Z');

    expect(listReads(paths)).toBe(1);
    expect(paths[0]).toContain('/api/monitoring/questions?');
    expect(recallQuestions('7d')).toEqual(body);
  });

  it('joins an in-flight read rather than starting a second one', async () => {
    const { paths } = stubFetch();
    const first = loadMonitoringQuestions('7d', 'a', 'b');
    const second = loadMonitoringQuestions('7d', 'a', 'b');
    await Promise.all([first, second]);

    expect(listReads(paths)).toBe(1);
  });

  it('re-reads when asked again, which is what Refresh does', async () => {
    const { paths } = stubFetch();
    await loadMonitoringQuestions('7d', 'a', 'b');
    await loadMonitoringQuestions('7d', 'a', 'b');
    expect(listReads(paths)).toBe(2);
  });

  it('treats a 403 body as an unavailable payload rather than as a thrown read', async () => {
    stubFetch({ ok: false, status: 403, body: { ...payload(), readState: 'ok' } });
    const body = await loadMonitoringQuestions('7d', 'a', 'b');
    expect(body?.readState).toBe('unavailable');
    expect(recallQuestions('7d')?.readState).toBe('unavailable');
  });
});

describe('the range identity a remount must reuse', () => {
  it('is the word in the URL, not the computed timestamps', () => {
    expect(monitoringRangeId(new URLSearchParams())).toBe('7d');
    expect(monitoringRangeId(new URLSearchParams('range=24h'))).toBe('24h');
    expect(monitoringRangeId(new URLSearchParams('range=30d'))).toBe('30d');
    expect(monitoringRangeId(new URLSearchParams('range=all'))).toBe('all');
  });

  it('keeps a custom pair as one key so the same typed window is one question', () => {
    expect(monitoringRangeId(new URLSearchParams('range=custom&from=2026-01-01&to=2026-01-31'))).toBe(
      'custom:2026-01-01:2026-01-31'
    );
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
  });

  it('does not fetch /api/monitoring/questions itself', () => {
    expect(source).not.toContain('/api/monitoring/questions?');
  });

  it('still fetches a single open question and a person panel, which are not the list', () => {
    expect(source).toContain('/api/monitoring/questions/${');
    expect(source).toContain('/api/monitoring/people/');
  });
});
