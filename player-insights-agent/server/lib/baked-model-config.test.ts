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

function implicitServing(version = '39') {
  return {
    config: {
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
    getJson: (path, query = {}) => {
      if (path.includes('/unity-catalog/models/') || path.includes('model-versions/get')) {
        if (over.failRun) return Promise.reject(new Error('no version'));
        return Promise.resolve({ model_version: { run_id: runId } });
      }
      if (path.includes('/mlflow/artifacts/get')) {
        expect(query.run_id).toBe(runId);
        return Promise.resolve({ content: document });
      }
      if (path.includes('/mlflow/artifacts/list')) {
        return Promise.resolve({ files: [{ path: 'agent/MLmodel', is_dir: false }] });
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
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

  it('recovers the exact MLflow experiment from the served model run', async () => {
    const base = transport();
    const entries = await readBakedModelConfig({
      endpointName: 'an-endpoint',
      readEndpoint: () => Promise.resolve(serving()),
      transport: {
        ...base,
        getJson: (path, query = {}) => {
          if (path === '/api/2.0/mlflow/runs/get') {
            expect(query.run_id).toBe('run-abc');
            return Promise.resolve({ run: { info: { experiment_id: 'customer-experiment' } } });
          }
          return base.getJson(path, query);
        },
      },
    });

    expect(entries.find((entry) => entry.key === 'experiment_id')).toMatchObject({
      value: 'customer-experiment',
      source: 'served-model-version',
      baked: false,
    });
  });

  it('reuses last-good rich config only while the exact served model version is unchanged', async () => {
    const base = transport();
    let artifactOutage = false;
    const flaky: BakedConfigTransport = {
      ...base,
      getJson: (path, query = {}) => {
        if (artifactOutage && path.includes('/mlflow/artifacts/get')) {
          return Promise.reject(new Error('temporary artifact outage'));
        }
        return base.getJson(path, query);
      },
    };
    const first = await readBakedModelConfig({
      endpointName: 'an-endpoint',
      readEndpoint: () => Promise.resolve(serving('39')),
      transport: flaky,
      now: 0,
    });
    expect(first.find((entry) => entry.key === 'llm_endpoint')?.value).toBe('databricks-claude-sonnet-4-6');

    artifactOutage = true;
    const sameVersion = await readBakedModelConfig({
      endpointName: 'an-endpoint',
      readEndpoint: () => Promise.resolve(serving('39')),
      transport: flaky,
      now: 60_000,
    });
    expect(sameVersion.find((entry) => entry.key === 'llm_endpoint')?.value).toBe('databricks-claude-sonnet-4-6');

    const newVersion = await readBakedModelConfig({
      endpointName: 'an-endpoint',
      readEndpoint: () => Promise.resolve(serving('40')),
      transport: flaky,
      now: 60_001,
    });
    expect(newVersion.find((entry) => entry.key === 'llm_endpoint')).toBeUndefined();
    expect(newVersion.find((entry) => entry.key === 'catalog')?.value).toBe('a_catalog');
  });

  it('reads an MLflow 3 Logged Model behind the production implicit traffic shape', async () => {
    const paths: string[] = [];
    const entries = await readBakedModelConfig({
      endpointName: 'an-endpoint',
      readEndpoint: () => Promise.resolve(implicitServing()),
      transport: {
        getJson: (path) => {
          paths.push(path);
          if (path.includes('/unity-catalog/models/')) {
            return Promise.resolve({
              run_id: 'source-run',
              source: 'models:/m-logged-model',
            });
          }
          if (path === '/api/2.0/mlflow/logged-models/m-logged-model') {
            return Promise.resolve({
              model: {
                info: {
                  artifact_uri: 'dbfs:/databricks/mlflow-tracking/experiment-1/logged_models/m-logged-model/artifacts',
                },
              },
            });
          }
          return Promise.reject(new Error(`unexpected path ${path}`));
        },
        downloadText: (path) => {
          paths.push(path);
          return Promise.resolve(MLMODEL);
        },
      },
    });

    const byKey = Object.fromEntries(entries.map((entry) => [entry.key, entry]));
    expect(byKey.llm_endpoint.value).toBe('databricks-claude-sonnet-4-6');
    expect(byKey.semantic_index.value).toBe('a_catalog.a_schema.semantic_layer_index');
    expect(byKey.declared_manifest.value).toHaveLength(12);
    expect(paths).toContain('/api/2.0/mlflow/logged-models/m-logged-model');
    expect(paths).toContain(
      '/WorkspaceInternal/Mlflow/Artifacts/experiment-1/LoggedModels/m-logged-model/artifacts/MLmodel'
    );
    expect(paths).not.toContain('/api/2.0/mlflow/artifacts/get');
  });

  it('returns nothing rather than throwing when the endpoint itself cannot be read', async () => {
    // The endpoint read is what tells us the served model's name, so if it
    // fails we have neither baked config nor a name to recover catalog/schema
    // from -- there is genuinely nothing to report.
    expect(
      await readBakedModelConfig({
        endpointName: 'an-endpoint',
        readEndpoint: () => Promise.reject(new Error('no endpoint')),
        transport: transport(),
      })
    ).toEqual([]);
  });

  it('recovers catalog and schema from the served model name when the artifact read fails', async () => {
    // The endpoint IS readable, so we know the served model is
    // `a_catalog.a_schema.<model>`; the artifact read then fails. Rather than
    // blank the whole data contract, the model's own name yields catalog and
    // schema (marked served-model-name, not baked), which keeps App catalog,
    // App schema and the declared table list connected through the outage.
    const entries = await readBakedModelConfig({
      endpointName: 'an-endpoint',
      readEndpoint: () => Promise.resolve(serving()),
      transport: transport({ failRun: true }),
    });
    const byKey = Object.fromEntries(entries.map((entry) => [entry.key, entry]));
    expect(byKey.catalog?.value).toBe('a_catalog');
    expect(byKey.schema?.value).toBe('a_schema');
    expect(byKey.catalog?.source).toBe('served-model-name');
    expect(byKey.catalog?.baked).toBe(false);
    // Nothing else could be read: the artifact-only values stay absent.
    expect(byKey.llm_endpoint).toBeUndefined();
    expect(byKey.semantic_index).toBeUndefined();
  });

  it('returns nothing when no serving endpoint is configured', async () => {
    expect(await readBakedModelConfig({ endpointName: '' })).toEqual([]);
  });
});
