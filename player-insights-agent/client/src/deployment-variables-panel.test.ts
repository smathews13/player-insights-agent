import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deploymentVariableSourceLabel,
  sortedDeploymentVariables,
  type DeploymentVariable,
} from './deployment-variables-view';

const row = (scope: DeploymentVariable['scope'], name: string): DeploymentVariable => ({
  scope,
  name,
  value: 'v',
  source: 'release',
  revision: 1,
  updatedBy: 'app boot',
  updatedAt: '2026-10-22T00:00:00.000Z',
});

describe('saved deployment values panel', () => {
  it('names each source in plain words', () => {
    expect(deploymentVariableSourceLabel('release')).toBe('Bundle release');
    expect(deploymentVariableSourceLabel('migrated')).toBe('Copied from earlier storage');
  });

  it('lists values alphabetically', () => {
    const sorted = sortedDeploymentVariables([
      row('release', 'PLAYER_INSIGHTS_SCHEMA'),
      row('release', 'PLAYER_INSIGHTS_CATALOG'),
    ]);
    expect(sorted.map((entry) => entry.name)).toEqual(['PLAYER_INSIGHTS_CATALOG', 'PLAYER_INSIGHTS_SCHEMA']);
  });

  it('is shown to admins on the Environment tab and offers no editing', () => {
    const page = readFileSync(new URL('SettingsPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('<DeploymentVariablesPanel />');
    const panel = readFileSync(new URL('DeploymentVariablesPanel.tsx', import.meta.url), 'utf8');
    expect(panel).not.toMatch(/method: 'PUT'|<Input|<Button/);
  });
});
