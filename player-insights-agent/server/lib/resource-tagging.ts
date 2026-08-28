/**
 * Applies Astrolabe's billing tag to the platform resources this app manages.
 *
 * Inventory comes from the same environment and served configuration that feed
 * Connections. It deliberately does not list the workspace looking for names:
 * a similarly named customer resource is not evidence that this deployment owns
 * it. Connected cost-generating resources are attempted even when the bundle
 * attaches rather than creates them; permission failures are reported by name.
 * Vector Search indexes are explicit skips because the platform only exposes
 * custom tags on their endpoint.
 */
import type { PreflightReport } from '../routes/insights-routes';
import {
  BILLING_TAG,
  RETIRED_BILLING_TAG_KEY,
  billingTagPair,
  type AppBillingTagState,
} from '../../shared/billing-tag';

export const ASTROLABE_TAG = BILLING_TAG;

export type ResourceTagKind =
  | 'app'
  | 'registered-model'
  | 'model-version'
  | 'mlflow-experiment'
  | 'serving-endpoint'
  | 'genie-space'
  | 'sql-warehouse'
  | 'lakebase'
  | 'vector-index'
  | 'vector-endpoint';

export interface ResourceTagTarget {
  kind: ResourceTagKind;
  name: string;
  label: string;
  action: 'tag' | 'skip';
  reason?: string;
  version?: string;
}

export interface ResourceTagResult extends ResourceTagTarget {
  status: 'tagged' | 'already-correct' | 'not-supported' | 'permission-required' | 'failed';
  detail: string;
  technicalDetail?: string;
}

export interface ResourceTagSummary {
  headline: string;
  total: number;
  correct: number;
  tagged: number;
  alreadyCorrect: number;
  notSupported: number;
  permissionRequired: number;
  failed: number;
  results: ResourceTagResult[];
}

export interface ResourceTagRetryPolicy {
  maxAttempts?: number;
  baseDelayMs?: number;
  timeBudgetMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
}

interface KeyValueTag {
  key?: string;
  value?: string;
}

export interface ResourceTagPlatform {
  getAppTag(appName: string): Promise<string | null>;
  createAppTag(appName: string): Promise<void>;
  updateAppTag(appName: string): Promise<void>;
  getServingTags(name: string): Promise<KeyValueTag[]>;
  addServingTag(name: string): Promise<void>;
  deleteServingTag(name: string, key: string): Promise<void>;
  getModelTags(name: string): Promise<KeyValueTag[]>;
  setModelTag(name: string): Promise<void>;
  deleteModelTag(name: string, key: string): Promise<void>;
  getModelVersionTags(name: string, version: string): Promise<KeyValueTag[]>;
  setModelVersionTag(name: string, version: string): Promise<void>;
  deleteModelVersionTag(name: string, version: string, key: string): Promise<void>;
  getExperimentTags(experimentId: string): Promise<KeyValueTag[]>;
  setExperimentTag(experimentId: string): Promise<void>;
  deleteExperimentTag(experimentId: string, key: string): Promise<void>;
  getWarehouseTags(warehouseId: string): Promise<KeyValueTag[]>;
  setWarehouseTags(warehouseId: string, tags: KeyValueTag[]): Promise<void>;
  getLakebaseTags(projectName: string): Promise<KeyValueTag[]>;
  setLakebaseTags(projectName: string, tags: KeyValueTag[]): Promise<void>;
  getVectorIndexEndpoint(indexName: string): Promise<string>;
  getVectorEndpointTags(endpointName: string): Promise<KeyValueTag[]>;
  setVectorEndpointTags(endpointName: string, tags: KeyValueTag[]): Promise<void>;
}

function configurationValue(report: PreflightReport | null, key: string): string {
  const value = report?.configuration.find((entry) => entry.key === key)?.value;
  return typeof value === 'string' ? value.trim() : '';
}

function text(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * Dry inventory: no workspace call and no mutation.
 *
 * Optional resources are included only when Connections has an identifier for
 * them. This keeps the action from turning into a second discovery mechanism.
 */
export function resourceTagInventory(
  input: {
    environment?: NodeJS.ProcessEnv;
    report?: PreflightReport | null;
  } = {}
): ResourceTagTarget[] {
  const environment = input.environment ?? process.env;
  const report = input.report ?? null;
  const targets: ResourceTagTarget[] = [];
  const appName = text(environment.DATABRICKS_APP_NAME);
  if (appName) {
    targets.push({ kind: 'app', name: appName, label: `App · ${appName}`, action: 'tag' });
  }

  const modelName = configurationValue(report, 'model_name') || text(environment.PLAYER_INSIGHTS_MODEL_NAME);
  const modelVersion = configurationValue(report, 'model_version');
  if (modelName) {
    targets.push({
      kind: 'registered-model',
      name: modelName,
      label: `Registered agent model · ${modelName}`,
      action: 'tag',
    });
    if (modelVersion) {
      targets.push({
        kind: 'model-version',
        name: modelName,
        version: modelVersion,
        label: `Agent model version · ${modelName} v${modelVersion}`,
        action: 'tag',
      });
    }
  }

  const serving = text(environment.DATABRICKS_SERVING_ENDPOINT_NAME);
  if (serving) {
    targets.push({
      kind: 'serving-endpoint',
      name: serving,
      label: `Serving endpoint · ${serving}`,
      action: 'tag',
    });
  }

  const foundationModel = configurationValue(report, 'llm_endpoint');
  if (foundationModel) {
    targets.push({
      kind: 'serving-endpoint',
      name: foundationModel,
      label: `Foundation model serving endpoint · ${foundationModel}`,
      action: 'tag',
    });
  }

  for (const [key, label] of [
    ['data_genie_space_id', 'Data Genie space'],
    ['dictionary_genie_space_id', 'Dictionary Genie space'],
  ] as const) {
    const spaceId = configurationValue(report, key);
    if (!spaceId) continue;
    targets.push({
      kind: 'genie-space',
      name: spaceId,
      label: `${label} · ${spaceId}`,
      action: 'skip',
      reason:
        'Genie space tags are organizational only and do not propagate to billing by space id. ' +
        'SQL issued by this space is billed through its associated SQL warehouse.',
    });
  }

  const experimentId = text(environment.PLAYER_INSIGHTS_EXPERIMENT_ID);
  if (experimentId) {
    targets.push({
      kind: 'mlflow-experiment',
      name: experimentId,
      label: `MLflow experiment · ${experimentId}`,
      action: 'tag',
    });
  }

  const index = configurationValue(report, 'semantic_index');
  if (index && index.includes('.')) {
    targets.push({
      kind: 'vector-index',
      name: index,
      label: `Vector Search index · ${index}`,
      action: 'skip',
      reason:
        'Databricks does not expose custom tags for Vector Search indexes. Nothing needs to be fixed on this index; ' +
        'Astrolabe tags its endpoint instead.',
    });
  }

  const warehouse = text(environment.DATABRICKS_SQL_WAREHOUSE_ID);
  if (warehouse) {
    targets.push({
      kind: 'sql-warehouse',
      name: warehouse,
      label: `SQL warehouse · ${warehouse}`,
      action: 'tag',
    });
  }

  const lakebaseBinding = text(environment.LAKEBASE_ENDPOINT);
  const projectId = /^projects\/([^/]+)/.exec(lakebaseBinding)?.[1] ?? '';
  if (projectId) {
    targets.push({
      kind: 'lakebase',
      name: `projects/${projectId}`,
      label: `Lakebase project · ${projectId}`,
      action: 'tag',
    });
  }
  // A report and the app environment can name the same serving endpoint. It is
  // one resource and must not inflate either the coverage inventory or tag work.
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.kind}\u0000${target.name}\u0000${target.version ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasTag(tags: readonly KeyValueTag[]): boolean {
  return tags.some((tag) => tag.key === ASTROLABE_TAG.key && tag.value === ASTROLABE_TAG.value);
}

function hasRetiredTag(tags: readonly KeyValueTag[]): boolean {
  return tags.some((tag) => tag.key === RETIRED_BILLING_TAG_KEY);
}

function mergeTag(tags: readonly KeyValueTag[]): KeyValueTag[] {
  return [
    ...tags.filter((tag) => tag.key !== ASTROLABE_TAG.key && tag.key !== RETIRED_BILLING_TAG_KEY),
    { ...ASTROLABE_TAG },
  ];
}

function tagStateDetail(state: 'already-correct' | 'tagged', extra = ''): string {
  const lead =
    state === 'already-correct' ? `Already correct: ${billingTagPair()}.` : `Now correct: tagged ${billingTagPair()}.`;
  return extra ? `${lead} ${extra}` : lead;
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const RETRYABLE_CODES = new Set(['DEADLINE_EXCEEDED', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN']);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  const shape = error as { error_code?: unknown; code?: unknown };
  const code = shape?.error_code ?? shape?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code).toUpperCase() : '';
}

function isPermissionError(error: unknown): boolean {
  const status = errorStatus(error);
  const raw = `${errorCode(error)} ${errorText(error)}`;
  return status === 403 || /PERMISSION_DENIED|FORBIDDEN|UNAUTHORI[ZS]ED/i.test(raw);
}

function isRetryable(error: unknown): boolean {
  if (RETRYABLE_STATUS.has(errorStatus(error)) || RETRYABLE_CODES.has(errorCode(error))) return true;
  return /DEADLINE_EXCEEDED|Gateway Timeout|HTTP\s+(?:502|503|504)|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN/i.test(
    errorText(error)
  );
}

function technicalDetail(error: unknown): string {
  const raw = errorText(error).trim();
  if (raw.length <= 8_000) return raw;
  return `${raw.slice(0, 8_000)}\n…technical response truncated by Astrolabe`;
}

function principalId(error: unknown, fallback?: string): string {
  const fromError = errorText(error).match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[0];
  return fromError ?? (text(fallback) || 'the Astrolabe app service principal');
}

function permissionRequired(target: ResourceTagTarget, error: unknown, servicePrincipalId?: string): ResourceTagResult {
  const principal = principalId(error, servicePrincipalId);
  let detail: string;
  if (target.kind === 'app') {
    detail =
      `Workspace admin action: grant service principal ${principal} CAN_MANAGE on app “${target.name}” ` +
      'so it can change the app tag assignments. Databricks app tags are organizational and currently do not ' +
      'propagate to billing.';
  } else if (target.kind === 'vector-endpoint') {
    detail =
      `Workspace admin action: grant service principal ${principal} CAN_USE or CAN_MANAGE on ` +
      `Vector Search endpoint “${target.name}”.`;
  } else if (target.kind === 'sql-warehouse') {
    detail =
      `Workspace admin action: grant service principal ${principal} CAN_MANAGE (or ownership) on ` +
      `SQL warehouse “${target.name}”.`;
  } else if (target.kind === 'lakebase') {
    detail =
      `Workspace admin action: grant service principal ${principal} CAN_MANAGE (or ownership) on Lakebase project ` +
      `“${target.name.replace(/^projects\//, '')}” so it can update custom tags.`;
  } else {
    detail = `Workspace admin action: grant service principal ${principal} management permission on “${target.name}”.`;
  }
  return { ...target, status: 'permission-required', detail, technicalDetail: technicalDetail(error) };
}

function failed(target: ResourceTagTarget, error: unknown, servicePrincipalId?: string): ResourceTagResult {
  if (isPermissionError(error)) return permissionRequired(target, error, servicePrincipalId);
  return {
    ...target,
    status: 'failed',
    detail: 'Databricks did not complete the tag update after Astrolabe retried transient failures.',
    technicalDetail: technicalDetail(error),
  };
}

interface ResolvedRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  deadline: number;
  sleep: (delayMs: number) => Promise<void>;
  now: () => number;
}

function taggingDeadlineError(): Error & { code: string } {
  return Object.assign(new Error('Astrolabe stopped waiting for the Databricks tag operation at its time limit.'), {
    code: 'ETIMEDOUT',
  });
}

async function insideTaggingDeadline<T>(operation: () => Promise<T>, policy: ResolvedRetryPolicy): Promise<T> {
  const remaining = policy.deadline - policy.now();
  if (remaining <= 0) throw taggingDeadlineError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(taggingDeadlineError()), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function retryTransient<T>(operation: () => Promise<T>, policy: ResolvedRetryPolicy): Promise<T> {
  /**
   * Retry the complete read-before-write operation, not only the failed write.
   * A timeout can arrive after Databricks committed the mutation. Reading again
   * makes that ambiguous completion idempotent: the next attempt observes the
   * tag and reports it correct instead of issuing a duplicate create.
   */
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await insideTaggingDeadline(operation, policy);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === policy.maxAttempts) throw error;
      const delayMs = policy.baseDelayMs * (2 ** attempt - 1);
      if (policy.now() + delayMs >= policy.deadline) throw error;
      await policy.sleep(delayMs);
    }
  }
  throw lastError;
}

async function tagTargetOnce(target: ResourceTagTarget, platform: ResourceTagPlatform): Promise<ResourceTagResult> {
  if (target.action === 'skip') {
    return {
      ...target,
      status: 'not-supported',
      detail: target.reason ?? 'Databricks does not expose a custom tag API for this resource.',
    };
  }
  if (target.kind === 'app') {
    const current = await platform.getAppTag(target.name);
    if (current === ASTROLABE_TAG.value) {
      return {
        ...target,
        status: 'already-correct',
        detail: tagStateDetail(
          'already-correct',
          'Databricks app tags are organizational and currently do not propagate to billing.'
        ),
      };
    }
    if (current === null) await platform.createAppTag(target.name);
    else await platform.updateAppTag(target.name);
    return {
      ...target,
        status: 'tagged',
        detail: tagStateDetail(
          'tagged',
          'Databricks app tags are organizational and currently do not propagate to billing.'
        ),
    };
  }
  if (target.kind === 'serving-endpoint') {
    const tags = await platform.getServingTags(target.name);
    const current = hasTag(tags);
    const retired = hasRetiredTag(tags);
    if (!current) await platform.addServingTag(target.name);
    if (retired) await platform.deleteServingTag(target.name, RETIRED_BILLING_TAG_KEY);
    if (current && !retired) {
      return { ...target, status: 'already-correct', detail: tagStateDetail('already-correct') };
    }
    return {
      ...target,
      status: 'tagged',
      detail: retired
        ? tagStateDetail('tagged', `Removed retired key ${RETIRED_BILLING_TAG_KEY}.`)
        : tagStateDetail('tagged'),
    };
  }
  if (target.kind === 'registered-model') {
    const tags = await platform.getModelTags(target.name);
    const current = hasTag(tags);
    const retired = hasRetiredTag(tags);
    if (!current) await platform.setModelTag(target.name);
    if (retired) await platform.deleteModelTag(target.name, RETIRED_BILLING_TAG_KEY);
    if (current && !retired) {
      return { ...target, status: 'already-correct', detail: tagStateDetail('already-correct') };
    }
    return {
      ...target,
      status: 'tagged',
      detail: retired
        ? tagStateDetail('tagged', `Removed retired key ${RETIRED_BILLING_TAG_KEY}.`)
        : tagStateDetail('tagged'),
    };
  }
  if (target.kind === 'model-version') {
    const version = target.version;
    if (!version) throw new Error('The connected agent model version was not resolved.');
    const tags = await platform.getModelVersionTags(target.name, version);
    const current = hasTag(tags);
    const retired = hasRetiredTag(tags);
    if (!current) await platform.setModelVersionTag(target.name, version);
    if (retired) await platform.deleteModelVersionTag(target.name, version, RETIRED_BILLING_TAG_KEY);
    if (current && !retired) {
      return { ...target, status: 'already-correct', detail: tagStateDetail('already-correct') };
    }
    return {
      ...target,
      status: 'tagged',
      detail: retired
        ? tagStateDetail('tagged', `Removed retired key ${RETIRED_BILLING_TAG_KEY}.`)
        : tagStateDetail('tagged'),
    };
  }
  if (target.kind === 'mlflow-experiment') {
    const tags = await platform.getExperimentTags(target.name);
    const current = hasTag(tags);
    const retired = hasRetiredTag(tags);
    if (!current) await platform.setExperimentTag(target.name);
    if (retired) await platform.deleteExperimentTag(target.name, RETIRED_BILLING_TAG_KEY);
    if (current && !retired) {
      return { ...target, status: 'already-correct', detail: tagStateDetail('already-correct') };
    }
    return {
      ...target,
      status: 'tagged',
      detail: retired
        ? tagStateDetail('tagged', `Removed retired key ${RETIRED_BILLING_TAG_KEY}.`)
        : tagStateDetail('tagged'),
    };
  }
  if (target.kind === 'sql-warehouse') {
    const tags = await platform.getWarehouseTags(target.name);
    if (hasTag(tags) && !hasRetiredTag(tags)) {
      return { ...target, status: 'already-correct', detail: tagStateDetail('already-correct') };
    }
    await platform.setWarehouseTags(target.name, mergeTag(tags));
    return {
      ...target,
      status: 'tagged',
      detail: hasRetiredTag(tags)
        ? tagStateDetail('tagged', `Removed retired key ${RETIRED_BILLING_TAG_KEY}.`)
        : tagStateDetail('tagged'),
    };
  }
  if (target.kind === 'lakebase') {
    const tags = await platform.getLakebaseTags(target.name);
    if (hasTag(tags) && !hasRetiredTag(tags)) {
      return { ...target, status: 'already-correct', detail: tagStateDetail('already-correct') };
    }
    await platform.setLakebaseTags(target.name, mergeTag(tags));
    return {
      ...target,
      status: 'tagged',
      detail: hasRetiredTag(tags)
        ? tagStateDetail('tagged', `Removed retired key ${RETIRED_BILLING_TAG_KEY}.`)
        : tagStateDetail('tagged'),
    };
  }
  return {
    ...target,
    status: 'not-supported',
    detail: target.reason ?? 'Databricks does not expose a custom tag API for this connected resource.',
  };
}

/**
 * Apply tags with the app service principal. The caller provides no user token;
 * the production adapter below creates WorkspaceClient with Apps-injected
 * credentials.
 */
/**
 * Whether this app currently carries `system_billing=astrolabe`.
 *
 * A read of the app's own tag assignment, not of billed usage. Missing spend is
 * not evidence the tag is absent.
 */
export async function readAppBillingTag(
  appName: string,
  platform?: Pick<ResourceTagPlatform, 'getAppTag'>
): Promise<AppBillingTagState> {
  const name = appName.trim();
  if (!name) return 'unverified';
  try {
    const adapter = platform ?? (await workspaceTagPlatform());
    const current = await adapter.getAppTag(name);
    return current === ASTROLABE_TAG.value ? 'matched' : 'missing';
  } catch {
    return 'unverified';
  }
}

export async function applyAstrolabeTags(input: {
  report: PreflightReport | null;
  environment?: NodeJS.ProcessEnv;
  platform?: ResourceTagPlatform;
  retry?: ResourceTagRetryPolicy;
}): Promise<ResourceTagSummary> {
  const platform = input.platform ?? (await workspaceTagPlatform());
  const environment = input.environment ?? process.env;
  const targets = resourceTagInventory({ environment, report: input.report });
  const results: ResourceTagResult[] = [];
  const now = input.retry?.now ?? Date.now;
  const maxAttempts = Math.max(1, Math.min(3, input.retry?.maxAttempts ?? 3));
  const baseDelayMs = Math.max(0, Math.min(1_000, input.retry?.baseDelayMs ?? 250));
  const timeBudgetMs = Math.max(1_000, Math.min(12_000, input.retry?.timeBudgetMs ?? 12_000));
  const policy: ResolvedRetryPolicy = {
    maxAttempts,
    baseDelayMs,
    deadline: now() + timeBudgetMs,
    sleep: input.retry?.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))),
    now,
  };
  const servicePrincipalId = environment.DATABRICKS_CLIENT_ID;

  for (const target of targets) {
    try {
      results.push(await retryTransient(() => tagTargetOnce(target, platform), policy));
    } catch (error) {
      results.push(failed(target, error, servicePrincipalId));
    }
    if (target.kind !== 'vector-index' || target.action !== 'skip') continue;
    let endpointName = '';
    try {
      results.push(
        await retryTransient(async () => {
          endpointName = await platform.getVectorIndexEndpoint(target.name);
          const endpoint: ResourceTagTarget = {
            kind: 'vector-endpoint',
            name: endpointName,
            label: `Vector Search endpoint · ${endpointName}`,
            action: 'tag',
          };
          const tags = await platform.getVectorEndpointTags(endpointName);
          if (hasTag(tags) && !hasRetiredTag(tags)) {
            return { ...endpoint, status: 'already-correct', detail: tagStateDetail('already-correct') };
          }
          await platform.setVectorEndpointTags(endpointName, mergeTag(tags));
          return {
            ...endpoint,
            status: 'tagged',
            detail: hasRetiredTag(tags)
              ? tagStateDetail('tagged', `Removed retired key ${RETIRED_BILLING_TAG_KEY}.`)
              : tagStateDetail('tagged'),
          };
        }, policy)
      );
    } catch (error) {
      results.push(
        failed(
          {
            kind: 'vector-endpoint',
            name: endpointName || target.name,
            label: endpointName ? `Vector Search endpoint · ${endpointName}` : 'Vector Search endpoint',
            action: 'tag',
          },
          error,
          servicePrincipalId
        )
      );
    }
  }

  const tagged = results.filter((result) => result.status === 'tagged').length;
  const alreadyCorrect = results.filter((result) => result.status === 'already-correct').length;
  const total = results.length;
  const correct = tagged + alreadyCorrect;
  const notSupported = results.filter((result) => result.status === 'not-supported').length;
  const permissionRequired = results.filter((result) => result.status === 'permission-required').length;
  const failedCount = results.filter((result) => result.status === 'failed').length;
  return {
    headline:
      `${correct} of ${total} resources correctly tagged · ${notSupported} not supported by Databricks · ` +
      `${permissionRequired} need workspace grants · ${failedCount} failed after retries.`,
    total,
    correct,
    tagged,
    alreadyCorrect,
    notSupported,
    permissionRequired,
    failed: failedCount,
    results,
  };
}

function errorStatus(error: unknown): number {
  const shape = error as { statusCode?: unknown; status?: unknown };
  return Number(shape?.statusCode ?? shape?.status ?? 0);
}

async function workspaceTagPlatform(): Promise<ResourceTagPlatform> {
  const { WorkspaceClient } = await import('@databricks/sdk-experimental');
  /**
   * The SDK otherwise retries for five minutes by default. Settings is an
   * interactive repair action, so that policy turns one slow Lakebase response
   * into a button that appears hung. Astrolabe owns the shorter, visible retry
   * policy above; each underlying request is also bounded so one attempt cannot
   * consume that entire interaction budget by itself.
   */
  const client = new WorkspaceClient({ httpTimeoutSeconds: 5, retryTimeoutSeconds: 0 });
  const jsonHeaders = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' });
  const appTagPath = (appName: string) =>
    `/api/2.0/entity-tag-assignments/apps/${encodeURIComponent(appName)}/tags/${ASTROLABE_TAG.key}`;

  return {
    async getAppTag(appName) {
      try {
        const body = (await client.apiClient.request({
          path: appTagPath(appName),
          method: 'GET',
          headers: jsonHeaders,
          raw: false,
        })) as { tag_value?: unknown };
        return typeof body?.tag_value === 'string' ? body.tag_value : '';
      } catch (error) {
        if (errorStatus(error) === 404) return null;
        throw error;
      }
    },
    async createAppTag(appName) {
      await client.apiClient.request({
        path: '/api/2.0/entity-tag-assignments',
        method: 'POST',
        headers: jsonHeaders,
        payload: {
          entity_type: 'apps',
          entity_id: appName,
          tag_key: ASTROLABE_TAG.key,
          tag_value: ASTROLABE_TAG.value,
        },
        raw: false,
      });
    },
    async updateAppTag(appName) {
      await client.apiClient.request({
        path: appTagPath(appName),
        method: 'PATCH',
        headers: jsonHeaders,
        query: { update_mask: 'tag_value' },
        payload: { tag_value: ASTROLABE_TAG.value },
        raw: false,
      });
    },
    async getServingTags(name) {
      return (await client.servingEndpoints.get({ name })).tags ?? [];
    },
    async addServingTag(name) {
      await client.servingEndpoints.patch({ name, add_tags: [{ ...ASTROLABE_TAG }] });
    },
    async deleteServingTag(name, key) {
      await client.servingEndpoints.patch({ name, delete_tags: [key] });
    },
    async getModelTags(name) {
      return (await client.modelRegistry.getModel({ name })).registered_model_databricks?.tags ?? [];
    },
    async setModelTag(name) {
      await client.modelRegistry.setModelTag({ name, ...ASTROLABE_TAG });
    },
    async deleteModelTag(name, key) {
      await client.modelRegistry.deleteModelTag({ name, key });
    },
    async getModelVersionTags(name, version) {
      return (await client.modelRegistry.getModelVersion({ name, version })).model_version?.tags ?? [];
    },
    async setModelVersionTag(name, version) {
      await client.modelRegistry.setModelVersionTag({ name, version, ...ASTROLABE_TAG });
    },
    async deleteModelVersionTag(name, version, key) {
      await client.modelRegistry.deleteModelVersionTag({ name, version, key });
    },
    async getExperimentTags(experimentId) {
      return (await client.experiments.getExperiment({ experiment_id: experimentId })).experiment?.tags ?? [];
    },
    async setExperimentTag(experimentId) {
      await client.experiments.setExperimentTag({ experiment_id: experimentId, ...ASTROLABE_TAG });
    },
    async deleteExperimentTag(experimentId, key) {
      await client.apiClient.request({
        path: '/api/2.0/mlflow/experiments/delete-experiment-tag',
        method: 'POST',
        headers: jsonHeaders,
        payload: { experiment_id: experimentId, key },
        raw: false,
      });
    },
    async getWarehouseTags(warehouseId) {
      return (await client.warehouses.get({ id: warehouseId })).tags?.custom_tags ?? [];
    },
    async setWarehouseTags(warehouseId, tags) {
      await client.warehouses.edit({
        id: warehouseId,
        tags: {
          custom_tags: tags.map((tag) => ({ key: tag.key ?? '', value: tag.value ?? '' })),
        },
      });
    },
    async getLakebaseTags(projectName) {
      const project = (await client.apiClient.request({
        path: `/api/2.0/postgres/${projectName}`,
        method: 'GET',
        headers: jsonHeaders,
        raw: false,
      })) as { spec?: { custom_tags?: KeyValueTag[] } };
      return project.spec?.custom_tags ?? [];
    },
    async setLakebaseTags(projectName, tags) {
      await client.apiClient.request({
        path: `/api/2.0/postgres/${projectName}`,
        method: 'PATCH',
        headers: jsonHeaders,
        query: { update_mask: 'spec.custom_tags' },
        payload: {
          spec: {
            custom_tags: tags.map((tag) => ({ key: tag.key ?? '', value: tag.value ?? '' })),
          },
        },
        raw: false,
      });
    },
    async getVectorIndexEndpoint(indexName) {
      const endpoint = (await client.vectorSearchIndexes.getIndex({ index_name: indexName })).endpoint_name?.trim();
      if (!endpoint) throw new Error(`Vector Search index ${indexName} did not report its endpoint.`);
      return endpoint;
    },
    async getVectorEndpointTags(endpointName) {
      return (await client.vectorSearchEndpoints.getEndpoint({ endpoint_name: endpointName })).custom_tags ?? [];
    },
    async setVectorEndpointTags(endpointName, tags) {
      await client.vectorSearchEndpoints.updateEndpointCustomTags({
        endpoint_name: endpointName,
        custom_tags: tags.map((tag) => ({ key: tag.key ?? '', value: tag.value ?? '' })),
      });
    },
  };
}
