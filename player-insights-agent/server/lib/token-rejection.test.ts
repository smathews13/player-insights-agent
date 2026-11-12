/**
 * The two 401s, and the fact that only one of them is a reload.
 *
 * The advice this replaces sent every reader of a refused token to the same
 * three steps. For the reader whose token had not expired, step one presented
 * the same live token and collected the same refusal, which is a loop; step two
 * signed them out of a workspace whose session this app does not use. What
 * makes that avoidable is that the token states its own expiry, so the app can
 * read which case it is in rather than picking one.
 */
import { describe, expect, it } from 'vitest';

import { classifyGenieProbe, classifyWarehouseStatus } from '../routes/access-verification';
import { presentedTokenAge, tokenRejection, type PresentedTokenAge } from './token-rejection';

const NOW = new Date('2026-08-16T22:00:00.000Z');

function tokenExpiring(at: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encode({ alg: 'RS256', typ: 'JWT' }),
    encode({ sub: 'reviewer@example.com', exp: Math.floor(new Date(at).getTime() / 1000) }),
    'not-a-real-signature',
  ].join('.');
}

const EXPIRED: PresentedTokenAge = {
  kind: 'expired',
  expiresAt: '2026-08-16T21:45:00.000Z',
  secondsAgo: 900,
};
const LIVE: PresentedTokenAge = {
  kind: 'live',
  expiresAt: '2026-08-16T22:40:00.000Z',
  secondsLeft: 2400,
};
const UNREADABLE: PresentedTokenAge = { kind: 'unreadable', why: 'the token states no expiry' };

describe('what the presented token says about its own lifetime', () => {
  it('reads an expiry that has passed, and how long ago', () => {
    const age = presentedTokenAge(tokenExpiring('2026-08-16T21:45:00.000Z'), NOW);
    expect(age.kind).toBe('expired');
    expect(age).toMatchObject({ secondsAgo: 900 });
  });

  it('reads an expiry that has not passed, and how long is left', () => {
    const age = presentedTokenAge(tokenExpiring('2026-08-16T22:40:00.000Z'), NOW);
    expect(age.kind).toBe('live');
    expect(age).toMatchObject({ secondsLeft: 2400 });
  });

  /**
   * Three different absences, all of them reported as unreadable with the
   * reason attached. None of them is a fault and none of them may be read as
   * "the token was fine": that reading is what produces a confident sentence
   * about a token nobody looked at.
   */
  it('says why, rather than guessing, when there is no expiry to read', () => {
    expect(presentedTokenAge(null, NOW)).toMatchObject({ kind: 'unreadable' });
    expect(presentedTokenAge('dapi-an-opaque-personal-access-token', NOW)).toMatchObject({
      kind: 'unreadable',
    });
    const noExp = [
      Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'reviewer@example.com' })).toString('base64url'),
      'sig',
    ].join('.');
    expect(presentedTokenAge(noExp, NOW)).toMatchObject({
      kind: 'unreadable',
      why: 'the token states no expiry',
    });
  });
});

describe('the copy for a refused token', () => {
  /** Common to all three, because the status code alone establishes it. */
  it('never reads a 401 as a permission the reader is missing', () => {
    for (const age of [EXPIRED, LIVE, UNREADABLE]) {
      const { explanation } = tokenRejection({ age });
      expect(explanation).toContain('not a permission you are missing');
      expect(explanation).toContain('no grant made to you would change it');
    }
  });

  it('offers a reload only when the token had actually run out', () => {
    const expired = tokenRejection({ age: EXPIRED });
    expect(expired.cause).toBe('forwarded-token-expired');
    expect(expired.remedy?.statement).toBe('Reload this page.');
    // And says what it read, in the units a person thinks in.
    expect(expired.explanation).toContain('15 minutes ago');
    expect(expired.evidence).toContain('`2026-08-16T21:45:00.000Z`');
  });

  /**
   * The loop, closed. This is the reader the old copy failed: their token is
   * live, so the page load that the old advice opened with hands the proxy the
   * same token back and changes nothing.
   */
  it('does not tell a reader with a live token to reload', () => {
    const live = tokenRejection({ age: LIVE });
    expect(live.cause).toBe('forwarded-token-refused-while-live');
    expect(live.remedy?.statement).toMatch(/private browsing window/);
    expect(live.remedy?.statement).not.toMatch(/reload/i);
    expect(live.explanation).toMatch(/Reloading this page hands over the same one/);
    expect(live.explanation).toContain('40 minutes');
  });

  /**
   * Neither case picked. Sam's rule for this: if it cannot tell them apart, say
   * so plainly and name the action that works in both.
   */
  it('says plainly when it cannot tell, and names the action that covers both', () => {
    const unknown = tokenRejection({ age: UNREADABLE });
    expect(unknown.cause).toBe('forwarded-token-refused');
    expect(unknown.explanation).toContain('cannot be read from here, so this does not guess');
    expect(unknown.remedy?.statement).toMatch(/private browsing window/);
    // "This covers both" was the note's own commentary on the statement above it,
    // which is explanation of a check rather than something a reader acts on. The
    // claim it made is still made, in `explanation`, where reasoning belongs.
    expect(unknown.explanation).toContain('works whether it had or not');
    // The reason it could not be read is carried, so the claim is checkable.
    expect(unknown.evidence).toContain('the token states no expiry');
  });

  /** Databricks occasionally says why. When it does, that outranks anything here. */
  it('quotes what Databricks said, when it said anything', () => {
    const said = tokenRejection({ age: LIVE, apiMessage: 'invalid access token' });
    expect(said.evidence).toContain('invalid access token');
    expect(tokenRejection({ age: LIVE }).evidence).toContain('gave no reason');
  });

  /**
   * Never the step a reader tries first, on any branch. This app is served from
   * its own host and keeps its own sign-in there, so a workspace sign-out is
   * the one action guaranteed to cost time and change nothing, and it is what
   * the old copy recommended second.
   */
  it('never sends anybody to sign out of the Databricks workspace', () => {
    for (const age of [EXPIRED, LIVE, UNREADABLE]) {
      const remedy = tokenRejection({ age }).remedy;
      expect(remedy?.statement).not.toMatch(/sign out/i);
      // The guidance may mention it, and does, to say that it does not work.
      if (/sign(ing)? out of Databricks/i.test(remedy?.guidance ?? '')) {
        expect(remedy?.guidance).toMatch(/does not clear/);
      }
    }
  });
});

describe('the surfaces that state it', () => {
  /**
   * The gate prints `summary` and `remedy` from the blocked report. Pinned as
   * identity rather than as a phrase match: the whole reason the copy moved
   * into a diagnosis is that the audit holds it against its evidence, and a
   * surface that paraphrases on the way out is outside the audit again.
   */
  it('gives the warehouse gate the diagnosis, word for word', () => {
    const message = 'Databricks answered HTTP 401 with no message body.';
    const blocked = classifyWarehouseStatus(401, 'wh-1', 'reviewer@example.com', message, LIVE);
    const diagnosis = tokenRejection({ age: LIVE, apiMessage: message });
    expect(blocked?.kind).toBe('token-rejected');
    expect(blocked?.summary).toBe(diagnosis.explanation);
    expect(blocked?.remedy).toEqual(diagnosis.remedy);
    expect(blocked?.layer).toBe('the forwarded user token');
    // Still not a grant, which is the older promise this path already made.
    expect(blocked?.missing).toBeUndefined();
  });

  it('gives a Genie row the same answer, so one refusal is not two stories', () => {
    const verdict = classifyGenieProbe(
      { ok: false, status: 401, message: 'no' },
      { id: 'space-1', label: 'Player Insights' },
      'reviewer@example.com',
      LIVE
    );
    expect(verdict.status).toBe('error');
    expect(verdict.detail).toContain(tokenRejection({ age: LIVE, apiMessage: 'no' }).explanation);
    expect(verdict.remedy).toEqual(tokenRejection({ age: LIVE, apiMessage: 'no' }).remedy);
    expect(verdict.detail).not.toMatch(/Reload the page/);
  });

  /**
   * A caller that was not given the token gets the branch that names no cause.
   * The alternative default, treating an absent input as a live token, would
   * make an omission look like a reading.
   */
  it('names no cause when nobody passed the token in', () => {
    const blocked = classifyWarehouseStatus(401, 'wh-1', 'reviewer@example.com', 'no body');
    expect(blocked?.summary).toContain('cannot be read from here');
    expect(blocked?.remedy?.statement).not.toMatch(/reload/i);
  });
});
