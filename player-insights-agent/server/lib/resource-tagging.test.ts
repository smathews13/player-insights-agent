import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PreflightReport } from '../routes/insights-routes';
import { applyAstrolabeTags, resourceTagInventory, type ResourceTagPlatform } from './resource-tagging';

function report(configuration: Array<{ key: string; value: string }>): PreflightReport {
  return { configuration } as unknown as PreflightReport;
}

function platform(overrides: Partial<ResourceTagPlatform> = {}): ResourceTagPlatform {
  return {
    getAppTag: vi.fn(() => Promise.resolve(null)),
    createAppTag: vi.fn(() => Promise.resolve()),
    updateAppTag: vi.fn(() => Promise.resolve()),
    getServingTags: vi.fn(() => Promise.resolve([])),
    addServingTag: vi.fn(() => Promise.resolve()),
    getModelTags: vi.fn(() => Promise.resolve([])),
    setModelTag: vi.fn(() => Promise.resolve()),
    getModelVersionTags: vi.fn(() => Promise.resolve([])),
    setModelVersionTag: vi.fn(() => Promise.resolve()),
    getExperimentTags: vi.fn(() => Promise.resolve([])),
    setExperimentTag: vi.fn(() => Promise.resolve()),
    getWarehouseTags: vi.fn(() => Promise.resolve([])),
    setWarehouseTags: vi.fn(() => Promise.resolve()),
    getLakebaseTags: vi.fn(() => Promise.resolve([])),
    setLakebaseTags: vi.fn(() => Promise.resolve()),
    getVectorIndexEndpoint: vi.fn(() => Promise.resolve('semantic-endpoint')),
    getVectorEndpointTags: vi.fn(() => Promise.resolve([])),
    setVectorEndpointTags: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe('Astrolabe resource tag inventory', () => {
  it('uses connected identifiers without discovering or tagging customer data', () => {
    const targets = resourceTagInventory({
      environment: {
        DATABRICKS_APP_NAME: 'astrolabe',
        DATABRICKS_SERVING_ENDPOINT_NAME: 'astrolabe-agent',
        DATABRICKS_SQL_WAREHOUSE_ID: 'warehouse-1',
        PLAYER_INSIGHTS_EXPERIMENT_ID: 'experiment-1',
        LAKEBASE_ENDPOINT: 'projects/customer-project/branches/production',
        PLAYER_INSIGHTS_INDEX_REBUILD_JOB_ID: '123',
      },
      report: report([
        { key: 'semantic_index', value: 'app_catalog.app_schema.semantic_layer_index' },
        { key: 'model_name', value: 'app_catalog.app_schema.astrolabe_agent' },
        { key: 'model_version', value: '7' },
        { key: 'catalog', value: 'customer_catalog' },
        { key: 'declared_manifest', value: 'customer_catalog.analytics.orders' },
      ]),
    });

    expect(targets.map((target) => target.kind)).toEqual([
      'app',
      'registered-model',
      'model-version',
      'serving-endpoint',
      'mlflow-experiment',
      'vector-index',
      'sql-warehouse',
      'lakebase',
    ]);
    expect(targets.flatMap((target) => [target.name, target.reason ?? '']).join(' ')).not.toContain('customer_catalog');
    expect(targets.some((target) => target.name === '123')).toBe(false);
    expect(targets.find((target) => target.kind === 'sql-warehouse')).toMatchObject({ action: 'tag' });
    expect(targets.find((target) => target.kind === 'lakebase')).toMatchObject({
      action: 'tag',
      name: 'projects/customer-project',
    });
  });
});

describe('applying Astrolabe resource tags', () => {
  it('counts an existing tag as success without writing it again', async () => {
    const createAppTag = vi.fn(() => Promise.resolve());
    const updateAppTag = vi.fn(() => Promise.resolve());
    const fake = platform({
      getAppTag: vi.fn(() => Promise.resolve('true')),
      createAppTag,
      updateAppTag,
    });
    const summary = await applyAstrolabeTags({
      environment: { DATABRICKS_APP_NAME: 'astrolabe' },
      report: null,
      platform: fake,
    });

    expect(summary).toMatchObject({ tagged: 0, alreadyTagged: 1, skipped: 0, failed: 0 });
    expect(summary.results[0].status).toBe('already-tagged');
    expect(createAppTag).not.toHaveBeenCalled();
    expect(updateAppTag).not.toHaveBeenCalled();
  });

  it('keeps newly tagged and already-tagged resources in separate counts', async () => {
    const summary = await applyAstrolabeTags({
      environment: {
        DATABRICKS_APP_NAME: 'astrolabe',
        DATABRICKS_SERVING_ENDPOINT_NAME: 'astrolabe-agent',
      },
      report: null,
      platform: platform({
        getAppTag: vi.fn(() => Promise.resolve('true')),
      }),
    });

    expect(summary).toMatchObject({ tagged: 1, alreadyTagged: 1, skipped: 0, failed: 0 });
  });

  it('skips a Vector Search index explicitly and tags only its endpoint', async () => {
    const setTags = vi.fn(() => Promise.resolve());
    const fake = platform({
      getVectorIndexEndpoint: vi.fn(() => Promise.resolve('semantic-endpoint')),
      getVectorEndpointTags: vi.fn(() => Promise.resolve([{ key: 'owner', value: 'platform' }])),
      setVectorEndpointTags: setTags,
    });
    const summary = await applyAstrolabeTags({
      environment: {},
      report: report([{ key: 'semantic_index', value: 'app.schema.semantic_index' }]),
      platform: fake,
    });

    expect(summary).toMatchObject({ tagged: 1, skipped: 1, failed: 0 });
    const index = summary.results.find((result) => result.kind === 'vector-index');
    expect(index?.status).toBe('skipped');
    expect(index?.detail).toContain('do not have a custom tag API');
    expect(summary.results.find((result) => result.kind === 'vector-endpoint')).toMatchObject({
      name: 'semantic-endpoint',
      status: 'tagged',
    });
    expect(setTags).toHaveBeenCalledWith('semantic-endpoint', [
      { key: 'owner', value: 'platform' },
      { key: 'astrolabe', value: 'true' },
    ]);
  });

  it('tags the connected registered agent model and served model version', async () => {
    const setModelTag = vi.fn(() => Promise.resolve());
    const setModelVersionTag = vi.fn(() => Promise.resolve());
    const summary = await applyAstrolabeTags({
      environment: {},
      report: report([
        { key: 'model_name', value: 'app.schema.astrolabe_agent' },
        { key: 'model_version', value: '12' },
      ]),
      platform: platform({ setModelTag, setModelVersionTag }),
    });

    expect(summary).toMatchObject({ tagged: 2, skipped: 0, failed: 0 });
    expect(setModelTag).toHaveBeenCalledWith('app.schema.astrolabe_agent');
    expect(setModelVersionTag).toHaveBeenCalledWith('app.schema.astrolabe_agent', '12');
  });

  it('names the warehouse grant needed when the app service principal cannot tag it', async () => {
    const summary = await applyAstrolabeTags({
      environment: { DATABRICKS_SQL_WAREHOUSE_ID: 'warehouse-1' },
      report: null,
      platform: platform({
        setWarehouseTags: vi.fn(() => Promise.reject(new Error('403 PERMISSION_DENIED'))),
      }),
    });

    expect(summary).toMatchObject({ tagged: 0, skipped: 0, failed: 1 });
    expect(summary.results[0].label).toContain('warehouse-1');
    expect(summary.results[0].detail).toContain('CAN_MANAGE');
  });

  it('uses Apps-injected service-principal credentials, never the viewer token', () => {
    const source = readFileSync(new URL('resource-tagging.ts', import.meta.url), 'utf8');
    const route = readFileSync(new URL('../routes/settings-routes.ts', import.meta.url), 'utf8');
    const handler = route.slice(
      route.indexOf("app.post('/api/settings/resource-tags'"),
      route.indexOf("app.get('/api/settings'", route.indexOf("app.post('/api/settings/resource-tags'"))
    );

    expect(source).toContain('new WorkspaceClient({})');
    expect(source).not.toContain('forwardedUserToken');
    expect(handler).not.toContain('forwardedUserToken');
  });
});
