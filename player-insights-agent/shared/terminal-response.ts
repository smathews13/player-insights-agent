/**
 * The four ways a request is allowed to end, and the shape of the fourth.
 *
 * Every ask request terminates as exactly one of `plan`, `clarification`,
 * `answer` or `unavailable`. Three of those already existed and are unchanged.
 * `unavailable` is the one this module adds, and its whole purpose is to be the
 * thing a surface returns INSTEAD OF making something up.
 *
 * WHY THE CONTRACT IS ENFORCED RATHER THAN DOCUMENTED. The defect this replaces
 * was not that the app lacked a failure shape. It was that the failure path
 * reached the end of a function holding a variable that had to contain an
 * answer, so filling it with the stored demo response was the shortest way to
 * compile. An `unavailable` result that merely OUGHT not to carry figures would
 * be filled the same way within a release. So {@link answerContentIn} names the
 * keys that must never appear on one, {@link unavailableResult} cannot produce
 * them, and a test asserts it.
 *
 * WHAT THIS IS NOT. It is not a general error envelope for every route. The
 * list routes answer with arrays and say what they are through headers; see
 * `markResponse` in server/lib/lakebase-store.ts. This is for the surfaces that
 * would otherwise render content: Ask, one run's trace, and anything that reads
 * as a result.
 */
import { failureDefinition, type FailureCode, type FailureLayer } from './failure-taxonomy';
import type { FailureEvidence } from './failure-evidence';
import type { AppBudgetStatus } from './app-budget-guard';

/** The four terminal outcomes. Exactly one of these ends a request. */
export const TERMINAL_KINDS = ['plan', 'clarification', 'answer', 'unavailable'] as const;
export type TerminalKind = (typeof TERMINAL_KINDS)[number];

/**
 * Whether the run behind this outcome was durably recorded.
 *
 * `unknown` is a real member and not a placeholder: a run whose store was
 * itself the thing that failed cannot say, and reporting that as `not_stored`
 * would be the same class of lie this module exists to remove, asserting a
 * failure nobody observed.
 */
export type PersistenceStatus = 'stored' | 'not_stored' | 'unknown';

/**
 * Who the work ran as, when something knows.
 *
 * The vocabulary of `mode` belongs to the signed-in-user execution workstream,
 * not to this file, so it is typed as a string here on purpose. This module
 * owns the envelope; it does not get to name the identities that go in it.
 */
export interface ExecutionIdentityClaim {
  mode: string;
  verified: boolean;
}

export interface UnavailableResult {
  kind: 'unavailable';
  /**
   * Mirrors `kind`, because every existing client branch dispatches on `type`
   * and a rolling deploy puts an old browser in front of a new server. An old
   * client meeting `type: 'unavailable'` falls through its plan and
   * clarification checks and normalises the body as an answer, which yields an
   * empty card rather than a wrong one. Dropping `type` would badge it a live
   * agent response instead, which is precisely the failure being removed.
   */
  type: 'unavailable';
  code: FailureCode;
  layer: FailureLayer;
  retryable: boolean;
  /** The sentence to show. Taken from the taxonomy unless a caller overrides it. */
  message: string;
  /**
   * The id a user quotes to support. Required, because "give us the correlation
   * ID" is the whole reason a failure panel is more useful than a red triangle,
   * and an optional one is absent exactly when somebody needs it.
   */
  request_id: string;
  /** The run this would have been, when one was created before the failure. */
  run_id: string | null;
  /**
   * When this surface last had a verified answer from what it depends on, or
   * null if it never has. Null and "a long time ago" are different facts and a
   * reader acts differently on them, so null is not rendered as a date.
   */
  last_verified_at: string | null;
  persistence_status: PersistenceStatus;
  execution_identity?: ExecutionIdentityClaim;
  /**
   * Operator detail. Never rendered as the user-facing sentence.
   *
   * Split from `message` because the two have different audiences and different
   * disclosure rules: this one may name a route, an SQLSTATE or an endpoint,
   * and `message` may not.
   *
   * SUPERSEDED BY `evidence` for anything a reader should see. It is kept
   * because several call sites have a sentence and no structure to put it in,
   * and because dropping it would take the only account of those failures off
   * the wire; a client with no `evidence` renders this as the error line rather
   * than showing nothing. New call sites should populate `evidence` instead: a
   * status a renderer can find beats a status buried in a sentence.
   */
  detail?: string;
  /**
   * The failure in named fields: which dependency, what it said, where it
   * stopped, who it ran as.
   *
   * Optional, and that is not a soft requirement dressed as a field. It is
   * genuinely absent for failures that have no downstream provider to quote --
   * a malformed idempotency key never reached anything. What it must not be is
   * absent because a call site did not bother, which is why
   * `insights-routes.test.ts` asserts it on the serving failure paths.
   */
  evidence?: FailureEvidence;
  /** Safe authoritative status when an app-budget guard refused a new Ask. */
  budget_status?: AppBudgetStatus;
}

/**
 * The keys that turn an `unavailable` into a fabrication.
 *
 * Named as data rather than checked inline so the test and the guard read the
 * same list, and so adding a field to the answer contract prompts a decision
 * here rather than silently widening what a failure may carry.
 */
export const ANSWER_CONTENT_KEYS = ['takeaway', 'narrative', 'figures', 'charts', 'sources', 'sql', 'trace'] as const;

/**
 * Which forbidden keys a value carries, in the order above. Empty is the pass.
 *
 * Returns the offending keys rather than a boolean so a failure says which one,
 * because the useful version of this assertion fires in a test written by
 * somebody who has just added the field it is complaining about.
 */
export function answerContentIn(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return ANSWER_CONTENT_KEYS.filter((key) => record[key] !== undefined);
}

export interface UnavailableInput {
  code: FailureCode;
  requestId: string;
  runId?: string | null;
  lastVerifiedAt?: string | null;
  persistence?: PersistenceStatus;
  executionIdentity?: ExecutionIdentityClaim;
  /** Operator detail, not shown as the headline. */
  detail?: string;
  /** The named fields behind the failure. See {@link UnavailableResult.evidence}. */
  evidence?: FailureEvidence;
  budgetStatus?: AppBudgetStatus;
  /**
   * Overrides the taxonomy's sentence.
   *
   * Rarely right. The taxonomy exists so one outage reads the same way on every
   * surface, and a per-call-site sentence is how that came apart last time. Use
   * it when a surface can say something materially more actionable, and put the
   * reason in a comment at the call site.
   */
  message?: string;
}

export function unavailableResult(input: UnavailableInput): UnavailableResult {
  const definition = failureDefinition(input.code);
  const result: UnavailableResult = {
    kind: 'unavailable',
    type: 'unavailable',
    code: definition.code,
    layer: definition.layer,
    retryable: definition.retryable,
    message: input.message ?? definition.uiMessage,
    request_id: input.requestId,
    run_id: input.runId ?? null,
    last_verified_at: input.lastVerifiedAt ?? null,
    persistence_status: input.persistence ?? 'unknown',
  };
  if (input.executionIdentity) result.execution_identity = input.executionIdentity;
  if (input.detail) result.detail = input.detail;
  if (input.evidence) result.evidence = input.evidence;
  if (input.budgetStatus) result.budget_status = input.budgetStatus;
  return result;
}

export function isUnavailableResult(value: unknown): value is UnavailableResult {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'unavailable' || record.type === 'unavailable';
}

/**
 * The HTTP status for a code, so a route does not pick its own.
 *
 * Separate from the builder because the status is a property of the transport
 * and the payload is not: the SSE path has already flushed its headers by the
 * time it knows, and reports the same outcome in the body alone.
 */
export function unavailableHttpStatus(code: FailureCode): number {
  return failureDefinition(code).httpStatus;
}
