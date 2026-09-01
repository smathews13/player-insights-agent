#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DEPLOY_DIR = path.join(APP_ROOT, 'build', 'deploy');

export function smokeDeployArtifact(deployDir = DEFAULT_DEPLOY_DIR) {
  const server = path.join(deployDir, 'server.mjs');
  const result = spawnSync(process.execPath, [server, '--module-smoke'], {
    cwd: deployDir,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'production',
      PATH: process.env.PATH ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.includes('module-smoke ok')) {
    throw new Error(
      [
        `Production server module smoke failed with status ${result.status ?? 'none'}.`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
  return { node: process.version, stdout: result.stdout.trim() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const directoryAt = process.argv.indexOf('--deploy-dir');
    const deployDir = path.resolve(directoryAt >= 0 ? process.argv[directoryAt + 1] : DEFAULT_DEPLOY_DIR);
    const result = smokeDeployArtifact(deployDir);
    console.log(`Deploy artifact startup passed (${result.node}): ${result.stdout}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
