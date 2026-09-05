#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_PERSONAS = [
  {
    id: 'business-analyst',
    markers: [
      { label: 'id: "business-analyst"', pattern: /\bid\s*:\s*["']business-analyst["']/g },
      { label: 'displayName: "Business Analyst"', pattern: /\bdisplayName\s*:\s*["']Business Analyst["']/g },
      {
        label: 'roleSummary: "Read-only analyst for governed performance and player investigation."',
        pattern: /\broleSummary\s*:\s*["']Read-only analyst for governed performance and player investigation\.["']/g,
      },
    ],
  },
  {
    id: 'marketing-scientist',
    markers: [
      { label: 'id: "marketing-scientist"', pattern: /\bid\s*:\s*["']marketing-scientist["']/g },
      { label: 'displayName: "Marketing Scientist"', pattern: /\bdisplayName\s*:\s*["']Marketing Scientist["']/g },
      {
        label:
          'roleSummary: "Read-only marketing scientist for governed audience, purchase, and player-profile analysis."',
        pattern:
          /\broleSummary\s*:\s*["']Read-only marketing scientist for governed audience, purchase, and player-profile analysis\.["']/g,
      },
    ],
  },
];

// Match the retired private persona identities, not unrelated organization
// labels or logo keys that the account UI is allowed to render.
const PRIVATE_PERSONA_PATTERN =
  /northwind[-_ ]analyst|2k[-_ ]marketing[-_ ]scientist|take[-_ ]two[-_ ](?:analyst|marketing[-_ ]scientist)/i;

function localModuleImports(file) {
  const source = readFileSync(file, 'utf8');
  const staticImports = [...source.matchAll(/\bimport(?:[^('"`;]*?\bfrom)?\s*["']([^"']+)["']/g)].map(
    (match) => match[1]
  );
  const dynamicImports = [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
  return [...staticImports, ...dynamicImports]
    .filter((specifier) => specifier.startsWith('.') && specifier.endsWith('.mjs'))
    .map((specifier) => path.resolve(path.dirname(file), specifier));
}

export function reachableRuntimeModules(entry) {
  const root = path.dirname(path.resolve(entry));
  const pending = [path.resolve(entry)];
  const visited = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Runtime module import escapes the deploy directory: ${path.relative(root, file)}`);
    }
    if (!existsSync(file)) {
      throw new Error(`Runtime module import is missing: ${path.relative(root, file)}`);
    }
    visited.add(file);
    pending.push(...localModuleImports(file));
  }
  return [...visited].sort();
}

function occurrenceFiles(pattern, modules) {
  const matches = [];
  for (const file of modules) {
    const count = readFileSync(file, 'utf8').match(pattern)?.length ?? 0;
    for (let index = 0; index < count; index += 1) matches.push(file);
  }
  return matches;
}

export function validateRuntimePersonas(entry) {
  const deployDir = path.dirname(path.resolve(entry));
  const modules = reachableRuntimeModules(entry);
  const findings = [];

  for (const persona of PUBLIC_PERSONAS) {
    for (const marker of persona.markers) {
      const matches = occurrenceFiles(marker.pattern, modules);
      if (matches.length !== 1) {
        const files = [...new Set(matches.map((file) => path.relative(deployDir, file)))];
        findings.push(
          `${persona.id} marker ${JSON.stringify(marker.label)}: expected once, found ${matches.length}` +
            (files.length > 0 ? ` in ${files.join(', ')}` : '')
        );
      }
    }
  }

  const privateFiles = modules
    .filter((file) => PRIVATE_PERSONA_PATTERN.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(deployDir, file));
  if (privateFiles.length > 0) {
    findings.push(`private target persona identifier found in ${privateFiles.join(', ')}`);
  }

  return {
    files: modules.map((file) => path.relative(deployDir, file)),
    findings,
  };
}

function main() {
  const entryAt = process.argv.indexOf('--entry');
  const entry = path.resolve(
    entryAt >= 0
      ? process.argv[entryAt + 1]
      : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'deploy', 'server.mjs')
  );
  const result = validateRuntimePersonas(entry);
  if (result.findings.length > 0) {
    throw new Error(
      `Deploy runtime persona validation failed:\n- ${result.findings.join('\n- ')}\nInspected: ${result.files.join(', ')}`
    );
  }
  console.log(`Deploy runtime personas passed across ${result.files.length} reachable modules.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
