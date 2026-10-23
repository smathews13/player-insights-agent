/**
 * A finished run must end the live view whichever id the tab knows it by.
 *
 * Seen on Dev: an ask sent from a script finished in about 35 seconds, while a
 * tab that had the conversation open showed "Preparing an answer" until it was
 * reloaded. The tab had learned the run by replay and held no id for it, and the
 * poll only ended a run whose id matched the ledger's `run_id`. A tab that
 * streamed its own ask knows it by the id it minted, the ledger's
 * `correlation_id`, which did not match `run_id` either.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeStage } from './answer-shape';
import {
  beginLiveAsk,
  endLiveAskForRun,
  hydrateLiveAsk,
  identifyLiveAsk,
  readLiveAsk,
  resetLiveAsks,
} from './live-ask';

const CONVERSATION = 'conv-ended-elsewhere';
const STARTED = Date.parse('2026-10-23T21:31:00Z');

const step = normalizeStage({ id: 'data', name: 'Reading data', status: 'running' }, 0);

function row(overrides: Partial<{ run_id: string; correlation_id: string | null; created_at: string }> = {}) {
  return {
    run_id: 'server-run',
    correlation_id: 'browser-run',
    created_at: new Date(STARTED).toISOString(),
    ...overrides,
  };
}

beforeEach(() => resetLiveAsks());

describe('endLiveAskForRun', () => {
  it('ends a run this tab learned by replay and never identified', () => {
    hydrateLiveAsk({ conversationId: CONVERSATION, stages: [step], question: 'Q', startedAt: STARTED });
    expect(readLiveAsk(CONVERSATION)?.inFlight).toBe(true);

    endLiveAskForRun(CONVERSATION, row({ correlation_id: null }));

    expect(readLiveAsk(CONVERSATION)?.inFlight).toBe(false);
  });

  it('ends a run this tab streamed, matched by the id the tab minted', () => {
    beginLiveAsk({ conversationId: CONVERSATION, question: 'Q', startedAt: STARTED });
    identifyLiveAsk(CONVERSATION, 'browser-run');

    endLiveAskForRun(CONVERSATION, row());

    expect(readLiveAsk(CONVERSATION)?.inFlight).toBe(false);
  });

  it('ends a run matched by the server id', () => {
    beginLiveAsk({ conversationId: CONVERSATION, question: 'Q', startedAt: STARTED });
    identifyLiveAsk(CONVERSATION, 'server-run');

    endLiveAskForRun(CONVERSATION, row({ correlation_id: null }));

    expect(readLiveAsk(CONVERSATION)?.inFlight).toBe(false);
  });

  it('leaves a newer identified ask running when the row is another run', () => {
    beginLiveAsk({ conversationId: CONVERSATION, question: 'Q', startedAt: STARTED });
    identifyLiveAsk(CONVERSATION, 'newer-browser-run');

    endLiveAskForRun(CONVERSATION, row());

    expect(readLiveAsk(CONVERSATION)?.inFlight).toBe(true);
  });

  it("leaves a just-sent ask running when the row is the previous turn's", () => {
    beginLiveAsk({ conversationId: CONVERSATION, question: 'Q', startedAt: STARTED });

    endLiveAskForRun(CONVERSATION, row({ created_at: new Date(STARTED - 60_000).toISOString() }));

    expect(readLiveAsk(CONVERSATION)?.inFlight).toBe(true);
  });

  it('does nothing when the conversation has no live run', () => {
    expect(() => endLiveAskForRun(CONVERSATION, row())).not.toThrow();
    expect(readLiveAsk(CONVERSATION)).toBeNull();
  });
});
