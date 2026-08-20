/**
 * The three roles, and what the user roster sends over the wire.
 *
 * Shared so the editor and the routes cannot disagree about what a row is, for the
 * reason admin-contract.ts is shared: a row here carries facts that can differ --
 * the role somebody holds, the role the deployment configuration guarantees them,
 * and whether the store can record a change at all -- and a client that modelled
 * those as one would have to pick which one a row means.
 *
 * NOTHING IN THIS FILE DECIDES ANYTHING. Whether a row may be changed or removed
 * is decided on the server, because the button the screen draws and the refusal
 * the route makes have to be one rule rather than two implementations of it.
 */

/**
 * The hierarchy, highest first.
 *
 * A super admin is an admin who can also appoint people. It is NOT a fourth thing
 * with its own privileges: everything an admin may open, a super admin may open,
 * and the only surface a super admin has that an admin does not is the roster
 * below. That keeps the hierarchy a total order, so "the higher of two roles" is
 * always a role rather than a merge.
 *
 * BEING ANY OF THE THREE GRANTS NO DATA. Questions run under the asker's own Unity
 * Catalog grants at every rank. A role opens surfaces; a grant opens data.
 */
export type Role = 'super_admin' | 'admin' | 'consumer';

/** Every role, highest first, for a select control and for iteration in tests. */
export const ROLES: readonly Role[] = ['super_admin', 'admin', 'consumer'];

/**
 * The roles a super admin may assign, which is all three.
 *
 * A super admin can appoint another super admin. The alternative was considered
 * and is worse: a deployment with exactly one person who can appoint anybody is a
 * deployment that loses its administration when that person leaves the customer,
 * and the only route back would be a redeploy by us. See docs for the decision.
 */
export const ASSIGNABLE_ROLES: readonly Role[] = ROLES;

/** The word for a role, in one place so the badge, the roster and a refusal agree. */
export const ROLE_WORD: Readonly<Record<Role, string>> = {
  super_admin: 'Super admin',
  admin: 'Admin',
  consumer: 'Consumer',
};

/**
 * Rank, so "the higher of two roles" is arithmetic rather than a branch per pair.
 *
 * Exported because the client orders the roster by it and the server compares the
 * seed floor against the stored role with it, and two orderings of three values is
 * two places to get the order wrong.
 */
export const ROLE_RANK: Readonly<Record<Role, number>> = {
  consumer: 0,
  admin: 1,
  super_admin: 2,
};

/** Whether a string off the wire or out of a column is one of the three roles. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && ROLES.includes(value as Role);
}

/**
 * The higher of two roles.
 *
 * THIS IS THE PRECEDENCE RULE, in one function. The seed is a floor and the store
 * decides everything above it: a stored row can raise somebody, and can never
 * lower a person the deployment configuration named. See resolveRole.
 */
export function highestRole(left: Role, right: Role): Role {
  return ROLE_RANK[left] >= ROLE_RANK[right] ? left : right;
}

/** Whether this role may open Monitoring, Ops and the Settings gear. */
export function opensAdminSurfaces(role: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.admin;
}

/** Whether this role may read and change the roster. Super admin only. */
export function opensUserRoster(role: Role): boolean {
  return role === 'super_admin';
}

/**
 * One person on the roster.
 *
 * `role` is what they hold, which is the higher of `seedFloor` and whatever the
 * store says. `seedFloor` is what deployment configuration guarantees them and is
 * the reason a row may not be lowered: a seed row's role cannot be taken away from
 * inside the app, only raised, because the environment would restore it on the next
 * request and a control that appears to work and does not is worse than none.
 */
export interface RosterEntry {
  email: string;
  role: Role;
  /** The floor deployment configuration sets. 'consumer' for anybody it does not name. */
  seedFloor: Role;
  /** Who last set the stored role. Empty when the row exists only in the seed. */
  setBy: string;
  /** When, as an ISO string. Empty when the row exists only in the seed. */
  setAt: string;
  /** Whether this row is the person reading the screen. */
  isYou: boolean;
  /** The roles this row may be changed to. Empty when it may not be changed. */
  assignable: Role[];
  canRemove: boolean;
}

export interface RosterPayload {
  entries: RosterEntry[];
  /** False when the stored half could not be read. The screen says so rather than drawing zero rows. */
  storedRosterReadable: boolean;
  /**
   * Whether the store can record a role at all.
   *
   * False on a deployment whose roster table predates the role column. Rows still
   * read, as admins, so nothing is lost and nobody gains anything; what cannot be
   * done is recording a role other than admin. The screen says so and names the
   * statement in `pendingSchemaStatement` rather than offering a control that
   * would fail.
   */
  roleColumnPresent: boolean;
  /** The statement that adds the role column, when it is absent. Empty otherwise. */
  pendingSchemaStatement: string;
  /** How many super admins this deployment has, counting seed and stored. */
  superAdminCount: number;
  /**
   * The statement that appoints a super admin directly in the store.
   *
   * NON-EMPTY ONLY WHEN THIS DEPLOYMENT HAS NO SUPER ADMIN AND NO ADMIN, which is
   * the one state in which nobody can appoint anybody from inside the app. It is
   * the documented way back, and it names the app's own tables, so it is withheld
   * in every state where somebody is able to act instead.
   */
  recoveryStatement: string;
}

/** A refusal the roster routes make, named so the route and its test read one string. */
export type RosterRefusal =
  | 'seed-floor'
  | 'last-super-admin'
  | 'not-found'
  | 'already-holds'
  | 'no-role-column'
  | 'unknown-role';
