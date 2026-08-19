/**
 * Whether to tell this reader to sign in again, decided from the one comparison
 * that can support it.
 *
 * THE FAILURE THIS ANSWERS. Five Connections rows read 403 -- two Vector Search,
 * three Unity Catalog -- for a reader who could query every one of those objects
 * by hand. He read them as a grant he was missing, re-consented, and escalated
 * it, over several days. The five red rows were exactly the five permissions the
 * app had declared MOST RECENTLY, and the four that stayed green were the older
 * ones his browser's sign-in already carried; a session keeps the permissions it
 * was minted with. The tell was in the data the whole time and no surface said
 * it. Signing in again fixed all five at once.
 *
 * WHY A MODULE AND NOT AN `if` AT EACH SURFACE. Two surfaces state this -- the
 * Connections identity card and the first-open gate -- and the thing that must
 * not vary between them is not the wording but the CONDITION. A surface that
 * decided for itself when to offer a sign-in would eventually offer one to
 * somebody whose sign-in is fine, and that is the failure worth designing
 * against: it sends them round the loop this exists to end.
 *
 * WHAT IS ALLOWED TO REACH A READER, and what is deliberately not:
 *
 *   - The SESSION lacks a permission the app declares. That is two lists this
 *     process already holds, compared in `server/lib/session-freshness.ts`, and
 *     it is a fact rather than an inference. This is the only case that returns
 *     a notice.
 *   - The USER lacks a grant on the object. Their sign-in carries the
 *     permission; the workspace refused the object anyway. `missingScopes` is
 *     EMPTY in that case, because the comparison is against the token's own
 *     scope claim and the token plainly lists it, so this returns null and the
 *     reader is never sent to a private window that cannot help them. That is
 *     the failure mode this whole module is shaped around.
 *   - The APP could not reach something. Nothing about the sign-in was
 *     established by an unreachable dependency, so `state` is not `stale` and
 *     this returns null.
 *   - The comparison could not be MADE at all -- no forwarded sign-in, a token
 *     that states no scopes, a container that was not told what it declares.
 *     `state` is `undetermined` and this returns null. Silence is the correct
 *     output: a confident wrong diagnosis here is worse than the nothing it
 *     replaces.
 *
 * NOTHING IS HARDCODED, and it could not be. Both lists are read at runtime --
 * the token's scope claim, and `PLAYER_INSIGHTS_USER_API_SCOPES` off the
 * deployment. Declared scopes are target-layered and have been spelled
 * differently across targets (with or without a `:read` suffix). A literal
 * list here would be wrong on whichever spelling it was not written for.
 * Catalog, workspace and Vector Search browse shortfalls are optional for this
 * remedy (shared/optional-user-api-scopes.ts); only required ask-path scopes
 * earn a private-window instruction.
 *
 * WHAT IT DOES NOT SAY, which is the same restraint `session-freshness.ts`
 * keeps and for the same reason. A declared scope absent from a token has two
 * possible causes and one token cannot separate them: the session is older than
 * the declaration, or the app has not been restarted since the declaration and
 * the scope is inert for everybody. The copy below names neither. It states what
 * was read -- the sign-in does not carry these -- and offers the one action that
 * is correct either way. Naming the first as fact is precisely the mistake of
 * 2026-08-16; see `shared/stated-cause.ts`.
 */
import { NEW_SIGN_IN, SIGN_OUT_DOES_NOT_CLEAR } from './fresh-sign-in';
import { requiredMissingScopes } from './optional-user-api-scopes';
import type { SessionReport } from './session-contract';

/**
 * The one line, and the remedy behind it.
 *
 * `lead` is split from `missing` rather than interpolated because both surfaces
 * set scope names in mono, and a component handed one sentence cannot pick the
 * names back out of it without matching on the words. This is the same shape
 * `first-open.ts` already uses for its scopes footer.
 */
export interface StaleSignInNotice {
  /** The declared permissions the presented sign-in does not carry. Never empty. */
  missing: string[];
  /** The lead, ending where the scope names begin. */
  lead: string;
  /**
   * The same finding, for a surface that has ALREADY listed the names.
   *
   * The first-open gate sets every declared permission as a row with a Granted
   * or Missing badge and then states this underneath, so `lead` plus `missing`
   * printed the five names a second time, inline, three rows below the badges
   * that said it. A reader does not read a list twice; they read the prose as
   * new information, find it is not, and the panel is a screen longer for it.
   */
  summary: string;
  /** The action, verbatim from `fresh-sign-in.ts`. */
  action: string;
  /**
   * The line that stops the wrong action, verbatim.
   *
   * NEVER OMITTED BY A CALLER. It is the part readers get wrong: told only to
   * open a private window, somebody reasonably signs out of Databricks first,
   * which does not clear this app's sign-in and never did.
   */
  guidance: string;
}

/**
 * The lead, in the singular the likeliest case actually takes.
 *
 * A permission is usually added to the declaration on its own, so a session
 * behind it is short of exactly one, and "does not carry 1 permissions" is the
 * sentence that would have been read most often.
 */
function lead(count: number): string {
  return count === 1
    ? 'Your sign-in to this app does not carry a permission the app asks for:'
    : `Your sign-in to this app does not carry ${count} permissions the app asks for:`;
}

/** The same count, as a sentence that stands alone. See {@link StaleSignInNotice.summary}. */
function summary(count: number): string {
  return count === 1
    ? 'Your sign-in does not carry the permission marked Missing above.'
    : `Your sign-in does not carry the ${count} permissions marked Missing above.`;
}

/**
 * Whether to tell this reader to sign in again, and what to say.
 *
 * Returns null wherever the evidence does not support the claim, which is every
 * state but one. Takes the report rather than reaching for it, so every branch
 * is reachable in a test without a token, a workspace or an environment.
 */
export function staleSignInNotice(session: SessionReport | null | undefined): StaleSignInNotice | null {
  if (!session) return null;
  // The verdict `sessionFreshness` reached, not a second reading of the lists.
  // Recomputing the comparison here would mean the card and the strip could
  // describe one token differently, and the token spells our catalog reads
  // `unity-catalog` where the bundle must spell them `catalog.tables:read` --
  // a second copy of that mapping has printed a GRANT for a present scope once
  // already.
  if (session.state !== 'stale') return null;
  // Belt and braces, and cheap. `stale` is only ever set alongside these, but
  // this function is the gate on a sentence that sends people somewhere, and a
  // future edit to the state machine should fail closed rather than start
  // prompting readers whose sign-in was never compared against anything.
  if (!session.signedIn) return null;
  // Catalog reads are Optional on every surface: a shortfall there does not
  // earn a private-window instruction. Only required ask-path scopes do.
  const missing = requiredMissingScopes(session.missingScopes);
  if (missing.length === 0) return null;

  return {
    missing: [...missing],
    lead: lead(missing.length),
    summary: summary(missing.length),
    action: NEW_SIGN_IN,
    guidance: SIGN_OUT_DOES_NOT_CLEAR,
  };
}
