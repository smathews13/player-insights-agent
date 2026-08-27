import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { isAdminRoute } from '../lib/admin-roles';
import { SpPersonaWriteSchema } from '../../shared/sp-identity';

const source = readFileSync(new URL('sp-identity-routes.ts', import.meta.url), 'utf8');

describe('service-principal identity admin routes', () => {
  it('are behind the existing admin prefix', () => {
    expect(isAdminRoute('/api/admin/sp-identity')).toBe(true);
    expect(isAdminRoute('/api/admin/sp-identity/personas')).toBe(true);
    expect(isAdminRoute('/api/admin/sp-identity/assignments')).toBe(true);
    expect(isAdminRoute('/api/admin/sp-identity/mode')).toBe(true);
  });

  it('never serialises a secret value', () => {
    expect(source).toContain("app.get('/api/admin/sp-identity'");
    expect(source).toContain("app.put('/api/admin/sp-identity/mode'");
    expect(source).toContain("app.post('/api/admin/sp-identity/personas'");
    expect(source).toContain("app.put('/api/admin/sp-identity/assignments'");
    expect(source).not.toMatch(/client_secret|secret_value|oauthSecret/);
    expect(Object.keys(SpPersonaWriteSchema.shape).sort()).toEqual([
      'clientId',
      'displayName',
      'secretKey',
      'secretScope',
    ]);
  });
});
