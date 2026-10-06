import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cachedOrganizationProfiles,
  currentOrganizationMappings,
  resetOrganizationProfileCache,
} from '../lib/organization-profiles';
import { organizationForEmail } from '../../shared/organization-mapping';
import { setupOrganizationRoutes } from './organization-routes';
import type { InsightsAppKit } from './insights-routes';

type Handler = (req: unknown, res: unknown) => Promise<void> | void;

function memoryStore() {
  const rows = new Map<
    string,
    { domain: string; name: string; monogram: string; updated_by: string; updated_at: Date }
  >();
  const audit: unknown[][] = [];
  let failing = false;
  return {
    rows,
    audit,
    fail(value: boolean) {
      failing = value;
    },
    query(text: string, params: unknown[] = []) {
      if (failing && /organization_profiles/.test(text)) return Promise.reject(new Error('lakebase down'));
      return Promise.resolve(run(text, params));
    },
  };

  function run(text: string, params: unknown[]) {
    {
      if (/INSERT INTO .*organization_profiles/.test(text)) {
        const [domain, name, monogram, by] = params as string[];
        rows.set(domain, { domain, name, monogram, updated_by: by, updated_at: new Date() });
        return { rows: [] };
      }
      if (/DELETE FROM .*organization_profiles/.test(text)) {
        rows.delete(params[0] as string);
        return { rows: [] };
      }
      if (/SELECT .* FROM .*organization_profiles/.test(text)) return { rows: [...rows.values()] };
      if (/admin_audit/.test(text)) audit.push(params);
      return { rows: [] };
    }
  }
}

function mount(store: ReturnType<typeof memoryStore>) {
  const handlers = new Map<string, Handler>();
  const app = {
    get: (path: string, handler: Handler) => handlers.set(`GET ${path}`, handler),
    put: (path: string, handler: Handler) => handlers.set(`PUT ${path}`, handler),
    delete: (path: string, handler: Handler) => handlers.set(`DELETE ${path}`, handler),
  };
  setupOrganizationRoutes({
    lakebase: store,
    server: { extend: (register: (target: typeof app) => void) => register(app) },
  } as unknown as InsightsAppKit);

  async function call(method: string, path: string, req: { body?: unknown; params?: Record<string, string> } = {}) {
    const handler = handlers.get(`${method} ${path}`);
    if (!handler) throw new Error(`no handler for ${method} ${path}`);
    let status = 200;
    let body: unknown;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json(value: unknown) {
        body = value;
        return res;
      },
    };
    await handler(
      {
        header: (name: string) => (name === 'x-forwarded-email' ? 'admin@example.com' : undefined),
        params: {},
        body: undefined,
        ...req,
      },
      res
    );
    return { status, body: body as Record<string, unknown> & { organizations?: Array<Record<string, unknown>> } };
  }
  return call;
}

describe('organization profile routes', () => {
  beforeEach(() => {
    resetOrganizationProfileCache();
    delete process.env.PLAYER_INSIGHTS_ORGANIZATIONS;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists built-in organizations with their logo and no edit', async () => {
    const call = mount(memoryStore());
    const { status, body } = await call('GET', '/api/admin/organizations');
    expect(status).toBe(200);
    const take = body.organizations?.find((row) => row.domain === 'take2games.com');
    expect(take).toMatchObject({
      source: 'built-in',
      customized: false,
      logoKey: 'acme',
      name: 'Take-Two Interactive',
    });
  });

  it('renames a built-in organization by domain, keeps its logo, and resets it', async () => {
    const store = memoryStore();
    const call = mount(store);
    const saved = await call('PUT', '/api/admin/organizations', {
      body: { domain: '@example.com', name: '  Databricks   Inc ' },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.organizations?.find((row) => row.domain === 'databricks.com')).toMatchObject({
      name: 'Databricks Inc',
      monogram: 'DB',
      logoKey: 'databricks',
      customized: true,
      defaultName: 'Databricks',
      source: 'built-in',
    });
    expect(organizationForEmail('a@labs.databricks.com', currentOrganizationMappings())).toMatchObject({
      id: 'databricks',
      name: 'Databricks Inc',
      logoKey: 'databricks',
    });
    expect(store.audit).toHaveLength(1);

    const reset = await call('DELETE', '/api/admin/organizations/:domain', { params: { domain: 'databricks.com' } });
    expect(reset.status).toBe(200);
    expect(reset.body.organizations?.find((row) => row.domain === 'databricks.com')).toMatchObject({
      name: 'Databricks',
      customized: false,
    });
    expect(cachedOrganizationProfiles()).toEqual([]);
  });

  it('adds an organization for an unknown domain and removes it again', async () => {
    const call = mount(memoryStore());
    const saved = await call('PUT', '/api/admin/organizations', {
      body: { domain: 'studio2games.example', name: 'Studio Two', monogram: 'st' },
    });
    expect(saved.body.organizations?.[saved.body.organizations.length - 1]).toMatchObject({
      domain: 'studio2games.example',
      name: 'Studio Two',
      monogram: 'ST',
      source: 'admin',
      customized: true,
    });
    expect(organizationForEmail('x@north.studio2games.example', currentOrganizationMappings()).name).toBe('Studio Two');
    const removed = await call('DELETE', '/api/admin/organizations/:domain', {
      params: { domain: 'studio2games.example' },
    });
    expect(removed.body.organizations?.some((row) => row.domain === 'studio2games.example')).toBe(false);
  });

  it('replaces a second edit of the same organization rather than stacking it', async () => {
    const store = memoryStore();
    const call = mount(store);
    await call('PUT', '/api/admin/organizations', { body: { domain: 'northwindlondon.com', name: 'Studio London' } });
    await call('PUT', '/api/admin/organizations', { body: { domain: 'northwindgames.com', name: 'Studio Games' } });
    expect([...store.rows.keys()]).toEqual(['northwindgames.com']);
  });

  it.each([
    [{ domain: 'not a domain', name: 'X' }, 'invalid_organization_domain'],
    [{ domain: 'example.com', name: '   ' }, 'invalid_organization_name'],
    [{ domain: 'example.com', name: '<b>x</b>' }, 'invalid_organization_name'],
    [{ domain: 'example.com', name: 'X', monogram: 'TOOLONG' }, 'invalid_organization_monogram'],
    [{ domain: 'example.com', name: 'X', monogram: 'a b' }, 'invalid_organization_monogram'],
    [{ domain: 'example.com', name: 'X', extra: 1 }, 'invalid_organization'],
  ])('refuses %j', async (body, error) => {
    const store = memoryStore();
    const call = mount(store);
    const response = await call('PUT', '/api/admin/organizations', { body });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe(error);
    expect(store.rows.size).toBe(0);
  });

  it('answers 404 when resetting a domain nobody edited', async () => {
    const call = mount(memoryStore());
    const response = await call('DELETE', '/api/admin/organizations/:domain', { params: { domain: 'databricks.com' } });
    expect(response.status).toBe(404);
  });

  it('reports an unavailable store instead of pretending the save happened', async () => {
    const store = memoryStore();
    store.fail(true);
    const call = mount(store);
    const response = await call('PUT', '/api/admin/organizations', {
      body: { domain: 'example.com', name: 'Example' },
    });
    expect(response.status).toBe(503);
    expect(cachedOrganizationProfiles()).toEqual([]);
  });
});
