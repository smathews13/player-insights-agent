import type { SpIdentityAdminPayload, SpPersonaDefinition, SpPersonaDefinitionWrite } from '../../shared/sp-identity';
import type { Role, RosterPayload } from '../../shared/user-roster-contract';

export const EMPTY_SP_IDENTITY: SpIdentityAdminPayload = {
  minting: { available: false, detail: '' },
  personas: [],
  personaDefinitions: [],
  assignments: [],
  roster: [],
};

/** Radix Select refuses an empty string; this is "no persona, stay on OAuth". */
export const UNASSIGNED_PERSONA = 'oauth';

function serverDetail(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const detail = (body as { detail?: unknown }).detail;
  return typeof detail === 'string' && detail.trim() ? detail.trim() : fallback;
}

async function readSpPayload(response: Response, operation: string): Promise<SpIdentityAdminPayload> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? `SP personas returned an unreadable response when ${operation}.`
        : `SP personas answered ${response.status} without an error message.`
    );
  }
  if (!response.ok) throw new Error(serverDetail(body, `SP personas answered ${response.status}.`));
  return body as SpIdentityAdminPayload;
}

export async function loadSpIdentityAdmin(): Promise<SpIdentityAdminPayload> {
  return readSpPayload(await fetch('/api/admin/sp-identity'), 'loaded');
}

/** Rename the existing identity only; this never deletes the stored identity or invents credentials. */
export async function renameSpPersona(id: string, displayName: string): Promise<void> {
  const response = await fetch(`/api/admin/sp-identity/personas/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(serverDetail(body, `Saving the persona name answered ${response.status}.`));
  }
}

async function definitionResponse(response: Response, operation: string): Promise<SpPersonaDefinition> {
  const body = (await response.json().catch(() => null)) as (SpPersonaDefinition & { detail?: string }) | null;
  if (!response.ok || !body) {
    throw new Error(serverDetail(body, `The persona configuration answered ${response.status} when ${operation}.`));
  }
  return body;
}

export async function createSpPersonaDefinition(write: SpPersonaDefinitionWrite): Promise<SpPersonaDefinition> {
  return definitionResponse(
    await fetch('/api/admin/sp-identity/persona-definitions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(write),
    }),
    'generated'
  );
}

export async function updateSpPersonaDefinition(
  id: string,
  write: SpPersonaDefinitionWrite
): Promise<SpPersonaDefinition> {
  return definitionResponse(
    await fetch(`/api/admin/sp-identity/persona-definitions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(write),
    }),
    'saved'
  );
}

export async function deleteSpPersonaDefinition(id: string): Promise<void> {
  const response = await fetch(`/api/admin/sp-identity/persona-definitions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(serverDetail(body, `Removing the persona configuration answered ${response.status}.`));
  }
}

export type HumanRosterFailure =
  | 'invalid'
  | 'conflict'
  | 'authorization'
  | 'session'
  | 'unavailable'
  | 'network'
  | 'response';

export class HumanRosterError extends Error {
  readonly kind: HumanRosterFailure;
  readonly status: number;

  constructor(message: string, kind: HumanRosterFailure, status = 0) {
    super(message);
    this.name = 'HumanRosterError';
    this.kind = kind;
    this.status = status;
  }
}

function rosterFailure(response: Response, body: { detail?: string; error?: string } | null): HumanRosterError {
  const detail = typeof body?.detail === 'string' ? body.detail.trim() : '';
  if (response.status === 400)
    return new HumanRosterError(detail || 'Enter a valid work email and role.', 'invalid', 400);
  if (response.status === 409) {
    return new HumanRosterError(detail || 'That person already has a conflicting role.', 'conflict', 409);
  }
  if (response.status === 401) {
    return new HumanRosterError('Your session expired. Sign in again, then retry.', 'session', 401);
  }
  if (response.status === 403) {
    return new HumanRosterError('You are not authorized to change human roles.', 'authorization', 403);
  }
  if (response.status === 503) {
    if (body?.error === 'roster_confirmation_unavailable') {
      return new HumanRosterError(
        'Lakebase could not confirm the saved role. Reload before retrying.',
        'unavailable',
        503
      );
    }
    return new HumanRosterError('Lakebase could not save the role. Try again.', 'unavailable', 503);
  }
  return new HumanRosterError(detail || `The human roster answered ${response.status}.`, 'response', response.status);
}

async function rosterResponse(response: Response): Promise<RosterPayload> {
  const body = (await response.json().catch(() => null)) as
    | (RosterPayload & { detail?: string; error?: string })
    | null;
  if (!response.ok) throw rosterFailure(response, body);
  if (!body)
    throw new HumanRosterError('The human roster returned an unreadable response.', 'response', response.status);
  return body;
}

async function rosterRequest(input: RequestInfo | URL, init?: RequestInit): Promise<RosterPayload> {
  try {
    return await rosterResponse(await fetch(input, { credentials: 'same-origin', ...init }));
  } catch (cause) {
    if (cause instanceof HumanRosterError) throw cause;
    throw new HumanRosterError('The network request failed. Check your connection and try again.', 'network');
  }
}

export async function loadHumanRoster(): Promise<RosterPayload> {
  return rosterRequest('/api/users');
}

export async function changeHumanRole(email: string, role: Role): Promise<RosterPayload> {
  return rosterRequest(`/api/users/${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
}

export async function writeHumanRoster(url: string, method: string, body: unknown): Promise<RosterPayload> {
  return rosterRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function assignSpPersona(email: string, personaId: string | null): Promise<SpIdentityAdminPayload> {
  const response = await fetch('/api/admin/sp-identity/assignments', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, personaId }),
  });
  const body = (await response.json().catch(() => null)) as {
    payload?: SpIdentityAdminPayload;
    detail?: string;
  } | null;
  if (!response.ok) throw new Error(body?.detail ?? `The persona assignment answered ${response.status}.`);
  if (!body?.payload) throw new Error('The persona assignment returned no identity roster.');
  return body.payload;
}
