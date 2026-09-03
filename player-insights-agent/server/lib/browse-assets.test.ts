import { describe, expect, it, vi } from 'vitest';

import {
  BROWSE_PAGE_LIMIT,
  browseBlockedByScope,
  discoverConnectionTypes,
  interpretBrowseAnswer,
  lakebaseProjectParent,
  listCatalogs,
  listExperiments,
  listGenieSpaces,
  listLakebaseDatabases,
  listLakebaseProjects,
  listNotebooks,
  listSchemas,
  listServingEndpoints,
  listTables,
  listVectorSearchEndpoints,
  listVectorSearchIndexes,
  listVolumes,
  listWarehouses,
  resetBrowsePageCache,
  validateNotebookPath,
} from './browse-assets';
import { DISCOVERY_MAX_CONCURRENCY } from './discovery-control';
import { isBrowseOk, isBrowseUnavailable } from '../../shared/browse-contract';

const HOST = 'https://example-workspace.invalid';

function tokenWith(scopes: string[]): string {
  const claims = Buffer.from(JSON.stringify({ scope: scopes.join(' ') })).toString('base64url');
  return `hdr.${claims}.sig`;
}

const CATALOG_SCOPES = [
  'sql',
  'dashboards.genie',
  'catalog.catalogs:read',
  'catalog.schemas:read',
  'catalog.tables:read',
  'workspace.workspace:read',
  'serving.serving-endpoints',
  'vectorsearch.vector-search-indexes:read',
  'vectorsearch.vector-search-endpoints:read',
  'postgres',
] as const;

function fetchFor(routes: Record<string, { status: number; body: Record<string, unknown> }>) {
  return vi.fn((url: string) => {
    const path = String(url).replace(HOST, '');
    const key = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    if (!key) {
      return Promise.resolve({
        status: 404,
        json: () => Promise.resolve({ error_code: 'NOT_FOUND', message: path }),
      });
    }
    const hit = routes[key];
    return Promise.resolve({ status: hit.status, json: () => Promise.resolve(hit.body) });
  }) as unknown as typeof fetch;
}

describe('browseBlockedByScope', () => {
  it('blocks catalog browse when the token lacks the catalog scope', () => {
    expect(
      browseBlockedByScope({
        apiPath: '/api/2.1/unity-catalog/catalogs',
        token: tokenWith(['sql', 'dashboards.genie']),
        declaredScopes: [...CATALOG_SCOPES],
      })
    ).toBe('catalog.catalogs:read');
  });

  it('blocks when the app does not declare the scope at all', () => {
    expect(
      browseBlockedByScope({
        apiPath: '/api/2.0/workspace/list',
        token: tokenWith(['sql', 'dashboards.genie']),
        declaredScopes: ['sql', 'dashboards.genie'],
      })
    ).toBe('workspace.workspace:read');
  });

  it('does not block when the token carries the scope', () => {
    expect(
      browseBlockedByScope({
        apiPath: '/api/2.1/unity-catalog/catalogs',
        token: tokenWith(['unity-catalog']),
        declaredScopes: [...CATALOG_SCOPES],
      })
    ).toBeNull();
  });
});

describe('interpretBrowseAnswer', () => {
  it('turns a bare catalog 403 into unavailable, not empty or failed', () => {
    const response = interpretBrowseAnswer({
      kind: 'catalogs',
      apiPath: '/api/2.1/unity-catalog/catalogs',
      answer: { kind: 'http', status: 403, body: {} },
      itemsFromBody: () => ({ items: [], next_page_token: '' }),
    });
    expect(isBrowseUnavailable(response)).toBe(true);
    if (response.status === 'unavailable') {
      expect(response.reason).toBe('scope_not_carried');
      expect(response.scope).toBe('catalog.catalogs:read');
    }
  });

  it('turns a scope-worded 403 into unavailable', () => {
    const response = interpretBrowseAnswer({
      kind: 'warehouses',
      apiPath: '/api/2.0/sql/warehouses',
      answer: {
        kind: 'http',
        status: 403,
        body: { message: 'Provided OAuth token does not have required scopes: sql' },
      },
      itemsFromBody: () => ({
        items: [{ id: 'x', label: 'x', secondary: '', expandable: false }],
        next_page_token: '',
      }),
    });
    expect(isBrowseUnavailable(response)).toBe(true);
    if (response.status === 'unavailable') {
      expect(response.scope).toBe('sql');
    }
  });

  it('keeps a successful empty list as ok', () => {
    const response = interpretBrowseAnswer({
      kind: 'catalogs',
      apiPath: '/api/2.1/unity-catalog/catalogs',
      answer: { kind: 'http', status: 200, body: { catalogs: [] } },
      itemsFromBody: () => ({ items: [], next_page_token: '' }),
    });
    expect(isBrowseOk(response)).toBe(true);
    if (response.status === 'ok') expect(response.items).toEqual([]);
  });

  it('treats a bare catalog 403 as a grant failure when the token holds the scope', () => {
    const response = interpretBrowseAnswer({
      kind: 'catalogs',
      apiPath: '/api/2.1/unity-catalog/catalogs',
      answer: { kind: 'http', status: 403, body: {} },
      itemsFromBody: () => ({ items: [], next_page_token: '' }),
      tokenScopes: ['catalog.catalogs:read'],
    });
    expect(response.status).toBe('failed');
    expect(isBrowseUnavailable(response)).toBe(false);
  });
});

describe('listCatalogs', () => {
  it('preserves an empty page token so the signed-in user can continue to visible catalogs', async () => {
    const fetchSpy = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve({
        status: 200,
        json: () =>
          Promise.resolve(
            String(url).includes('page_token=hidden-prefix')
              ? { catalogs: [{ name: 'customer_catalog' }], next_page_token: '' }
              : { catalogs: [], next_page_token: 'hidden-prefix' }
          ),
      })
    );
    const fetchImpl = fetchSpy as unknown as typeof fetch;
    const options = {
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl,
    };
    const first = await listCatalogs(options);
    expect(first).toMatchObject({
      status: 'ok',
      items: [],
      next_page_token: 'hidden-prefix',
      pagination: { complete: false, incomplete_reason: 'more_available', page: 1 },
    });
    const second = await listCatalogs({ ...options, pageToken: 'hidden-prefix', page: 2 });
    expect(second).toMatchObject({
      status: 'ok',
      items: [{ id: 'customer_catalog', label: 'customer_catalog' }],
      pagination: { complete: true, page: 2 },
    });
    const [secondUrl, secondInit] = fetchSpy.mock.calls[1] ?? [];
    expect(secondUrl).toContain('page_token=hidden-prefix');
    expect((secondInit?.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
  });

  it('returns catalogs the caller can see', async () => {
    const fetchImpl = fetchFor({
      '/api/2.1/unity-catalog/catalogs': {
        status: 200,
        body: {
          catalogs: [{ name: 'main' }, { name: 'samples' }],
          next_page_token: 'page-2',
        },
      },
    });
    const response = await listCatalogs({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl,
    });
    expect(response).toEqual({
      status: 'ok',
      kind: 'catalogs',
      items: [
        { id: 'main', label: 'main', secondary: '', expandable: false },
        { id: 'samples', label: 'samples', secondary: '', expandable: false },
      ],
      next_page_token: 'page-2',
      path: '',
      pagination: {
        complete: false,
        incomplete_reason: 'more_available',
        page: 1,
        page_limit: 5,
        page_size: 100,
        returned: 2,
      },
    });
  });

  it('returns unavailable when the sign-in lacks catalog.catalogs:read, without calling', async () => {
    const fetchImpl = vi.fn();
    const response = await listCatalogs({
      host: HOST,
      token: tokenWith(['sql', 'dashboards.genie']),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(isBrowseUnavailable(response)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    if (response.status === 'unavailable') {
      expect(response.reason).toBe('scope_not_carried');
      expect(response.scope).toBe('catalog.catalogs:read');
    }
  });

  it('returns ok with an empty items list when the workspace lists none', async () => {
    const response = await listCatalogs({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl: fetchFor({
        '/api/2.1/unity-catalog/catalogs': { status: 200, body: { catalogs: [] } },
      }),
    });
    expect(isBrowseOk(response)).toBe(true);
    if (response.status === 'ok') expect(response.items).toEqual([]);
  });
});

describe('discoverConnectionTypes', () => {
  it('returns only categories with user-visible root resources and preserves empty versus denied', async () => {
    const response = await discoverConnectionTypes({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES].filter((scope) => scope !== 'dashboards.genie')),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl: fetchFor({
        '/api/2.1/unity-catalog/catalogs': {
          status: 200,
          body: { catalogs: [{ name: 'main' }] },
        },
        '/api/2.1/unity-catalog/schemas': {
          status: 200,
          body: { schemas: [{ name: 'analytics', full_name: 'main.analytics' }] },
        },
        '/api/2.1/unity-catalog/tables': {
          status: 200,
          body: { tables: [{ name: 'players', full_name: 'main.analytics.players', table_type: 'MANAGED' }] },
        },
        '/api/2.1/unity-catalog/volumes': {
          status: 200,
          body: { volumes: [{ name: 'uploads', full_name: 'main.analytics.uploads', volume_type: 'MANAGED' }] },
        },
        '/api/2.0/sql/warehouses': {
          status: 200,
          body: { warehouses: [{ id: 'wh-1', name: 'Analytics', state: 'RUNNING' }] },
        },
        '/api/2.0/serving-endpoints': {
          status: 200,
          body: { endpoints: [] },
        },
        '/api/2.0/vector-search/endpoints': {
          status: 200,
          body: { endpoints: [] },
        },
      }),
    });
    expect(response.available.map((entry) => entry.id)).toEqual([
      'catalog',
      'schema',
      'table',
      'volume',
      'sql-warehouse',
    ]);
    expect(response.available).not.toContainEqual(expect.objectContaining({ id: 'genie-space' }));
    expect(response.unavailable).toContainEqual(
      expect.objectContaining({ rootKind: 'genie-spaces', status: 'denied' })
    );
    expect(response.unavailable).toContainEqual(
      expect.objectContaining({ rootKind: 'serving-endpoints', status: 'empty' })
    );
  });

  it('uses five root calls for a 100 catalog by 100 schema workspace instead of recursively making 20,105', async () => {
    const catalogs = Array.from({ length: 100 }, (_, index) => ({ name: `catalog_${index}` }));
    const routedFetch = fetchFor({
      '/api/2.1/unity-catalog/catalogs': { status: 200, body: { catalogs } },
      '/api/2.0/sql/warehouses': { status: 200, body: { warehouses: [] } },
      '/api/2.0/genie/spaces': { status: 200, body: { spaces: [] } },
      '/api/2.0/serving-endpoints': { status: 200, body: { endpoints: [] } },
      '/api/2.0/vector-search/endpoints': { status: 200, body: { endpoints: [] } },
      // These fixtures document the fan-out that must remain lazy.
      '/api/2.1/unity-catalog/schemas': {
        status: 200,
        body: { schemas: Array.from({ length: 100 }, (_, index) => ({ name: `schema_${index}` })) },
      },
      '/api/2.1/unity-catalog/tables': { status: 200, body: { tables: [{ name: 'must-stay-lazy' }] } },
      '/api/2.1/unity-catalog/volumes': { status: 200, body: { volumes: [{ name: 'must-stay-lazy' }] } },
    });
    const requested: string[] = [];
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      requested.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      return routedFetch(input, init);
    }) as typeof fetch;
    const response = await discoverConnectionTypes({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl,
    });

    expect(requested).toHaveLength(5);
    expect(requested.join('\n')).not.toMatch(/schemas|tables|volumes|indexes/);
    expect(response.available.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['catalog', 'schema', 'table', 'volume'])
    );
    expect(response.discovery).toMatchObject({
      mode: 'lazy',
      root_calls: 5,
      concurrency_limit: DISCOVERY_MAX_CONCURRENCY,
    });
  });

  it('does not fan out across Vector Search endpoints until one is opened', async () => {
    const fetchImpl = fetchFor({
      '/api/2.1/unity-catalog/catalogs': { status: 200, body: { catalogs: [] } },
      '/api/2.0/sql/warehouses': { status: 200, body: { warehouses: [] } },
      '/api/2.0/genie/spaces': { status: 200, body: { spaces: [] } },
      '/api/2.0/serving-endpoints': { status: 200, body: { endpoints: [] } },
      '/api/2.0/vector-search/endpoints': {
        status: 200,
        body: {
          endpoints: Array.from({ length: 100 }, (_, index) => ({ name: `endpoint_${index}` })),
        },
      },
      '/api/2.0/vector-search/indexes': {
        status: 200,
        body: { vector_indexes: [{ name: 'must.stay.lazy' }] },
      },
    });
    const response = await discoverConnectionTypes({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining('/vector-search/indexes'), expect.anything());
    expect(response.available.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['vector-search-endpoint', 'vector-search-index'])
    );
  });

  it('never exceeds the shared discovery concurrency limit', async () => {
    let active = 0;
    let maximum = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const path = String(url);
      const body = path.includes('catalogs')
        ? { catalogs: [{ name: 'main' }] }
        : path.includes('warehouses')
          ? { warehouses: [] }
          : path.includes('genie')
            ? { spaces: [] }
            : { endpoints: [] };
      return { status: 200, json: () => Promise.resolve(body) };
    }) as unknown as typeof fetch;

    await discoverConnectionTypes({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl,
    });

    expect(maximum).toBe(DISCOVERY_MAX_CONCURRENCY);
  });

  it('cancels active calls and does not start queued calls after the request closes', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () =>
              reject(
                init.signal?.reason instanceof Error ? init.signal.reason : new DOMException('Aborted', 'AbortError')
              ),
            { once: true }
          );
        })
    ) as unknown as typeof fetch;
    const pending = discoverConnectionTypes({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const response = await pending;

    expect(fetchImpl).toHaveBeenCalledTimes(DISCOVERY_MAX_CONCURRENCY);
    expect(response.unavailable.every((entry) => entry.status === 'failed')).toBe(true);
  });
});

describe('bounded pagination and per-user page cache', () => {
  it('marks the fifth page partial and refuses a sixth call', async () => {
    const fetchImpl = fetchFor({
      '/api/2.1/unity-catalog/catalogs': {
        status: 200,
        body: { catalogs: [{ name: 'last-loaded' }], next_page_token: 'must-not-be-followed' },
      },
    });
    const fifth = await listCatalogs({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl,
      pageToken: 'page-5',
      page: BROWSE_PAGE_LIMIT,
    });
    expect(fifth).toMatchObject({
      status: 'ok',
      next_page_token: '',
      pagination: { complete: false, incomplete_reason: 'page_cap', page: BROWSE_PAGE_LIMIT },
    });

    const sixth = await listCatalogs({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl,
      pageToken: 'page-6',
      page: BROWSE_PAGE_LIMIT + 1,
    });
    expect(sixth).toMatchObject({ status: 'failed', error: 'page cap reached' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reuses a page only for the same signed-in user and token', async () => {
    resetBrowsePageCache();
    const fetchImpl = fetchFor({
      '/api/2.1/unity-catalog/catalogs': { status: 200, body: { catalogs: [{ name: 'main' }] } },
    });
    const base = {
      host: HOST,
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl,
    };
    await listCatalogs({ ...base, principal: 'alice@example.test', token: tokenWith([...CATALOG_SCOPES]) });
    await listCatalogs({ ...base, principal: 'alice@example.test', token: tokenWith([...CATALOG_SCOPES]) });
    await listCatalogs({ ...base, principal: 'bob@example.test', token: tokenWith([...CATALOG_SCOPES]) });
    await listCatalogs({ ...base, principal: 'alice@example.test', token: tokenWith(['catalog.catalogs:read']) });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not cache a failed page, so retry can recover', async () => {
    resetBrowsePageCache();
    let attempt = 0;
    const fetchImpl = vi.fn(() => {
      attempt += 1;
      return Promise.resolve({
        status: attempt === 1 ? 503 : 200,
        json: () => Promise.resolve(attempt === 1 ? { message: 'busy' } : { catalogs: [{ name: 'main' }] }),
      });
    }) as unknown as typeof fetch;
    const options = {
      host: HOST,
      principal: 'alice@example.test',
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl,
    };
    expect((await listCatalogs(options)).status).toBe('failed');
    expect((await listCatalogs(options)).status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports an initial deadline as incomplete instead of an empty list', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () =>
              reject(
                init.signal?.reason instanceof Error ? init.signal.reason : new DOMException('Aborted', 'AbortError')
              ),
            { once: true }
          );
        })
    ) as unknown as typeof fetch;
    const response = await listCatalogs({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl,
      timeoutMs: 5,
    });
    expect(response).toMatchObject({ status: 'failed', incomplete_reason: 'deadline', error: 'timeout' });
  });
});

describe('listSchemas and listTables drill-down', () => {
  it('lists schemas for a catalog and tables for a schema', async () => {
    const fetchImpl = fetchFor({
      '/api/2.1/unity-catalog/schemas': {
        status: 200,
        body: { schemas: [{ name: 'analytics', full_name: 'main.analytics' }] },
      },
      '/api/2.1/unity-catalog/tables': {
        status: 200,
        body: {
          tables: [{ full_name: 'main.analytics.players', name: 'players', table_type: 'MANAGED' }],
        },
      },
    });
    const schemas = await listSchemas({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      catalog: 'main',
      fetchImpl,
    });
    expect(isBrowseOk(schemas)).toBe(true);
    if (schemas.status === 'ok') {
      // `secondary` carries the two-part name for the `data_catalogs` picker,
      // which stores either a catalog or one `catalog.schema`.
      expect(schemas.items).toEqual([
        { id: 'analytics', label: 'analytics', secondary: 'main.analytics', expandable: false },
      ]);
    }

    const tables = await listTables({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      catalog: 'main',
      schema: 'analytics',
      fetchImpl,
    });
    expect(isBrowseOk(tables)).toBe(true);
    if (tables.status === 'ok') {
      expect(tables.items[0]).toEqual({
        id: 'main.analytics.players',
        label: 'players',
        secondary: 'MANAGED',
        expandable: false,
      });
    }
  });

  it('refuses schema browse without a catalog rather than calling the workspace', async () => {
    const fetchImpl = vi.fn();
    const response = await listSchemas({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      catalog: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(response.status).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('listWarehouses and listGenieSpaces', () => {
  it('returns name plus id for warehouses and Genie spaces', async () => {
    const warehouses = await listWarehouses({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl: fetchFor({
        '/api/2.0/sql/warehouses': {
          status: 200,
          body: {
            warehouses: [{ id: 'wh-1', name: 'Apps warehouse', state: 'RUNNING' }],
          },
        },
      }),
    });
    expect(warehouses).toMatchObject({
      status: 'ok',
      items: [{ id: 'wh-1', label: 'Apps warehouse', secondary: 'RUNNING' }],
    });

    const spaces = await listGenieSpaces({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl: fetchFor({
        '/api/2.0/genie/spaces': {
          status: 200,
          body: {
            spaces: [{ space_id: 'space-1', title: 'Player data' }],
          },
        },
      }),
    });
    expect(spaces).toMatchObject({
      status: 'ok',
      items: [{ id: 'space-1', label: 'Player data' }],
    });
  });
});

describe('listServingEndpoints', () => {
  it('lists every endpoint, reporting the task it serves', async () => {
    const response = await listServingEndpoints({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl: fetchFor({
        '/api/2.0/serving-endpoints': {
          status: 200,
          body: {
            endpoints: [
              { name: 'a-chat-model', task: 'llm/v1/chat', state: { ready: 'READY' } },
              { name: 'an-agent', state: { ready: 'NOT_READY' } },
            ],
          },
        },
      }),
    });
    expect(isBrowseOk(response)).toBe(true);
    if (response.status === 'ok') {
      expect(response.items).toEqual([
        { id: 'a-chat-model', label: 'a-chat-model', secondary: 'llm/v1/chat', expandable: false },
        { id: 'an-agent', label: 'an-agent', secondary: 'NOT_READY', expandable: false },
      ]);
    }
  });

  /**
   * The judge and the foundation model can legitimately name an agent endpoint,
   * so a list that quietly dropped everything without a chat task would hide a
   * valid pick and look like the workspace has fewer endpoints than it has.
   */
  it('does not filter by task', async () => {
    const response = await listServingEndpoints({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl: fetchFor({
        '/api/2.0/serving-endpoints': {
          status: 200,
          body: {
            endpoints: [
              { name: 'embeddings', task: 'llm/v1/embeddings' },
              { name: 'responses', task: 'agent/v1/responses' },
            ],
          },
        },
      }),
    });
    if (response.status !== 'ok') throw new Error(`expected ok, got ${response.status}`);
    expect(response.items.map((item) => item.id)).toEqual(['embeddings', 'responses']);
  });

  it('returns unavailable when the sign-in does not carry the serving scope', async () => {
    const fetchImpl = vi.fn();
    const response = await listServingEndpoints({
      host: HOST,
      token: tokenWith(['sql']),
      declaredScopes: ['sql', 'dashboards.genie'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(isBrowseUnavailable(response)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    if (response.status === 'unavailable') {
      expect(response.scope).toBe('serving.serving-endpoints');
      expect(response.reason).toBe('scope_not_carried');
    }
  });
});

describe('listNotebooks', () => {
  it('lists directories and notebooks under a path', async () => {
    const response = await listNotebooks({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      path: '/Users/someone@example.com',
      fetchImpl: fetchFor({
        '/api/2.0/workspace/list': {
          status: 200,
          body: {
            objects: [
              {
                path: '/Users/someone@example.com/project',
                object_type: 'DIRECTORY',
              },
              {
                path: '/Users/someone@example.com/declare',
                object_type: 'NOTEBOOK',
                language: 'PYTHON',
              },
              {
                path: '/Users/someone@example.com/readme.md',
                object_type: 'FILE',
              },
            ],
          },
        },
      }),
    });
    expect(isBrowseOk(response)).toBe(true);
    if (response.status === 'ok') {
      expect(response.path).toBe('/Users/someone@example.com');
      expect(response.items).toEqual([
        {
          id: '/Users/someone@example.com/project',
          label: 'project',
          secondary: 'Directory',
          expandable: true,
        },
        {
          id: '/Users/someone@example.com/declare',
          label: 'declare',
          secondary: 'PYTHON',
          expandable: false,
        },
      ]);
    }
  });

  it('returns unavailable when the workspace read scope is not declared', async () => {
    const fetchImpl = vi.fn();
    const response = await listNotebooks({
      host: HOST,
      token: tokenWith(['sql']),
      declaredScopes: ['sql', 'dashboards.genie'],
      path: '/Users/someone@example.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(isBrowseUnavailable(response)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    if (response.status === 'unavailable') {
      expect(response.scope).toBe('workspace.workspace:read');
    }
  });
});

describe('validateNotebookPath', () => {
  const path = '/Users/someone@example.com/declare';

  it('accepts only a readable notebook', async () => {
    const result = await validateNotebookPath(path, {
      host: HOST,
      token: tokenWith(['workspace.workspace:read']),
      declaredScopes: ['workspace.workspace:read'],
      fetchImpl: fetchFor({
        [`/api/2.0/workspace/get-status?path=${encodeURIComponent(path)}`]: {
          status: 200,
          body: { path, object_type: 'NOTEBOOK' },
        },
        [`/api/2.0/workspace/export?path=${encodeURIComponent(path)}&format=SOURCE`]: {
          status: 200,
          body: { content: 'cHJpbnQoIm9rIik=' },
        },
      }),
    });
    expect(result).toEqual({ ok: true, path });
  });

  it('rejects folders and unreadable notebooks without saving a guess', async () => {
    const folder = await validateNotebookPath('/Shared/folder', {
      host: HOST,
      token: tokenWith(['workspace.workspace:read']),
      declaredScopes: ['workspace.workspace:read'],
      fetchImpl: fetchFor({
        [`/api/2.0/workspace/get-status?path=${encodeURIComponent('/Shared/folder')}`]: {
          status: 200,
          body: { path: '/Shared/folder', object_type: 'DIRECTORY' },
        },
      }),
    });
    expect(folder).toMatchObject({ ok: false, status: 400 });

    const denied = await validateNotebookPath(path, {
      host: HOST,
      token: tokenWith(['workspace.workspace:read']),
      declaredScopes: ['workspace.workspace:read'],
      fetchImpl: fetchFor({
        [`/api/2.0/workspace/get-status?path=${encodeURIComponent(path)}`]: {
          status: 200,
          body: { path, object_type: 'NOTEBOOK' },
        },
        [`/api/2.0/workspace/export?path=${encodeURIComponent(path)}&format=SOURCE`]: {
          status: 403,
          body: { error_code: 'PERMISSION_DENIED' },
        },
      }),
    });
    expect(denied).toMatchObject({ ok: false, status: 403 });
  });
});

describe('listVolumes', () => {
  it('lists volumes under a catalog.schema and stores the leaf name', async () => {
    const response = await listVolumes({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      catalog: 'main',
      schema: 'assets',
      fetchImpl: fetchFor({
        '/api/2.1/unity-catalog/volumes': {
          status: 200,
          body: {
            volumes: [
              {
                name: 'player_insights_assets',
                full_name: 'main.assets.player_insights_assets',
                volume_type: 'MANAGED',
              },
            ],
          },
        },
      }),
    });
    expect(isBrowseOk(response)).toBe(true);
    if (response.status === 'ok') {
      expect(response.items).toEqual([
        {
          id: 'player_insights_assets',
          label: 'player_insights_assets',
          secondary: 'MANAGED',
          expandable: false,
        },
      ]);
    }
  });

  it('refuses when catalog schemas browse is blocked, without inventing a volumes scope', async () => {
    const fetchImpl = vi.fn();
    const response = await listVolumes({
      host: HOST,
      token: tokenWith(['sql']),
      declaredScopes: ['sql', 'dashboards.genie'],
      catalog: 'main',
      schema: 'assets',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(isBrowseUnavailable(response)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    if (response.status === 'unavailable') {
      expect(response.scope).toBe('catalog.schemas:read');
    }
  });
});

describe('Vector Search browse', () => {
  it('lists endpoints and indexes under an endpoint', async () => {
    const endpoints = await listVectorSearchEndpoints({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl: fetchFor({
        '/api/2.0/vector-search/endpoints': {
          status: 200,
          body: {
            endpoints: [
              {
                name: 'player-vs',
                num_indexes: 2,
                endpoint_status: { state: 'ONLINE' },
              },
            ],
          },
        },
      }),
    });
    expect(isBrowseOk(endpoints)).toBe(true);
    if (endpoints.status === 'ok') {
      expect(endpoints.items[0]).toEqual({
        id: 'player-vs',
        label: 'player-vs',
        secondary: 'ONLINE, 2 indexes',
        expandable: false,
      });
    }

    const indexes = await listVectorSearchIndexes({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      endpoint: 'player-vs',
      fetchImpl: fetchFor({
        '/api/2.0/vector-search/indexes': {
          status: 200,
          body: {
            vector_indexes: [
              {
                name: 'main.player.semantic_layer_index',
                index_type: 'DELTA_SYNC',
                endpoint_name: 'player-vs',
              },
            ],
          },
        },
      }),
    });
    expect(isBrowseOk(indexes)).toBe(true);
    if (indexes.status === 'ok') {
      expect(indexes.items[0]).toEqual({
        id: 'main.player.semantic_layer_index',
        label: 'semantic_layer_index',
        secondary: 'DELTA_SYNC',
        expandable: false,
      });
    }
  });

  it('returns unavailable when the VS endpoint scope is not carried', async () => {
    const fetchImpl = vi.fn();
    const response = await listVectorSearchEndpoints({
      host: HOST,
      token: tokenWith(['sql']),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(isBrowseUnavailable(response)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    if (response.status === 'unavailable') {
      expect(response.scope).toBe('vectorsearch.vector-search-endpoints:read');
    }
  });
});

describe('Lakebase browse', () => {
  it('prefixes a bare project id for the branches parent', () => {
    expect(lakebaseProjectParent('demo')).toBe('projects/demo');
    expect(lakebaseProjectParent('projects/demo')).toBe('projects/demo');
  });

  it('lists projects and databases under a branch', async () => {
    const projects = await listLakebaseProjects({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl: fetchFor({
        '/api/2.0/postgres/projects': {
          status: 200,
          body: {
            projects: [
              {
                name: 'projects/demo',
                status: { display_name: 'Demo DB' },
              },
            ],
          },
        },
      }),
    });
    expect(isBrowseOk(projects)).toBe(true);
    if (projects.status === 'ok') {
      expect(projects.items[0]).toEqual({
        id: 'projects/demo',
        label: 'Demo DB',
        secondary: 'demo',
        expandable: false,
      });
    }

    const databases = await listLakebaseDatabases({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      branch: 'projects/demo/branches/production',
      fetchImpl: fetchFor({
        '/api/2.0/postgres/projects/demo/branches/production/databases': {
          status: 200,
          body: {
            databases: [
              {
                name: 'projects/demo/branches/production/databases/databricks-postgres',
              },
            ],
          },
        },
      }),
    });
    expect(isBrowseOk(databases)).toBe(true);
    if (databases.status === 'ok') {
      expect(databases.items[0].id).toBe('projects/demo/branches/production/databases/databricks-postgres');
      expect(databases.items[0].label).toBe('databricks-postgres');
    }
  });

  it('returns unavailable when postgres is not declared', async () => {
    const fetchImpl = vi.fn();
    const response = await listLakebaseProjects({
      host: HOST,
      token: tokenWith(['sql']),
      declaredScopes: ['sql', 'dashboards.genie'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(isBrowseUnavailable(response)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    if (response.status === 'unavailable') {
      expect(response.scope).toBe('postgres');
    }
  });
});

describe('listExperiments', () => {
  it('is always unavailable because Apps has no MLflow scope', async () => {
    const fetchImpl = vi.fn();
    const response = await listExperiments({
      host: HOST,
      token: tokenWith([...CATALOG_SCOPES]),
      declaredScopes: [...CATALOG_SCOPES],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(isBrowseUnavailable(response)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    if (response.status === 'unavailable') {
      expect(response.reason).toBe('apps_has_no_scope');
      expect(response.scope).toBe('');
      expect(response.detail).toContain('MLflow');
    }
  });
});
