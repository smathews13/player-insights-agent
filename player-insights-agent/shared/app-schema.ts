/**
 * The Postgres schema the app creates and owns inside Lakebase.
 *
 * ONE SOURCE. `var.lakebase_app_schema` in databricks.yml, the
 * `PLAYER_INSIGHTS_APP_SCHEMA` env the release bakes into app.yaml, the DDL that
 * creates the schema, the grant script that privileges it, and the Connections
 * row that names it all resolve through this module. The default stays
 * `player_insights` so existing installs do not silently move.
 *
 * Changing the schema on a live deployment is a deliberate migration, not a
 * hot swap: set the bundle var, release the app (so the env updates), grant on
 * the new schema, and migrate data. The Connections page shows the live env
 * value, never "not set".
 */

/** The compiled default; must match `var.lakebase_app_schema`'s default. */
export const DEFAULT_APP_SCHEMA = 'player_insights';

/** The env name the release and app.yaml use. */
export const APP_SCHEMA_ENV = 'PLAYER_INSIGHTS_APP_SCHEMA';

/**
 * Resolve the schema name from an environment map.
 *
 * Empty or whitespace falls through to {@link DEFAULT_APP_SCHEMA}, matching how
 * other safe-to-bake app defaults behave when a From-Git deploy leaves a slot
 * blank.
 */
export function resolveAppSchema(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const fromEnv = (env[APP_SCHEMA_ENV] ?? '').trim();
  return fromEnv || DEFAULT_APP_SCHEMA;
}

/**
 * The schema this process is using. Read once at module load from
 * `process.env`, so a mid-process env change is ignored (same as other
 * deployment constants). Tests that need a different schema must set the env
 * before importing this module, or call {@link resolveAppSchema} directly.
 */
export const APP_SCHEMA = resolveAppSchema();

/** Qualify a bare table name: `admin_emails` → `player_insights.admin_emails`. */
export function appTable(name: string): string {
  return `${APP_SCHEMA}.${name}`;
}
