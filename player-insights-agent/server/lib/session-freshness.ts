/**
 * Whether the sign-in a browser presented still carries what this app asks for.
 *
 * THE FAILURE THIS ANSWERS. Unity Catalog rows on the Connections page went red
 * with HTTP 403 for a reader who could query every one of those tables by hand.
 * His browser was presenting a token minted before the app declared the catalog
 * scopes, and Databricks Apps intersects the forwarded token with the scopes the
 * app declares, so a session older than a declaration stays narrow for as long
 * as it lives. Nothing on any screen said so, and nothing could: the token's own
 * scope list was read inside `dependency-probes.ts` and surfaced nowhere, so the
 * one fact the whole diagnosis turns on was invisible to the person diagnosing.
 *
 * WHAT IS COMPARED, AND WHY THAT IS ENOUGH TO BE WORTH SAYING. Two lists, both
 * of which this process holds: the scope claim on the presented token, and the
 * `user_api_scopes` this deployment declares. A declared scope the token does not
 * carry is a fact, not an inference, and it is a fact a reader cannot get at any
 * other way.
 *
 * WHAT IS NOT CONCLUDED FROM IT, WHICH MATTERS MORE. A declared scope absent
 * from a token has two possible causes and one token cannot tell them apart:
 * the SESSION is older than the declaration, or the APP has not been stopped and
 * started since the declaration and the scope is inert for everybody. So the
 * cause recorded here is the narrow one that was actually established -- the
 * token lacks a declared scope -- and the copy names both possibilities and the
 * one action that is correct either way. Naming the first as fact is precisely
 * the mistake of 2026-08-16; see `shared/stated-cause.ts`.
 *
 * The remedy, and the reasoning that picked it over the things a reader would
 * otherwise try, is in `shared/fresh-sign-in.ts`. It lives there because the
 * Connections page states the same remedy against the individual row that was
 * refused, and two wordings of one fact is one wording too many.
 */
import { UNDETERMINED } from '../../shared/stated-cause';
import { freshSignIn, quotedScopes as quoted } from '../../shared/fresh-sign-in';
import { DECLARED_SCOPES_VAR } from '../../shared/declared-scopes';
import type { SessionReport } from '../../shared/session-contract';
// Moved to `shared/declared-scopes.ts` and re-exported here, so the callers that
// already read them off this module keep working. The probe module needs the
// same list and cannot import this one: this one imports `tokenCarriesScope`
// out of it, so a list both of them read cannot live in either.
export { DECLARED_SCOPES_VAR, declaredUserApiScopes } from '../../shared/declared-scopes';
import { scopesFromToken } from '../routes/access-verification';
// Imported rather than reimplemented: the forwarded
// token spells our catalog reads `unity-catalog` while the bundle has to spell
// them `catalog.tables:read`, and a second copy of that mapping is a second
// chance to read a token that carries a scope as a token that lacks it. That
// exact confusion has already printed a GRANT for a missing scope once.
import { tokenCarriesScope } from '../../shared/token-scopes';

function undetermined(
  explanation: string,
  // Stated by every caller rather than defaulted, because the three
  // undetermined branches do not agree on it and the harmless value is the one
  // a default would pick. See `SessionReport.signedIn`.
  signedIn: boolean,
  evidence = ''
): SessionReport {
  return {
    state: 'undetermined',
    cause: UNDETERMINED,
    evidence,
    explanation,
    // Always. A remedy is a claim about a cause, and there is no cause here.
    remedy: null,
    signedIn,
    tokenScopes: null,
    declaredScopes: null,
    missingScopes: [],
  };
}

/**
 * What the presented sign-in was shown to carry, and what follows from it.
 *
 * Never throws and never asks the workspace anything: both inputs are already in
 * this process, which is what lets the identity route report this on every load
 * without a round trip.
 */
export function sessionFreshness(input: {
  /** The forwarded user token, or null when the request carried none. */
  token: string | null;
  /** The scopes this deployment declares, or null when it was not told. */
  declared: readonly string[] | null;
}): SessionReport {
  if (!input.token) {
    return undetermined('This request carried no forwarded sign-in, so there is nothing to compare against the ' +
        'permissions this app asks for. Nothing about your sign-in was established either way.',
      false
    );
  }

  const tokenScopes = scopesFromToken(input.token);
  if (!tokenScopes) {
    return undetermined('The sign-in this request carried does not list its own permissions, so it cannot be ' +
        'compared against the ones this app asks for. Nothing about your sign-in was established.',
      // A sign-in DID reach this app. What could not be read is what it
      // carries, which is the next question down and not this one.
      true
    );
  }

  const declared = input.declared?.filter(Boolean) ?? null;
  if (!declared || declared.length === 0) {
    return {
      ...undetermined('This deployment was not told which permissions it asks for, so no sign-in can be ' +
          'compared against them. Nothing about your sign-in was established.',
        true,
        `The token lists ${quoted(tokenScopes)}. ${DECLARED_SCOPES_VAR} is unset in this container.`
      ),
      // Still reported. The reader came here for the token's scope list, and it
      // is knowable whether or not the other half of the comparison is.
      tokenScopes,
    };
  }

  const missing = declared.filter((scope) => !tokenCarriesScope(tokenScopes, scope));

  if (missing.length === 0) {
    return {
      state: 'current',
      cause: 'token-carries-every-declared-scope',
      evidence:
        `The app declares ${declared.length} permissions and the sign-in this request carried ` +
        `carries all of them. It lists ${quoted(tokenScopes)}.`,
      explanation: 'Your sign-in to this app carries every permission the app asks for.',
      remedy: null,
      signedIn: true,
      tokenScopes,
      declaredScopes: [...declared],
      missingScopes: [],
    };
  }

  return {
    state: 'stale',
    // The narrow claim, which is the whole claim. What the comparison
    // establishes is that this token lacks a declared scope. It does not
    // establish why, and the cause vocabulary must not pretend otherwise.
    cause: 'token-lacks-declared-scope',
    evidence:
      `The app declares ${declared.length} permissions including ${quoted(missing)}. The sign-in ` +
      `this request carried lists ${quoted(tokenScopes)}, which does not include ` +
      `${quoted(missing)}.`,
    explanation:
      `Your sign-in to this app does not carry ${quoted(missing)}, which the app asks for. Parts ` +
      'of the app will report errors that look like permissions you are missing, and are not.',
    remedy: freshSignIn(),
    signedIn: true,
    tokenScopes,
    declaredScopes: [...declared],
    missingScopes: missing,
  };
}
