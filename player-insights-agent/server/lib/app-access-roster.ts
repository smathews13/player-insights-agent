/**
 * Databricks App admission, read and changed as the signed-in super admin.
 *
 * PIA roles and the Databricks App ACL are deliberately different authorities:
 * Lakebase decides what somebody may do after admission; the App ACL decides
 * whether Databricks admits them at all. This module keeps those layers aligned
 * without granting CAN_MANAGE for an in-app administrator role.
 */
import type { RosterEntry, RosterPayload } from '../../shared/user-roster-contract';

export type AppPermissionLevel = 'CAN_MANAGE' | 'CAN_USE';
export type AppAccessPrincipalKind = 'user' | 'group' | 'service_principal';

export interface AppAccessPrincipal {
  kind: AppAccessPrincipalKind;
  name: string;
  displayName: string;
  directPermission: AppPermissionLevel | null;
  effectivePermission: AppPermissionLevel | null;
  inherited: boolean;
}

export interface AppAccessSnapshot {
  available: boolean;
  principals: AppAccessPrincipal[];
  message: string;
}

export type AppAccessMutation =
  | { kind: 'updated'; snapshot: AppAccessSnapshot }
  | { kind: 'unchanged'; snapshot: AppAccessSnapshot }
  | { kind: 'refused'; status: 403 | 409; message: string; snapshot?: AppAccessSnapshot }
  | { kind: 'failed'; status: number; message: string; snapshot?: AppAccessSnapshot };

export interface AppAccessOptions {
  host: string;
  appName: string;
  userToken: string;
  fetchImpl?: typeof fetch;
}

function accessState(principal: AppAccessPrincipal): NonNullable<RosterEntry['appAccess']> {
  if (principal.directPermission === 'CAN_MANAGE' || principal.effectivePermission === 'CAN_MANAGE')
    return 'can_manage';
  if (!principal.directPermission && principal.inherited) return 'inherited';
  return 'can_use';
}

function accessDetail(principal: AppAccessPrincipal): string {
  if (principal.directPermission === 'CAN_MANAGE') {
    return 'Direct CAN MANAGE on the Databricks App. Change or remove this in Databricks permissions.';
  }
  if (principal.inherited) {
    return 'App access is inherited from Databricks. Group and inherited grants must be changed in Databricks permissions.';
  }
  return 'Direct CAN USE on the Databricks App.';
}

/**
 * Draw one user list from both authorities.
 *
 * Explicit App users absent from Lakebase become Consumers, which is PIA's
 * default role. Groups and service principals stay separate because expanding
 * them into guessed human members would make the apparent 1:1 list false.
 */
export function alignRosterWithAppAccess(payload: RosterPayload, snapshot: AppAccessSnapshot): RosterPayload {
  if (!snapshot.available) {
    return {
      ...payload,
      entries: payload.entries.map((entry) => ({
        ...entry,
        appAccess: 'unknown',
        appAccessDetail: snapshot.message,
      })),
      appAccessAvailable: false,
      appAccessMessage: snapshot.message,
      appAccessPrincipals: [],
    };
  }

  const users = new Map(
    snapshot.principals
      .filter((principal) => principal.kind === 'user' && principal.effectivePermission !== null)
      .map((principal) => [principal.name.toLowerCase(), principal])
  );
  const entries = payload.entries.map((entry) => {
    const principal = users.get(entry.email.toLowerCase());
    users.delete(entry.email.toLowerCase());
    if (!principal) {
      return {
        ...entry,
        appAccess: 'missing' as const,
        appAccessDetail: 'PIA has a role for this person, but the Databricks App ACL has no explicit user grant.',
      };
    }
    const removableDirectUse = principal.directPermission === 'CAN_USE' && !principal.inherited;
    return {
      ...entry,
      appAccess: accessState(principal),
      appAccessDetail: accessDetail(principal),
      canRemove: entry.canRemove && removableDirectUse,
    };
  });
  for (const principal of users.values()) {
    entries.push({
      email: principal.name,
      role: 'consumer',
      isDeploymentOwner: false,
      seedFloor: 'consumer',
      setBy: 'Databricks App permissions',
      setAt: '',
      isYou: false,
      appAccess: accessState(principal),
      appAccessDetail: accessDetail(principal),
      assignable: ['admin', 'super_admin'],
      canRemove: principal.directPermission === 'CAN_USE' && !principal.inherited,
    });
  }

  return {
    ...payload,
    entries,
    appAccessAvailable: true,
    appAccessMessage:
      'Databricks App permissions control admission. PIA roles control what an admitted person may do inside the app.',
    appAccessPrincipals: snapshot.principals
      .filter(
        (principal): principal is AppAccessPrincipal & { kind: 'group' | 'service_principal' } =>
          principal.kind !== 'user' && principal.effectivePermission !== null
      )
      .map((principal) => ({
        kind: principal.kind,
        name: principal.name,
        displayName: principal.displayName,
        permission: principal.effectivePermission ?? 'CAN_USE',
        inherited: principal.inherited,
      })),
  };
}

interface Permission {
  inherited?: unknown;
  permission_level?: unknown;
}

interface AccessControlResponse {
  all_permissions?: unknown;
  display_name?: unknown;
  group_name?: unknown;
  service_principal_name?: unknown;
  user_name?: unknown;
}

interface PermissionsBody {
  access_control_list?: unknown;
  message?: unknown;
  error?: unknown;
  error_code?: unknown;
}

interface DirectAccessControl {
  group_name?: string;
  service_principal_name?: string;
  user_name?: string;
  permission_level: AppPermissionLevel;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function permission(value: unknown): AppPermissionLevel | null {
  return value === 'CAN_MANAGE' || value === 'CAN_USE' ? value : null;
}

function higher(left: AppPermissionLevel | null, right: AppPermissionLevel | null): AppPermissionLevel | null {
  if (left === 'CAN_MANAGE' || right === 'CAN_MANAGE') return 'CAN_MANAGE';
  if (left === 'CAN_USE' || right === 'CAN_USE') return 'CAN_USE';
  return null;
}

function messageFrom(body: PermissionsBody, fallback: string): string {
  return text(body.message) || text(body.error) || text(body.error_code) || fallback;
}

function principalIdentity(entry: AccessControlResponse): {
  kind: AppAccessPrincipalKind;
  name: string;
} | null {
  const user = text(entry.user_name);
  if (user) return { kind: 'user', name: user.toLowerCase() };
  const group = text(entry.group_name);
  if (group) return { kind: 'group', name: group };
  const servicePrincipal = text(entry.service_principal_name);
  if (servicePrincipal) return { kind: 'service_principal', name: servicePrincipal };
  return null;
}

export function appAccessPrincipals(body: unknown): AppAccessPrincipal[] {
  if (!body || typeof body !== 'object') return [];
  const raw = (body as PermissionsBody).access_control_list;
  if (!Array.isArray(raw)) return [];
  const parsed: AppAccessPrincipal[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as AccessControlResponse;
    const identity = principalIdentity(entry);
    if (!identity) continue;
    const permissions = Array.isArray(entry.all_permissions) ? (entry.all_permissions as Permission[]) : [];
    let directPermission: AppPermissionLevel | null = null;
    let effectivePermission: AppPermissionLevel | null = null;
    let inherited = false;
    for (const item of permissions) {
      if (!item || typeof item !== 'object') continue;
      const level = permission(item.permission_level);
      if (!level) continue;
      effectivePermission = higher(effectivePermission, level);
      if (item.inherited === true) inherited = true;
      else directPermission = higher(directPermission, level);
    }
    parsed.push({
      ...identity,
      displayName: text(entry.display_name) || identity.name,
      directPermission,
      effectivePermission,
      inherited,
    });
  }
  return parsed.sort((left, right) => {
    const kind = left.kind.localeCompare(right.kind);
    return kind || left.name.localeCompare(right.name);
  });
}

function permissionsUrl(options: AppAccessOptions): string {
  return `${options.host.replace(/\/+$/, '')}/api/2.0/permissions/apps/${encodeURIComponent(options.appName)}`;
}

async function responseBody(response: Response): Promise<PermissionsBody> {
  const body = await response.json().catch(() => ({}));
  return body && typeof body === 'object' ? (body as PermissionsBody) : {};
}

function requestHeaders(options: AppAccessOptions): Record<string, string> {
  return {
    authorization: `Bearer ${options.userToken}`,
    accept: 'application/json',
  };
}

function unavailable(status: number, body: PermissionsBody): AppAccessMutation {
  const raw = messageFrom(body, `Databricks answered HTTP ${status}.`);
  if (status === 403) {
    return {
      kind: 'refused',
      status: 403,
      message:
        'Databricks refused the App permission change. The signed-in PIA super admin must also hold CAN MANAGE ' +
        `on this Databricks App and consent to the access-management scope. (${raw})`,
    };
  }
  return { kind: 'failed', status: status || 502, message: raw };
}

export async function readAppAccess(options: AppAccessOptions): Promise<AppAccessSnapshot> {
  if (!options.host || !options.appName || !options.userToken) {
    return {
      available: false,
      principals: [],
      message: 'The running app could not establish its App name, workspace host, or signed-in user token.',
    };
  }
  const call = options.fetchImpl ?? fetch;
  try {
    const response = await call(permissionsUrl(options), {
      method: 'GET',
      headers: requestHeaders(options),
    });
    const body = await responseBody(response);
    if (!response.ok) {
      const raw = messageFrom(body, `Databricks App permissions answered HTTP ${response.status}.`);
      return {
        available: false,
        principals: [],
        message:
          response.status === 403
            ? 'The signed-in PIA super admin must also hold CAN MANAGE on this Databricks App and consent to ' +
              `the access-management scope before the two lists can be aligned. (${raw})`
            : raw,
      };
    }
    return { available: true, principals: appAccessPrincipals(body), message: '' };
  } catch (error) {
    return {
      available: false,
      principals: [],
      message: `Databricks App permissions could not be reached: ${(error as Error).message}`,
    };
  }
}

function directAccessControls(snapshot: AppAccessSnapshot): DirectAccessControl[] {
  return snapshot.principals.flatMap((principal) => {
    if (!principal.directPermission) return [];
    const identity =
      principal.kind === 'user'
        ? { user_name: principal.name }
        : principal.kind === 'group'
          ? { group_name: principal.name }
          : { service_principal_name: principal.name };
    return [{ ...identity, permission_level: principal.directPermission }];
  });
}

async function mutate(
  options: AppAccessOptions,
  method: 'PATCH' | 'PUT',
  accessControlList: DirectAccessControl[]
): Promise<AppAccessMutation> {
  const call = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await call(permissionsUrl(options), {
      method,
      headers: { ...requestHeaders(options), 'content-type': 'application/json' },
      body: JSON.stringify({ access_control_list: accessControlList }),
    });
  } catch (error) {
    return { kind: 'failed', status: 502, message: `Databricks could not be reached: ${(error as Error).message}` };
  }
  const body = await responseBody(response);
  if (!response.ok) return unavailable(response.status, body);
  return {
    kind: 'updated',
    snapshot: { available: true, principals: appAccessPrincipals(body), message: '' },
  };
}

/** Add direct CAN_USE only. PIA Admin never implies Databricks CAN_MANAGE. */
export async function grantAppUse(options: AppAccessOptions, email: string): Promise<AppAccessMutation> {
  const normalized = email.trim().toLowerCase();
  const before = await readAppAccess(options);
  if (!before.available) {
    return { kind: 'failed', status: 503, message: before.message, snapshot: before };
  }
  const existing = before.principals.find((principal) => principal.kind === 'user' && principal.name === normalized);
  if (existing?.directPermission) return { kind: 'unchanged', snapshot: before };
  return mutate(options, 'PATCH', [{ user_name: normalized, permission_level: 'CAN_USE' }]);
}

/**
 * Remove only a direct CAN_USE entry. CAN_MANAGE and inherited access belong to
 * the Databricks permission model and are never silently downgraded here.
 */
export async function revokeDirectAppUse(options: AppAccessOptions, email: string): Promise<AppAccessMutation> {
  const normalized = email.trim().toLowerCase();
  const before = await readAppAccess(options);
  if (!before.available) {
    return { kind: 'failed', status: 503, message: before.message, snapshot: before };
  }
  const existing = before.principals.find((principal) => principal.kind === 'user' && principal.name === normalized);
  if (!existing?.directPermission) {
    if (existing?.inherited) {
      return {
        kind: 'refused',
        status: 409,
        message: `${normalized} inherits App access from a Databricks group. Change that group in Databricks permissions.`,
        snapshot: before,
      };
    }
    return { kind: 'unchanged', snapshot: before };
  }
  if (existing.directPermission === 'CAN_MANAGE') {
    return {
      kind: 'refused',
      status: 409,
      message: `${normalized} holds CAN MANAGE on the Databricks App. Change that permission in Databricks first.`,
      snapshot: before,
    };
  }
  const remaining = directAccessControls(before).filter(
    (principal) => principal.user_name?.toLowerCase() !== normalized
  );
  const changed = await mutate(options, 'PUT', remaining);
  if (changed.kind !== 'updated') return changed;
  const after = await readAppAccess(options);
  if (!after.available) {
    return {
      kind: 'failed',
      status: 503,
      message: 'Databricks accepted the permission update but the app could not confirm it. Reload before retrying.',
      snapshot: after,
    };
  }
  const stillThere = after.principals.find((principal) => principal.kind === 'user' && principal.name === normalized);
  if (stillThere?.effectivePermission) {
    return {
      kind: 'refused',
      status: 409,
      message: `${normalized} still inherits App access from Databricks after its direct CAN USE entry was removed.`,
      snapshot: after,
    };
  }
  return { kind: 'updated', snapshot: after };
}
