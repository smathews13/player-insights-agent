#!/usr/bin/env node
// Grants the Databricks App service principal's Postgres role the privileges it
// needs on schemas that were first created by a developer role. Without these,
// AppKit's cache migration fails with "permission denied for schema appkit" and
// every /api route silently falls back to representative data.
//
// Requires a Databricks CLI profile whose identity holds DATABRICKS_SUPERUSER on
// the branch. A Lakebase role without it can connect and read but cannot GRANT,
// and the refusal arrives as SQLSTATE 42501 from the first GRANT rather than at
// connection time.
//
// bundle/app-release.sh invokes this through bundle/app-db-grant.sh before every
// app code deploy. Run that wrapper directly after Lakebase detach/reattach when
// no full release is needed, then restart the app so it recreates `appkit` as
// owner. The wrapper resolves PGHOST from the direct branch connection; do not
// use the pooled AppKit hostname for an operator OAuth login.
//
// A bare `GRANT USAGE, CREATE ON SCHEMA appkit` is NOT enough. AppKit migrations
// later issue CREATE INDEX, which only the table owner may run, and a developer
// role cannot hand ownership over on Lakebase. This script drops a misowned
// cache-only `appkit` schema instead; the app recreates and owns it on next boot.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_SCHEMA_FILE = path.join(ROOT, 'shared', 'app-schema.ts');

// AppKit's internal cache schema. Its migrations issue CREATE INDEX, which only
// the table owner may run, and a developer role cannot hand ownership over
// (granting app-role membership requires ADMIN OPTION, which Lakebase withholds).
// Dropping it lets the app recreate and own it on next boot; it holds only cache.
export const APPKIT_CACHE_SCHEMA = 'appkit';

/**
 * Whether to DROP the AppKit cache schema so the app can recreate and own it.
 *
 * Ownership, not privileges: CREATE INDEX requires table ownership, and a bare
 * GRANT USAGE/CREATE on schema `appkit` cannot supply it. Empty / absent /
 * foreign-owned tables all mean "drop" (DROP IF EXISTS is a no-op when absent).
 * Only when every existing cache table is already owned by the app role do we
 * leave the schema alone, so a second run stays idempotent.
 *
 * @param {string[]} tableOwners distinct `pg_tables.tableowner` values in `appkit`
 * @param {string} appRole the app service principal's Postgres role (client id)
 */
export function shouldDropAppkitCacheSchema(tableOwners, appRole) {
  const ownedByApp =
    tableOwners.length > 0 && tableOwners.every((owner) => owner === appRole);
  return !ownedByApp;
}

export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Grants for an app data schema that already exists.
 *
 * An absent schema deliberately returns no statements. The app role already
 * receives CREATE on the database and must create the schema itself so it owns
 * the boot-time DDL. Creating it here would make the human operator its owner
 * and cause the next release's ownership gate to refuse the deployment.
 */
export function appSchemaGrantStatements(schemaExists, schema, role) {
  if (!schemaExists) return [];
  return [
    `GRANT USAGE, CREATE ON SCHEMA ${quoteIdent(schema)} TO ${role}`,
    `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${quoteIdent(schema)} TO ${role}`,
    `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${quoteIdent(schema)} TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(schema)} GRANT ALL PRIVILEGES ON TABLES TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(schema)} GRANT ALL PRIVILEGES ON SEQUENCES TO ${role}`,
  ];
}

function required(name, how) {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  console.error(`\nERROR: ${name} is not set, and there is deliberately no default.\n`);
  console.error(`${how}\n`);
  console.error('All of DATABRICKS_CONFIG_PROFILE, PGHOST, PGDATABASE, PGUSER and APP_PG_ROLE\n' +
      'are required. PGHOST, PGDATABASE and PGUSER are on the Lakebase instance\n' +
      'page in the workspace; APP_PG_ROLE is the app service principal client id.\n'
  );
  process.exit(1);
}

function appSchemaFromSharedDefault() {
  let source;
  try {
    source = readFileSync(SHARED_SCHEMA_FILE, 'utf8');
  } catch {
    console.error(`\nERROR: cannot read ${SHARED_SCHEMA_FILE}.`);
    console.error('This script derives the default app schema from shared/app-schema.ts.\n');
    process.exit(1);
  }
  const m = /DEFAULT_APP_SCHEMA\s*=\s*'([A-Za-z_][A-Za-z0-9_]*)'/.exec(source);
  if (!m) {
    console.error(`\nERROR: could not parse DEFAULT_APP_SCHEMA from ${SHARED_SCHEMA_FILE}.\n`);
    process.exit(1);
  }
  return m[1];
}

function resolveAppSchema() {
  const override = (process.env.PLAYER_INSIGHTS_APP_SCHEMA ?? '').trim();
  const declared = appSchemaFromSharedDefault();
  if (override && override !== declared) {
    // Env may legitimately differ from the compiled default when a target
    // overrides var.lakebase_app_schema; that is the whole point of wiring it.
    // Record both so a mis-set env is visible in the grant log.
    console.log(
      `  note  PLAYER_INSIGHTS_APP_SCHEMA='${override}' (compiled default is '${declared}')`
    );
  }
  return override || declared;
}

function token(profile) {
  const out = execFileSync('databricks', ['auth', 'token', '--profile', profile], {
    encoding: 'utf8',
  });
  return JSON.parse(out).access_token;
}

async function main() {
  const PROFILE = required('DATABRICKS_CONFIG_PROFILE',
    'The CLI profile for the workspace holding the Lakebase branch. Its identity\n' +
      'needs the DATABRICKS_SUPERUSER Postgres role on that branch.\n' +
      '  databricks auth profiles'
  );

  const PGUSER = required('PGUSER',
    "The Postgres role you connect AS, your own login, not the app's. Lakebase\n" +
      'reports it as `status.postgres_role` on your owner role:\n' +
      '  databricks postgres list-roles projects/<project>/branches/<branch> \\\n' +
      '    --profile "<profile>" -o json\n' +
      'Note it is the postgres_role (usually your email), not the role_id.'
  );

  const PGHOST = required('PGHOST',
    "The Lakebase branch host. From the app's .env, or:\n" +
      '  databricks postgres get-branch projects/<project>/branches/<branch> \\\n' +
      '    --profile "<profile>" -o json'
  );

  const PGDATABASE = required('PGDATABASE',
    'The Postgres database inside the branch (bundle default: databricks-postgres).\n' +
      '  databricks postgres list-databases projects/<project>/branches/<branch> \\\n' +
      '    --profile "<profile>" -o json'
  );

  const APP_ROLE = required('APP_PG_ROLE',
    "The app service principal's client id: the Postgres role privileges are\n" +
      'granted TO. The app must already exist, since its service principal is\n' +
      'created with it:\n' +
      '  databricks apps get <app-name> --profile "<profile>" -o json \\\n' +
      '    | python3 -c \'import json,sys; print(json.load(sys.stdin)["service_principal_client_id"])\'\n' +
      'Beware the near-miss: the Lakebase *resource* name is\n' +
      '`.../roles/dbrx-apps-<client-id>`, but the *Postgres* role name granted to\n' +
      'here is the bare client id.'
  );

  const APP_SCHEMA = resolveAppSchema();
  // App data schema gets ordinary grants. `appkit` is handled by drop-and-recreate
  // below: grants cannot transfer the ownership CREATE INDEX needs.
  const SCHEMAS = [APP_SCHEMA];

  console.log('grant-app-db-access');
  console.log(`  profile     ${PROFILE}`);
  console.log(`  host        ${PGHOST}`);
  console.log(`  database    ${PGDATABASE}`);
  console.log(`  connect as  ${PGUSER}`);
  console.log(`  grant to    ${APP_ROLE}`);
  console.log(`  app schema  ${APP_SCHEMA}  (PLAYER_INSIGHTS_APP_SCHEMA or shared/app-schema.ts)`);
  console.log('');

  const client = new pg.Client({
    host: PGHOST,
    port: Number(process.env.PGPORT ?? 5432),
    database: PGDATABASE,
    user: PGUSER,
    password: token(PROFILE),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const role = quoteIdent(APP_ROLE);
  const statements = [`GRANT CREATE, CONNECT ON DATABASE ${quoteIdent(PGDATABASE)} TO ${role}`];
  for (const schema of SCHEMAS) {
    const { rowCount } = await client.query(
      `SELECT 1 FROM pg_namespace WHERE nspname = $1`,
      [schema]
    );
    statements.push(...appSchemaGrantStatements(rowCount > 0, schema, role));
    if (rowCount === 0) {
      console.log(
        `ok: ${schema} does not exist; database CREATE is granted and the app will create and own it`
      );
    }
  }

  for (const statement of statements) {
    await client.query(statement);
    console.log('ok:', statement);
  }

  const { rows: cacheOwners } = await client.query(
    `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = $1`,
    [APPKIT_CACHE_SCHEMA]
  );
  const owners = cacheOwners.map((r) => r.tableowner);
  if (shouldDropAppkitCacheSchema(owners, APP_ROLE)) {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(APPKIT_CACHE_SCHEMA)} CASCADE`);
    console.log(
      `ok: dropped ${APPKIT_CACHE_SCHEMA} schema so the app recreates and owns it ` +
        `(cache only; GRANT USAGE/CREATE alone cannot satisfy CREATE INDEX ownership)`
    );
  } else {
    console.log(`ok: ${APPKIT_CACHE_SCHEMA} schema already owned by the app role`);
  }

  const { rows } = await client.query(
    `SELECT nspname, has_schema_privilege($1, nspname, 'USAGE') AS usage,
            has_schema_privilege($1, nspname, 'CREATE') AS create
     FROM pg_namespace WHERE nspname = ANY($2)`,
    [APP_ROLE, SCHEMAS]
  );
  console.table(rows);
  await client.end();
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
