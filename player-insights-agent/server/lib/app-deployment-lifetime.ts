import { appTable } from '../../shared/app-schema';

export const APP_DEPLOYMENT_LIFETIME_TABLE = appTable('app_deployment_lifetime');
export const APP_DEPLOYMENT_HISTORY_PATH = '/api/2.0/apps';

export const APP_DEPLOYMENT_LIFETIME_DDL = `CREATE TABLE IF NOT EXISTS ${APP_DEPLOYMENT_LIFETIME_TABLE} (
  app_scope TEXT PRIMARY KEY,
  first_deployed_at TIMESTAMPTZ NOT NULL,
  evidence TEXT NOT NULL CHECK (evidence IN ('apps_deployment_history', 'durable_app_activity')),
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

export const READ_APP_DEPLOYMENT_LIFETIME_QUERY = `SELECT first_deployed_at, evidence
FROM ${APP_DEPLOYMENT_LIFETIME_TABLE}
WHERE app_scope = $1`;

export const WRITE_APP_DEPLOYMENT_LIFETIME_QUERY = `INSERT INTO ${APP_DEPLOYMENT_LIFETIME_TABLE}
  (app_scope, first_deployed_at, evidence, resolved_at)
VALUES ($1, $2::timestamptz, $3, NOW())
ON CONFLICT (app_scope) DO UPDATE SET
  first_deployed_at = LEAST(${APP_DEPLOYMENT_LIFETIME_TABLE}.first_deployed_at, EXCLUDED.first_deployed_at),
  evidence = CASE
    WHEN ${APP_DEPLOYMENT_LIFETIME_TABLE}.evidence = 'apps_deployment_history'
      THEN ${APP_DEPLOYMENT_LIFETIME_TABLE}.evidence
    ELSE EXCLUDED.evidence
  END,
  resolved_at = NOW()`;

/**
 * Git deployments can retain their app-owned Lakebase schema even when the
 * deployment-history read is unavailable. This is the only fallback: durable
 * activity proves the app was running by this instant, while resource creation
 * and billing rows do not.
 */
export const FIRST_DURABLE_APP_ACTIVITY_QUERY = `SELECT LEAST(
  (SELECT MIN(completed_at) FROM ${appTable('runs')} WHERE state = 'SUCCEEDED'),
  (SELECT MIN(created_at) FROM ${appTable('messages')}),
  (SELECT MIN(active_minute) FROM ${appTable('app_activity_minutes')})
) AS first_active_at`;

interface LakebaseStore {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface FirstAppDeployment {
  deployedAt: string;
  evidence: 'apps_deployment_history' | 'durable_app_activity';
}

interface DeploymentHistoryPage {
  app_deployments?: unknown;
  next_page_token?: unknown;
}

export type DeploymentHistoryReader = (appName: string, pageToken?: string) => Promise<DeploymentHistoryPage>;
export type AppSourceReader = (appName: string) => Promise<boolean>;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stamp(value: unknown): string {
  const raw = value instanceof Date ? value.toISOString() : typeof value === 'string' ? value.trim() : '';
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function earliestSuccessfulDeployment(pages: readonly DeploymentHistoryPage[]): string {
  return (
    pages
      .flatMap((page): unknown[] => (Array.isArray(page.app_deployments) ? (page.app_deployments as unknown[]) : []))
      .flatMap((raw) => {
        const deployment = object(raw);
        const state = text(object(deployment.status).state).toUpperCase();
        const created = stamp(deployment.create_time);
        return state === 'SUCCEEDED' && created ? [created] : [];
      })
      .sort()[0] ?? ''
  );
}

export const workspaceDeploymentHistoryReader: DeploymentHistoryReader = async (appName, pageToken) => {
  const { WorkspaceClient } = await import('@databricks/sdk-experimental');
  const client = new WorkspaceClient({});
  return (await client.apiClient.request({
    path: `${APP_DEPLOYMENT_HISTORY_PATH}/${encodeURIComponent(appName)}/deployments`,
    method: 'GET',
    query: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    headers: new Headers({ Accept: 'application/json' }),
    raw: false,
  })) as DeploymentHistoryPage;
};

export const workspaceGitAppSourceReader: AppSourceReader = async (appName) => {
  const { WorkspaceClient } = await import('@databricks/sdk-experimental');
  const client = new WorkspaceClient({});
  const response = (await client.apiClient.request({
    path: `${APP_DEPLOYMENT_HISTORY_PATH}/${encodeURIComponent(appName)}`,
    method: 'GET',
    headers: new Headers({ Accept: 'application/json' }),
    raw: false,
  })) as Record<string, unknown>;
  return Object.keys(object(object(response.active_deployment).git_source)).length > 0;
};

async function readAllDeploymentHistory(
  appName: string,
  read: DeploymentHistoryReader
): Promise<DeploymentHistoryPage[]> {
  const pages: DeploymentHistoryPage[] = [];
  let pageToken = '';
  for (let page = 0; page < 100; page += 1) {
    const result = await read(appName, pageToken || undefined);
    pages.push(result);
    const next = text(result.next_page_token);
    if (!next || next === pageToken) return pages;
    pageToken = next;
  }
  throw new Error('App deployment history exceeded the bounded pagination limit.');
}

const resolved = new Map<string, Promise<FirstAppDeployment | null>>();

export function forgetFirstAppDeployments(): void {
  resolved.clear();
}

/**
 * Resolve once per process, prefer the durable Lakebase fact, then the complete
 * successful Apps deployment history, and finally app-owned durable activity.
 * A missing answer stays missing: no resource timestamp or billing row is used.
 */
export function resolveFirstAppDeployment(input: {
  store: LakebaseStore;
  appName: string;
  workspaceId: string;
  readHistory?: DeploymentHistoryReader;
  readAppSource?: AppSourceReader;
}): Promise<FirstAppDeployment | null> {
  const appName = input.appName.trim();
  const workspaceId = input.workspaceId.trim();
  if (!appName || !workspaceId) return Promise.resolve(null);
  const scope = `${workspaceId}:${appName}`;
  const existing = resolved.get(scope);
  if (existing) return existing;

  const pending = (async (): Promise<FirstAppDeployment | null> => {
    try {
      const saved = await input.store.query(READ_APP_DEPLOYMENT_LIFETIME_QUERY, [scope]);
      const deployedAt = stamp(saved.rows[0]?.first_deployed_at);
      const evidence = text(saved.rows[0]?.evidence);
      if (deployedAt && (evidence === 'apps_deployment_history' || evidence === 'durable_app_activity')) {
        return { deployedAt, evidence };
      }
    } catch {
      // A Git install may not have applied the additive migration yet. Continue
      // to the control plane, but do not claim the result is persisted.
    }

    let found: FirstAppDeployment | null = null;
    let gitBacked = false;
    try {
      const pages = await readAllDeploymentHistory(appName, input.readHistory ?? workspaceDeploymentHistoryReader);
      const deployedAt = earliestSuccessfulDeployment(pages);
      if (deployedAt) found = { deployedAt, evidence: 'apps_deployment_history' };
      gitBacked = pages.some((page) =>
        (Array.isArray(page.app_deployments) ? (page.app_deployments as unknown[]) : []).some(
          (raw) => Object.keys(object(object(raw).git_source)).length > 0
        )
      );
    } catch (error) {
      console.warn(`[ops] App deployment history could not be read: ${(error as Error).message}`);
      try {
        gitBacked = await (input.readAppSource ?? workspaceGitAppSourceReader)(appName);
      } catch {
        gitBacked = false;
      }
    }

    if (!found && gitBacked) {
      try {
        const activity = await input.store.query(FIRST_DURABLE_APP_ACTIVITY_QUERY);
        const deployedAt = stamp(activity.rows[0]?.first_active_at);
        if (deployedAt) found = { deployedAt, evidence: 'durable_app_activity' };
      } catch {
        // No proof means no history. The caller renders the unavailable reason.
      }
    }
    if (!found) return null;

    try {
      await input.store.query(WRITE_APP_DEPLOYMENT_LIFETIME_QUERY, [scope, found.deployedAt, found.evidence]);
    } catch (error) {
      console.warn(`[ops] First app deployment evidence could not be persisted: ${(error as Error).message}`);
    }
    return found;
  })();
  resolved.set(scope, pending);
  return pending;
}
