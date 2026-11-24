import { describe, expect, it } from 'vitest';

import { memoryDeploymentStore } from './__fixtures__/memory-deployment-store';
import {
  deploymentVariablesDdl,
  listDeploymentVariables,
  readVariableScope,
  recordVariableScope,
  writeVariableScope,
} from './deployment-variables';
import type { DecisionStore } from './deployment-decisions';

describe('deployment variables', () => {
  it('copies the legacy release blob across on first read and marks it migrated', async () => {
    const { store, scopeValues, history } = memoryDeploymentStore({
      decisions: { release_environment_v1: JSON.stringify({ PLAYER_INSIGHTS_CATALOG: 'customer_catalog', BAD: 7 }) },
    });

    expect(JSON.parse((await readVariableScope(store, 'release')) ?? '{}')).toEqual({
      PLAYER_INSIGHTS_CATALOG: 'customer_catalog',
    });
    expect(scopeValues('release')).toEqual({ PLAYER_INSIGHTS_CATALOG: 'customer_catalog' });
    expect(history.map((entry) => entry.source)).toEqual(['migrated']);
  });

  it('prefers the table over the legacy blob once it has values', async () => {
    const { store } = memoryDeploymentStore({
      decisions: { release_environment_v1: JSON.stringify({ PLAYER_INSIGHTS_CATALOG: 'old' }) },
    });
    await writeVariableScope(store, 'release', { PLAYER_INSIGHTS_CATALOG: 'new' }, 'release', 'app boot');
    expect(JSON.parse((await readVariableScope(store, 'release')) ?? '{}')).toEqual({ PLAYER_INSIGHTS_CATALOG: 'new' });
  });

  it('relabels a copied value when a release first states it, without a new revision or history', async () => {
    const { store, history } = memoryDeploymentStore({
      decisions: { release_environment_v1: JSON.stringify({ PLAYER_INSIGHTS_CATALOG: 'c' }) },
    });
    await readVariableScope(store, 'release');
    await writeVariableScope(store, 'release', { PLAYER_INSIGHTS_CATALOG: 'c' }, 'release', 'app boot');
    expect(await listDeploymentVariables(store)).toMatchObject([{ source: 'release', revision: 1 }]);
    expect(history).toHaveLength(1);
  });

  it('records history only for values that changed or were removed', async () => {
    const { store, history } = memoryDeploymentStore();
    await writeVariableScope(store, 'release', { A: '1', B: '2' }, 'release', 'app boot');
    await writeVariableScope(store, 'release', { A: '1', B: '2' }, 'release', 'app boot');
    await writeVariableScope(store, 'release', { A: '3' }, 'release', 'app boot');
    expect(history.map(({ name, value, revision }) => [name, value, revision])).toEqual([
      ['A', '1', 1],
      ['B', '2', 1],
      ['B', null, 2],
      ['A', '3', 2],
    ]);
  });

  it('still writes the legacy blob so a rollback finds the same values', async () => {
    const { store, decisions } = memoryDeploymentStore();
    await recordVariableScope(store, 'release', { PLAYER_INSIGHTS_CATALOG: 'c' }, 'release', 'app boot');
    expect(JSON.parse(decisions.get('release_environment_v1') ?? '{}')).toEqual({ PLAYER_INSIGHTS_CATALOG: 'c' });
  });

  it('reports failure when the table write fails, because reads prefer the table', async () => {
    const failing: DecisionStore = {
      query: (text: string) =>
        text.trimStart().startsWith('WITH') ? Promise.reject(new Error('down')) : Promise.resolve({ rows: [] }),
    };
    expect(await recordVariableScope(failing, 'release', { A: '1' }, 'release', 'app boot')).toBe(false);
  });

  it('lists every saved value with its source for the admin view', async () => {
    const { store } = memoryDeploymentStore();
    await writeVariableScope(store, 'release', { PLAYER_INSIGHTS_CATALOG: 'c' }, 'release', 'boot');
    expect(await listDeploymentVariables(store)).toMatchObject([
      { scope: 'release', name: 'PLAYER_INSIGHTS_CATALOG', value: 'c', source: 'release', revision: 1 },
    ]);
  });

  it('keys variables by scope and lets history record a removal', () => {
    const [table, history] = deploymentVariablesDdl();
    expect(table).toContain('PRIMARY KEY (scope, name)');
    expect(history).toContain('value TEXT,');
  });
});

describe('saved deployment values route', () => {
  it('is admin-gated and read-only', async () => {
    const { isAdminRoute } = await import('./admin-roles');
    const { readFileSync } = await import('node:fs');
    expect(isAdminRoute('/api/admin/deployment-variables')).toBe(true);
    const routes = readFileSync(new URL('../routes/runtime-settings-routes.ts', import.meta.url), 'utf8');
    expect(routes).toContain("app.get('/api/admin/deployment-variables'");
    expect(routes).not.toMatch(/app\.(put|post|delete)\('\/api\/admin\/deployment-variables'/);
  });
});
