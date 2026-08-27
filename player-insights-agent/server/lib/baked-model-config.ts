/**
 * What the served model version baked at log time, without asking it a question.
 *
 * Connections used to send a fake `preflight` Ask so the endpoint would echo
 * `custom_outputs.configuration`. That path is gone. The same values still live
 * on the model version as `model_config` — foundation model, declared tables,
 * resolved Vector Search index — and the app can read them the same way it
 * already reads which version the endpoint serves: as its own service principal,
 * via GET, never via invoke.
 *
 * Gap-fill only. Values the app container already holds win. Failure is empty,
 * never a throw: this feeds the page somebody opens to find out why the rest of
 * the app is misbehaving.
 */
import { parseServedModel } from './benchmark-runner';
import { APPLY_ENV_VARS } from '../../shared/apply-declaration';
import type { PreflightConfiguration } from '../routes/insights-routes';

const BAKED_TTL_MS = 45_000;

const EXTRA_ENV: Record<string, string> = {
  declared_manifest: 'PLAYER_INSIGHTS_DECLARED_MANIFEST',
  tables: 'PLAYER_INSIGHTS_TABLES',
  semantic_index: 'PLAYER_INSIGHTS_SEMANTIC_INDEX',
  manifest_source: 'PLAYER_INSIGHTS_MANIFEST_SOURCE',
};

const LIST_KEYS = new Set(['catalog_allowlist', 'catalog_denylist', 'declared_manifest', 'tables']);

export interface BakedConfigTransport {
  getJson: (path: string, query?: Record<string, string>) => Promise<unknown>;
  getText?: (path: string, query?: Record<string, string>) => Promise<string>;
}

export type EndpointReader = (name: string) => Promise<unknown>;

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * The `model_config` / python_function `config` map out of an MLmodel document.
 *
 * MLflow round-trips the map through YAML. A full YAML parser is not a
 * dependency of this app; the keys Connections needs are scalars and string
 * lists, which this reads without executing anything.
 */
export function parseModelConfigDocument(source: string): Record<string, unknown> {
  const trimmed = source.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const record = asRecord(parsed);
      const nested = asRecord(record.model_config);
      if (Object.keys(nested).length > 0) return nested;
      const flavors = asRecord(asRecord(record.flavors).python_function);
      const fromFlavor = asRecord(flavors.config ?? flavors.model_config);
      if (Object.keys(fromFlavor).length > 0) return fromFlavor;
      if ('llm_endpoint' in record || 'declared_manifest' in record || 'semantic_index' in record) {
        return record;
      }
    } catch {
      return {};
    }
  }
  const block = yamlBlock(source, ['model_config:', 'config:']);
  return block ? parseYamlMap(block) : {};
}

function yamlBlock(source: string, headers: readonly string[]): string {
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const header = headers.find((name) => line.trimStart().startsWith(name));
    if (!header) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const rest = line.trimStart().slice(header.length).trim();
    const collected: string[] = [];
    if (rest && rest !== '|' && rest !== '>' && rest !== '{}') {
      collected.push(`_inline: ${rest}`);
    }
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next];
      if (!candidate.trim()) {
        collected.push(candidate);
        continue;
      }
      const candidateIndent = candidate.match(/^\s*/)?.[0].length ?? 0;
      if (candidateIndent <= indent) break;
      collected.push(candidate.slice(indent + 2));
    }
    const body = collected.join('\n').trim();
    if (body) return body;
  }
  return '';
}

function parseYamlMap(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = block.split(/\r?\n/);
  let currentKey = '';
  let list: string[] | null = null;
  const flushList = () => {
    if (currentKey && list) result[currentKey] = list;
    list = null;
  };
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && currentKey) {
      list = list ?? [];
      list.push(unquote(item[1]));
      continue;
    }
    const pair = line.match(/^\s*([A-Za-z0-9_]+):\s*(.*)$/);
    if (!pair) continue;
    flushList();
    currentKey = pair[1];
    const raw = pair[2].trim();
    if (!raw || raw === '|' || raw === '>' || raw === '[]') {
      list = raw === '[]' ? [] : [];
      if (raw === '[]') {
        result[currentKey] = [];
        list = null;
      }
      continue;
    }
    if (raw.startsWith('[') && raw.endsWith(']')) {
      try {
        const parsed = JSON.parse(raw.replace(/'/g, '"')) as unknown;
        result[currentKey] = Array.isArray(parsed) ? parsed.map((entry) => text(entry)) : unquote(raw);
      } catch {
        result[currentKey] = unquote(raw);
      }
      continue;
    }
    if (raw === 'null' || raw === '~') {
      result[currentKey] = '';
      continue;
    }
    result[currentKey] = unquote(raw);
  }
  flushList();
  return result;
}

function artifactText(body: unknown): string {
  if (typeof body === 'string') return body;
  const record = asRecord(body);
  if (typeof record.content === 'string') return record.content;
  if (typeof record.data === 'string') {
    try {
      return Buffer.from(record.data, 'base64').toString('utf8');
    } catch {
      return record.data;
    }
  }
  if (typeof record.text === 'string') return record.text;
  return '';
}

function runIdOf(body: unknown): string {
  const record = asRecord(body);
  const version = asRecord(record.model_version ?? record.modelVersion);
  return text(version.run_id ?? version.runId ?? record.run_id ?? record.runId);
}

function envVarFor(key: string): string {
  return APPLY_ENV_VARS[key] ?? EXTRA_ENV[key] ?? '';
}

/**
 * Configuration entries from a baked model_config map.
 *
 * `source` is `artifact` on purpose: these values were written into the model
 * version at log time. Connections already knows how to present that provenance.
 */
export function configurationFromBaked(config: Record<string, unknown>): PreflightConfiguration[] {
  const entries: PreflightConfiguration[] = [];
  for (const [key, raw] of Object.entries(config)) {
    if (raw === undefined || raw === null || raw === '') continue;
    const value = LIST_KEYS.has(key)
      ? Array.isArray(raw)
        ? raw.map((item) => text(item)).filter(Boolean)
        : text(raw)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : text(raw);
    if (Array.isArray(value) ? value.length === 0 : !value) continue;
    entries.push({
      key,
      env_var: envVarFor(key),
      value,
      source: 'artifact',
      mutability: 'model-version',
      baked: true,
      required: false,
    });
  }
  return entries;
}

async function defaultGetJson(path: string, query: Record<string, string> = {}): Promise<unknown> {
  const { WorkspaceClient } = await import('@databricks/sdk-experimental');
  const client = new WorkspaceClient({});
  return client.apiClient.request({
    path,
    method: 'GET',
    query,
    headers: new Headers({ Accept: 'application/json' }),
    raw: false,
  });
}

async function describeEndpoint(name: string): Promise<unknown> {
  const { WorkspaceClient } = await import('@databricks/sdk-experimental');
  return new WorkspaceClient({}).servingEndpoints.get({ name });
}

async function readModelConfigText(
  transport: BakedConfigTransport,
  runId: string
): Promise<string> {
  const paths = ['agent/MLmodel', 'MLmodel', 'agent/model_config', 'model_config.json', 'agent/config.json'];
  for (const artifact of paths) {
    try {
      if (transport.getText) {
        const textBody = await transport.getText('/api/2.0/mlflow/artifacts/get', {
          run_id: runId,
          path: artifact,
        });
        if (textBody.trim()) return textBody;
      }
      const body = await transport.getJson('/api/2.0/mlflow/artifacts/get', {
        run_id: runId,
        path: artifact,
      });
      const extracted = artifactText(body);
      if (extracted.trim()) return extracted;
    } catch {
      // Try the next path. A missing file is ordinary; the next name may exist.
    }
  }
  try {
    const listed = asRecord(
      await transport.getJson('/api/2.0/mlflow/artifacts/list', { run_id: runId, path: 'agent' })
    );
    const files = Array.isArray(listed.files) ? listed.files : [];
    const mlmodel = files.find((file) => {
      const path = text(asRecord(file).path);
      return path.endsWith('MLmodel') || path.endsWith('model_config') || path.endsWith('config.json');
    });
    const path = text(asRecord(mlmodel).path);
    if (!path) return '';
    const body = await transport.getJson('/api/2.0/mlflow/artifacts/get', { run_id: runId, path });
    return artifactText(body);
  } catch {
    return '';
  }
}

async function runIdForServedModel(
  transport: BakedConfigTransport,
  entityName: string,
  version: string
): Promise<string> {
  const attempts: Array<{ path: string; query: Record<string, string> }> = [
    {
      path: `/api/2.1/unity-catalog/models/${encodeURIComponent(entityName)}/versions/${encodeURIComponent(version)}`,
      query: {},
    },
    {
      path: '/api/2.1/unity-catalog/model-versions/get',
      query: { full_name: entityName, version },
    },
    {
      path: '/api/2.0/mlflow/databricks/model-versions/get',
      query: { name: entityName, version },
    },
    {
      path: '/api/2.0/mlflow/model-versions/get',
      query: { name: entityName, version },
    },
  ];
  for (const attempt of attempts) {
    try {
      const runId = runIdOf(await transport.getJson(attempt.path, attempt.query));
      if (runId) return runId;
    } catch {
      // The model may be UC or workspace-registry; try the next spelling.
    }
  }
  return '';
}

let cache: { at: number; endpoint: string; entries: PreflightConfiguration[] } | null = null;

/** Forget the cached baked config. Exported for tests. */
export function forgetBakedModelConfig(): void {
  cache = null;
}

/**
 * The served model version's baked configuration, or nothing.
 *
 * Cached briefly so a Connections refresh is not three MLflow round trips.
 * A failed read is never cached, matching stored settings: one outage must not
 * become 45 seconds of a blank Foundation model row.
 */
export async function readBakedModelConfig(input: {
  endpointName?: string;
  readEndpoint?: EndpointReader;
  transport?: BakedConfigTransport;
  now?: number;
} = {}): Promise<PreflightConfiguration[]> {
  const endpointName = (input.endpointName ?? process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? '').trim();
  if (!endpointName) return [];
  // No workspace, no model version to ask. Local tests and a laptop checkout
  // hit this; a deployed app always has DATABRICKS_HOST.
  if (!input.readEndpoint && !input.transport && !(process.env.DATABRICKS_HOST ?? '').trim()) return [];
  const now = input.now ?? Date.now();
  if (cache && cache.endpoint === endpointName && now - cache.at < BAKED_TTL_MS) {
    return cache.entries;
  }

  const transport: BakedConfigTransport = input.transport ?? { getJson: defaultGetJson };
  try {
    const served = parseServedModel(
      endpointName,
      await (input.readEndpoint ?? describeEndpoint)(endpointName)
    );
    if (!served.entityName || !served.version) return [];
    const runId = await runIdForServedModel(transport, served.entityName, served.version);
    if (!runId) return [];
    const document = await readModelConfigText(transport, runId);
    const entries = configurationFromBaked(parseModelConfigDocument(document));
    cache = { at: now, endpoint: endpointName, entries };
    return entries;
  } catch (error) {
    console.warn(
      '[settings] The served model version’s baked configuration could not be read:',
      (error as Error).message
    );
    return [];
  }
}
