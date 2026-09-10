import type { Role } from '../../shared/user-roster-contract';
import type { AdminStore } from './admin-identity';
import { SCIM_USERS_PATH, workspaceControlPlaneReader, type ControlPlaneReader } from './control-plane-identity';
import { readGroupRoleMappings } from './group-role-mappings';

export type GroupRoleLookup = (email: string) => Promise<Extract<Role, 'admin' | 'consumer'> | null>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';
}

function scimFilterLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function groupRoleLookupForStore(
  store: AdminStore,
  reader: ControlPlaneReader = workspaceControlPlaneReader
): GroupRoleLookup {
  return async (email) => {
    const caller = normalized(email);
    if (!caller) return null;
    try {
      const mappings = await readGroupRoleMappings(store);
      if (mappings.length === 0) return null;
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
      if (mappings.some((mapping) => mapping.role === 'admin' && groups.has(normalized(mapping.groupName)))) {
        return 'admin';
      }
      return mappings.some((mapping) => mapping.role === 'consumer' && groups.has(normalized(mapping.groupName)))
        ? 'consumer'
        : null;
    } catch {
      return null;
    }
  };
}
