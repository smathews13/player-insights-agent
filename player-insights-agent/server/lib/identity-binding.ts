/**
 * Which principal an ask request may be executed under, decided once per request.
 *
 * Three modules meet here and each owns a different question.
 * `identity-subject.ts` answers "does the forwarded token belong to the person
 * this request says it is from", by reading the token. `terminal-response.ts`
 * answers "what shape does a request that will not be answered come back in".
 * This one answers the question neither of them can: given that binding, and
 * given where this process is running, may the request proceed, and with which
 * credential.
 *
 * IT IS THE ABSENCE OF A BRANCH THAT MATTERS HERE. There used to be one path
 * through the ask route for a request whose token worked and another for a
 * request whose token did not, and the second called the endpoint with the app's
 * own service principal. So a reader could be shown an answer computed under an
 * application's grants on a screen that said their access had been checked. This
 * module produces either a credential to execute as, or a refusal. There is no
 * third return value, and that is deliberately a property of the type rather
 * than of anybody's care at the call site.
 *
 * THE VOCABULARY OF `mode` IS DEFINED HERE, which `terminal-response.ts` defers
 * to by typing it as a string.
 */

import type { Request } from 'express';

import { CORRELATION_HEADER, mintCorrelationId, usableCorrelationId } from '../../shared/correlation';
import { type FailureCode } from '../../shared/failure-taxonomy';
import type { ExecutionIdentityClaim } from '../../shared/terminal-response';
import { forwardedUserToken } from '../routes/access-verification';
import { bindTokenToUser, bindingFailure, describeBinding, isVerified, type SubjectBinding } from './identity-subject';

/** Which principal a request asked to be executed as. */
export type IdentityMode =
  /** The signed-in human, whose token was forwarded. The only customer mode. */
  | 'signed_in_user'
  /**
   * An admin-assigned service principal, when the experimental SP-identity
   * pivot is on and a token could be minted for that persona.
   *
   * The signed-in human is still `email`; this mode only names the credential
   * downstream Databricks APIs see. Unassigned users never reach it.
   */
  | 'assigned_service_principal'
  /**
   * The app's own service principal.
   *
   * Named so a record can state that a run was NOT executed as its reader,
   * which is a fact worth being able to write down. No ask path may request it:
   * it is reachable only on a laptop, where there is no Apps proxy and so no
   * user to be.
   */
  | 'app_service_principal';

export const SIGNED_IN_USER: IdentityMode = 'signed_in_user';
export const ASSIGNED_SERVICE_PRINCIPAL: IdentityMode = 'assigned_service_principal';
export const APP_SERVICE_PRINCIPAL: IdentityMode = 'app_service_principal';

/** The identity a request is allowed to proceed under. */
export interface BoundIdentity {
  ok: true;
  /** The signed-in user, as `x-forwarded-email` gave them. */
  email: string;
  /**
   * The forwarded bearer token, or '' when running locally with no proxy.
   *
   * Carried on this object rather than read again at the call site so there is
   * one place a reviewer can watch the credential enter and leave. It is passed
   * to exactly one function, and it is never logged, traced or stored.
   */
  token: string;
  /**
   * Whether the token was PROVEN to belong to `email`.
   *
   * False is ordinary rather than alarming: an opaque token states no subject
   * to check. It travels with the run so that no surface claims the identity
   * was confirmed when only the platform's word was taken for it.
   */
  verified: boolean;
  mode: IdentityMode;
  /**
   * The assigned persona when {@link mode} is `assigned_service_principal`.
   * Display only — never a secret.
   */
  persona?: { id: string; displayName: string; clientId: string };
  requestId: string;
  /**
   * The id every cross-system record of this question carries.
   *
   * The browser's, when it sent one this server will print; otherwise
   * `requestId`, so a caller that sends nothing is exactly where it was. See
   * `shared/correlation.ts` for why this is not `requestId` itself and not the
   * ledger's primary key.
   */
  correlationId: string;
}

export interface IdentityRefused {
  ok: false;
  code: FailureCode;
  /**
   * For the server log only. Names both identities in play, which is exactly
   * what must not reach the caller: telling somebody which subject we resolved
   * tells them what to present next.
   */
  detail: string;
  requestId: string;
  correlationId: string;
}

export type IdentityDecision = BoundIdentity | IdentityRefused;

export interface DecideOptions {
  /** The signed-in user the route resolved, already known to be present. */
  signedInAs: string;
  /**
   * Whether a forwarded token is mandatory.
   *
   * True for the deployed app, where its absence means the platform is not
   * forwarding one and no request can be attributed to anybody. False on a
   * laptop, where there is no proxy to forward anything: refusing there would
   * make the app impossible to run locally without a switch to turn the check
   * off, and a switch to turn the check off is the thing that ends up set in
   * production.
   */
  required: boolean;
  /** Unix seconds, injected so a token expiry can be tested without waiting. */
  now?: number;
}

/**
 * Decide whether this request runs, and under whose credential.
 */
export function decideIdentity(req: Request, options: DecideOptions): IdentityDecision {
  const requestId = mintCorrelationId();
  // Taken before the identity check, so a refusal is joinable to the browser's
  // record of it too. A question that was never allowed to run is the one a
  // reader is most likely to come back and ask about.
  const correlationId = usableCorrelationId(req.headers?.[CORRELATION_HEADER]) ?? requestId;
  const token = forwardedUserToken(req);
  const binding = bindTokenToUser(token, options.signedInAs, { now: options.now });

  if (binding.kind === 'absent' && !options.required) {
    // A laptop. There is no user to execute as, and the run says so rather than
    // implying one: `app_service_principal` is a truthful label for what is
    // about to happen, and the deployed app cannot reach this branch.
    return {
      ok: true,
      email: options.signedInAs,
      token: '',
      verified: false,
      mode: APP_SERVICE_PRINCIPAL,
      requestId,
      correlationId,
    };
  }

  const failure = bindingFailure(binding);
  if (failure) {
    return {
      ok: false,
      code: failure,
      requestId,
      correlationId,
      detail: describeBinding(binding, options.signedInAs),
    };
  }

  // `bound` or `unverifiable`. Both proceed as the user, and only the first
  // claims to have been checked; see the asymmetry documented on
  // `bindTokenToUser`. An unverifiable token is safe to forward precisely
  // because the endpoint holds its own invoker against the user this request
  // names, and because the app principal is no longer reachable from here.
  return {
    ok: true,
    email: options.signedInAs,
    token: token ?? '',
    verified: isVerified(binding),
    mode: SIGNED_IN_USER,
    requestId,
    correlationId,
  };
}

/** What a decision asserts about the run, for the record and the response. */
export function executionIdentityClaim(decision: BoundIdentity): ExecutionIdentityClaim {
  return { mode: decision.mode, verified: decision.verified };
}

/**
 * The claim to attach to a request that never executed.
 *
 * Always unverified, and always the mode that was ASKED for. A refusal is not
 * an execution, so recording what it would have run as would be recording
 * something that did not happen.
 */
export function refusedIdentityClaim(): ExecutionIdentityClaim {
  return { mode: SIGNED_IN_USER, verified: false };
}

/** A refusal, as a log line. Carries the detail, and never the token. */
export function describeRefusal(refusal: IdentityRefused): string {
  // The correlation id rather than the request id, because this line exists to
  // be found by somebody holding the id the browser showed them. The two are the
  // same value unless the browser minted one, which is exactly the case where
  // printing the other would make the line unfindable.
  return `[identity] REFUSED ${refusal.code} (${refusal.correlationId}): ${refusal.detail}.`;
}

/**
 * The `detail` a refusal may be sent to the browser with.
 *
 * `IdentityRefused.detail` names both identities in play, and `detail` on a
 * terminal result is carried in the response body rather than kept server-side.
 * Telling somebody which subject we resolved for their token tells them what to
 * present next, so the two audiences get two strings: this one, and the log line
 * above it, joined by the correlation id the reader is given to quote.
 */
export function disclosableRefusal(refusal: IdentityRefused): string {
  return refusal.code === 'IDENTITY_MISMATCH'
    ? 'The signed-in user could not be matched to the credential this request carried.'
    : 'This request carried no identity the app could execute it as.';
}

/**
 * How the endpoint's rejection of the user's credential is classified.
 *
 * 401 and 403 were previously the same event, because both led to the same
 * retry. They are not: the credential was not accepted, versus the credential
 * was accepted and the account behind it may not read what the question needs.
 * Only the second is about the reader's grants, and only the second gives them
 * a sentence they can act on.
 */
export function authorizationFailureFor(status: number): FailureCode | null {
  if (status === 401) return 'USER_AUTH_REJECTED';
  if (status === 403) return 'USER_NOT_AUTHORIZED';
  return null;
}

export type { SubjectBinding };
