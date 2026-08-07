/**
 * Who asked, and under whose authority it ran.
 *
 *   1. The signed-in human (`x-forwarded-email`, stored as
 *      `conversations.user_email`, and the thing the rail watermarks.
 *   2. The app service principal), what the app server itself authenticates
 *      as: every Lakebase query, and the call to the serving endpoint.
 *   3. The agent serving principal, what the orchestrator inside the Model
 *      Serving endpoint authenticates as, and therefore what actually executes
 *      the Genie calls and the SQL against Unity Catalog.
 *   4. The access mode the user chose at the gate, which says which of the
 *      above the user was told was in force.
 *
 * 2 and 3 are DIFFERENT PRINCIPALS. That was verified against the live
 * deployment rather than assumed, and collapsing them into one
 * "service principal" field would misreport the hop that matters most: the app
 * principal never touches Unity Catalog, and the serving principal is not an
 * identity the app can authenticate as or grant anything to.
 */

/** How much of the system the user was told their own permissions govern. */
export type AccessMode =
  /** The default and the design: everything executes as the service principals. */
  | 'service-principal'
  /**
   * The user's own grants were checked, and held, before they were let in.
   * Execution STILL runs as the serving principal. This mode records that the
   * user could have read this data themselves, not that they did.
   */
  | 'user-verified'
  /** The gate was skipped. Recorded so a run cannot look verified by omission. */
  | 'skipped';

export const ACCESS_MODES: readonly AccessMode[] = ['service-principal', 'user-verified', 'skipped'];

export function isAccessMode(value: unknown): value is AccessMode {
  return typeof value === 'string' && (ACCESS_MODES as readonly string[]).includes(value);
}

/**
 * The app's own service principal.
 *
 * Read from the environment every time rather than captured once, and returned
 * as null rather than a placeholder when it is absent: a stored placeholder
 * would sit in the governance record looking like an identity.
 */
export function appServicePrincipal(): string | null {
  return process.env.DATABRICKS_CLIENT_ID?.trim() || null;
}

export interface ServingPrincipalObservation {
  id: string;
  /** When the endpoint last told us this, ISO-8601. */
  observedAt: string;
}

/**
 * The serving principal, as last reported by the agent's own preflight.
 */
let servingPrincipal: ServingPrincipalObservation | null = null;

export function observedServingPrincipal(): ServingPrincipalObservation | null {
  return servingPrincipal;
}

/**
 * Record what a preflight report said the serving principal is.
 *
 * Only a resolved principal is kept. An unresolved one is a placeholder the
 * agent substitutes when `current_user.me()` failed, and storing that against a
 * conversation would turn a failed lookup into a named identity.
 */
export function rememberServingPrincipal(report: {
  principal?: unknown;
  principal_resolved?: unknown;
}): void {
  if (report.principal_resolved !== true) return;
  const id = typeof report.principal === 'string' ? report.principal.trim() : '';
  if (!id) return;
  servingPrincipal = { id, observedAt: new Date().toISOString() };
}

/** Test seam. The observation is process-wide, so it has to be resettable. */
export function forgetServingPrincipal(): void {
  servingPrincipal = null;
}

export interface AccessDecision {
  mode: AccessMode;
  decidedAt: string;
  /** What was actually checked, for the modes where anything was. */
  detail: string;
}

/**
 * What each user was last admitted under.
 *
 * Held server-side, and keyed by the forwarded identity, because the mode is a
 * claim about authority and a claim about authority cannot be taken from the
 * client that benefits from it. A request asserting `user-verified` in a header
 * would be asserting that its own permissions were checked.
 */
const decisions = new Map<string, AccessDecision>();

/**
 * Record a mode the caller declared for itself.
 *
 * Refuses `user-verified`, which is not the caller's to declare. It is granted
 * by `recordVerifiedAccess` after the checks have run and passed. Returns the
 * decision that is now in force so a caller cannot assume its request landed.
 */
export function declareAccessMode(email: string, mode: AccessMode, detail: string): AccessDecision {
  if (mode === 'user-verified') {
    throw new Error('user-verified is established by running the access checks, not by declaring it. ' +
        'Call recordVerifiedAccess with the outcome of a real check.'
    );
  }
  const decision: AccessDecision = { mode, decidedAt: new Date().toISOString(), detail };
  decisions.set(email, decision);
  return decision;
}

/** Record that this user's own grants were checked, and held. */
export function recordVerifiedAccess(email: string, detail: string): AccessDecision {
  const decision: AccessDecision = { mode: 'user-verified', decidedAt: new Date().toISOString(), detail };
  decisions.set(email, decision);
  return decision;
}

/**
 * The mode in force for a user.
 *
 * Absent means nobody has been through the gate in this process, which resolves
 * to the default rather than to nothing: the service principals are what is
 * executing whether or not anyone was asked about it, so that is the truthful
 * label for a turn that predates a decision.
 */
export function accessModeFor(email: string): AccessMode {
  return decisions.get(email)?.mode ?? 'service-principal';
}

export function accessDecisionFor(email: string): AccessDecision | null {
  return decisions.get(email) ?? null;
}

/** Test seam, and what a sign-out would call if this app had one. */
export function forgetAccessDecisions(): void {
  decisions.clear();
}

/**
 * The identity columns for one turn, in the order the INSERT wants them.
 *
 * A single place that builds them, so a new write path cannot record three of
 * the four and leave the record looking answered.
 */
export function executionIdentityColumns(email: string) {
  const serving = observedServingPrincipal();
  return [
    appServicePrincipal(),
    serving?.id ?? null,
    serving?.observedAt ?? null,
    accessModeFor(email),
  ] as const;
}
