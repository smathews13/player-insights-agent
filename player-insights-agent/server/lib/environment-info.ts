import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  EnvironmentInfo,
  EnvironmentPackage,
  EnvironmentVariable,
} from '../../shared/environment-info';

const execFileAsync = promisify(execFile);
const MASK = '***';
const SECRET_KEY =
  /(?:^|_)(?:ACCESS_KEY|API_KEY|AUTH|BEARER|CREDENTIAL|CREDENTIALS|PASSWORD|PASSWD|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)/i;

export function isSensitiveEnvironmentKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

function looksLikeSecretValue(value: string): boolean {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return true;
  if (/^dapi[a-f0-9]{20,}$/i.test(value)) return true;
  if (/^Bearer\s+\S+$/i.test(value)) return true;
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

export function maskedEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): EnvironmentVariable[] {
  return Object.entries(environment)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => ({
      key,
      value: isSensitiveEnvironmentKey(key) || looksLikeSecretValue(value) ? MASK : value,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function parsePipPackages(raw: string): EnvironmentPackage[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('pip returned an invalid package list');
  return parsed
    .filter(
      (entry): entry is { name: string; version: string } =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === 'string' &&
        typeof (entry as { version?: unknown }).version === 'string'
    )
    .map(({ name, version }) => ({ name, version }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function run(command: string, arguments_: string[], includeStderr: boolean): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, arguments_, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 5_000,
  });
  return (includeStderr ? `${stdout}${stderr}` : stdout).trim();
}

async function firstPython(arguments_: string[], includeStderr = false): Promise<string> {
  for (const command of ['python3', 'python']) {
    try {
      return await run(command, arguments_, includeStderr);
    } catch {
      // Databricks runtimes normally provide python3; local development may only
      // expose python. Try both before reporting that Python is unavailable.
    }
  }
  return '';
}

export async function readEnvironmentInfo(
  environment: NodeJS.ProcessEnv = process.env
): Promise<EnvironmentInfo> {
  const [pythonVersion, packagesJson] = await Promise.all([
    firstPython(['--version'], true),
    firstPython(['-m', 'pip', 'list', '--format=json', '--disable-pip-version-check']),
  ]);

  let packages: EnvironmentPackage[] = [];
  if (packagesJson) {
    try {
      packages = parsePipPackages(packagesJson);
    } catch (error) {
      console.warn('[environment] pip package list could not be parsed:', (error as Error).message);
    }
  }

  return {
    runtime: {
      python: pythonVersion.replace(/^Python\s+/i, ''),
      node: process.version,
    },
    variables: maskedEnvironment(environment),
    packages,
  };
}
