import { createHash, randomUUID } from 'node:crypto';
import {
  EMPTY_AI_GATEWAY_CAPABILITIES,
  gatewayTransport,
  type AiGatewayCandidate,
  type AiGatewayCapabilities,
  type AiGatewayDiscovery,
  type AiGatewayMode,
  type AiGatewaySummary,
  type AiGatewayValidation,
  type EnforcementSource,
} from '../../shared/ai-gateway-contract';
import { APP_SCHEMA } from '../../shared/app-schema';
import { scopesFromToken } from '../routes/access-verification';
import { tokenScopeVerdict } from '../../shared/token-scopes';
import type { StoredSetting } from './app-settings';
import { forgetStoredSettings } from './app-settings';
import { DiscoveryPageCache, discoveryLimiter } from './discovery-control';
import type { LakebaseReader } from './lakebase-store';

export const AI_GATEWAY_TIMEOUT_MS = 10_000;
export const AI_GATEWAY_PAGE_SIZE = 50;
export const AI_GATEWAY_PAGE_CAP = 5;
export const AI_GATEWAY_RESULT_CAP = 100;
export const AI_GATEWAY_REVISION_RESOURCE = 'ai-gateway-revision';

const MODEL_SERVICES_PATH = '/api/2.1/unity-catalog/model-services';
const SERVING_ENDPOINTS_PATH = '/api/2.0/serving-endpoints';
const ALLOWED_PATHS = [
  /^\/api\/2\.1\/unity-catalog\/model-services(?:\/[^/?]+)?$/,
  /^\/api\/2\.0\/serving-endpoints(?:\/[^/?]+)?$/,
];

interface WorkspaceAnswer {
  status: number;
  body: Record<string, unknown>;
  etag: string;
}

export interface AiGatewayWorkspaceOptions {
  host: string;
  token: string;
  principal: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cache?: boolean;
}

const pageCache = new DiscoveryPageCache<WorkspaceAnswer>();

export function resetAiGatewayCache(): void {
  pageCache.clear();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function present(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(text(value));
}

function cacheKey(pathAndQuery: string, options: AiGatewayWorkspaceOptions): string {
  const principal = options.principal.trim().toLowerCase();
  if (!principal || !options.token) return '';
  const token = createHash('sha256').update(options.token).digest('base64url').slice(0, 16);
  return `${principal}\u0000${token}\u0000${pathAndQuery}`;
}

function combinedSignal(options: AiGatewayWorkspaceOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? AI_GATEWAY_TIMEOUT_MS);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

/** Narrow GET-only workspace adapter. Host and token are server-owned inputs. */
export async function gatewayWorkspaceGet(
  path: string,
  query: Record<string, string>,
  options: AiGatewayWorkspaceOptions
): Promise<WorkspaceAnswer> {
  if (!ALLOWED_PATHS.some((allowed) => allowed.test(path))) {
    throw new Error('AI Gateway discovery refused a path outside its allowlist.');
  }
  const search = new URLSearchParams(query);
  const pathAndQuery = search.size ? `${path}?${search.toString()}` : path;
  const key = options.cache === false ? '' : cacheKey(pathAndQuery, options);
  const cached = key ? pageCache.get(key) : undefined;
  if (cached) return cached;
  const signal = combinedSignal(options);
  const response = await discoveryLimiter.run(signal, () =>
    (options.fetchImpl ?? fetch)(`${options.host}${pathAndQuery}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.token}`, accept: 'application/json' },
      signal,
    })
  );
  const raw: unknown = await response.json().catch(() => null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`The workspace returned malformed JSON for ${path}.`);
  }
  const answer = {
    status: response.status,
    body: raw as Record<string, unknown>,
    etag: response.headers.get('etag')?.trim() ?? '',
  };
  if (key && response.ok) pageCache.set(key, answer);
  return answer;
}

function readiness(
  body: Record<string, unknown>,
  kind: AiGatewayCandidate['kind']
): {
  ready: boolean;
  label: string;
} {
  const state = record(body.state);
  const value = (
    text(state.ready) ||
    text(state.status) ||
    text(body.readiness) ||
    text(body.status) ||
    text(body.state)
  ).toUpperCase();
  const updating = text(state.config_update).toUpperCase();
  const ready = ['READY', 'ACTIVE', 'ONLINE'].includes(value) && !['UPDATING', 'IN_PROGRESS'].includes(updating);
  return { ready, label: value || (kind === 'model-service' ? 'UNKNOWN' : 'NOT_READY') };
}

function actionOf(value: unknown): string {
  const object = record(value);
  return (
    text(object.action) ||
    text(object.enforcement_action) ||
    text(object.behavior) ||
    text(object.mode) ||
    text(object.action_type)
  ).toUpperCase();
}

function gatewayConfiguration(
  body: Record<string, unknown>,
  kind: AiGatewayCandidate['kind']
): Record<string, unknown> {
  if (kind === 'model-service') return record(body.config);
  return record(body.ai_gateway);
}

function capabilitySummary(
  body: Record<string, unknown>,
  kind: AiGatewayCandidate['kind'],
  identifier: string
): { capabilities: AiGatewayCapabilities; enforcement: EnforcementSource[] } {
  const config = gatewayConfiguration(body, kind);
  const usage = config.usage ?? config.usage_tracking ?? config.usage_tracking_config;
  const inference = config.inference_table ?? config.inference_table_config;
  const rateLimits = config.rate_limits ?? config.rate_limit;
  const budget = config.budget ?? config.budget_policy ?? record(usage).budget ?? body.budget_policy;
  const fallback = config.fallback ?? config.fallback_config;
  const capabilities: AiGatewayCapabilities = {
    rateLimits: present(rateLimits),
    budgetEnforcement: actionOf(budget) === 'BLOCK_USAGE',
    usageTracking: present(usage),
    inferenceTable: present(inference),
    guardrails: present(config.guardrails),
    routingFallback: present(config.routing) || present(fallback),
  };
  const enforcement: EnforcementSource[] = [];
  if (capabilities.rateLimits) {
    enforcement.push({
      source: 'gateway-rate-limit',
      label: 'Rate limited',
      approximate: true,
      blocksUsage: true,
      detail: 'Returns 429 near the configured limit; bounded overshoot is possible, so enforcement is approximate.',
      identifier,
    });
  }
  if (capabilities.budgetEnforcement) {
    enforcement.push({
      source: 'gateway-block-usage-budget',
      label: 'BLOCK_USAGE',
      approximate: true,
      blocksUsage: true,
      detail: 'Blocks usage from near-real-time budget data. This is approximate, not an exact spending ceiling.',
      identifier,
    });
  }
  return { capabilities, enforcement };
}

function typeName(body: Record<string, unknown>): string {
  return (
    text(body.endpoint_type) ||
    text(body.service_type) ||
    text(body.type) ||
    text(record(body.config).endpoint_type)
  ).toUpperCase();
}

function unsupportedType(body: Record<string, unknown>): boolean {
  const type = typeName(body);
  return type.includes('AGENT') || type.includes('CUSTOM');
}

function foundationEndpoint(body: Record<string, unknown>): boolean {
  const type = typeName(body);
  if (/(FOUNDATION|PAY_PER_TOKEN|EXTERNAL_MODEL|FMAPI)/.test(type)) return true;
  const config = record(body.config);
  const entities = Array.isArray(config.served_entities)
    ? config.served_entities.map(record)
    : Array.isArray(body.served_entities)
      ? body.served_entities.map(record)
      : [];
  return (
    entities.length > 0 &&
    entities.every((entity) => {
      const name = text(entity.entity_name) || text(entity.name);
      return name.startsWith('system.ai.') || present(entity.external_model);
    })
  );
}

function candidateFromBody(
  body: Record<string, unknown>,
  kind: AiGatewayCandidate['kind'],
  mode: AiGatewayMode
): AiGatewayCandidate | null {
  const id = text(body.full_name) || text(body.name) || text(body.id);
  if (!id || unsupportedType(body)) return null;
  if (kind !== 'model-service' && !foundationEndpoint(body)) return null;
  const gateway = gatewayConfiguration(body, kind);
  if (kind === 'legacy-endpoint' && !present(gateway)) return null;
  const state = readiness(body, kind);
  const safe = capabilitySummary(body, kind, id);
  const compatibleModes: AiGatewayMode[] =
    kind === 'model-service'
      ? ['mlflow', 'openai']
      : kind === 'direct-endpoint'
        ? ['']
        : present(gateway.openai_compatible) || text(gateway.api_format).toUpperCase().includes('OPENAI')
          ? ['mlflow', 'openai']
          : ['mlflow'];
  if (!compatibleModes.includes(mode)) return null;
  return {
    id,
    displayName: text(body.display_name) || id,
    kind,
    ready: state.ready,
    readiness: state.label,
    compatibleModes,
    capabilities: kind === 'direct-endpoint' ? EMPTY_AI_GATEWAY_CAPABILITIES : safe.capabilities,
    enforcement: kind === 'direct-endpoint' ? [] : safe.enforcement,
  };
}

function listRows(body: Record<string, unknown>, keys: readonly string[]): Record<string, unknown>[] | null {
  for (const key of keys) {
    if (Array.isArray(body[key])) return (body[key] as unknown[]).map(record);
  }
  return null;
}

interface ListedResource {
  body: Record<string, unknown>;
  etag: string;
}

async function listFamily(
  path: string,
  keys: readonly string[],
  options: AiGatewayWorkspaceOptions
): Promise<{ rows: ListedResource[]; pages: number; capped: boolean }> {
  const rows: ListedResource[] = [];
  let token = '';
  let pages = 0;
  do {
    pages += 1;
    const query: Record<string, string> = { max_results: String(AI_GATEWAY_PAGE_SIZE) };
    if (token) query.page_token = token;
    const answer = await gatewayWorkspaceGet(path, query, options);
    if (answer.status === 401 || answer.status === 403) {
      const denied = new Error('permission-blocked');
      Object.assign(denied, { status: answer.status });
      throw denied;
    }
    if (answer.status < 200 || answer.status >= 300) throw new Error(`workspace HTTP ${answer.status}`);
    const found = listRows(answer.body, keys);
    if (!found) throw new Error(`The workspace returned a malformed ${path} list.`);
    rows.push(...found.map((body) => ({ body, etag: answer.etag })));
    token = text(answer.body.next_page_token) || text(answer.body.nextPageToken);
  } while (token && pages < AI_GATEWAY_PAGE_CAP && rows.length < AI_GATEWAY_RESULT_CAP);
  return { rows: rows.slice(0, AI_GATEWAY_RESULT_CAP), pages, capped: Boolean(token) };
}

async function endpointDetail(
  summary: Record<string, unknown>,
  options: AiGatewayWorkspaceOptions
): Promise<ListedResource | null> {
  const name = text(summary.name) || text(summary.id);
  if (!name) return null;
  const answer = await gatewayWorkspaceGet(`${SERVING_ENDPOINTS_PATH}/${encodeURIComponent(name)}`, {}, options);
  if (answer.status < 200 || answer.status >= 300) return null;
  return { body: answer.body, etag: answer.etag };
}

export async function discoverAiGatewayCandidates(input: {
  mode: AiGatewayMode;
  query: string;
  options: AiGatewayWorkspaceOptions;
}): Promise<AiGatewayDiscovery> {
  if (!input.options.host || !input.options.token) {
    return {
      status: 'permission-blocked',
      items: [],
      detail: 'The signed-in user token needed for workspace metadata discovery was not available.',
      pagination: { pagesRead: 0, pageCap: AI_GATEWAY_PAGE_CAP, capped: false },
    };
  }
  try {
    const families =
      input.mode === '' ? [] : [listFamily(MODEL_SERVICES_PATH, ['model_services', 'services'], input.options)];
    const [services, endpoints] = await Promise.all([
      families[0] ?? Promise.resolve({ rows: [], pages: 0, capped: false }),
      listFamily(SERVING_ENDPOINTS_PATH, ['endpoints', 'serving_endpoints'], input.options),
    ]);
    const detailed = await Promise.all(endpoints.rows.map((entry) => endpointDetail(entry.body, input.options)));
    const candidates = [
      ...services.rows.map((entry) => candidateFromBody(entry.body, 'model-service', input.mode)),
      ...detailed.map((entry) =>
        entry
          ? candidateFromBody(entry.body, input.mode === '' ? 'direct-endpoint' : 'legacy-endpoint', input.mode)
          : null
      ),
    ].filter((entry): entry is AiGatewayCandidate => Boolean(entry));
    const query = input.query.trim().toLowerCase();
    const items = candidates
      .filter((entry) => !query || `${entry.displayName}\n${entry.id}`.toLowerCase().includes(query))
      .slice(0, AI_GATEWAY_RESULT_CAP);
    return {
      status: 'ok',
      items,
      detail: '',
      pagination: {
        pagesRead: services.pages + endpoints.pages,
        pageCap: AI_GATEWAY_PAGE_CAP,
        capped: services.capped || endpoints.capped,
      },
    };
  } catch (error) {
    const permission =
      (error as { status?: number }).status === 403 || (error as Error).message === 'permission-blocked';
    return {
      status: permission ? 'permission-blocked' : 'unavailable',
      items: [],
      detail: permission
        ? 'The workspace refused metadata discovery for this signed-in user.'
        : `Gateway discovery is unavailable: ${(error as Error).message}`,
      pagination: { pagesRead: 0, pageCap: AI_GATEWAY_PAGE_CAP, capped: false },
    };
  }
}

function invocationPlausible(token: string): boolean {
  const scopes = scopesFromToken(token);
  if (scopes === null) return true;
  return (
    tokenScopeVerdict(scopes, 'model-serving') !== false ||
    tokenScopeVerdict(scopes, 'serving.serving-endpoints') !== false
  );
}

export async function validateAiGatewayCandidate(input: {
  mode: AiGatewayMode;
  candidateId: string;
  options: AiGatewayWorkspaceOptions;
}): Promise<AiGatewayValidation & { etag?: string }> {
  const validatedAt = new Date().toISOString();
  if (!input.options.host || !input.options.token) {
    return {
      state: 'permission-blocked',
      detail: 'A signed-in user token was not available for metadata validation.',
      validatedAt,
      candidate: null,
    };
  }
  if (!invocationPlausible(input.options.token)) {
    return {
      state: 'permission-blocked',
      detail: 'The forwarded sign-in does not carry a Model Serving scope, so invocation permission is not plausible.',
      validatedAt,
      candidate: null,
    };
  }
  const encoded = encodeURIComponent(input.candidateId.trim());
  const paths =
    input.mode === ''
      ? [{ path: `${SERVING_ENDPOINTS_PATH}/${encoded}`, kind: 'direct-endpoint' as const }]
      : [
          { path: `${MODEL_SERVICES_PATH}/${encoded}`, kind: 'model-service' as const },
          { path: `${SERVING_ENDPOINTS_PATH}/${encoded}`, kind: 'legacy-endpoint' as const },
        ];
  let refused = false;
  try {
    for (const target of paths) {
      const answer = await gatewayWorkspaceGet(target.path, {}, { ...input.options, cache: false });
      if (answer.status === 401 || answer.status === 403) {
        refused = true;
        continue;
      }
      if (answer.status === 404) continue;
      if (answer.status < 200 || answer.status >= 300) {
        return {
          state: 'unavailable',
          detail: `The workspace returned HTTP ${answer.status} while validating the candidate.`,
          validatedAt,
          candidate: null,
        };
      }
      const candidate = candidateFromBody(answer.body, target.kind, input.mode);
      if (!candidate) {
        return {
          state: 'invalid',
          detail:
            'The resource is not a supported foundation model service or AI-Gateway-enabled endpoint for this mode.',
          validatedAt,
          candidate: null,
        };
      }
      if (!candidate.ready) {
        return {
          state: 'unavailable',
          detail: `The resource exists but is not ready (${candidate.readiness}).`,
          validatedAt,
          candidate,
          etag: answer.etag,
        };
      }
      return {
        state: 'validated',
        detail:
          'Metadata is readable, the resource is ready, and Model Serving invocation permission is plausible. ' +
          'No model request was sent.',
        validatedAt,
        candidate,
        etag: answer.etag,
      };
    }
  } catch (error) {
    const name = (error as Error).name;
    return {
      state: name === 'AbortError' || name === 'TimeoutError' ? 'unavailable' : 'unavailable',
      detail: `The workspace could not complete validation: ${(error as Error).message}`,
      validatedAt,
      candidate: null,
    };
  }
  return {
    state: refused ? 'permission-blocked' : 'invalid',
    detail: refused
      ? 'The workspace refused metadata access to the selected resource.'
      : 'The selected resource does not exist in this workspace.',
    validatedAt,
    candidate: null,
  };
}

interface StoredGatewayMetadata {
  mode: AiGatewayMode;
  candidateId: string;
  validatedAt: string;
  etag: string;
  revision: string;
}

function parseMetadata(note: string): StoredGatewayMetadata | null {
  try {
    const value = JSON.parse(note) as Partial<StoredGatewayMetadata>;
    if (
      (value.mode === '' || value.mode === 'mlflow' || value.mode === 'openai') &&
      typeof value.candidateId === 'string' &&
      typeof value.validatedAt === 'string' &&
      typeof value.revision === 'string'
    ) {
      return {
        mode: value.mode,
        candidateId: value.candidateId,
        validatedAt: value.validatedAt,
        etag: typeof value.etag === 'string' ? value.etag : '',
        revision: value.revision,
      };
    }
  } catch {
    // Legacy notes are prose, not validation metadata.
  }
  return null;
}

export function gatewayRevision(stored: ReadonlyMap<string, StoredSetting>): string {
  return stored.get(AI_GATEWAY_REVISION_RESOURCE)?.value.trim() || '0';
}

export async function stageAiGatewaySelection(input: {
  store: LakebaseReader;
  mode: AiGatewayMode;
  candidateId: string;
  expectedRevision: string;
  actor: string;
  validation: AiGatewayValidation & { etag?: string };
}): Promise<{ ok: true; revision: string; stagedAt: string } | { ok: false; reason: 'stale' }> {
  const revision = randomUUID();
  const note = JSON.stringify({
    mode: input.mode,
    candidateId: input.candidateId,
    validatedAt: input.validation.validatedAt,
    etag: input.validation.etag ?? '',
    revision,
  } satisfies StoredGatewayMetadata);
  const result = await input.store.lakebase.query(
    `WITH gate AS (
       SELECT pg_advisory_xact_lock(hashtext('astrolabe-ai-gateway-stage'))
     ), current AS (
       SELECT COALESCE(
         (SELECT value FROM ${APP_SCHEMA}.deployment_settings WHERE resource_id = $1),
         '0'
       ) AS revision
       FROM gate
     ), accepted AS (
       SELECT 1 FROM current WHERE revision = $2
     ), written AS (
       INSERT INTO ${APP_SCHEMA}.deployment_settings
         (resource_id, value, intent, note, updated_by, updated_at)
       SELECT row.resource_id, row.value, 'intended', row.note, $3, now()
       FROM (VALUES
         ('llm-gateway', $4, $6),
         ('llm-endpoint', $5, $6),
         ($1, $7, '')
       ) AS row(resource_id, value, note)
       CROSS JOIN accepted
       ON CONFLICT (resource_id) DO UPDATE
         SET value = EXCLUDED.value,
             intent = EXCLUDED.intent,
             note = EXCLUDED.note,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()
       RETURNING resource_id, updated_at
     )
     SELECT resource_id, updated_at FROM written`,
    [AI_GATEWAY_REVISION_RESOURCE, input.expectedRevision, input.actor, input.mode, input.candidateId, note, revision]
  );
  if (result.rows.length !== 3) return { ok: false, reason: 'stale' };
  forgetStoredSettings();
  const stamp = result.rows.find((row) => row.resource_id === AI_GATEWAY_REVISION_RESOURCE)?.updated_at;
  return {
    ok: true,
    revision,
    stagedAt: stamp instanceof Date ? stamp.toISOString() : text(stamp) || input.validation.validatedAt,
  };
}

export function summarizeAiGateway(input: {
  activeMode: string;
  activeModel: string;
  stored: ReadonlyMap<string, StoredSetting>;
  validation?: AiGatewayValidation;
}): AiGatewaySummary {
  const activeMode: AiGatewayMode =
    input.activeMode === 'mlflow' || input.activeMode === 'openai' ? input.activeMode : '';
  const gateway = input.stored.get('llm-gateway');
  const model = input.stored.get('llm-endpoint');
  const metadata = parseMetadata(gateway?.note ?? '');
  const coherent =
    gateway?.intent === 'intended' &&
    model?.intent === 'intended' &&
    metadata?.candidateId === model.value &&
    metadata.mode === gateway.value &&
    metadata.revision === gatewayRevision(input.stored);
  const staged =
    coherent && metadata
      ? { mode: metadata.mode, model: metadata.candidateId, transport: gatewayTransport(metadata.mode) }
      : null;
  const invalid = Boolean(gateway || model) && !coherent;
  return {
    active: { mode: activeMode, model: input.activeModel.trim(), transport: gatewayTransport(activeMode) },
    staged,
    configurationState: invalid
      ? 'invalid'
      : staged
        ? input.validation && input.validation.state !== 'validated'
          ? input.validation.state === 'unavailable'
            ? 'unavailable'
            : 'invalid'
          : 'staged'
        : 'active',
    detail: invalid
      ? 'A legacy partial Gateway intention exists. Select and stage the transport and model together.'
      : staged
        ? input.validation?.detail || 'Staged for agent release.'
        : activeMode
          ? input.validation?.detail || 'The running model version reports this Gateway route.'
          : 'Direct model traffic remains active.',
    validatedAt: input.validation?.validatedAt || metadata?.validatedAt || '',
    revision: gatewayRevision(input.stored),
    candidate: input.validation?.candidate ?? null,
    rollback: 'Stage Direct with the existing foundation endpoint, then use the normal confirmed agent release.',
  };
}
