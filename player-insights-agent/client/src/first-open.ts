/**
 * What the login gate shows on first open: the identity the session runs under,
 * the app's required OAuth scopes one row at a time, and the disclaimer.
 *
 * Built to `login-gate.md`. Where that spec and the mockup beside it disagreed,
 * the spec won and the difference is noted at the line it affects.
 *
 * DELIBERATELY NOT THE ACCESS GATE. `AccessGate.tsx` runs a probe under the
 * reader's own token and reports it per table, per Genie space, with a remedy
 * against each; it is switched off in `shared/access-gate.ts` because that report
 * was found confusing in front of a demo. This asks the workspace nothing. Every
 * fact below is already on the `/api/identity` payload the header reads on load.
 *
 * NOTHING HERE IS A SECOND OPINION. The scope comparison is
 * `server/lib/session-freshness.ts`, which reuses `tokenCarriesScope` because the
 * forwarded token spells our catalog reads `unity-catalog` while the bundle has
 * to spell them `catalog.tables:read`. A second copy of that mapping is a second
 * chance to read a token that carries a scope as one that lacks it, and that
 * confusion has printed a GRANT for a present scope once already.
 *
 * THE REQUIRED SET IS READ, NEVER WRITTEN DOWN HERE, which the spec asks for in
 * as many words. `declaredScopes` on the report is `PLAYER_INSIGHTS_USER_API_SCOPES`,
 * which the release resolves from `var.app_user_api_scopes` in `databricks.yml`.
 * That variable is layered per target -- the shared default a customer/T2 target
 * inherits and the example override carry different sets -- so a literal list in this
 * file would tell a reader of one deployment that they are short of permissions
 * the app never asked for on theirs. It would also drift from the platform's own spelling, and
 * the `:read` suffix is live enough to be worth naming: the app declares
 * `vectorsearch.vector-search-indexes:read`, with the suffix, while the design
 * mockup shows it without. Reading the list is what stops this screen taking a
 * side in that.
 */
import type { Identity } from './app-types';
import { DEVELOPMENT_FALLBACK } from './oauth-badge';
import { IDENTITY_RESOLVING, IDENTITY_UNAVAILABLE } from './user-initials';
import {
  OPTIONAL_USER_API_SCOPES,
  isOptionalUserApiScope,
  requiredMissingScopes,
} from '../../shared/optional-user-api-scopes';
// Whether a shortfall is a thing the reader can fix, and the words for it. The
// same module the Connections identity card reads, so the two screens a reader
// can meet this on state one condition in one wording.
import { staleSignInNotice, type StaleSignInNotice } from '../../shared/stale-sign-in';

/**
 * What the scopes block is saying.
 *
 * FOUR, BECAUSE `unchecked` IS NOT `missing`. A check that did not run
 * establishes nothing, and collapsing it into a shortfall would send a reader to
 * their workspace admin about a scope that was never shown to be absent -- which
 * is the mistake `session-freshness.ts` spends its length refusing to make.
 * `resolving` draws nothing at all: a card that appears and then corrects the
 * address on it is worse than one that appears a beat late.
 */
export type FirstOpenVerdict = 'resolving' | 'granted' | 'missing' | 'unchecked';

/**
 * One scope row on the gate.
 *
 * `optional` scopes are always listed (the three catalog reads), whether or not
 * this deployment declares them. `not_declared` means the deploy left them off
 * the OAuth config on purpose — still shown, never a shortfall.
 */
export interface ScopeRow {
  /** Verbatim from the deployment's declaration, or the known optional name. */
  name: string;
  status: 'granted' | 'missing' | 'unchecked' | 'not_declared';
  optional: boolean;
}

/**
 * The line inside the scopes box, split so the scope names can be set in mono.
 *
 * A structure rather than one sentence because the spec sets scope names in DM
 * Mono wherever they appear, and a component cannot pick them back out of a
 * string it was handed without matching on the words.
 */
export interface ScopeFooter {
  lead: string;
  scopes: string[];
  tail: string;
}

export interface FirstOpenReport {
  verdict: FirstOpenVerdict;
  /** The real session user from the OAuth token, never a placeholder (spec). */
  signedInAs: string;
  /** Whether an OAuth sign-in actually reached this app and was read. */
  oauthVerified: boolean;
  /**
   * Required declared scopes first (deployment order), then every optional
   * catalog scope — including ones this deploy did not declare.
   */
  scopes: ScopeRow[];
  /** Required declared scopes the sign-in does not carry. Empty unless `missing`. */
  missing: string[];
  footer: ScopeFooter | null;
}

/* -------------------------------------------------------------------------- */
/* Fixed copy                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The card's heading is the LOCKUP, so there is no title string here any more.
 *
 * `APP_TITLE` used to be the old long name set as an h1. §1 replaces every
 * rendered old name with the astrolabe lockup: the mark, and "astrolabe" in
 * lowercase. `login-gate.md` puts it second, under the Databricks logo, and the
 * dialog takes its accessible name from it.
 */
export const IDENTITY_LABEL = 'You are signing in as';
export const IDENTITY_CAPTION = 'Questions run under this identity.';
export const OAUTH_BADGE = 'OAuth verified';
export const SCOPES_HEADING = 'Required scopes';
export const OPTIONAL_SCOPES_HEADING = 'Optional scopes';

/**
 * One caption under each heading, in the identity card's voice.
 *
 * Required scopes are load-bearing for every question. Optional scopes unlock
 * Connections browsing and Lakebase; a deployment can omit any of them, and
 * workspace read is used for notebook browsing.
 */
export const REQUIRED_SCOPES_NOTE =
  'The app cannot answer questions without these: they power serving, SQL, and Genie.';
export const OPTIONAL_SCOPES_NOTE =
  'Questions still work without these; they unlock Connections browsing (catalogs, tables, notebooks, Vector Search) and Lakebase, and a deployment can omit any of them.';
export const CONTINUE_LABEL = 'Continue';

/**
 * The way past a failing check, named for what it does to the CHECK.
 *
 * It replaces the Continue label rather than standing beside it, because in this
 * build Continue was already live in every state -- the departure noted at the
 * top of `FirstOpenGate.tsx` -- and two controls that dismiss the same card is
 * one control too many. What was missing was never the ability to get past a
 * shortfall; it was any indication on the card that getting past it was allowed,
 * and that doing so fixes nothing.
 */
export const SKIP_LABEL = 'Skip checks and continue';

/**
 * The one line that keeps Skip honest, and it is one line on purpose.
 *
 * A reader who skips has to leave knowing that the app is not now working around
 * the shortfall: nothing was granted, the missing permission is still missing,
 * and the first feature that needs it fails exactly as it would have. Said in a
 * sentence rather than a warning block, because this card is a statement rather
 * than an alert (spec, Disclaimer block) and the same restraint applies here.
 */
export const SKIP_NOTE = 'Skipping grants nothing. Whatever needs a missing scope still fails.';

/**
 * The disclaimer heading, in the spec's capitalisation.
 *
 * SPEC OVER SOURCE. The cost-obs README titles it "Not Official Databricks
 * Software" in title case; `login-gate.md` sets it as "Not official Databricks
 * software", and the spec governs the presentation. The BODY below is the part
 * that is quoted, and it is quoted exactly.
 */
export const DISCLAIMER_TITLE = 'Not official Databricks software';

/** The phrase the source bolds, and the only part of the body that is marked up. */
export const DISCLAIMER_EMPHASIS = 'not an official Databricks product';

/**
 * Verbatim, and never truncated or paraphrased (spec, Disclaimer block).
 *
 * It is the same sentence a customer meets on the other field-engineering app
 * they have been given, and two wordings of one legal position is one wording too
 * many. `first-open-render.test.tsx` asserts that the rendered text is
 * character-for-character this string, so the emphasis cannot drift the sentence
 * while it is marking part of it up.
 */
export const DISCLAIMER_BODY =
  'This application is built and maintained by the Databricks field engineering team and is ' +
  'not an official Databricks product. It is not covered by Databricks Support SLAs. Your ' +
  'Databricks account team can help you deploy, configure, and troubleshoot this app as part ' +
  'of your engagement.';

export const SOURCE_LABEL = 'Source on GitHub';
export const SOURCE_URL = 'https://github.com/smathews13/player-insights-agent';

/**
 * The body either side of the emphasised phrase.
 *
 * A split rather than three literals, so the marked-up render is derived from the
 * one string and cannot say something the string does not.
 */
export function disclaimerParts(): { before: string; emphasis: string; after: string } {
  const at = DISCLAIMER_BODY.indexOf(DISCLAIMER_EMPHASIS);
  if (at === -1) return { before: DISCLAIMER_BODY, emphasis: '', after: '' };
  return {
    before: DISCLAIMER_BODY.slice(0, at),
    emphasis: DISCLAIMER_EMPHASIS,
    after: DISCLAIMER_BODY.slice(at + DISCLAIMER_EMPHASIS.length),
  };
}

/** Said where the app was never told what it asks for, which is not a shortfall. */
const NOTHING_DECLARED = 'This deployment does not declare any required scopes.';

/** Said where the comparison could not be made. It claims nothing either way. */
const NOT_CHECKED = 'Your scopes could not be read, so none of them were checked.';

/** The same, where the identity read itself never landed. */
const NOT_COMPLETED = 'This check did not complete, so no scope was checked.';

/**
 * The fix, with the names left out for the caller to set in mono.
 *
 * WHAT THIS USED TO SAY, AND WHY IT WAS WRONG RATHER THAN MERELY TERSE. It read
 * "N scopes are missing. Ask your workspace admin to add `x` to the app's OAuth
 * configuration." That is the spec's wording and it cannot be right here: every
 * name in this list is one the app ALREADY declares. `missing` is the declared
 * set minus what the presented sign-in carries, so a scope only reaches this
 * footer by being in `user_api_scopes` already. The admin it sent the reader to
 * had nothing left to do, and the reader had the fix in their own browser the
 * whole time.
 *
 * It is the sentence that cost several days. Five Connections rows read 403,
 * they were exactly the five most recently declared permissions, and this screen
 * met the reader on the way in and pointed them at their admin.
 *
 * Takes the notice rather than the list, so this screen cannot state the
 * instruction on evidence the shared gate would have refused. See
 * `shared/stale-sign-in.ts` for what that gate does and does not admit.
 */
export function missingFooter(notice: StaleSignInNotice): ScopeFooter {
  return {
    // `summary`, NOT `lead`, and `scopes` deliberately empty. The rows above this
    // footer are the declared set with a Missing badge against each shortfall, so
    // `lead` plus `notice.missing` set those same names a second time, inline, a
    // few rows below the badges that said it. On the deployment that prompted
    // this the five names ran the footer to eight lines and pushed the card off
    // a laptop viewport; the reader had already been told, in a form that reads
    // faster than prose. The Connections identity card still takes `lead` and
    // `missing`, because there the names are not listed anywhere else.
    lead: notice.summary,
    scopes: [],
    // Both verbatim from `shared/fresh-sign-in.ts`, which is also where the
    // Connections rows and the identity card get them. The browser-names line
    // is the one piece dropped here: this is a footer under a list on a card a
    // reader is trying to get past, and it is the sentence that adds nothing
    // for anyone who has ever opened a private window.
    tail: `${notice.action} ${notice.guidance}`,
  };
}

/**
 * Declared scopes as rows, then any optional scope the deploy left off.
 *
 * Optional names that ARE declared keep their place in declaration order (example
 * interleaves them). Ones that are not declared are appended so a customer
 * four-scope deploy still lists every optional name (catalog reads and
 * workspace read) as Optional.
 */
export function scopeRows(
  declared: readonly string[] | null | undefined,
  missing: readonly string[],
  checked: boolean
): ScopeRow[] {
  const declaredList = declared ?? [];
  const declaredSet = new Set(declaredList);
  const statusFor = (name: string): ScopeRow['status'] =>
    !checked ? 'unchecked' : missing.includes(name) ? 'missing' : 'granted';

  const rows: ScopeRow[] = declaredList.map((name) => ({
    name,
    optional: isOptionalUserApiScope(name),
    status: statusFor(name),
  }));

  for (const name of OPTIONAL_USER_API_SCOPES) {
    if (declaredSet.has(name)) continue;
    rows.push({
      name,
      optional: true,
      status: checked ? 'not_declared' : 'unchecked',
    });
  }
  return rows;
}

export function requiredScopeRows(scopes: readonly ScopeRow[]): ScopeRow[] {
  return scopes.filter((row) => !row.optional);
}

export function optionalScopeRows(scopes: readonly ScopeRow[]): ScopeRow[] {
  return scopes.filter((row) => row.optional);
}

/**
 * What the card says, from the identity read the header already made.
 *
 * Read in this order because the questions are nested: has anything landed, did
 * the read fail, was anybody signed in, and only then what the sign-in carries.
 */
export function firstOpenReport(identity: Identity | null | undefined): FirstOpenReport {
  const signedInAs = identity?.signedInAs ?? IDENTITY_RESOLVING;
  const base = {
    signedInAs,
    oauthVerified: false,
    scopes: [] as ScopeRow[],
    missing: [] as string[],
    footer: null,
  };

  if (!identity || signedInAs === IDENTITY_RESOLVING) return { ...base, verdict: 'resolving' };

  // The identity read failed or never landed. Not a permissions finding: the app
  // does not know who this is, so it must not claim their scopes are fine and
  // must not claim one is absent.
  if (signedInAs === IDENTITY_UNAVAILABLE) {
    return { ...base, verdict: 'unchecked', footer: { lead: NOT_COMPLETED, scopes: [], tail: '' } };
  }

  // Nothing signed this reader in, so the address beside it is the server's
  // stand-in rather than a person. Ordinary on a laptop; on the deployed app it
  // means the platform stopped forwarding the signed-in user.
  if (identity.identitySource === DEVELOPMENT_FALLBACK) {
    return {
      ...base,
      verdict: 'unchecked',
      footer: {
        lead: 'No Databricks sign-in reached this app, so no scope was checked.',
        scopes: [],
        tail: '',
      },
    };
  }

  const session = identity.session;
  // A server too old to report one. Silence read as success is the defect the
  // OAuth badge already refuses to commit, and it is the same fact here.
  if (!session) {
    return { ...base, verdict: 'unchecked', footer: { lead: NOT_COMPLETED, scopes: [], tail: '' } };
  }

  const oauthVerified = session.signedIn;
  const declared = session.declaredScopes;
  const unchecked = (lead: string): FirstOpenReport => ({
    ...base,
    oauthVerified,
    verdict: 'unchecked',
    scopes: scopeRows(declared, [], false),
    footer: { lead, scopes: [], tail: '' },
  });

  if (!session.signedIn) return unchecked(NOT_COMPLETED);
  if (session.state === 'undetermined') return unchecked(declared?.length ? NOT_CHECKED : NOTHING_DECLARED);
  if (!declared || declared.length === 0) return unchecked(NOTHING_DECLARED);

  const allMissing = [...session.missingScopes];
  const scopes = scopeRows(declared, allMissing, true);
  // Catalog (optional) shortfalls do not fail the gate. Asks do not need them.
  const missing = requiredMissingScopes(allMissing);
  if (missing.length === 0) {
    return { ...base, oauthVerified, verdict: 'granted', scopes, missing: [] };
  }
  /**
   * Whether the shortfall earns an instruction, asked of the shared gate.
   *
   * Non-null on every path that reaches here today: the branches above have
   * already ruled out an unread sign-in, an undetermined comparison and a
   * deployment that declares nothing, which is exactly what the gate checks.
   * Asked anyway, and the null handled, because the alternative is this screen
   * holding its own opinion about when to send somebody to a private window --
   * and the whole point of one gate is that a second one drifts.
   */
  const notice = staleSignInNotice(session);
  return {
    ...base,
    oauthVerified,
    verdict: 'missing',
    scopes,
    missing,
    // The pills still say Missing against each row, so a null notice leaves the
    // reader the finding without an instruction, which is the safe direction.
    footer: notice ? missingFooter(notice) : null,
  };
}

/**
 * Whether the card is drawn at all for this report.
 *
 * Its own function, and not `verdict !== 'resolving'` inline, because this is the
 * claim the whole surface turns on and it is the one worth a test.
 */
export function showsFirstOpen(report: FirstOpenReport): boolean {
  return report.verdict !== 'resolving';
}

/**
 * Whether the reader is offered a recheck.
 *
 * A RECHECK IS NOT A BLOCK. The spec renders Continue disabled beside Refresh
 * whenever a scope is missing; this build keeps Continue live, on the standing
 * instruction that a missing scope warns rather than locking the reader out and
 * that this screen must not become a dead end. Refresh is added exactly as the
 * spec asks for it, as the second control and in the app-wide style, so what a
 * reader can DO here is a superset of the spec rather than a departure from it.
 */
export function offersRefresh(report: FirstOpenReport): boolean {
  return report.verdict === 'missing' || report.verdict === 'unchecked';
}

/**
 * Whether the way past is named as a skip rather than as a continue.
 *
 * ONLY WHERE THERE IS SOMETHING TO SKIP. On a card whose every row says Granted
 * there is no check to step over, and a Skip button there would ask the reader
 * what they were being let off -- inviting them to look for a problem the card
 * has just told them it does not have. So `granted` keeps plain Continue, and
 * both states that stop short of it -- a real shortfall, and a comparison that
 * never ran -- name the control for what taking it means.
 *
 * The same predicate as `offersRefresh` today, and deliberately not spelled as
 * `offersRefresh(report)`: they answer different questions about the card and
 * either could change without the other.
 */
export function offersSkip(report: FirstOpenReport): boolean {
  return report.verdict === 'missing' || report.verdict === 'unchecked';
}

/* -------------------------------------------------------------------------- */
/* Once per session                                                            */
/* -------------------------------------------------------------------------- */

/** Namespaced so it is recognisable in a devtools panel beside everything else. */
export const FIRST_OPEN_KEY = 'pia.first-open.acknowledged';

/** Where the dismissal's OUTCOME is recorded, separately from the fact of it. */
export const FIRST_OPEN_OUTCOME_KEY = 'pia.first-open.outcome';

/**
 * How the card was got past, which is NOT a statement about anybody's grants.
 *
 * `skipped` MEANS THE CHECKS WERE NOT SATISFIED, and it must never be read as a
 * weaker form of `passed`. The distinction is the whole reason this is recorded
 * at all: a single "dismissed" flag would let a later reader of that flag
 * conclude the scopes had been verified, when what actually happened is that
 * somebody was shown a shortfall and chose to walk past it.
 *
 * IT GRANTS NOTHING, AND IT ENABLES NOTHING. It is a note about what the reader
 * did, held in this browser session and never sent anywhere. It does not change
 * whose token reads governed data, and there is no branch anywhere that consults
 * it before a read: the app goes on reading as the signed-in person, refusing
 * what their grants refuse, and reporting those refusals as the errors they are.
 * The app's own service principal is not an alternative this value selects, and
 * `POST /api/access-mode` -- the one route that can move execution onto it -- is
 * not reachable from this screen. See `shared/access-gate.ts`, which holds that
 * whole mechanism switched off, and the note in `FirstOpenGate.tsx`.
 *
 * Nothing consumes this yet. It exists so that when something does, the fact it
 * finds is the true one rather than an inference from a dismissal.
 */
export type FirstOpenOutcome = 'passed' | 'skipped';

/** The two methods of `Storage` this needs, so a test can pass a plain object. */
export interface AcknowledgementStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * `sessionStorage`, when there is one that can actually be used.
 *
 * SESSION AND NOT LOCAL, which is the difference between "once per session" and
 * "once, ever". A reader who closes the tab and comes back tomorrow is opening
 * the app again and should meet the disclaimer again; a reader who reloads or
 * navigates in the same sitting has already read it and must not be asked twice.
 * localStorage would answer the second and get the first wrong, and a
 * module-level flag would answer the first and re-prompt on every reload, which
 * is the recurring nag this is specified not to be.
 *
 * The try/catch is around the property access rather than only around `getItem`,
 * because a sandboxed iframe throws a SecurityError on merely reading
 * `window.sessionStorage`, before any key is touched.
 */
export function browserAcknowledgementStore(): AcknowledgementStore | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The same answer for this loaded copy of the app, whatever storage does.
 *
 * Backs the store rather than replacing it: a browser with storage disabled, and
 * the server renderer, both get `null` above, and without this the card would
 * come back on every navigation for exactly those readers.
 */
let acknowledgedHere = false;

const ACKNOWLEDGED = 'true';

/**
 * Whether this session has already been shown the card.
 *
 * Anything other than the exact recorded value counts as not shown, which is the
 * fail-open direction: the cost of a second showing is one click, and the cost of
 * treating junk in a key as an acknowledgement is a disclaimer nobody ever read.
 */
export function firstOpenAcknowledged(store = browserAcknowledgementStore()): boolean {
  if (acknowledgedHere) return true;
  if (!store) return false;
  try {
    return store.getItem(FIRST_OPEN_KEY) === ACKNOWLEDGED;
  } catch {
    return false;
  }
}

/**
 * The dismissal and its outcome, written outcome FIRST.
 *
 * THE ORDER IS THE SAFETY PROPERTY, not a style. Both writes are best effort
 * against a store that can throw, so either can be the one that fails. Filing
 * the outcome before the latch means the two possible partial results are "no
 * record of anything" and "the truth, without the latch" -- never "dismissed,
 * outcome unknown", which is the state a later reader would be tempted to read
 * as a pass. For the same reason `skipFirstOpenChecks` does not delegate to
 * `acknowledgeFirstOpen`: that would write `passed` and then correct it, and a
 * throw in between would leave a skip recorded as a pass.
 */
function record(store: AcknowledgementStore | null, outcome: FirstOpenOutcome): void {
  acknowledgedHere = true;
  if (!store) return;
  try {
    store.setItem(FIRST_OPEN_OUTCOME_KEY, outcome);
    store.setItem(FIRST_OPEN_KEY, ACKNOWLEDGED);
  } catch {
    // Deliberately nothing. See the callers.
  }
}

/**
 * Record that it was shown and dismissed with every check satisfied.
 *
 * Best effort, and the caller keeps its own state either way: a card that
 * refuses to close because a write failed is a control that appears broken,
 * where one that closes and reappears after a reload is a control that worked
 * and a preference that did not stick.
 *
 * `passed` is accurate at its one real call site. Continue is the control on the
 * `granted` verdict only; the two verdicts that fall short of it are got past
 * with Skip below, which records what actually happened.
 */
export function acknowledgeFirstOpen(store = browserAcknowledgementStore()): void {
  record(store, 'passed');
}

/**
 * Dismiss the card with the checks left unsatisfied, and say so.
 *
 * The same dismissal, against the honest outcome. What it does NOT do is the
 * point, and is spelled out on `FirstOpenOutcome` above: no grant, no fallback,
 * no change of execution identity, and no request to any server.
 */
export function skipFirstOpenChecks(store = browserAcknowledgementStore()): void {
  record(store, 'skipped');
}

/**
 * How this session got past the card, or null if it has not or nothing recorded.
 *
 * Only the two exact recorded values answer. Anything else in the key is junk
 * and reads as null, which is the safe direction here for the opposite reason to
 * the latch above: the risk with an unrecognised value is not a second showing
 * of a disclaimer, it is a caller treating garbage as evidence that the scope
 * checks were satisfied.
 */
export function firstOpenOutcome(store = browserAcknowledgementStore()): FirstOpenOutcome | null {
  if (!store) return null;
  try {
    const recorded = store.getItem(FIRST_OPEN_OUTCOME_KEY);
    return recorded === 'passed' || recorded === 'skipped' ? recorded : null;
  } catch {
    return null;
  }
}

/** Test seam, and nothing else. Clears the in-memory half only. */
export function forgetFirstOpen(): void {
  acknowledgedHere = false;
}
