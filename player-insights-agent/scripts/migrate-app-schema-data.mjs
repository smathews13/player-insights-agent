#!/usr/bin/env node
/**
 * Copy an existing PIA schema into a new schema owned by the current App role.
 *
 * The source is never changed. All target inserts run in one transaction and
 * use the intersection of source/target columns, so a newer target can accept
 * an older source without inventing values for new defaulted columns.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? '' : (process.argv[at + 1] ?? '');
}

export function quotedIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe Postgres identifier: ${value}`);
  return `"${value.replaceAll('"', '""')}"`;
}

export function migrationOrder(tables, dependencies) {
  const remaining = new Set(tables);
  const ordered = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((table) =>
        dependencies
          .filter((edge) => edge.child === table)
          .every((edge) => edge.parent === table || !remaining.has(edge.parent))
      )
      .sort();
    if (ready.length === 0) {
      throw new Error(`Foreign-key dependency cycle prevents a safe copy: ${[...remaining].sort().join(', ')}`);
    }
    for (const table of ready) {
      ordered.push(table);
      remaining.delete(table);
    }
  }
  return ordered;
}

function cli(profile, args) {
  return JSON.parse(
    execFileSync('databricks', [...args, '--profile', profile, '-o', 'json'], {
      encoding: 'utf8',
    })
  );
}

async function main() {
  const appName = arg('app');
  const profile = arg('profile');
  const sourceSchema = arg('from');
  const targetSchema = arg('to');
  if (!appName || !profile || !sourceSchema || !targetSchema) {
    throw new Error(
      'usage: migrate-app-schema-data.mjs --app <name> --profile <profile> --from <source_schema> --to <target_schema>'
    );
  }
  if (sourceSchema === targetSchema) throw new Error('Source and target schemas must differ.');
  const source = quotedIdentifier(sourceSchema);
  const target = quotedIdentifier(targetSchema);

  const app = cli(profile, ['apps', 'get', appName]);
  const appRole = String(app.service_principal_client_id ?? '');
  const postgres = (app.resources ?? []).map((resource) => resource.postgres).find(Boolean);
  if (!appRole || !postgres) throw new Error(`${appName} has no resolvable App role or Postgres resource.`);
  const branch = postgres.branch;
  const databaseId = String(postgres.database ?? '')
    .split('/')
    .pop();
  const endpoints = cli(profile, ['postgres', 'list-endpoints', branch]);
  const host = endpoints?.[0]?.status?.hosts?.host;
  const databases = cli(profile, ['postgres', 'list-databases', branch]);
  const database = (databases ?? []).find((item) => item.database_id === databaseId)?.status?.postgres_database;
  const me = cli(profile, ['current-user', 'me']).userName;
  if (!host || !database || !me) throw new Error('Could not resolve Lakebase host, database, or caller identity.');
  const password = cli(profile, ['auth', 'token']).access_token;

  const client = new pg.Client({
    host,
    port: 5432,
    database,
    user: me,
    password,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const ownership = await client.query(
      `SELECT nspname, pg_get_userbyid(nspowner) AS owner
         FROM pg_namespace
        WHERE nspname = ANY($1)`,
      [[sourceSchema, targetSchema]]
    );
    const owners = new Map(ownership.rows.map((row) => [row.nspname, row.owner]));
    if (!owners.has(sourceSchema)) throw new Error(`Source schema ${sourceSchema} does not exist.`);
    if (owners.get(targetSchema) !== appRole) {
      throw new Error(`Target schema ${targetSchema} is not owned by the current App role ${appRole}.`);
    }

    const tableRows = await client.query(
      `SELECT source.table_name
         FROM information_schema.tables source
         JOIN information_schema.tables target USING (table_name)
        WHERE source.table_schema = $1
          AND target.table_schema = $2
          AND source.table_type = 'BASE TABLE'
          AND target.table_type = 'BASE TABLE'
        ORDER BY source.table_name`,
      [sourceSchema, targetSchema]
    );
    const tables = tableRows.rows.map((row) => String(row.table_name));
    const dependencyRows = await client.query(
      `SELECT child.relname AS child, parent.relname AS parent
         FROM pg_constraint constraint_row
         JOIN pg_class child ON child.oid = constraint_row.conrelid
         JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
         JOIN pg_class parent ON parent.oid = constraint_row.confrelid
         JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
        WHERE constraint_row.contype = 'f'
          AND child_ns.nspname = $1
          AND parent_ns.nspname = $1`,
      [targetSchema]
    );
    const ordered = migrationOrder(tables, dependencyRows.rows);

    await client.query('BEGIN');
    try {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `player-insights-schema-handoff:${sourceSchema}:${targetSchema}`,
      ]);
      const results = [];
      for (const tableName of ordered) {
        const table = quotedIdentifier(tableName);
        const columnRows = await client.query(
          `SELECT source.column_name
             FROM information_schema.columns source
             JOIN information_schema.columns target USING (column_name)
            WHERE source.table_schema = $1
              AND target.table_schema = $2
              AND source.table_name = $3
              AND target.table_name = $3
            ORDER BY target.ordinal_position`,
          [sourceSchema, targetSchema, tableName]
        );
        const columns = columnRows.rows.map((row) => quotedIdentifier(String(row.column_name)));
        if (columns.length === 0) continue;
        const sourceCount = Number(
          (await client.query(`SELECT count(*)::bigint AS count FROM ${source}.${table}`)).rows[0]?.count
        );
        const inserted = await client.query(
          `INSERT INTO ${target}.${table} (${columns.join(', ')})
           SELECT ${columns.join(', ')} FROM ${source}.${table}
           ON CONFLICT DO NOTHING`
        );
        const targetCount = Number(
          (await client.query(`SELECT count(*)::bigint AS count FROM ${target}.${table}`)).rows[0]?.count
        );
        if (!Number.isSafeInteger(sourceCount) || !Number.isSafeInteger(targetCount) || targetCount < sourceCount) {
          throw new Error(`${tableName} count verification failed (${sourceCount} source, ${targetCount} target).`);
        }
        results.push({ table: tableName, source: sourceCount, inserted: inserted.rowCount ?? 0, target: targetCount });
      }
      await client.query('COMMIT');
      console.log(JSON.stringify({ app: appName, sourceSchema, targetSchema, tables: results }, null, 2));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
