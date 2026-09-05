/**
 * The Postgres schema the app creates and owns inside Lakebase.
 *
 * ONE SOURCE. `var.lakebase_app_schema` in databricks.yml, the
 * `PLAYER_INSIGHTS_APP_SCHEMA` env the release bakes into app.yaml, the DDL that
 * creates the schema, the grant script that privileges it, and the Connections
 * row that names it all resolve through this module.
 *
 * Changing the schema on a live deployment is a deliberate migration, not a
 * hot swap: set the bundle var, release the app (so the env updates), grant on
 * the new schema, and migrate data. The Connections page shows the live env
 * value, never "not set".
 *
 * Direct Deploy-from-Git is the exception that has no bundle variable to
 * resolve. The public app.yaml historically authored `player_insights`, which
 * collides with schemas created by older apps and leaves a new app principal
 * unable to use its own store. A source-only deploy has an empty
 * PLAYER_INSIGHTS_TARGET, so that one legacy authored value resolves to the
 * canonical product-owned default below. Bundle releases fill the target and
 * therefore keep their configured schema, including existing
 * `player_insights` stores and their role rows.
 */

/** The schema a direct Git deployment creates and owns. */
export const DEFAULT_APP_SCHEMA = 'player_insights_agent';

/** The old authored Git fallback, still used by existing bundle targets. */
export const LEGACY_APP_SCHEMA = 'player_insights';

/** The env name the release and app.yaml use. */
export const APP_SCHEMA_ENV = 'PLAYER_INSIGHTS_APP_SCHEMA';

/** Filled by bundle releases and empty in the public Git deployment artifact. */
export const APP_TARGET_ENV = 'PLAYER_INSIGHTS_TARGET';

/** Present when the app is actually attached to Lakebase; absent in local tests. */
export const LAKEBASE_ENDPOINT_ENV = 'LAKEBASE_ENDPOINT';

/**
 * Resolve the schema name from an environment map.
 *
 * A Lakebase-bound source deployment uses {@link DEFAULT_APP_SCHEMA}; bundle
 * targets and local development keep their explicit or legacy schema.
 */
export function resolveAppSchema(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): string {
  const fromEnv = (env[APP_SCHEMA_ENV] ?? '').trim();
  const bundleTarget = (env[APP_TARGET_ENV] ?? '').trim();
  const lakebaseBound = Boolean((env[LAKEBASE_ENDPOINT_ENV] ?? '').trim());
  if (!bundleTarget && lakebaseBound && (!fromEnv || fromEnv === LEGACY_APP_SCHEMA)) {
    return DEFAULT_APP_SCHEMA;
  }
  // Keep source tests and local development on the established fixture schema.
  // A deployed app always receives LAKEBASE_ENDPOINT from the resource binding,
  // so this branch cannot put a Git deployment back on the colliding default.
  if (!fromEnv) return LEGACY_APP_SCHEMA;
  return fromEnv;
}

/**
 * The schema this process is using. Read once at module load from
 * `process.env`, so a mid-process env change is ignored (same as other
 * deployment constants). Tests that need a different schema must set the env
 * before importing this module, or call {@link resolveAppSchema} directly.
 */
export let APP_SCHEMA = resolveAppSchema();

const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Adopt the schema already owned by this app identity before route modules load.
 *
 * A Git deployment replaces app.yaml, so it cannot carry a bundle target's
 * private schema value. The boot probe uses this setter after asking Postgres
 * which app schema the unchanged app role already owns. Keeping the
 * mutation here preserves one validation boundary and one exported binding.
 */
export function adoptAppSchema(schema: string): string {
  const candidate = schema.trim();
  if (!POSTGRES_IDENTIFIER.test(candidate)) {
    throw new Error(`Refusing invalid Postgres schema identifier: ${JSON.stringify(schema)}`);
  }
  APP_SCHEMA = candidate;
  return APP_SCHEMA;
}

/** Qualify a bare table name against the process's app-owned schema. */
export function appTable(name: string): string {
  return `${APP_SCHEMA}.${name}`;
}
