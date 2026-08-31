import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RosterPayload } from '../../shared/user-roster-contract';
import type { SpIdentityAdminPayload } from '../../shared/sp-identity';
import { assignSpPersona, changeHumanRole, EMPTY_SP_IDENTITY, renameSpPersona } from './identity-settings-api';
import { RosterRows } from './UserRoleEditor';

const EMAIL = 'person@example.invalid';
const ROSTER: RosterPayload = {
  entries: [
    {
      email: EMAIL,
      role: 'consumer',
      seedFloor: 'consumer',
      setBy: 'owner@example.invalid',
      setAt: '2026-08-28T00:00:00.000Z',
      isYou: false,
      assignable: ['admin'],
      canRemove: true,
    },
  ],
  storedRosterReadable: true,
  roleColumnPresent: true,
  pendingSchemaStatement: '',
  superAdminCount: 1,
  recoveryStatement: '',
};
const SP_PAYLOAD: SpIdentityAdminPayload = {
  ...EMPTY_SP_IDENTITY,
  enabled: true,
  personas: [
    {
      id: 'finance',
      displayName: 'Finance reader',
      clientId: 'aaaaaaaa-0000-4000-8000-000000000001',
      secretScope: 'hidden-scope',
      secretKey: 'hidden-key',
      updatedAt: '2026-08-28T00:00:00.000Z',
      updatedBy: 'owner@example.invalid',
    },
  ],
  roster: [{ email: EMAIL, role: 'consumer', personaId: null }],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Identity mutation boundaries', () => {
  it('changes a human role only through the super-admin roster route', async () => {
    const fetch = vi.fn().mockResolvedValue(json(ROSTER));
    vi.stubGlobal('fetch', fetch);
    await changeHumanRole(EMAIL, 'admin');
    expect(fetch).toHaveBeenCalledWith(`/api/users/${encodeURIComponent(EMAIL)}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
  });

  it('assigns a persona through the admin route without touching the human role', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ payload: SP_PAYLOAD }));
    vi.stubGlobal('fetch', fetch);
    await assignSpPersona(EMAIL, 'finance');
    expect(fetch).toHaveBeenCalledWith('/api/admin/sp-identity/assignments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, personaId: 'finance' }),
    });
  });

  it('renames only an existing backend persona and sends no credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetch);
    await renameSpPersona('finance', 'Finance reporting');
    expect(fetch).toHaveBeenCalledWith('/api/admin/sp-identity/personas/finance', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Finance reporting' }),
    });
    expect(JSON.stringify(fetch.mock.calls)).not.toMatch(/clientId|secretScope|secretKey|hidden-scope|hidden-key/);
  });

  it('keeps human-role controls super-admin-only while persona assignment remains available to admins', () => {
    const markup = renderToStaticMarkup(
      <RosterRows
        payload={ROSTER}
        busy={false}
        personas={SP_PAYLOAD.personas}
        personaByEmail={new Map([[EMAIL, null]])}
        personaDisabled={false}
        showPersona={true}
        manageHumanRoles={false}
        onPersonaChange={() => {}}
        onChange={() => {
          throw new Error('human role mutation must not be exposed');
        }}
        onRemove={() => {
          throw new Error('human removal must not be exposed');
        }}
      />
    );
    expect(markup).toContain(`aria-label="Persona for ${EMAIL}: No persona"`);
    expect(markup).toContain('<span class="app-select-value"><span>No persona</span></span>');
    expect(markup).not.toContain('Persona ·');
    expect(markup).not.toContain(`aria-label="Role for ${EMAIL}`);
    expect(markup).not.toContain(`aria-label="Remove ${EMAIL}"`);
    expect(markup).not.toContain('roster-add-row');
  });
});
