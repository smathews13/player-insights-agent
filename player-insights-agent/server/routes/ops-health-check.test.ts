import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Application, Request, Response as ExpressResponse } from 'express';

import { HEALTH_CHECK_CONCURRENCY, forgetWorkspaceId, setupOpsRoutes } from './ops-routes';
import type { InsightsAppKit, PreflightConfiguration, PreflightReport } from './insights-routes';
import type { OpsHealthPayload } from '../../shared/ops-contract';

function configuration(key: string, value: unknown): PreflightConfiguration {
  return { key, value, env_var: '', source: 'artifact', mutability: 'baked', baked: true, required: false };
}

const REPORT: PreflightReport = {
  checked_at: '2026-09-03T12:00:00Z',
  status: 'ok',
  principal: 'app',
  principal_resolved: true,
  table_source: 'release',
  build_sha: 'abc',
  configuration: [
    configuration('llm_endpoint', 'foundation-model'),
    configuration('data_genie_space_id', 'data-space'),
    configuration('dictionary_genie_space_id', 'dictionary-space'),
    configuration('warehouse_id', 'warehouse-id'),
    configuration('catalog', 'catalog'),
    configuration('schema', 'schema'),
    configuration('semantic_index', 'catalog.schema.index'),
    configuration('declared_manifest', ['catalog.schema.one', 'catalog.schema.two']),
  ],
  checks: [],
  assumptions: [],
  counts: { ok: 0, failed: 0, unverified: 0 },
  source: 'configuration',
};

type Handler = (req: Request, res: ExpressResponse) => Promise<void>;

function request(): Request {
  const headers: Record<string, string> = {
    'x-forwarded-email': 'operator@example.test',
    'x-forwarded-access-token': 'user-token',
  };
  return {
    query: {},
    headers,
    header: (name: string) => headers[name.toLowerCase()],
  } as Request;
}

async function invoke(handler: Handler): Promise<{ status: number; body: unknown }> {
  let status = 200;
  let body: unknown;
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as ExpressResponse;
  await handler(request(), response);
  return { status, body };
}

function harness(role = 'admin', gate?: Promise<void>, healthCheckTotalTimeoutMs?: number) {
  const get = new Map<string, Handler>();
  const post = new Map<string, Handler>();
  const app = {
    get: (path: string, handler: Handler) => get.set(path, handler),
    post: (path: string, handler: Handler) => post.set(path, handler),
  };
  let inFlight = 0;
  let peak = 0;
  const probePaths: string[] = [];
  const audit: unknown[][] = [];
  let activeGate = gate;
  const fetchImpl: typeof fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/2.0/preview/scim/v2/Me')) {
      return {
        status: 200,
        ok: true,
        headers: new Headers(),
        json: () => Promise.resolve({}),
      } as globalThis.Response;
    }
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    probePaths.push(new URL(url).pathname);
    if (activeGate) await activeGate;
    inFlight -= 1;
    const path = new URL(url).pathname;
    const refused = path.endsWith('/genie/spaces/dictionary-space');
    const body = refused
      ? { message: 'Provided OAuth token does not have required scopes: dashboards.genie' }
      : path.includes('/vector-search/indexes/')
        ? { name: 'catalog.schema.index', endpoint_name: 'vector-endpoint' }
        : path.includes('/vector-search/endpoints/')
          ? { endpoint_status: { state: 'ONLINE' } }
          : path.includes('/serving-endpoints/')
            ? { state: { ready: 'READY' } }
            : path.includes('/sql/warehouses/')
              ? { state: 'RUNNING' }
              : {};
    return {
      status: refused ? 403 : 200,
      ok: !refused,
      headers: new Headers(),
      json: () => Promise.resolve(body),
    } as globalThis.Response;
  });
  const query = vi.fn((sql: string, params: unknown[] = []) => {
    if (sql.includes('admin_audit')) audit.push(params);
    return Promise.resolve({ rows: [] });
  });
  setupOpsRoutes(
    {
      lakebase: { query },
      server: { extend: (register: (target: Application) => void) => register(app as never) },
    } as InsightsAppKit,
    {
      isAdminRoute: () => true,
      fetchImpl,
      readOrchestratorReport: () => Promise.resolve({ report: REPORT }),
      healthCheckRole: () => Promise.resolve(role),
      healthCheckTotalTimeoutMs,
      now: () => Date.parse('2026-09-03T15:00:00Z'),
    }
  );
  return {
    get,
    post,
    fetchImpl,
    probePaths,
    audit,
    peak: () => peak,
    setGate: (next?: Promise<void>) => {
      activeGate = next;
    },
  };
}

beforeEach(() => {
  process.env.DATABRICKS_HOST = 'https://workspace.example';
  process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'orchestrator';
  forgetWorkspaceId();
});

afterEach(() => {
  delete process.env.DATABRICKS_HOST;
  delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
  vi.restoreAllMocks();
});

describe('POST /api/ops/health/check', () => {
  it.each([
    ['admin', 200],
    ['owner', 200],
    ['super_admin', 200],
    ['consumer', 403],
  ])('independently enforces the shared capability for %s', async (role, expected) => {
    const routes = harness(role);
    const answer = await invoke(routes.post.get('/api/ops/health/check')!);
    expect(answer.status).toBe(expected);
    if (role === 'consumer') {
      expect(answer.body).toMatchObject({ error: 'admin_role_required' });
      expect(routes.probePaths).toEqual([]);
    }
  });

  it('returns the canonical registry rows with one checkedAt and a safe audit record', async () => {
    const routes = harness();
    const answer = await invoke(routes.post.get('/api/ops/health/check')!);
    const payload = answer.body as OpsHealthPayload;
    expect(payload.checkedAt).toBe('2026-09-03T15:00:00.000Z');
    expect(new Set(payload.dependencies.map((row) => row.lastCheckedAt).filter(Boolean))).toEqual(
      new Set([payload.checkedAt])
    );
    expect(payload.dependencies.map((row) => row.id)).toEqual([
      'sql-warehouse',
      'genie-data',
      'genie-dictionary',
      'catalog',
      'schema',
      'table:catalog.schema.one',
      'table:catalog.schema.two',
      'agent-endpoint',
      'llm-endpoint',
      'judge-endpoint',
      'semantic-index',
      'semantic-index-endpoint',
      'declared-manifest',
      'experiment-id',
    ]);
    expect(payload.dependencies.find((row) => row.id === 'experiment-id')?.label).toBe('MLflow experiment');
    expect(payload.dependencies.find((row) => row.id === 'genie-dictionary')).toMatchObject({
      verdict: 'refused',
      lastCheckedAt: payload.checkedAt,
    });
    expect(payload.dependencies.find((row) => row.id === 'sql-warehouse')?.verdict).toBe('reachable');
    expect(routes.audit).toHaveLength(1);
    expect(routes.audit[0].join(' ')).toContain('health-resources-checked ops-health');
    expect(routes.audit[0].join(' ')).not.toMatch(/token|https:|error/i);
  });

  it('serves ordinary GET refreshes from cache but bypasses it for the manual POST', async () => {
    const routes = harness();
    const health = routes.get.get('/api/ops/health')!;
    await invoke(health);
    const afterFirst = routes.probePaths.length;
    await invoke(health);
    expect(routes.probePaths).toHaveLength(afterFirst);
    await invoke(routes.post.get('/api/ops/health/check')!);
    expect(routes.probePaths.length).toBeGreaterThan(afterFirst);
  });

  it('bounds concurrency and deduplicates simultaneous manual requests', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const routes = harness('admin', gate);
    const handler = routes.post.get('/api/ops/health/check')!;
    const first = invoke(handler);
    const second = invoke(handler);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(routes.peak()).toBeLessThanOrEqual(HEALTH_CHECK_CONCURRENCY);
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.body).toEqual(two.body);
    expect(routes.audit).toHaveLength(1);
    const uniqueProbeCount = new Set(routes.probePaths).size;
    expect(routes.probePaths.length).toBe(uniqueProbeCount + 1);
  });

  it('keeps the cached rows when a forced run misses its total deadline', async () => {
    const routes = harness('admin', undefined, 5);
    const before = (await invoke(routes.get.get('/api/ops/health')!)).body as OpsHealthPayload;
    routes.setGate(new Promise<void>(() => {}));
    const failed = await invoke(routes.post.get('/api/ops/health/check')!);
    expect(failed).toMatchObject({
      status: 503,
      body: { error: 'health_check_unavailable' },
    });
    const after = (await invoke(routes.get.get('/api/ops/health')!)).body as OpsHealthPayload;
    expect(after).toEqual(before);
  });
});
