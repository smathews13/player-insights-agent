import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isAdminRoute } from '../lib/admin-roles';

describe('cost budget route permissions', () => {
  it('admin-gates both the read and the write', () => {
    expect(isAdminRoute('/api/admin/cost-budgets')).toBe(true);
    const source = fs.readFileSync(path.join(__dirname, 'cost-budgets-routes.ts'), 'utf8');
    expect(source).toContain("app.get('/api/admin/cost-budgets'");
    expect(source).toContain("app.put('/api/admin/cost-budgets'");
  });
});
