import { describe, expect, it, vi } from 'vitest';

import {
  browseBlockedByScope,
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
  validateNotebookPath,
} from './browse-assets';
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
  return vi.fn(async (url: string) => {
    const path = String(url).replace(HOST, '');
    const key = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    if (!key) {
      return {
        status: 404,
        json: async () => ({ error_code: 'NOT_FOUND', message: path }),
      };
    }
    const hit = routes[key];
    return { status: hit.status, json: async () => hit.body };
  }) as unknown as typeof fetch;
}

describe('browseBlockedByScope', () => {
  it('blocks catalog browse when the token lacks the catalog scope', () => {
    expect(
      browseBlockedByScope({
        apiPath: '/api/2.1/unity-catalog/catalogs',
        token: tokenWith(['sql', 'dashboards.genie']),
        declaredScopes: [...CATALOG_SCOPES],
      }),
    ).toBe('catalog.catalogs:read');
  });

  it('blocks when the app does not declare the scope at all', () => {
    expect(
      browseBlockedByScope({
        apiPath: '/api/2.0/workspace/list',
        token: tokenWith(['sql', 'dashboards.genie']),
        declaredScopes: ['sql', 'dashboards.genie'],
      }),
    ).toBe('workspace.workspace:read');
  });

  it('does not block when the token carries the scope', () => {
    expect(
      browseBlockedByScope({
        apiPath: '/api/2.1/unity-catalog/catalogs',
        token: tokenWith(['unity-catalog']),
        declaredScopes: [...CATALOG_SCOPES],
      }),
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
      itemsFromBody: () => ({ items: [{ id: 'x', label: 'x', secondary: '', expandable: false }], next_page_token: '' }),
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
      expect(databases.items[0].id).toBe(
        'projects/demo/branches/production/databases/databricks-postgres',
      );
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
