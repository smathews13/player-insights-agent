import { describe, expect, it } from 'vitest';
import {
  ANSWER_CONTENT_KEYS,
  TERMINAL_KINDS,
  answerContentIn,
  isUnavailableResult,
  unavailableHttpStatus,
  unavailableResult,
} from './terminal-response';

/**
 * The contract that an admitted failure carries nothing that reads as a result.
 *
 * This is the assertion the whole improvement rests on. The previous defect was
 * not a missing failure shape, it was that the failure path held a variable
 * which had to contain an answer, so the stored demo response was the shortest
 * way to satisfy the type. These tests exist so the next person who reaches for
 * the same shortcut has to delete a test that says why not.
 */

function result(overrides: Parameters<typeof unavailableResult>[0] | null = null) {
  return unavailableResult(overrides ?? { code: 'DEPENDENCY_UNAVAILABLE', requestId: 'req-1' });
}

describe('the six terminal outcomes', () => {
  it('includes both authored artifact responses', () => {
    expect([...TERMINAL_KINDS]).toEqual(['plan', 'clarification', 'report', 'dashboard', 'answer', 'unavailable']);
  });
});

describe('an unavailable result', () => {
  it('carries no takeaway, figures, charts, sources, SQL or trace', () => {
    expect(answerContentIn(result())).toEqual([]);
  });

  it('reports which forbidden key it found, so a failure names the field', () => {
    // The useful version of this assertion fires for somebody who has just
    // added the field, and a bare `false` would send them looking.
    expect(answerContentIn({ ...result(), figures: [], sql: 'SELECT 1' })).toEqual(['figures', 'sql']);
  });

  it('names every key that would make it read as an answer', () => {
    // Pinned as a list rather than derived, so widening what a failure may
    // carry is an edit to this line and therefore a decision.
    expect([...ANSWER_CONTENT_KEYS]).toEqual(['takeaway', 'narrative', 'figures', 'charts', 'sources', 'sql', 'trace']);
  });

  it('takes its message, layer and retryability from the taxonomy', () => {
    const denied = result({ code: 'USER_NOT_AUTHORIZED', requestId: 'req-2' });
    expect(denied.layer).toBe('authorization');
    expect(denied.retryable).toBe(false);
    expect(denied.message).toContain('do not have access');
  });

  it('carries the correlation id a user is meant to quote', () => {
    expect(result({ code: 'DEPENDENCY_UNAVAILABLE', requestId: 'req-abc' }).request_id).toBe('req-abc');
  });
});

describe('the facts a panel has to state and cannot guess', () => {
  it('reports never-verified as null rather than as a date', () => {
    // "Last verified: never" and "last verified: three days ago" send a reader
    // to different places. Defaulting the first to a timestamp, any timestamp,
    // makes a first deployment look like a recent outage.
    expect(result().last_verified_at).toBeNull();
  });

  it('reports persistence as unknown when nothing observed it', () => {
    // Not `not_stored`. A run whose store was the thing that failed cannot say
    // whether it was recorded, and claiming it was not is the same class of
    // error as claiming it was: asserting an outcome nobody saw.
    expect(result().persistence_status).toBe('unknown');
    expect(
      result({ code: 'DEPENDENCY_UNAVAILABLE', requestId: 'r', persistence: 'not_stored' }).persistence_status
    ).toBe('not_stored');
  });

  it('omits the execution identity entirely rather than inventing one', () => {
    expect(result().execution_identity).toBeUndefined();
    const claimed = result({
      code: 'USER_AUTH_REJECTED',
      requestId: 'r',
      executionIdentity: { mode: 'signed_in_user', verified: false },
    });
    expect(claimed.execution_identity).toEqual({ mode: 'signed_in_user', verified: false });
  });

  it('keeps operator detail out of the sentence a user reads', () => {
    const withDetail = result({
      code: 'DEPENDENCY_UNAVAILABLE',
      requestId: 'r',
      detail: 'GET /api/runs failed (code 08006)',
    });
    expect(withDetail.detail).toContain('08006');
    expect(withDetail.message).not.toContain('08006');
  });
});

describe('reaching an older browser', () => {
  it('mirrors kind onto type', () => {
    // Every existing client branch dispatches on `type`. A rolling deploy puts
    // a cached browser in front of this server, and one that does not recognise
    // `unavailable` falls through to normalising the body as an answer: empty,
    // which is survivable. Without `type` it would badge the same body a live
    // agent response, which is the failure being removed.
    const payload = result();
    expect(payload.kind).toBe('unavailable');
    expect(payload.type).toBe('unavailable');
  });

  it('recognises a payload that carries either key', () => {
    expect(isUnavailableResult(result())).toBe(true);
    expect(isUnavailableResult({ kind: 'unavailable' })).toBe(true);
    expect(isUnavailableResult({ type: 'unavailable' })).toBe(true);
    expect(isUnavailableResult({ type: 'answer' })).toBe(false);
    expect(isUnavailableResult(null)).toBe(false);
  });
});

describe('the status a route answers with', () => {
  it('comes from the code rather than from the route', () => {
    expect(unavailableHttpStatus('DEPENDENCY_UNAVAILABLE')).toBe(503);
    expect(unavailableHttpStatus('USER_NOT_AUTHORIZED')).toBe(403);
    expect(unavailableHttpStatus('RUN_DEADLINE_EXCEEDED')).toBe(504);
  });

  it('is 200 for a run that completed and found nothing usable', () => {
    // Nothing failed. The agent ran, could use none of what it read, and said
    // so. Reporting that as 5xx would page somebody for a correct outcome.
    expect(unavailableHttpStatus('NO_VALID_EVIDENCE')).toBe(200);
  });
});
