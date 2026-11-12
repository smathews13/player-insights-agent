/**
 * What an HTTP 401 on a forwarded token establishes, and what it does not.
 *
 * THE ADVICE THIS REPLACES. Until now a 401 was answered with "Reload this page
 * to pick up a fresh token. If it persists, sign out of the workspace and back
 * in, then open the app again." Three actions, offered as a sequence, none of
 * them derived from anything the code had read:
 *
 * - A reload only replaces the token if the token had run out. The proxy in
 *   front of this app hands over the token it holds; if that token is live and
 *   Databricks refused it anyway, a reload presents the same live token and
 *   collects the same refusal. That is a loop, and the copy sent readers round
 *   it with no way to know they were in one.
 * - Signing out of the Databricks workspace does not clear this app's sign-in.
 *   The app is served from its own host and keeps its own session there. This
 *   is the step a reader tries first, and it has never worked.
 *
 * WHAT IS ACTUALLY KNOWABLE HERE, and it is more than nothing. The forwarded
 * token carries its own expiry. Comparing that claim against the clock
 * separates the two cases that the old copy ran together:
 *
 * - The expiry has passed. The token really had run out, and a reload really is
 *   the fix, because a page load is what makes the proxy hand over a new one.
 * - The expiry has not passed. The token was live when Databricks refused it,
 *   so its age is not the reason and a reload cannot help. What replaces the
 *   token rather than re-presenting it is a new sign-in.
 *
 * And where the expiry cannot be read at all, that is said plainly and the
 * action offered is the one that covers both, rather than the one that covers
 * the case somebody guessed at. That is the rule this module is written to,
 * recorded as D10 in `bundle/DECISIONS.md`.
 *
 * Every branch is a {@link Diagnosis}, and every branch is registered in
 * `server/lib/diagnosis-audit.test.ts`. That registration is the point of
 * putting the copy here rather than inline in `access-verification.ts`, where
 * it sat outside the guard entirely.
 */
import type { Diagnosis } from '../../shared/stated-cause';

/**
 * What the presented token says about its own lifetime.
 *
 * A value rather than the token itself, so the comparison happens once at the
 * edge and the copy is a pure function of it. `access-verification.ts` already
 * takes `genieScope` this way for the same reason.
 */
export type PresentedTokenAge =
  | { kind: 'expired'; expiresAt: string; secondsAgo: number }
  | { kind: 'live'; expiresAt: string; secondsLeft: number }
  /** No token, no `exp` claim, or a shape this cannot read. `why` is reported. */
  | { kind: 'unreadable'; why: string };

/** The layer a reader would go and look at, in the vocabulary `Blocked` uses. */
export const TOKEN_LAYER = 'the forwarded user token';

function claims(token: string): Record<string, unknown> | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  try {
    const payload = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Read the presented token's expiry, without asking the workspace anything.
 *
 * Unreadable is a first-class answer and carries its reason. An opaque token, a
 * personal access token and a request that forwarded nothing all land here, and
 * none of them is a fault: what follows from them is that the app says it
 * cannot tell, which is the whole point.
 */
export function presentedTokenAge(token: string | null, now: Date = new Date()): PresentedTokenAge {
  if (!token) return { kind: 'unreadable', why: 'this request forwarded no user token' };
  const payload = claims(token);
  if (!payload) {
    return { kind: 'unreadable', why: 'the token is not in a form whose claims can be read' };
  }
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return { kind: 'unreadable', why: 'the token states no expiry' };
  }
  const expiresAt = new Date(exp * 1000).toISOString();
  const seconds = Math.round((exp * 1000 - now.getTime()) / 1000);
  return seconds <= 0
    ? { kind: 'expired', expiresAt, secondsAgo: Math.abs(seconds) }
    : { kind: 'live', expiresAt, secondsLeft: seconds };
}

/** "12 minutes", "2 hours", "40 seconds". Rounded, because precision here is noise. */
function readableSpan(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * What every branch can say, because the status code alone establishes it.
 *
 * Kept as one string so the three branches cannot drift into three different
 * accounts of the same fact, and worded around what a reader is about to do
 * next: the danger of a 401 is that it looks like a permission problem and
 * sends somebody to an administrator for a grant that changes nothing.
 */
const REFUSED =
  'Databricks refused the sign-in this app forwarded for you (HTTP 401) before it looked at ' +
  'any permission, so nothing was run and nothing about your own access was established. This ' +
  'is not a permission you are missing, and no grant made to you would change it.';

/** Open the app with nothing stored, which replaces the sign-in rather than re-presenting it. */
const NEW_SIGN_IN = {
  kind: 'ui' as const,
  statement:
    'Open this app again in a private browsing window, and sign in there.\n' +
    'Chrome and Edge call it Incognito or InPrivate. Safari and Firefox call it a Private Window.',
};

/**
 * The one line under a new sign-in, shared by the two branches that offer one.
 *
 * SAME SENTENCE AS `shared/fresh-sign-in.ts`, and for the same reason: told to
 * open a private window, a reader reasonably signs out of Databricks first, and
 * that cannot clear a session this app does not hold. Not imported from there
 * because that module builds a whole remedy for a scope refusal and this is a
 * 401; what they share is one fact about where the session lives, and stating it
 * identically is what keeps the two surfaces from teaching different lessons.
 *
 * WHAT THE PARAGRAPH HERE USED TO ADD, all of it now cut: which browser calls it
 * what (the statement says that), the cookie mechanics, clearing cookies as an
 * alternative to a second window, and the escalation saying that a refused fresh
 * sign-in is the workspace administrator's problem. The last was the most
 * tempting to keep and is still the right conclusion; it is not this remedy's to
 * draw, because the next probe reaches it from evidence rather than from the
 * reader having worked down a list.
 */
const SESSION_IS_NOT_THE_WORKSPACE =
  'Signing out of Databricks does not clear this app\u2019s sign-in: it is held by the proxy in ' +
  'front of the app, not by the workspace.';

/** A 401, and what to do about it, derived from the presented token's own expiry. */
export interface TokenRejection extends Diagnosis {
  /** Where to look, for the surfaces that print a layer beside the summary. */
  layer: string;
}

/**
 * The diagnosis for a refused token.
 *
 * Never throws, never asks the workspace anything, and never names a cause the
 * expiry did not settle. `apiMessage` is quoted into the evidence when there is
 * one, because Databricks occasionally says why, and when it does that sentence
 * outranks anything inferred here.
 */
export function tokenRejection(input: { age: PresentedTokenAge; apiMessage?: string }): TokenRejection {
  const said = input.apiMessage?.trim()
    ? ` Databricks said: ${input.apiMessage.trim()}`
    : ' Databricks gave no reason with it.';

  if (input.age.kind === 'expired') {
    const ago = readableSpan(input.age.secondsAgo);
    return {
      layer: TOKEN_LAYER,
      // Determined, and narrowly. The expiry had passed, which is a fact about
      // the token rather than a story about the reader.
      cause: 'forwarded-token-expired',
      evidence:
        `The presented token states that it expired at \`${input.age.expiresAt}\`, which is ` +
        `${ago} before this check ran, and Databricks answered HTTP 401.${said}`,
      explanation:
        `${REFUSED} The sign-in it forwarded had run out ${ago} ago, which is the ordinary ` +
        'way for this to happen and the one version of it that clears itself.',
      remedy: {
        kind: 'ui',
        statement: 'Reload this page.',
        // NOTHING, and this is the clearest case of the rule. The action is one
        // click that costs seconds and cannot be got wrong. What stood here
        // explained that a page load is what makes the proxy hand over a new
        // token, that a reload is offered on this branch and nowhere else, and
        // what to try if it survived one: mechanism, a note about the app's own
        // copy, and an escalation. None of them changes what the reader does.
        guidance: '',
      },
    };
  }

  if (input.age.kind === 'live') {
    const left = readableSpan(input.age.secondsLeft);
    return {
      layer: TOKEN_LAYER,
      // Also determined, and this is the branch the old copy got wrong: the
      // token had not run out, so its age is ruled OUT rather than assumed in.
      cause: 'forwarded-token-refused-while-live',
      evidence:
        `The presented token states that it does not expire until \`${input.age.expiresAt}\`, ` +
        `which is ${left} after this check ran, so it had not run out when Databricks answered ` +
        `HTTP 401.${said}`,
      explanation:
        `${REFUSED} The sign-in it forwarded had not run out: it is good for another ${left}. ` +
        'Reloading this page hands over the same one and gets the same answer, so that is not ' +
        'the thing to try.',
      remedy: {
        kind: NEW_SIGN_IN.kind,
        statement: NEW_SIGN_IN.statement,
        guidance: SESSION_IS_NOT_THE_WORKSPACE,
      },
    };
  }

  return {
    layer: TOKEN_LAYER,
    // The refusal is established. The reason for it is not, and this says so
    // rather than picking the half that would make the copy shorter.
    cause: 'forwarded-token-refused',
    evidence:
      `Databricks answered HTTP 401.${said} The presented token\u2019s own expiry could not be ` +
      `read here (${input.age.why}), so whether it had run out was not established either way.`,
    explanation:
      `${REFUSED} Whether the sign-in had simply run out cannot be read from here, so this does ` +
      'not guess. The step below is the one that works whether it had or not.',
    remedy: {
      kind: NEW_SIGN_IN.kind,
      statement: NEW_SIGN_IN.statement,
      guidance: SESSION_IS_NOT_THE_WORKSPACE,
    },
  };
}
