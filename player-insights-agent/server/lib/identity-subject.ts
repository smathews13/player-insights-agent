/**
 * Whether the token on a request belongs to the person the request says it is
 * from.
 *
 * Databricks Apps sets two independent things on an authenticated request:
 * `x-forwarded-email`, which is who the platform says signed in, and
 * `x-forwarded-access-token`, which is the credential every downstream call is
 * then made with. Everything the app records, scopes and displays is keyed on
 * the first. Everything that actually reads data is authorised by the second.
 * Nothing has ever checked that they name the same person.
 *
 * They should always agree, and the value of the check is not that they might
 * casually disagree. It is that "the answer was computed under the grants of
 * whoever the email says" is a claim the app makes on every screen, and until
 * this existed the app had no evidence for it at all. A mismatch here is the
 * one signal that the two halves came apart.
 *
 * WHAT THIS DELIBERATELY CANNOT DO. It reads the token's own claims, so it
 * proves what the token SAYS about itself, not that Databricks issued it. The
 * signature is not verified and could not usefully be: the app has no issuer key,
 * and the token is about to be sent to Databricks, which does verify it and
 * refuses it if it is forged. This check catches the wrong REAL token, which is
 * the failure mode a signature check would not have caught either.
 *
 * NO CLAIM READ HERE MAY BE LOGGED, TRACED OR STORED beyond the subject, and
 * the subject only where the email already is. A token's claims are credentials
 * in every sense that matters, and a trace attribute is forever.
 */

import { FAILURE_TAXONOMY, type FailureCode } from '../../shared/failure-taxonomy';

/**
 * Seconds of clock difference tolerated before a token is called expired.
 *
 * The app container and the OAuth issuer are different machines, and refusing a
 * token that has three seconds left is an outage caused by NTP. Generous in the
 * direction that costs nothing: a token this app accepts is still verified by
 * Databricks on the next hop, which applies its own expiry.
 */
export const CLOCK_SKEW_SECONDS = 60;

/**
 * The claims a token might name its subject in.
 *
 * More than one because the shape is not guaranteed and has changed: a
 * user-to-machine OAuth token, a personal access token and a token minted for a
 * service principal do not agree on which of these is populated. Read in order
 * and any match is a match, because the question here is "does this token
 * mention the signed-in user", not "which claim is canonical".
 */
const SUBJECT_CLAIMS = ['sub', 'email', 'upn', 'preferred_username', 'username'] as const;

/**
 * The claims of a JWT, or `null` for anything that is not one.
 *
 * `null` is not a failure. A personal access token is an opaque string, and so
 * is anything the platform decides to hand out next; neither is malformed, and
 * treating an unreadable token as a rejected one would refuse every request in
 * a workspace that issues them.
 */
export function readTokenClaims(token: string): Record<string, unknown> | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  try {
    const payload = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
    return claims as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Every subject this token names, in the order the claims were read.
 *
 * A list rather than one value: a token can carry both a numeric `sub` and an
 * `email`, and picking one of them to be "the" subject is how a check comes to
 * compare an id against an address and call the difference an attack.
 */
export function tokenSubjects(token: string): string[] {
  const claims = readTokenClaims(token);
  if (!claims) return [];
  const found: string[] = [];
  for (const name of SUBJECT_CLAIMS) {
    const value = claims[name];
    if (typeof value === 'string' && value.trim()) found.push(value.trim());
  }
  return found;
}

export type SubjectBinding =
  /** The token names the signed-in user. The only outcome that proves anything. */
  | { kind: 'bound'; subject: string }
  /**
   * The token names somebody else. Two identities on one request, which is the
   * condition the whole module exists to find.
   */
  | { kind: 'mismatch'; subject: string }
  /** The token said it was valid until a moment that has passed. */
  | { kind: 'expired'; secondsAgo: number }
  /**
   * The token is real and does not say who it is for, in terms that can be
   * compared with an email address. NOT a rejection: see below.
   */
  | { kind: 'unverifiable'; why: string }
  /** There is no token at all. */
  | { kind: 'absent' };

/**
 * Compare two identities as the directory would, and no more loosely.
 *
 * Case-insensitive, because SCIM, the workspace UI and `x-forwarded-email`
 * disagree about the casing of the same person routinely and a check that
 * refuses on it locks out everybody stored capitalised. Nothing else is
 * normalised: a plus-address and a different domain are different principals,
 * and being helpful about that is how a check stops checking.
 */
export function sameSubject(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function looksLikeAddress(value: string): boolean {
  return value.includes('@');
}

export interface BindOptions {
  /** Unix seconds. Injected so expiry can be tested without waiting an hour. */
  now?: number;
}

/**
 * Hold the forwarded token against the resolved signed-in user.
 *
 * THE ASYMMETRY IS DELIBERATE, and is the whole design of this function. A
 * token that names a DIFFERENT PERSON is refused. A token that names nobody
 * this app can compare against is not.
 *
 * The reason is what the alternative does on a Tuesday. Databricks does not
 * guarantee that `sub` is an address: it has been observed carrying a numeric
 * SCIM id, and a check that reads an id, fails to match it against an email and
 * calls that a mismatch refuses every request in the workspace, permanently, on
 * a rule that fired correctly zero times. Treating an unreadable subject as
 * unverified rather than as wrong keeps the app up and keeps the claim honest:
 * `verified: false` travels with the run and the interface does not get to say
 * the identity was confirmed.
 *
 * So a mismatch is only declared when the token named an ADDRESS, which is a
 * value in the same namespace as the thing it is being compared with, and that
 * address is somebody else's.
 */
export function bindTokenToUser(token: string | null, email: string, options: BindOptions = {}): SubjectBinding {
  if (!token || !token.trim()) return { kind: 'absent' };
  if (!email || !email.trim()) {
    return {
      kind: 'unverifiable',
      why: 'the request resolved no signed-in address, so there is nothing to hold the token against',
    };
  }

  const claims = readTokenClaims(token);
  if (!claims) {
    return {
      kind: 'unverifiable',
      why: 'the token is opaque rather than a JWT, so it states no subject this app can read',
    };
  }

  // Before the subject, because an expired token belonging to the right person
  // is still a token nothing will accept, and reporting it as a subject problem
  // sends the reader to look at grants.
  const expiry = claims.exp;
  if (typeof expiry === 'number' && Number.isFinite(expiry)) {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (expiry + CLOCK_SKEW_SECONDS < now) {
      return { kind: 'expired', secondsAgo: Math.round(now - expiry) };
    }
  }

  const subjects = tokenSubjects(token);
  if (subjects.length === 0) {
    return {
      kind: 'unverifiable',
      why: 'the token carries no subject claim, so it does not say who it was issued to',
    };
  }
  const matched = subjects.find((subject) => sameSubject(subject, email));
  if (matched) return { kind: 'bound', subject: matched };

  const addressed = subjects.find(looksLikeAddress);
  if (addressed) return { kind: 'mismatch', subject: addressed };

  return {
    kind: 'unverifiable',
    why:
      'the token names its subject as an identifier rather than an address, which cannot be ' +
      'compared with the signed-in email without guessing',
  };
}

/**
 * The failure code a binding outcome terminates on, or `null` to carry on.
 *
 * `unverifiable` returns null on purpose. It is not a pass: the caller records
 * `verified: false` and the interface must not claim otherwise. It is the
 * absence of evidence either way, and refusing on it would take down every
 * deployment whose tokens are opaque.
 */
export function bindingFailure(binding: SubjectBinding): FailureCode | null {
  switch (binding.kind) {
    case 'mismatch':
      return 'IDENTITY_MISMATCH';
    case 'expired':
      return 'USER_AUTH_REJECTED';
    case 'absent':
      return 'IDENTITY_REQUIRED';
    case 'bound':
    case 'unverifiable':
      return null;
  }
}

/**
 * Whether the binding is evidence that the token is the signed-in user's.
 */
export function isVerified(binding: SubjectBinding): boolean {
  return binding.kind === 'bound';
}

/**
 * What the endpoint's own logs say about one binding.
 *
 * NEVER THE TOKEN, and never a claim other than the subject. The subject is
 * logged only on a mismatch, where the two addresses in play are the whole
 * finding and both are already recorded elsewhere in the clear.
 */
export function describeBinding(binding: SubjectBinding, email: string): string {
  switch (binding.kind) {
    case 'bound':
      return `the forwarded token names ${email}, which is who the request is from`;
    case 'mismatch':
      return (
        `the request is from ${email} and the forwarded token was issued to ${binding.subject}. ` +
        `Refusing with ${FAILURE_TAXONOMY.IDENTITY_MISMATCH.code} rather than running either of them.`
      );
    case 'expired':
      return `the forwarded token expired ${binding.secondsAgo}s ago, so nothing will accept it`;
    case 'unverifiable':
      return `the token could not be tied to ${email}: ${binding.why}`;
    case 'absent':
      return 'no token was forwarded with this request';
  }
}
