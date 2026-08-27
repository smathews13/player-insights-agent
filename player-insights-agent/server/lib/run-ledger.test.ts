import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lakebaseHealth, resetLakebaseHealth, stopLakebaseWatchdog } from './lakebase-store';
import {
  acquireLease,
  cancelAllExecutingRuns,
  cancelOwnedRun,
  completeAttempt,
  createOrGetRun,
  heartbeat,
  idempotencyConflict,
  readRun,
  recordAttempt,
  transition,
  type LedgerRun,
  type NewRun,
} from './run-ledger';
import { FakeStore, type Row } from './__fixtures__/fake-run-store';
import { EXECUTING_STATES, TERMINAL_STATES } from './run-state';

function newRun(overrides: Partial<NewRun> = {}): NewRun {
  return {
    runId: `run-${Math.random().toString(16).slice(2)}`,
    userEmail: 'reader@example.com',
    conversationId: 'conv-1',
    turnId: 'turn-1',
    requestHash: 'hash-abc',
    idempotencyKeyHash: null,
    deadlineAt: new Date('2026-01-01T00:01:30Z'),
    identityModeRequested: 'signed_in_user',
    releaseIdentity: { app_build_sha: 'abc123' },
    correlationId: 'req-deadbeef-0000-4000-8000-000000000001',
    ...overrides,
  };
}

function value<T>(result: { ok: true; value: T } | { ok: false; reason: string; detail: string }): T {
  if (!result.ok) throw new Error(`Expected success, got ${result.reason}: ${result.detail}`);
  return result.value;
}

let store: FakeStore;

beforeEach(() => {
  resetLakebaseHealth();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  store = new FakeStore();
});

afterEach(() => {
  stopLakebaseWatchdog();
  vi.restoreAllMocks();
});

describe('creating the run for a question', () => {
  it('creates one and says it created it', async () => {
    const result = value(await createOrGetRun(store, newRun({ runId: 'run-1' })));
    expect(result.created).toBe(true);
    expect(result.run.runId).toBe('run-1');
    expect(result.run.state).toBe('RECEIVED');
  });

  /**
   * The join the whole correlation change exists for: an operator holding one id
   * -- from a reader's screenshot, from a log line, or from a trace attribute --
   * has to be able to find the run without knowing the id this app chose
   * internally. Written on creation and read back on the same row.
   */
  it('records the id the request arrived under, alongside the id it chose', async () => {
    const result = value(
      await createOrGetRun(store, newRun({ runId: 'run-1', correlationId: 'req-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }))
    );

    expect(result.run.correlationId).toBe('req-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(result.run.runId).toBe('run-1');
  });

  it('returns the run that already exists rather than a second one', async () => {
    await createOrGetRun(store, newRun({ runId: 'run-1' }));
    const again = value(await createOrGetRun(store, newRun({ runId: 'run-2' })));

    expect(again.created).toBe(false);
    expect(again.run.runId).toBe('run-1');
    expect(store.runs).toHaveLength(1);
  });

  it('answers a hundred concurrent identical requests with one run', async () => {
    // The plan's headline case. Concurrency here is the interleaving the fake
    // can produce rather than real parallelism, which is enough to establish
    // that nothing in the code path creates a second row once one exists.
    const results = await Promise.all(
      Array.from({ length: 100 }, (_unused, index) => createOrGetRun(store, newRun({ runId: `run-${index}` })))
    );

    expect(store.runs).toHaveLength(1);
    const ids = new Set(results.map((result) => value(result).run.runId));
    expect(ids.size).toBe(1);
    expect(results.filter((result) => value(result).created)).toHaveLength(1);
  });

  it('retries when the row it conflicted with is not yet visible', async () => {
    // The snapshot hole: `INSERT ... ON CONFLICT DO NOTHING` conflicts with a
    // row committed after this statement's snapshot began, so the SELECT beside
    // it sees nothing and the statement returns no rows at all. Reissuing takes
    // a fresh snapshot. Without the retry this is a hard failure on exactly the
    // concurrent case the ledger exists for.
    const committed = {
      ...({} as Row),
      run_id: 'run-elsewhere',
      user_email: 'reader@example.com',
      conversation_id: 'conv-1',
      turn_id: 'turn-1',
      request_hash: 'hash-abc',
      idempotency_key_hash: null,
      state: 'RUNNING',
      fencing_token: 0,
      lease_expires_at: null,
      attempts: 0,
      created_at: 1,
      completed_at: null,
    } as Row;
    store.hideOnce(committed);

    const result = value(await createOrGetRun(store, newRun({ runId: 'run-mine' })));

    expect(result.created).toBe(false);
    expect(result.run.runId).toBe('run-elsewhere');
  });

  it('starts a new run for the same question once the first has finished', async () => {
    // The reason the uniqueness rule is partial. A question asked again next
    // week must get a fresh answer rather than be welded to the old run.
    await createOrGetRun(store, newRun({ runId: 'run-1' }));
    store.runs[0].state = 'SUCCEEDED';

    const later = value(await createOrGetRun(store, newRun({ runId: 'run-2' })));

    expect(later.created).toBe(true);
    expect(later.run.runId).toBe('run-2');
  });

  it('starts a new run for a question waiting on a person', async () => {
    // AWAITING_APPROVAL is not executing. A plan can sit unapproved for as long
    // as the reader takes, and blocking every re-ask for that whole time would
    // be worse than the duplicate it prevents.
    await createOrGetRun(store, newRun({ runId: 'run-1' }));
    store.runs[0].state = 'AWAITING_APPROVAL';

    expect(value(await createOrGetRun(store, newRun({ runId: 'run-2' }))).created).toBe(true);
  });

  it('does not attach one reader to another reader run', async () => {
    await createOrGetRun(store, newRun({ runId: 'run-1' }));
    const other = value(await createOrGetRun(store, newRun({ runId: 'run-2', userEmail: 'someone.else@example.com' })));

    expect(other.created).toBe(true);
    expect(other.run.runId).toBe('run-2');
  });

  it('attaches a repeated idempotency key to the run it already made', async () => {
    await createOrGetRun(store, newRun({ runId: 'run-1', idempotencyKeyHash: 'key-hash' }));
    store.runs[0].state = 'SUCCEEDED';

    // Finished, so the live-request rule does not apply. The key still does,
    // which is the whole point of sending one: a client that retries after a
    // dropped connection gets the answer, not a second execution.
    const again = value(await createOrGetRun(store, newRun({ runId: 'run-2', idempotencyKeyHash: 'key-hash' })));

    expect(again.created).toBe(false);
    expect(again.run.runId).toBe('run-1');
  });

  it('fails closed when the store cannot be reached', async () => {
    // Never an exception, because the ask route's catch answers an exception
    // with a representative response. A run that cannot be recorded must stop
    // the request instead of producing an answer nobody can look up.
    store.failWith = 'Connection terminated unexpectedly';

    const result = await createOrGetRun(store, newRun());

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('unavailable');
  });

  it('does not report a store-wide outage when only the ledger fails', async () => {
    // The ledger's tables are new. On a database where their CREATE was refused
    // on ownership, these statements fail while every existing read is
    // perfectly healthy, and routing them through `readStored` would mark the
    // whole store unavailable and drop every degradable page to representative
    // rows. That is a far worse failure than the duplicate execution the ledger
    // prevents, so these statements are deliberately outside that health state.
    store.failWith = 'relation "player_insights.runs" does not exist';

    await createOrGetRun(store, newRun());

    expect(lakebaseHealth().state).not.toBe('unavailable');
  });
});

describe('a key reused for a different question', () => {
  it('is a conflict rather than the earlier answer', () => {
    const run = { idempotencyKeyHash: 'key-hash', requestHash: 'hash-abc' } as LedgerRun;
    expect(idempotencyConflict(run, 'hash-different')).toBe(true);
    expect(idempotencyConflict(run, 'hash-abc')).toBe(false);
  });

  it('is not raised against a caller that sent no key at all', () => {
    const run = { idempotencyKeyHash: null, requestHash: 'hash-abc' } as LedgerRun;
    expect(idempotencyConflict(run, 'hash-different')).toBe(false);
  });
});

describe('taking ownership of a run', () => {
  it('hands the first executor a fencing token', async () => {
    const { run } = value(await createOrGetRun(store, newRun({ runId: 'run-1' })));
    const leased = value(await acquireLease(store, run.runId, 'executor-a', ['RECEIVED']));

    expect(leased.fencingToken).toBe(1);
    expect(leased.leaseOwner).toBe('executor-a');
    expect(leased.attempts).toBe(1);
  });

  it('refuses a second executor while the lease is live', async () => {
    const { run } = value(await createOrGetRun(store, newRun({ runId: 'run-1' })));
    await acquireLease(store, run.runId, 'executor-a', ['RECEIVED']);

    const second = await acquireLease(store, run.runId, 'executor-b', ['RECEIVED']);

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe('lost');
    expect(second.ok === false && second.detail).toContain('Attach to it rather than running it again');
  });

  it('lets a new executor take over once the lease has expired', async () => {
    // The recovery path. An app killed mid-run leaves a lease nobody will ever
    // release, and a run that could never be taken over is a run that is stuck
    // forever rather than one that is safe.
    const { run } = value(await createOrGetRun(store, newRun({ runId: 'run-1' })));
    value(await acquireLease(store, run.runId, 'executor-a', ['RECEIVED']));
    store.now += 60_000;

    const taken = value(await acquireLease(store, run.runId, 'executor-b', ['RECEIVED']));

    expect(taken.leaseOwner).toBe('executor-b');
    expect(taken.fencingToken).toBe(2);
  });

  it('bumps the fence on takeover, which is what makes the old owner stale', async () => {
    const { run } = value(await createOrGetRun(store, newRun({ runId: 'run-1' })));
    const first = value(await acquireLease(store, run.runId, 'executor-a', ['RECEIVED']));
    store.now += 60_000;
    const second = value(await acquireLease(store, run.runId, 'executor-b', ['RECEIVED']));

    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
  });

  it('refuses to take a run that has moved on', async () => {
    const { run } = value(await createOrGetRun(store, newRun({ runId: 'run-1' })));
    store.runs[0].state = 'SUCCEEDED';

    expect((await acquireLease(store, run.runId, 'executor-a', ['RECEIVED'])).ok).toBe(false);
  });
});

describe('moving a run between states', () => {
  async function leased() {
    const { run } = value(await createOrGetRun(store, newRun({ runId: 'run-1' })));
    return value(await acquireLease(store, run.runId, 'executor-a', ['RECEIVED']));
  }

  it('records the move when this executor still owns the run', async () => {
    const run = await leased();
    const moved = value(
      await transition(store, { runId: run.runId, from: 'RECEIVED', to: 'PLANNING', fencingToken: run.fencingToken })
    );

    expect(moved.state).toBe('PLANNING');
  });

  it('writes nothing under a stale fencing token', async () => {
    // The property the whole ledger turns on. A stalled executor that comes
    // back after being taken over must not write its result over the run that
    // replaced it, and it must be told so rather than believing it succeeded.
    const run = await leased();
    store.now += 60_000;
    const taker = value(await acquireLease(store, run.runId, 'executor-b', ['RECEIVED']));

    const stale = await transition(store, {
      runId: run.runId,
      from: 'RECEIVED',
      to: 'PLANNING',
      fencingToken: run.fencingToken,
    });

    expect(stale.ok).toBe(false);
    expect(stale.ok === false && stale.reason).toBe('lost');
    expect(stale.ok === false && stale.detail).toContain('second answer to a question that already has one');
    expect(store.runs[0].state).toBe('RECEIVED');
    expect(taker.fencingToken).not.toBe(run.fencingToken);
  });

  it('refuses an illegal move before it reaches the database', async () => {
    // In TypeScript rather than in the WHERE clause, so a programming error
    // reads as one. As an UPDATE matching no rows it would be indistinguishable
    // from losing a race, and the caller would retry it forever.
    const run = await leased();
    const before = store.statements.length;

    const refused = await transition(store, {
      runId: run.runId,
      from: 'RECEIVED',
      to: 'SUCCEEDED',
      fencingToken: run.fencingToken,
    });

    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.detail).toContain('cannot move to SUCCEEDED');
    expect(store.statements).toHaveLength(before);
  });

  it('refuses a terminal state whose failure code belongs somewhere else', async () => {
    const run = await leased();
    const refused = await transition(store, {
      runId: run.runId,
      from: 'RECEIVED',
      to: 'FAILED',
      fencingToken: run.fencingToken,
      code: 'USER_NOT_AUTHORIZED',
    });

    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.detail).toContain('authorization-layer');
  });

  it('refuses a failure code on a state that has not finished', async () => {
    const run = await leased();
    const refused = await transition(store, {
      runId: run.runId,
      from: 'RECEIVED',
      to: 'PLANNING',
      fencingToken: run.fencingToken,
      code: 'DEPENDENCY_UNAVAILABLE',
    });

    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.detail).toContain('has not finished');
  });

  it('requires a failure code on a state that did fail', async () => {
    const run = await leased();
    const refused = await transition(store, {
      runId: run.runId,
      from: 'RECEIVED',
      to: 'FAILED',
      fencingToken: run.fencingToken,
    });

    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.detail).toContain('must carry a failure code');
  });

  it('closes the run and releases the lease when it finishes', async () => {
    const run = await leased();
    value(
      await transition(store, {
        runId: run.runId,
        from: 'RECEIVED',
        to: 'DEADLINE_EXCEEDED',
        fencingToken: run.fencingToken,
        code: 'RUN_DEADLINE_EXCEEDED',
      })
    );

    expect(store.runs[0].completed_at).not.toBeNull();
    expect(store.runs[0].lease_expires_at).toBeNull();
  });

  it('cannot be moved again once it has finished', async () => {
    const run = await leased();
    value(
      await transition(store, {
        runId: run.runId,
        from: 'RECEIVED',
        to: 'CANCELLED',
        fencingToken: run.fencingToken,
      })
    );

    const after = await transition(store, {
      runId: run.runId,
      from: 'CANCELLED',
      to: 'FAILED',
      fencingToken: run.fencingToken,
      code: 'DEPENDENCY_UNAVAILABLE',
    });

    expect(after.ok).toBe(false);
    expect(store.runs[0].state).toBe('CANCELLED');
  });

  it('records the identity the run actually executed under', async () => {
    const run = await leased();
    const moved = value(
      await transition(store, {
        runId: run.runId,
        from: 'RECEIVED',
        to: 'PLANNING',
        fencingToken: run.fencingToken,
        identityModeEffective: 'signed_in_user',
        identityVerified: true,
      })
    );

    expect(moved.identityModeRequested).toBe('signed_in_user');
    expect(moved.identityModeEffective).toBe('signed_in_user');
    expect(moved.identityVerified).toBe(true);
  });
});

describe('the heartbeat', () => {
  it('extends the lease of the executor that holds it', async () => {
    const { run } = value(await createOrGetRun(store, newRun({ runId: 'run-1' })));
    const leased = value(await acquireLease(store, run.runId, 'executor-a', ['RECEIVED']));
    store.now += 20_000;

    expect(value(await heartbeat(store, run.runId, leased.fencingToken))).toBe(true);
    expect(store.runs[0].lease_expires_at).toBe(store.now + 30_000);
  });

  it('does nothing for an executor that has been taken over', async () => {
    // Otherwise a stalled executor keeps renewing a lease it no longer holds,
    // and the run it was replaced on can never be worked on again.
    const { run } = value(await createOrGetRun(store, newRun({ runId: 'run-1' })));
    const first = value(await acquireLease(store, run.runId, 'executor-a', ['RECEIVED']));
    store.now += 60_000;
    await acquireLease(store, run.runId, 'executor-b', ['RECEIVED']);

    expect(value(await heartbeat(store, run.runId, first.fencingToken))).toBe(false);
  });
});

describe('the attempt record', () => {
  it('keeps one row per fence, so two executors cannot both claim it', async () => {
    const { run } = value(await createOrGetRun(store, newRun({ runId: 'run-1' })));
    const leased = value(await acquireLease(store, run.runId, 'executor-a', ['RECEIVED']));

    expect(
      value(
        await recordAttempt(store, {
          attemptId: 'attempt-1',
          runId: run.runId,
          fencingToken: leased.fencingToken,
          executor: 'executor-a',
        })
      )
    ).toBe(true);
    expect(
      value(
        await recordAttempt(store, {
          attemptId: 'attempt-2',
          runId: run.runId,
          fencingToken: leased.fencingToken,
          executor: 'executor-b',
        })
      )
    ).toBe(false);
    expect(store.attempts).toHaveLength(1);
  });

  it('closes with the outcome, which is what the audit reads', async () => {
    const { run } = value(await createOrGetRun(store, newRun({ runId: 'run-1' })));
    const leased = value(await acquireLease(store, run.runId, 'executor-a', ['RECEIVED']));
    await recordAttempt(store, {
      attemptId: 'attempt-1',
      runId: run.runId,
      fencingToken: leased.fencingToken,
      executor: 'executor-a',
    });

    value(
      await completeAttempt(store, {
        runId: run.runId,
        fencingToken: leased.fencingToken,
        outcome: 'FAILED',
        failureCode: 'DEPENDENCY_UNAVAILABLE',
      })
    );

    expect(store.attempts[0].outcome).toBe('FAILED');
    expect(store.attempts[0].failure_code).toBe('DEPENDENCY_UNAVAILABLE');
  });
});

describe('explicit cancellation', () => {
  async function storedRun(runId: string, state: string, userEmail = 'reader@example.com') {
    await createOrGetRun(
      store,
      newRun({
        runId,
        userEmail,
        conversationId: `conv-${runId}`,
        turnId: `turn-${runId}`,
        requestHash: `hash-${runId}`,
        correlationId: `req-${runId}`,
      })
    );
    const run = store.runs.find((row) => row.run_id === runId);
    if (!run) throw new Error(`Run ${runId} was not stored.`);
    run.state = state;
    run.fencing_token = 7;
    run.lease_owner = 'executor-a';
    run.lease_expires_at = store.now + 30_000;
    return run;
  }

  it.each(EXECUTING_STATES)('atomically cancels an owned run in %s', async (state) => {
    const run = await storedRun(`run-${state}`, state);

    const result = value(await cancelOwnedRun(store, run.user_email, run.run_id));

    expect(result.kind).toBe('cancelled');
    expect(run.state).toBe('CANCELLED');
    expect(run.fencing_token).toBe(8);
    expect(run.lease_owner).toBeNull();
    expect(run.lease_expires_at).toBeNull();
    expect(run.completed_at).toBe(store.now);
    expect(run.updated_at).toBe(store.now);
  });

  it.each(TERMINAL_STATES)('leaves a terminal %s run unchanged', async (state) => {
    const run = await storedRun(`terminal-${state}`, state);
    const before = { ...run };

    const result = value(await cancelOwnedRun(store, run.user_email, run.run_id));

    expect(result).toMatchObject({ kind: 'not-active', run: { state } });
    expect(run).toEqual(before);
  });

  it('accepts the browser correlation id and returns the durable run id', async () => {
    const run = await storedRun('run-by-correlation', 'RUNNING');

    const result = value(await cancelOwnedRun(store, run.user_email, String(run.correlation_id)));

    expect(result).toMatchObject({
      kind: 'cancelled',
      runs: [{ runId: 'run-by-correlation', correlationId: 'req-run-by-correlation' }],
    });
  });

  it('does not reveal or change another owner run', async () => {
    const run = await storedRun('run-private', 'RUNNING', 'owner@example.com');

    const result = value(await cancelOwnedRun(store, 'other@example.com', run.run_id));

    expect(result).toEqual({ kind: 'not-found' });
    expect(run.state).toBe('RUNNING');
    expect(run.fencing_token).toBe(7);
  });

  it('returns not-found for an identifier that does not exist', async () => {
    expect(value(await cancelOwnedRun(store, 'reader@example.com', 'missing'))).toEqual({ kind: 'not-found' });
  });

  it('cancels one admin snapshot across every executing state and no terminal state', async () => {
    for (const state of EXECUTING_STATES) await storedRun(`active-${state}`, state);
    for (const state of TERMINAL_STATES) await storedRun(`done-${state}`, state);

    const cancelled = value(await cancelAllExecutingRuns(store));
    const future = await storedRun('future-run', 'RUNNING');

    expect(cancelled.map((run) => run.runId).sort()).toEqual(
      EXECUTING_STATES.map((state) => `active-${state}`).sort()
    );
    expect(store.runs.filter((run) => run.run_id.startsWith('active-')).every((run) => run.state === 'CANCELLED')).toBe(
      true
    );
    expect(store.runs.filter((run) => run.run_id.startsWith('done-')).map((run) => run.state)).toEqual([
      ...TERMINAL_STATES,
    ]);
    expect(future.state).toBe('RUNNING');
  });

  it('never deletes a run or its history', async () => {
    const run = await storedRun('run-kept', 'SYNTHESIZING');
    const before = store.runs.length;

    value(await cancelOwnedRun(store, run.user_email, run.run_id));

    expect(store.runs).toHaveLength(before);
    expect(store.statements.every((statement) => !/\bDELETE\b/i.test(statement))).toBe(true);
  });
});

describe('reading a run back', () => {
  it('finds the reader own run', async () => {
    await createOrGetRun(store, newRun({ runId: 'run-1' }));
    const found = value(await readRun(store, 'run-1', 'reader@example.com'));

    expect(found?.runId).toBe('run-1');
  });

  it('denies another reader, in the statement rather than after it', async () => {
    // Scoped by the WHERE clause. A check applied to a row already in hand is
    // one a later edit can return early past, and this is the read a Run
    // Explorer link would reach with somebody else's run id in it.
    await createOrGetRun(store, newRun({ runId: 'run-1' }));

    expect(value(await readRun(store, 'run-1', 'someone.else@example.com'))).toBeNull();
  });

  it('reports an outage as an outage rather than as a missing run', async () => {
    store.failWith = 'Connection terminated unexpectedly';
    const result = await readRun(store, 'run-1', 'reader@example.com');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('unavailable');
  });
});
