#!/usr/bin/env node
// Whether the app's Postgres role owns the objects it maintains in the app data
// schema (PLAYER_INSIGHTS_APP_SCHEMA / DEFAULT_APP_SCHEMA). Not AppKit's cache
// schema (`appkit`): that one is cache-only and is remediated by dropping it in
// grant-app-db-access.mjs so the app recreates and owns it.
//
// Ownership, not privileges, and the two are not interchangeable. The app's DDL
// runs `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` at every boot, and Postgres
// checks ownership before it decides the statement is a no-op, so a table
// created by a developer's role is refused for as long as it exists. Grants do
// not help, and neither does re-running grant-app-db-access.mjs for these
// tables: the developer role cannot hand ownership over, because
// `ALTER ... OWNER TO` requires membership in the target role and Lakebase
// withholds the ADMIN OPTION needed to grant it. The only remedy is to let the
// app create the objects itself.
//
// The condition is reached by pointing local development at the branch the
// deployed app uses, which is the one thing that makes it likely rather than
// theoretical.
//
// Everything is discovered from the app, so there is nothing to keep in step by
// hand:
//   node scripts/check-db-ownership.mjs --app <app-name> --profile <profile>
//
// Exits 0 when the app owns its schema, or when the schema does not exist yet,
// which is the normal state of a deployment whose app has never booted.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_SCHEMA_FILE = path.join(ROOT, 'shared', 'app-schema.ts');

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? '' : (process.argv[at + 1] ?? '');
}

const APP = arg('app');
const PROFILE = arg('profile');

function cli(args) {
  return JSON.parse(execFileSync('databricks', [...args, '--profile', PROFILE, '-o', 'json'], {
    encoding: 'utf8',
  }));
}

/** The schema the app creates: env, else DEFAULT_APP_SCHEMA from shared. */
function appSchema() {
  const fromEnv = (process.env.PLAYER_INSIGHTS_APP_SCHEMA ?? '').trim();
  if (fromEnv) return fromEnv;
  const source = readFileSync(SHARED_SCHEMA_FILE, 'utf8');
  const m = /DEFAULT_APP_SCHEMA\s*=\s*'([A-Za-z_][A-Za-z0-9_]*)'/.exec(source);
  if (!m) {
    console.error(`could not parse DEFAULT_APP_SCHEMA from ${SHARED_SCHEMA_FILE}`);
    process.exit(2);
  }
  return m[1];
}

/** A recreated app cannot take ownership of the prior app principal's schema. */
export function schemaNeedsNewName(schemaOwner, appRole) {
  return schemaOwner !== appRole;
}

async function main() {
  if (!APP || !PROFILE) {
    console.error('usage: node scripts/check-db-ownership.mjs --app <app-name> --profile <profile>');
    process.exit(2);
  }

  const app = cli(['apps', 'get', APP]);
  const appRole = app.service_principal_client_id;
  const postgres = (app.resources ?? []).map((r) => r.postgres).find(Boolean);
  if (!appRole || !postgres) {
    // Not a failure of ownership. An app with no postgres resource stores
    // nothing, and reporting an ownership problem against it would be an
    // invented finding.
    console.log(`SKIPPED: ${APP} has no attached postgres resource, so it has no schema to own.`);
    return;
  }

  const branch = postgres.branch;
  const databaseId = String(postgres.database ?? '').split('/').pop();
  const endpoints = cli(['postgres', 'list-endpoints', branch]);
  const host = endpoints?.[0]?.status?.hosts?.host;
  const databases = cli(['postgres', 'list-databases', branch]);
  const database = (databases ?? []).find((d) => d.database_id === databaseId)?.status?.postgres_database;
  const me = cli(['current-user', 'me']).userName;
  if (!host || !database || !me) {
    console.error(`could not resolve the Lakebase connection for ${APP} (host, database or caller identity missing).`);
    process.exit(2);
  }

  const schema = appSchema();
  const client = new pg.Client({
    host,
    port: 5432,
    database,
    user: me,
    password: JSON.parse(execFileSync('databricks', ['auth', 'token', '--profile', PROFILE], { encoding: 'utf8' }))
      .access_token,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const { rows: schemas } = await client.query(
    `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1`, [schema]);
  if (schemas.length === 0) {
    console.log(`ok: ${schema} does not exist yet, so the app will create and own it on its first boot.`);
    await client.end();
    return;
  }

  const { rows: tables } = await client.query(
    `SELECT tablename, tableowner FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`, [schema]);
  await client.end();

  console.log(`app role   ${appRole}`);
  console.log(`database   ${database} on ${host}`);
  console.log(`schema     ${schema}`);

  const schemaOwner = schemas[0].owner;
  if (schemaNeedsNewName(schemaOwner, appRole)) {
    console.error(`\nOWNERSHIP: schema ${schema} is owned by ${schemaOwner}, not this app's Postgres role.`);
    console.error(`A recreated Databricks App has a new service principal and cannot reuse the dead app's`);
    console.error(`schema. Grants and scripts/grant-app-db-access.mjs cannot transfer that ownership.`);
    console.error(`\nKEEP ${schema} intact so its data can be migrated deliberately. Before the next bundle`);
    console.error(`deploy, set lakebase_app_schema to a NEW, UNUSED schema name in:`);
    console.error(`\n  .databricks/bundle/<target>/variable-overrides.json`);
    console.error(`\nThen run bundle deploy and bundle/app-release.sh again. The new app will create and own`);
    console.error(`the new schema on first boot; do not drop or rename the old schema to unblock release.`);
    process.exit(1);
  }

  const foreign = tables.filter((row) => row.tableowner !== appRole);
  if (foreign.length === 0) {
    console.log(`ok: the app owns its schema and all ${tables.length} table(s) in it.`);
    return;
  }

  console.error(`\nOWNERSHIP: ${foreign.length} object(s) in ${schema} are not owned by the app's Postgres role.`);
  for (const row of foreign) console.error(`  ${row.tablename} -> ${row.tableowner}`);
  console.error(`\nThe app's boot DDL will be refused on these for as long as they exist, and grants cannot`);
  console.error(`fix it: ownership can only be transferred by a role the workspace does not hand out. Let the`);
  console.error(`app create them instead.`);
  // This used to say `DROP SCHEMA ... CASCADE`, and somebody nearly ran it. That
  // is right for a deployment whose app has never booted and catastrophic for one
  // with history: it takes every conversation, message, rating and run with it,
  // and the misowned objects are usually a handful of tables a developer's local
  // server created, sitting in a schema the app itself owns.
  console.error(`\nDROP THE OBJECTS LISTED ABOVE, ONE AT A TIME. Do NOT drop ${schema} itself: it holds every`);
  console.error(`conversation, message, rating and run this app has stored, almost certainly owned by the app`);
  console.error(`already, and none of it is reproducible.`);
  console.error(`\n  1. check what each one holds:  SELECT count(*) FROM ${schema}.<table>`);
  console.error(`  2. export anything you need, then DROP TABLE ${schema}.<table>  (no CASCADE: if something`);
  console.error(`     depends on it, find out what before you take that too)`);
  console.error(`  3. restart the app, which recreates them as their owner`);
  console.error(`\nTry ALTER TABLE ${schema}.<table> OWNER TO "${appRole}" first if you like, but expect`);
  console.error(`"must be able to SET ROLE": Lakebase does not grant a person that over a service principal.`);
  console.error(`\nThen stop pointing local development at this branch, which is how it happens.`);
  process.exit(1);
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(2);
  });
}
