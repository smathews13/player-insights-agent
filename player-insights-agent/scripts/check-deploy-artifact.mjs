#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetFindings, inspectBundle } from './bundle-budget.mjs';
import { validateRuntimePersonas } from './check-runtime-personas.mjs';
import { smokeDeployArtifact } from './smoke-deploy-artifact.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DEPLOY_DIR = path.join(APP_ROOT, 'build', 'deploy');
const LIMITS = JSON.parse(readFileSync(path.join(APP_ROOT, 'scripts', 'bundle-budget-limits.json'), 'utf8'));
const MAX_DEPLOY_FILE_BYTES = 10 * 1024 * 1024;
const GIT_DEPLOY_SCOPES = [
  'serving.serving-endpoints',
  'model-serving',
  'sql',
  'dashboards.genie',
  'workspace.workspace:read',
  'postgres',
];
const COMMITTED_EMPTY_VALUES = [
  'PLAYER_INSIGHTS_TARGET',
  'PLAYER_INSIGHTS_LLM_ENDPOINT',
  'PLAYER_INSIGHTS_INDEX_REBUILD_JOB_ID',
  'PLAYER_INSIGHTS_EXPERIMENT_ID',
  'PLAYER_INSIGHTS_CATALOG',
  'PLAYER_INSIGHTS_SCHEMA',
  'PLAYER_INSIGHTS_DATA_GENIE_ID',
  'PLAYER_INSIGHTS_DICTIONARY_GENIE_ID',
  'PLAYER_INSIGHTS_JUDGE_ENDPOINT',
  'PLAYER_INSIGHTS_NOTEBOOK_DECLARATION',
  'PLAYER_INSIGHTS_ADMIN_EMAILS',
  'PLAYER_INSIGHTS_ORGANIZATIONS',
  'PLAYER_INSIGHTS_PERSONA_TEMPLATES',
  'PLAYER_INSIGHTS_TELEMETRY_SCHEMA',
];

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(file) : [file];
  });
}

function envValue(yaml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`- name: ${escaped}\\n\\s+value: '?([^'\\n]*)'?`).exec(yaml);
  return match?.[1];
}

function fail(findings, message) {
  findings.push(message);
}

function main() {
  const args = process.argv.slice(2);
  const committed = args.includes('--committed');
  const expectedAt = args.indexOf('--expected-sha');
  const expectedSha = expectedAt >= 0 ? args[expectedAt + 1] : '';
  const directoryAt = args.indexOf('--deploy-dir');
  const deployDir = path.resolve(directoryAt >= 0 ? args[directoryAt + 1] : DEFAULT_DEPLOY_DIR);
  const findings = [];

  if (!existsSync(deployDir) || !statSync(deployDir).isDirectory()) {
    throw new Error(`Deploy artifact directory is missing: ${deployDir}`);
  }
  const appYamlPath = path.join(deployDir, 'app.yaml');
  const serverPath = path.join(deployDir, 'server.mjs');
  for (const required of [appYamlPath, serverPath, path.join(deployDir, 'client', 'dist', 'index.html')]) {
    if (!existsSync(required))
      fail(findings, `required artifact file is missing: ${path.relative(deployDir, required)}`);
  }
  if (findings.length > 0) throw new Error(findings.join('\n'));

  const files = filesBelow(deployDir);
  const installManifests = files.filter((file) =>
    ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'].includes(
      path.basename(file)
    )
  );
  if (installManifests.length > 0) {
    fail(
      findings,
      `deploy tree would trigger package installation: ${installManifests.map((file) => path.relative(deployDir, file)).join(', ')}`
    );
  }

  const sourceMaps = files.filter((file) => file.endsWith('.map'));
  if (sourceMaps.length > 0) {
    fail(
      findings,
      `deploy tree contains source maps: ${sourceMaps.map((file) => path.relative(deployDir, file)).join(', ')}`
    );
  }
  for (const file of files.filter((candidate) => /\.(?:css|js|mjs)$/.test(candidate))) {
    if (readFileSync(file, 'utf8').includes('sourceMappingURL=')) {
      fail(findings, `${path.relative(deployDir, file)} references a source map`);
    }
  }

  for (const file of files) {
    const size = statSync(file).size;
    if (size > MAX_DEPLOY_FILE_BYTES) {
      fail(
        findings,
        `${path.relative(deployDir, file)} is ${(size / 1048576).toFixed(2)} MiB, over the 10 MiB platform limit`
      );
    }
  }

  const appYaml = readFileSync(appYamlPath, 'utf8');
  if (!/^command: \['node', 'server\.mjs'\]$/m.test(appYaml)) {
    fail(findings, 'app.yaml does not run the dependency-free server.mjs entrypoint');
  }
  if (envValue(appYaml, 'NODE_ENV') !== 'production') {
    fail(findings, 'app.yaml does not set NODE_ENV=production');
  }
  const buildSha = envValue(appYaml, 'PLAYER_INSIGHTS_BUILD_SHA') ?? '';
  if (!/^[0-9a-f]{40}(?:\+dirty)?$/.test(buildSha)) {
    fail(findings, `PLAYER_INSIGHTS_BUILD_SHA is not a complete source stamp: ${buildSha || '<empty>'}`);
  }
  const scopes = (envValue(appYaml, 'PLAYER_INSIGHTS_USER_API_SCOPES') ?? '').split(',').filter(Boolean);
  if (scopes.length === 0) {
    fail(findings, 'app.yaml declares no user API scopes');
  }

  if (committed) {
    if (buildSha.endsWith('+dirty')) {
      fail(findings, `committed artifact was built from uncommitted tracked changes: ${buildSha}`);
    }
    if (expectedSha && !/^[0-9a-f]{40}$/.test(expectedSha)) {
      fail(findings, '--expected-sha must be a complete commit SHA');
    } else if (expectedSha && buildSha !== expectedSha) {
      fail(findings, `committed artifact stamp ${buildSha || '<empty>'} does not match source commit ${expectedSha}`);
    }
    for (const name of COMMITTED_EMPTY_VALUES) {
      const value = envValue(appYaml, name);
      if ((value ?? '') !== '') fail(findings, `committed app.yaml carries private deployment value ${name}`);
    }
    if (envValue(appYaml, 'PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL') !== 'false') {
      fail(findings, 'committed app.yaml does not keep the shared conversation rail disabled');
    }
    if (JSON.stringify(scopes) !== JSON.stringify(GIT_DEPLOY_SCOPES)) {
      fail(findings, `committed app.yaml has the wrong Git-deploy scope contract: ${scopes.join(',')}`);
    }
  }

  let budgetReport;
  try {
    budgetReport = inspectBundle(deployDir);
    findings.push(...budgetFindings(budgetReport, LIMITS).map((finding) => `bundle budget: ${finding}`));
  } catch (error) {
    fail(findings, `bundle budget could not be checked: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const personas = validateRuntimePersonas(serverPath);
    findings.push(...personas.findings.map((finding) => `runtime personas: ${finding}`));
  } catch (error) {
    fail(findings, `runtime personas could not be checked: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (findings.length === 0) {
    try {
      smokeDeployArtifact(deployDir);
    } catch (error) {
      fail(findings, `server module smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (findings.length > 0) {
    console.error('Deploy artifact check failed:');
    for (const finding of findings) console.error(`  - ${finding}`);
    process.exit(1);
  }
  console.log(
    `Deploy artifact check passed (${files.length} files, source ${buildSha}${committed ? ', committed/public-safe' : ''}).`
  );
}

main();
