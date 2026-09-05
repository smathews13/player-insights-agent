#!/usr/bin/env node
/**
 * Read staged model-release intentions directly from the app-owned Lakebase
 * store using the release operator's Databricks OAuth credential.
 *
 * Databricks Apps browser routes require both proxy identity and an app-session
 * cookie. A workspace bearer token therefore cannot make /api/settings a
 * repeatable machine gate. This reader uses the same direct Lakebase OAuth path
 * as grant-app-db-access.mjs and returns only the bounded settings contract the
 * model release compares.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const RELEASE_INTENTION_KEYS = Object.freeze({
  'llm-endpoint': 'llm_endpoint',
  'llm-gateway': 'llm_gateway',
  'genie-data': 'data_genie_space_id',
  'genie-dictionary': 'dictionary_genie_space_id',
  'sql-warehouse': 'warehouse_id',
  catalog: 'catalog',
  schema: 'schema',
  'catalog-allowlist': 'catalog_allowlist',
  'catalog-denylist': 'catalog_denylist',
  'max-output-tokens': 'max_output_tokens',
});

function required(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function rows(body, key) {
  return Array.isArray(body) ? body : (body?.[key] ?? []);
}

function defaultCli(args) {
  try {
    return JSON.parse(
      execFileSync('databricks', [...args, '-o', 'json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
  } catch {
    const operation = args.slice(0, 2).join(' ');
    throw new Error(`Databricks CLI ${operation} failed; verify the release profile credential and entitlement`);
  }
}

export function sanitizeReleaseError(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.split(String(secret)).join('[REDACTED]');
  }
  return message
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/("(?:access_token|password)"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/(password\s*=\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+(@)/gi, '$1[REDACTED]$2');
}

export async function readReleaseIntentions({ profile, appName, appSchema, cli = defaultCli, Client = pg.Client }) {
  profile = required(profile, 'DATABRICKS_CONFIG_PROFILE');
  appName = required(appName, 'PLAYER_INSIGHTS_APP_NAME');
  appSchema = required(appSchema, 'PLAYER_INSIGHTS_APP_SCHEMA');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(appSchema)) {
    throw new Error('PLAYER_INSIGHTS_APP_SCHEMA is not a safe Postgres identifier');
  }

  let token = '';
  let client;
  try {
    const app = cli(['apps', 'get', appName, '--profile', profile]);
    const postgres = (app.resources ?? []).map((resource) => resource.postgres).find(Boolean) ?? {};
    const branchName = required(postgres.branch, 'the app Postgres branch');
    const databaseResource = required(postgres.database, 'the app Postgres database');

    const branch = cli(['postgres', 'get-branch', branchName, '--profile', profile]);
    let host = String(branch?.status?.hosts?.host ?? '').trim();
    if (!host) {
      const endpoints = rows(cli(['postgres', 'list-endpoints', branchName, '--profile', profile]), 'endpoints');
      host = String(endpoints.map((entry) => entry?.status?.hosts?.host).find(Boolean) ?? '').trim();
    }
    host = required(host, 'the direct Lakebase branch host');

    const databaseId = databaseResource.split('/').at(-1);
    const databases = rows(cli(['postgres', 'list-databases', branchName, '--profile', profile]), 'databases');
    const database = databases.find(
      (entry) =>
        entry.database_id === databaseId ||
        String(entry.name ?? '')
          .split('/')
          .at(-1) === databaseId
    );
    const databaseName = required(database?.status?.postgres_database, 'the Lakebase database name');
    const user = required(cli(['current-user', 'me', '--profile', profile])?.userName, 'the Lakebase operator role');
    token = required(cli(['auth', 'token', '--profile', profile])?.access_token, 'the OAuth database credential');

    client = new Client({
      host,
      port: 5432,
      database: databaseName,
      user,
      password: token,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    const result = await client.query(
      `SELECT resource_id, value, updated_at, updated_by
         FROM "${appSchema}".deployment_settings
        WHERE intent = 'intended'
        ORDER BY resource_id`
    );

    const resources = (result.rows ?? []).map((row) => {
      const id = String(row.resource_id ?? '');
      const agentKey = RELEASE_INTENTION_KEYS[id];
      if (!agentKey) {
        throw new Error(`stored intended setting ${JSON.stringify(id)} is absent from the release contract`);
      }
      const updatedAt = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? '');
      return {
        resource: { id, agentKey, label: id },
        intended: String(row.value ?? ''),
        intendedBy: String(row.updated_by ?? ''),
        intendedAt: updatedAt,
      };
    });
    return { source: 'lakebase-direct-oauth', resources };
  } catch (error) {
    throw new Error(sanitizeReleaseError(error, [token]));
  } finally {
    if (client) await client.end().catch(() => undefined);
  }
}

async function main() {
  const payload = await readReleaseIntentions({
    profile: process.env.DATABRICKS_CONFIG_PROFILE,
    appName: process.env.PLAYER_INSIGHTS_APP_NAME,
    appSchema: process.env.PLAYER_INSIGHTS_APP_SCHEMA,
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(`ERROR: secure app-intention read failed: ${sanitizeReleaseError(error)}`);
    process.exit(1);
  });
}
