import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import type { Role } from '../../shared/user-roster-contract';
import type { AdminStore } from './admin-identity';

const SCIM_ME_PATH = '/api/2.0/preview/scim/v2/Me';
import { readGroupRoleMappings } from './group-role-mappings';
import { ExpiringLruCache } from './expiring-lru';

export type GroupRole = Extract<Role, 'super_admin' | 'admin' | 'consumer'>;
export type GroupRoleLookup = (email: string) => Promise<GroupRole | null>;

interface GroupRoleMapping {
  groupName: string;
  role: GroupRole;
}

/** Highest first: a member of several groups gets the highest role among them. */
const GROUP_ROLE_ORDER: readonly GroupRole[] = ['super_admin', 'admin', 'consumer'];

/**
 * The deployment's Super admin group. Only the deployment can name it: Identity
 * never maps a group to Super admin, so the top role changes only when the
 * group's membership changes in the identity provider.
 */
export function configuredSuperAdminGroup(): string {
  return process.env.PLAYER_INSIGHTS_SUPER_ADMIN_GROUP?.trim() || '';
}

export function isConfiguredSuperAdminGroup(groupName: string): boolean {
  const configured = normalized(configuredSuperAdminGroup());
  return Boolean(configured) && normalized(groupName) === configured;
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
      if (!key || key === normalized(configuredAdminGroup()) || key === normalized(configuredSuperAdminGroup())) {
        return false;
      }
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function isConfiguredConsumerGroup(groupName: string): boolean {
  const key = normalized(groupName);
  return Boolean(key) && configuredConsumerGroups().some((name) => normalized(name) === key);
}

/** Every group whose role the deployment sets, with that role. Highest first. */
export function deploymentGroups(): GroupRoleMapping[] {
  const superGroup = configuredSuperAdminGroup();
  const adminGroup = isConfiguredSuperAdminGroup(configuredAdminGroup()) ? '' : configuredAdminGroup();
  return [
    ...(superGroup ? [{ groupName: superGroup, role: 'super_admin' as const }] : []),
    ...(adminGroup ? [{ groupName: adminGroup, role: 'admin' as const }] : []),
    ...configuredConsumerGroups().map((groupName) => ({ groupName, role: 'consumer' as const })),
  ];
}

export function isDeploymentManagedGroup(groupName: string): boolean {
  return (
    isConfiguredSuperAdminGroup(groupName) || isConfiguredAdminGroup(groupName) || isConfiguredConsumerGroup(groupName)
  );
}

/**
 * Stored mappings plus the deployment's access groups.
 *
 * A configured group is not an editable suggestion: a stale Lakebase row must
 * never turn the admin group's members into consumers, so the deployment's role
 * replaces any stored row for the same group. Super admin comes only from the
 * deployment's Super admin group or a pinned person, and individual users are
 * never touched by any of this.
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

const MEMBERSHIP_TTL_MS = 15_000;
const MEMBERSHIP_CACHE_MAX_ENTRIES = 512;
// Group membership per caller, never the derived role: a mapping change in
// Identity applies on the next request. Membership (owned by the workspace) may
// lag by up to 15 seconds, which also bounds how long removing someone from an
// admin-mapped group takes. Only the caller's own record is cached; a failed
// read is retried on the next request.
const memberships = new ExpiringLruCache<ReadonlySet<string>>(MEMBERSHIP_CACHE_MAX_ENTRIES, MEMBERSHIP_TTL_MS);
const warnedUnreadable = new ExpiringLruCache<true>(MEMBERSHIP_CACHE_MAX_ENTRIES, 60_000);

/** Test and deployment-reload seam. */
export function forgetWorkspaceGroupMemberships(): void {
  memberships.clear();
  warnedUnreadable.clear();
}

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
 * This is the only source of group membership: the app service principal never
 * reads the directory for it, so a caller whose own record cannot be read gets
 * no group role. Kept only when the record is the caller's, so a token for one
 * identity can never set another's groups. Never throws.
 */
export async function rememberOwnGroups(
  caller: string,
  token: string | null,
  read: SelfReader = workspaceSelfReader
): Promise<boolean> {
  const key = normalized(caller);
  if (!key || !token || memberships.get(key)) return false;
  let reason: string;
  try {
    const me = record(await read(token));
    if (normalized(me.userName) === key || normalized(me.applicationId) === key) {
      if (Array.isArray(me.groups)) {
        memberships.set(key, groupNames(me.groups));
        return true;
      }
      reason = 'the record lists no groups';
    } else {
      reason = 'the record is not the caller';
    }
  } catch (error) {
    reason = (error as Error).message;
  }
  if (!warnedUnreadable.get(key)) {
    warnedUnreadable.set(key, true);
    console.warn(`[admin] A caller's own groups could not be read (${reason}); no group role applies to them.`);
  }
  return false;
}

/** Groups from the caller's own record, or none. */
function ownGroups(caller: string): ReadonlySet<string> {
  return memberships.get(caller) ?? new Set<string>();
}

function roleFromGroups(mappings: readonly GroupRoleMapping[], groups: ReadonlySet<string>): GroupRole | null {
  const held = new Set(
    mappings.filter((mapping) => groups.has(normalized(mapping.groupName))).map((mapping) => mapping.role)
  );
  return GROUP_ROLE_ORDER.find((role) => held.has(role)) ?? null;
}

/**
 * The deployment's own groups alone, with no stored state. Role resolution uses
 * this when the roster cannot be read: an unreadable store still admits nobody,
 * but deployment config does not live in the store.
 */
export function deploymentGroupRoleLookup(): GroupRoleLookup {
  return (email) => {
    const caller = normalized(email);
    const mappings = withConfiguredAdminGroup([]);
    if (!caller || mappings.length === 0) return Promise.resolve(null);
    return Promise.resolve(roleFromGroups(mappings, ownGroups(caller)));
  };
}

export function groupRoleLookupForStore(store: AdminStore): GroupRoleLookup {
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
    return roleFromGroups(mappings, ownGroups(caller));
  };
}
