/**
 * The only file here that talks to anything.
 *
 * THROUGH THE APP'S OWN PUBLIC ROUTES, WITH THE OPERATOR'S OWN TOKEN. Not
 * through a diagnostic side door and not as the app service principal. The
 * point of certifying a deployment is to exercise the boundary a user crosses,
 * and a check that reaches around that boundary certifies a path nobody uses.
 * The bundle's storage checks established the same rule and wrote down why: a
 * psql session proves the grants exist, not that the app picked them up.
 *
 * NOTHING HERE DECIDES ANYTHING. Every function returns what it saw or null,
 * and null means the call did not answer. The probes turn that into `unknown`.
 * An error swallowed into an empty object would arrive at a probe as a
 * deployment with no scopes and no attachments, which reads as a finding about
 * the release rather than about the network.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expectedManifestTables } from './expected-manifest.ts';
import type { Observations } from './runner.ts';
import type {
  AppRecord,
  EndpointRecord,
  ModelRunRecord,
  ModelVersionRecord,
  OwnershipRun,
  PreflightRecord,
  SettingsRecord,
  StorageRecord,
} from './probes.ts';
import { servedVersion } from './probes.ts';

export interface ObserveOptions {
  target: string;
  profile: string;
  appName: string;
  /** Fully-qualified registered model, from the bundle. */
  modelName: string;
  servingEndpoint: string;
  catalog: string;
  schema: string;
  /** `user_api_scopes` the bundle authors, already resolved by the wrapper. */
  authoredScopes: string[];
  /** `var.execution_identity`: the identity this target says it INTENDS. */
  declaredIdentity: string;
  /** Repository root, so `agent/preflight.py` can be read. */
  repoRoot: string;
  /** The app directory, so the ownership check can be run from it. */
  appDir: string;
  /** Seconds any one HTTP call may take. */
  timeoutSeconds?: number;
  log?: (message: string) => void;
}

/** A control-plane read. Returns null on any failure, having said so. */
function cliJson<T>(args: string[], options: ObserveOptions): T | null {
  try {
    const out = execFileSync('databricks', [...args, '--profile', options.profile, '-o', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out) as T;
  } catch (error) {
    options.log?.(`  could not read: databricks ${args.join(' ')}: ${(error as Error).message.split('\n')[0]}`);
    return null;
  }
}

function bearerToken(options: ObserveOptions): string {
  try {
    const out = execFileSync('databricks', ['auth', 'token', '--profile', options.profile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return (JSON.parse(out) as { access_token?: string }).access_token ?? '';
  } catch (error) {
    options.log?.(
      `  could not mint a token for profile '${options.profile}': ${(error as Error).message.split('\n')[0]}`
    );
    return '';
  }
}

/**
 * One of the app's routes.
 *
 * A non-2xx body is still returned when it parses, because these routes answer
 * with their findings: `/api/storage` reports an unavailable store with 503 and
 * a full payload, and reading that as "no answer" would turn the clearest
 * finding this tool can get into an unknown.
 */
async function appJson<T>(url: string, route: string, token: string, options: ObserveOptions): Promise<T | null> {
  if (!url || !token) return null;
  try {
    const response = await fetch(`${url}${route}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout((options.timeoutSeconds ?? 30) * 1000),
    });
    return (await response.json()) as T;
  } catch (error) {
    options.log?.(`  ${route} did not answer: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Ownership, by running the script that already answers it.
 *
 * Not reimplemented. `check-db-ownership.mjs` is on the release's critical path
 * already and its three exit codes are load-bearing: 0 owns it, 1 a finding,
 * anything else a check that could not run. A second implementation here would
 * be a second thing to keep in step with the app's DDL.
 */
export function runOwnershipCheck(options: ObserveOptions): OwnershipRun | null {
  try {
    const output = execFileSync(
      'node',
      ['scripts/check-db-ownership.mjs', '--app', options.appName, '--profile', options.profile],
      { cwd: options.appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { exitCode: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: typeof failure.status === 'number' ? failure.status : 2,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` || (failure.message ?? ''),
    };
  }
}

/**
 * Whether the app build sends an identity mode with every ask.
 *
 * READ FROM THE COMMIT THE APP WAS BUILT FROM, not from the working tree and not
 * from the running app. The working tree is whatever six agents have edited
 * since; the running app reports no such thing on any route. The build stamp
 * names a commit, and what that commit's server sends is a property of it.
 *
 * Searched across the whole server directory rather than one file, because the
 * question survives the ask route being split up and a probe pinned to a
 * filename would answer "no" the day somebody moved it, which reads as a
 * finding about the release.
 *
 * Null on any failure, including a commit this clone does not have, which
 * happens when the release was built somewhere else.
 */
export function appSendsIdentityMode(buildSha: string, options: ObserveOptions): boolean | null {
  if (!/^[0-9a-f]{7,40}$/i.test(buildSha)) return null;
  try {
    execFileSync('git', ['cat-file', '-e', `${buildSha}^{commit}`], {
      cwd: options.repoRoot,
      stdio: 'ignore',
    });
  } catch {
    options.log?.(`  commit ${buildSha.slice(0, 12)} is not in this clone, so what the app build sends was not read`);
    return null;
  }
  try {
    const out = execFileSync(
      'git',
      ['grep', '-l', 'custom_inputs.identity_mode', buildSha, '--', 'player-insights-agent/server'],
      { cwd: options.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return out.trim().length > 0;
  } catch (error) {
    // git grep exits 1 for no match, which is an answer: that build sends none.
    // Anything else is a failure to look, which must not be read as one.
    const failure = error as { status?: number };
    if (failure.status === 1) return false;
    options.log?.(`  could not search commit ${buildSha.slice(0, 12)} for the identity mode it sends`);
    return null;
  }
}

/** What the repository expects the served manifest to be, or null. */
export function readExpectedTables(options: ObserveOptions): string[] | null {
  try {
    const source = readFileSync(path.join(options.repoRoot, 'agent', 'preflight.py'), 'utf8');
    return expectedManifestTables(source, { catalog: options.catalog, schema: options.schema });
  } catch {
    return null;
  }
}

export async function observe(options: ObserveOptions): Promise<Observations> {
  const log = options.log ?? (() => {});

  log('Reading the app from the workspace');
  const app = cliJson<AppRecord>(['apps', 'get', options.appName], options);

  log('Reading the serving endpoint');
  const endpoint = cliJson<EndpointRecord>(['serving-endpoints', 'get', options.servingEndpoint], options);

  // Only the version taking traffic. Reading the newest registered version
  // instead would certify a manifest nobody is serving.
  const version = servedVersion(endpoint);
  let modelVersion: ModelVersionRecord | null = null;
  if (version && options.modelName) {
    log(`Reading model version ${version}`);
    modelVersion = cliJson<ModelVersionRecord>(
      ['api', 'get', `/api/2.1/unity-catalog/models/${options.modelName}/versions/${version}`],
      options
    );
  } else {
    log('  no single served version, so no model version was read');
  }

  // One hop further back than looks necessary, and the reason is worth keeping.
  // The build stamp and the auth policy are release decisions that reach the
  // artifact through `model_config`, and neither serving nor Unity Catalog
  // reports them afterwards. MLflow keeps every model_config entry as a param on
  // the logging run, so the version's own run_id is the only surviving record.
  let modelRun: ModelRunRecord | null = null;
  if (modelVersion?.run_id) {
    log('Reading the run that logged it');
    modelRun =
      cliJson<{ run?: ModelRunRecord }>(
        ['api', 'get', `/api/2.0/mlflow/runs/get?run_id=${modelVersion.run_id}`],
        options
      )?.run ?? null;
  } else if (modelVersion) {
    log('  the model version names no run, so its release decisions were not read');
  }

  const url = (app?.url ?? '').replace(/\/$/, '');
  const token = url ? bearerToken(options) : '';
  const issuedBy = cliJson<{ userName?: string }>(['current-user', 'me'], options)?.userName ?? '';

  log('Asking the app about itself, as you');
  const [settings, storage, preflight] = await Promise.all([
    appJson<SettingsRecord>(url, '/api/settings', token, options),
    appJson<StorageRecord>(url, '/api/storage', token, options),
    appJson<PreflightRecord>(url, '/api/preflight', token, options),
  ]);

  log('Checking Postgres ownership');
  const ownership = runOwnershipCheck(options);

  // After /api/settings, because the app's build stamp is what says which commit
  // to read. Asked of the RUNNING app rather than of the checkout, so this
  // describes what is deployed even when the local tree is on something else.
  const appBuildSha = settings?.appBuildSha ?? '';
  const appIdentityMode = appBuildSha ? appSendsIdentityMode(appBuildSha, options) : null;

  return {
    target: options.target,
    issuedBy,
    app,
    endpoint,
    modelVersion,
    modelRun,
    modelName: options.modelName,
    authoredScopes: options.authoredScopes.length > 0 ? options.authoredScopes : null,
    declaredIdentity: options.declaredIdentity.trim() || null,
    appIdentityMode,
    expectedTables: readExpectedTables(options),
    settings,
    storage,
    preflight,
    ownership,
  };
}
