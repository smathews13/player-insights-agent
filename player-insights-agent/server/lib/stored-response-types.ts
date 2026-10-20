/**
 * Every response type the ask route can store in `messages.response_json`, and
 * the builders for the ones that are not plain answers.
 *
 * Run lists (rail badge, Run Explorer, Monitoring, Ops, spend) admit a stored
 * turn only when `response_json.trace` is an object. A type that stores its trace
 * somewhere else, or none, silently disappears from all of them. That happened to
 * reports and dashboards, and `stored-response-types.test.ts` now fails, naming the
 * type, when a stored type neither carries a top-level trace nor sits on
 * {@link RUNLESS_STORED_RESPONSE_TYPES} with a reason.
 */

export const STORED_RESPONSE_TYPES = ['answer', 'plan', 'clarification', 'dashboard', 'report'] as const;
export type StoredResponseType = (typeof STORED_RESPONSE_TYPES)[number];

/**
 * Stored types that are deliberately not runs, each with the reason. Adding a type
 * here is a decision that its turns never appear in run lists or spend.
 */
export const RUNLESS_STORED_RESPONSE_TYPES: Partial<Record<StoredResponseType, string>> = {
  plan: 'A plan executed nothing: it waits for approval, and the approved execution is its own run.',
};

export function planStoredResponse(plan: unknown, supersededApprovalId?: string | null) {
  return {
    type: 'plan' as const,
    mode: 'live' as const,
    plan,
    // Recorded on the response, and so into `response_json`, because a re-issue is
    // the interesting event when someone asks later why an approval did not run.
    ...(supersededApprovalId ? { supersededApprovalId } : {}),
  };
}

/**
 * A clarification is a turn of the conversation and so a run: its trace is stored
 * at the top level, where the run lists read it, as well as inside `clarification`.
 */
export function clarificationStoredResponse<T, Tr>(clarification: T, trace: Tr) {
  return { type: 'clarification' as const, mode: 'live' as const, clarification, trace };
}

/** A built dashboard or report, with the run trace the run lists read. */
export function documentStoredResponse<K extends 'dashboard' | 'report', D, Tr>(
  kind: K,
  id: string,
  document: D,
  trace: Tr
) {
  return { type: kind, mode: 'live' as const, id, [kind]: document, trace } as {
    type: K;
    mode: 'live';
    id: string;
    trace: Tr;
  } & Record<K, D>;
}
