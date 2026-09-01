/**
 * That opening Ask PIA asks for each list exactly once, and asks for both at
 * the same time.
 *
 * BOTH CLAIMS FAIL SILENTLY, which is why they are the ones written down. A
 * duplicate request breaks nothing a reader can see -- it just doubles what it
 * costs to open the page. A serialised pair breaks nothing either; the rail
 * simply appears later than it needs to, and "later" is not a state anybody
 * files a bug about. Neither shows up in a rendered-markup test, and neither
 * could be observed at all from inside the page: this repository has no jsdom,
 * so effects never run.
 *
 * The concurrency assertion is the sharper of the two. It resolves nothing until
 * both requests have been issued, so a version of `loadInitialRail` that awaited
 * the first before starting the second would not merely be slower here -- it
 * would hang, and the test would fail rather than pass a little later.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { forgetRunLabelOverrides } from './run-header-labels';
import { loadInitialRail, readConversationList, readRunSummaries, startInitialRail } from './initial-rail';

const HOME = readFileSync(new URL('HomePage.tsx', import.meta.url), 'utf8');

const RUNS = [
  {
    id: 'run-2',
    conversation_id: 'conv-a',
    status: 'complete',
    created_at: '2026-08-17T10:00:00Z',
    duration_ms: 4200,
    rating: 4,
  },
  {
    id: 'run-1',
    conversation_id: 'conv-a',
    status: 'failed',
    created_at: '2026-08-17T09:00:00Z',
    duration_ms: 900,
    rating: null,
  },
];

const CONVERSATIONS = [{ id: 'conv-a', title: 'Active players by title', updated_at: '2026-08-17T10:00:00Z' }];

/** A response with no degradation headers, i.e. the ordinary case. */
function ok(body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name] ?? null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

afterEach(() => {
  forgetRunLabelOverrides();
  vi.unstubAllGlobals();
});

describe('each list is asked for once per load', () => {
  it('makes exactly one request to each route', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return Promise.resolve(ok(url === '/api/runs' ? RUNS : CONVERSATIONS));
    });

    await loadInitialRail();

    expect(calls.filter((url) => url === '/api/runs')).toHaveLength(1);
    expect(calls.filter((url) => url === '/api/conversations')).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('starts both before waiting for either', async () => {
    // The requests are held open until BOTH have been issued. A serialised
    // implementation deadlocks here rather than merely taking longer, so this
    // cannot pass by accident on a fast machine.
    const issued = new Set<string>();
    let release = () => {};
    const bothIssued = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal('fetch', async (url: string) => {
      issued.add(url);
      if (issued.size === 2) release();
      await bothIssued;
      return ok(url === '/api/runs' ? RUNS : CONVERSATIONS);
    });

    const rail = await loadInitialRail();
    expect(issued).toEqual(new Set(['/api/runs', '/api/conversations']));
    expect(rail.conversations).toHaveLength(1);
    expect(rail.runSummaries.size).toBe(1);
  });
});

describe('what the page is handed', () => {
  it('collapses the runs to the newest turn of each conversation', async () => {
    vi.stubGlobal('fetch', (url: string) => Promise.resolve(ok(url === '/api/runs' ? RUNS : CONVERSATIONS)));
    const rail = await loadInitialRail();
    // The 10:00 turn, not the 09:00 one, and its rating with it.
    expect(rail.runSummaries.get('conv-a')).toMatchObject({ status: 'complete', rating: 4 });
    expect(rail.availability).toEqual({ origin: 'stored', reason: null });
  });

  it('reads the store’s own header rather than counting rows', async () => {
    // An unreachable store answers with an empty array too, so a count cannot
    // tell "holds nothing" from "could not be read".
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(url === '/api/runs' ? ok([]) : ok([], { 'X-PIA-Storage': 'unavailable' }))
    );
    const rail = await loadInitialRail();
    expect(rail.availability.origin).toBe('unavailable');
    // Not an empty list: an empty list would be drawn as "no conversations yet".
    expect(rail.conversations).toEqual([]);
  });

  it('sends normalized owner/persona filters and reads server-computed matches', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return Promise.resolve(
        ok({
          conversations: CONVERSATIONS,
          matching_conversation_ids: ['conv-a'],
          persona_filter_rule: 'persisted rule',
        })
      );
    });
    const list = await readConversationList({
      owners: ['alice@example.com'],
      personaIds: ['finance'],
    });
    expect(calls).toEqual(['/api/conversations?owners=alice%40example.com&personas=finance']);
    expect(list.matchingConversationIds).toEqual(['conv-a']);
    expect(list.personaFilterRule).toBe('persisted rule');
  });
});

describe('one route failing does not cost the page the other', () => {
  it('keeps the conversations when the runs read throws', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      url === '/api/runs' ? Promise.reject(new Error('offline')) : Promise.resolve(ok(CONVERSATIONS))
    );
    const rail = await loadInitialRail();
    // No pills, and no stand-in ones -- but the rail still lists conversations.
    expect(rail.runSummaries.size).toBe(0);
    expect(rail.conversations).toHaveLength(1);
    expect(rail.availability.origin).toBe('stored');
  });

  it('reports an unreadable conversation list as unavailable, not as empty', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      url === '/api/runs' ? Promise.resolve(ok(RUNS)) : Promise.reject(new Error('offline'))
    );
    const rail = await loadInitialRail();
    expect(rail.conversations).toBeNull();
    expect(rail.availability).toEqual({ origin: 'unavailable', reason: 'storage_unavailable' });
    // And the half that did answer is still there.
    expect(rail.runSummaries.size).toBe(1);
  });

  it('never rejects, because both callers are render paths', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    await expect(loadInitialRail()).resolves.toMatchObject({ conversations: null });
  });
});

/**
 * THE ONE THAT COST SOMETHING VISIBLE, and the reason this file grew.
 *
 * `conversationLoading` is not a spinner on the rail. While it is true Ask PIA
 * hides the welcome screen, draws a "Loading conversation" card, and DISABLES THE
 * COMPOSER -- the reader cannot type their question, let alone send it. It was
 * cleared the moment the conversation list answered.
 *
 * Asking for both lists together made it wait for the slower of the two, because
 * one combined promise cannot resolve until both halves have. The run list is the
 * heavier read -- it joins messages to conversations and derives a status per row,
 * and a stale Lakebase connection makes it reconnect and try again -- and all it
 * feeds is the status pills on the rail. So a decoration on the rail could hold
 * the text box shut on the page every visit lands on.
 *
 * Both requests must still go out together; that is the whole point of the
 * module and the test above pins it. What must not happen is the page waiting on
 * both before it lets anybody type.
 */
describe('a slow run list does not hold the page shut', () => {
  it('answers the conversation list while the run list is still open', async () => {
    let runsIssued = false;
    vi.stubGlobal('fetch', (url: string) => {
      if (url === '/api/runs') {
        runsIssued = true;
        // The read that never lands, which is what a reconnecting store looks
        // like from here.
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(ok(CONVERSATIONS));
    });

    const reads = startInitialRail();
    // Raced rather than awaited, so a coupled version fails on the assertion
    // below instead of hanging until the suite's own timeout.
    const first = await Promise.race([
      reads.conversations.then(() => 'the conversations answered'),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting for the runs'), 50)),
    ]);

    expect(first).toBe('the conversations answered');
    expect(runsIssued, 'and both reads were still issued together').toBe(true);
    await expect(reads.conversations).resolves.toMatchObject({ availability: { origin: 'stored' } });
  });

  it('is the read Ask PIA clears its composer gate on', () => {
    // Asserted against the source because the gate lives in an effect, and this
    // suite has no jsdom to run one in. The claim is which of the two reads the
    // page stops waiting on -- not that a promise exists.
    expect(HOME, 'the page starts both reads and waits on them separately').toContain('startInitialRail()');
    expect(HOME, 'and not on one promise that needs both to have landed').not.toContain('loadInitialRail');
    expect(HOME, 'the gate is cleared by the conversation list').toMatch(
      /reads\.conversations\.then\([\s\S]{0,1200}?setConversationLoading\(false\)/
    );
    expect(HOME, 'and never by the run list').not.toMatch(
      /reads\.runSummaries\.then\([\s\S]{0,600}?setConversationLoading\(false\)/
    );
  });
});

describe('the re-read after a turn completes', () => {
  it('asks for the runs alone, once', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return Promise.resolve(ok(RUNS));
    });
    const summaries = await readRunSummaries();
    expect(calls).toEqual(['/api/runs']);
    expect(summaries.get('conv-a')?.status).toBe('complete');
  });

  it('answers with no pills rather than throwing when the route refuses', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 503 } as unknown as Response));
    await expect(readRunSummaries()).resolves.toEqual(new Map());
  });
});
