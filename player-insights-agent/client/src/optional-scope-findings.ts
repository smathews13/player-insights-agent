/**
 * A shortfall in a permission this app calls optional is not something to fix.
 *
 * WHAT THIS CORRECTS. The Connections panel is headed "What to fix" and drew one
 * block per refused check. On the example deployment that meant four blocks: the
 * catalog, the schema, the twelve tables collected into one, and the Vector
 * Search index. All of those turn on scopes `shared/optional-user-api-scopes.ts`
 * records as OPTIONAL -- `catalog.catalogs:read`, `catalog.schemas:read`,
 * `catalog.tables:read`, `workspace.workspace:read`, and (Sam's 2026-08-18 call)
 * the two `vectorsearch.*:read` browse reads: no ask needs the APP's forwarded
 * token to carry them, a deployment may leave them off its OAuth config
 * entirely, and the login gate and the Identity card already draw them neutrally
 * for exactly that reason. The Connections page was the one surface left telling
 * a reader to go and fix permissions the app had already decided it can live
 * without.
 *
 * WHY IT READS A VALUE AND NOT THE PROSE. Each of those blocks says which
 * permission it turned on, in a sentence, and matching the sentence would be the
 * third copy of a scope vocabulary that has misfired twice in this repository.
 * The probe that took the refusal records the name on the check
 * (`PreflightCheck.scope`), so this is a set membership test on a value rather
 * than a guess about English.
 *
 * WHAT IS DELIBERATELY NOT MOVED OUT OF THE PANEL:
 *
 *   - anything `failed`. A failure was established ABOUT THE OBJECT, and no
 *     optional permission explains it away. Only the `refused` verdict is
 *     eligible, which is also the only one whose meaning is "the call stopped
 *     before it reached the object" (DECISIONS.md D6 and D8).
 *   - a refusal over a REQUIRED permission, whatever else is on the page. The
 *     ask-path scopes (`sql`, `dashboards.genie`, serving) are required and stay
 *     in the panel as findings. The Vector Search reads used to be here too;
 *     Sam's 2026-08-18 call moved them to OPTIONAL alongside catalog, because
 *     they browse VS from the APP's forwarded token and ask-time semantic
 *     retrieval runs on the MODEL's own token instead. A VS browse refusal is
 *     now a neutral shortfall, not a finding.
 *   - a refusal that named no permission. An absent `scope` means nothing
 *     established which permission was implicated, and reading that silence as
 *     "an optional one, probably" is how a real finding gets hidden.
 *
 * Pure and separate from the page, so what the panel is allowed to draw is
 * assertable without composing markup.
 */
import { checkVerdict } from '../../shared/check-verdict';
import { isOptionalUserApiScope } from '../../shared/optional-user-api-scopes';
import type { PreflightCheck } from './preflight';

/** Whether this check is a refusal over a permission the app calls optional. */
export function isOptionalScopeShortfall(check: PreflightCheck): boolean {
  if (checkVerdict(check) !== 'refused') return false;
  return isOptionalUserApiScope((check.scope ?? '').trim());
}

/** The optional shortfalls on a page, and the permissions they named. */
export interface OptionalScopeShortfall {
  /**
   * The permissions the refusals named, once each, in the order first met.
   *
   * Not the whole optional set: this reports what was READ on this page, so a
   * deployment where two of the three answered names two rather than three.
   */
  scopes: string[];
  /**
   * The checks these are, kept whole for the count and for a title.
   *
   * ONE POPULATION, and never added to anything else. Every member is `refused`,
   * which is a different claim from `failed`, and a line that summed the two
   * would be the arithmetic D6 exists to forbid.
   */
  checks: PreflightCheck[];
}

/** What the panel draws, and what it must not. */
export interface FindingSplit {
  /** Findings a reader is being asked to act on. Draw these in "What to fix". */
  required: PreflightCheck[];
  /** Optional shortfalls, for the neutral line. Never in "What to fix". */
  optional: OptionalScopeShortfall;
}

/**
 * The blocked checks, split by whether anyone is being asked to do something.
 *
 * Order is preserved in both halves, because the panel lists findings in the
 * order the report produced them and a reshuffle here would move rows about for
 * no reason a reader could see.
 */
export function splitOptionalScopeFindings(checks: readonly PreflightCheck[]): FindingSplit {
  const required: PreflightCheck[] = [];
  const optionalChecks: PreflightCheck[] = [];
  const scopes: string[] = [];
  for (const check of checks) {
    if (!isOptionalScopeShortfall(check)) {
      required.push(check);
      continue;
    }
    optionalChecks.push(check);
    const scope = (check.scope ?? '').trim();
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  return { required, optional: { scopes, checks: optionalChecks } };
}

/**
 * What the neutral line calls itself, in the Identity card's words.
 *
 * The same phrase that card uses for the same three names, so a reader who has
 * met them there recognises them here rather than reading a fourth vocabulary.
 */
export const OPTIONAL_SCOPES_LABEL = 'Optional permissions';

/**
 * The word on the chip, and it is the verdict rather than a grant state.
 *
 * The login gate and the Identity card say "Not granted" here, and they have
 * earned it: both compare the token's own scope claim against what the app
 * declares, so an absence there is a fact about the sign-in. This surface read a
 * REFUSAL, which establishes less: it says the workspace stopped the call over
 * this permission, and not whether the reader holds it or is owed a grant. So
 * the chip carries this page's own word for that, in the gate's NEUTRAL pill
 * rather than the red one, which is the part of the precedent that matters.
 */
export const OPTIONAL_SCOPES_CHIP = 'Refused';

/**
 * The one line under the names, and every clause in it is load-bearing.
 *
 * NO CAUSE IS ASSERTED. Three different things produce these refusals -- a
 * sign-in older than the declaration, an app that never declared the permission,
 * and a token that did not enumerate its scopes -- and one line covering all
 * three may not name any of them. It reports what was read.
 *
 * "STOPPED BEFORE THEY REACHED THE OBJECT" is not padding. It is the difference
 * between this line and the thing a reader would otherwise conclude, which is
 * that they cannot see those tables. Nothing here established that.
 *
 * The count names its population, and the population is the refused checks
 * alone. Nothing failing is counted in it.
 */
export function optionalScopeNote(count: number): string {
  const population = count === 1 ? 'one check on this page' : `${count} checks on this page`;
  return `${population} stopped over these before reaching the object. Questions do not need them, ` +
    'the catalog and table listings here stay empty without them, and a deployment can leave them ' +
    'out entirely.';
}
