#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.resolve(process.argv[2] || path.join(APP_ROOT, 'server', 'lib', 'migrations.ts'));
const source = readFileSync(sourcePath, 'utf8');
const baseline = Number(/export const BASELINE_VERSION\s*=\s*(\d+)\s*;/.exec(source)?.[1]);
const start = source.indexOf('export const LATER_MIGRATIONS');
const end = source.indexOf('export function buildMigrations', start);

if (baseline !== 1 || start < 0 || end < 0) {
  throw new Error('Could not read the baseline and later migration registry.');
}

const registry = source.slice(start, end);
const versions = [...registry.matchAll(/^\s+version:\s*(\d+),\s*$/gm)].map((match) => Number(match[1]));
if (versions.length === 0) throw new Error('The later migration registry is empty.');

let previous = baseline;
for (const version of versions) {
  if (!Number.isInteger(version) || version !== previous + 1) {
    throw new Error(`Migration versions must be unique, contiguous, and ascending; ${version} follows ${previous}.`);
  }
  previous = version;
}

console.log(`Migration order check passed (versions ${baseline}-${previous}).`);
