import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createSpPersonaDefinition,
  deleteSpPersonaDefinition,
  EMPTY_SP_IDENTITY,
  loadSpIdentityAdmin,
  updateSpPersonaDefinition,
} from './identity-settings-api';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('always-on SP persona administration', () => {
  it('loads mappings from the admin API without a feature flag', async () => {
    const fetch = vi.fn().mockResolvedValue(json(EMPTY_SP_IDENTITY));
    vi.stubGlobal('fetch', fetch);
    const payload = await loadSpIdentityAdmin();
    expect(fetch).toHaveBeenCalledWith('/api/admin/sp-identity');
    expect(payload).not.toHaveProperty('enabled');
  });

  it('Settings has no SP experiment, mode API, or browser preference', () => {
    const source = readFileSync(new URL('SettingsPage.tsx', import.meta.url), 'utf8');
    const api = readFileSync(new URL('identity-settings-api.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/SP identities|spIdentityEnabled|persistSpIdentityMode/);
    expect(api).not.toMatch(/sp-identity\/mode|persistSpIdentityMode/);
  });
});

describe('credential-free persona configuration API', () => {
  const write = {
    displayName: 'Finance reader',
    description: 'Governed finance reporting',
    capabilities: ['SQL warehouse abc123 — CAN USE'],
    grants: [
      {
        resourceType: 'SQL_WAREHOUSE' as const,
        resource: 'abc123',
        action: 'USE' as const,
        privilege: 'CAN USE',
      },
    ],
    legacyCapabilities: [],
  };
  const saved = {
    id: 'definition-1',
    ...write,
    updatedAt: '2026-08-28T00:00:00.000Z',
    updatedBy: 'owner@example.invalid',
  };

  it('generates and edits a Lakebase-backed configuration without credential fields', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(saved)).mockResolvedValueOnce(json(saved));
    vi.stubGlobal('fetch', fetch);

    await createSpPersonaDefinition(write);
    await updateSpPersonaDefinition(saved.id, write);

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/admin/sp-identity/persona-definitions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(write),
    });
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/admin/sp-identity/persona-definitions/definition-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(write),
    });
    expect(JSON.stringify(fetch.mock.calls)).not.toMatch(/clientId|clientSecret|secretScope|secretKey/);
  });

  it('removes only the saved configuration', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    await deleteSpPersonaDefinition('definition-1');
    expect(fetch).toHaveBeenCalledWith('/api/admin/sp-identity/persona-definitions/definition-1', {
      method: 'DELETE',
    });
  });

  it('exposes no client request for model-generated permission suggestions', () => {
    const source = readFileSync(new URL('identity-settings-api.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/permission-suggestions|suggestSpPersonaPermissions|AbortSignal/);
  });
});
