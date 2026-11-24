/**
 * The deployment's own configuration, one row per variable, with history.
 *
 * Deploy from Git replaces app.yaml, so the values a release filled in (catalog,
 * schema, Genie spaces, model endpoints, experiment, groups) have to live in the
 * app's own store. They used to be one JSON blob in `deployment_decisions`; that
 * is still written for one release so a rollback finds what it expects, and still
 * read when this table has nothing yet, which also copies it across.
 *
 * Variables are grouped by scope so a later writer with a different owner cannot
 * erase a bundle release's values: each scope is replaced only by its own writer.
 *
 * Secrets never come here.
 */
import { appTable } from '../../shared/app-schema';
import {
  DEPLOYMENT_DECISIONS_TABLE_NAME,
  readDeploymentDecision,
  recordDeploymentDecision,
  type DecisionStore,
} from './deployment-decisions';

export const DEPLOYMENT_VARIABLES_TABLE_NAME = 'deployment_variables';
export const DEPLOYMENT_VARIABLE_HISTORY_TABLE_NAME = 'deployment_variable_history';

export type VariableScope = 'release';

/** How a value got here, shown to admins beside it. */
export type VariableSource = 'release' | 'migrated';

export const VARIABLE_SCOPES: readonly VariableScope[] = ['release'];

function variablesTable(): string {
  return appTable(DEPLOYMENT_VARIABLES_TABLE_NAME);
}

function historyTable(): string {
  return appTable(DEPLOYMENT_VARIABLE_HISTORY_TABLE_NAME);
}

export function deploymentVariablesDdl(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${variablesTable()} (
       scope TEXT NOT NULL,
       name TEXT NOT NULL,
       value TEXT NOT NULL,
       source TEXT NOT NULL,
       revision INTEGER NOT NULL DEFAULT 1,
       updated_by TEXT NOT NULL,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (scope, name)
     )`,
    `CREATE TABLE IF NOT EXISTS ${historyTable()} (
       id BIGSERIAL PRIMARY KEY,
       scope TEXT NOT NULL,
       name TEXT NOT NULL,
       value TEXT,
       source TEXT NOT NULL,
       revision INTEGER NOT NULL,
       changed_by TEXT NOT NULL,
       changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    `CREATE INDEX IF NOT EXISTS deployment_variable_history_name_idx
       ON ${historyTable()} (scope, name, changed_at DESC)`,
  ];
}

export function deploymentVariablesDown(): string[] {
  return [`DROP TABLE IF EXISTS ${historyTable()}`, `DROP TABLE IF EXISTS ${variablesTable()}`];
}

/** The legacy blob each scope was stored as before this table. */
const LEGACY_DECISION: Record<VariableScope, string> = {
  release: 'release_environment_v1',
};

function legacyTable(): string {
  return appTable(DEPLOYMENT_DECISIONS_TABLE_NAME);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      typeof entry === 'string' && entry.trim() ? [[key, entry.trim()] as const] : []
    )
  );
}

function parseLegacy(value: string | null): Record<string, string> | null {
  if (!value) return null;
  try {
    return stringRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Rows in one scope, or null when there are none or they cannot be read. */
async function readScopeRows(store: DecisionStore, scope: VariableScope): Promise<Record<string, string> | null> {
  try {
    const result = await store.query(`SELECT name, value FROM ${variablesTable()} WHERE scope = $1`, [scope]);
    const values = Object.fromEntries(
      (result.rows ?? []).flatMap((row) =>
        typeof row.name === 'string' && typeof row.value === 'string' ? [[row.name, row.value] as const] : []
      )
    );
    return Object.keys(values).length > 0 ? values : null;
  } catch {
    return null;
  }
}

/**
 * Replace one scope with `values`, recording a history row for every value that
 * changed or was removed. Unchanged values write nothing, so a release boot that
 * restates the same configuration leaves no trail, except that a value copied
 * from the legacy blob takes the first real writer's source without a new
 * revision. Never throws.
 */
export async function writeVariableScope(
  store: DecisionStore,
  scope: VariableScope,
  values: Record<string, string>,
  source: VariableSource,
  actor: string
): Promise<boolean> {
  const entries = Object.entries(stringRecord(values));
  const table = variablesTable();
  try {
    await store.query(
      `WITH input(name, value) AS (
         SELECT * FROM unnest($2::text[], $3::text[])
       ),
       removed AS (
         DELETE FROM ${table} v
          WHERE v.scope = $1 AND NOT EXISTS (SELECT 1 FROM input i WHERE i.name = v.name)
          RETURNING v.name, v.revision
       ),
       upserted AS (
         INSERT INTO ${table} AS v (scope, name, value, source, revision, updated_by, updated_at)
         SELECT $1, i.name, i.value, $4, 1, $5, now() FROM input i
         ON CONFLICT (scope, name) DO UPDATE
           SET value = EXCLUDED.value, source = EXCLUDED.source,
               revision = v.revision + CASE WHEN v.value IS DISTINCT FROM EXCLUDED.value THEN 1 ELSE 0 END,
               updated_by = EXCLUDED.updated_by, updated_at = now()
           WHERE v.value IS DISTINCT FROM EXCLUDED.value OR v.source = 'migrated'
         RETURNING v.name, v.value, v.revision
       ),
       previous AS (
         SELECT p.name, p.value FROM ${table} p WHERE p.scope = $1
       ),
       history AS (
         INSERT INTO ${historyTable()} (scope, name, value, source, revision, changed_by)
         SELECT $1, u.name, u.value, $4, u.revision, $5 FROM upserted u
          WHERE NOT EXISTS (SELECT 1 FROM previous p WHERE p.name = u.name AND p.value = u.value)
         UNION ALL
         SELECT $1, name, NULL, $4, revision + 1, $5 FROM removed
       )
       SELECT (SELECT count(*) FROM upserted) + (SELECT count(*) FROM removed) AS changed`,
      [scope, entries.map(([name]) => name), entries.map(([, value]) => value), source, actor]
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The scope's values as the JSON object its callers already parse, or null.
 *
 * Reads this table first. When it holds nothing for the scope, falls back to the
 * legacy blob and copies it across, so the first boot after this change moves
 * the deployment's configuration without a migration that could fail on a
 * malformed blob.
 */
export async function readVariableScope(store: DecisionStore, scope: VariableScope): Promise<string | null> {
  const rows = await readScopeRows(store, scope);
  if (rows) return JSON.stringify(rows);
  const legacy = parseLegacy(await readDeploymentDecision(store, legacyTable(), LEGACY_DECISION[scope]));
  if (!legacy || Object.keys(legacy).length === 0) return null;
  await writeVariableScope(store, scope, legacy, 'migrated', 'deployment variables migration');
  return JSON.stringify(legacy);
}

/**
 * Save one scope here and, for one release, in its legacy blob too. Succeeds only
 * when this table took the write, because reads prefer this table.
 */
export async function recordVariableScope(
  store: DecisionStore,
  scope: VariableScope,
  values: Record<string, string>,
  source: VariableSource,
  actor: string
): Promise<boolean> {
  const saved = await writeVariableScope(store, scope, values, source, actor);
  await recordDeploymentDecision(store, legacyTable(), LEGACY_DECISION[scope], JSON.stringify(values), actor);
  return saved;
}

export interface DeploymentVariableRow {
  scope: VariableScope;
  name: string;
  value: string;
  source: VariableSource;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}

function isoTime(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? new Date(value).toISOString() : '';
}

/** Every saved variable, for the read-only admin view. Throws when unreadable. */
export async function listDeploymentVariables(store: DecisionStore): Promise<DeploymentVariableRow[]> {
  const result = await store.query(
    `SELECT scope, name, value, source, revision, updated_by, updated_at
       FROM ${variablesTable()} ORDER BY scope, name`
  );
  return (result.rows ?? []).map((row) => ({
    scope: row.scope as VariableScope,
    name: String(row.name),
    value: String(row.value),
    source: row.source as VariableSource,
    revision: Number(row.revision),
    updatedBy: String(row.updated_by),
    updatedAt: isoTime(row.updated_at),
  }));
}
