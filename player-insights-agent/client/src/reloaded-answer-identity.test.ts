import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { dataAccessDisclosure } from './analytical-execution';
import { normalizeAnswer, storedExecutionIdentity, type WireAnswer } from './answer-shape';
import type { ConversationMessage } from './app-types';

/**
 * What an answer says about its own identity the SECOND time somebody reads it.
 *
 * The footer of an answer says whose grants its figures were read under, and it
 * derives that from what the run reported rather than from a constant. Live, it
 * worked. Reopened from the conversation rail, every answer ever given said the
 * identity was unconfirmed -- during a design review, on a screen full of
 * answers that had all run under the reader's own grants.
 *
 * The sentence was not wrong about what it had been given. It was reporting a
 * payload with nothing in it, and the reason there was nothing in it is that the
 * identity is recorded in columns beside the stored answer rather than inside
 * it, and neither the route serving those rows nor the browser reading them
 * carried the columns across. Two places lost it, and both are covered here:
 *
 *   1. The reopened turn, which had the record and did not read it.
 *   2. The turn that just ran, which had the claim and dropped it one render
 *      later. The transcript holds every turn as the row it will be reloaded as,
 *      the row for a fresh answer holds the normalized answer, and every render
 *      normalizes it again -- which renamed this one field out of existence.
 *
 * The tests are written as the reader experiences it: a row goes in, a sentence
 * comes out. Asserting on the intermediate claim would let the two halves drift
 * apart while both still passed.
 */

const RAN_AS_READER = 'Data read under your own Unity Catalog grants.';
const RAN_AS_APP = 'Data access scope: application Unity Catalog grants.';
/**
 * No footer line at all, which is what a run with no recorded identity gets.
 *
 * It used to get "The identity this data was read as is unconfirmed." The claim
 * was true and was removed anyway: it asserted a doubt on every such run, and it
 * rendered on surfaces that know who asked, where it reads as a hint that the
 * question was answered as someone else. Absence says the same thing and accuses
 * nobody. Naming the reader here instead would be the opposite and worse error,
 * so these cases assert null rather than a substitute sentence.
 */
const NO_LINE = null;

/** The answer body a stored turn holds, with no identity of its own anywhere in it. */
function storedAnswer(): Record<string, unknown> {
  return {
    id: 'msg-1',
    mode: 'live',
    takeaway: 'Active players rose 4%.',
    narrative: 'Active players rose 4% over the period.',
    sources: [{ name: 'gold.daily_summary', freshness: 'Read during this run' }],
    caveats: [],
    sql: 'SELECT 1',
    trace: { id: 'tr-00000000000000000000000000000001', totalMs: 10, toolCalls: 1, stages: [] },
  };
}

/**
 * A turn as the conversation route serves it, and the sentence its footer ends up with.
 *
 * This is the chain HomePage runs on every assistant row: read the identity off
 * the row, hand it to the normalizer under the name a live reply uses, and let
 * the footer's own rule pick the words. Copied here rather than imported because
 * HomePage keeps its response parsing unexported by design; the test below that
 * reads the page's source is what holds the copy to the original.
 */
function footerOf(row: ConversationMessage): string | null {
  const identity = storedExecutionIdentity(row);
  const answer = normalizeAnswer(
    identity === undefined
      ? (row.response_json as WireAnswer)
      : ({ ...(row.response_json as WireAnswer), execution_identity: identity } as WireAnswer)
  );
  return dataAccessDisclosure(answer.executionIdentity);
}

/** A turn as the ask route replies with it, and the sentence its footer ends up with. */
function liveFooterOf(reply: WireAnswer): string | null {
  return dataAccessDisclosure(normalizeAnswer(reply).executionIdentity);
}

function reopened(columns: Partial<ConversationMessage>): ConversationMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'Active players rose 4%.',
    response_json: storedAnswer(),
    ...columns,
  };
}

describe('an answer reopened from the conversation rail', () => {
  it('says what it said live when the row recorded that the reader executed it', () => {
    const live = liveFooterOf({ ...storedAnswer(), execution_identity: { mode: 'signed_in_user', verified: true } });
    const reloaded = footerOf(reopened({ execution_mode: 'signed_in_user', execution_identity_verified: true }));

    expect(reloaded).toBe(RAN_AS_READER);
    // The point of the fix, stated as the equality it has to hold to. An answer
    // that describes its own boundary differently on Tuesday than it did on
    // Monday is not a record of anything, whichever day is the accurate one.
    expect(reloaded).toBe(live);
  });

  it('says what it said live when the row recorded that the application executed it', () => {
    const live = liveFooterOf({
      ...storedAnswer(),
      execution_identity: { mode: 'app_service_principal', verified: false },
    });
    const reloaded = footerOf(
      reopened({ execution_mode: 'app_service_principal', execution_identity_verified: false })
    );

    expect(reloaded).toBe(RAN_AS_APP);
    expect(reloaded).toBe(live);
  });

  /**
   * The reason this is not simply "always show an identity now".
   *
   * The columns were added partway through this app's life, and every turn taken
   * before that holds nulls. There is no identity to report for those runs and no
   * honest way to work one out: the reader's session says who is looking now, not
   * who ran it then, and a backfill would be writing an audit trail rather than
   * reading one. So those runs get no identity line, rather than the reader's
   * name and rather than a sentence about the gap.
   */
  it('shows no identity line for a run that never recorded one', () => {
    expect(footerOf(reopened({ execution_mode: null, execution_identity_verified: null }))).toBe(NO_LINE);
    expect(footerOf(reopened({}))).toBe(NO_LINE);
  });

  /**
   * `verified` is not the same fact as the mode. The mode is which credential
   * the endpoint was called with; the flag is whether this app could read a
   * subject out of the forwarded token and prove it was the reader's. Unverified
   * is the ordinary case for an opaque token and is not a weaker boundary, so the
   * footer says the same sentence either way -- but the flag still has to travel
   * as it was recorded, because an absent one defaulted to true would turn every
   * unproven run into a confirmed one on the strength of a missing column.
   */
  it('carries an unverified run as unverified rather than promoting it', () => {
    const row = reopened({ execution_mode: 'signed_in_user', execution_identity_verified: false });

    expect(storedExecutionIdentity(row)).toEqual({ mode: 'signed_in_user', verified: false });
    expect(footerOf(row)).toBe(RAN_AS_READER);
  });

  /**
   * A row filled in on one side only is a row that could not say who ran it.
   *
   * Completing it either way is a guess: the missing half is missing because
   * something failed to record it, and the half that survived is not evidence
   * about the half that did not. Nothing is what a record in that state actually
   * supports, so nothing is what the footer says.
   *
   * Note what is deliberately NOT done here. A pair that looks internally odd --
   * the application mode with the verified flag set, say -- is passed through to
   * the footer's own rule rather than reclassified on the way. Reclassifying it
   * would mean this file holding an opinion about which sentence to show, and a
   * second copy of that decision is how the footer came to contradict the run in
   * the first place.
   */
  it.each([
    ['a mode with no verification flag', { execution_mode: 'signed_in_user', execution_identity_verified: null }],
    ['a verification flag with no mode', { execution_mode: null, execution_identity_verified: true }],
    ['a blank mode beside a flag', { execution_mode: '   ', execution_identity_verified: true }],
    [
      'a flag the column did not hold as a boolean',
      { execution_mode: 'signed_in_user', execution_identity_verified: 'yes' },
    ],
  ])('shows no identity line for %s rather than completing it', (_label, columns) => {
    expect(footerOf(reopened(columns))).toBe(NO_LINE);
  });
});

/**
 * The half of the defect that was invisible because it corrected itself in the
 * screenshot: a live answer stated its identity when it arrived and stopped a
 * render later, so the bug looked like it belonged to reloading alone.
 */
describe('an answer that has just been given', () => {
  it('keeps its identity when the transcript reads it back as a row', () => {
    const reply = { ...storedAnswer(), execution_identity: { mode: 'signed_in_user', verified: true } };
    const onArrival = normalizeAnswer(reply);
    // What the transcript stores for the turn that just ran, and reads again on
    // every render from then on. Normalizing an answer twice has to say what
    // normalizing it once said, or a field is lost to nothing but a re-render.
    const onEveryRenderAfter = normalizeAnswer(onArrival as unknown as WireAnswer);

    expect(dataAccessDisclosure(onArrival.executionIdentity)).toBe(RAN_AS_READER);
    expect(dataAccessDisclosure(onEveryRenderAfter.executionIdentity)).toBe(RAN_AS_READER);
  });

  it('does not gain an identity from being read twice', () => {
    const onArrival = normalizeAnswer(storedAnswer());

    expect(dataAccessDisclosure(normalizeAnswer(onArrival as unknown as WireAnswer).executionIdentity)).toBe(NO_LINE);
  });
});

/**
 * Asserted against the page's source, because the claim is about WHERE the
 * identity is read: off the message row, in the function every assistant turn in
 * the transcript goes through. The chain above passes just as happily with
 * nothing calling it, which is exactly the state the app was in.
 */
describe('the transcript reads the identity off the row it renders', () => {
  const HOME_PAGE = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');

  it('takes the claim from the stored row rather than from the answer alone', () => {
    expect(HOME_PAGE).toContain('storedExecutionIdentity(message)');
  });

  it('hands it to the normalizer under the name a live reply uses', () => {
    expect(HOME_PAGE).toContain('execution_identity: executionIdentity');
  });
});
