/**
 * The endpoint refusing a request from inside an HTTP 200.
 *
 * `invokeServingAsUser` turns a 401 or a 403 from Model Serving into an
 * `AuthorizationRefused`, which the ask route answers as `unavailable`. That
 * covers the endpoint declining to run the invocation at all. It does not cover
 * the case this module exists for: the invocation SUCCEEDS, and the agent
 * inside it declines the turn.
 *
 * `agent/execution_identity.py` is that gate, and it cannot answer with a
 * status. A Model Serving container returns 200 for anything it managed to
 * produce, so the agent's refusal arrives as `custom_outputs.type` set to
 * `unavailable`, in a body that is otherwise a perfectly ordinary response.
 *
 * WHAT HAPPENED WITHOUT THIS, and it is worse than the fallback the workstream
 * set out to delete. The ask route reads five shapes: plan, clarification,
 * report, structured answer, and prose. A refusal is none of them, but it is not
 * nothing either: the agent puts its refusal sentence in a text output item, and
 * `extractLiveText` walks `output[].text` and finds it. So the refusal matched
 * the PROSE branch, which is the branch that keeps the agent's words and fills
 * the figures, charts, sources and SQL from the stored demo answer. A reader
 * refused on identity grounds was shown the demo dataset, over HTTP 200, badged
 * `type: 'answer'` and `mode: 'live'`, with "The request could not be executed
 * with your permissions" written above it as the takeaway.
 *
 * So this is read BEFORE any of the five, and it is read off `custom_outputs`
 * rather than off the prose, because the prose is what made the bug.
 */

import { isFailureCode, type FailureCode } from '../../shared/failure-taxonomy';
import { unavailableResult, type ExecutionIdentityClaim, type UnavailableResult } from '../../shared/terminal-response';

/** The `custom_outputs.type` the agent sets when it refused the turn. */
export const UNAVAILABLE_TYPE = 'unavailable';

/**
 * What a code this build has never heard of is treated as.
 *
 * A refusal, always. The agent said it would not run the turn, and the only
 * thing that must not happen is the request continuing on to an answer because
 * the reason was spelled in a vocabulary this release predates. `contract` is
 * the honest layer for it: the two halves of the deployment disagree, which is
 * app-versus-model skew rather than anything about the reader.
 */
export const UNKNOWN_CODE_FALLBACK: FailureCode = 'OUTPUT_SCHEMA_VIOLATION';

export interface RefusalContext {
  /**
   * The id this server generated and logged for the request.
   *
   * Preferred over the one the endpoint echoes back. They are the same value on
   * every healthy path, and when they are not, the one the app wrote in its own
   * log is the one a support conversation can find.
   */
  requestId: string;
}

/**
 * Read the agent's refusal out of an endpoint response, or `null`.
 *
 * `null` means the response was not a refusal, and the caller carries on to the
 * five ordinary shapes. It is deliberately the only way to carry on: anything
 * that looks like a refusal and cannot be parsed is still returned as one.
 */
export function readAgentRefusal(payload: unknown, context: RefusalContext): UnavailableResult | null {
  const outputs = customOutputs(payload);
  if (!outputs || outputs.type !== UNAVAILABLE_TYPE) return null;

  const declared = outputs.code;
  const code = isFailureCode(declared) ? declared : UNKNOWN_CODE_FALLBACK;
  const message = text(outputs.message);
  const detail = isFailureCode(declared)
    ? `The agent endpoint refused this turn with ${code}.`
    : `The agent endpoint refused this turn with ${JSON.stringify(declared)}, which this build ` +
      `does not know. Reported as ${UNKNOWN_CODE_FALLBACK}: the app and the model version are ` +
      'not from the same release.';

  return unavailableResult({
    code,
    requestId: context.requestId,
    // The agent creates no durable run of its own, and the app has not written
    // one at this point either. Naming an id here would hand the reader a
    // correlation id that finds nothing.
    runId: null,
    persistence: 'not_stored',
    executionIdentity: executionIdentity(outputs),
    // Kept when the agent sent one: it is the layer that knows WHICH identity
    // condition fired, and its sentence is already written for a reader. The
    // code still decides the status and the retryability.
    ...(message ? { message } : {}),
    detail,
  });
}

/**
 * What the agent said it was executing as, with nothing upgraded.
 *
 * `verified` is only true when the endpoint sent exactly `true`. A missing
 * field, a string, or a truthy value of any other kind reads as unverified,
 * because this flag is the difference between "we checked" and "we assumed",
 * and every wrong answer it can give is in the direction of claiming a check
 * that did not happen.
 */
function executionIdentity(outputs: Record<string, unknown>): ExecutionIdentityClaim | undefined {
  const claim = outputs.execution_identity;
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return undefined;
  const record = claim as Record<string, unknown>;
  const mode = text(record.mode);
  if (!mode) return undefined;
  return { mode, verified: record.verified === true };
}

function customOutputs(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const outputs = (payload as { custom_outputs?: unknown }).custom_outputs;
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return null;
  return outputs as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
