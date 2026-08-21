/**
 * Adds Astrolabe's required OAuth scopes and workspace browse scope to its own
 * Apps resource.
 *
 * Every request is authenticated explicitly with the forwarded user's token.
 * There is deliberately no WorkspaceClient fallback here: the app service
 * principal cannot manage its own authorization, and attempting that path
 * would turn a clear CAN MANAGE refusal into a misleading self-elevation flow.
 */
import { REQUIRED_USER_API_SCOPES } from '../../shared/required-user-api-scopes';
import { OPTIONAL_USER_API_SCOPES } from '../../shared/optional-user-api-scopes';

const APPS_PATH = '/api/2.0/apps';

export type ScopeUpdateResult =
  | { kind: 'updated'; scopes: string[] }
  | { kind: 'unchanged'; scopes: string[] }
  | { kind: 'refused'; status: 403; message: string }
  | { kind: 'failed'; status: number; message: string };

export interface ScopeUpdaterOptions {
  host: string;
  appName: string;
  userToken: string;
  /** Optional browse scopes requested by a specific UI action. */
  additionalScopes?: readonly string[];
  fetchImpl?: typeof fetch;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function messageFrom(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const record = body as Record<string, unknown>;
  return text(record.message) || text(record.error) || text(record.error_code) || fallback;
}

function scopesFrom(body: unknown): string[] {
  const raw =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>).user_api_scopes
      : undefined;
  if (!Array.isArray(raw)) return [];
  return [...new Set(
    raw
      .filter((scope): scope is string => typeof scope === 'string')
      .map((scope) => scope.trim())
      .filter(Boolean),
  )];
}

function appUrl(host: string, appName: string): string {
  return `${host.replace(/\/+$/, '')}${APPS_PATH}/${encodeURIComponent(appName)}`;
}

async function bodyOf(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function failed(response: Response, body: unknown): ScopeUpdateResult {
  const message = messageFrom(body, `Databricks answered HTTP ${response.status}.`);
  if (response.status === 403) {
    return {
      kind: 'refused',
      status: 403,
      message:
        'Ask someone who can manage this app to open it once. Databricks refused this sign-in ' +
        `because it does not have CAN MANAGE on the app. (${message})`,
    };
  }
  return { kind: 'failed', status: response.status || 502, message };
}

/**
 * Read, merge, then update. The stable de-duplication preserves every scope an
 * administrator already granted and makes a repeated click a no-op. Workspace
 * browse scopes are optional to asks but included here because a Git deploy
 * otherwise cannot obtain the token scopes used by Connections browsing.
 */
export const MANAGER_GRANT_USER_API_SCOPES = [
  ...REQUIRED_USER_API_SCOPES,
  ...OPTIONAL_USER_API_SCOPES,
] as const;

export async function allowAstrolabeUserApiScopes(
  options: ScopeUpdaterOptions,
): Promise<ScopeUpdateResult> {
  const call = options.fetchImpl ?? fetch;
  const url = appUrl(options.host, options.appName);
  const headers = {
    authorization: `Bearer ${options.userToken}`,
    accept: 'application/json',
  };

  let read: Response;
  try {
    read = await call(url, { method: 'GET', headers });
  } catch (error) {
    return { kind: 'failed', status: 502, message: `Databricks could not be reached: ${(error as Error).message}` };
  }
  const currentBody = await bodyOf(read);
  if (!read.ok) return failed(read, currentBody);

  const current = scopesFrom(currentBody);
  const managed = options.additionalScopes
    ? [...REQUIRED_USER_API_SCOPES, ...options.additionalScopes]
    : MANAGER_GRANT_USER_API_SCOPES;
  const merged = [...new Set([...current, ...managed])];
  if (merged.length === current.length) return { kind: 'unchanged', scopes: current };

  let update: Response;
  try {
    update = await call(url, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ user_api_scopes: merged }),
    });
  } catch (error) {
    return { kind: 'failed', status: 502, message: `Databricks could not be reached: ${(error as Error).message}` };
  }
  const updatedBody = await bodyOf(update);
  if (!update.ok) return failed(update, updatedBody);
  return { kind: 'updated', scopes: merged };
}

