import { afterEach, describe, expect, it } from 'vitest';

import {
  configurationFromBaked,
  forgetBakedModelConfig,
  parseModelConfigDocument,
  readBakedModelConfig,
  type BakedConfigTransport,
} from './baked-model-config';

const MLMODEL = `
artifact_path: agent
flavors:
  python_function:
    python_version: 3.11.13
    loader_module: mlflow.pyfunc.model
    config:
      llm_endpoint: databricks-claude-sonnet-4-6
      semantic_index: a_catalog.a_schema.semantic_layer_index
      declared_manifest:
      - a_catalog.a_schema.data_dictionary
      - a_catalog.a_schema.gold_player_180d_summary
      - a_catalog.a_schema.gold_title_daily_summary
      - a_catalog.a_schema.silver_gameplay_activity
      - a_catalog.a_schema.silver_player_profiles
      - a_catalog.a_schema.silver_purchases
      - a_catalog.a_schema.extra_one
      - a_catalog.a_schema.extra_two
      - a_catalog.a_schema.extra_three
      - a_catalog.a_schema.extra_four
      - a_catalog.a_schema.extra_five
      - a_catalog.a_schema.extra_six
      catalog: a_catalog
      schema: a_schema
`;

function serving(version = '39') {
  return {
    config: {
      traffic_config: { routes: [{ served_model_name: `agent_${version}`, traffic_percentage: 100 }] },
      served_entities: [
        {
          name: `agent_${version}`,
          entity_name: 'a_catalog.a_schema.an_agent',
          entity_version: version,
        },
      ],
    },
  };
}

function transport(over: Partial<{ runId: string; document: string; failRun: boolean }> = {}): BakedConfigTransport {
  const runId = over.runId ?? 'run-abc';
  const document = over.document ?? MLMODEL;
  return {
    getJson: async (path, query = {}) => {
      if (path.includes('/unity-catalog/models/') || path.includes('model-versions/get')) {
        if (over.failRun) throw new Error('no version');
        return { model_version: { run_id: runId } };
      }
      if (path.includes('/mlflow/artifacts/get')) {
        expect(query.run_id).toBe(runId);
        return { content: document };
      }
      if (path.includes('/mlflow/artifacts/list')) {
        return { files: [{ path: 'agent/MLmodel', is_dir: false }] };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

afterEach(() => {
  forgetBakedModelConfig();
});

describe('reading model_config out of an MLmodel document', () => {
  it('finds the foundation model, the resolved index, and the twelve-table list', () => {
    const config = parseModelConfigDocument(MLMODEL);
    expect(config.llm_endpoint).toBe('databricks-claude-sonnet-4-6');
    expect(config.semantic_index).toBe('a_catalog.a_schema.semantic_layer_index');
    expect(config.declared_manifest).toEqual(expect.arrayContaining(['a_catalog.a_schema.extra_six']));
    expect((config.declared_manifest as string[]).length).toBe(12);
  });

  it('also reads a JSON document the artifact API sometimes wraps', () => {
    const config = parseModelConfigDocument(
      JSON.stringify({
        llm_endpoint: 'databricks-claude-sonnet-4-6',
        declared_manifest: ['a.b.one', 'a.b.two'],
      })
    );
    expect(config.llm_endpoint).toBe('databricks-claude-sonnet-4-6');
    expect(config.declared_manifest).toEqual(['a.b.one', 'a.b.two']);
  });

  it('does not invent keys from an empty or unreadable document', () => {
    expect(parseModelConfigDocument('')).toEqual({});
    expect(parseModelConfigDocument('flavors:\n  python_function:\n    python_version: 3.11\n')).toEqual({});
  });
});

describe('turning the map into configuration entries', () => {
  it('marks them as artifact-baked and drops empties', () => {
    const entries = configurationFromBaked({
      llm_endpoint: 'databricks-claude-sonnet-4-6',
      semantic_index: '',
      llm_gateway: null,
      declared_manifest: ['a.b.one', 'a.b.two'],
    });
    const byKey = Object.fromEntries(entries.map((entry) => [entry.key, entry]));
    expect(byKey.llm_endpoint).toMatchObject({
      value: 'databricks-claude-sonnet-4-6',
      source: 'artifact',
      baked: true,
    });
    expect(byKey.declared_manifest.value).toEqual(['a.b.one', 'a.b.two']);
    expect(byKey.semantic_index).toBeUndefined();
    expect(byKey.llm_gateway).toBeUndefined();
  });
});

describe('reading the served version as the app', () => {
  it('follows endpoint → model version → MLmodel without invoking serving', async () => {
    const entries = await readBakedModelConfig({
      endpointName: 'an-endpoint',
      readEndpoint: () => Promise.resolve(serving()),
      transport: transport(),
    });
    const byKey = Object.fromEntries(entries.map((entry) => [entry.key, entry]));
    expect(byKey.llm_endpoint.value).toBe('databricks-claude-sonnet-4-6');
    expect(byKey.semantic_index.value).toBe('a_catalog.a_schema.semantic_layer_index');
    expect(byKey.declared_manifest.value).toHaveLength(12);
  });

  it('returns nothing rather than throwing when the version cannot be read', async () => {
    expect(
      await readBakedModelConfig({
        endpointName: 'an-endpoint',
        readEndpoint: () => Promise.reject(new Error('no endpoint')),
        transport: transport(),
      })
    ).toEqual([]);
    expect(
      await readBakedModelConfig({
        endpointName: 'an-endpoint',
        readEndpoint: () => Promise.resolve(serving()),
        transport: transport({ failRun: true }),
      })
    ).toEqual([]);
  });

  it('returns nothing when no serving endpoint is configured', async () => {
    expect(await readBakedModelConfig({ endpointName: '' })).toEqual([]);
  });
});
