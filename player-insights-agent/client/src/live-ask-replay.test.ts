/**
 * Leaving a running question and coming back to it.
 *
 * TWO WAYS TO LEAVE AND THEY RECOVER DIFFERENTLY, which is why they are tested
 * together: whichever one the reader took, the thing they must not meet is
 * their own question above a shut composer and an empty agent path.
 *
 *  - Navigating INSIDE the app unmounts the Ask page and leaves the stream this
 *    browser opened running. The registry holds the steps, so returning is a
 *    subscribe and a read.
 *  - Reloading, or opening the conversation in another tab, ends that stream.
 *    Nothing in this browser saw the run. The steps come back from the durable
 *    poll instead, which is what `hydrateLiveAsk` folds in.
 *
 * A mount is a subscribe and a read of the key on screen; an unmount is the
 * unsubscribe. That is the whole of what the Ask page does with this module, so
 * it is what these tests do -- there is no jsdom here, and a claim that can
 * only be checked by rendering is a claim that does not get checked.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TraceStage } from './answer-shape';
import { normalizeStage } from './answer-shape';
import {
  beginLiveAsk,
  endLiveAsk,
  hydrateLiveAsk,
  liveAskListenerCount,
  openLiveAsk,
  readLiveAsk,
  recordLiveStage,
  resetLiveAsks,
  subscribeToLiveAsks,
} from './live-ask';

const CONVERSATION = 'conv-away';

function stage(overrides: Partial<TraceStage> & Pick<TraceStage, 'id'>): TraceStage {
  return {
    name: 'Chose the next step',
    kind: 'agent',
    start: 0,
    duration: 1_829,
    status: 'complete',
    calls: 1,
    input: '',
    output: '',
    startMeasured: true,
    ...overrides,
  };
}

/** What the reconnect route hands back, before the client normalizes it. */
function recorded(id: string, status: TraceStage['status'] = 'complete'): unknown {
  return {
    id,
    name: 'Chose the next step',
    kind: 'agent',
    status,
    start: 0,
    duration: status === 'running' ? 0 : 1_829,
    calls: 1,
  };
}

/** Stands in for a mount of the Ask page. Returns the unmount. */
function mount(): { steps: () => TraceStage[]; renders: () => number; unmount: () => void } {
  let renders = 0;
  const stop = subscribeToLiveAsks(() => {
    renders += 1;
  });
  return {
    steps: () => readLiveAsk(CONVERSATION)?.stages ?? [],
    renders: () => renders,
    unmount: stop,
  };
}

beforeEach(() => {
  resetLiveAsks();
});

describe('an in-flight run whose stream this browser is still holding', () => {
  it('keeps every step the run reported while nobody was looking at it', () => {
    const first = mount();
    beginLiveAsk({ conversationId: CONVERSATION, question: 'How did the title perform?' });
    openLiveAsk(CONVERSATION);
    recordLiveStage(CONVERSATION, stage({ id: 'step-1' }));

    // Away: Run Explorer, Connections, another tab of the nav. The page goes,
    // the stream does not, and the run reports two more steps to nobody.
    first.unmount();
    recordLiveStage(CONVERSATION, stage({ id: 'step-1-1-data_genie', kind: 'tool' }));
    recordLiveStage(CONVERSATION, stage({ id: 'step-2', status: 'running', duration: 0 }));
    expect(liveAskListenerCount()).toBe(0);

    // Back. The path is where the run left it and the newest step is the one
    // the reader is waiting on, rather than an empty list under a live pill.
    const second = mount();
    expect(second.steps().map((entry) => entry.id)).toEqual(['step-1', 'step-1-1-data_genie', 'step-2']);
    expect(second.steps()[2].status).toBe('running');
    expect(readLiveAsk(CONVERSATION)?.inFlight).toBe(true);

    // And it goes on growing, which is the difference between a reconnect and a
    // snapshot: the remount is subscribed, not just reading once.
    recordLiveStage(CONVERSATION, stage({ id: 'step-2', duration: 6_004 }));
    expect(second.renders()).toBeGreaterThan(0);
    expect(second.steps()).toHaveLength(3);
    expect(second.steps()[2].status).toBe('complete');
    second.unmount();
  });

  it('leaves nothing listening behind an unmounted page', () => {
    const first = mount();
    const second = mount();
    expect(liveAskListenerCount()).toBe(2);
    first.unmount();
    second.unmount();
    expect(liveAskListenerCount()).toBe(0);
  });
});

describe('an in-flight run whose stream is gone', () => {
  it('draws the path from what the server recorded, and keeps it growing', () => {
    // A reload, or the conversation opened in a second tab. Nothing in this
    // browser ever saw the run, so the registry starts empty: this is the case
    // that used to leave the reader with a question, a shut composer and an
    // empty agent path for the rest of the run.
    const view = mount();
    expect(view.steps()).toEqual([]);

    hydrateLiveAsk({
      conversationId: CONVERSATION,
      stages: [recorded('step-1'), recorded('step-1-1-data_genie'), recorded('step-2', 'running')].map(normalizeStage),
      question: 'How did the title perform?',
      startedAt: 1_000,
    });

    expect(view.steps().map((entry) => entry.id)).toEqual(['step-1', 'step-1-1-data_genie', 'step-2']);
    expect(readLiveAsk(CONVERSATION)?.inFlight).toBe(true);
    // The question comes off the durable transcript, so the step rows can avoid
    // echoing it back at the reader.
    expect(readLiveAsk(CONVERSATION)?.question).toBe('How did the title perform?');

    // The next poll, 1.5s later: the step it was waiting on finished and another
    // one started. The path grows rather than being replaced.
    hydrateLiveAsk({
      conversationId: CONVERSATION,
      stages: [recorded('step-2'), recorded('step-3', 'running')].map(normalizeStage),
    });

    const steps = view.steps();
    expect(steps.map((entry) => entry.id)).toEqual(['step-1', 'step-1-1-data_genie', 'step-2', 'step-3']);
    expect(steps[2].status).toBe('complete');
    expect(steps[3].status).toBe('running');
    view.unmount();
  });

  it('does not redraw the page for a poll that learned nothing', () => {
    // A run goes minutes between steps late on, and the poll runs every 1.5
    // seconds. Announcing on every one of them would re-render the whole page
    // roughly forty times per step for no change on screen.
    const view = mount();
    hydrateLiveAsk({ conversationId: CONVERSATION, stages: [recorded('step-1')].map(normalizeStage) });
    const afterFirst = view.renders();

    hydrateLiveAsk({ conversationId: CONVERSATION, stages: [recorded('step-1')].map(normalizeStage) });
    hydrateLiveAsk({ conversationId: CONVERSATION, stages: [recorded('step-1')].map(normalizeStage) });

    expect(view.renders()).toBe(afterFirst);
    view.unmount();
  });

  it('records nothing at all for a working run that has taken no step yet', () => {
    // The durable row already says the run is working and the page already says
    // so on screen. An entry with no steps in it would be a run in the registry
    // that a stream arriving afterwards would have to be careful not to trust.
    hydrateLiveAsk({ conversationId: CONVERSATION, stages: [] });
    expect(readLiveAsk(CONVERSATION)).toBeNull();
  });

  it('cannot take a step off the screen of a view that is streaming', () => {
    // Both halves are live one second after asking: this browser holds the
    // stream AND polls. The replay lags the stream, and a replay that replaced
    // the list would walk the path backwards every 1.5 seconds.
    beginLiveAsk({ conversationId: CONVERSATION, question: 'How did the title perform?' });
    openLiveAsk(CONVERSATION, 5_000);
    recordLiveStage(CONVERSATION, stage({ id: 'step-1' }));
    recordLiveStage(CONVERSATION, stage({ id: 'step-2', status: 'running', duration: 0 }));

    hydrateLiveAsk({ conversationId: CONVERSATION, stages: [recorded('step-1')].map(normalizeStage) });

    const run = readLiveAsk(CONVERSATION);
    expect(run?.stages.map((entry) => entry.id)).toEqual(['step-1', 'step-2']);
    // The instants stay the browser's own: they are facts about when things
    // arrived here, and the replay knows nothing about that.
    expect(run?.streamOpenedAt).toBe(5_000);
  });

  it('does not reopen a run that has already ended', () => {
    // A poll can land after the answer has. Reviving the entry would put the
    // "Working…" state back over an answer already on screen.
    beginLiveAsk({ conversationId: CONVERSATION, question: 'How did the title perform?' });
    recordLiveStage(CONVERSATION, stage({ id: 'step-1' }));
    endLiveAsk(CONVERSATION);

    hydrateLiveAsk({ conversationId: CONVERSATION, stages: [recorded('step-2')].map(normalizeStage) });

    expect(readLiveAsk(CONVERSATION)?.inFlight).toBe(false);
    // The steps it did report are kept either way: a run that stopped after two
    // of them is shown as those two.
    expect(readLiveAsk(CONVERSATION)?.stages).toHaveLength(2);
  });
});
