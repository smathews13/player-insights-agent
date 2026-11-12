import { describe, expect, it } from 'vitest';

import {
  FAILURE_CODES,
  FAILURE_TAXONOMY,
  NEVER_REROUTE_LAYERS,
  failureDefinition,
  isFailureCode,
  type FailureCode,
} from './failure-taxonomy';

/**
 * The codes that mean somebody was refused, as opposed to something breaking.
 *
 * Listed here rather than derived from the layer, so that moving a code between
 * layers has to be done deliberately in two places instead of quietly
 * reclassifying a denial as an outage in one.
 */
const REFUSALS: FailureCode[] = ['IDENTITY_REQUIRED', 'IDENTITY_MISMATCH', 'USER_AUTH_REJECTED', 'USER_NOT_AUTHORIZED'];

describe('the taxonomy is complete', () => {
  it('defines every code it declares, under its own name', () => {
    for (const code of FAILURE_CODES) {
      expect(FAILURE_TAXONOMY[code]).toBeDefined();
      expect(FAILURE_TAXONOMY[code].code).toBe(code);
    }
    expect(Object.keys(FAILURE_TAXONOMY).sort()).toEqual([...FAILURE_CODES].sort());
  });

  it('recognises its own codes and nothing else', () => {
    expect(isFailureCode('USER_NOT_AUTHORIZED')).toBe(true);
    expect(isFailureCode('user_not_authorized')).toBe(false);
    expect(isFailureCode(undefined)).toBe(false);
  });

  /**
   * A code from a newer release must not be rendered as a generic failure: that
   * is how the two halves of a skewed deployment stop disagreeing out loud.
   */
  it('throws on a code it has never heard of rather than inventing a definition', () => {
    expect(() => failureDefinition('SOMETHING_NEWER' as FailureCode)).toThrow(/Unknown failure code/);
  });

  it('lets no code carry an answer', () => {
    for (const code of FAILURE_CODES) {
      expect(FAILURE_TAXONOMY[code].mayGenerateAnswer).toBe(false);
    }
  });
});

/**
 * The property Improvement 1 rests on. A denial that something retries is a
 * denial answered by asking as somebody else, and the code table is the only
 * place that can make it impossible to arrive at by accident.
 */
describe('a refusal is not an outage', () => {
  it.each(REFUSALS)('never marks %s retryable', (code) => {
    expect(FAILURE_TAXONOMY[code].retryable).toBe(false);
  });

  it.each(REFUSALS)('never lets %s be retried under another route or identity', (code) => {
    expect(FAILURE_TAXONOMY[code].mayRerouteOrReidentify).toBe(false);
  });

  it('forbids rerouting for every code in a protected layer, including ones added later', () => {
    for (const code of FAILURE_CODES) {
      if (NEVER_REROUTE_LAYERS.includes(FAILURE_TAXONOMY[code].layer)) {
        expect(FAILURE_TAXONOMY[code].mayRerouteOrReidentify).toBe(false);
      }
    }
  });

  /**
   * The distinction the ask route did not have: everything that stopped a
   * request arrived as one exception and inherited a dependency failure's
   * retryability on the way out.
   */
  it('keeps DEPENDENCY_UNAVAILABLE retryable, which is what a refusal must not be', () => {
    expect(FAILURE_TAXONOMY.DEPENDENCY_UNAVAILABLE.retryable).toBe(true);
    expect(FAILURE_TAXONOMY.DEPENDENCY_UNAVAILABLE.layer).toBe('dependency');
  });

  it('files no refusal under a layer that would let it be rerouted', () => {
    for (const code of REFUSALS) {
      expect(NEVER_REROUTE_LAYERS).toContain(FAILURE_TAXONOMY[code].layer);
    }
  });
});

describe('what a refused reader is told', () => {
  /**
   * A denial that reads as an outage sends the reader away to wait, and a
   * reader who waits never asks for the grant that would have fixed it.
   */
  it.each(REFUSALS)('does not invite %s to try again', (code) => {
    expect(FAILURE_TAXONOMY[code].uiMessage.toLowerCase()).not.toContain('try again');
  });

  it('names the thing a denied reader can act on, without naming what they could not reach', () => {
    expect(FAILURE_TAXONOMY.USER_NOT_AUTHORIZED.uiMessage).toContain('data products required by this question');
  });

  /**
   * Paging on a user who correctly lacks a grant is how the channel that
   * carries IDENTITY_MISMATCH becomes one nobody reads.
   */
  it('pages for two identities on one request, and for nobody lacking a grant', () => {
    expect(FAILURE_TAXONOMY.IDENTITY_MISMATCH.alert).toBe('page');
    expect(FAILURE_TAXONOMY.IDENTITY_MISMATCH.trace).toBe('record_security_event');
    expect(FAILURE_TAXONOMY.USER_NOT_AUTHORIZED.alert).toBe('none');
  });
});

/**
 * The pair of column-policy codes, whose whole value is that they are two.
 *
 * They are the same policy at two moments and a reasonable person merges them
 * on sight, so what stops that is written down as an assertion rather than left
 * in a comment. The difference that matters to a security reviewer is whether
 * the values were ever materialised; the difference that matters to an operator
 * is that the two rates move for opposite reasons, and summed they cancel.
 */
describe('a refused statement and a refused result set stay apart', () => {
  it('keeps both, under the one layer that is right for both', () => {
    expect(FAILURE_TAXONOMY.COLUMN_POLICY_VIOLATION.layer).toBe('governance');
    expect(FAILURE_TAXONOMY.RESULT_COLUMN_POLICY_VIOLATION.layer).toBe('governance');
    expect(FAILURE_TAXONOMY.RESULT_COLUMN_POLICY_VIOLATION.code).not.toBe(
      FAILURE_TAXONOMY.COLUMN_POLICY_VIOLATION.code
    );
  });

  it('records both for security review and pages for neither', () => {
    // Both are the product refusing to disclose something, which is the product
    // working. A reviewer must be able to find them; an on-call must not be
    // woken by them.
    for (const code of ['COLUMN_POLICY_VIOLATION', 'RESULT_COLUMN_POLICY_VIOLATION'] as const) {
      expect(FAILURE_TAXONOMY[code].trace).toBe('record_security_event');
      expect(FAILURE_TAXONOMY[code].alert).toBe('warning');
      expect(FAILURE_TAXONOMY[code].httpStatus).toBe(403);
      expect(FAILURE_TAXONOMY[code].retryable).toBe(false);
    }
  });

  /**
   * The near miss the evidence workstream called out by name: the closest
   * NAME in this file is the furthest meaning away. Reporting a governance
   * refusal on the contract code pages an on-call for the product working, and
   * tells the reader the agent replied in a form the app cannot read.
   */
  it('is not the contract code, whose name is the closest fit and whose meaning is not', () => {
    expect(FAILURE_TAXONOMY.OUTPUT_SCHEMA_VIOLATION.layer).toBe('contract');
    expect(FAILURE_TAXONOMY.OUTPUT_SCHEMA_VIOLATION.alert).toBe('page');
    expect(FAILURE_TAXONOMY.RESULT_COLUMN_POLICY_VIOLATION.alert).not.toBe('page');
  });

  it('tells the reader the rows were discarded, not that the question was refused up front', () => {
    // The sentences differ because the two remedies differ: name columns
    // instead of starring, versus ask for different columns.
    expect(FAILURE_TAXONOMY.RESULT_COLUMN_POLICY_VIOLATION.uiMessage).toContain('discarded');
    expect(FAILURE_TAXONOMY.COLUMN_POLICY_VIOLATION.uiMessage).toContain('refused');
  });
});

/**
 * The admission refusal, and the two things it must never become.
 *
 * The run ledger used to hold this as a local constant pointed at two
 * conditions with two different statuses. One of them is this; the other is a
 * malformed key, which is not a conflict at all and now has its own entry.
 */
describe('a reused idempotency key', () => {
  it('is a conflict, in the layer that says the request is what has to change', () => {
    expect(FAILURE_TAXONOMY.IDEMPOTENCY_CONFLICT.httpStatus).toBe(409);
    expect(FAILURE_TAXONOMY.IDEMPOTENCY_CONFLICT.layer).toBe('request');
  });

  /**
   * The property the code exists for. Refusing is only worth doing if neither
   * run's answer comes back: replaying the earlier one answers a question the
   * caller has stopped asking, and running the new one under the old key
   * defeats the guard they asked for by sending a key at all.
   */
  it('may not be answered from either run', () => {
    expect(FAILURE_TAXONOMY.IDEMPOTENCY_CONFLICT.mayGenerateAnswer).toBe(false);
    expect(FAILURE_TAXONOMY.IDEMPOTENCY_CONFLICT.retryable).toBe(false);
  });

  /**
   * One occurrence is the guard working. Paging on a correctly refused
   * duplicate is how the channel carrying IDENTITY_MISMATCH stops being read.
   */
  it('does not alert like an outage or like a security event', () => {
    expect(FAILURE_TAXONOMY.IDEMPOTENCY_CONFLICT.alert).toBe('info');
    expect(FAILURE_TAXONOMY.IDEMPOTENCY_CONFLICT.trace).toBe('record_failure');
  });

  /**
   * A code carries exactly one status, so a caller that answers 400 from this
   * entry has put a status on the wire that contradicts the code beside it.
   */
  it('declares one status, which is not the malformed-key one', () => {
    expect(FAILURE_TAXONOMY.IDEMPOTENCY_CONFLICT.httpStatus).not.toBe(400);
  });
});

/**
 * The second pair whose whole value is that they are two, and the one most
 * likely to be merged: the names differ by a word, they sit next to each other
 * in the list, they share a layer, and a reader who has not hit either of them
 * will read both as "something wrong with the idempotency key".
 *
 * What stops the merge is written here as assertions rather than left in a
 * comment, because the cost of it lands on a client rather than on us. 409
 * tells a caller its key collided with something we hold and a different key
 * gets through; 400 tells it we could not read the header at all and no key of
 * that shape will ever get through. Collapsed onto one code, one of those two
 * callers is told to do the thing that cannot work.
 */
describe('a reused idempotency key and an unreadable one stay apart', () => {
  it('answers the two with the two statuses that mean different remedies', () => {
    expect(FAILURE_TAXONOMY.IDEMPOTENCY_CONFLICT.httpStatus).toBe(409);
    expect(FAILURE_TAXONOMY.IDEMPOTENCY_KEY_MALFORMED.httpStatus).toBe(400);
    expect(FAILURE_TAXONOMY.IDEMPOTENCY_KEY_MALFORMED.httpStatus).not.toBe(
      FAILURE_TAXONOMY.IDEMPOTENCY_CONFLICT.httpStatus
    );
  });

  /**
   * The layer IS shared, and correctly, which is why the status is what has to
   * be asserted. Both answer "whose problem is this" with the request, so both
   * end in REFUSED rather than putting a caller's header in front of an
   * operator as an outage.
   */
  it('files both under the request layer, which is the thing they do share', () => {
    expect(FAILURE_TAXONOMY.IDEMPOTENCY_CONFLICT.layer).toBe('request');
    expect(FAILURE_TAXONOMY.IDEMPOTENCY_KEY_MALFORMED.layer).toBe('request');
  });

  it('tells the caller two different things to do about it', () => {
    // Neither sentence may be reachable from the other code: a malformed header
    // has no "earlier request" and a conflict has nothing to say about format.
    expect(FAILURE_TAXONOMY.IDEMPOTENCY_CONFLICT.uiMessage).toContain('earlier request');
    expect(FAILURE_TAXONOMY.IDEMPOTENCY_KEY_MALFORMED.uiMessage).toContain('Idempotency-Key header must be');
    expect(FAILURE_TAXONOMY.IDEMPOTENCY_KEY_MALFORMED.uiMessage).not.toContain('earlier');
  });

  it('counts both quietly and wakes nobody for either', () => {
    // A client with a key bug is worth counting and is not an incident here.
    for (const code of ['IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_KEY_MALFORMED'] as const) {
      expect(FAILURE_TAXONOMY[code].alert).toBe('info');
      expect(FAILURE_TAXONOMY[code].trace).toBe('record_failure');
      expect(FAILURE_TAXONOMY[code].retryable).toBe(false);
      expect(FAILURE_TAXONOMY[code].mayRerouteOrReidentify).toBe(false);
      expect(FAILURE_TAXONOMY[code].mayGenerateAnswer).toBe(false);
    }
  });
});
