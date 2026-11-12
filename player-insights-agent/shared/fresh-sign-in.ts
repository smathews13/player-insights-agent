/**
 * The one action that helps a reader whose sign-in is short of a permission.
 *
 * ONE COPY, READ BY TWO SURFACES. The strip above every page states it from the
 * identity report, and the Connections page states it against the individual
 * row that was refused. Those are two places a reader can meet the same fact,
 * and a second wording of it is a second thing to keep true: the version that
 * cost an afternoon told somebody to sign out of Databricks, which does not
 * clear this app's sign-in and never did.
 *
 * Here rather than in either caller because both import it and neither may
 * import the other. `session-freshness.ts` reads `tokenCarriesScope` out of
 * `dependency-probes.ts`, so a remedy living in the first and used by the
 * second would close a cycle between them.
 *
 * THE REMEDY WAS CHOSEN AGAINST WHAT THE PLATFORM PERMITS, not against what
 * would be convenient to write:
 *
 * - There is NO supported way for a Databricks App to end its own sign-in. The
 *   session is held by the authentication proxy in front of the container, in a
 *   cookie the app never sees and cannot expire.
 * - Signing out of the Databricks workspace does not clear it. The app is
 *   served from its own `databricksapps.com` host and keeps its own session
 *   there. This is the step a reader will try first and it will not work.
 * - There is no re-consent to perform. Consent is recorded once and kept, so a
 *   reader sent looking for an approval prompt will not find one.
 *
 * What is left is the browser's own doing, and it works: a private window
 * starts with no stored session, so the proxy runs a fresh sign-in and mints a
 * token carrying the scopes the app declares today.
 */
import type { DiagnosisRemedy } from './stated-cause';

/** `a`, `b` and `c`, for a sentence rather than a log line. */
export function quotedScopes(scopes: readonly string[]): string {
  const names = scopes.map((scope) => `\`${scope}\``);
  if (names.length <= 1) return names[0] ?? 'nothing';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The action itself, and the browser names that make it findable.
 *
 * TWO CONSTANTS RATHER THAN ONE LITERAL because a third surface now states this
 * and cannot state all of it. The Connections identity card and the per-row
 * remedy have room for both lines; the first-open gate's scopes box is a footer
 * under a list and takes the action alone. Slicing the composed statement on its
 * newline would have worked and would have been a second reader of this file's
 * formatting, so the pieces are named and {@link freshSignIn} is composed from
 * them. Every existing caller still gets the same string it always did.
 */
export const NEW_SIGN_IN = 'Open this app again in a private browsing window, and sign in there.';

/** Which of the four browsers calls it what. Findability, not instruction. */
export const PRIVATE_WINDOW_NAMES =
  'Chrome and Edge call it Incognito or InPrivate. Safari and Firefox call it a Private Window.';

/**
 * THE ONE SENTENCE THAT STOPS A WRONG ACTION. See {@link freshSignIn} below for
 * why it survived the cut that took the paragraph around it.
 *
 * Exported so the surfaces that state the remedy WITHOUT the full statement can
 * still carry it. This is the line readers get wrong, so a surface that drops it
 * to save room has saved the wrong line.
 *
 * THE MECHANISM CAME OFF THE END on 2026-08-17: it used to go on to say the
 * sign-in is held by the proxy in front of the app rather than by the workspace.
 * True, and the reason, but a reader does nothing differently for knowing it,
 * and this sentence is set in a footer under a nine-row list where every clause
 * costs a line. What is left is the part that stops the wrong action.
 */
export const SIGN_OUT_DOES_NOT_CLEAR = 'Signing out of Databricks does not clear this app\u2019s sign-in.';

/**
 * Open the app again with nothing stored.
 *
 * Correct whichever of the two causes is in play, which is the whole reason it
 * can be offered at all: a fresh sign-in is what a reader needs if their session
 * is behind the declaration, and it is also the cheapest way to establish that
 * it is NOT their session. Neither half is stated as the cause, because one
 * token cannot tell them apart.
 *
 * THE GUIDANCE IS THE ONE SENTENCE THAT STOPS A WRONG ACTION, and it is the
 * reason this field survived the cut at all. Told only to open a private window,
 * a reader reasonably signs out of Databricks first: it is the obvious way to
 * end a session, it is what every other Databricks surface responds to, and it
 * cannot work here, because this app is served from its own host and its session
 * is held by the proxy in front of it. That is a wrong action costing real time,
 * so it gets a line.
 *
 * WHAT WAS DROPPED WITH THE PARAGRAPH, so nobody restores it as an oversight.
 * The cookie mechanics, the promise that consent is not asked for twice, the
 * clear-your-cookies alternative to a second window, and the escalation saying
 * that a fresh sign-in which STILL lacks the permission means the app was never
 * restarted. All true. None of them changes what the reader does next: the first
 * three explain a step they are already taking, and the fourth is a further
 * diagnosis this app reaches from its own evidence on the next probe rather than
 * something a reader should be working down a list towards.
 */
export function freshSignIn(): DiagnosisRemedy {
  return {
    kind: 'ui',
    statement: `${NEW_SIGN_IN}\n${PRIVATE_WINDOW_NAMES}`,
    guidance: SIGN_OUT_DOES_NOT_CLEAR,
  };
}
