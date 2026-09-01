import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_GATEWAY_PAGE_CAP,
  AI_GATEWAY_REVISION_RESOURCE,
  discoverAiGatewayCandidates,
  gatewayWorkspaceGet,
  resetAiGatewayCache,
  stageAiGatewaySelection,
  summarizeAiGateway,
  validateAiGatewayCandidate,
} from './ai-gateway';
import type { StoredSetting } from './app-settings';
import { isAdminRoute } from './admin-roles';

const OPTIONS = {
  host: 'https://workspace.example',
  token: 'opaque-user-token',
  principal: 'admin@example.test',
};

beforeEach(() => resetAiGatewayCache());

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function routeFetch(routes: Record<string, Response | (() => Response)>): typeof fetch {
  return vi.fn((input: string | URL | Request) => {
    const url = new URL(requestUrl(input));
    const route = routes[`${url.pathname}${url.search}`] ?? routes[url.pathname];
    if (!route) return Promise.resolve(json({ error_code: 'NOT_FOUND' }, 404));
    return Promise.resolve(typeof route === 'function' ? route() : route.clone());
  }) as typeof fetch;
}

describe('AI Gateway discovery', () => {
  it('returns only eligible model services and Gateway-enabled foundation endpoints', async () => {
    const fetchImpl = routeFetch({
      '/api/2.1/unity-catalog/model-services': json({
        model_services: [
          {
            full_name: 'main.ai.routed-model',
            display_name: 'Routed model',
            status: 'READY',
            config: {
              routing: { routes: [{}] },
              rate_limits: [{ calls: 10 }],
              inference_table: { enabled: true },
              budget_policy: { action: 'BLOCK_USAGE' },
              credential: 'must-not-leak',
            },
          },
        ],
      }),
      '/api/2.0/serving-endpoints': json({
        endpoints: [{ name: 'legacy-fm' }, { name: 'custom-agent' }],
      }),
      '/api/2.0/serving-endpoints/legacy-fm': json({
        name: 'legacy-fm',
        endpoint_type: 'FOUNDATION_MODEL_API',
        state: { ready: 'READY', config_update: 'NOT_UPDATING' },
        ai_gateway: {
          usage_tracking_config: { enabled: true },
          guardrails: { pii: true },
          fallback_config: { endpoint: 'fallback' },
          api_token: 'must-not-leak',
        },
      }),
      '/api/2.0/serving-endpoints/custom-agent': json({
        name: 'custom-agent',
        endpoint_type: 'CUSTOM_MODEL',
        state: { ready: 'READY' },
        ai_gateway: { rate_limits: [{}] },
      }),
    });
    const result = await discoverAiGatewayCandidates({
      mode: 'mlflow',
      query: '',
      options: { ...OPTIONS, fetchImpl },
    });

    expect(result.status).toBe('ok');
    expect(result.items.map((item) => item.id)).toEqual(['main.ai.routed-model', 'legacy-fm']);
    expect(result.items[0].capabilities).toMatchObject({
      rateLimits: true,
      budgetEnforcement: true,
      inferenceTable: true,
      routingFallback: true,
    });
    expect(result.items[1].capabilities).toMatchObject({
      usageTracking: true,
      guardrails: true,
      routingFallback: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/credential|api_token|must-not-leak/);
    const modelServiceCall = vi
      .mocked(fetchImpl)
      .mock.calls.find(([input]) => requestUrl(input).includes('/api/2.1/unity-catalog/model-services'));
    expect(modelServiceCall).toBeDefined();
    expect(modelServiceCall?.[1]?.method).toBe('GET');
    expect(new Headers(modelServiceCall?.[1]?.headers).get('authorization')).toBe('Bearer opaque-user-token');
  });

  it('stops paged discovery at the fixed cap', async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = new URL(requestUrl(input));
      if (url.pathname.includes('model-services')) {
        return Promise.resolve(
          json({
            model_services: [
              { full_name: `main.ai.model-${url.searchParams.get('page_token') || '1'}`, status: 'READY' },
            ],
            next_page_token: String(Number(url.searchParams.get('page_token') || '1') + 1),
          })
        );
      }
      return Promise.resolve(json({ endpoints: [] }));
    });
    const fetchImpl = fetchMock as typeof fetch;
    const result = await discoverAiGatewayCandidates({
      mode: 'mlflow',
      query: '',
      options: { ...OPTIONS, fetchImpl },
    });
    expect(result.pagination.capped).toBe(true);
    expect(result.pagination.pagesRead).toBe(AI_GATEWAY_PAGE_CAP + 1);
    expect(fetchMock.mock.calls.filter(([url]) => requestUrl(url).includes('model-services'))).toHaveLength(
      AI_GATEWAY_PAGE_CAP
    );
  });

  it.each([
    [403, 'permission-blocked'],
    [500, 'unavailable'],
  ] as const)('maps upstream HTTP %s without pretending the list is empty', async (status, expected) => {
    const fetchImpl = routeFetch({
      '/api/2.1/unity-catalog/model-services': json({ message: 'no' }, status),
      '/api/2.0/serving-endpoints': json({ endpoints: [] }),
    });
    const result = await discoverAiGatewayCandidates({
      mode: 'mlflow',
      query: '',
      options: { ...OPTIONS, fetchImpl },
    });
    expect(result.status).toBe(expected);
    expect(result.items).toEqual([]);
  });

  it('reports malformed and cancelled upstream calls as unavailable', async () => {
    const malformed = vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))) as typeof fetch;
    const bad = await discoverAiGatewayCandidates({
      mode: '',
      query: '',
      options: { ...OPTIONS, fetchImpl: malformed },
    });
    expect(bad.status).toBe('unavailable');
    expect(bad.detail).toMatch(/malformed/i);

    const cancelled = vi.fn(() => Promise.reject(new DOMException('cancelled', 'AbortError'))) as typeof fetch;
    const stopped = await discoverAiGatewayCandidates({
      mode: '',
      query: '',
      options: { ...OPTIONS, fetchImpl: cancelled },
    });
    expect(stopped.status).toBe('unavailable');
  });

  it('refuses non-allowlisted workspace paths before sending a request', async () => {
    const fetchImpl = vi.fn();
    await expect(gatewayWorkspaceGet('/api/2.0/token/create', {}, { ...OPTIONS, fetchImpl })).rejects.toThrow(
      /allowlist/
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('AI Gateway validation and staging', () => {
  it('keeps discovery, validation, staging, and release gates behind admin authorization', () => {
    for (const path of [
      '/api/admin/ai-gateway/summary',
      '/api/admin/ai-gateway/candidates',
      '/api/admin/ai-gateway/validate',
      '/api/admin/ai-gateway/stage',
      '/api/admin/ai-gateway/releases/release-1/validate',
    ]) {
      expect(isAdminRoute(path), path).toBe(true);
    }
    const settingsRoutes = readFileSync(new URL('../routes/settings-routes.ts', import.meta.url), 'utf8');
    expect(settingsRoutes).toContain("resourceId === 'llm-gateway'");
    expect(settingsRoutes).toContain('atomic_gateway_selection_required');
  });

  it('returns precise invalid, unavailable, and permission-blocked states', async () => {
    const invalid = await validateAiGatewayCandidate({
      mode: 'openai',
      candidateId: 'legacy',
      options: {
        ...OPTIONS,
        fetchImpl: routeFetch({
          '/api/2.0/serving-endpoints/legacy': json({
            name: 'legacy',
            endpoint_type: 'FOUNDATION_MODEL_API',
            state: { ready: 'READY' },
            ai_gateway: { rate_limits: [{}] },
          }),
        }),
      },
    });
    expect(invalid.state).toBe('invalid');

    const unavailable = await validateAiGatewayCandidate({
      mode: 'mlflow',
      candidateId: 'main.ai.cold',
      options: {
        ...OPTIONS,
        fetchImpl: routeFetch({
          '/api/2.1/unity-catalog/model-services/main.ai.cold': json({
            full_name: 'main.ai.cold',
            status: 'PROVISIONING',
            config: {},
          }),
        }),
      },
    });
    expect(unavailable).toMatchObject({ state: 'unavailable', candidate: { ready: false } });

    const denied = await validateAiGatewayCandidate({
      mode: 'mlflow',
      candidateId: 'main.ai.hidden',
      options: {
        ...OPTIONS,
        fetchImpl: routeFetch({
          '/api/2.1/unity-catalog/model-services/main.ai.hidden': json({}, 403),
          '/api/2.0/serving-endpoints/main.ai.hidden': json({}, 403),
        }),
      },
    });
    expect(denied.state).toBe('permission-blocked');
  });

  it('atomically writes the pair and opaque revision, including Direct clearing', async () => {
    const query = vi.fn((_sql: string, params?: unknown[]) =>
      Promise.resolve({
        rows: [
          { resource_id: 'llm-gateway', updated_at: new Date('2026-09-01T12:00:00Z') },
          { resource_id: 'llm-endpoint', updated_at: new Date('2026-09-01T12:00:00Z') },
          { resource_id: AI_GATEWAY_REVISION_RESOURCE, updated_at: new Date('2026-09-01T12:00:00Z') },
        ],
        params,
      })
    );
    const result = await stageAiGatewaySelection({
      store: { lakebase: { query } },
      mode: '',
      candidateId: 'databricks-gpt-5',
      expectedRevision: '0',
      actor: 'admin@example.test',
      validation: {
        state: 'validated',
        detail: 'ok',
        validatedAt: '2026-09-01T11:59:59Z',
        candidate: null,
        etag: '"opaque-etag"',
      },
    });
    expect(result.ok).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/pg_advisory_xact_lock/);
    expect(sql).toMatch(/'llm-gateway'[\s\S]*'llm-endpoint'/);
    expect(params?.[3]).toBe('');
    expect(params?.[4]).toBe('databricks-gpt-5');
    expect(JSON.stringify(params)).toContain('opaque-etag');
  });

  it('refuses a stale concurrent revision without a partial success', async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [] }));
    const result = await stageAiGatewaySelection({
      store: { lakebase: { query } },
      mode: 'mlflow',
      candidateId: 'main.ai.service',
      expectedRevision: 'stale',
      actor: 'admin@example.test',
      validation: {
        state: 'validated',
        detail: 'ok',
        validatedAt: '2026-09-01T12:00:00Z',
        candidate: null,
      },
    });
    expect(result).toEqual({ ok: false, reason: 'stale' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('keeps an empty route neutral and represents a coherent staged pair', () => {
    const empty = summarizeAiGateway({ activeMode: '', activeModel: 'direct-model', stored: new Map() });
    expect(empty).toMatchObject({
      active: { transport: 'Direct' },
      staged: null,
      configurationState: 'active',
    });

    const revision = 'revision-1';
    const note = JSON.stringify({
      mode: 'openai',
      candidateId: 'main.ai.routed',
      validatedAt: '2026-09-01T12:00:00Z',
      etag: 'secret-server-only',
      revision,
    });
    const setting = (resourceId: string, value: string, storedNote = note): StoredSetting => ({
      resourceId,
      value,
      intent: 'intended',
      note: storedNote,
      updatedAt: '2026-09-01T12:00:00Z',
      updatedBy: 'admin@example.test',
    });
    const stored = new Map([
      ['llm-gateway', setting('llm-gateway', 'openai')],
      ['llm-endpoint', setting('llm-endpoint', 'main.ai.routed')],
      [AI_GATEWAY_REVISION_RESOURCE, setting(AI_GATEWAY_REVISION_RESOURCE, revision, '')],
    ]);
    const summary = summarizeAiGateway({ activeMode: '', activeModel: 'direct-model', stored });
    expect(summary.staged).toMatchObject({ mode: 'openai', model: 'main.ai.routed' });
    expect(JSON.stringify(summary)).not.toContain('secret-server-only');
  });
});
