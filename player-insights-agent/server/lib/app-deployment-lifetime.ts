import { appTable } from '../../shared/app-schema';

export const APP_DEPLOYMENT_LIFETIME_TABLE = appTable('app_deployment_lifetime');
export const APP_DEPLOYMENT_HISTORY_PATH = '/api/2.0/apps';

export const APP_DEPLOYMENT_LIFETIME_DDL = `CREATE TABLE IF NOT EXISTS ${APP_DEPLOYMENT_LIFETIME_TABLE} (
  app_scope TEXT PRIMARY KEY,
  first_deployed_at TIMESTAMPTZ NOT NULL,
  evidence TEXT NOT NULL CHECK (evidence IN ('apps_deployment_history', 'durable_app_activity')),
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

/**
 * Version 40 extends the existing lifetime fact instead of creating a second
 * deployment-owner table. `app_scope` is already the singleton key, so the
 * database can hold zero or one owner identity for one app deployment.
 */
export const ADD_FIRST_DEPLOYED_BY_STATEMENT =
  `ALTER TABLE ${APP_DEPLOYMENT_LIFETIME_TABLE} ` + `ADD COLUMN IF NOT EXISTS first_deployed_by TEXT`;

export const READ_APP_DEPLOYMENT_LIFETIME_QUERY = `SELECT first_deployed_at, first_deployed_by, evidence
FROM ${APP_DEPLOYMENT_LIFETIME_TABLE}
WHERE app_scope = $1`;

export const WRITE_APP_DEPLOYMENT_LIFETIME_QUERY = `INSERT INTO ${APP_DEPLOYMENT_LIFETIME_TABLE}
  (app_scope, first_deployed_at, evidence, first_deployed_by, resolved_at)
VALUES ($1, $2::timestamptz, $3, NULLIF($4, ''), NOW())
ON CONFLICT (app_scope) DO UPDATE SET
  first_deployed_at = LEAST(${APP_DEPLOYMENT_LIFETIME_TABLE}.first_deployed_at, EXCLUDED.first_deployed_at),
  evidence = CASE
    WHEN EXCLUDED.first_deployed_at < ${APP_DEPLOYMENT_LIFETIME_TABLE}.first_deployed_at
      THEN EXCLUDED.evidence
    ELSE ${APP_DEPLOYMENT_LIFETIME_TABLE}.evidence
  END,
  first_deployed_by = CASE
    WHEN EXCLUDED.first_deployed_at < ${APP_DEPLOYMENT_LIFETIME_TABLE}.first_deployed_at
      THEN EXCLUDED.first_deployed_by
    WHEN EXCLUDED.first_deployed_at = ${APP_DEPLOYMENT_LIFETIME_TABLE}.first_deployed_at
      THEN COALESCE(${APP_DEPLOYMENT_LIFETIME_TABLE}.first_deployed_by, EXCLUDED.first_deployed_by)
    ELSE ${APP_DEPLOYMENT_LIFETIME_TABLE}.first_deployed_by
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
  /** Normalized creator of the earliest successful Apps deployment, or empty when unprovable. */
  deployedBy: string;
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

function identity(value: unknown): string {
  return text(value).toLocaleLowerCase();
}

export function earliestSuccessfulDeploymentRecord(pages: readonly DeploymentHistoryPage[]): FirstAppDeployment | null {
  const earliest =
    pages
      .flatMap((page): unknown[] => (Array.isArray(page.app_deployments) ? (page.app_deployments as unknown[]) : []))
      .flatMap((raw) => {
        const deployment = object(raw);
        const state = text(object(deployment.status).state).toUpperCase();
        const deployedAt = stamp(deployment.create_time);
        return state === 'SUCCEEDED' && deployedAt
          ? [{ deployedAt, deployedBy: identity(deployment.creator), evidence: 'apps_deployment_history' as const }]
          : [];
      })
      .sort((left, right) => left.deployedAt.localeCompare(right.deployedAt))[0] ?? null;
  return earliest;
}

export function earliestSuccessfulDeployment(pages: readonly DeploymentHistoryPage[]): string {
  return earliestSuccessfulDeploymentRecord(pages)?.deployedAt ?? '';
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
  return (
    Object.keys(object(response.git_repository)).length > 0 ||
    Object.keys(object(object(response.active_deployment).git_source)).length > 0
  );
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
    let found: FirstAppDeployment | null = null;
    try {
      const saved = await input.store.query(READ_APP_DEPLOYMENT_LIFETIME_QUERY, [scope]);
      const deployedAt = stamp(saved.rows[0]?.first_deployed_at);
      const deployedBy = identity(saved.rows[0]?.first_deployed_by);
      const evidence = text(saved.rows[0]?.evidence);
      if (deployedAt && (evidence === 'apps_deployment_history' || evidence === 'durable_app_activity')) {
        const persisted: FirstAppDeployment = { deployedAt, deployedBy, evidence };
        // A creator from complete Apps history is final. Old rows and activity
        // fallbacks have no creator, so make one bounded history read to upgrade
        // them rather than guessing from the roster or current deployer.
        if (deployedBy && evidence === 'apps_deployment_history') return persisted;
        found = persisted;
      }
    } catch {
      // A Git install may not have applied the additive migration yet. Continue
      // to the control plane, but do not claim the result is persisted.
    }

    let gitBacked = false;
    try {
      const pages = await readAllDeploymentHistory(appName, input.readHistory ?? workspaceDeploymentHistoryReader);
      const history = earliestSuccessfulDeploymentRecord(pages);
      if (history && (!found || history.deployedAt < found.deployedAt)) found = history;
      gitBacked = pages.some((page) =>
        (Array.isArray(page.app_deployments) ? (page.app_deployments as unknown[]) : []).some(
          (raw) => Object.keys(object(object(raw).git_source)).length > 0
        )
      );
      if (!gitBacked) gitBacked = await (input.readAppSource ?? workspaceGitAppSourceReader)(appName);
    } catch (error) {
      console.warn(`[ops] App deployment history could not be read: ${(error as Error).message}`);
      try {
        gitBacked = await (input.readAppSource ?? workspaceGitAppSourceReader)(appName);
      } catch {
        gitBacked = false;
      }
    }

    if (gitBacked) {
      try {
        const activity = await input.store.query(FIRST_DURABLE_APP_ACTIVITY_QUERY);
        const deployedAt = stamp(activity.rows[0]?.first_active_at);
        if (deployedAt && (!found || deployedAt < found.deployedAt)) {
          found = { deployedAt, deployedBy: '', evidence: 'durable_app_activity' };
        }
      } catch {
        // No proof means no history. The caller renders the unavailable reason.
      }
    }
    if (!found) return null;

    try {
      await input.store.query(WRITE_APP_DEPLOYMENT_LIFETIME_QUERY, [
        scope,
        found.deployedAt,
        found.evidence,
        found.deployedBy,
      ]);
    } catch (error) {
      console.warn(`[ops] First app deployment evidence could not be persisted: ${(error as Error).message}`);
    }
    return found;
  })();
  resolved.set(scope, pending);
  return pending;
}

/** Deployment Owner is provenance, not a role. Missing proof produces no owner. */
export async function deploymentOwnerEmail(
  store: LakebaseStore,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const result = await resolveFirstAppDeployment({
    store,
    appName: env.DATABRICKS_APP_NAME ?? '',
    workspaceId: env.DATABRICKS_WORKSPACE_ID ?? '',
  });
  return result?.deployedBy ?? '';
}
