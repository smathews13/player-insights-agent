import { describe, expect, it } from 'vitest';

import { APP_SCHEMA } from '../../shared/app-schema';
import {
  activeLakebaseBinding,
  LakebaseBindingNoOp,
  LakebaseBindingPlanConflict,
  lakebaseBindingFromDatabase,
  lakebaseRedeployCommand,
  lakebaseRedeployPlan,
  writeDesiredLakebaseBinding,
} from './lakebase-binding-plan';

const ACTIVE = {
  project: 'projects/current',
  branch: 'projects/current/branches/production',
  database: 'projects/current/branches/production/databases/app',
  endpoint: 'projects/current/branches/production/endpoints/primary',
  schema: APP_SCHEMA,
};

describe('Lakebase binding truth boundary', () => {
  it('derives the active binding from the environment AppKit actually consumed', () => {
    expect(
      activeLakebaseBinding({
        LAKEBASE_ENDPOINT: 'projects/current/branches/production/endpoints/primary',
        PGDATABASE: 'app',
      })
    ).toMatchObject(ACTIVE);
  });

  it('accepts only a complete project, branch, and database resource name', () => {
    expect(lakebaseBindingFromDatabase('projects/next/branches/blue/databases/app')).toEqual({
      project: 'projects/next',
      branch: 'projects/next/branches/blue',
      database: 'projects/next/branches/blue/databases/app',
    });
    expect(lakebaseBindingFromDatabase('projects/next/branches/blue')).toBeNull();
  });

  it('generates the resource update, grants, and restart without a hot-swap claim', () => {
    const desired = {
      project: 'projects/next',
      branch: 'projects/next/branches/blue',
      database: 'projects/next/branches/blue/databases/app',
      revision: 2,
      updatedAt: '2026-09-03T12:00:00Z',
      updatedBy: 'admin@example.com',
    };
    const command = lakebaseRedeployCommand(desired, 'customer');
    expect(command).toContain("export BUNDLE_VAR_lakebase_project_id='next'");
    expect(command).toContain("export BUNDLE_VAR_lakebase_branch_id='blue'");
    expect(command).toContain("export BUNDLE_VAR_lakebase_database_id='app'");
    expect(command).toContain("databricks bundle deploy -t 'customer'");
    expect(command).toContain("TARGET='customer' bundle/app-db-grant.sh");
    expect(command).toContain("TARGET='customer' bundle/app-release.sh --apply");

    const plan = lakebaseRedeployPlan({ active: ACTIVE, desired, target: 'customer' });
    expect(plan.status).toBe('redeploy_required');
    expect(plan.active.database).toBe(ACTIVE.database);
    expect(plan.desired?.database).toBe(desired.database);
    expect(plan.detail).toMatch(/still using the active pool/i);
  });

  it('marks a copied plan fulfilled only after this process reports it active', () => {
    const desired = {
      ...ACTIVE,
      revision: 1,
      updatedAt: '2026-09-03T12:00:00Z',
      updatedBy: 'admin@example.com',
    };
    const plan = lakebaseRedeployPlan({ active: ACTIVE, desired });
    expect(plan.status).toBe('active');
    expect(plan.desired).toBeNull();
    expect(plan.command).toBe('');
  });
});

describe('Lakebase binding stale fencing', () => {
  it('refuses a stale active deployment and a no-op before writing', async () => {
    const lakebase = { query: () => Promise.resolve({ rows: [] as Record<string, unknown>[] }) };
    await expect(
      writeDesiredLakebaseBinding(
        { lakebase },
        {
          database: 'projects/next/branches/blue/databases/app',
          expectedRevision: 0,
          expectedActiveDatabase: 'projects/old/branches/main/databases/app',
          updatedBy: 'admin@example.com',
          active: ACTIVE,
        }
      )
    ).rejects.toBeInstanceOf(LakebaseBindingPlanConflict);
    await expect(
      writeDesiredLakebaseBinding(
        { lakebase },
        {
          database: ACTIVE.database,
          expectedRevision: 0,
          expectedActiveDatabase: ACTIVE.database,
          updatedBy: 'admin@example.com',
          active: ACTIVE,
        }
      )
    ).rejects.toBeInstanceOf(LakebaseBindingNoOp);
  });

  it('uses the expected plan revision in the atomic update', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const lakebase = {
      query: (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return Promise.resolve({
          rows: [
            {
              project: 'projects/next',
              branch: 'projects/next/branches/blue',
              database: 'projects/next/branches/blue/databases/app',
              revision: 8,
              updated_at: '2026-09-03T12:00:00Z',
              updated_by: 'admin@example.com',
            },
          ],
        });
      },
    };
    const written = await writeDesiredLakebaseBinding(
      { lakebase },
      {
        database: 'projects/next/branches/blue/databases/app',
        expectedRevision: 7,
        expectedActiveDatabase: ACTIVE.database,
        updatedBy: 'admin@example.com',
        active: ACTIVE,
      }
    );
    expect(written.revision).toBe(8);
    expect(calls[0].sql).toContain('WHERE id = $1 AND revision = $7');
    expect(calls[0].params[calls[0].params.length - 1]).toBe(7);
  });
});
