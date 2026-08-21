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

export const ASTROLABE_TAG = { key: 'astrolabe', value: 'true' } as const;

export type ResourceTagKind =
  | 'app'
  | 'registered-model'
  | 'model-version'
  | 'mlflow-experiment'
  | 'serving-endpoint'
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
  status: 'tagged' | 'already-tagged' | 'skipped' | 'failed';
  detail: string;
}

export interface ResourceTagSummary {
  tagged: number;
  alreadyTagged: number;
  skipped: number;
  failed: number;
  results: ResourceTagResult[];
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
  getModelTags(name: string): Promise<KeyValueTag[]>;
  setModelTag(name: string): Promise<void>;
  getModelVersionTags(name: string, version: string): Promise<KeyValueTag[]>;
  setModelVersionTag(name: string, version: string): Promise<void>;
  getExperimentTags(experimentId: string): Promise<KeyValueTag[]>;
  setExperimentTag(experimentId: string): Promise<void>;
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
      reason: 'Vector Search indexes do not have a custom tag API. Their endpoint can be tagged.',
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
  return targets;
}

function hasTag(tags: readonly KeyValueTag[]): boolean {
  return tags.some((tag) => tag.key === ASTROLABE_TAG.key && tag.value === ASTROLABE_TAG.value);
}

function mergeTag(tags: readonly KeyValueTag[]): KeyValueTag[] {
  return [...tags.filter((tag) => tag.key !== ASTROLABE_TAG.key), { ...ASTROLABE_TAG }];
}

function failed(target: ResourceTagTarget, error: unknown): ResourceTagResult {
  const raw = error instanceof Error ? error.message : String(error);
  let detail = raw.split('\n')[0].trim().slice(0, 240) || 'Databricks did not complete the update.';
  if (/permission|forbidden|unauthori[sz]ed|403/i.test(detail)) {
    if (target.kind === 'sql-warehouse') {
      detail += ' The app service principal needs CAN_MANAGE (or ownership) on this SQL warehouse to set cost tags.';
    } else if (target.kind === 'lakebase') {
      detail += ' The app service principal needs permission to update this Lakebase project.';
    } else if (
      target.kind === 'registered-model' ||
      target.kind === 'model-version' ||
      target.kind === 'mlflow-experiment'
    ) {
      detail += ' Grant the app service principal management permission on this MLflow resource.';
    }
  }
  return { ...target, status: 'failed', detail };
}

async function tagTarget(target: ResourceTagTarget, platform: ResourceTagPlatform): Promise<ResourceTagResult> {
  if (target.action === 'skip') {
    return { ...target, status: 'skipped', detail: target.reason ?? 'This resource cannot be tagged.' };
  }
  try {
    if (target.kind === 'app') {
      const current = await platform.getAppTag(target.name);
      if (current === ASTROLABE_TAG.value) {
        return { ...target, status: 'already-tagged', detail: 'Already tagged astrolabe=true.' };
      }
      if (current === null) await platform.createAppTag(target.name);
      else await platform.updateAppTag(target.name);
      return { ...target, status: 'tagged', detail: 'Tagged astrolabe=true.' };
    }
    if (target.kind === 'serving-endpoint') {
      const tags = await platform.getServingTags(target.name);
      if (hasTag(tags)) {
        return { ...target, status: 'already-tagged', detail: 'Already tagged astrolabe=true.' };
      }
      await platform.addServingTag(target.name);
      return { ...target, status: 'tagged', detail: 'Tagged astrolabe=true.' };
    }
    if (target.kind === 'registered-model') {
      if (hasTag(await platform.getModelTags(target.name))) {
        return { ...target, status: 'already-tagged', detail: 'Already tagged astrolabe=true.' };
      }
      await platform.setModelTag(target.name);
      return { ...target, status: 'tagged', detail: 'Tagged astrolabe=true.' };
    }
    if (target.kind === 'model-version') {
      const version = target.version;
      if (!version) throw new Error('The connected agent model version was not resolved.');
      if (hasTag(await platform.getModelVersionTags(target.name, version))) {
        return { ...target, status: 'already-tagged', detail: 'Already tagged astrolabe=true.' };
      }
      await platform.setModelVersionTag(target.name, version);
      return { ...target, status: 'tagged', detail: 'Tagged astrolabe=true.' };
    }
    if (target.kind === 'mlflow-experiment') {
      if (hasTag(await platform.getExperimentTags(target.name))) {
        return { ...target, status: 'already-tagged', detail: 'Already tagged astrolabe=true.' };
      }
      await platform.setExperimentTag(target.name);
      return { ...target, status: 'tagged', detail: 'Tagged astrolabe=true.' };
    }
    if (target.kind === 'sql-warehouse') {
      const tags = await platform.getWarehouseTags(target.name);
      if (hasTag(tags)) {
        return { ...target, status: 'already-tagged', detail: 'Already tagged astrolabe=true.' };
      }
      await platform.setWarehouseTags(target.name, mergeTag(tags));
      return { ...target, status: 'tagged', detail: 'Tagged astrolabe=true.' };
    }
    if (target.kind === 'lakebase') {
      const tags = await platform.getLakebaseTags(target.name);
      if (hasTag(tags)) {
        return { ...target, status: 'already-tagged', detail: 'Already tagged astrolabe=true.' };
      }
      await platform.setLakebaseTags(target.name, mergeTag(tags));
      return { ...target, status: 'tagged', detail: 'Tagged astrolabe=true.' };
    }
    return {
      ...target,
      status: 'skipped',
      detail: target.reason ?? 'This connected resource is not managed by Astrolabe.',
    };
  } catch (error) {
    return failed(target, error);
  }
}

/**
 * Apply tags with the app service principal. The caller provides no user token;
 * the production adapter below creates WorkspaceClient with Apps-injected
 * credentials.
 */
export async function applyAstrolabeTags(input: {
  report: PreflightReport | null;
  environment?: NodeJS.ProcessEnv;
  platform?: ResourceTagPlatform;
}): Promise<ResourceTagSummary> {
  const platform = input.platform ?? (await workspaceTagPlatform());
  const targets = resourceTagInventory({ environment: input.environment, report: input.report });
  const results: ResourceTagResult[] = [];

  for (const target of targets) {
    results.push(await tagTarget(target, platform));
    if (target.kind !== 'vector-index' || target.action !== 'skip') continue;
    try {
      const endpointName = await platform.getVectorIndexEndpoint(target.name);
      const endpoint: ResourceTagTarget = {
        kind: 'vector-endpoint',
        name: endpointName,
        label: `Vector Search endpoint · ${endpointName}`,
        action: 'tag',
      };
      const tags = await platform.getVectorEndpointTags(endpointName);
      if (hasTag(tags)) {
        results.push({ ...endpoint, status: 'already-tagged', detail: 'Already tagged astrolabe=true.' });
      } else {
        await platform.setVectorEndpointTags(endpointName, mergeTag(tags));
        results.push({ ...endpoint, status: 'tagged', detail: 'Tagged astrolabe=true.' });
      }
    } catch (error) {
      results.push(
        failed(
          {
            kind: 'vector-endpoint',
            name: target.name,
            label: 'Vector Search endpoint',
            action: 'tag',
          },
          error
        )
      );
    }
  }

  return {
    tagged: results.filter((result) => result.status === 'tagged' || result.status === 'already-tagged').length,
    alreadyTagged: results.filter((result) => result.status === 'already-tagged').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    failed: results.filter((result) => result.status === 'failed').length,
    results,
  };
}

function errorStatus(error: unknown): number {
  const shape = error as { statusCode?: unknown; status?: unknown };
  return Number(shape?.statusCode ?? shape?.status ?? 0);
}

async function workspaceTagPlatform(): Promise<ResourceTagPlatform> {
  const { WorkspaceClient } = await import('@databricks/sdk-experimental');
  const client = new WorkspaceClient({});
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
    async getModelTags(name) {
      return (await client.modelRegistry.getModel({ name })).registered_model_databricks?.tags ?? [];
    },
    async setModelTag(name) {
      await client.modelRegistry.setModelTag({ name, ...ASTROLABE_TAG });
    },
    async getModelVersionTags(name, version) {
      return (await client.modelRegistry.getModelVersion({ name, version })).model_version?.tags ?? [];
    },
    async setModelVersionTag(name, version) {
      await client.modelRegistry.setModelVersionTag({ name, version, ...ASTROLABE_TAG });
    },
    async getExperimentTags(experimentId) {
      return (await client.experiments.getExperiment({ experiment_id: experimentId })).experiment?.tags ?? [];
    },
    async setExperimentTag(experimentId) {
      await client.experiments.setExperimentTag({ experiment_id: experimentId, ...ASTROLABE_TAG });
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
