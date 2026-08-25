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
        { key: 'llm_endpoint', value: 'databricks-claude-sonnet-4-6' },
        { key: 'data_genie_space_id', value: 'space-data' },
        { key: 'dictionary_genie_space_id', value: 'space-dictionary' },
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
      'serving-endpoint',
      'genie-space',
      'genie-space',
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
    expect(targets.find((target) => target.label.startsWith('Foundation model'))).toMatchObject({
      action: 'tag',
      name: 'databricks-claude-sonnet-4-6',
    });
    expect(targets.filter((target) => target.kind === 'genie-space')).toHaveLength(2);
  });
});

describe('applying Astrolabe resource tags', () => {
  it('counts an existing tag as success without writing it again', async () => {
    const createAppTag = vi.fn(() => Promise.resolve());
    const updateAppTag = vi.fn(() => Promise.resolve());
    const fake = platform({
      getAppTag: vi.fn(() => Promise.resolve('astrolabe')),
      createAppTag,
      updateAppTag,
    });
    const summary = await applyAstrolabeTags({
      environment: { DATABRICKS_APP_NAME: 'astrolabe' },
      report: null,
      platform: fake,
    });

    expect(summary).toMatchObject({
      total: 1,
      correct: 1,
      tagged: 0,
      alreadyCorrect: 1,
      notSupported: 0,
      permissionRequired: 0,
      failed: 0,
    });
    expect(summary.results[0].status).toBe('already-correct');
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
        getAppTag: vi.fn(() => Promise.resolve('astrolabe')),
      }),
    });

    expect(summary).toMatchObject({ total: 2, correct: 2, tagged: 1, alreadyCorrect: 1, failed: 0 });
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

    expect(summary).toMatchObject({ total: 2, correct: 1, tagged: 1, notSupported: 1, failed: 0 });
    const index = summary.results.find((result) => result.kind === 'vector-index');
    expect(index?.status).toBe('not-supported');
    expect(index?.detail).toContain('does not expose custom tags');
    expect(index?.detail).toContain('Nothing needs to be fixed');
    expect(summary.results.find((result) => result.kind === 'vector-endpoint')).toMatchObject({
      name: 'semantic-endpoint',
      status: 'tagged',
    });
    expect(setTags).toHaveBeenCalledWith('semantic-endpoint', [
      { key: 'owner', value: 'platform' },
      { key: 'system_billing', value: 'astrolabe' },
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

    expect(summary).toMatchObject({ total: 2, correct: 2, tagged: 2, notSupported: 0, failed: 0 });
    expect(setModelTag).toHaveBeenCalledWith('app.schema.astrolabe_agent');
    expect(setModelVersionTag).toHaveBeenCalledWith('app.schema.astrolabe_agent', '12');
  });

  it('tags the foundation model endpoint and states why Genie billing follows the warehouse', async () => {
    const addServingTag = vi.fn(() => Promise.resolve());
    const summary = await applyAstrolabeTags({
      environment: {},
      report: report([
        { key: 'llm_endpoint', value: 'databricks-claude-sonnet-4-6' },
        { key: 'data_genie_space_id', value: 'space-data' },
      ]),
      platform: platform({ addServingTag }),
    });

    expect(addServingTag).toHaveBeenCalledWith('databricks-claude-sonnet-4-6');
    expect(summary.results.find((result) => result.label.startsWith('Foundation model'))).toMatchObject({
      status: 'tagged',
    });
    expect(summary.results.find((result) => result.kind === 'genie-space')).toMatchObject({
      status: 'not-supported',
      detail: expect.stringContaining('billed through its associated SQL warehouse'),
    });
  });

  it('classifies the seven reported targets into correct, unsupported, grants, and recovered retry', async () => {
    const appDenial = new Error(
      'Response from server (Forbidden)\n' +
        '{"error_code":"PERMISSION_DENIED","message":"Failed to authorize app player-insights-agent. ' +
        'User does not have permission to apply tag assignment changes."}'
    );
    const vectorDenial = new Error(
      'Response from server (Forbidden)\n' +
        '{"error_code":"PERMISSION_DENIED","message":"The user is not authorized to make the request, ' +
        "please contact the workspace admin to assign the user 071769f1-5623-45b6-a172-c8b8060adff1 'Can Use' " +
        "or 'Can Manage' permission.\"}"
    );
    const warehouseDenial = new Error(
      'Response from server (Forbidden)\n' +
        '{"error_code":"PERMISSION_DENIED","message":"071769f1-5623-45b6-a172-c8b8060adff1 is not ' +
        'authorized to manage this SQL Endpoint. Please contact your administrator."}'
    );
    const lakebaseUpdate = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new Error(
          'Response from server (Gateway Timeout) ' +
            '{"error_code":"DEADLINE_EXCEEDED","details":[{"@type":"type.googleapis.com/google.rpc.RequestInfo"}]}'
        )
      )
      .mockResolvedValueOnce();
    const sleep = vi.fn(() => Promise.resolve());
    const summary = await applyAstrolabeTags({
      environment: {
        DATABRICKS_APP_NAME: 'player-insights-agent',
        DATABRICKS_CLIENT_ID: '071769f1-5623-45b6-a172-c8b8060adff1',
        DATABRICKS_SERVING_ENDPOINT_NAME: 'player-insights-agent',
        PLAYER_INSIGHTS_EXPERIMENT_ID: '<mlflow-experiment-id>',
        DATABRICKS_SQL_WAREHOUSE_ID: '<sql-warehouse-id>',
        LAKEBASE_ENDPOINT: 'projects/player-insights-agent-db/branches/production',
      },
      report: report([{ key: 'semantic_index', value: '<your_catalog>.<your_schema>.semantic_layer_index' }]),
      platform: platform({
        createAppTag: vi.fn(() => Promise.reject(appDenial)),
        getServingTags: vi.fn(() => Promise.resolve([{ key: 'system_billing', value: 'astrolabe' }])),
        getExperimentTags: vi.fn(() => Promise.resolve([{ key: 'system_billing', value: 'astrolabe' }])),
        getVectorIndexEndpoint: vi.fn(() => Promise.resolve('player-insights-vector-endpoint')),
        setVectorEndpointTags: vi.fn(() => Promise.reject(vectorDenial)),
        setWarehouseTags: vi.fn(() => Promise.reject(warehouseDenial)),
        setLakebaseTags: lakebaseUpdate,
      }),
      retry: { sleep, now: () => 0 },
    });

    expect(summary).toMatchObject({
      total: 7,
      correct: 3,
      tagged: 1,
      alreadyCorrect: 2,
      notSupported: 1,
      permissionRequired: 3,
      failed: 0,
    });
    expect(summary.headline).toBe(
      '3 of 7 resources correctly tagged · 1 not supported by Databricks · ' +
        '3 need workspace grants · 0 failed after retries.'
    );
    expect(lakebaseUpdate).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);

    const app = summary.results.find((result) => result.kind === 'app');
    expect(app).toMatchObject({ status: 'permission-required' });
    expect(app?.detail).toContain(
      'service principal 071769f1-5623-45b6-a172-c8b8060adff1 CAN_MANAGE on app “player-insights-agent”'
    );
    expect(app?.technicalDetail).toContain('apply tag assignment changes');

    const vectorIndex = summary.results.find((result) => result.kind === 'vector-index');
    expect(vectorIndex).toMatchObject({ status: 'not-supported' });
    expect(vectorIndex?.detail).toContain('does not expose custom tags');
    expect(vectorIndex?.detail).toContain('Nothing needs to be fixed');

    const vectorEndpoint = summary.results.find((result) => result.kind === 'vector-endpoint');
    expect(vectorEndpoint).toMatchObject({
      status: 'permission-required',
      name: 'player-insights-vector-endpoint',
    });
    expect(vectorEndpoint?.detail).toContain(
      'service principal 071769f1-5623-45b6-a172-c8b8060adff1 CAN_USE or CAN_MANAGE'
    );

    const warehouse = summary.results.find((result) => result.kind === 'sql-warehouse');
    expect(warehouse).toMatchObject({ status: 'permission-required' });
    expect(warehouse?.detail).toContain(
      'service principal 071769f1-5623-45b6-a172-c8b8060adff1 CAN_MANAGE (or ownership)'
    );

    expect(summary.results.find((result) => result.kind === 'serving-endpoint')).toMatchObject({
      status: 'already-correct',
    });
    expect(summary.results.find((result) => result.kind === 'mlflow-experiment')).toMatchObject({
      status: 'already-correct',
    });
    expect(summary.results.find((result) => result.kind === 'lakebase')).toMatchObject({ status: 'tagged' });
  });

  it('reports DEADLINE_EXCEEDED only after all bounded retry attempts are spent', async () => {
    const deadline = new Error(
      'Response from server (Gateway Timeout) {"error_code":"DEADLINE_EXCEEDED","message":"deadline exceeded"}'
    );
    const setLakebaseTags = vi.fn(() => Promise.reject(deadline));
    const summary = await applyAstrolabeTags({
      environment: { LAKEBASE_ENDPOINT: 'projects/player-insights-agent-db/branches/production' },
      report: null,
      platform: platform({ setLakebaseTags }),
      retry: { maxAttempts: 3, sleep: () => Promise.resolve(), now: () => 0 },
    });

    expect(setLakebaseTags).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({
      total: 1,
      correct: 0,
      notSupported: 0,
      permissionRequired: 0,
      failed: 1,
    });
    expect(summary.headline).toBe(
      '0 of 1 resources correctly tagged · 0 not supported by Databricks · ' +
        '0 need workspace grants · 1 failed after retries.'
    );
    expect(summary.results[0]).toMatchObject({
      status: 'failed',
      detail: 'Databricks did not complete the tag update after Astrolabe retried transient failures.',
    });
    expect(summary.results[0].technicalDetail).toContain('DEADLINE_EXCEEDED');
  });

  it('names the warehouse grant needed when the app service principal cannot tag it', async () => {
    const summary = await applyAstrolabeTags({
      environment: {
        DATABRICKS_CLIENT_ID: '071769f1-5623-45b6-a172-c8b8060adff1',
        DATABRICKS_SQL_WAREHOUSE_ID: 'warehouse-1',
      },
      report: null,
      platform: platform({
        setWarehouseTags: vi.fn(() =>
          Promise.reject(
            new Error(
              'Response from server (Forbidden)\n' +
                '{"error_code":"PERMISSION_DENIED","message":"071769f1-5623-45b6-a172-c8b8060adff1 ' +
                'is not authorized to manage this SQL Endpoint."}'
            )
          )
        ),
      }),
    });

    expect(summary).toMatchObject({ tagged: 0, permissionRequired: 1, failed: 0 });
    expect(summary.results[0].label).toContain('warehouse-1');
    expect(summary.results[0].detail).toContain('CAN_MANAGE');
  });

  it('names CAN_MANAGE when the app service principal cannot tag Lakebase', async () => {
    const summary = await applyAstrolabeTags({
      environment: {
        DATABRICKS_CLIENT_ID: '071769f1-5623-45b6-a172-c8b8060adff1',
        LAKEBASE_ENDPOINT: 'projects/player-insights-agent-db/branches/production',
      },
      report: null,
      platform: platform({
        setLakebaseTags: vi.fn(() =>
          Promise.reject(new Error('Response from server (Forbidden) {"error_code":"PERMISSION_DENIED"}'))
        ),
      }),
    });

    expect(summary.results[0]).toMatchObject({ kind: 'lakebase', status: 'permission-required' });
    expect(summary.results[0].detail).toContain('CAN_MANAGE (or ownership)');
  });

  it('uses Apps-injected service-principal credentials, never the viewer token', () => {
    const source = readFileSync(new URL('resource-tagging.ts', import.meta.url), 'utf8');
    const route = readFileSync(new URL('../routes/settings-routes.ts', import.meta.url), 'utf8');
    const handler = route.slice(
      route.indexOf("app.post('/api/settings/resource-tags'"),
      route.indexOf("app.get('/api/settings'", route.indexOf("app.post('/api/settings/resource-tags'"))
    );

    expect(source).toContain('new WorkspaceClient({ httpTimeoutSeconds: 5, retryTimeoutSeconds: 0 })');
    expect(source).not.toContain('forwardedUserToken');
    expect(handler).not.toContain('forwardedUserToken');
  });
});
