/**
 * Identity metadata read from the Databricks control plane as this app.
 *
 * The app calls SCIM Users for the signed-in user's optional workspace
 * metadata and Apps for deployment plus its dedicated service-principal
 * identity. No forwarded user token is used and no credential or raw
 * control-plane error is returned.
 */
import type { ControlPlaneIdentityMetadata } from '../../shared/identity-metadata';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import { APP_NAME_ENV, APPS_PATH, workspaceIdFromAppUrl } from './app-metadata';
import { ExpiringLruCache } from './expiring-lru';

export const USER_METADATA_TTL_MS = 60_000;
export const USER_METADATA_CACHE_MAX_ENTRIES = 512;
export const APP_CONTEXT_TTL_MS = 5 * 60_000;
export const APP_CONTEXT_CACHE_MAX_ENTRIES = 64;

export const SCIM_USERS_PATH = '/api/2.0/preview/scim/v2/Users';

export type ControlPlaneReader = (path: string, query?: Record<string, string>) => Promise<unknown>;

type UserRead = ControlPlaneIdentityMetadata['user'];
type AppRead = {
  workspaceId: string;
  servicePrincipal: ControlPlaneIdentityMetadata['servicePrincipal'];
};

const userCache = new ExpiringLruCache<UserRead>(USER_METADATA_CACHE_MAX_ENTRIES, USER_METADATA_TTL_MS);
const appCache = new ExpiringLruCache<AppRead>(APP_CONTEXT_CACHE_MAX_ENTRIES, APP_CONTEXT_TTL_MS);

/** Test seam and deployment-reload seam. */
export function forgetControlPlaneIdentityMetadata(): void {
  userCache.clear();
  appCache.clear();
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function identifierOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
}

function readAt(now: number): string {
  return new Date(now).toISOString();
}

function keyPart(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function scimResources(body: unknown): Record<string, unknown>[] {
  const resources = recordOf(body).Resources;
  return Array.isArray(resources) ? resources.map(recordOf) : [];
}

async function readUser(email: string, host: string, reader: ControlPlaneReader, now: number): Promise<UserRead> {
  const key = `${keyPart(host)}\u0000${keyPart(email)}`;
  const cached = userCache.get(key, now);
  if (cached) return cached;
  const empty: UserRead = { displayName: '', objectId: '', state: 'not_reported', readAt: readAt(now) };
  if (!email || !host) {
    userCache.set(key, empty, now);
    return empty;
  }
  let result = empty;
  try {
    const body = await reader(SCIM_USERS_PATH, { filter: `userName eq ${email}` });
    const matching = scimResources(body).find((candidate) => keyPart(textOf(candidate.userName)) === keyPart(email));
    if (matching) {
      result = {
        displayName: textOf(matching.displayName),
        objectId: textOf(matching.id),
        state: 'verified',
        readAt: readAt(now),
      };
    }
  } catch {
    // Denied and unavailable are deliberately the same safe wire state.
  }
  userCache.set(key, result, now);
  return result;
}

async function readAppContext(
  appName: string,
  host: string,
  reader: ControlPlaneReader,
  now: number
): Promise<AppRead> {
  const key = `${keyPart(host)}\u0000${keyPart(appName)}`;
  const cached = appCache.get(key, now);
  if (cached) return cached;
  let result: AppRead = {
    workspaceId: '',
    servicePrincipal: {
      displayName: '',
      applicationId: '',
      objectId: '',
      authenticationType: '',
      attachedResourceCount: null,
      state: 'not_reported',
    },
  };
  if (appName && host) {
    try {
      const app = recordOf(await reader(`${APPS_PATH}/${encodeURIComponent(appName)}`));
      const applicationId = textOf(app.service_principal_client_id);
      const displayName = textOf(app.service_principal_name);
      const objectId = identifierOf(app.service_principal_id);
      const resources = Array.isArray(app.resources) ? app.resources.length : null;
      result = {
        workspaceId: workspaceIdFromAppUrl(textOf(app.url)),
        servicePrincipal: {
          displayName,
          applicationId,
          objectId,
          authenticationType: applicationId ? 'OAuth machine-to-machine' : '',
          attachedResourceCount: resources,
          state: displayName || applicationId || objectId ? 'verified' : 'not_reported',
        },
      };
    } catch {
      // The workspace id is omitted unless the platform reports it.
    }
  }
  appCache.set(key, result, now);
  return result;
}

let workspaceClient: import('@databricks/sdk-experimental').WorkspaceClient | undefined;

/** Production reader using only Databricks Apps' injected app credentials. */
export const workspaceControlPlaneReader: ControlPlaneReader = async (path, query) => {
  const { WorkspaceClient } = await import('@databricks/sdk-experimental');
  if (!workspaceClient) {
    workspaceClient = new WorkspaceClient({ httpTimeoutSeconds: 5, retryTimeoutSeconds: 0 });
  }
  return workspaceClient.apiClient.request({
    path,
    method: 'GET',
    ...(query ? { query } : {}),
    headers: new Headers({ Accept: 'application/json' }),
    raw: false,
  });
};

export async function readControlPlaneIdentityMetadata(
  input: {
    email: string;
    appName?: string;
    workspaceHost?: string;
  },
  deps: { read?: ControlPlaneReader; now?: number } = {}
): Promise<ControlPlaneIdentityMetadata> {
  const appName = (input.appName ?? process.env[APP_NAME_ENV] ?? '').trim();
  const workspaceHost = normalizeWorkspaceHost(input.workspaceHost ?? process.env.DATABRICKS_HOST);
  const now = deps.now ?? Date.now();
  const reader = deps.read ?? workspaceControlPlaneReader;
  const [user, app] = await Promise.all([
    readUser(input.email.trim(), workspaceHost, reader, now),
    readAppContext(appName, workspaceHost, reader, now),
  ]);
  return {
    user,
    app: {
      displayName: 'Astrolabe',
      resourceName: appName,
      workspaceHost,
      workspaceId: app.workspaceId,
    },
    servicePrincipal: app.servicePrincipal,
  };
}
