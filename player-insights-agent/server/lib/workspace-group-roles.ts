import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import type { Role } from '../../shared/user-roster-contract';
import type { AdminStore } from './admin-identity';
import { SCIM_USERS_PATH, workspaceControlPlaneReader, type ControlPlaneReader } from './control-plane-identity';

const SCIM_SERVICE_PRINCIPALS_PATH = '/api/2.0/preview/scim/v2/ServicePrincipals';
const SCIM_ME_PATH = '/api/2.0/preview/scim/v2/Me';
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
 * The deployment's other access groups (Engineer and Exec), comma separated in
 * the environment so a Deploy from Git carries them. They sign in as Consumers;
 * naming them here makes Identity list them and keeps a stale stored row from
 * changing what the deployment says.
 */
export function configuredConsumerGroups(): string[] {
  const seen = new Set<string>();
  return (process.env.PLAYER_INSIGHTS_CONSUMER_GROUPS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => {
      const key = normalized(name);
      if (!key || key === normalized(configuredAdminGroup()) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function isConfiguredConsumerGroup(groupName: string): boolean {
  const key = normalized(groupName);
  return Boolean(key) && configuredConsumerGroups().some((name) => normalized(name) === key);
}

/** Every group whose role the deployment sets, with that role. Admin first. */
export function deploymentGroups(): GroupRoleMapping[] {
  const adminGroup = configuredAdminGroup();
  return [
    ...(adminGroup ? [{ groupName: adminGroup, role: 'admin' as const }] : []),
    ...configuredConsumerGroups().map((groupName) => ({ groupName, role: 'consumer' as const })),
  ];
}

export function isDeploymentManagedGroup(groupName: string): boolean {
  return isConfiguredAdminGroup(groupName) || isConfiguredConsumerGroup(groupName);
}

/**
 * Stored mappings plus the deployment's access groups.
 *
 * A configured group is not an editable suggestion: a stale Lakebase row must
 * never turn the admin group's members into consumers, so the deployment's role
 * replaces any stored row for the same group. Super admin stays an explicit
 * roster role, and individual users are never touched by any of this.
 */
function withConfiguredAdminGroup(stored: readonly GroupRoleMapping[]): GroupRoleMapping[] {
  const kept = stored.filter((mapping) => !isDeploymentManagedGroup(mapping.groupName));
  return [...deploymentGroups(), ...kept];
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

// A service principal signs in as its application ID and is listed under
// ServicePrincipals, not Users.
const APPLICATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function groupNames(groups: unknown[]): ReadonlySet<string> {
  return new Set(
    groups
      .map(record)
      .map((group) => normalized(group.display))
      .filter(Boolean)
  );
}

export type SelfReader = (token: string) => Promise<unknown>;

/** The caller's own SCIM record, read with their own token. */
export const workspaceSelfReader: SelfReader = async (token) => {
  const host = normalizeWorkspaceHost(process.env.DATABRICKS_HOST);
  if (!host) throw new Error('DATABRICKS_HOST is not set');
  const response = await fetch(`${host}${SCIM_ME_PATH}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`SCIM Me returned ${response.status}`);
  return response.json();
};

/**
 * Record the caller's groups from their own SCIM record.
 *
 * A directory read by a principal that is not a workspace admin returns user and
 * service principal records with no `groups` at all, so the app service
 * principal cannot see anybody's membership. `Me` read with the caller's own
 * forwarded token can. Kept only when the record is the caller's, so a token
 * for one identity can never set another's groups. Never throws.
 */
export async function rememberOwnGroups(
  caller: string,
  token: string | null,
  read: SelfReader = workspaceSelfReader
): Promise<boolean> {
  const key = normalized(caller);
  if (!key || !token || memberships.get(key)) return false;
  try {
    const me = record(await read(token));
    if (normalized(me.userName) !== key && normalized(me.applicationId) !== key) return false;
    if (!Array.isArray(me.groups)) return false;
    memberships.set(key, groupNames(me.groups));
    return true;
  } catch {
    return false;
  }
}

async function workspaceGroupsFor(caller: string, reader: ControlPlaneReader): Promise<ReadonlySet<string>> {
  const cached = memberships.get(caller);
  if (cached) return cached;
  const servicePrincipal = APPLICATION_ID_PATTERN.test(caller);
  const body = servicePrincipal
    ? await reader(SCIM_SERVICE_PRINCIPALS_PATH, { filter: `applicationId eq ${scimFilterLiteral(caller)}` })
    : await reader(SCIM_USERS_PATH, { filter: `userName eq ${scimFilterLiteral(caller)}` });
  const resources = record(body).Resources;
  const key = servicePrincipal ? 'applicationId' : 'userName';
  const user = Array.isArray(resources)
    ? resources.map(record).find((candidate) => normalized(candidate[key]) === caller)
    : null;
  // A record without `groups` means the reader may not see membership, not that
  // there is none, so it is not cached over a later self read.
  if (!Array.isArray(user?.groups)) return new Set<string>();
  const groups = groupNames(user.groups);
  memberships.set(caller, groups);
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
