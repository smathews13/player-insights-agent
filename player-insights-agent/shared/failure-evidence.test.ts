import { describe, expect, it } from 'vitest';
import {
  carriedProviderCode,
  carriedStatus,
  DEPENDENCY_LABELS,
  describeDependency,
  describeStage,
  formatProviderError,
  isFailureEvidence,
  PROVIDER_MESSAGE_LIMIT,
  providerFailure,
  type DependencyKind,
} from './failure-evidence';
import { FAILURE_TAXONOMY } from './failure-taxonomy';

/**
 * The fields a failure panel is built from.
 *
 * Tested at this level as well as through the copy module because the property
 * that matters is a negative one -- that nothing here invents a status, a name or
 * a step that the provider did not report -- and a negative is easiest to pin
 * where the value is produced rather than where it is worded.
 */

describe('naming the dependency', () => {
  it('uses the label a reader can search for', () => {
    expect(describeDependency({ kind: 'sql-warehouse', name: 'pia-serverless' })).toBe('SQL warehouse pia-serverless');
    expect(describeDependency({ kind: 'genie-space', name: '01f0abc' })).toBe('Genie space 01f0abc');
  });

  it('drops the name rather than inventing one, when the app does not know it', () => {
    // An endpoint whose name is unset is a misconfigured deployment. "Agent
    // serving endpoint unknown" reads as a component called unknown and sends
    // somebody looking for it.
    expect(describeDependency({ kind: 'agent-endpoint', name: '' })).toBe('Agent serving endpoint');
    expect(describeDependency({ kind: 'agent-endpoint', name: '   ' })).toBe('Agent serving endpoint');
  });

  it('says nothing when there is no dependency to name', () => {
    // Not every failure has one: a malformed idempotency key never reached
    // anything. Null so a caller prints nothing rather than a line that looks
    // like a reading and is not one.
    expect(describeDependency(undefined)).toBeNull();
  });

  it('has a label for every kind, so a new one cannot render as an identifier', () => {
    const kinds: DependencyKind[] = [
      'agent-endpoint',
      'sql-warehouse',
      'genie-space',
      'unity-catalog',
      'lakebase',
      'llm-gateway',
      'app-store',
      'unknown',
    ];
    for (const kind of kinds) {
      expect(DEPENDENCY_LABELS[kind]).toBeTruthy();
      expect(DEPENDENCY_LABELS[kind]).not.toContain('-');
    }
  });
});

describe('the error line', () => {
  it('joins the status, the code and the message in the order they are scanned', () => {
    expect(
      formatProviderError({
        status: 403,
        providerCode: 'PERMISSION_DENIED',
        providerMessage: 'User has no SELECT on the table.',
      })
    ).toBe('HTTP 403 \u00b7 PERMISSION_DENIED \u00b7 User has no SELECT on the table.');
  });

  it('omits each part that is genuinely absent rather than padding it', () => {
    // "HTTP 0" and an empty code both read as things the provider returned.
    expect(formatProviderError({ providerMessage: 'socket hang up' })).toBe('socket hang up');
    expect(formatProviderError({ status: 502 })).toBe('HTTP 502');
    expect(formatProviderError({})).toBeNull();
    expect(formatProviderError(undefined)).toBeNull();
  });

  it('keeps a zero status, which is a status a transport really does report', () => {
    expect(formatProviderError({ status: 0, providerMessage: 'no response' })).toContain('HTTP 0');
  });

  it('truncates a stack trace rather than pushing the retry button off the screen', () => {
    const line = formatProviderError({ providerMessage: 'y'.repeat(PROVIDER_MESSAGE_LIMIT + 500) });
    expect(line).toContain('\u2026');
    expect(line?.length).toBeLessThan(PROVIDER_MESSAGE_LIMIT + 10);
  });

  it('does not truncate a message that fits, down to the last character', () => {
    const exact = 'z'.repeat(PROVIDER_MESSAGE_LIMIT);
    expect(formatProviderError({ providerMessage: exact })).toBe(exact);
  });
});

describe('how far the run got', () => {
  it('reports the count and the last step to finish, worded as "after"', () => {
    // The app hears about a stage when the agent reports it COMPLETE, so the
    // stage that failed is one nobody heard about. Wording this as the stage it
    // died in would send a reader to read a query that ran.
    const line = describeStage({ title: 'Query gold_title_daily_summary', completed: 4 });
    expect(line).toBe('Stopped after 4 completed steps; the last to finish was "Query gold_title_daily_summary".');
  });

  it('agrees with itself about one step', () => {
    expect(describeStage({ title: 'Confirmed definitions', completed: 1 })).toContain('1 completed step;');
  });

  it('says nothing when nothing was narrated', () => {
    expect(describeStage(undefined)).toBeNull();
    expect(describeStage({ title: '' })).toBeNull();
    // Zero completed steps is not a step, and naming step 0 names one that does
    // not exist.
    expect(describeStage({ title: 'Planned the analysis', completed: 0 })).toBe(
      'Stopped after "Planned the analysis".'
    );
  });
});

describe('reading a rejection', () => {
  it('finds the status wherever the transport in use happens to put it', () => {
    // The experimental SDK surfaces `statusCode`, the generated client surfaces
    // `status`, and a new transport that surfaces neither must report nothing
    // rather than inherit a guess.
    expect(carriedStatus(Object.assign(new Error('x'), { statusCode: 503 }))).toBe(503);
    expect(carriedStatus(Object.assign(new Error('x'), { status: 429 }))).toBe(429);
    expect(carriedStatus(new Error('403 Forbidden'))).toBeUndefined();
    expect(carriedStatus('a thrown string')).toBeUndefined();
  });

  /**
   * The one place this module deliberately refuses to be helpful.
   *
   * `rejectionStatus` in the ask route DOES read the prose, and it must: it
   * decides whether a rejection becomes an authorization refusal, and a missed
   * 403 would let a denied request through. This one only decides what to print,
   * and printing "HTTP 403" because the word "forbidden" appeared in a sentence
   * asserts a status nobody received.
   */
  it('never infers a status from the words in the message', () => {
    expect(carriedStatus(new Error('permission denied: not authorized'))).toBeUndefined();
  });

  it('finds a provider error code under any of the names the SDKs use', () => {
    expect(carriedProviderCode(Object.assign(new Error('x'), { error_code: 'PERMISSION_DENIED' }))).toBe(
      'PERMISSION_DENIED'
    );
    expect(carriedProviderCode(Object.assign(new Error('x'), { errorCode: 'RESOURCE_EXHAUSTED' }))).toBe(
      'RESOURCE_EXHAUSTED'
    );
    expect(carriedProviderCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
  });

  it('ignores a numeric code, which is an errno and reads as a second status', () => {
    expect(carriedProviderCode(Object.assign(new Error('x'), { code: 7 }))).toBeUndefined();
  });

  it('always produces a message, including for something nobody typed', () => {
    // The failure that produced the sentence this work replaces was a rejection
    // nobody had typed, and `String(error)` beats an empty panel.
    expect(providerFailure(new Error('socket hang up')).providerMessage).toBe('socket hang up');
    expect(providerFailure('plain string').providerMessage).toBe('plain string');
    expect(providerFailure(undefined).providerMessage).toBe('undefined');
  });

  it('reads all three at once, so a call site cannot forget one', () => {
    const error = Object.assign(new Error('Served entity is scaling up.'), {
      statusCode: 503,
      error_code: 'ENDPOINT_OVERLOADED',
    });
    expect(providerFailure(error)).toEqual({
      status: 503,
      providerCode: 'ENDPOINT_OVERLOADED',
      providerMessage: 'Served entity is scaling up.',
    });
  });
});

describe('reading evidence off the wire', () => {
  it('accepts a payload from a server one release ahead, ignoring what it cannot read', () => {
    // A partial reading of a real failure is worth more to a reader than a
    // generic sentence, which is the trade this whole module exists to reverse.
    expect(isFailureEvidence({ status: 500, somethingNewer: { a: 1 } })).toBe(true);
  });

  it('refuses a field of the wrong type rather than rendering it', () => {
    expect(isFailureEvidence({ status: '500' })).toBe(false);
    expect(isFailureEvidence({ providerMessage: 42 })).toBe(false);
    expect(isFailureEvidence(null)).toBe(false);
    expect(isFailureEvidence([])).toBe(false);
    expect(isFailureEvidence('evidence')).toBe(false);
  });

  it('accepts an empty object, which is a failure with nothing to quote', () => {
    expect(isFailureEvidence({})).toBe(true);
  });
});

describe('the taxonomy this is read alongside', () => {
  it('still refuses to let a failure carry an answer', () => {
    // Adding a field to the failure envelope is exactly when somebody widens
    // this by accident, so it is asserted from the module that added one.
    for (const definition of Object.values(FAILURE_TAXONOMY)) {
      expect(definition.mayGenerateAnswer).toBe(false);
    }
  });
});
