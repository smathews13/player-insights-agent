/**
 * The narration a run leaves behind, which is what a browser that walked away
 * from it is shown when it comes back.
 *
 * The failure this closes is one a reader met and reported: leave a running
 * question, come back, and the question is there, the composer is shut because
 * a run is in flight, and the agent path is empty for the rest of the run. The
 * steps existed the whole time -- on the response body of a POST nobody was
 * reading any more -- and nothing wrote them down.
 */
import { describe, expect, it, vi } from 'vitest';
import { FakeStore } from './__fixtures__/fake-run-store';
import { acquireLease, cancelOwnedRun, createOrGetRun } from './run-ledger';
import {
  createStageRecorder,
  readStageEvents,
  recordStageEvent,
  stageEventPayload,
  STAGE_INPUT_LIMIT,
} from './run-stage-events';

/** A stage in the shape the endpoint actually sends one. */
function stage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'step-1',
    name: 'Chose the next step',
    kind: 'agent',
    status: 'complete',
    start: 0,
    duration: 1_829,
    calls: 1,
    input: '',
    output: '',
    ...overrides,
  };
}

describe('what a stage may leave in the table', () => {
  it('keeps the step’s identity, shape and measurements', () => {
    const payload = stageEventPayload(stage({ depth: 1, parent_id: 'step-1' }));

    expect(payload).toMatchObject({
      id: 'step-1',
      name: 'Chose the next step',
      kind: 'agent',
      status: 'complete',
      start: 0,
      duration: 1_829,
      calls: 1,
      depth: 1,
      parent_id: 'step-1',
    });
  });

  it('never stores the step’s output', () => {
    // The schema's own rule: no raw tool result goes in this table. The
    // arguments a step was given are what the rail draws; what came back is the
    // result, and it arrives in full with the authoritative trace.
    const payload = stageEventPayload(
      stage({
        id: 'step-1-1-data_genie',
        kind: 'tool',
        output: '[{"title_id": 4471, "hours_viewed": 91827364}, {"title_id": 4472}]',
      })
    );

    expect(payload).not.toHaveProperty('output');
  });

  it('stores only the explicit fully-qualified table projection', () => {
    const payload = stageEventPayload(
      stage({
        id: 'inventory',
        name: 'Listed available tables',
        kind: 'discovery',
        input: '{}',
        output: 'raw catalog result that must not be persisted',
        tables: [
          '<your_catalog>.<your_schema>.gold_title_daily',
          '<your_catalog>.<your_schema>.gold_title_daily',
          'not-a-qualified-table',
          17,
        ],
        tool_payload: { authorization: 'Bearer secret' },
      })
    );

    expect(payload.tables).toEqual(['<your_catalog>.<your_schema>.gold_title_daily']);
    expect(payload).not.toHaveProperty('output');
    expect(payload).not.toHaveProperty('tool_payload');
  });

  it('stores the arguments only as wide as the rail draws them', () => {
    const payload = stageEventPayload(
      stage({
        kind: 'tool',
        input: `{"question": "${'w'.repeat(400)}"}`,
      })
    );

    expect(String(payload.input)).toHaveLength(STAGE_INPUT_LIMIT);
    // Marked as shortened, because the expanded trace shows the field whole and
    // says so; a silently cut Genie question would have the two views quietly
    // disagreeing about what was asked.
    expect(String(payload.input).endsWith('\u2026')).toBe(true);
  });

  it('omits a measurement the run did not report rather than writing a zero', () => {
    // `start` absent and `start: 0` are different claims -- the client has
    // `startMeasured` for exactly this -- and a defaulted 0 would turn "this
    // model version reports no offsets" into "this step began at the start".
    const payload = stageEventPayload({ id: 'step-1', name: 'Chose the next step', status: 'running' });

    expect(payload).not.toHaveProperty('start');
    expect(payload).not.toHaveProperty('duration');
    expect(payload).not.toHaveProperty('depth');
    expect(payload.status).toBe('running');
  });

  it('drops a field the agent invented rather than storing whatever arrives', () => {
    // An allowlist, so a field added to the endpoint tomorrow is a field this
    // does not store. The other arrangement finds out later that one of the
    // additions was a token or a whole tool payload.
    const payload = stageEventPayload(stage({ authorization: 'Bearer abc', tool_result_rows: [1, 2, 3] }));

    expect(payload).not.toHaveProperty('authorization');
    expect(payload).not.toHaveProperty('tool_result_rows');
  });
});

describe('recording a run as it happens', () => {
  it('replays the steps in the order the run reported them', async () => {
    const store = new FakeStore();
    const recorder = createStageRecorder(store, 'run-1');

    recorder.record(stage({ id: 'step-1' }));
    recorder.record(
      stage({
        id: 'inventory',
        name: 'Listed available tables',
        kind: 'discovery',
        tables: ['<your_catalog>.<your_schema>.gold_title_daily'],
      })
    );
    recorder.record(stage({ id: 'step-2', status: 'running', duration: 0 }));
    await recorder.settled();

    const replayed = await readStageEvents(store, 'run-1');
    expect(replayed.map((entry) => entry.id)).toEqual(['step-1', 'inventory', 'step-2']);
    expect(replayed[1].tables).toEqual(['<your_catalog>.<your_schema>.gold_title_daily']);
    expect(replayed[1]).not.toHaveProperty('output');
    expect(replayed[2].status).toBe('running');
  });

  it('numbers the steps in arrival order however the writes land', async () => {
    // Appends are chained rather than fired off together. Issued concurrently
    // they would land in whatever order the pool returned them, and a replay
    // ordered by `seq` would then be a replay of a run that never happened in
    // that order.
    const store = new FakeStore();
    const slow = new Map<number, () => void>();
    const original = store.lakebase.query;
    let insert = 0;
    store.lakebase.query = (text: string, params: unknown[] = []) => {
      if (!/INSERT INTO player_insights\.run_events/i.test(text)) return original(text, params);
      insert += 1;
      const at = insert;
      // The first insert finishes last, which is what a slow connection does.
      return new Promise((resolve) => {
        slow.set(at, () => resolve(original(text, params)));
      });
    };

    const recorder = createStageRecorder(store, 'run-1');
    recorder.record(stage({ id: 'step-1' }));
    recorder.record(stage({ id: 'step-2' }));
    // Only the first is in flight: the chain holds the second until it settles.
    await vi.waitFor(() => expect(slow.size).toBe(1));
    slow.get(1)?.();
    await vi.waitFor(() => expect(slow.size).toBe(2));
    slow.get(2)?.();
    await recorder.settled();

    expect(store.stageEvents.map((row) => [row.seq, (row.payload as { id: string }).id])).toEqual([
      [1, 'step-1'],
      [2, 'step-2'],
    ]);
  });

  it('does not make the run wait on its own narration', () => {
    // The step is already on its way to the browser by the time this is called.
    // A run that waited a Lakebase round trip per step would have made every
    // question slower to help the minority of readers who navigate away.
    const store = new FakeStore();
    let settled = false;
    const original = store.lakebase.query;
    store.lakebase.query = (text: string, params: unknown[] = []) =>
      original(text, params).then((rows) => {
        settled = true;
        return rows;
      });

    createStageRecorder(store, 'run-1').record(stage());

    expect(settled).toBe(false);
  });

  it('files a repeated append once', async () => {
    const store = new FakeStore();

    await expect(recordStageEvent(store, { runId: 'run-1', seq: 1, stage: stage() })).resolves.toBe(true);
    await expect(recordStageEvent(store, { runId: 'run-1', seq: 1, stage: stage() })).resolves.toBe(true);

    expect(store.stageEvents).toHaveLength(1);
  });

  it('keeps one run’s steps out of another’s replay', async () => {
    const store = new FakeStore();
    await recordStageEvent(store, { runId: 'run-1', seq: 1, stage: stage({ id: 'step-1' }) });
    await recordStageEvent(store, { runId: 'run-2', seq: 1, stage: stage({ id: 'step-9' }) });

    await expect(readStageEvents(store, 'run-1')).resolves.toEqual([expect.objectContaining({ id: 'step-1' })]);
  });

  it('ignores queued and late stages after cancellation invalidates the fence', async () => {
    const store = new FakeStore();
    await createOrGetRun(store, {
      runId: 'run-fenced',
      userEmail: 'reader@example.com',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      requestHash: 'hash-fenced',
      idempotencyKeyHash: null,
      deadlineAt: new Date('2026-08-31T18:00:00Z'),
      identityModeRequested: 'signed_in_user',
      releaseIdentity: {},
      correlationId: 'request-fenced',
    });
    const lease = await acquireLease(store, 'run-fenced', 'replica-a', ['RECEIVED']);
    if (!lease.ok) throw new Error(lease.detail);
    const controller = new AbortController();
    const recorder = createStageRecorder(store, 'run-fenced', {
      fencingToken: lease.value.fencingToken,
      signal: controller.signal,
    });

    recorder.record(stage({ id: 'before-stop' }));
    await recorder.settled();
    await cancelOwnedRun(store, 'reader@example.com', 'run-fenced');
    controller.abort();
    recorder.record(stage({ id: 'after-stop' }));
    await recordStageEvent(store, {
      runId: 'run-fenced',
      seq: 99,
      stage: stage({ id: 'stale-replica' }),
      fencingToken: lease.value.fencingToken,
    });
    await recorder.settled();

    expect(store.stageEvents.map((event) => (event.payload as { id: string }).id)).toEqual(['before-stop']);
  });
});

describe('a table that cannot be read or written', () => {
  it('replays nothing rather than failing the reconnect', async () => {
    // The reconnect's other half -- whether the run is still working -- is still
    // true and still the thing the browser needs. Refusing the whole read
    // because the narration was unreadable would be a worse outcome than a
    // reconnect without narration, which is what every run had before this.
    const store = new FakeStore();
    store.failWith = 'relation "player_insights.run_events" does not exist';

    await expect(readStageEvents(store, 'run-1')).resolves.toEqual([]);
  });

  it('describes an unwritable table once per run rather than once per step', async () => {
    // Thirty log lines per question would bury the one line that says what
    // happened.
    const store = new FakeStore();
    store.failWith = 'permission denied for table run_events';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const recorder = createStageRecorder(store, 'run-1');
    recorder.record(stage({ id: 'step-1' }));
    recorder.record(stage({ id: 'step-2' }));
    recorder.record(stage({ id: 'step-3' }));
    await recorder.settled();

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
