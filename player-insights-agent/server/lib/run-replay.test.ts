import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLakebaseHealth, stopLakebaseWatchdog } from './lakebase-store';
import { FakeStore } from './__fixtures__/fake-run-store';
import { readReplay, replayBody } from './run-replay';
import type { LedgerRun } from './run-ledger';
import type { RunState } from './run-state';

function run(overrides: Partial<LedgerRun> = {}): LedgerRun {
  return {
    runId: 'run-1',
    userEmail: 'reader@example.com',
    conversationId: 'conv-1',
    turnId: 'turn-1',
    requestHash: 'hash-abc',
    idempotencyKeyHash: null,
    planFingerprint: null,
    state: 'SUCCEEDED' as RunState,
    deadlineAt: '2026-01-01T00:01:30Z',
    identityModeRequested: 'signed_in_user',
    identityModeEffective: 'signed_in_user',
    identityVerified: true,
    personaId: null,
    personaName: null,
    terminalCode: null,
    terminalMessageId: 'msg-1',
    traceId: 'tr-1',
    correlationId: 'req-deadbeef-0000-4000-8000-000000000001',
    fencingToken: 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    attempts: 1,
    ...overrides,
  };
}

let store: FakeStore;

beforeEach(() => {
  resetLakebaseHealth();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  store = new FakeStore();
  store.messages.push({
    id: 'msg-1',
    user_email: 'reader@example.com',
    response_json: { type: 'answer', takeaway: 'Weekly actives fell 4 percent.' },
  });
});

afterEach(() => {
  stopLakebaseWatchdog();
  vi.restoreAllMocks();
});

describe('replaying a run that answered', () => {
  it('serves the answer the first caller was served', async () => {
    const replay = await readReplay(store, run());

    expect(replay.kind).toBe('answer');
    expect(replay.kind === 'answer' && replay.body.takeaway).toBe('Weekly actives fell 4 percent.');
  });

  it('reads a jsonb column that comes back as text', async () => {
    // The column has been both, and a replay that returned the raw string
    // would put a JSON blob on screen where the answer goes.
    store.messages[0].response_json = JSON.stringify({ type: 'answer', takeaway: 'Stored as text.' });

    const replay = await readReplay(store, run());

    expect(replay.kind === 'answer' && replay.body.takeaway).toBe('Stored as text.');
  });

  it('will not serve another reader their answer', async () => {
    // `messages` carries no owner of its own, so an id-only read is how one
    // user's answer reaches another user's screen.
    const replay = await readReplay(store, run({ userEmail: 'someone.else@example.com' }));

    expect(replay.kind).toBe('missing');
  });
});

describe('replaying a run that did not answer', () => {
  it('hands back the code rather than an empty answer', async () => {
    const replay = await readReplay(
      store,
      run({ state: 'FAILED' as RunState, terminalCode: 'DEPENDENCY_UNAVAILABLE', terminalMessageId: null })
    );

    expect(replay.kind).toBe('failure');
    expect(replay.kind === 'failure' && replay.code).toBe('DEPENDENCY_UNAVAILABLE');
  });

  it('treats a run still in flight as having nothing to replay', async () => {
    const replay = await readReplay(store, run({ state: 'RUNNING' as RunState }));

    expect(replay.kind).toBe('failure');
    expect(replay.kind === 'failure' && replay.state).toBe('RUNNING');
  });
});

describe('when the answer a run names is not there', () => {
  it('says so rather than replaying nothing as an answer', async () => {
    const replay = await readReplay(store, run({ terminalMessageId: null }));

    expect(replay.kind).toBe('missing');
    expect(replay.kind === 'missing' && replay.detail).toContain('recorded no message');
  });

  it('says so when the row it names has gone', async () => {
    store.messages.length = 0;

    const replay = await readReplay(store, run());

    expect(replay.kind).toBe('missing');
  });

  it('says so when what was stored cannot be read back as an answer', async () => {
    store.messages[0].response_json = 'not json at all';

    const replay = await readReplay(store, run());

    expect(replay.kind).toBe('missing');
  });

  it('separates a store that is down from an answer that is gone', async () => {
    // Different responses. One is retryable and one never will be, and
    // collapsing them tells the reader to try again forever.
    store.failWith = 'Connection terminated unexpectedly';

    const replay = await readReplay(store, run());

    expect(replay.kind).toBe('unavailable');
  });
});

describe('what a replayed answer says about itself', () => {
  it('admits to being a replay, so nothing renders it as a fresh run', async () => {
    const replay = await readReplay(store, run());
    if (replay.kind !== 'answer') throw new Error('Expected an answer to replay');

    const body = replayBody(replay.body, run());

    expect(body.replayed).toBe(true);
    expect(body.replayedRunId).toBe('run-1');
    expect(body.takeaway).toBe('Weekly actives fell 4 percent.');
  });
});
