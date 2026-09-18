import type { AppGroupsSettings } from '../../shared/app-groups';

export interface AppGroupsDocument {
  settings: AppGroupsSettings;
  revision: number;
}

export class AppGroupsError extends Error {
  readonly kind: 'conflict' | 'authorization' | 'session' | 'unavailable' | 'invalid' | 'network' | 'response';
  readonly status: number;

  constructor(
    message: string,
    kind: 'conflict' | 'authorization' | 'session' | 'unavailable' | 'invalid' | 'network' | 'response',
    status = 0
  ) {
    super(message);
    this.name = 'AppGroupsError';
    this.kind = kind;
    this.status = status;
  }
}

function failure(response: Response, detail: string): AppGroupsError {
  if (response.status === 400) return new AppGroupsError(detail || 'The teams were not valid.', 'invalid', 400);
  if (response.status === 401) return new AppGroupsError('Your session expired. Sign in again.', 'session', 401);
  if (response.status === 403) return new AppGroupsError('Only administrators can change teams.', 'authorization', 403);
  if (response.status === 409)
    return new AppGroupsError(detail || 'Teams changed after this page loaded. Reload and retry.', 'conflict', 409);
  if (response.status === 503)
    return new AppGroupsError(detail || 'Lakebase could not save the teams.', 'unavailable', 503);
  return new AppGroupsError(detail || `Teams answered ${response.status}.`, 'response', response.status);
}

async function request(input: RequestInfo | URL, init?: RequestInit): Promise<AppGroupsDocument> {
  try {
    const response = await fetch(input, { credentials: 'same-origin', ...init });
    const body = (await response.json().catch(() => null)) as (AppGroupsDocument & { detail?: string }) | null;
    if (!response.ok) throw failure(response, body?.detail ?? '');
    if (!body || typeof body.revision !== 'number' || !body.settings)
      throw new AppGroupsError('Teams returned an unreadable response.', 'response', response.status);
    return { settings: body.settings, revision: body.revision };
  } catch (cause) {
    if (cause instanceof AppGroupsError) throw cause;
    throw new AppGroupsError('The network request failed. Check your connection and retry.', 'network');
  }
}

export function loadAppGroups(): Promise<AppGroupsDocument> {
  return request('/api/admin/app-groups');
}

export function saveAppGroups(patch: Partial<AppGroupsSettings>, revision: number): Promise<AppGroupsDocument> {
  return request('/api/admin/app-groups', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision, patch }),
  });
}
