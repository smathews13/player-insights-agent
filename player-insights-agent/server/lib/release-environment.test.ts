import { describe, expect, it, vi } from 'vitest';

import { configurationForSettings } from './release-configuration';
import {
  RELEASE_ENVIRONMENT_DECISION,
  recordReleaseEnvironment,
  releaseEnvironmentSnapshot,
  restoreReleaseEnvironment,
  type ReleaseEnvironmentKey,
} from './release-environment';
import type { DecisionStore } from './deployment-decisions';

function readingStore(value: string | null): DecisionStore {
  return {
    query: vi.fn().mockResolvedValue({
      rows: value === null ? [] : [{ value }],
    }),
  };
}

describe('release runtime configuration persistence', () => {
  it('records only the allowlisted target values and never build, target, or administrator identity', async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    const store: DecisionStore = {
      query: vi.fn((text: string, params: unknown[] = []) => {
        calls.push({ text, params });
        return Promise.resolve({ rows: [] });
      }),
    };
    const env = {
      PLAYER_INSIGHTS_TARGET: 'demo',
      LAKEBASE_ENDPOINT: 'projects/example/branches/production',
      PLAYER_INSIGHTS_CATALOG: 'example_catalog',
      PLAYER_INSIGHTS_SCHEMA: 'player_data',
      PLAYER_INSIGHTS_DATA_GENIE_ID: 'data-space',
      PLAYER_INSIGHTS_BUILD_SHA: 'new-build',
      PLAYER_INSIGHTS_ADMIN_EMAILS: 'admin@example.test',
    };

    expect(await recordReleaseEnvironment(store, env)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params[0]).toBe(RELEASE_ENVIRONMENT_DECISION);
    const recorded = JSON.parse(String(calls[0]?.params[1])) as Record<string, string>;
    expect(recorded).toMatchObject({
      PLAYER_INSIGHTS_CATALOG: 'example_catalog',
      PLAYER_INSIGHTS_SCHEMA: 'player_data',
      PLAYER_INSIGHTS_DATA_GENIE_ID: 'data-space',
    });
    expect(recorded).not.toHaveProperty('PLAYER_INSIGHTS_TARGET');
    expect(recorded).not.toHaveProperty('PLAYER_INSIGHTS_BUILD_SHA');
    expect(recorded).not.toHaveProperty('PLAYER_INSIGHTS_ADMIN_EMAILS');
  });

  it('hydrates a target-neutral Git manifest before Connections derives its configured tables', async () => {
    const persisted: Partial<Record<ReleaseEnvironmentKey, string>> = {
      PLAYER_INSIGHTS_CATALOG: 'example_catalog',
      PLAYER_INSIGHTS_SCHEMA: 'player_data',
      PLAYER_INSIGHTS_DATA_GENIE_ID: 'data-space',
      PLAYER_INSIGHTS_DICTIONARY_GENIE_ID: 'dictionary-space',
      PLAYER_INSIGHTS_USER_API_SCOPES: 'sql,dashboards.genie,catalog.tables:read',
    };
    const env: Record<string, string | undefined> = {
      PLAYER_INSIGHTS_TARGET: '',
      LAKEBASE_ENDPOINT: 'projects/example/branches/production',
      PLAYER_INSIGHTS_CATALOG: '',
      PLAYER_INSIGHTS_SCHEMA: '',
      PLAYER_INSIGHTS_DATA_GENIE_ID: '',
      PLAYER_INSIGHTS_DICTIONARY_GENIE_ID: '',
      PLAYER_INSIGHTS_USER_API_SCOPES: 'sql',
      PLAYER_INSIGHTS_BUILD_SHA: 'new-git-build',
      PLAYER_INSIGHTS_ADMIN_EMAILS: '',
    };

    expect(await restoreReleaseEnvironment(readingStore(JSON.stringify(persisted)), env)).toBe(5);
    const configuration = configurationForSettings(env, []);
    const manifest = configuration.find((entry) => entry.key === 'declared_manifest');

    expect(configuration.find((entry) => entry.key === 'catalog')?.value).toBe('example_catalog');
    expect(configuration.find((entry) => entry.key === 'schema')?.value).toBe('player_data');
    expect(configuration.find((entry) => entry.key === 'data_genie_space_id')?.value).toBe('data-space');
    expect(Array.isArray(manifest?.value) ? manifest.value.length : 0).toBeGreaterThan(0);
    expect(env.PLAYER_INSIGHTS_BUILD_SHA).toBe('new-git-build');
    expect(env.PLAYER_INSIGHTS_TARGET).toBe('');
    expect(env.PLAYER_INSIGHTS_ADMIN_EMAILS).toBe('');
  });

  it('never records a Git placeholder or mutates a Git boot without a valid snapshot', async () => {
    const env: Record<string, string | undefined> = {
      PLAYER_INSIGHTS_TARGET: '',
      LAKEBASE_ENDPOINT: 'projects/example/branches/production',
      PLAYER_INSIGHTS_CATALOG: '',
    };
    const store = readingStore('{not-json');

    expect(await recordReleaseEnvironment(store, env)).toBe(false);
    expect(releaseEnvironmentSnapshot(env)).toEqual({});
    expect(await restoreReleaseEnvironment(store, env)).toBe(0);
    expect(env.PLAYER_INSIGHTS_CATALOG).toBe('');
  });
});
