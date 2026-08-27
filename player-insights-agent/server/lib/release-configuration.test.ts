import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { qualifyDataContractTables } from '../../shared/data-contract';
import { configurationForSettings, configurationFromRelease } from './release-configuration';

describe('release configuration, without asking the agent', () => {
  it('reads catalog, warehouse and Genie ids from the app environment', () => {
    const configuration = configurationFromRelease({
      PLAYER_INSIGHTS_CATALOG: 'cat',
      PLAYER_INSIGHTS_SCHEMA: 'sch',
      DATABRICKS_SQL_WAREHOUSE_ID: 'wh-1',
      PLAYER_INSIGHTS_DATA_GENIE_ID: 'space-data',
    });
    const byKey = Object.fromEntries(configuration.map((entry) => [entry.key, entry]));
    expect(byKey.catalog).toMatchObject({ value: 'cat', source: 'app-environment' });
    expect(byKey.schema.value).toBe('sch');
    expect(byKey.warehouse_id.value).toBe('wh-1');
    expect(byKey.data_genie_space_id.value).toBe('space-data');
    expect(byKey.declared_manifest.value).toEqual(qualifyDataContractTables('cat', 'sch'));
    expect(byKey.declared_manifest.source).toBe('data-contract');
  });

  it('resolves a semantic-index flag of true using catalog and schema', () => {
    const configuration = configurationFromRelease({
      PLAYER_INSIGHTS_CATALOG: 'cat',
      PLAYER_INSIGHTS_SCHEMA: 'sch',
      PLAYER_INSIGHTS_SEMANTIC_INDEX: 'true',
    });
    expect(configuration.find((entry) => entry.key === 'semantic_index')?.value).toBe(
      'cat.sch.semantic_layer_index'
    );
  });

  it('copies the foundation model from the app environment when the release wrote one', () => {
    const configuration = configurationFromRelease({
      PLAYER_INSIGHTS_LLM_ENDPOINT: 'databricks-claude-sonnet-4-6',
    });
    expect(configuration.find((entry) => entry.key === 'llm_endpoint')?.value).toBe(
      'databricks-claude-sonnet-4-6'
    );
  });

  it('prefers an explicit declared manifest over qualifying the data contract', () => {
    const configuration = configurationFromRelease({
      PLAYER_INSIGHTS_CATALOG: 'cat',
      PLAYER_INSIGHTS_SCHEMA: 'sch',
      PLAYER_INSIGHTS_DECLARED_MANIFEST: 'other.place.t1,other.place.t2',
    });
    const manifest = configuration.find((entry) => entry.key === 'declared_manifest');
    expect(manifest?.value).toEqual(['other.place.t1', 'other.place.t2']);
  });

  it('does not invent a table list when catalog or schema is missing', () => {
    expect(configurationFromRelease({ PLAYER_INSIGHTS_CATALOG: 'cat' }).map((entry) => entry.key)).not.toContain(
      'declared_manifest'
    );
  });
});

describe('filling gaps from the served model version', () => {
  const baked = (
    key: string,
    value: unknown
  ): ReturnType<typeof configurationFromRelease>[number] => ({
    key,
    env_var: '',
    value,
    source: 'artifact',
    mutability: 'model-version',
    baked: true,
    required: false,
  });

  it('fills the foundation model and a longer declared list the container did not have', () => {
    const twelve = Array.from({ length: 12 }, (_, index) => `cat.sch.t${index + 1}`);
    const merged = configurationForSettings(
      { PLAYER_INSIGHTS_CATALOG: 'cat', PLAYER_INSIGHTS_SCHEMA: 'sch' },
      [
        baked('llm_endpoint', 'databricks-claude-sonnet-4-6'),
        baked('declared_manifest', twelve),
        baked('semantic_index', 'cat.sch.semantic_layer_index'),
      ]
    );
    const byKey = Object.fromEntries(merged.map((entry) => [entry.key, entry]));
    expect(byKey.llm_endpoint.value).toBe('databricks-claude-sonnet-4-6');
    expect(byKey.declared_manifest.value).toEqual(twelve);
    expect(byKey.semantic_index.value).toBe('cat.sch.semantic_layer_index');
    expect(byKey.catalog.value).toBe('cat');
  });

  it('does not overwrite an explicit declared manifest or an already-set foundation model', () => {
    const merged = configurationForSettings(
      {
        PLAYER_INSIGHTS_CATALOG: 'cat',
        PLAYER_INSIGHTS_SCHEMA: 'sch',
        PLAYER_INSIGHTS_DECLARED_MANIFEST: 'other.place.t1,other.place.t2',
        PLAYER_INSIGHTS_LLM_ENDPOINT: 'a-custom-model',
      },
      [baked('llm_endpoint', 'databricks-claude-sonnet-4-6'), baked('declared_manifest', ['cat.sch.one'])]
    );
    const byKey = Object.fromEntries(merged.map((entry) => [entry.key, entry]));
    expect(byKey.llm_endpoint.value).toBe('a-custom-model');
    expect(byKey.declared_manifest.value).toEqual(['other.place.t1', 'other.place.t2']);
  });

  it('does not invent a foundation model when neither the container nor the artifact named one', () => {
    const merged = configurationForSettings({ PLAYER_INSIGHTS_CATALOG: 'cat', PLAYER_INSIGHTS_SCHEMA: 'sch' }, []);
    expect(merged.find((entry) => entry.key === 'llm_endpoint')).toBeUndefined();
  });
});

describe('no fake serving question remains in the app', () => {
  it('does not POST the word preflight as an Ask', () => {
    const root = path.resolve(__dirname, '../..');
    const files = [
      'server/routes/insights-routes.ts',
      'server/routes/settings-routes.ts',
      'server/routes/ops-routes.ts',
      'server/routes/access-verification.ts',
      'client/src/session-checks.ts',
      'client/src/EvalFlywheel.tsx',
      'client/src/use-evaluation-lab.ts',
    ];
    for (const relative of files) {
      const source = readFileSync(path.join(root, relative), 'utf8');
      expect(source, `${relative} still builds a serving body whose question is preflight`).not.toMatch(
        /content:\s*['"]preflight['"]/
      );
      expect(source, `${relative} still calls invokePreflight`).not.toContain('invokePreflight');
      expect(source, `${relative} still builds a preflight serving body`).not.toContain('buildPreflightServingBody');
    }
  });
});
