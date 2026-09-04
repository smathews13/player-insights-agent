/**
 * The roster: who this deployment knows, what role each holds, and what may be
 * done to a row.
 *
 * WHY THIS EXISTS. Roles originally arrived as an environment variable fixed at
 * deploy time. That made a code deployment an authorization change. Production
 * now persists config only when this table is genuinely empty, clears the
 * in-memory seed, and reads every role from Lakebase thereafter. A named person
 * holds the roster and every explicit UI/API change takes effect on the next
 * request without a redeploy.
 *
 * THE PRECEDENCE RULE, ONCE, BECAUSE EVERY EDGE CASE HERE IS A READING OF IT:
 *
 *   The store is authoritative. Absence from deployed config means nothing.
 *
 * SeedRoles remains an input to pure helpers and focused route tests, but
 * production passes an empty seed after bootstrap. A Lakebase outage therefore
 * fails closed; it never revives a stale role from app.yaml.
 *
 * WHAT HAPPENS WITH NO SUPER ADMIN LEFT, in the three ways it can arise:
 *
 *   Through the app        It cannot. Every change that would leave the roster
 *                          with no super admin is refused, which is the same
 *                          refusal the admin list already makes for its last
 *                          admin.
 *   By an edit to the store The store is authoritative. Recovery is an explicit
 *                          database/UI action, never a deployment side effect.
 *   With no seed either     Nobody can appoint anybody, and the app says so and
 *                          prints the statement that inserts a super admin row.
 *                          It does NOT promote the first caller to fill the gap:
 *                          a deployment whose first visitor becomes its
 *                          administrator is a deployment that ships that way, and
 *                          this app is published for customers to deploy. The
 *                          statement is the way back, run by whoever holds the
 *                          database, which is the same shape as every other
 *                          privileged statement this app prints and never runs.
 *
 * NO ROLE HERE GRANTS DATA. Nothing in this file widens what any query may read.
 * Questions run under the asker's own Unity Catalog grants at every rank, through
 * the forwarded user token, exactly as they do for a consumer. A super admin who
 * opens somebody else's conversation in Monitoring sees what their OWN grants
 * allow, and appointing themselves does not change that by one column.
 */
import {
  highestRole,
  isRole,
  ROLE_RANK,
  ROLE_WORD,
  ROLES,
  type Role,
  type RosterEntry,
  type RosterPayload,
  type RosterRefusal,
} from '../../shared/user-roster-contract';
import { ADDED_ADMINS_TABLE } from './admin-roles-schema';
import { columnText, normalizeAdminEmail, type AdminStore } from './admin-identity';
import type { Request } from 'express';

export type { Role, RosterEntry, RosterPayload, RosterRefusal };

/**
 * The column carrying the role, added to the table the admin list already keeps.
 *
 * A COLUMN ON THE EXISTING TABLE RATHER THAN A TABLE OF ITS OWN, and the reason is
 * the boot DDL. This app creates its schema with `CREATE TABLE IF NOT EXISTS` at
 * every start, and a table the DDL has newly learned about does not exist yet, so
 * whichever role runs it first owns it forever -- which has already blocked a
 * release once, when a local server pointed at the deployed branch created three
 * admin tables the app could not then maintain. One additive column on a table the
 * app already owns is the smallest change that cannot repeat that.
 */
export const ROLE_COLUMN = 'role';

/**
 * The statement that adds it, printed rather than run.
 *
 * NOT IN THE BOOT DDL, deliberately, and this is the one place to say why. The
 * schema module's first rule is that nothing alters an existing table, because
 * Postgres checks ownership before it finds an `ADD COLUMN IF NOT EXISTS` to be a
 * no-op, so the statement fails on every deployment where the app is not the owner
 * and succeeds only where it was never needed. This belongs in the versioned
 * migration path instead, and until it has run the roster degrades to exactly the
 * two roles the app had before: rows read as admins, and a role other than admin
 * is refused with this statement on screen.
 */
export const ADD_ROLE_COLUMN_STATEMENT =
  `ALTER TABLE ${ADDED_ADMINS_TABLE} ` + `ADD COLUMN IF NOT EXISTS ${ROLE_COLUMN} TEXT NOT NULL DEFAULT 'admin'`;

/**
 * Postgres for "that column is not there".
 *
 * Matched on the code rather than the message, because the message is localised and
 * a role check that turns on an English substring is a role check that fails in
 * another locale. The message is read only as a fallback, for stores that answer
 * without a code.
 */
const UNDEFINED_COLUMN = '42703';

function missingRoleColumn(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (code === UNDEFINED_COLUMN) return true;
  const message = (error as Error)?.message ?? '';
  return message.includes(ROLE_COLUMN) && /does not exist|undefined column/i.test(message);
}

/** One stored row, in the form the comparison is made in. */
export interface StoredRole {
  email: string;
  role: Role;
  setBy: string;
  setAt: string;
}

export interface StoredRoster {
  rows: StoredRole[];
  /** False on a deployment whose table predates the role column. Every row reads as admin. */
  roleColumnPresent: boolean;
}

const REQUEST_ROSTER = Symbol('request-roster');
const rosterGeneration = new WeakMap<object, number>();

interface RequestRosterSnapshot {
  store: AdminStore;
  generation: number;
  reading: Promise<StoredRoster>;
}

type RequestWithRoster = Request & { [REQUEST_ROSTER]?: RequestRosterSnapshot };

function generationFor(store: AdminStore): number {
  return rosterGeneration.get(store) ?? 0;
}

/**
 * Invalidate snapshots after an authoritative role mutation.
 *
 * The generation is per store and weakly held. A mutation in the middle of a
 * request therefore forces its response read-back to hit Lakebase, while other
 * request objects remain collectible as soon as Express releases them.
 */
export function invalidateRosterCache(store: AdminStore): void {
  rosterGeneration.set(store, generationFor(store) + 1);
}

/**
 * The stored half. Throws when the store does not answer.
 *
 * Deliberately not degraded to an empty roster here, for the reason the admin list
 * is not: the caller has to decide what an unreadable roster means, and it means
 * two different things in the two places this is called. A role check treats it as
 * no stored roles and falls back to the seed floor; the editor has to say the
 * roster could not be read rather than drawing it empty.
 *
 * A MISSING ROLE COLUMN IS NOT A FAILURE and is not reported as one. The rows are
 * re-read without it and every one of them reads as an admin, which is what they
 * were before the column existed. Nobody gains a role from the fallback and nobody
 * loses one.
 */
export async function readRoster(store: AdminStore): Promise<StoredRoster> {
  try {
    const withRole = await store.query(
      `SELECT email, ${ROLE_COLUMN}, added_by, added_at FROM ${ADDED_ADMINS_TABLE} ORDER BY added_at ASC`
    );
    return { rows: withRole.rows.map((row) => storedRole(row, columnText(row[ROLE_COLUMN]))), roleColumnPresent: true };
  } catch (error) {
    if (!missingRoleColumn(error)) throw error;
    const withoutRole = await store.query(
      `SELECT email, added_by, added_at FROM ${ADDED_ADMINS_TABLE} ORDER BY added_at ASC`
    );
    return { rows: withoutRole.rows.map((row) => storedRole(row, 'admin')), roleColumnPresent: false };
  }
}

/**
 * One authoritative full-roster read per request and generation.
 *
 * Both admin guards and the roster handler ask through this seam. Rejections are
 * shared too, so an outage cannot become a second read with a different answer;
 * the guards still interpret that rejection as a denial.
 */
export function readRosterForRequest(store: AdminStore, req: Request): Promise<StoredRoster> {
  const request = req as RequestWithRoster;
  const generation = generationFor(store);
  const cached = request[REQUEST_ROSTER];
  if (cached && cached.store === store && cached.generation === generation) return cached.reading;
  const reading = readRoster(store);
  request[REQUEST_ROSTER] = { store, generation, reading };
  return reading;
}

/**
 * One row, with anything that is not one of the three roles read as admin.
 *
 * AN UNRECOGNISED VALUE READS AS ADMIN, not as consumer and not as an error,
 * because a row in this table has always meant "this person administers this
 * deployment" and a value the app does not know must not silently take that away.
 * It cannot read as super admin: an unrecognised string is not evidence of the
 * highest role. A recognised value is used as written, consumer included -- an
 * explicit consumer row is how the roster lists somebody it has not promoted.
 */
function storedRole(row: Record<string, unknown>, rawRole: string): StoredRole {
  const candidate = rawRole.trim().toLowerCase();
  return {
    email: normalizeAdminEmail(columnText(row.email)),
    role: isRole(candidate) ? candidate : 'admin',
    setBy: columnText(row.added_by),
    setAt: row.added_at instanceof Date ? row.added_at.toISOString() : columnText(row.added_at),
  };
}

/**
 * Write one person's role, creating the row or replacing it.
 *
 * `added_at` is moved to now on a replacement, because the column is what the row
 * prints as "set by, when" and the question a reader asks of a row is when it
 * became what it is now. The history of what it was before is the audit table's,
 * which is append only and is the record a permission change is answerable from.
 *
 * Falls back to writing no role at all when the column is absent, which the caller
 * has already refused for anything but admin: a role the store cannot record must
 * not be reported as recorded.
 */
export async function writeRole(
  store: AdminStore,
  input: { email: string; role: Role; actor: string; roleColumnPresent: boolean }
): Promise<void> {
  const email = normalizeAdminEmail(input.email);
  const actor = normalizeAdminEmail(input.actor);
  if (!input.roleColumnPresent) {
    await store.query(
      `INSERT INTO ${ADDED_ADMINS_TABLE} (email, added_by) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET added_by = EXCLUDED.added_by, added_at = NOW()`,
      [email, actor]
    );
    invalidateRosterCache(store);
    return;
  }
  await store.query(
    `INSERT INTO ${ADDED_ADMINS_TABLE} (email, ${ROLE_COLUMN}, added_by) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE
       SET ${ROLE_COLUMN} = EXCLUDED.${ROLE_COLUMN},
           added_by = EXCLUDED.added_by,
           added_at = NOW()`,
    [email, input.role, actor]
  );
  invalidateRosterCache(store);
}

/** Drop one row. Returns false when there was none, so the route can answer 404. */
export async function deleteRosterRow(store: AdminStore, email: string): Promise<boolean> {
  const result = await store.query(`DELETE FROM ${ADDED_ADMINS_TABLE} WHERE email = $1 RETURNING email`, [
    normalizeAdminEmail(email),
  ]);
  const deleted = result.rows.length > 0;
  if (deleted) invalidateRosterCache(store);
  return deleted;
}

/**
 * What the deployment's environment guarantees one address, and what it guarantees
 * everybody.
 *
 * Passed in rather than read from the process here, so this module has no second
 * notion of where the seed comes from and a test does not have to set an
 * environment variable to assert a precedence rule.
 */
export interface SeedRoles {
  /** Addresses the environment names as super admins. */
  superAdmins: readonly string[];
  /** Every address the environment names, super admins included. */
  admins: readonly string[];
}

/** The floor for one address: the role the environment gives it, or consumer. */
export function seedFloorFor(seed: SeedRoles, email: string): Role {
  const candidate = normalizeAdminEmail(email);
  if (!candidate) return 'consumer';
  if (seed.superAdmins.includes(candidate)) return 'super_admin';
  if (seed.admins.includes(candidate)) return 'admin';
  return 'consumer';
}

/**
 * The role one address effectively holds: the higher of the floor and the store.
 *
 * The whole precedence rule, applied. Everything else in this file that decides
 * something asks this rather than comparing the two halves again.
 */
export function effectiveRole(input: { seed: SeedRoles; stored: readonly StoredRole[]; email: string }): Role {
  const candidate = normalizeAdminEmail(input.email);
  const floor = seedFloorFor(input.seed, candidate);
  const row = input.stored.find((entry) => entry.email === candidate);
  return row ? highestRole(floor, row.role) : floor;
}

/** Every address either half knows, effective role attached, seed rows first. */
export function everyKnownUser(input: {
  seed: SeedRoles;
  stored: readonly StoredRole[];
}): { email: string; role: Role }[] {
  const seen = new Set<string>();
  const out: { email: string; role: Role }[] = [];
  for (const email of [...input.seed.superAdmins, ...input.seed.admins]) {
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ email, role: effectiveRole({ ...input, email }) });
  }
  for (const row of input.stored) {
    if (seen.has(row.email)) continue;
    seen.add(row.email);
    out.push({ email: row.email, role: effectiveRole({ ...input, email: row.email }) });
  }
  return out;
}

/** How many super admins this deployment has, counting both halves once each. */
export function countSuperAdmins(input: { seed: SeedRoles; stored: readonly StoredRole[] }): number {
  return everyKnownUser(input).filter((user) => user.role === 'super_admin').length;
}

/**
 * The statement that appoints a super admin directly in the store.
 *
 * Withheld unless the deployment has nobody who can act, and the caller enforces
 * that. It names the app's own table, which is not a secret and is also not
 * something to put in front of a refused consumer on a working deployment: a
 * refusal that describes the thing behind it is a directory of the things worth
 * asking for. In the state where it IS printed there is nobody to withhold it from,
 * because every surface is refusing everybody.
 */
export function recoveryStatement(): string {
  return (
    `INSERT INTO ${ADDED_ADMINS_TABLE} (email, ${ROLE_COLUMN}, added_by) ` +
    `VALUES ('<address>', 'super_admin', '<who ran this>') ` +
    `ON CONFLICT (email) DO UPDATE SET ${ROLE_COLUMN} = 'super_admin'`
  );
}

/**
 * Why a role change must not happen, or '' when it may.
 *
 * CHECKED AGAINST THE ROSTER AS READ IN THIS REQUEST rather than against what the
 * screen believed, because two super admins demoting each other at once would both
 * pass a check made in a browser and leave the deployment with none.
 */
export function roleChangeRefusal(input: {
  email: string;
  role: unknown;
  seed: SeedRoles;
  stored: readonly StoredRole[];
  roleColumnPresent: boolean;
  /** POST may create an explicit consumer row; PATCH may not reapply consumer. */
  allowMissingConsumer?: boolean;
}): RosterRefusal | '' {
  if (!isRole(input.role)) return 'unknown-role';
  const target = normalizeAdminEmail(input.email);
  const desired = input.role;
  const current = effectiveRole({ seed: input.seed, stored: input.stored, email: target });
  const createsConsumer =
    input.allowMissingConsumer === true &&
    desired === 'consumer' &&
    seedFloorFor(input.seed, target) === 'consumer' &&
    !input.stored.some((entry) => entry.email === target);
  if (desired === current && !createsConsumer) return 'already-holds';
  // A deployment-seeded role is canonical and cannot be lowered in Lakebase:
  // the environment would restore the role on the next request. This is role
  // configuration only; deployment ownership is separate provenance.
  if (current === 'super_admin' && seedFloorFor(input.seed, target) === 'super_admin') {
    return 'immutable-super-admin';
  }
  // The floor. Lowering below it would be undone by the environment on the next
  // request, and a control that appears to work and does not is worse than none.
  if (ROLE_RANK[desired] < ROLE_RANK[seedFloorFor(input.seed, target)]) return 'seed-floor';
  // A role the store cannot record must not be reported as recorded. Admin is
  // recordable without the column, because a row on its own has always meant admin.
  if (!input.roleColumnPresent && desired !== 'admin') return 'no-role-column';
  if (leavesNoSuperAdmin({ ...input, target, desired })) return 'last-super-admin';
  return '';
}

/** Why a removal must not happen, or '' when it may. */
export function removalRefusal(input: {
  email: string;
  seed: SeedRoles;
  stored: readonly StoredRole[];
}): RosterRefusal | '' {
  const target = normalizeAdminEmail(input.email);
  if (!input.stored.some((entry) => entry.email === target)) return 'not-found';
  if (
    effectiveRole({ seed: input.seed, stored: input.stored, email: target }) === 'super_admin' &&
    seedFloorFor(input.seed, target) === 'super_admin'
  ) {
    return 'immutable-super-admin';
  }
  if (seedFloorFor(input.seed, target) !== 'consumer') return 'seed-floor';
  if (leavesNoSuperAdmin({ ...input, target, desired: 'consumer' })) return 'last-super-admin';
  return '';
}

/**
 * Whether making this one change would leave the deployment with no super admin.
 *
 * Counted over the roster with the change applied rather than by asking "is this
 * the only one", so the answer stays right for a removal, a demotion and a change
 * that happens to be neither.
 */
function leavesNoSuperAdmin(input: {
  seed: SeedRoles;
  stored: readonly StoredRole[];
  target: string;
  desired: Role;
}): boolean {
  const after = input.stored
    .filter((entry) => entry.email !== input.target)
    .concat(input.desired === 'consumer' ? [] : [{ email: input.target, role: input.desired, setBy: '', setAt: '' }]);
  return countSuperAdmins({ seed: input.seed, stored: after }) === 0;
}

/**
 * What each refusal says, in one place, so the route and its test read the same
 * words.
 *
 * Each names the state and what would change it, and none of them explains the
 * hierarchy: a person reading a refusal wants to know what to do next, not how the
 * permission model was designed.
 */
export const REFUSAL_DETAIL: Readonly<Record<RosterRefusal, string>> = {
  'immutable-super-admin':
    "That Super admin role is set in this deployment's configuration and cannot be changed or removed here.",
  'seed-floor': "That role is set in this deployment's configuration and cannot be lowered here. It can be raised.",
  'last-super-admin': 'That is the only super admin. Appoint another one first.',
  'not-found': 'That address is not on the roster.',
  'already-holds': 'That address already holds that role.',
  'no-role-column': `This deployment's roster cannot record that role yet. Run: ${ADD_ROLE_COLUMN_STATEMENT}`,
  'unknown-role': `Send one of ${ROLES.join(', ')}.`,
};

/**
 * The roster as the editor draws it, with what may be done to each row decided
 * here.
 *
 * ON THE SERVER RATHER THAN IN THE COMPONENT, because the control the screen draws
 * and the refusal the route makes have to be one rule. A row offering a change the
 * route will refuse is the failure this shape exists to prevent.
 */
export function rosterPayload(input: {
  seed: SeedRoles;
  stored: readonly StoredRole[];
  storedRosterReadable: boolean;
  roleColumnPresent: boolean;
  reader: string;
  deploymentOwner?: string;
}): RosterPayload {
  const you = normalizeAdminEmail(input.reader);
  const deploymentOwner = normalizeAdminEmail(input.deploymentOwner ?? '');
  const superAdminCount = countSuperAdmins({ seed: input.seed, stored: input.stored });
  const adminCount = everyKnownUser({ seed: input.seed, stored: input.stored }).filter(
    (user) => user.role !== 'consumer'
  ).length;
  const entries: RosterEntry[] = everyKnownUser({ seed: input.seed, stored: input.stored })
    .map((user) => {
      const row = input.stored.find((entry) => entry.email === user.email);
      const floor = seedFloorFor(input.seed, user.email);
      return {
        email: user.email,
        isDeploymentOwner: Boolean(deploymentOwner) && user.email === deploymentOwner,
        role: user.role,
        seedFloor: floor,
        setBy: row?.setBy ?? '',
        setAt: row?.setAt ?? '',
        isYou: user.email === you,
        assignable: ROLES.filter(
          (candidate) =>
            !roleChangeRefusal({
              email: user.email,
              role: candidate,
              seed: input.seed,
              stored: input.stored,
              roleColumnPresent: input.roleColumnPresent,
            })
        ),
        canRemove: !removalRefusal({ email: user.email, seed: input.seed, stored: input.stored }),
      };
    })
    .sort((left, right) => ROLE_RANK[right.role] - ROLE_RANK[left.role] || left.email.localeCompare(right.email));
  return {
    entries,
    storedRosterReadable: input.storedRosterReadable,
    roleColumnPresent: input.roleColumnPresent,
    pendingSchemaStatement: input.roleColumnPresent ? '' : ADD_ROLE_COLUMN_STATEMENT,
    superAdminCount,
    // Only when nobody can act at all. See recoveryStatement.
    recoveryStatement: superAdminCount === 0 && adminCount === 0 ? recoveryStatement() : '',
  };
}

/** One line naming a role change, for the audit trail and nothing else. */
export function roleChangeSentence(input: { actor: string; email: string; from: Role; to: Role }): string {
  return (
    `${input.actor} changed ${input.email} from ${ROLE_WORD[input.from].toLowerCase()} to ` +
    `${ROLE_WORD[input.to].toLowerCase()} in this deployment.`
  );
}
