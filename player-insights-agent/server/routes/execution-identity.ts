/**
 * Who asked, and under whose authority it ran.
 *
 *   1. The signed-in human (`x-forwarded-email`, stored as
 *      `conversations.user_email`, and the thing the rail watermarks.
 *   2. The app service principal), what the app server itself authenticates
 *      as: every Lakebase query, and the call to the serving endpoint.
 *   3. The agent serving principal, what the orchestrator inside the Model
 *      Serving endpoint authenticates as for preflight and dependency checks.
 *      Who runs Genie/SQL on an ask is `analyticalExecution` (signed-in user under
 *      user-authorization), not this principal by default.
 *   4. The access mode the user chose at the gate, which says what was
 *      checked (or skipped), not who executes.
 *
 * 2 and 3 are DIFFERENT PRINCIPALS. That was verified against the live
 * deployment rather than assumed, and collapsing them into one
 * "service principal" field would misreport the hop that matters most: the app
 * principal never touches Unity Catalog, and the serving principal is not an
 * identity the app can authenticate as or grant anything to.
 */
import { ACCESS_GATE_ENABLED } from '../../shared/access-gate';
import { ExpiringLruCache } from '../lib/expiring-lru';

/** How much of the system the user was told their own permissions govern. */
export type AccessMode =
  /**
   * Proceeded (or defaulted) without verifying the reader's own grants.
   * A gate mode about what was checked, not a claim about who executes asks —
   * that is `analyticalExecution` from `/api/identity`.
   */
  | 'service-principal'
  /**
   * The user's own grants were checked, and held, before they were let in.
   * Records what was verified under their token, not who will execute later
   * asks — that is `analyticalExecution` from `/api/identity`.
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
export function rememberServingPrincipal(report: { principal?: unknown; principal_resolved?: unknown }): void {
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
 *
 * A verified decision is not a session. It expires after five minutes and the
 * whole process holds at most 2,048 users, so a long-lived instance cannot retain
 * every identity it has ever seen or reuse an old verification indefinitely.
 */
export const ACCESS_DECISION_TTL_MS = 5 * 60_000;
export const ACCESS_DECISION_CACHE_MAX_ENTRIES = 2_048;
const decisions = new ExpiringLruCache<AccessDecision>(ACCESS_DECISION_CACHE_MAX_ENTRIES, ACCESS_DECISION_TTL_MS);

function decisionKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Record a mode the caller declared for itself.
 *
 * Refuses `user-verified`, which is not the caller's to declare. It is granted
 * by `recordVerifiedAccess` after the checks have run and passed. Returns the
 * decision that is now in force so a caller cannot assume its request landed.
 */
export function declareAccessMode(email: string, mode: AccessMode, detail: string, now = Date.now()): AccessDecision {
  if (mode === 'user-verified') {
    throw new Error(
      'user-verified is established by running the access checks, not by declaring it. ' +
        'Call recordVerifiedAccess with the outcome of a real check.'
    );
  }
  const decision: AccessDecision = { mode, decidedAt: new Date(now).toISOString(), detail };
  decisions.set(decisionKey(email), decision, now);
  return decision;
}

/** Record that this user's own grants were checked, and held. */
export function recordVerifiedAccess(email: string, detail: string, now = Date.now()): AccessDecision {
  const decision: AccessDecision = { mode: 'user-verified', decidedAt: new Date(now).toISOString(), detail };
  decisions.set(decisionKey(email), decision, now);
  return decision;
}

/**
 * The mode in force for a user.
 *
 * Absent means nobody has been through the gate in this process, which resolves
 * to the default rather than to nothing: `service-principal` here means own
 * access was not verified, not that asks run as a service principal. Who executes
 * is `analyticalExecution`.
 */
export function accessModeFor(email: string, now = Date.now()): AccessMode {
  return decisions.get(decisionKey(email), now)?.mode ?? 'service-principal';
}

export function accessDecisionFor(email: string, now = Date.now()): AccessDecision | null {
  return decisions.get(decisionKey(email), now) ?? null;
}

/** Test seam, and what a sign-out would call if this app had one. */
export function forgetAccessDecisions(): void {
  decisions.clear();
}

/**
 * The mode to write against a turn, or null when there is none to write.
 *
 * Null while the gate is disabled and nobody has been asked, because the default
 * above would file every turn under the fallback and the Monitoring page counts
 * that as a reader who declined the check. Absent is the honest column value for
 * a check that did not run; `notChecked` is the bucket it lands in.
 *
 * @param gate Defaults to the deployment's switch, and is a parameter so a test
 *   can drive both states.
 */
export function recordedAccessMode(email: string, gate = ACCESS_GATE_ENABLED, now = Date.now()): AccessMode | null {
  if (gate) return accessModeFor(email, now);
  return accessDecisionFor(email, now)?.mode ?? null;
}

/**
 * What a turn actually executed as, as opposed to what the user was told at the gate.
 *
 * A SEPARATE FIELD FROM `access_mode`, which is item 4 above: the mode the user
 * was admitted under. The two answer different questions and used to be
 * conflated, which is how a run recorded as `user-verified` was misread as a
 * claim about who executed. `access_mode` says what was checked at the gate.
 * This says whose credential the endpoint was called with.
 *
 * The vocabulary is `IdentityMode` from server/lib/identity-binding.ts, taken as
 * a string here because that module imports the access-verification route and
 * this one is imported by it.
 */
export interface ExecutionRecord {
  mode: string;
  /** Whether the forwarded token was proven to belong to the signed-in user. */
  verified: boolean;
}

/**
 * The identity columns for one turn, in the order the INSERT wants them.
 *
 * A single place that builds them, so a new write path cannot record four of
 * the six and leave the record looking answered.
 *
 * `execution` is optional and records nulls when absent. Null is the honest
 * value for a row written by something that did not call the endpoint, and it
 * is what turns recorded before these columns existed already hold: a backfill
 * would be inventing an audit trail.
 */
export function executionIdentityColumns(email: string, execution?: ExecutionRecord) {
  const serving = observedServingPrincipal();
  return [
    appServicePrincipal(),
    serving?.id ?? null,
    serving?.observedAt ?? null,
    recordedAccessMode(email),
    execution?.mode ?? null,
    execution?.verified ?? null,
  ] as const;
}
