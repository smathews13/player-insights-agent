import { describe, expect, it } from 'vitest';

import { FAILURE_TAXONOMY } from '../../shared/failure-taxonomy';
import { answerContentIn } from '../../shared/terminal-response';
import { readAgentRefusal, UNKNOWN_CODE_FALLBACK } from './agent-refusal';

const CONTEXT = { requestId: 'req-app-1' };

/**
 * A response shaped the way `agent/execution_identity.py` actually builds one:
 * the refusal sentence in a text output item, and the machine-readable half in
 * `custom_outputs`. The text item is not incidental. It is what made the
 * refusal match the prose branch of the ask route.
 */
function refusal(outputs: Record<string, unknown> = {}) {
  return {
    output: [
      {
        type: 'message',
        id: 'response-identity_mismatch',
        text: 'The request could not be executed with your permissions.',
      },
    ],
    custom_outputs: {
      type: 'unavailable',
      code: 'IDENTITY_MISMATCH',
      layer: 'identity',
      retryable: false,
      message: 'The request could not be executed with your permissions.',
      request_id: 'req-app-1',
      run_id: 'run-7',
      execution_identity: { mode: 'signed_in_user', verified: false },
      ...outputs,
    },
  };
}

describe('reading a refusal the endpoint returned inside a 200', () => {
  it('reads the agent refusal as a terminal unavailable', () => {
    const result = readAgentRefusal(refusal(), CONTEXT);
    expect(result).toMatchObject({
      kind: 'unavailable',
      type: 'unavailable',
      code: 'IDENTITY_MISMATCH',
      layer: 'identity',
      retryable: false,
      request_id: 'req-app-1',
      persistence_status: 'not_stored',
    });
  });

  it.each(['IDENTITY_REQUIRED', 'IDENTITY_MISMATCH', 'USER_AUTH_REJECTED', 'USER_NOT_AUTHORIZED'] as const)(
    'reads %s, which are the codes the identity gate emits',
    (code) => {
      expect(readAgentRefusal(refusal({ code }), CONTEXT)?.code).toBe(code);
    }
  );

  it('keeps the sentence the agent wrote, which is the layer that knows what fired', () => {
    const result = readAgentRefusal(
      refusal({ message: 'The request could not be executed with your permissions.' }),
      CONTEXT
    );
    expect(result?.message).toBe('The request could not be executed with your permissions.');
  });

  it('falls back to the taxonomy when the agent sent no sentence', () => {
    const result = readAgentRefusal(refusal({ message: '' }), CONTEXT);
    expect(result?.message).toBe(FAILURE_TAXONOMY.IDENTITY_MISMATCH.uiMessage);
  });

  /**
   * The endpoint does not get to decide this. A refusal it marked retryable is
   * a refusal something would retry, and the only way a retry of a refused
   * identity succeeds is by asking as a different one.
   */
  it('takes retryability from the taxonomy even when the endpoint claimed otherwise', () => {
    const result = readAgentRefusal(refusal({ retryable: true }), CONTEXT);
    expect(result?.retryable).toBe(false);
  });

  /**
   * The two ids are the same on every healthy path. When they are not, the one
   * in this server's own log is the one a support conversation can find.
   */
  it('reports the request id this server logged, not the one echoed back', () => {
    const result = readAgentRefusal(refusal({ request_id: 'req-something-else' }), CONTEXT);
    expect(result?.request_id).toBe('req-app-1');
  });

  /**
   * Nothing was written before the endpoint was called, so naming a run would
   * hand the reader a correlation id that finds nothing when they quote it.
   */
  it('names no run, because the refusal created none', () => {
    expect(readAgentRefusal(refusal(), CONTEXT)?.run_id).toBeNull();
  });
});

/**
 * THE ORACLE IS THE IDENTITY. None of these assert what data came back, which
 * in a workspace where every principal reads the same tables would be either
 * theatre or a false pass. They assert what the response SAYS about who ran it.
 */
describe('what the refusal claims about who was executing', () => {
  it('carries the mode the agent reported', () => {
    const result = readAgentRefusal(refusal(), CONTEXT);
    expect(result?.execution_identity).toEqual({ mode: 'signed_in_user', verified: false });
  });

  /**
   * The single most important assertion in this file. `verified` is the
   * difference between "the endpoint held its invoker against the user we named
   * and they matched" and "nobody checked". Every wrong answer this flag can
   * give is in the direction of claiming a check that did not happen, so only
   * an exact boolean true counts.
   */
  it.each([
    ['a string', 'true'],
    ['the number one', 1],
    ['a missing field', undefined],
    ['null', null],
  ])('does not let %s count as a verified identity', (_label, verified) => {
    const result = readAgentRefusal(refusal({ execution_identity: { mode: 'signed_in_user', verified } }), CONTEXT);
    expect(result?.execution_identity?.verified).toBe(false);
  });

  it('claims no identity at all when the agent named none', () => {
    expect(readAgentRefusal(refusal({ execution_identity: undefined }), CONTEXT)?.execution_identity).toBeUndefined();
    expect(readAgentRefusal(refusal({ execution_identity: 'nope' }), CONTEXT)?.execution_identity).toBeUndefined();
  });

  /**
   * A refusal that reports `service_principal` is the endpoint saying it did
   * NOT run as the reader. That has to survive to the record intact: it is the
   * only evidence that the fallback this workstream deleted has not come back
   * somewhere else.
   */
  it('preserves a service_principal claim rather than normalising it away', () => {
    const result = readAgentRefusal(
      refusal({ execution_identity: { mode: 'service_principal', verified: false } }),
      CONTEXT
    );
    expect(result?.execution_identity?.mode).toBe('service_principal');
  });
});

describe('a refusal spelled in a vocabulary this build predates', () => {
  /**
   * The app and the model are released separately and in either order. A code
   * from a newer model version is still a refusal, and continuing to an answer
   * because the reason was unfamiliar is the one outcome that is not allowed.
   */
  it('is still a refusal', () => {
    const result = readAgentRefusal(refusal({ code: 'IDENTITY_ROTATED' }), CONTEXT);
    expect(result?.kind).toBe('unavailable');
    expect(result?.code).toBe(UNKNOWN_CODE_FALLBACK);
  });

  it('says in the operator detail that the two halves are not from one release', () => {
    const result = readAgentRefusal(refusal({ code: 'IDENTITY_ROTATED' }), CONTEXT);
    expect(result?.detail).toContain('IDENTITY_ROTATED');
    expect(result?.detail).toContain('not from the same release');
  });

  it.each([
    ['a missing code', undefined],
    ['a numeric code', 7],
    ['an empty code', ''],
  ])('treats %s as a refusal rather than as no refusal', (_label, code) => {
    expect(readAgentRefusal(refusal({ code }), CONTEXT)?.kind).toBe('unavailable');
  });
});

/**
 * The regression this module exists for, asserted from the shape that caused
 * it. A refusal must not be mistaken for one of the four ordinary outcomes, and
 * an ordinary outcome must not be mistaken for a refusal.
 */
describe('telling a refusal apart from an answer', () => {
  it('does not see a refusal in a plan, a clarification or an answer', () => {
    for (const type of ['plan', 'clarification', 'answer', 'preflight_retired']) {
      expect(readAgentRefusal({ custom_outputs: { type } }, CONTEXT)).toBeNull();
    }
  });

  it('does not see a refusal where there are no custom outputs at all', () => {
    expect(readAgentRefusal({ output: [{ text: 'hello' }] }, CONTEXT)).toBeNull();
    expect(readAgentRefusal({}, CONTEXT)).toBeNull();
    expect(readAgentRefusal(null, CONTEXT)).toBeNull();
    expect(readAgentRefusal('a string', CONTEXT)).toBeNull();
    expect(readAgentRefusal({ custom_outputs: ['unavailable'] }, CONTEXT)).toBeNull();
  });

  /**
   * The refusal body carries prose, and the prose branch of the ask route is
   * the one that fills figures, charts, sources and SQL from the stored demo
   * answer. Reading `custom_outputs` rather than the text is what stops that,
   * so the text being present and plausible is part of the fixture.
   */
  it('reads the machine-readable half, not the sentence that fooled the prose branch', () => {
    const withProse = readAgentRefusal(refusal(), CONTEXT);
    expect(withProse?.code).toBe('IDENTITY_MISMATCH');
    const withoutProse = readAgentRefusal({ custom_outputs: refusal().custom_outputs }, CONTEXT);
    expect(withoutProse?.code).toBe('IDENTITY_MISMATCH');
  });

  /**
   * The contract that makes an `unavailable` worth returning. If a refusal can
   * carry a figure, the shortest way to compile a failure path is to fill it.
   */
  it('carries no takeaway, narrative, figure, chart, source, SQL or trace', () => {
    expect(answerContentIn(readAgentRefusal(refusal(), CONTEXT))).toEqual([]);
  });

  it('carries none of them even when the endpoint tried to attach some', () => {
    const result = readAgentRefusal(
      refusal({
        takeaway: 'Active players rose 12%',
        figures: [{ label: 'players', value: 1 }],
        sql: 'SELECT 1',
      }),
      CONTEXT
    );
    expect(answerContentIn(result)).toEqual([]);
  });
});
