import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { LAKEBASE_BINDING_PLAN_DDL } from '../lib/lakebase-binding-plan';
import { LATER_MIGRATIONS } from '../lib/migrations';
import { mayRoleManageLakebaseBinding } from './lakebase-binding-routes';

const SOURCE = readFileSync(fileURLToPath(new URL('./lakebase-binding-routes.ts', import.meta.url)), 'utf8');

describe('Lakebase binding route boundary', () => {
  it('authorizes Admin, host Owner, and Super Admin while refusing Consumer', () => {
    expect(mayRoleManageLakebaseBinding('admin')).toBe(true);
    expect(mayRoleManageLakebaseBinding('super_admin')).toBe(true);
    expect(mayRoleManageLakebaseBinding('owner')).toBe(true);
    expect(mayRoleManageLakebaseBinding('consumer')).toBe(false);
    expect(SOURCE).toContain("app.get('/api/lakebase-binding', manager");
    expect(SOURCE).toContain("app.post('/api/lakebase-binding/stage', manager");
  });

  it('never calls a control-plane write or swaps the AppKit pool', () => {
    expect(SOURCE).not.toMatch(/apiClient\.request|apps update|createApp|new Pool|pool\.end|pool\s*=/);
    expect(SOURCE).toContain('validateLakebaseDatabase');
    expect(SOURCE).toContain('expectedActiveDatabase');
    expect(SOURCE).toContain('expectedRevision');
  });

  it('migrates a separate revision-fenced desired-binding table with no credentials', () => {
    const migration = LATER_MIGRATIONS.find((entry) => entry.version === 39);
    expect(migration?.statements).toEqual([LAKEBASE_BINDING_PLAN_DDL]);
    expect(LAKEBASE_BINDING_PLAN_DDL).toContain('revision BIGINT NOT NULL DEFAULT 1');
    expect(LAKEBASE_BINDING_PLAN_DDL).toContain('active_database TEXT NOT NULL');
    expect(LAKEBASE_BINDING_PLAN_DDL).not.toMatch(/token|secret|password|credential/i);
  });
});
