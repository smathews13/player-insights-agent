import type { SpIdentityAdminPayload } from '../../shared/sp-identity';
import type { Role, RosterPayload } from '../../shared/user-roster-contract';

export const EMPTY_SP_IDENTITY: SpIdentityAdminPayload = {
  enabled: false,
  minting: { available: false, detail: '' },
  personas: [],
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

export async function persistSpIdentityMode(enabled: boolean): Promise<SpIdentityAdminPayload> {
  const response = await fetch('/api/admin/sp-identity/mode', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  return readSpPayload(response, 'saved the experimental pivot');
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

async function rosterResponse(response: Response): Promise<RosterPayload> {
  const body = (await response.json().catch(() => null)) as (RosterPayload & { detail?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.detail ?? `The human roster answered ${response.status}.`);
  return body;
}

export async function loadHumanRoster(): Promise<RosterPayload> {
  return rosterResponse(await fetch('/api/users'));
}

export async function changeHumanRole(email: string, role: Role): Promise<RosterPayload> {
  return rosterResponse(
    await fetch(`/api/users/${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
  );
}

export async function writeHumanRoster(url: string, method: string, body: unknown): Promise<RosterPayload> {
  return rosterResponse(
    await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
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
