/**
 * Who administers this deployment, and the refusal that makes it mean something.
 *
 * Every runtime role is a row in Lakebase. Deployment config is only a
 * greenfield bootstrap input: when the roster is empty it is inserted once, and
 * when any row exists it is ignored. A later code deploy therefore cannot alter
 * admins, super admins, or explicit consumer rows.
 *
 * THREE RULES DECIDE EVERY EDGE CASE HERE, and each is a correction of the
 * cost-obs app this mechanism is copied from:
 *
 *   1. An empty roster means NOBODY is an admin, not everybody. cost-obs treats a
 *      fresh deployment with no configured admins as one where every caller is
 *      an admin, so whoever set it up can configure it. This app is published
 *      for customers to deploy into their own workspaces, and a deployment
 *      whose first state is "everyone administers" is a deployment that ships
 *      that way. The one-time config bootstrap solves the same problem without
 *      making config authoritative after the first row exists.
 *   2. A failed read of the stored half DENIES rather than admits. cost-obs
 *      falls through to an empty list on a storage error, and an empty list
 *      admits everyone there.
 *   3. BEING AN ADMIN GRANTS NO DATA. Nothing in this file widens what any
 *      query may read. Questions run under the asker's own Unity Catalog
 *      grants, through the forwarded user token, exactly as they do for a
 *      consumer. The role opens tabs. If you are here because you want an
 *      admin to be able to read something a consumer cannot, this is the wrong
 *      file: that decision belongs to Unity Catalog and is made by a grant.
 *
 * Nothing in this module reads a header, a query parameter or a body field that
 * claims a role. The caller's address arrives from the one identity reader the
 * app already has, passed in rather than imported, so this file cannot grow a
 * second notion of who is calling.
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ADDED_ADMINS_TABLE, ADMIN_AUDIT_TABLE } from './admin-roles-schema';
import { columnText, normalizeAdminEmail, type AdminStore } from './admin-identity';
import { opensAdminSurfaces, opensUserRoster, type Role } from '../../shared/user-roster-contract';
import {
  effectiveRole,
  readRoster,
  ROLE_COLUMN,
  seedFloorFor,
  type SeedRoles,
  type StoredRoster,
} from './user-roster';
// The wire shape lives in shared/ so the editor and these routes cannot disagree
// about what a row is. Re-exported because most callers here want it, and a second
// import line at every call site is noise.
import type { AdminListEntry, AdminListPayload } from '../../shared/admin-contract';

export type { AdminListEntry, AdminListPayload };

/**
 * The bundle variable naming this deployment's seed admins.
 *
 * Named for the `PLAYER_INSIGHTS_` family rather than a new prefix, because
 * `PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL` and
 * `PLAYER_INSIGHTS_EXPERIMENT_ID` already established it and a second
 * convention is a second thing to search for when a value does not arrive.
 *
 * UNSET IS A VALID STATE AND IT MEANS NOBODY IS AN ADMIN. That is rule one
 * above, and it is why this has no default.
 */
export const SEED_ADMIN_EMAILS_ENV = 'PLAYER_INSIGHTS_ADMIN_EMAILS';

/**
 * The marker that makes a seed entry a super admin: `super:someone@example.com`.
 *
 * ON THE EXISTING VARIABLE RATHER THAN A SECOND ONE, and that is a deliberate
 * choice about where a customer's own material lives. The value of this variable is
 * supplied through the git-ignored bundle override, so it is the one place a
 * deployment already names people without any address reaching a committed file. A
 * second variable would need a second entry in bundle configuration, a second thing
 * to search for when a value does not arrive, and a second file for somebody to put
 * an address into by mistake.
 *
 * A super entry is ALSO an admin entry. The hierarchy is a total order and a super
 * admin opens everything an admin opens, so the address lands on both halves of the
 * seed and no caller has to remember to check two lists.
 */
export const SEED_SUPER_ADMIN_PREFIX = 'super:';

export type { Role };
export type { AdminStore };
export { columnText, normalizeAdminEmail };

export interface AddedAdmin {
  email: string;
  addedBy: string;
  addedAt: string;
}

export interface RoleResolution {
  role: Role;
  /**
   * Whether the stored half of the list could be read.
   *
   * False does NOT mean the role is unknown. An unreadable store means no
   * added admins, which is rule two, so the role below is a decision rather
   * than a guess. It is reported because the Settings editor has to say the
   * stored list is unreadable instead of drawing it as empty, and because an
   * empty list and an unreachable one are the two states this app keeps being
   * bitten by conflating.
   */
  addedAdminsReadable: boolean;
  /** How many seed admins this deployment has. Zero is meaningful and common. */
  seedAdminCount: number;
}

/**
 * The seed list, and what in the variable was not an address.
 *
 * Separators are commas, semicolons and whitespace, all of them, because the
 * value is typed into bundle configuration by hand and a variable that only
 * accepts one of the three is a lockout waiting for a space after a comma.
 *
 * An entry with no `@` is DROPPED rather than kept. It cannot be an address, so
 * keeping it could never grant anybody anything, and dropping it keeps the rule
 * that the list contains addresses and nothing else. The rejects are returned so
 * the boot log can name them: a typo that silently vanishes is how somebody
 * comes to believe they configured an admin.
 */
export function parseSeedAdmins(raw: string | undefined): {
  emails: string[];
  /** The subset marked with {@link SEED_SUPER_ADMIN_PREFIX}. Every one is also in `emails`. */
  superEmails: string[];
  rejected: string[];
} {
  const emails: string[] = [];
  const superEmails: string[] = [];
  const rejected: string[] = [];
  for (const token of (raw ?? '').split(/[,;\s]+/)) {
    const raw0 = normalizeAdminEmail(token);
    if (!raw0) continue;
    const isSuper = raw0.startsWith(SEED_SUPER_ADMIN_PREFIX);
    const candidate = isSuper ? raw0.slice(SEED_SUPER_ADMIN_PREFIX.length).trim() : raw0;
    if (!candidate.includes('@')) {
      // Reported as written, marker included, so a reader of the boot log sees the
      // entry they typed rather than a fragment of it.
      rejected.push(raw0);
      continue;
    }
    if (!emails.includes(candidate)) emails.push(candidate);
    if (isSuper && !superEmails.includes(candidate)) superEmails.push(candidate);
  }
  return { emails, superEmails, rejected };
}

/**
 * Read once, at boot, and never re-read per request.
 *
 * The same reasoning as the shared conversation rail: a per-request read would
 * let the administrator set change under a running app, which makes an audit of
 * who could do what unanswerable after the fact.
 */
let seedAdmins: string[] = [];
let seedSuperAdmins: string[] = [];

/** What the environment named at boot. Super admins included: they are admins too. */
export function seedAdminEmails(): readonly string[] {
  return seedAdmins;
}

/** The super admins the environment named at boot. A subset of {@link seedAdminEmails}. */
export function seedSuperAdminEmails(): readonly string[] {
  return seedSuperAdmins;
}

/** Both halves of the seed, as the roster's precedence rule wants them. */
export function seedRoles(): SeedRoles {
  return { superAdmins: seedSuperAdmins, admins: seedAdmins };
}

/**
 * Resolve an in-memory seed floor for isolated route tests.
 *
 * Production boot uses {@link bootstrapSeedRoles}; it never calls this function,
 * because retaining deployment config in memory would make a code deploy part
 * of runtime authorization again.
 */
export function announceSeedAdmins(raw: string | undefined = process.env[SEED_ADMIN_EMAILS_ENV]) {
  const { emails, superEmails, rejected } = parseSeedAdmins(raw);
  seedAdmins = emails;
  seedSuperAdmins = superEmails;
  if (rejected.length > 0) {
    console.error(
      `[admin] ${SEED_ADMIN_EMAILS_ENV} contains ${rejected.length} entr${rejected.length === 1 ? 'y' : 'ies'} ` +
        `with no "@" in ${JSON.stringify(rejected)}, so they are NOT addresses and have been ignored. ` +
        'Nothing is exposed by this. If one of them was meant to be an administrator, they are not one.'
    );
  }
  if (emails.length === 0) {
    console.warn(
      `[admin] NO SEED ADMINISTRATORS. ${SEED_ADMIN_EMAILS_ENV} is unset or empty, so nobody is an ` +
        'administrator except whoever an existing admin has added in Lakebase, and on a fresh deployment ' +
        'that is nobody. Monitoring, Ops, Benchmark Lab and the Settings gear will refuse every caller ' +
        'with 403. An empty list means nobody rather than everybody, deliberately. Set the bundle ' +
        'variable to give this deployment an administrator.'
    );
    return;
  }
  console.log(
    `[admin:test] installed ${emails.length} in-memory administrator${emails.length === 1 ? '' : 's'}, ` +
      `${superEmails.length} of them super administrator${superEmails.length === 1 ? '' : 's'}. ` +
      'Production does not use this path; it bootstraps an empty Lakebase roster once.'
  );
  if (superEmails.length === 0) {
    console.log(
      `[admin] NO SEED SUPER ADMINISTRATOR. Nobody can appoint or remove administrators from ` +
        'inside the app unless the stored roster already names a super admin. This deployment therefore ' +
        `has the two roles it always had. To name one, prefix an entry in ${SEED_ADMIN_EMAILS_ENV} with ` +
        `"${SEED_SUPER_ADMIN_PREFIX}".`
    );
  }
}

export type RoleBootstrapState = 'existing-roster' | 'bootstrapped' | 'empty' | 'unavailable';

/**
 * Persist deployment config exactly once, then remove it from runtime authority.
 *
 * Lakebase is the source of truth for every request. The environment is consulted
 * only when the roster is genuinely empty, and even then the INSERT repeats the
 * emptiness check so a concurrent boot cannot overwrite or supplement rows that
 * another instance just created. There is deliberately no UPDATE or DELETE in
 * this path: stale deployed config is absence, not an instruction to change a
 * role.
 */
export async function bootstrapSeedRoles(
  store: AdminStore,
  raw: string | undefined = process.env[SEED_ADMIN_EMAILS_ENV]
): Promise<RoleBootstrapState> {
  const parsed = parseSeedAdmins(raw);

  // Production role checks must never retain an environment floor. These globals
  // remain only for focused route tests that call announceSeedAdmins directly.
  seedAdmins = [];
  seedSuperAdmins = [];

  if (parsed.rejected.length > 0) {
    console.error(
      `[admin] ${SEED_ADMIN_EMAILS_ENV} contains ${parsed.rejected.length} invalid ` +
        `entr${parsed.rejected.length === 1 ? 'y' : 'ies'} and they were ignored.`
    );
  }

  let current: StoredRoster;
  try {
    current = await readRoster(store);
  } catch (error) {
    const rawCode = (error as { code?: unknown }).code;
    const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : 'unknown';
    console.error(
      `[admin] ROLE BOOTSTRAP SKIPPED: the Lakebase roster could not be read (code ${code}: ` +
        `${(error as Error).message}). Astrolabe will keep serving with no stored roles available; ` +
        'Connections reports the storage problem. No configured role was written or retained, because ' +
        'an unreadable roster is not evidence that it is empty.'
    );
    return 'unavailable';
  }
  if (current.rows.length > 0) {
    console.log(
      `[admin] Lakebase already contains ${current.rows.length} role row${current.rows.length === 1 ? '' : 's'}; ` +
        `${SEED_ADMIN_EMAILS_ENV} is ignored. A code deploy cannot add, remove, promote, or demote anybody.`
    );
    return 'existing-roster';
  }

  const roles = parsed.emails.map((email) => ({
    email,
    role: parsed.superEmails.includes(email) ? ('super_admin' as const) : ('admin' as const),
  }));
  if (roles.length === 0) {
    console.warn(
      `[admin] The Lakebase roster is empty and ${SEED_ADMIN_EMAILS_ENV} names nobody. ` +
        'No role was bootstrapped; every caller remains a consumer until an operator explicitly creates a role row.'
    );
    return 'empty';
  }

  const params: string[] = [];
  const values = roles
    .map(({ email, role }, index) => {
      params.push(email, role, email);
      const offset = index * 3;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
    })
    .join(', ');
  const inserted = await store.query(
    `INSERT INTO ${ADDED_ADMINS_TABLE} (email, ${ROLE_COLUMN}, added_by)
     SELECT seed.email, seed.role, seed.added_by
       FROM (VALUES ${values}) AS seed(email, role, added_by)
      WHERE NOT EXISTS (SELECT 1 FROM ${ADDED_ADMINS_TABLE})
     ON CONFLICT (email) DO NOTHING
     RETURNING email, ${ROLE_COLUMN}`,
    params
  );

  if (inserted.rows.length === 0) {
    console.log(
      `[admin] The roster stopped being empty before bootstrap committed; ${SEED_ADMIN_EMAILS_ENV} was ignored.`
    );
    return 'existing-roster';
  }
  console.log(
    `[admin] Bootstrapped ${inserted.rows.length} role row${inserted.rows.length === 1 ? '' : 's'} into Lakebase. ` +
      'Future boots ignore deployed role config because the database is now authoritative.'
  );
  return 'bootstrapped';
}

/**
 * The stored half of the list. Throws when the store does not answer.
 *
 * Deliberately not degraded to an empty array here. The caller has to decide
 * what an unreadable list means, and it means two different things in the two
 * places this is called: a role check treats it as no added admins and denies,
 * and the Settings editor has to say the list could not be read rather than
 * drawing zero rows.
 */
export async function readAddedAdmins(store: AdminStore): Promise<AddedAdmin[]> {
  const result = await store.query(`SELECT email, added_by, added_at FROM ${ADDED_ADMINS_TABLE} ORDER BY added_at ASC`);
  return result.rows.map((row) => ({
    email: normalizeAdminEmail(columnText(row.email)),
    addedBy: columnText(row.added_by),
    addedAt: row.added_at instanceof Date ? row.added_at.toISOString() : columnText(row.added_at),
  }));
}

/**
 * The caller's role from Lakebase.
 *
 * Production clears the in-memory seed after the one-time bootstrap, so the
 * stored row is the entire answer. A store failure is caught and denies rather
 * than falling back to deployed config. Focused route tests may install an
 * in-memory seed with announceSeedAdmins.
 *
 * A SEED SUPER ADMIN SHORT-CIRCUITS THE READ. Not an optimisation: super admin is
 * the top of the order, so the store has nothing to add, and skipping the read means
 * the one role that can repair a broken roster does not depend on reading it.
 */
export async function resolveRole(store: AdminStore, email: string): Promise<RoleResolution> {
  const caller = normalizeAdminEmail(email);
  const seed = seedRoles();
  const floor = seedFloorFor(seed, caller);
  if (floor === 'super_admin') {
    return { role: 'super_admin', addedAdminsReadable: true, seedAdminCount: seed.admins.length };
  }
  try {
    const { rows } = await readRoster(store);
    const role = caller ? effectiveRole({ seed, stored: rows, email: caller }) : 'consumer';
    return { role, addedAdminsReadable: true, seedAdminCount: seed.admins.length };
  } catch (error) {
    console.warn(
      `[admin] The stored roster could not be read (${(error as Error).message}), so this request has ` +
        'no stored roles to check against and resolves at the seed floor. Seed administrators are ' +
        'unaffected. An unreadable roster denies rather than admits.'
    );
    return { role: floor, addedAdminsReadable: false, seedAdminCount: seed.admins.length };
  }
}

/**
 * What `GET /api/identity` carries about the role.
 *
 * On the identity payload rather than at an endpoint of its own, which is the
 * whole of the design: there is one place the browser learns who it is and what
 * it may open, so the two cannot disagree and there is no second notion of the
 * caller anywhere in the app.
 */
export interface RolePayload {
  role: Role;
  addedAdminsReadable: boolean;
  seedAdminCount: number;
}

export async function rolePayload(store: AdminStore, email: string): Promise<RolePayload> {
  const { role, addedAdminsReadable, seedAdminCount } = await resolveRole(store, email);
  return { role, addedAdminsReadable, seedAdminCount };
}

/**
 * The API paths only an administrator may reach.
 *
 * A PREFIX LIST RATHER THAN A GUARD PER ROUTE, on purpose. A route added later
 * under one of these prefixes is refused for a consumer without anybody
 * remembering to wrap it, which is the opposite of the failure mode a
 * per-handler guard has: the handler somebody forgot is the one that serves
 * everybody. Monitoring and Ops are being built on top of this, so they get the
 * refusal by construction.
 *
 * `GET /api/settings` IS DELIBERATELY NOT HERE, and it looks like a gap. It is the
 * Connections page's read endpoint: it reports what the deployment is connected
 * to, Connections is a consumer-visible page that reads it, and it is one of the
 * diagnostics that has to keep answering when the rest of the API is refusing.
 * Mutating Connections routes ARE listed below as narrower prefixes, so a
 * consumer can still read drift while only an administrator may stage intended
 * values, edit declared connections, or request an Apply plan. The gear's own
 * surface has one endpoint, `/api/admins`, and it is here.
 */
export const ADMIN_ROUTE_PREFIXES: readonly string[] = [
  '/api/monitoring',
  '/api/ops',
  '/api/admins',
  // Benchmark Lab is not an admin tab, and its endpoints are still admin-only.
  // The experimental toggle that reveals it is a per-browser preference anybody
  // can set, so on its own it hides the page without protecting it. This is what
  // makes "hidden from consumers" a fact rather than a default.
  '/api/benchmarks',
  // The roster. Under the admin prefixes as well as the super-admin ones below, so
  // that a consumer is refused by the same middleware as every other admin surface
  // and a defect in the narrower guard cannot leave the roster open to everybody.
  '/api/users',
  // The egress controls' WRITE side and classification. `/api/egress/admin` and
  // not `/api/egress`, and the narrowness is deliberate rather than an oversight:
  // `/api/egress/controls` and `/api/egress/events` have to stay open to every
  // signed-in reader, because a consumer's own browser is where the copy buttons
  // and the chart controls are and is therefore the only party that can report an
  // export. Widening this to `/api/egress` would refuse consumers on the recorder,
  // so the only exports still recorded would be administrators' own -- a record
  // that has quietly narrowed to one person while continuing to look complete.
  // `setupEgressRoutes` checks BOTH halves of that and registers nothing if either
  // is wrong.
  '/api/egress/admin',
  // Connections MUTATIONS and the Apply plan. Not `/api/settings` itself: GET
  // must stay open so a consumer can see what the deployment is connected to.
  // These prefixes cover PUT/DELETE on values, POST/DELETE on declared
  // connections, impact/restore, and GET/POST on `/api/settings/apply`.
  '/api/settings/values',
  '/api/settings/connections',
  '/api/settings/apply',
  '/api/settings/resource-tags',
  // One namespace for every release-request lifecycle operation. Creation,
  // claim, and completion all resolve the acting person from the same trusted
  // forwarded identity and are refused to consumers by construction.
  '/api/admin',
];

/**
 * The API paths only a SUPER administrator may reach.
 *
 * A PREFIX LIST FOR THE SAME REASON AS THE ONE ABOVE. A route added later under
 * `/api/users` is refused for a plain admin without anybody remembering to wrap it,
 * which is the opposite of the failure mode a per-handler guard has: the handler
 * somebody forgot is the one that serves everybody.
 *
 * ONLY THE ROSTER IS HERE. Appointing people is the single thing a super admin can
 * do that an admin cannot, and every other admin surface stays open to both, so
 * there is nothing else to add. A super admin reading Monitoring sees exactly what
 * an admin sees, conditioned on their own Unity Catalog grants: the rank is not a
 * grant and does not widen one.
 */
export const SUPER_ADMIN_ROUTE_PREFIXES: readonly string[] = ['/api/users'];

function matchesPrefix(path: string, prefixes: readonly string[]): boolean {
  const lowered = path.toLowerCase();
  return prefixes.some((prefix) => lowered === prefix || lowered.startsWith(`${prefix}/`));
}

/** Whether a request path is one of the admin surfaces. */
export function isAdminRoute(path: string): boolean {
  return matchesPrefix(path, ADMIN_ROUTE_PREFIXES);
}

/** Whether a request path needs the super administrator role. */
export function isSuperAdminRoute(path: string): boolean {
  return matchesPrefix(path, SUPER_ADMIN_ROUTE_PREFIXES);
}

/**
 * What a refused consumer is told.
 *
 * It says that the caller is not an administrator and nothing else. It does not
 * name what was refused and it does not enumerate what an admin would have
 * seen, because a refusal that describes the thing behind it is a directory of
 * the things worth asking for.
 */
export const ADMIN_REQUIRED_BODY = {
  error: 'admin_role_required',
  detail: 'This deployment restricts this to its administrators, and you are not one.',
} as const;

/**
 * What a refused administrator is told.
 *
 * A SEPARATE BODY FROM THE ONE ABOVE, because the two refusals are refusals of
 * different things and a reader who already administers this deployment would read
 * "you are not an administrator" as a fault in the app. It still names no surface
 * and enumerates nothing.
 */
export const SUPER_ADMIN_REQUIRED_BODY = {
  error: 'super_admin_role_required',
  detail: 'This deployment restricts changing roles to its super administrator.',
} as const;

/**
 * Refuse a consumer at the route, for every admin path, with 403.
 *
 * THIS IS THE PERMISSION MODEL. Hiding a tab in the browser is a layout
 * preference that anyone can undo by typing a URL, so the navigation and the
 * badge are decoration on top of this middleware and never a substitute for it.
 *
 * `readEmail` is passed in rather than imported so that this module has no
 * opinion about where identity comes from and cannot grow a second one. The app
 * passes its single identity reader.
 *
 * Any unexpected failure DENIES. `resolveRole` catches the store failure itself,
 * so reaching the catch below means a defect rather than an outage, and the
 * fail-closed reading of a defect in a permission gate is refusal.
 */
export function requireAdmin(store: AdminStore, readEmail: (req: Request) => string) {
  return function refuseNonAdmins(req: Request, res: Response, next: NextFunction) {
    if (!isAdminRoute(req.path)) {
      next();
      return;
    }
    let caller: string;
    try {
      caller = readEmail(req);
    } catch {
      // requireIdentity answers 401 for this before the request reaches here.
      // Reaching it anyway means this middleware was registered ahead of that
      // one, and refusing is the safe reading either way.
      res.status(403).json(ADMIN_REQUIRED_BODY);
      return;
    }
    resolveRole(store, caller)
      .then((resolution) => {
        if (opensAdminSurfaces(resolution.role)) {
          next();
          return;
        }
        console.warn(
          `[admin] REFUSED ${req.method} ${req.path}: the caller is not an administrator of this ` +
            'deployment. Expected whenever a consumer follows a link to an admin surface; the page they ' +
            'land on says so.'
        );
        res.status(403).json(ADMIN_REQUIRED_BODY);
      })
      .catch((error: Error) => {
        console.error(
          `[admin] REFUSED ${req.method} ${req.path}: the role could not be established (${error.message}). ` +
            'Denying rather than admitting, because an unresolved role is not evidence of one.'
        );
        res.status(403).json(ADMIN_REQUIRED_BODY);
      });
  };
}

/**
 * Refuse anybody but a super administrator at the roster routes, with 403.
 *
 * THIS IS THE PERMISSION MODEL FOR APPOINTING PEOPLE, in the same way requireAdmin
 * is for reading admin data. The roster panel is drawn only for a super admin, and
 * that is layout: a plain admin who types the URL or calls the endpoint directly is
 * refused here, and the test for this feature asserts that refusal rather than
 * asserting the panel is hidden.
 *
 * REGISTERED AFTER requireAdmin, NOT INSTEAD OF IT. `/api/users` is on both prefix
 * lists, so a consumer is refused by the first guard and an admin by this one. Two
 * refusals in front of the roster rather than one, because this is the surface that
 * changes who can do what in a customer's deployment.
 *
 * Any unexpected failure DENIES, for the reason requireAdmin's does: resolveRole
 * catches its own store failure, so reaching the catch below means a defect rather
 * than an outage, and the fail-closed reading of a defect in a permission gate is
 * refusal.
 */
export function requireSuperAdmin(store: AdminStore, readEmail: (req: Request) => string) {
  return function refuseNonSuperAdmins(req: Request, res: Response, next: NextFunction) {
    if (!isSuperAdminRoute(req.path)) {
      next();
      return;
    }
    let caller: string;
    try {
      caller = readEmail(req);
    } catch {
      res.status(403).json(SUPER_ADMIN_REQUIRED_BODY);
      return;
    }
    resolveRole(store, caller)
      .then((resolution) => {
        if (opensUserRoster(resolution.role)) {
          next();
          return;
        }
        console.warn(
          `[admin] REFUSED ${req.method} ${req.path}: the caller does not hold the super ` +
            'administrator role of this deployment. Expected whenever an administrator reaches the roster; ' +
            'the panel is not drawn for them.'
        );
        res.status(403).json(SUPER_ADMIN_REQUIRED_BODY);
      })
      .catch((error: Error) => {
        console.error(
          `[admin] REFUSED ${req.method} ${req.path}: the role could not be established ` +
            `(${error.message}). Denying rather than admitting, because an unresolved role is not evidence of one.`
        );
        res.status(403).json(SUPER_ADMIN_REQUIRED_BODY);
      });
  };
}

/**
 * The actions worth a row.
 *
 * `access-revoked` is separate from `admin-removed` even though one action can
 * produce both, and that separation is the point: taking somebody off the list is
 * a decision about a role, and handing back a Unity Catalog privilege an earlier
 * version of this app granted them is a change to what they can read. One combined
 * row would have to pick which of those it meant.
 *
 * THERE IS NO `access-granted`. Nothing in this app grants Unity Catalog
 * privileges; see admin-access.ts for why the add path stopped.
 */
export type AdminAction =
  | 'admin-added'
  | 'admin-removed'
  /**
   * A role set to something other than what it was, by a super admin, on the roster.
   *
   * SEPARATE FROM `admin-added` AND `admin-removed` even though a change can amount
   * to one of them, because the fact a permission change has to be answerable for
   * afterwards is which role somebody went FROM and which they went TO. An addition
   * and a removal are the two rows the admin list wrote when the role was a boolean;
   * with three roles they can no longer carry the change, and a promotion recorded
   * as an addition would read as though the person had not been there before.
   */
  | 'role-changed'
  /** A person taken off the roster entirely, whatever role they held. */
  | 'user-removed'
  | 'conversation-read'
  | 'access-revoked'
  | 'runtime-settings-updated'
  /** An admin recorded or cleared a Connections setting intention (or live value). */
  | 'connection-setting-saved'
  | 'connection-setting-cleared'
  /** An admin asked the app identity to backfill system_billing=astrolabe on managed resources. */
  | 'resource-tags-applied'
  /** An admin corrected a run’s outcome or rating on the Run Explorer rail. */
  | 'run-labels-updated'
  /** An admin saved MLflow / bake-off values on Settings → Experimental. */
  | 'benchmark-settings-updated'
  /** An admin saved the evaluation dataset from Benchmarking. */
  | 'eval-dataset-updated'
  /** An admin added questions from traces to the evaluation dataset. */
  | 'eval-dataset-curated'
  /** An admin aligned judge guidelines from labelled evaluation rows. */
  | 'eval-guidelines-aligned'
  /** An admin promoted a bake-off winner for the next Ask. */
  | 'eval-agent-promoted'
  /** An admin asked this app to list or start workspace production scorers. */
  | 'eval-live-monitoring-probed'
  /** An admin started an MLflow Review App labeling session for SMEs. */
  | 'eval-review-app-started';

/**
 * Record what an admin did: who, when, what.
 *
 * Every add, every removal, every grant and revoke, and every read of another
 * person's conversation.
 * Best effort and never allowed to fail the action it describes: an admin who
 * cannot add an admin because the audit table is unreachable is an admin locked
 * out by the logging, and the write they were making is the one that would fix
 * the outage. The failure is logged loudly instead, so a missing row has a
 * matching line in the app's own output.
 */
export async function recordAdminAction(
  store: AdminStore,
  entry: { actor: string; action: AdminAction; subject: string; detail: string }
): Promise<boolean> {
  try {
    await store.query(
      `INSERT INTO ${ADMIN_AUDIT_TABLE} (id, actor, action, subject, detail) VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), normalizeAdminEmail(entry.actor), entry.action, entry.subject, entry.detail]
    );
    return true;
  } catch (error) {
    console.error(
      `[admin] AUDIT ROW NOT WRITTEN for ${entry.action} by ${entry.actor} on ${entry.subject}: ` +
        `${(error as Error).message}. The action itself went ahead. This line is the record.`
    );
    return false;
  }
}

/**
 * The list as the Settings editor draws it: seed rows first, then added.
 *
 * An address on BOTH halves renders once, as a seed row, because the seed half
 * is the one that decides what may be done to it. Removing the added copy would
 * not remove the role, and a Remove button that leaves somebody an admin is
 * worse than no button.
 */
export function adminListPayload(input: {
  seed: readonly string[];
  added: readonly AddedAdmin[];
  addedAdminsReadable: boolean;
  reader: string;
}): AdminListPayload {
  const you = normalizeAdminEmail(input.reader);
  const seedRows: AdminListEntry[] = input.seed.map((email) => ({
    email,
    origin: 'seed',
    addedBy: '',
    addedAt: '',
    isYou: email === you,
    removable: false,
  }));
  const addedRows: AdminListEntry[] = input.added
    .filter((entry) => !input.seed.includes(entry.email))
    .map((entry) => ({
      email: entry.email,
      origin: 'added',
      addedBy: entry.addedBy,
      addedAt: entry.addedAt,
      isYou: entry.email === you,
      removable: true,
    }));
  return {
    entries: [...seedRows, ...addedRows],
    addedAdminsReadable: input.addedAdminsReadable,
    seedAdminCount: input.seed.length,
  };
}

/**
 * Whether an address is one this app will store.
 *
 * Deliberately not a full address grammar. The check that matters is made by
 * whoever signs in: an address that nobody can authenticate as grants nothing,
 * and a regular expression strict enough to reject a real address is a lockout.
 * So this refuses what is obviously not an address and accepts the rest.
 */
export function invalidAdminEmail(raw: string): string {
  const candidate = normalizeAdminEmail(raw);
  if (!candidate) return 'Enter an email address.';
  if (candidate.length > 320) return 'That is longer than an email address can be.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) return 'That does not look like an email address.';
  return '';
}

export type RemovalRefusal = '' | 'seed-row' | 'last-admin' | 'not-found';

/**
 * Whether removing this address would leave the deployment with no administrator.
 *
 * The refusal the specification asks for, and it is narrower than it sounds: it
 * fires only when the seed list is EMPTY and this is the last added admin. With
 * a seed list, removing every added admin is allowed, because whoever was named
 * at deployment is still an administrator and nothing is lost.
 *
 * A deployment with no administrator cannot appoint one from inside the app, so
 * the only route back is a bundle change and a redeploy. Refusing is what the
 * specification chose over relying on the seed list always being populated.
 */
export function removalRefusal(input: {
  email: string;
  seed: readonly string[];
  added: readonly AddedAdmin[];
}): RemovalRefusal {
  const target = normalizeAdminEmail(input.email);
  if (input.seed.includes(target)) return 'seed-row';
  if (!input.added.some((entry) => entry.email === target)) return 'not-found';
  if (input.seed.length === 0 && input.added.length === 1) return 'last-admin';
  return '';
}

/** What each refusal says, in one place, so the route and its test read the same words. */
export const REMOVAL_REFUSAL_DETAIL: Readonly<Record<Exclude<RemovalRefusal, ''>, string>> = {
  'seed-row':
    'That administrator was set at deployment and cannot be removed here. Edit the bundle variable to change it.',
  'last-admin':
    'That is the last administrator, and this deployment has no seed administrators to fall back on. ' +
    'Removing them would leave nobody able to open Monitoring, Ops or these settings, and nobody able ' +
    'to appoint anybody. Add another administrator first.',
  'not-found': 'That address is not on the list.',
};

/** Add one address. Returns false when it was already there, so the route can say so. */
export async function addAdmin(store: AdminStore, input: { email: string; addedBy: string }): Promise<boolean> {
  const email = normalizeAdminEmail(input.email);
  const result = await store.query(
    `INSERT INTO ${ADDED_ADMINS_TABLE} (email, added_by) VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING email`,
    [email, normalizeAdminEmail(input.addedBy)]
  );
  return result.rows.length > 0;
}

/** Remove one address. Returns false when there was no row, so the route can say so. */
export async function removeAdmin(store: AdminStore, email: string): Promise<boolean> {
  const result = await store.query(`DELETE FROM ${ADDED_ADMINS_TABLE} WHERE email = $1 RETURNING email`, [
    normalizeAdminEmail(email),
  ]);
  return result.rows.length > 0;
}
