import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAdminRoute } from '../lib/admin-roles';

describe('benchmark settings route permissions', () => {
  it('allows signed-in readers to load but admin-gates writes', () => {
    expect(isAdminRoute('/api/benchmark-settings')).toBe(false);
    expect(isAdminRoute('/api/admin/benchmark-settings')).toBe(true);
    const source = fs.readFileSync(path.join(__dirname, 'benchmark-settings-routes.ts'), 'utf8');
    expect(source).toContain("app.get('/api/benchmark-settings'");
    expect(source).toContain("app.put('/api/admin/benchmark-settings'");
  });
});
