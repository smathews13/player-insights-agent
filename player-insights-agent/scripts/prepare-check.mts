/**
 * Parses every statement the route file runs against the live Lakebase schema,
 * without reading or writing a row.
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import {
  RUNS_QUERY,
  RUN_TRACE_MESSAGE_QUERY,
  RUN_TRACE_BENCHMARK_QUERY,
} from '../server/routes/insights-routes.ts';

const SOURCE = 'server/routes/insights-routes.ts';
const text = readFileSync(new URL(`../${SOURCE}`, import.meta.url), 'utf8');

/**
 * Every backtick or single-quoted literal in the file that names the app schema.
 * Deliberately broad: a statement this misses is a statement that goes to
 * production unparsed, so over-collecting is the safe direction.
 */
function extractStatements(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/`([^`]*?)`/g)) {
    const body = match[1];
    if (/player_insights\./i.test(body) && /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)/i.test(body.trim())) {
      found.add(body);
    }
  }
  for (const match of source.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
    const body = match[1];
    if (/player_insights\./i.test(body) && /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)/i.test(body.trim())) {
      found.add(body);
    }
  }
  return [...found];
}

const inline = extractStatements(text);
const interpolated = inline.filter((sql) => sql.includes('${'));
const literal = inline.filter((sql) => !sql.includes('${'));

const cases: Array<[string, string]> = [
  ['RUNS_QUERY (exported)', RUNS_QUERY],
  ['RUN_TRACE_MESSAGE_QUERY (exported)', RUN_TRACE_MESSAGE_QUERY],
  ['RUN_TRACE_BENCHMARK_QUERY (exported)', RUN_TRACE_BENCHMARK_QUERY],
  ...literal.map((sql, index): [string, string] => [
    `inline #${index + 1}: ${sql.trim().replace(/\s+/g, ' ').slice(0, 76)}`,
    sql,
  ]),
];

console.log(`Extracted ${literal.length} inline statements from ${SOURCE}, plus 3 exported.`);
if (interpolated.length > 0) {
  // Named rather than dropped. An interpolated statement not covered by one of
  // the exported constants above would be leaving this check unvalidated.
  console.log(`\n${interpolated.length} interpolated literal(s) skipped here, covered by the exports:`);
  for (const sql of interpolated) {
    console.log(`  - ${sql.trim().replace(/\s+/g, ' ').slice(0, 90)}`);
  }
}

const client = new Client({
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  port: Number(process.env.PGPORT ?? 5432),
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
} catch (error) {
  console.error(`\nconnect failed: ${(error as Error).message}`);
  process.exit(2);
}

console.log(`\nConnected to ${process.env.PGHOST} / ${process.env.PGDATABASE}\n`);
await client.query('BEGIN READ ONLY');

let failures = 0;
for (const [index, [name, sql]] of cases.entries()) {
  try {
    await client.query(`PREPARE pia_check_${index} AS ${sql}`);
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(error as Error).message}`);
  }
}

await client.query('ROLLBACK');
await client.end();

console.log(
  failures === 0
    ? `\nAll ${cases.length} statements parse and resolve against the live schema.`
    : `\n${failures} of ${cases.length} statements failed.`
);
process.exit(failures === 0 ? 0 : 1);
