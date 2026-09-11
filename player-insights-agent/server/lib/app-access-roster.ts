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

  const storedByEmail = new Map(payload.entries.map((entry) => [entry.email.toLowerCase(), entry]));
  const directEntries = snapshot.principals
    .filter((principal) => principal.kind === 'user' && principal.effectivePermission !== null)
    .map((principal) => {
      const entry = storedByEmail.get(principal.name.toLowerCase());
      if (entry) {
        return {
          ...entry,
          appAccess: accessState(principal),
          appAccessDetail: accessDetail(principal),
        };
      }
      return {
        email: principal.name,
        role: 'consumer' as const,
        isDeploymentOwner: false,
        seedFloor: 'consumer' as const,
        setBy: 'Databricks App permissions',
        setAt: '',
        isYou: false,
        appAccess: accessState(principal),
        appAccessDetail: accessDetail(principal),
        assignable: ['admin', 'super_admin'],
        canRemove: false,
      } satisfies RosterEntry;
    });
  const directEmails = new Set(directEntries.map((entry) => entry.email.toLowerCase()));
  const inheritedOrStored = payload.entries
    .filter((entry) => !directEmails.has(entry.email.toLowerCase()) && entry.role !== 'consumer')
    .map((entry) => ({
      ...entry,
      appAccess: 'inherited' as const,
      appAccessDetail:
        'This app role is stored, but direct App access is not listed. It may still apply through a Databricks App group.',
    }));
  const entries = [...directEntries, ...inheritedOrStored];

  return {
    ...payload,
    entries,
    superAdminCount: entries.filter((entry) => entry.role === 'super_admin').length,
    appAccessAvailable: true,
    appAccessMessage:
      'Databricks App permissions determine membership. Player Insights Agent determines each member’s app role.',
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
      console.warn('[identity] Databricks App membership could not be read:', raw);
      return {
        available: false,
        principals: [],
        message:
          response.status === 403
            ? 'Databricks App membership could not be read with this session’s permissions.'
            : `Databricks App membership could not be read (HTTP ${response.status}).`,
      };
    }
    return { available: true, principals: appAccessPrincipals(body), message: '' };
  } catch (error) {
    console.warn('[identity] Databricks App permissions request failed:', (error as Error).message);
    return {
      available: false,
      principals: [],
      message: 'Databricks App membership could not be reached.',
    };
  }
}
