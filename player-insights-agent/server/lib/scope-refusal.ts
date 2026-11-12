/**
 * What a 403 that turned on an OAuth scope actually establishes, and what to do.
 *
 * WHAT THIS REPLACED, SO IT IS NOT PUT BACK. The Connections page used to answer
 * a scope refusal with one sentence and four steps. The sentence said "it is the
 * app that is short of a scope, not the reader of a grant", and nothing in the
 * code had read anything that could know that. The steps said: validate the
 * scope name, add it to `databricks.yml`, stop and start the app, sign out and
 * back in. Three of the four were already done and verified working on this
 * deployment, one row told the reader to add a scope the bundle already
 * declared, and the fourth rested on a consent model the documentation does not
 * support. The reader did them again and it did not help.
 *
 * THE MISSING FACT WAS WHAT THE APP ASKS FOR. Both remedies above are correct in
 * one case each, and picking between them needs the deployment's own
 * `user_api_scopes`. The container is now told them (`session-freshness.ts`,
 * `DECLARED_SCOPES_VAR`), so this no longer has to guess:
 *
 * - the app DOES declare the scope, and the presented sign-in demonstrably lacks
 *   it. A fresh sign-in is the reader's move, and it is offered without either
 *   candidate being asserted as the cause: one token cannot tell a session older
 *   than the declaration from an app that was never restarted. This is the same
 *   verdict `sessionFreshness` reaches from the other direction, and it
 *   deliberately carries the same `cause` string.
 * - the app declares it and the sign-in DOES carry it, and the workspace refused
 *   anyway. Then the scope is ruled out by the token itself and a grant is what
 *   is left, so this branch says so and offers no sign-in.
 * - the app does NOT declare it. Then no sign-in it hands out can carry it, the
 *   reader can do nothing at all, and the bundle edit is the whole fix. This is
 *   the only branch where the deploy steps are the right answer, and it is the
 *   branch the old code never distinguished.
 * - the deployment was not told what it declares. Then this is undetermined and
 *   carries NO remedy, because the two above are contradictory advice and
 *   picking one is the original defect.
 *
 * WHY THE SIGN-IN'S OWN SCOPES ARE AN INPUT AND NOT A SECOND READING OF THEM.
 * Two paths used to reach a verdict about the same 403 from different evidence.
 * `refusalCause` in `dependency-probes.ts` reads the token's scope claim through
 * a spelling table and decides whether the refusal was about a scope at all;
 * this function then re-decided WHICH scope problem it was from the declared list
 * alone. So a deployment whose reader held the scope, and whose workspace refused
 * for want of a GRANT, was told its sign-in did not carry a permission the token
 * plainly listed, and sent to a private window that could not help. Both readers
 * survive and neither is duplicated: the token verdict is computed once, beside
 * the call that produced the refusal, and handed here as `scopeHeld`.
 *
 * Registered in `server/lib/diagnosis-audit.test.ts`, which holds every branch
 * against `shared/stated-cause.ts`: prose on an undetermined verdict may not
 * assert a cause, an undetermined verdict may not carry a remedy, and a named
 * cause must quote what was read. See DECISIONS.md D10.
 */
import { UNDETERMINED, type Diagnosis, type DiagnosisRemedy } from '../../shared/stated-cause';
import { freshSignIn, quotedScopes } from '../../shared/fresh-sign-in';

/**
 * A diagnosis whose remedy may name who can run it.
 *
 * `run_by` is on the preflight remedy rather than on {@link Diagnosis} because
 * only one branch here needs it, and it needs it badly: a bundle edit and a
 * restart handed to the reader of a Connections page is a task rather than a
 * fix. Widening the audited type for one branch would put an optional field in
 * front of every diagnosis that will never set it.
 */
export interface ScopeRefusalDiagnosis extends Diagnosis {
  remedy: (DiagnosisRemedy & { run_by?: string }) | null;
  /**
   * Whether what is left to fix is a grant on the object.
   *
   * The statement that grants it names the object and the principal, and both
   * belong to the probe rather than to this module, so the caller attaches its
   * own `grant` remedy when this is true. It is a fact about the verdict and not
   * a substitute for one: every other branch leaves it false, and a false value
   * never means "no grant is needed", only that the scope question did not get
   * far enough to rule the scope out.
   */
  grantIsMissing: boolean;
}

/**
 * The scope names this deployment declares, in the form the bundle spells them.
 *
 * Compared by exact match on purpose. `declarable` comes from
 * `scopeForPath`, which is the same Apps-API vocabulary `user_api_scopes` is
 * written in, so the coarse-family translation that reading a TOKEN needs has
 * no business here. Running it anyway would be the second copy of that mapping
 * the whole arrangement exists to avoid.
 */
function declares(declared: readonly string[], scope: string): boolean {
  return declared.includes(scope);
}

/**
 * Where a reader can see the two lists this verdict was reached from.
 *
 * Named rather than described, because the fact the diagnosis turns on was
 * invisible for as long as this panel existed and a reader checking it by hand
 * had nowhere to look.
 */
const WHERE_THE_LISTS_ARE =
  'The Connected as section of the Connections page lists what your sign-in carries and what this ' + 'app asks for.';

/**
 * One scope refusal, as a verdict with the evidence that reached it.
 *
 * Takes booleans and lists rather than reaching for them, so every branch is
 * reachable in a test without a workspace, a token or an environment.
 */
export function scopeRefusalDiagnosis(input: {
  /**
   * The Apps-API name for this call's family, from `scopeForPath`. Empty when
   * no family claims the path, which is a finding rather than a default.
   */
  declarable: string;
  /** The name the workspace used in its own refusal, when it named one. */
  namedByWorkspace: string;
  /** The scopes this deployment declares, or null when it was not told. */
  declared: readonly string[] | null;
  /** The scopes the presented sign-in lists, or null when it did not say. */
  tokenScopes: readonly string[] | null;
  /**
   * Whether the presented sign-in carries {@link declarable}, from
   * `tokenScopeVerdict`, or null when its absence proves nothing.
   *
   * THREE-VALUED, and the third value is the point. `false` here is a fact about
   * the token: it enumerated its permissions in a vocabulary this deployment
   * recognises and the one being refused was not among them. `null` means the
   * token said nothing, or said it in a spelling nothing has been taught, and
   * reading that silence as absence is how a reader who holds a scope gets sent
   * to a private window.
   *
   * REQUIRED, THOUGH `null` IS ALWAYS AN HONEST ANSWER. Omitting it defaulted to
   * the undecided reading, which is safe on its own and still lets this row and
   * the session strip describe one token differently -- the strip reporting a
   * sign-in that carries everything over a row naming a stale sign-in as one of
   * two candidates. Making the caller state what it read is what keeps the two
   * on one source; a caller that read nothing says so by passing `null`.
   */
  scopeHeld: boolean | null;
}): ScopeRefusalDiagnosis {
  const { declarable, namedByWorkspace, declared, tokenScopes, scopeHeld } = input;
  const scope = declarable || namedByWorkspace;

  // The workspace's own word for it, kept whenever it differs, because that is
  // the string a reader will search for and the two vocabularies genuinely
  // disagree: a refusal says `vector-search` where the bundle must say
  // `vectorsearch.vector-search-indexes:read`.
  // Two short sentences rather than one with a semicolon in the middle. The
  // clause version read as a correction of itself: a reader met two permission
  // names and a subordinate clause about each before learning that they are the
  // same permission under two vocabularies.
  const alias =
    namedByWorkspace && namedByWorkspace !== scope
      ? ` The workspace calls it \`${namedByWorkspace}\`. The app declares the same permission as ` + `\`${scope}\`.`
      : '';

  const carried = tokenScopes
    ? `The sign-in this request carried lists ${quotedScopes(tokenScopes)}.`
    : 'The sign-in this request carried does not list its own permissions.';

  if (!declared) {
    return {
      cause: UNDETERMINED,
      evidence: `The refusal named \`${scope}\`. ${carried} This deployment was not told which permissions it declares.`,
      // No claim about WHY the scope is absent, and none available: the two
      // candidates need different people and the list that separates them is
      // not in this container. Checked by the audit, which is why the sentence
      // reports what was not established rather than filling the gap.
      explanation:
        `The workspace refused this call over the \`${scope}\` permission. The call stopped there, ` +
        `so nothing was established about whether ${input.tokenScopes ? 'you' : 'this identity'} ` +
        'can reach the object. Whether this app asks for that permission was not established ' +
        'either. This deployment was not told what it declares.',
      // Always null here. A remedy is a claim about a cause, and the two
      // candidate remedies contradict each other.
      remedy: null,
      grantIsMissing: false,
    };
  }

  if (declares(declared, scope)) {
    // THE SCOPE IS RULED OUT BY THE TOKEN THAT WAS PRESENTED. The app asks for
    // it, the sign-in enumerates it, and the workspace refused anyway, so the
    // one thing left between this identity and the object is a grant on the
    // object. The sign-in remedy below is not merely unhelpful here, it is
    // misdirection: a reader who opens a private window gets a second token
    // carrying the same permission and the same refusal.
    if (scopeHeld === true) {
      return {
        cause: 'workspace-refused-a-held-scope',
        evidence:
          `The app declares ${declared.length} permissions including \`${scope}\`, and the sign-in ` +
          `this request carried lists it. The refusal named \`${namedByWorkspace || scope}\`.`,
        explanation:
          `Your sign-in carries \`${scope}\`, and the workspace refused this call anyway.${alias} ` +
          'That rules the permission out and leaves a grant on the object itself, which an admin ' +
          `adds. A new sign-in will not move this one. ${WHERE_THE_LISTS_ARE}`,
        // The statement names the object and the principal, neither of which is
        // this module's to know. See `grantIsMissing`.
        remedy: null,
        grantIsMissing: true,
      };
    }

    // NEITHER RULED IN NOR RULED OUT, and said as much. The sign-in did not
    // enumerate its permissions, or enumerated them in a spelling this
    // deployment has not been taught, so the branch above cannot be reached and
    // the one below cannot be asserted. A fresh sign-in is still offered,
    // because it is the cheaper of the two candidates to rule out and it is
    // correct either way, but the prose no longer tells a reader their sign-in
    // lacks something nothing read: the explanation names both candidates and
    // the remedy asserts neither.
    if (scopeHeld === null) {
      return {
        cause: 'declared-scope-refused',
        evidence:
          `The app declares ${declared.length} permissions including \`${scope}\`. ${carried} The ` +
          `refusal named \`${namedByWorkspace || scope}\`.`,
        explanation:
          `This app asks for \`${scope}\`, and the workspace refused this call over it.${alias} ` +
          'Whether the sign-in this request carried holds that permission was not established, so ' +
          'this is either a sign-in older than the permission or a grant you are missing on the ' +
          `object. The call stopped before it could tell. ${WHERE_THE_LISTS_ARE}`,
        remedy: freshSignIn(),
        grantIsMissing: false,
      };
    }

    return {
      cause: 'token-lacks-declared-scope',
      evidence:
        `The app declares ${declared.length} permissions including \`${scope}\`. ${carried} The ` +
        `refusal named \`${namedByWorkspace || scope}\`.`,
      // FOUR SHORT SENTENCES, not one that says three things and contradicts
      // itself in the middle. The version this replaced ran "Nothing was
      // established about whether you can reach the object: the call stopped
      // before it got there, so this row is not a permission you are missing"
      // together, which put a finding, its reason and a warning against a
      // different conclusion into one clause chain and read as broken English.
      // Every distinction in it is load-bearing and all of them survive: the
      // call stopped, so nothing about the object was established, so nobody
      // should read this as a grant they lack.
      explanation:
        `Your sign-in to this app does not carry \`${scope}\`, which the app asks for.${alias} ` +
        'The call stopped there, so nothing was established about whether you can reach the ' +
        `object. This is not a grant you are missing. ${WHERE_THE_LISTS_ARE}`,
      remedy: freshSignIn(),
      grantIsMissing: false,
    };
  }

  return {
    cause: 'app-declares-no-such-scope',
    evidence:
      `The app declares ${quotedScopes(declared)}. \`${scope}\` is not among them, and the refusal ` +
      `named \`${namedByWorkspace || scope}\`. ${carried}`,
    explanation:
      `This app does not ask for \`${scope}\`, so no sign-in it hands out can carry it.${alias} ` +
      'The call stopped there, so nothing was established about whether you can reach the object. ' +
      'A new sign-in will not move this one, and there is nothing you can do about it from the ' +
      `browser. ${WHERE_THE_LISTS_ARE}`,
    remedy: {
      kind: 'cli',
      // The only surviving step of the four, and the only one that was ever
      // load-bearing here. The other three were already done on this
      // deployment; this branch is the case where they have not been.
      statement:
        `# Check the Apps API accepts the NAME before declaring it. It validates against a\n` +
        `# narrower list than the workspace's OAuth metadata, and one rejected name fails the\n` +
        `# whole deploy. This answers without deploying and creates nothing:\n` +
        `databricks api post /api/2.0/apps \\\n` +
        `  --json '{"name":"<an-app-that-already-exists>","user_api_scopes":["${scope}"]}'\n` +
        `# "already exists" means the name is good. "not a valid scope" means it is not.\n` +
        `#\n` +
        `# Then add it to app_user_api_scopes in databricks.yml, and restart. Scopes are read\n` +
        `# when the app STARTS, so a redeploy on its own leaves the change inert:\n` +
        `databricks apps stop <app-name>\n` +
        `databricks apps start <app-name>`,
      // ONE LINE, AND IT IS THE ONE THE RESTART DOES NOT COVER. A deployer who
      // runs the statement above sees the app come back declaring the scope and
      // reasonably reports it fixed; every reader already signed in still fails,
      // because a session keeps the permissions it was minted with. Without this
      // sentence that is a second round of the same investigation, for several
      // people. The other half of the paragraph said no GRANT can fix this,
      // which `run_by` below already says on the same surface.
      guidance:
        'Anyone already signed in keeps their old permissions after the restart, and needs a new ' +
        'sign-in to pick this up.',
      run_by: 'Run by whoever deploys this app. A workspace admin cannot fix this and a GRANT will not',
    },
    grantIsMissing: false,
  };
}
