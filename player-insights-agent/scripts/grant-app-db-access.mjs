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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Relative to the repository root, which is the parent of the app directory.
const ROUTES_FILE = path.join(ROOT, 'server', 'routes', 'insights-routes.ts');

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

// --- The app schema, and the coupling that makes it three values --------------
function appSchemaFromRoutes() {
  let source;
  try {
    source = readFileSync(ROUTES_FILE, 'utf8');
  } catch {
    console.error(`\nERROR: cannot read ${ROUTES_FILE}.`);
    console.error('This script derives the app schema from the DDL there. Run it from');
    console.error('the player-insights-agent/ app directory inside a full checkout.\n');
    process.exit(1);
  }
  const found = [...source.matchAll(/CREATE SCHEMA IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  const distinct = [...new Set(found)];
  if (distinct.length !== 1) {
    console.error(`\nERROR: expected exactly one schema in ${ROUTES_FILE}'s DDL, found ${distinct.length}.`);
    console.error(distinct.length ? `  ${distinct.join(', ')}` : '  (none)');
    console.error('Grant on the wrong schema and every route silently answers from');
    console.error('representative data. Fix the DDL or this parser before granting.\n');
    process.exit(1);
  }
  return distinct[0];
}

const APP_SCHEMA = appSchemaFromRoutes();
const OVERRIDE = process.env.PLAYER_INSIGHTS_APP_SCHEMA;
if (OVERRIDE && OVERRIDE !== APP_SCHEMA) {
  console.error(`\nERROR: PLAYER_INSIGHTS_APP_SCHEMA is '${OVERRIDE}' but the app creates '${APP_SCHEMA}'.`);
  console.error('\nThe schema is written down in three places and they must agree:');
  console.error(`  1. server/routes/insights-routes.ts   the DDL that creates it  -> ${APP_SCHEMA}`);
  console.error(`  2. databricks.yml var.lakebase_app_schema  documents it        -> set to match`);
  console.error(`  3. this script                        grants on it             -> reads (1)`);
  console.error('\nChange (1) and (2) together, or neither. Granting on a schema the app');
  console.error('does not create leaves every route on representative data at HTTP 200.\n');
  process.exit(1);
}

// --- What these grants deliberately do not cover: ownership -------------------
const SCHEMAS = [APP_SCHEMA];
// AppKit's internal cache schema. Its migrations issue CREATE INDEX, which only
// the table owner may run, and a developer role cannot hand ownership over
// (granting app-role membership requires ADMIN OPTION, which Lakebase withholds).
// Dropping it lets the app recreate and own it on next boot; it holds only cache.
const APPKIT_CACHE_SCHEMA = 'appkit';

function token() {
  const out = execFileSync('databricks', ['auth', 'token', '--profile', PROFILE], {
    encoding: 'utf8',
  });
  return JSON.parse(out).access_token;
}

function ident(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

async function main() {
  console.log('grant-app-db-access');
  console.log(`  profile     ${PROFILE}`);
  console.log(`  host        ${PGHOST}`);
  console.log(`  database    ${PGDATABASE}`);
  console.log(`  connect as  ${PGUSER}`);
  console.log(`  grant to    ${APP_ROLE}`);
  console.log(`  app schema  ${APP_SCHEMA}  (read from server/routes/insights-routes.ts)`);
  console.log('');

  const client = new pg.Client({
    host: PGHOST,
    port: Number(process.env.PGPORT ?? 5432),
    database: PGDATABASE,
    user: PGUSER,
    password: token(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const role = ident(APP_ROLE);
  const statements = [`GRANT CREATE, CONNECT ON DATABASE ${ident(PGDATABASE)} TO ${role}`];
  for (const schema of SCHEMAS) {
    statements.push(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`,
      `GRANT USAGE, CREATE ON SCHEMA ${ident(schema)} TO ${role}`,
      `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${ident(schema)} TO ${role}`,
      `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${ident(schema)} TO ${role}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${ident(schema)} GRANT ALL PRIVILEGES ON TABLES TO ${role}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${ident(schema)} GRANT ALL PRIVILEGES ON SEQUENCES TO ${role}`
    );
  }

  for (const statement of statements) {
    await client.query(statement);
    console.log('ok:', statement);
  }

  const { rows: cacheOwners } = await client.query(`SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = $1`, [
    APPKIT_CACHE_SCHEMA,
  ]);
  const cacheOwnedByApp = cacheOwners.length > 0 && cacheOwners.every((r) => r.tableowner === APP_ROLE);
  if (!cacheOwnedByApp) {
    await client.query(`DROP SCHEMA IF EXISTS ${ident(APPKIT_CACHE_SCHEMA)} CASCADE`);
    console.log(`ok: dropped ${APPKIT_CACHE_SCHEMA} schema so the app recreates and owns it`);
  } else {
    console.log(`ok: ${APPKIT_CACHE_SCHEMA} schema already owned by the app role`);
  }

  const { rows } = await client.query(`SELECT nspname, has_schema_privilege($1, nspname, 'USAGE') AS usage,
            has_schema_privilege($1, nspname, 'CREATE') AS create
     FROM pg_namespace WHERE nspname = ANY($2)`,
    [APP_ROLE, SCHEMAS]
  );
  console.table(rows);
  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
