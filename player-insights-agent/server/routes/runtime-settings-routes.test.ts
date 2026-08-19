import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAdminRoute } from '../lib/admin-roles';

describe('runtime settings route permissions', () => {
  it('allows signed-in consumers to read but admin-gates writes', () => {
    expect(isAdminRoute('/api/runtime-settings')).toBe(false);
    expect(isAdminRoute('/api/admin/runtime-settings')).toBe(true);
    const source = fs.readFileSync(path.join(__dirname, 'runtime-settings-routes.ts'), 'utf8');
    expect(source).toContain("app.get('/api/runtime-settings'");
    expect(source).toContain("app.put('/api/admin/runtime-settings'");
  });
});
