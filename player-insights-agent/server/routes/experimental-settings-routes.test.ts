import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isAdminRoute } from '../lib/admin-roles';

describe('Experimental settings route scope', () => {
  it('lets signed-in readers consume visibility while admin-gating writes', () => {
    expect(isAdminRoute('/api/experimental-settings')).toBe(false);
    expect(isAdminRoute('/api/admin/experimental-settings')).toBe(true);
  });

  it('keeps AI Gateway writes inside the audited admin settings path', () => {
    const source = readFileSync(new URL('./experimental-settings-routes.ts', import.meta.url), 'utf8');
    expect(source).toContain("app.put('/api/admin/experimental-settings'");
    expect(source).toContain("action: 'experimental-settings-updated'");
    expect(source).toContain('writeExperimentalSettings');
  });
});
