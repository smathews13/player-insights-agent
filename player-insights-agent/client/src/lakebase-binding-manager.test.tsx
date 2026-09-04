import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { LakebaseRedeployPlan } from '../../shared/lakebase-binding';
import { canMutateConnections } from '../../shared/user-roster-contract';
import { LakebaseBindingPanel } from './LakebaseBindingManager';
import { canStageLakebaseBinding, lakebaseBindingDraft } from './lakebase-binding-manager-state';

const SOURCE = readFileSync(fileURLToPath(new URL('./LakebaseBindingManager.tsx', import.meta.url)), 'utf8');
const PLAN: LakebaseRedeployPlan = {
  status: 'redeploy_required',
  active: {
    project: 'projects/current',
    branch: 'projects/current/branches/production',
    database: 'projects/current/branches/production/databases/app',
    endpoint: 'projects/current/branches/production/endpoints/primary',
    schema: 'astrolabe',
  },
  desired: {
    project: 'projects/next',
    branch: 'projects/next/branches/blue',
    database: 'projects/next/branches/blue/databases/app',
    revision: 4,
    updatedAt: '2026-09-03T12:00:00Z',
    updatedBy: 'owner@example.com',
  },
  command:
    "export BUNDLE_VAR_lakebase_project_id='next'\ndatabricks bundle deploy -t 'prod'\nTARGET='prod' bundle/app-release.sh --apply",
  target: 'prod',
  targetKnown: true,
  appSettingsUrl: 'https://workspace.example/apps/astrolabe',
  detail: 'The desired binding is staged only. AppKit is still using the active pool.',
};

function render(editing = false, draft = lakebaseBindingDraft(PLAN)) {
  return renderToStaticMarkup(
    <LakebaseBindingPanel
      plan={PLAN}
      editing={editing}
      draft={draft}
      saving={false}
      message=""
      onEdit={() => {}}
      onDraft={() => {}}
      onSave={() => {}}
      onCancel={() => {}}
    />
  );
}

describe('Lakebase Admin+ binding affordance', () => {
  it('keeps consumers read-only while Admin, Owner, and Super Admin can manage', () => {
    expect(canMutateConnections('consumer')).toBe(false);
    expect(canMutateConnections('admin')).toBe(true);
    expect(canMutateConnections('owner')).toBe(true);
    expect(canMutateConnections('super_admin')).toBe(true);
  });

  it('shows active and desired bindings as different states without a false Connected or saved claim', () => {
    const markup = render();
    expect(markup).toContain('Active Lakebase binding');
    expect(markup).toContain('projects/current/branches/production/databases/app');
    expect(markup).toContain('Desired after redeploy');
    expect(markup).toContain('projects/next/branches/blue/databases/app');
    expect(markup).toContain('Redeploy required');
    expect(markup).toContain('AppKit opened this pool from deployment-injected Postgres settings');
    expect(markup).toContain('Open Databricks App resource settings');
    expect(markup).not.toMatch(/\bSaved\b/);
    expect(markup).not.toMatch(/>Connected</);
  });

  it('renders searchable hierarchical picker state with explicit Save and Cancel', () => {
    const markup = render(true, 'projects/new/branches/main/databases/app');
    expect(markup).toContain('data-testid="asset-picker-lakebase"');
    expect(markup).toContain('Finding resources your sign-in can access');
    expect(markup).toContain('Save redeploy plan');
    expect(markup).toContain('Cancel');
    expect(canStageLakebaseBinding(PLAN, 'projects/new/branches/main/databases/app')).toBe(true);
    expect(canStageLakebaseBinding(PLAN, PLAN.desired!.database)).toBe(false);
  });

  it('stages only from the explicit Save handler and Cancel restores the server reading', () => {
    expect(SOURCE).toMatch(/onPick=\{onDraft\}/);
    expect(SOURCE).toMatch(/onClick=\{onSave\}/);
    expect(SOURCE).toMatch(/onClick=\{onCancel\}/);
    expect(SOURCE).toMatch(/fetch\('\/api\/lakebase-binding\/stage'/);
    expect(lakebaseBindingDraft(PLAN)).toBe(PLAN.desired!.database);
    expect(SOURCE).toContain('The running Lakebase connection has not changed.');
  });
});
