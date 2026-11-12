/**
 * Whether the credential a benchmark suite is executing under will last long
 * enough to finish it, and what to do at the moment it does not.
 *
 * WHY THIS IS ITS OWN PROBLEM. Everywhere else in the app, a forwarded token is
 * used once, inside one HTTP request, and its lifetime is somebody else's
 * concern. A benchmark suite is the exception: it is started by one request and
 * then runs unattended for minutes, invoking the endpoint once per case with a
 * token that was minted for a request that returned long ago. So a suite can
 * outlive its own credential, and the interesting question is what happens on
 * the case after that.
 *
 * THE ANSWER MUST NOT BE "CARRY ON AS THE APPLICATION". That is the exact defect
 * the whole user-authorization workstream exists to delete, and reintroducing it
 * here would be the worst place to have it: on a surface that produces numbers
 * people quote, where half a suite scored under a reader's grants and half under
 * an application's would still render as one run with one pass rate. There is no
 * re-identification path in this module, and there is nothing for one to be
 * built out of: it decides only whether the run may CONTINUE.
 *
 * So the design is two checks and no fallback, and they divide the problem
 * between them rather than overlapping.
 *
 *  1. BEFORE THE RUN STARTS, refuse if the token says it expires before the
 *     suite's own budget runs out. The suite cannot promise to finish, so it
 *     does not start, and the person is told while they are still looking at
 *     the screen rather than four minutes later. This is `coverage`, below.
 *  2. WHEN THE ENDPOINT REFUSES an identity-layer failure mid-suite, the run
 *     stops there and the cases it never reached are recorded as never reached.
 *     This is `endsTheSuite`, below, applied by the runner.
 *
 * THERE IS DELIBERATELY NO THIRD CHECK BETWEEN CASES, and the reason is worth
 * writing down because it looks like an omission. One was written and removed.
 * Check 1 guarantees `expiry >= start + budget`, and the runner abandons the
 * suite once `now - start > budget`, so a credential with a readable expiry can
 * never be observed dead at a case boundary: the budget runs out first, every
 * time, by construction. A credential with an unreadable expiry cannot be
 * checked at a boundary at all. So a between-cases check fires in exactly no
 * situation, and a check that cannot fire is worse than no check, because the
 * next reader takes it for the protection it appears to be.
 *
 * What is left uncovered by check 1 is real and is covered by check 2: a clock
 * that disagrees with the issuer's, a token revoked rather than expired, and
 * the one case a suite is allowed to overrun its budget by (the budget is
 * tested between cases, so the last case may start just inside it and run for
 * its full turn timeout). In all three the endpoint is the thing that finds
 * out, which is the correct authority anyway.
 *
 * A TOKEN THAT DECLARES NO EXPIRY IS NOT REFUSED, which mirrors the asymmetry
 * `identity-subject.ts` documents at length and is the same judgement: a
 * personal access token is an opaque string, it states no `exp`, and a rule that
 * refused every credential it could not read the lifetime of would take the
 * Benchmark Lab down in any workspace that issues them, on a check that would
 * have fired correctly zero times. Those runs rely entirely on check 2, and the
 * run records that its credential's lifetime was unknown so that a truncated one
 * is explicable afterwards.
 */

import { FAILURE_TAXONOMY, type FailureCode } from '../../shared/failure-taxonomy';
import { readTokenClaims } from './identity-subject';

/**
 * Clock difference assumed between this container and the token's issuer, added
 * to what a suite is required to have left before it may start.
 *
 * The same magnitude as `identity-subject.ts`'s tolerance and the opposite sign,
 * which is the point. That one is generous, because refusing a live token costs
 * a user their request. This one is strict, because over-estimating how long a
 * credential has left costs a suite its second half. Both are a minute because
 * both are guarding against the same NTP drift.
 */
export const CLOCK_SKEW_MS = 60_000;

/** What a credential says about how long it is good for. */
export interface CredentialLifetime {
  /** Unix ms the credential stops being accepted, or null when it does not say. */
  expiresAtMs: number | null;
  /**
   * Why the expiry is unknown, for the run's own record. Empty when it is known.
   *
   * Carried as a sentence rather than a boolean because it ends up on a stored
   * row that somebody reads weeks later, and "the token was opaque" is the
   * difference between a run that was truncated for a reason and one that looks
   * like it stopped for no reason.
   */
  unknownReason: string;
}

/**
 * Read how long a forwarded token is good for.
 *
 * NOTHING ELSE FROM THE TOKEN IS READ, and the token itself never leaves this
 * function. `exp` is the one claim a long-running run needs, and the rule in
 * `identity-subject.ts` that no claim may be logged, traced or stored applies
 * here unchanged: the value that leaves is a timestamp, which is not a
 * credential.
 */
export function credentialLifetime(token: string): CredentialLifetime {
  if (!token || !token.trim()) {
    return {
      expiresAtMs: null,
      unknownReason: 'there is no forwarded token, so this run has no credential lifetime to reason about',
    };
  }
  const claims = readTokenClaims(token);
  if (!claims) {
    return {
      expiresAtMs: null,
      unknownReason:
        'the token is opaque rather than a JWT, so it declares no expiry and the run cannot be ' +
        'checked against one ahead of time',
    };
  }
  const expiry = claims.exp;
  if (typeof expiry !== 'number' || !Number.isFinite(expiry)) {
    return {
      expiresAtMs: null,
      unknownReason: 'the token carries no readable exp claim, so it does not say when it stops working',
    };
  }
  return { expiresAtMs: Math.round(expiry * 1000), unknownReason: '' };
}

/** Whether a credential can cover a whole suite, decided before one starts. */
export type SuiteCoverage =
  | { covered: true; note: string }
  | { covered: false; code: FailureCode; message: string; detail: string };

/**
 * Decide whether to start a suite at all.
 *
 * Checked against the suite's BUDGET rather than against how long a suite
 * usually takes. The budget is the only bound the runner actually enforces, so
 * it is the only one a promise to finish can be made against; six cases take
 * about four and a half minutes against a twenty minute budget, so this is
 * conservative by roughly a factor of four and refuses almost nothing in
 * practice. Being conservative is the right direction: the cost of refusing a
 * suite that would have finished is that somebody signs in again, and the cost
 * of starting one that cannot finish is several minutes of endpoint time spent
 * producing a run whose second half does not exist.
 */
export function coverage(lifetime: CredentialLifetime, nowMs: number, budgetMs: number): SuiteCoverage {
  if (lifetime.expiresAtMs === null) {
    return {
      covered: true,
      note:
        `The credential's lifetime could not be read (${lifetime.unknownReason}), so this run was not ` +
        'checked against the suite budget before it started. Nothing checks it again either: if it ' +
        'expires mid-suite the endpoint is what refuses, and the run stops there and records how far ' +
        'it got rather than continuing under any other identity.',
    };
  }
  const remainingMs = lifetime.expiresAtMs - nowMs;
  // The skew is added to what the suite needs rather than to what the token
  // has, so a container running behind the issuer refuses a marginal run rather
  // than starting one that dies in its last case.
  if (remainingMs >= budgetMs + CLOCK_SKEW_MS) {
    return {
      covered: true,
      note:
        `The credential is good for another ${Math.round(remainingMs / 60_000)} minute(s), which covers ` +
        `this suite's ${Math.round(budgetMs / 60_000)} minute budget.`,
    };
  }
  const remainingMinutes = Math.max(0, Math.floor(remainingMs / 60_000));
  return {
    covered: false,
    code: 'IDENTITY_REQUIRED',
    message:
      `Your session has about ${remainingMinutes} minute(s) left and this suite is allowed up to ` +
      `${Math.round(budgetMs / 60_000)}, so it was not started. A benchmark runs as you, not as the ` +
      'application, and one that ran out of session halfway would leave a run that scored half its ' +
      'cases. Sign in again and start it.',
    detail:
      `the forwarded credential expires in ${Math.round(remainingMs / 1000)}s and the suite budget is ` +
      `${Math.round(budgetMs / 1000)}s. Refused with ${FAILURE_TAXONOMY.IDENTITY_REQUIRED.code} before ` +
      'any case ran.',
  };
}

/**
 * Whether a refusal means the whole suite is finished, or only this case.
 *
 * Read off the taxonomy's own `layer` rather than from a list of codes here, so
 * a code added to the taxonomy later inherits the right behaviour instead of
 * defaulting to the wrong one by being absent from a list nobody updated.
 *
 * The split is the useful one. An `identity` failure is about the RUN's
 * credential, so every remaining case would fail identically and grinding
 * through them wastes minutes to learn nothing. An `authorization` failure is
 * about the DATA this particular question needed, which is a real and expected
 * result for a benchmark run by somebody who cannot read every table the suite
 * touches: that case is unscored and the next one still means something.
 */
export function endsTheSuite(code: FailureCode): boolean {
  return FAILURE_TAXONOMY[code].layer === 'identity';
}
