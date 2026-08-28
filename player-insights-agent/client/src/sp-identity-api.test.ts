import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createSpPersonaDefinition,
  deleteSpPersonaDefinition,
  EMPTY_SP_IDENTITY,
  loadSpIdentityAdmin,
  persistSpIdentityMode,
  updateSpPersonaDefinition,
} from './identity-settings-api';
import { spIdentityEnabledFromPayload } from './sp-identity-mode';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading and writing the deployment-wide SP-identity pivot', () => {
  it('loads enabled from GET /api/admin/sp-identity, fail-closed', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ ...EMPTY_SP_IDENTITY, enabled: true }));
    vi.stubGlobal('fetch', fetch);
    const payload = await loadSpIdentityAdmin();
    expect(fetch).toHaveBeenCalledWith('/api/admin/sp-identity');
    expect(spIdentityEnabledFromPayload(payload)).toBe(true);
  });

  it('does not treat a successful read of enabled:false as on', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...EMPTY_SP_IDENTITY, enabled: false })));
    expect(spIdentityEnabledFromPayload(await loadSpIdentityAdmin())).toBe(false);
  });

  it('writes the same flag through PUT /api/admin/sp-identity/mode', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ ...EMPTY_SP_IDENTITY, enabled: true }));
    vi.stubGlobal('fetch', fetch);
    const payload = await persistSpIdentityMode(true);
    expect(fetch).toHaveBeenCalledWith('/api/admin/sp-identity/mode', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(spIdentityEnabledFromPayload(payload)).toBe(true);
    expect(JSON.stringify(payload)).not.toMatch(/secret value|client_secret|s3cret/i);
  });

  it('Settings reads and writes that payload, not a browser preference', () => {
    const source = readFileSync(new URL('SettingsPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('loadSpIdentityAdmin');
    expect(source).toContain('persistSpIdentityMode');
    expect(source).toContain('spIdentityEnabledFromPayload');
    expect(source).toContain('checked={spIdentityEnabled}');
    expect(source).toContain('spIdentityEnabled={spIdentityEnabled}');
    expect(source).not.toContain('showsSpIdentities');
    expect(source).not.toContain("setFeature('spIdentities'");
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
});
