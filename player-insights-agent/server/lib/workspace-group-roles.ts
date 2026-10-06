import type { Role } from '../../shared/user-roster-contract';
import type { AdminStore } from './admin-identity';
import { SCIM_USERS_PATH, workspaceControlPlaneReader, type ControlPlaneReader } from './control-plane-identity';
import { readGroupRoleMappings } from './group-role-mappings';
import { ExpiringLruCache } from './expiring-lru';

export type GroupRoleLookup = (email: string) => Promise<Extract<Role, 'admin' | 'consumer'> | null>;

interface GroupRoleMapping {
  groupName: string;
  role: Extract<Role, 'admin' | 'consumer'>;
}

/**
 * The deployment's admin access group, read per call because Git recovery may
 * restore the environment after this module loads. Keep its case: SCIM names
 * are exact.
 */
export function configuredAdminGroup(): string {
  return process.env.PLAYER_INSIGHTS_ADMIN_GROUP?.trim() || '';
}

export function isConfiguredAdminGroup(groupName: string): boolean {
  const configured = normalized(configuredAdminGroup());
  return Boolean(configured) && normalized(groupName) === configured;
}

/**
 * Stored mappings plus the deployment's admin group as an Admin floor.
 *
 * The configured group is not an editable suggestion: a stale Lakebase row must
 * never turn its members into consumers, so it replaces any stored row for the
 * same group. Super admin stays an explicit roster role.
 */
function withConfiguredAdminGroup(stored: readonly GroupRoleMapping[]): GroupRoleMapping[] {
  const adminGroup = configuredAdminGroup();
  const kept = stored.filter((mapping) => !isConfiguredAdminGroup(mapping.groupName));
  return adminGroup ? [{ groupName: adminGroup, role: 'admin' }, ...kept] : kept;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';
}

function scimFilterLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const MEMBERSHIP_TTL_MS = 15_000;
const MEMBERSHIP_CACHE_MAX_ENTRIES = 512;
// Group membership per caller, never the derived role: a mapping change in
// Identity applies on the next request. Membership (owned by the workspace) may
// lag by up to 15 seconds, which also bounds how long removing someone from an
// admin-mapped group takes. Only a read that returned the caller is cached; a
// failed read or a body without them is retried on the next request.
const memberships = new ExpiringLruCache<ReadonlySet<string>>(MEMBERSHIP_CACHE_MAX_ENTRIES, MEMBERSHIP_TTL_MS);

/** Test and deployment-reload seam. */
export function forgetWorkspaceGroupMemberships(): void {
  memberships.clear();
}

async function workspaceGroupsFor(caller: string, reader: ControlPlaneReader): Promise<ReadonlySet<string>> {
  const cached = memberships.get(caller);
  if (cached) return cached;
  const body = await reader(SCIM_USERS_PATH, { filter: `userName eq ${scimFilterLiteral(caller)}` });
  const resources = record(body).Resources;
  const user = Array.isArray(resources)
    ? resources.map(record).find((candidate) => normalized(candidate.userName) === caller)
    : null;
  const groups = Array.isArray(user?.groups)
    ? new Set(
        user.groups
          .map(record)
          .map((group) => normalized(group.display))
          .filter(Boolean)
      )
    : new Set<string>();
  if (user) memberships.set(caller, groups);
  return groups;
}

function roleFromGroups(
  mappings: readonly GroupRoleMapping[],
  groups: ReadonlySet<string>
): Extract<Role, 'admin' | 'consumer'> | null {
  if (mappings.some((mapping) => mapping.role === 'admin' && groups.has(normalized(mapping.groupName)))) {
    return 'admin';
  }
  return mappings.some((mapping) => mapping.role === 'consumer' && groups.has(normalized(mapping.groupName)))
    ? 'consumer'
    : null;
}

/**
 * The deployment admin group alone, with no stored state. Role resolution uses
 * this when the roster cannot be read: an unreadable store still admits nobody,
 * but deployment config does not live in the store.
 */
export function deploymentGroupRoleLookup(reader: ControlPlaneReader = workspaceControlPlaneReader): GroupRoleLookup {
  return async (email) => {
    const caller = normalized(email);
    const mappings = withConfiguredAdminGroup([]);
    if (!caller || mappings.length === 0) return null;
    try {
      return roleFromGroups(mappings, await workspaceGroupsFor(caller, reader));
    } catch {
      return null;
    }
  };
}

export function groupRoleLookupForStore(
  store: AdminStore,
  reader: ControlPlaneReader = workspaceControlPlaneReader
): GroupRoleLookup {
  return async (email) => {
    const caller = normalized(email);
    if (!caller) return null;
    // An unreadable store drops only the stored mappings; the deployment floor
    // does not depend on Lakebase.
    const stored = await readGroupRoleMappings(store).catch((error) => {
      console.warn(
        `[admin] Stored group mappings could not be read (${(error as Error).message}); ` +
          'only the deployment admin group applies to this request.'
      );
      return [];
    });
    const mappings = withConfiguredAdminGroup(stored);
    if (mappings.length === 0) return null;
    try {
      return roleFromGroups(mappings, await workspaceGroupsFor(caller, reader));
    } catch {
      return null;
    }
  };
}
