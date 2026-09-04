import { APP_SCHEMA } from '../../shared/app-schema';
import type { DesiredLakebaseBinding, LakebaseBinding, LakebaseRedeployPlan } from '../../shared/lakebase-binding';
import { appPageUrl } from './app-metadata';
import type { LakebaseReader } from './lakebase-store';

export const LAKEBASE_BINDING_PLAN_TABLE = `${APP_SCHEMA}.lakebase_binding_plans`;
export const LAKEBASE_BINDING_PLAN_ID = 'desired';

export const LAKEBASE_BINDING_PLAN_DDL = `CREATE TABLE IF NOT EXISTS ${LAKEBASE_BINDING_PLAN_TABLE} (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  branch TEXT NOT NULL,
  database TEXT NOT NULL,
  active_database TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
)`;

const DATABASE_NAME = /^projects\/([^/]+)\/branches\/([^/]+)\/databases\/([^/]+)$/;
const ENDPOINT_NAME = /^projects\/([^/]+)\/branches\/([^/]+)\/endpoints\/([^/]+)$/;

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return '';
}

function shell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function lakebaseBindingFromDatabase(database: string): Omit<LakebaseBinding, 'endpoint' | 'schema'> | null {
  const match = DATABASE_NAME.exec(database.trim());
  if (!match) return null;
  const [, projectId, branchId] = match;
  return {
    project: `projects/${projectId}`,
    branch: `projects/${projectId}/branches/${branchId}`,
    database: database.trim(),
  };
}

/**
 * The binding this process actually received at startup.
 *
 * Runtime environment wins over the Apps control-plane record here. An App
 * resource may have been edited while this process is still serving; until the
 * restart injects the new values, AppKit's pool is still using these ones.
 */
export function activeLakebaseBinding(env: NodeJS.ProcessEnv = process.env): LakebaseBinding {
  const endpoint = text(env.LAKEBASE_ENDPOINT);
  const endpointMatch = ENDPOINT_NAME.exec(endpoint);
  const databaseLeaf = text(env.PGDATABASE);
  if (!endpointMatch) {
    return {
      project: '',
      branch: '',
      database: databaseLeaf,
      endpoint,
      schema: APP_SCHEMA,
    };
  }
  const [, projectId, branchId] = endpointMatch;
  const branch = `projects/${projectId}/branches/${branchId}`;
  return {
    project: `projects/${projectId}`,
    branch,
    database: databaseLeaf ? `${branch}/databases/${databaseLeaf}` : '',
    endpoint,
    schema: APP_SCHEMA,
  };
}

function desiredFromRow(row: Record<string, unknown> | undefined): DesiredLakebaseBinding | null {
  if (!row) return null;
  const database = text(row.database);
  const parsed = lakebaseBindingFromDatabase(database);
  if (!parsed) return null;
  const revision = Number(row.revision);
  const updatedAt = row.updated_at;
  return {
    ...parsed,
    revision: Number.isSafeInteger(revision) && revision > 0 ? revision : 1,
    updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : text(updatedAt),
    updatedBy: text(row.updated_by),
  };
}

export async function readDesiredLakebaseBinding(client: LakebaseReader): Promise<DesiredLakebaseBinding | null> {
  const result = await client.lakebase.query(
    `SELECT project, branch, database, revision, updated_at, updated_by
       FROM ${LAKEBASE_BINDING_PLAN_TABLE}
      WHERE id = $1`,
    [LAKEBASE_BINDING_PLAN_ID]
  );
  return desiredFromRow(result.rows[0]);
}

export class LakebaseBindingPlanConflict extends Error {
  constructor() {
    super(
      'The Lakebase binding plan changed after this editor opened. Reload it, review the newer plan, and try again.'
    );
    this.name = 'LakebaseBindingPlanConflict';
  }
}

export class LakebaseBindingNoOp extends Error {
  constructor() {
    super('That database is already attached to the running app. Nothing was staged.');
    this.name = 'LakebaseBindingNoOp';
  }
}

export async function writeDesiredLakebaseBinding(
  client: LakebaseReader,
  input: {
    database: string;
    expectedRevision: number;
    expectedActiveDatabase: string;
    updatedBy: string;
    active?: LakebaseBinding;
  }
): Promise<DesiredLakebaseBinding> {
  const desired = lakebaseBindingFromDatabase(input.database);
  if (!desired) {
    throw new Error('Choose a full Lakebase database name: projects/.../branches/.../databases/....');
  }
  const active = input.active ?? activeLakebaseBinding();
  if (input.expectedActiveDatabase.trim() !== active.database) throw new LakebaseBindingPlanConflict();
  if (desired.database === active.database) throw new LakebaseBindingNoOp();
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new LakebaseBindingPlanConflict();
  }

  const params = [
    LAKEBASE_BINDING_PLAN_ID,
    desired.project,
    desired.branch,
    desired.database,
    active.database,
    input.updatedBy.trim(),
  ];
  const result =
    input.expectedRevision === 0
      ? await client.lakebase.query(
          `INSERT INTO ${LAKEBASE_BINDING_PLAN_TABLE}
             (id, project, branch, database, active_database, revision, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, 1, $6, now())
           ON CONFLICT (id) DO NOTHING
           RETURNING project, branch, database, revision, updated_at, updated_by`,
          params
        )
      : await client.lakebase.query(
          `UPDATE ${LAKEBASE_BINDING_PLAN_TABLE}
              SET project = $2,
                  branch = $3,
                  database = $4,
                  active_database = $5,
                  revision = revision + 1,
                  updated_by = $6,
                  updated_at = now()
            WHERE id = $1 AND revision = $7
            RETURNING project, branch, database, revision, updated_at, updated_by`,
          [...params, input.expectedRevision]
        );
  const written = desiredFromRow(result.rows[0]);
  if (!written) throw new LakebaseBindingPlanConflict();
  return written;
}

export function lakebaseRedeployCommand(desired: DesiredLakebaseBinding, target: string): string {
  const targetValue = target.trim() || '<target>';
  const projectId = desired.project.slice('projects/'.length);
  const branchId = desired.branch.slice(desired.branch.lastIndexOf('/branches/') + '/branches/'.length);
  const databaseId = desired.database.slice(desired.database.lastIndexOf('/databases/') + '/databases/'.length);
  return [
    `export BUNDLE_VAR_lakebase_project_id=${shell(projectId)}`,
    `export BUNDLE_VAR_lakebase_branch_id=${shell(branchId)}`,
    `export BUNDLE_VAR_lakebase_database_id=${shell(databaseId)}`,
    `databricks bundle deploy -t ${shell(targetValue)}`,
    `TARGET=${shell(targetValue)} bundle/app-db-grant.sh`,
    `TARGET=${shell(targetValue)} bundle/app-release.sh --apply`,
  ].join('\n');
}

export function lakebaseRedeployPlan(input: {
  active?: LakebaseBinding;
  desired: DesiredLakebaseBinding | null;
  target?: string;
  workspaceHost?: string;
  appName?: string;
}): LakebaseRedeployPlan {
  const active = input.active ?? activeLakebaseBinding();
  // A copied branch may carry the plan row that requested it. Once this process
  // reports that exact database as active, the plan is fulfilled rather than
  // remaining a permanent pending banner.
  const desired = input.desired?.database === active.database ? null : input.desired;
  const target = text(input.target);
  return {
    status: desired ? 'redeploy_required' : 'active',
    active,
    desired,
    command: desired ? lakebaseRedeployCommand(desired, target) : '',
    target: target || '<target>',
    targetKnown: Boolean(target),
    appSettingsUrl: appPageUrl({
      host: text(input.workspaceHost),
      appName: text(input.appName),
      workspaceId: '',
    }),
    detail: desired
      ? 'The desired binding is staged only. AppKit is still using the active pool shown above until the App resource is updated and the app restarts.'
      : 'No replacement binding is staged. The active binding comes from the Postgres environment injected into this running app deployment.',
  };
}
