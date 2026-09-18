import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAdminRoute } from '../lib/admin-roles';
import { isAppearancePatch } from './runtime-settings-routes';

describe('runtime settings route permissions', () => {
  it('allows caller-scoped Appearance reads, writes, and resets while preserving admin routes', () => {
    expect(isAdminRoute('/api/runtime-settings')).toBe(false);
    expect(isAdminRoute('/api/admin/runtime-settings')).toBe(true);
    const source = fs.readFileSync(path.join(__dirname, 'runtime-settings-routes.ts'), 'utf8');
    expect(source).toContain("app.get('/api/runtime-settings'");
    expect(source).toContain("app.put('/api/runtime-settings'");
    expect(source).toContain("app.delete('/api/runtime-settings'");
    expect(source).toContain("app.get('/api/admin/runtime-settings'");
    expect(source).toContain("app.put('/api/admin/runtime-settings'");
    expect(source).toContain('appearance_settings_only');
    expect(source).toContain('default_owner_cannot_reset');
  });

  it('rejects runtime fields from the caller-scoped write contract', () => {
    expect(isAppearancePatch({ colorScheme: 'light', density: 'compact' })).toBe(true);
    expect(isAppearancePatch({ entityStyles: { table: { foreground: '#112233' } } })).toBe(true);
    expect(isAppearancePatch({ loop: { maxSteps: 20 } })).toBe(false);
    expect(isAppearancePatch({ answer: { takeaway: false } })).toBe(false);
    expect(isAppearancePatch({ behavior: { timezone: 'UTC' } })).toBe(false);
  });
});
