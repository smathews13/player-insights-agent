import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PreflightReport } from '../routes/insights-routes';
import {
  applyAstrolabeTags,
  createWorkspaceTagPlatform,
  readAppBillingTag,
  resourceTagInventory,
  type ResourceTagPlatform,
} from './resource-tagging';

function report(configuration: Array<{ key: string; value: string }>): PreflightReport {
  return { configuration } as PreflightReport;
}

function platform(overrides: Partial<ResourceTagPlatform> = {}): ResourceTagPlatform {
  return {
    getServingTags: vi.fn(() => Promise.resolve([])),
    patchServingTags: vi.fn(() => Promise.resolve()),
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

const TOKEN = 'opaque-token';

function scopedToken(scopes: string[]): string {
  return `header.${Buffer.from(JSON.stringify({ scope: scopes.join(' ') })).toString('base64url')}.signature`;
}

function urlText(value: string | URL | Request): string {
  if (typeof value === 'string') return value;
  return value instanceof URL ? value.toString() : value.url;
}

describe('Resource Tags support matrix', () => {
  it('inventories every connected class and marks only billing-capable APIs supported', () => {
    const targets = resourceTagInventory({
      environment: {
        DATABRICKS_APP_NAME: 'astrolabe',
        DATABRICKS_SERVING_ENDPOINT_NAME: 'agent-endpoint',
        DATABRICKS_SQL_WAREHOUSE_ID: 'warehouse-1',
        PLAYER_INSIGHTS_EXPERIMENT_ID: 'experiment-1',
        LAKEBASE_ENDPOINT: 'projects/app-db/branches/production/endpoints/primary',
      },
      report: report([
        { key: 'model_name', value: 'catalog.schema.agent' },
        { key: 'model_version', value: '7' },
        { key: 'llm_endpoint', value: 'databricks-claude-sonnet-4-6' },
        { key: 'data_genie_space_id', value: 'data-space' },
        { key: 'dictionary_genie_space_id', value: 'dictionary-space' },
        { key: 'semantic_index', value: 'catalog.schema.semantic_index' },
      ]),
    });
    const support = Object.fromEntries(targets.map((item) => [item.kind, item.support]));

    expect(support).toMatchObject({
      app: 'not-applicable',
      'registered-model': 'not-applicable',
      'model-version': 'not-applicable',
      'serving-endpoint': 'supported',
      'foundation-model-endpoint': 'not-applicable',
      'genie-space': 'not-applicable',
      'mlflow-experiment': 'not-applicable',
      'vector-index': 'unsupported',
      'sql-warehouse': 'supported',
      'lakebase-project': 'supported',
      'lakebase-branch': 'not-applicable',
      'lakebase-endpoint': 'not-applicable',
    });
    expect(targets.filter((item) => item.billingAttribution).map((item) => item.kind)).toEqual([
      'serving-endpoint',
      'sql-warehouse',
      'lakebase-project',
    ]);
  });

  it('treats a customer-owned foundation endpoint as a normal serving target', () => {
    const targets = resourceTagInventory({
      environment: {},
      report: report([{ key: 'llm_endpoint', value: 'customer-foundation-route' }]),
    });
    expect(targets).toEqual([
      expect.objectContaining({
        kind: 'serving-endpoint',
        name: 'customer-foundation-route',
        support: 'supported',
      }),
    ]);
  });

  it('does not duplicate one serving endpoint named by two configuration paths', () => {
    const targets = resourceTagInventory({
      environment: { DATABRICKS_SERVING_ENDPOINT_NAME: 'shared' },
      report: report([{ key: 'llm_endpoint', value: 'shared' }]),
    });
    expect(targets.filter((item) => item.kind === 'serving-endpoint')).toHaveLength(1);
  });
});

describe('coverage semantics', () => {
  it('excludes organizational metadata and unsupported resources from the primary denominator', async () => {
    const summary = await applyAstrolabeTags({
      environment: {
        DATABRICKS_APP_NAME: 'astrolabe',
        DATABRICKS_SERVING_ENDPOINT_NAME: 'agent',
        DATABRICKS_SQL_WAREHOUSE_ID: 'warehouse',
        PLAYER_INSIGHTS_EXPERIMENT_ID: 'experiment',
      },
      report: report([
        { key: 'data_genie_space_id', value: 'genie' },
        { key: 'semantic_index', value: 'catalog.schema.index' },
      ]),
      platform: platform(),
      token: TOKEN,
    });

    expect(summary).toMatchObject({
      headline: '3 of 3 supported resources tagged',
      supportedTotal: 3,
      supportedCovered: 3,
      tagged: 3,
      unsupported: 1,
      notApplicable: 3,
      supportedFailed: 0,
    });
    expect(summary.results.filter((item) => item.status === 'unsupported')).toHaveLength(1);
    expect(summary.results.filter((item) => item.status === 'not-applicable')).toHaveLength(3);
  });

  it('counts already-correct and newly-applied resources as covered without duplicate writes', async () => {
    const patchServingTags = vi.fn(() => Promise.resolve());
    const setWarehouseTags = vi.fn(() => Promise.resolve());
    const summary = await applyAstrolabeTags({
      environment: {
        DATABRICKS_SERVING_ENDPOINT_NAME: 'agent',
        DATABRICKS_SQL_WAREHOUSE_ID: 'warehouse',
      },
      report: null,
      token: TOKEN,
      platform: platform({
        getServingTags: vi.fn(() => Promise.resolve([{ key: 'system_billing', value: 'astrolabe' }])),
        patchServingTags,
        setWarehouseTags,
      }),
    });
    expect(summary).toMatchObject({
      supportedTotal: 2,
      supportedCovered: 2,
      tagged: 1,
      alreadyCorrect: 1,
    });
    expect(patchServingTags).not.toHaveBeenCalled();
    expect(setWarehouseTags).toHaveBeenCalledTimes(1);
  });
});

describe('identity, permissions, and API paths', () => {
  it('uses only the server-provided OBO token for billing-tag APIs', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fakeFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: urlText(url),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Promise.resolve(
        new Response(JSON.stringify({ tags: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    });
    const live = createWorkspaceTagPlatform({
      host: 'https://workspace.example',
      token: 'obo-token',
      fetchImpl: fakeFetch as typeof fetch,
    });
    await live.getServingTags('agent');
    expect(calls).toEqual([
      {
        url: 'https://workspace.example/api/2.0/serving-endpoints/agent',
        authorization: 'Bearer obo-token',
      },
    ]);
    const source = readFileSync(new URL('resource-tagging.ts', import.meta.url), 'utf8');
    const oboAdapter = source.slice(
      source.indexOf('export function createWorkspaceTagPlatform'),
      source.indexOf('export async function createAppVectorTagPlatform')
    );
    expect(oboAdapter).toContain('authorization: `Bearer ${input.token}`');
    expect(oboAdapter).not.toContain('new WorkspaceClient');
    expect(source).not.toContain('DATABRICKS_CLIENT_ID');
  });

  it('selects OBO for user-authorized APIs and the app identity only for AI Search tags', async () => {
    const getServingTags = vi.fn(() => Promise.resolve([]));
    const unusedOboVectorDiscovery = vi.fn(() => Promise.resolve('wrong-endpoint'));
    const obo = platform({ getServingTags, getVectorIndexEndpoint: unusedOboVectorDiscovery });
    const vector = {
      getVectorIndexEndpoint: vi.fn(() => Promise.resolve('vector-endpoint')),
      getVectorEndpointTags: vi.fn(() => Promise.resolve([])),
      setVectorEndpointTags: vi.fn(() => Promise.resolve()),
    };
    const result = await applyAstrolabeTags({
      environment: { DATABRICKS_SERVING_ENDPOINT_NAME: 'agent' },
      report: report([{ key: 'semantic_index', value: 'catalog.schema.index' }]),
      token: TOKEN,
      platform: obo,
      vectorPlatform: vector,
    });
    expect(getServingTags).toHaveBeenCalledWith('agent', undefined);
    expect(unusedOboVectorDiscovery).not.toHaveBeenCalled();
    expect(vector.getVectorIndexEndpoint).toHaveBeenCalledWith('catalog.schema.index', undefined);
    expect(vector.setVectorEndpointTags).toHaveBeenCalled();
    expect(result.results.find((item) => item.kind === 'vector-endpoint')?.identity).toBe('app-service-principal');
  });

  it('uses the documented endpoint, warehouse, Lakebase update-mask, and AI Search tag paths', async () => {
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const fakeFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: urlText(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
      });
      const path = urlText(url);
      const body = path.includes('/postgres/')
        ? { status: { custom_tags: [] } }
        : path.includes('/sql/warehouses/')
          ? { tags: { custom_tags: [] } }
          : path.includes('/vector-search/indexes/')
            ? { endpoint_name: 'vs-endpoint' }
            : { custom_tags: [], tags: [] };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    const live = createWorkspaceTagPlatform({
      host: 'https://workspace.example/',
      token: 'obo-token',
      fetchImpl: fakeFetch as typeof fetch,
    });
    await live.patchServingTags('agent', [{ key: 'k', value: 'v' }], [], undefined);
    await live.setWarehouseTags('warehouse', [{ key: 'k', value: 'v' }]);
    await live.setLakebaseTags('projects/project', [{ key: 'k', value: 'v' }]);
    await live.setVectorEndpointTags('vector', [{ key: 'k', value: 'v' }]);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'PATCH https://workspace.example/api/2.0/serving-endpoints/agent/tags',
      'POST https://workspace.example/api/2.0/sql/warehouses/warehouse/edit',
      'PATCH https://workspace.example/api/2.0/postgres/projects/project?update_mask=spec.custom_tags',
      'PATCH https://workspace.example/api/2.0/vector-search/endpoints/vector/tags',
    ]);
    expect(JSON.parse(calls[2].body)).toMatchObject({ name: 'projects/project' });
  });

  it('classifies a missing OBO token as permission required and performs no write', async () => {
    const setWarehouseTags = vi.fn(() => Promise.resolve());
    const summary = await applyAstrolabeTags({
      environment: { DATABRICKS_SQL_WAREHOUSE_ID: 'warehouse' },
      report: null,
      token: null,
      platform: platform({ setWarehouseTags }),
    });
    expect(summary).toMatchObject({ supportedTotal: 1, permissionRequired: 1, supportedFailed: 0 });
    expect(summary.results[0].detail).toContain('signed-in administrator');
    expect(setWarehouseTags).not.toHaveBeenCalled();
  });

  it('detects a missing declared scope before calling Databricks', async () => {
    const getWarehouseTags = vi.fn(() => Promise.resolve([]));
    const summary = await applyAstrolabeTags({
      environment: { DATABRICKS_SQL_WAREHOUSE_ID: 'warehouse' },
      report: null,
      token: scopedToken(['model-serving']),
      platform: platform({ getWarehouseTags }),
    });
    expect(summary).toMatchObject({ permissionRequired: 1, supportedFailed: 0 });
    expect(summary.results[0].nextAction).toContain('`sql`');
    expect(summary.results[0].nextAction).toContain('restart');
    expect(getWarehouseTags).not.toHaveBeenCalled();
  });

  it('does not retry a 403 and redacts tokens and principal ids from diagnostics', async () => {
    const denial = Object.assign(
      new Error('403 PERMISSION_DENIED authorization=secret 071769f1-5623-45b6-a172-c8b8060adff1 Bearer raw-token'),
      { status: 403 }
    );
    const getServingTags = vi.fn(() => Promise.reject(denial));
    const sleep = vi.fn(() => Promise.resolve());
    const summary = await applyAstrolabeTags({
      environment: { DATABRICKS_SERVING_ENDPOINT_NAME: 'agent' },
      report: null,
      token: TOKEN,
      platform: platform({ getServingTags }),
      retry: { sleep },
    });
    expect(getServingTags).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ permissionRequired: 1, supportedFailed: 0 });
    expect(summary.results[0].technicalDetail).not.toMatch(/raw-token|071769f1/);
  });

  it('names the exact app-service-principal grant for an AI Search 403', async () => {
    const denial = Object.assign(new Error('PERMISSION_DENIED'), { status: 403 });
    const setVectorEndpointTags = vi.fn(() => Promise.reject(denial));
    const summary = await applyAstrolabeTags({
      environment: {},
      report: report([{ key: 'semantic_index', value: 'catalog.schema.index' }]),
      token: TOKEN,
      platform: platform(),
      vectorPlatform: {
        getVectorIndexEndpoint: vi.fn(() => Promise.resolve('vector-endpoint')),
        getVectorEndpointTags: vi.fn(() => Promise.resolve([])),
        setVectorEndpointTags,
      },
    });
    const vector = summary.results.find((item) => item.kind === 'vector-endpoint');
    expect(vector).toMatchObject({ status: 'permission-required', identity: 'app-service-principal' });
    expect(vector?.nextAction).toBe(
      'Grant the Player Insights Agent service principal CAN_MANAGE on AI Search endpoint “vector-endpoint”.'
    );
    expect(setVectorEndpointTags).toHaveBeenCalledTimes(1);
  });
});

describe('bounded retries, isolation, and cancellation', () => {
  it('honors 429 Retry-After and succeeds after one retry', async () => {
    const throttled = Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 900 });
    const getWarehouseTags = vi
      .fn<() => Promise<Array<{ key: string; value: string }>>>()
      .mockRejectedValueOnce(throttled)
      .mockResolvedValueOnce([]);
    const sleep = vi.fn(() => Promise.resolve());
    const summary = await applyAstrolabeTags({
      environment: { DATABRICKS_SQL_WAREHOUSE_ID: 'warehouse' },
      report: null,
      token: TOKEN,
      platform: platform({ getWarehouseTags }),
      retry: { sleep, now: () => 0, random: () => 0 },
    });
    expect(getWarehouseTags).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(900);
    expect(summary).toMatchObject({ supportedCovered: 1, supportedFailed: 0 });
  });

  it('isolates one exhausted 503 while another resource succeeds', async () => {
    const unavailable = Object.assign(new Error('temporary upstream outage'), { status: 503 });
    const summary = await applyAstrolabeTags({
      environment: {
        DATABRICKS_SERVING_ENDPOINT_NAME: 'agent',
        DATABRICKS_SQL_WAREHOUSE_ID: 'warehouse',
      },
      report: null,
      token: TOKEN,
      platform: platform({ getServingTags: vi.fn(() => Promise.reject(unavailable)) }),
      retry: { maxAttempts: 2, sleep: () => Promise.resolve(), now: () => 0 },
    });
    expect(summary).toMatchObject({ supportedTotal: 2, supportedCovered: 1, supportedFailed: 1 });
    expect(summary.results.find((item) => item.name === 'warehouse')?.status).toBe('tagged');
  });

  it('uses bounded concurrency', async () => {
    let active = 0;
    let maximum = 0;
    const hold = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return [];
    };
    await applyAstrolabeTags({
      environment: {
        DATABRICKS_SERVING_ENDPOINT_NAME: 'agent',
        DATABRICKS_SQL_WAREHOUSE_ID: 'warehouse',
        LAKEBASE_ENDPOINT: 'projects/project/branches/production',
      },
      report: null,
      token: TOKEN,
      platform: platform({
        getServingTags: hold,
        getWarehouseTags: hold,
        getLakebaseTags: hold,
      }),
      retry: { concurrency: 2 },
    });
    expect(maximum).toBe(2);
  });

  it('stops the batch when the request is cancelled', async () => {
    const controller = new AbortController();
    const pending = applyAstrolabeTags({
      environment: {
        DATABRICKS_SERVING_ENDPOINT_NAME: 'agent',
        DATABRICKS_SQL_WAREHOUSE_ID: 'warehouse',
      },
      report: null,
      token: TOKEN,
      signal: controller.signal,
      platform: platform({
        getServingTags: vi.fn<(name: string, signal?: AbortSignal) => Promise<Array<{ key: string; value: string }>>>(
          (_name, signal) =>
            new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))
        ),
      }),
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a second Apply retries only unresolved resources; full mode rechecks all', async () => {
    const temporary = Object.assign(new Error('unavailable'), { status: 503 });
    const firstPlatform = platform({ getServingTags: vi.fn(() => Promise.reject(temporary)) });
    const first = await applyAstrolabeTags({
      environment: {
        DATABRICKS_SERVING_ENDPOINT_NAME: 'agent',
        DATABRICKS_SQL_WAREHOUSE_ID: 'warehouse',
      },
      report: null,
      token: TOKEN,
      platform: firstPlatform,
      retry: { maxAttempts: 1 },
    });
    expect(first).toMatchObject({ supportedCovered: 1, supportedFailed: 1 });

    const getServingTags = vi.fn(() => Promise.resolve([]));
    const getWarehouseTags = vi.fn(() => Promise.resolve([]));
    const secondPlatform = platform({ getServingTags, getWarehouseTags });
    const second = await applyAstrolabeTags({
      environment: {
        DATABRICKS_SERVING_ENDPOINT_NAME: 'agent',
        DATABRICKS_SQL_WAREHOUSE_ID: 'warehouse',
      },
      report: null,
      token: TOKEN,
      platform: secondPlatform,
      previous: first,
    });
    expect(second).toMatchObject({ supportedCovered: 2, supportedFailed: 0 });
    expect(getServingTags).toHaveBeenCalledTimes(1);
    expect(getWarehouseTags).not.toHaveBeenCalled();

    await applyAstrolabeTags({
      environment: {
        DATABRICKS_SERVING_ENDPOINT_NAME: 'agent',
        DATABRICKS_SQL_WAREHOUSE_ID: 'warehouse',
      },
      report: null,
      token: TOKEN,
      platform: secondPlatform,
      previous: second,
      mode: 'full',
    });
    expect(getWarehouseTags).toHaveBeenCalledTimes(1);
  });

  it('retries failed AI Search discovery instead of treating the index name as an endpoint', async () => {
    const unavailable = Object.assign(new Error('temporary discovery failure'), { status: 503 });
    const first = await applyAstrolabeTags({
      environment: {},
      report: report([{ key: 'semantic_index', value: 'catalog.schema.index' }]),
      token: TOKEN,
      platform: platform({ getVectorIndexEndpoint: vi.fn(() => Promise.reject(unavailable)) }),
      retry: { maxAttempts: 1 },
    });
    const getVectorIndexEndpoint = vi.fn(() => Promise.resolve('real-endpoint'));
    const second = await applyAstrolabeTags({
      environment: {},
      report: report([{ key: 'semantic_index', value: 'catalog.schema.index' }]),
      token: TOKEN,
      platform: platform({ getVectorIndexEndpoint }),
      previous: first,
    });
    expect(getVectorIndexEndpoint).toHaveBeenCalledTimes(1);
    expect(second.results.find((item) => item.kind === 'vector-endpoint')?.name).toBe('real-endpoint');
  });
});

describe('organizational app tag diagnostics', () => {
  it('requires an explicit metadata reader and never treats absence as billing evidence', async () => {
    expect(await readAppBillingTag('app')).toBe('unverified');
    expect(await readAppBillingTag('app', { getAppTag: vi.fn(() => Promise.resolve('astrolabe')) })).toBe('matched');
    expect(await readAppBillingTag('app', { getAppTag: vi.fn(() => Promise.resolve(null)) })).toBe('missing');
  });
});
