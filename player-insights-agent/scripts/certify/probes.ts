/**
 * One function per check, from an observation to a verdict. No IO.
 *
 * Split from the runner so that every rule about what counts as a pass is
 * testable without a workspace, and so that the runner is only allowed to be
 * wrong about what it FETCHED, never about what it CONCLUDED.
 *
 * TWO RULES THAT EVERY PROBE HERE FOLLOWS.
 *
 * A missing observation is `unknown`, never `pass`. Each probe takes its input
 * as nullable and the null branch says which call did not answer. Reading an
 * absent payload as an empty one produces "no missing scopes" from an app that
 * was never fetched, which is precisely the shape of the reassuring green line
 * this whole exercise exists to remove.
 *
 * A probe reports what it OBSERVED and nothing wider. `AGENT_ENDPOINT_REACHABLE`
 * passing means the endpoint answered, and the detail says in as many words
 * that nothing behind it was covered, because the endpoint stopped reporting
 * its dependencies and the app now receives `preflight_retired`.
 */
import type { CheckResult } from './certificate.ts';
import { statusWithoutProbe, checkDefinition } from './catalogue.ts';
import { dirtyStamps, unknownFields, type ReleaseTuple, type UserAuthPolicyState } from './release-identity.ts';

// --- The shapes we read, narrowed to the fields that decide something --------
//
// Structural rather than imported from the app or generated from the API. The
// control-plane payloads are not typed anywhere we can reach, and the app's own
// types live in server code this tooling must not depend on: a release script
// that fails to run because a server type moved is a release script people stop
// running.

export interface AppRecord {
  name?: string;
  url?: string;
  user_api_scopes?: string[];
  effective_user_api_scopes?: string[];
  service_principal_client_id?: string;
  active_deployment?: { deployment_id?: string; status?: { state?: string } } | null;
  resources?: Array<{
    name?: string;
    postgres?: { branch?: string; database?: string };
    serving_endpoint?: { name?: string };
    sql_warehouse?: { id?: string };
  }>;
}

export interface EndpointRecord {
  name?: string;
  config?: {
    served_entities?: Array<{ name?: string; entity_name?: string; entity_version?: string }>;
    traffic_config?: { routes?: Array<{ served_entity_name?: string; traffic_percentage?: number }> };
  };
}

export interface ModelVersionRecord {
  version?: number | string;
  /** The MLflow run that logged it, which is where the release decisions are. */
  run_id?: string;
  model_version_dependencies?: { dependencies?: Array<{ table?: { table_full_name?: string } }> };
}

/**
 * The MLflow run that logged the served version.
 *
 * Worth saying why this is read at all, because the two obvious places were
 * checked first and answer nothing: a serving endpoint payload carries no auth
 * field, and a Unity Catalog model version reports only its table dependencies.
 * `log_model.py` passes the build stamp and the release decisions through
 * `model_config`, and MLflow records each entry as a param on the logging run.
 * That makes both readable after the fact, from the same values the artifact
 * carries rather than from a second copy that can disagree with it.
 */
export interface ModelRunRecord {
  data?: { params?: Array<{ key?: string; value?: string }> };
}

export function runParam(run: ModelRunRecord | null, key: string): string | null {
  const found = (run?.data?.params ?? []).find((param) => param.key === key);
  return found?.value ? found.value : null;
}

/** The fields of `/api/settings` this reads. See server/lib/app-settings.ts. */
export interface SettingsRecord {
  appBuildSha?: string;
  modelBuildSha?: string;
  status?: 'ok' | 'blocked' | 'pending' | 'unknown';
  drift?: Array<{ id?: string; severity?: string; headline?: string }>;
  orchestratorReported?: boolean;
}

/** The fields of `/api/storage` this reads. See server/lib/lakebase-store.ts. */
export interface StorageRecord {
  state?: string;
  access?: string;
  last_ok_at?: string | null;
  last_error?: { message?: string } | null;
}

/** The fields of `/api/preflight` this reads. */
export interface PreflightRecord {
  error?: string;
  checks?: Array<{ id?: string; status?: string; detail?: string }>;
}

/** How `scripts/check-db-ownership.mjs` answered. */
export interface OwnershipRun {
  /** 0 owns it (or no schema yet), 1 a finding, anything else could not run. */
  exitCode: number;
  output: string;
}

function result(code: string, status: CheckResult['status'], detail: string, evidenceRef?: string): CheckResult {
  return { code, status, detail, durationMs: 0, ...(evidenceRef ? { evidenceRef } : {}) };
}

/** The verdict for a check whose observation never arrived. */
function notObserved(code: string, what: string): CheckResult {
  return result(code, 'unknown', `${what} This is not a finding: nothing was asked.`);
}

/**
 * The verdict for a check with no probe, taken from the catalogue.
 *
 * The detail is the catalogue's own `notObservable` sentence rather than a
 * second wording of it, so a report cannot explain an unverifiable check
 * differently from the way the catalogue does.
 */
export function unprobed(code: string): CheckResult {
  const definition = checkDefinition(code);
  return result(
    code,
    statusWithoutProbe(code),
    definition?.notObservable ?? `${code} has no probe and the catalogue gives no reason.`
  );
}

// --- Release identity --------------------------------------------------------

export function probeReleaseIdentity(tuple: ReleaseTuple): CheckResult {
  const missing = unknownFields(tuple);
  if (missing.length === 0) {
    return result(
      'RELEASE_IDENTITY_COMPLETE',
      'pass',
      'Every identifying field is known, so this certificate names one release.'
    );
  }
  return result(
    'RELEASE_IDENTITY_COMPLETE',
    'fail',
    `The release does not identify itself: ${missing.join(', ')} ${
      missing.length === 1 ? 'is' : 'are'
    } unknown. A certificate for it would cover a family of deployments rather than one.`
  );
}

export function probeBuildStamps(tuple: ReleaseTuple): CheckResult {
  const dirty = dirtyStamps(tuple);
  if (dirty.length > 0) {
    return result(
      'BUILD_STAMPS_REPRODUCIBLE',
      'fail',
      `${dirty.join(' and ')} was built from a tree with uncommitted tracked changes, so no commit ` +
        'rebuilds it and there is nothing to roll back to.'
    );
  }
  if (!tuple.appBuildSha || !tuple.modelBuildSha) {
    return result(
      'BUILD_STAMPS_REPRODUCIBLE',
      'unknown',
      'One of the two build stamps is absent, so whether the artefacts are reproducible was not ' +
        'established. Absence is not cleanliness.'
    );
  }
  return result('BUILD_STAMPS_REPRODUCIBLE', 'pass', 'Both artefacts carry a clean commit stamp.');
}

export function probeBuildMatch(tuple: ReleaseTuple): CheckResult {
  if (!tuple.appBuildSha || !tuple.modelBuildSha) {
    return result(
      'APP_MODEL_BUILD_MATCH',
      'unknown',
      'At least one side carries no stamp, so agreement is unknown here rather than confirmed.'
    );
  }
  if (tuple.appBuildSha === tuple.modelBuildSha) {
    return result('APP_MODEL_BUILD_MATCH', 'pass', `Both were built from ${tuple.appBuildSha}.`);
  }
  return result(
    'APP_MODEL_BUILD_MATCH',
    'fail',
    `The app is running ${tuple.appBuildSha} and the served version was logged from ` +
      `${tuple.modelBuildSha}. Normal between releases, and the first explanation to reach for ` +
      'when the app expects a field the orchestrator does not send.'
  );
}

// --- Attachments and scopes --------------------------------------------------

/** The three attachments whose absence leaves an environment variable unset. */
const REQUIRED_ATTACHMENTS = ['postgres', 'serving-endpoint', 'sql-warehouse'];

export function probeAttachments(app: AppRecord | null): CheckResult {
  if (!app) return notObserved('APP_RESOURCE_ATTACHMENTS', 'The app was not read from the workspace.');
  const names = new Set((app.resources ?? []).map((resource) => resource.name).filter(Boolean));
  const missing = REQUIRED_ATTACHMENTS.filter((name) => !names.has(name));
  if (missing.length > 0) {
    return result(
      'APP_RESOURCE_ATTACHMENTS',
      'fail',
      `Not attached: ${missing.join(', ')}. The environment variable each one populates will not ` +
        'resolve, and the app starts, answers HTTP 200 and serves representative data anyway.'
    );
  }
  return result(
    'APP_RESOURCE_ATTACHMENTS',
    'pass',
    `All ${REQUIRED_ATTACHMENTS.length} attachments present: ${REQUIRED_ATTACHMENTS.join(', ')}.`
  );
}

export function probeScopesAsAuthored(app: AppRecord | null, authored: string[] | null): CheckResult {
  if (!app) return notObserved('OAUTH_SCOPES_AS_AUTHORED', 'The app was not read from the workspace.');
  if (!authored) {
    return notObserved(
      'OAUTH_SCOPES_AS_AUTHORED',
      'The bundle did not resolve, so there is no authored list to compare against.'
    );
  }
  if (authored.length === 0) {
    return result(
      'OAUTH_SCOPES_AS_AUTHORED',
      'fail',
      'The bundle authors no user_api_scopes for this app, so the live list cannot be checked ' +
        'against anything. resources/player_insights_app.app.yml is what declares them.'
    );
  }
  const declared = new Set(app.user_api_scopes ?? []);
  const want = new Set(authored);
  const dropped = [...want].filter((scope) => !declared.has(scope)).sort();
  const extra = [...declared].filter((scope) => !want.has(scope)).sort();
  if (dropped.length === 0 && extra.length === 0) {
    return result(
      'OAUTH_SCOPES_AS_AUTHORED',
      'pass',
      `The live app declares exactly the ${authored.length} scopes the bundle authors.`
    );
  }
  return result(
    'OAUTH_SCOPES_AS_AUTHORED',
    'fail',
    [
      dropped.length > 0 ? `authored but not declared on the live app: ${dropped.join(', ')}` : '',
      extra.length > 0 ? `declared on the live app and not authored: ${extra.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ') + '. An `apps update` replaces the whole list, so this is how a scope goes missing.'
  );
}

/**
 * Declared scopes that are not in effect.
 *
 * Compared IN ONE DIRECTION, the same way bundle/app-release.sh does it. The
 * effective list also carries scopes the platform adds for itself, which are
 * not drift, and reporting them would train the reader to ignore this check.
 */
export function probeScopesInEffect(app: AppRecord | null): CheckResult {
  if (!app) return notObserved('OAUTH_SCOPES_IN_EFFECT', 'The app was not read from the workspace.');
  const declared = new Set(app.user_api_scopes ?? []);
  const effective = new Set(app.effective_user_api_scopes ?? []);
  if (declared.size === 0) {
    return notObserved('OAUTH_SCOPES_IN_EFFECT', 'The live app declares no scopes.');
  }
  const missing = [...declared].filter((scope) => !effective.has(scope)).sort();
  if (missing.length > 0) {
    return result(
      'OAUTH_SCOPES_IN_EFFECT',
      'fail',
      `Declared and not in effect: ${missing.join(', ')}. Scopes are read when the app STARTS, so ` +
        'a deploy alone leaves the change inert. Stop and start the app.'
    );
  }
  return result(
    'OAUTH_SCOPES_IN_EFFECT',
    'pass',
    `All ${declared.size} declared scopes are in effect. This says nothing about whether a user ` +
      'can consent to them; see OAUTH_SCOPE_CONSENT_PROVEN.'
  );
}

// --- Storage -----------------------------------------------------------------

export function probeOwnership(run: OwnershipRun | null): CheckResult {
  if (!run) return notObserved('POSTGRES_SCHEMA_OWNERSHIP', 'The ownership check was not run.');
  if (run.exitCode === 0) {
    return result('POSTGRES_SCHEMA_OWNERSHIP', 'pass', 'The app owns its schema, so its boot DDL applies.');
  }
  if (run.exitCode === 1) {
    return result(
      'POSTGRES_SCHEMA_OWNERSHIP',
      'fail',
      'Objects in the app schema are owned by another role. The boot DDL is refused for as long ' +
        'as they exist, and no grant and no redeploy repairs it.'
    );
  }
  // Exit 2 is the check saying it could not run: no postgres attachment, no
  // connection, no readable identity. app-release.sh already treats this as
  // distinct from a finding and says why, and the same reasoning applies here.
  return result(
    'POSTGRES_SCHEMA_OWNERSHIP',
    'unknown',
    `The ownership check could not run (exit ${run.exitCode}). Not a finding that ownership is ` +
      'wrong: nothing established it either way.'
  );
}

export function probeStorage(storage: StorageRecord | null): CheckResult {
  if (!storage) return notObserved('LAKEBASE_STORAGE_READABLE', 'The app did not answer /api/storage.');
  if (storage.state === 'ok') {
    return result(
      'LAKEBASE_STORAGE_READABLE',
      'pass',
      `The app read through its own schema${storage.last_ok_at ? ` at ${storage.last_ok_at}` : ''}.`
    );
  }
  if (storage.state === 'unavailable') {
    return result(
      'LAKEBASE_STORAGE_READABLE',
      'fail',
      `The app cannot read its own store${
        storage.access === 'denied' ? ' and Postgres is REFUSING it, which is a grant problem' : ''
      }. Every list in the app is showing seeded rows at HTTP 200.` +
        (storage.last_error?.message ? ` Last error: ${storage.last_error.message}` : '')
    );
  }
  // The watchdog probes once a minute, so a just-booted app legitimately reads
  // `unknown` for up to that long. Unknown, and the caller decides whether to
  // wait: passing it would report health nobody measured.
  return result(
    'LAKEBASE_STORAGE_READABLE',
    'unknown',
    `The app reports storage as '${storage.state ?? 'nothing at all'}'. Nothing has read the store ` +
      'since it booted, so this is not yet an answer either way.'
  );
}

// --- The model and its manifest ---------------------------------------------

/** The served entity holding all the traffic, and the version behind it. */
export function servedVersion(endpoint: EndpointRecord | null): string {
  if (!endpoint) return '';
  const routes = endpoint.config?.traffic_config?.routes ?? [];
  const live = routes.filter((route) => (route.traffic_percentage ?? 0) === 100);
  if (live.length !== 1) return '';
  const entity = (endpoint.config?.served_entities ?? []).find(
    (candidate) => candidate.name === live[0].served_entity_name
  );
  return entity?.entity_version ?? '';
}

export function probeServedVersion(endpoint: EndpointRecord | null): CheckResult {
  if (!endpoint) {
    return notObserved('SERVED_VERSION_UNAMBIGUOUS', 'The serving endpoint was not read.');
  }
  const routes = endpoint.config?.traffic_config?.routes ?? [];
  const carrying = routes.filter((route) => (route.traffic_percentage ?? 0) > 0);
  if (carrying.length === 1 && (carrying[0].traffic_percentage ?? 0) === 100) {
    const version = servedVersion(endpoint);
    return result(
      'SERVED_VERSION_UNAMBIGUOUS',
      'pass',
      `Version ${version || '(unnamed)'} holds all the traffic.`,
      carrying[0].served_entity_name
    );
  }
  if (carrying.length === 0) {
    return result(
      'SERVED_VERSION_UNAMBIGUOUS',
      'fail',
      'No served entity is carrying traffic, so nothing answers a question on this endpoint.'
    );
  }
  return result(
    'SERVED_VERSION_UNAMBIGUOUS',
    'fail',
    `Traffic is split across ${carrying.length} versions (` +
      carrying.map((route) => `${route.served_entity_name ?? '?'} ${route.traffic_percentage ?? 0}%`).join(', ') +
      '). An observed answer cannot be attributed to a version, which makes every live check here ' +
      'ambiguous rather than merely uncertain.'
  );
}

/** Table dependencies the model version declares, fully qualified and sorted. */
export function manifestTables(version: ModelVersionRecord | null): string[] {
  const dependencies = version?.model_version_dependencies?.dependencies ?? [];
  return dependencies
    .map((dependency) => dependency.table?.table_full_name ?? '')
    .filter(Boolean)
    .sort();
}

/**
 * The data contract inside the manifest, one direction only.
 *
 * The surplus is REPORTED IN THE DETAIL OF A PASS rather than failed. The
 * manifest is enumerated from the catalog allowlist at log time and the
 * contract is the narrower list the Genie spaces curate, so a correct release
 * routinely declares more than the contract names.
 */
export function probeManifestCoverage(version: ModelVersionRecord | null, expected: string[] | null): CheckResult {
  if (!version) {
    return notObserved('MANIFEST_COVERS_DATA_CONTRACT', 'The served model version was not read.');
  }
  if (!expected) {
    return notObserved(
      'MANIFEST_COVERS_DATA_CONTRACT',
      'The data contract could not be resolved from agent/preflight.py.'
    );
  }
  const live = new Set(manifestTables(version));
  const missing = expected.filter((table) => !live.has(table)).sort();
  if (missing.length > 0) {
    return result(
      'MANIFEST_COVERS_DATA_CONTRACT',
      'fail',
      `Curated by a Genie space and NOT declared by the served version: ${missing.join(', ')}. ` +
        'Passthrough grants nothing on these, so every Genie call touching one fails and the ' +
        'agent answers from somewhere else.'
    );
  }
  const surplus = [...live].filter((table) => !expected.includes(table)).sort();
  return result(
    'MANIFEST_COVERS_DATA_CONTRACT',
    'pass',
    `All ${expected.length} tables the data contract names are in the served manifest.` +
      (surplus.length > 0
        ? ` It declares ${surplus.length} more the contract does not name (${surplus.join(', ')}), ` +
          'which is over-granted rather than broken.'
        : '')
  );
}

/**
 * How the run that logged the served version resolves the auth policy.
 *
 * Fails closed on anything that is not an explicit yes, mirroring
 * `user_authorization.resolve`. Reading it any more generously here would have
 * certification report a policy the serving container will not apply, and the
 * container is the one that decides. MLflow stringifies params, so a Python
 * `True` arrives as `"True"`, which is why the comparison is case-insensitive.
 */
export function loggedAuthPolicy(run: ModelRunRecord | null): UserAuthPolicyState {
  if (!run) return 'unknown';
  const raw = runParam(run, 'user_authorization');
  if (raw === null) return 'disabled';
  return raw.trim().toLowerCase() === 'true' ? 'enabled' : 'disabled';
}

/** What a target declares in `var.execution_identity`. */
export const USER_AUTHORIZATION = 'user-authorization';
export const SYSTEM_PASSTHROUGH = 'system-passthrough';

export function probeDeclaredIdentity(declared: string | null, run: ModelRunRecord | null): CheckResult {
  const code = 'EXECUTION_IDENTITY_AS_DECLARED';
  if (!declared) {
    return notObserved(code, 'The bundle did not resolve var.execution_identity for this target.');
  }
  if (declared !== USER_AUTHORIZATION && declared !== SYSTEM_PASSTHROUGH) {
    return result(
      code,
      'fail',
      `var.execution_identity is "${declared}", which is neither ${USER_AUTHORIZATION} nor ` +
        `${SYSTEM_PASSTHROUGH}. A declaration nothing recognises states no intent, so there is ` +
        'nothing to hold the served version against.'
    );
  }
  if (!run) {
    return notObserved(code, 'The MLflow run that logged the served version was not read.');
  }
  const policy = loggedAuthPolicy(run);
  const served = policy === 'enabled' ? USER_AUTHORIZATION : SYSTEM_PASSTHROUGH;
  if (served === declared) {
    return result(
      code,
      'pass',
      declared === USER_AUTHORIZATION
        ? 'The target declares user-authorization and the served version was logged with it, so ' +
            'Genie and SQL carry the signed-in user. Whether that user can sign in at all is a ' +
            'separate question: see OAUTH_SCOPE_CONSENT_PROVEN.'
        : 'The target declares system-passthrough and the served version was logged without a ' +
            'user auth policy. Data calls run as the endpoint principal, deliberately.'
    );
  }
  if (declared === USER_AUTHORIZATION) {
    return result(
      code,
      'fail',
      'The target declares user-authorization and the served version was logged WITHOUT it. This ' +
        'is the release that meant to and did not: the flag is baked in at log time, so a version ' +
        'cannot acquire the policy afterwards and no redeploy will fix it.'
    );
  }
  return result(
    code,
    'fail',
    'The served version was logged with user-authorization and the target declares ' +
      'system-passthrough. One of the two is out of date, and until they agree nobody can tell ' +
      'from this repository which identity the release intended.'
  );
}

/**
 * The two halves of the identity contract, held against each other.
 *
 * `appSendsSignedInUser` is null when the app's build commit could not be read,
 * which is a different thing from an app that sends nothing: the first is a
 * question nobody answered and the second is half of a working pair.
 */
export function probeIdentityContract(appSendsSignedInUser: boolean | null, run: ModelRunRecord | null): CheckResult {
  const code = 'IDENTITY_CONTRACT_PAIRED';
  if (appSendsSignedInUser === null) {
    return notObserved(
      code,
      'What the app build sends as its identity mode was not established from its build commit.'
    );
  }
  if (!run) {
    return notObserved(code, 'The MLflow run that logged the served version was not read.');
  }
  const policy = loggedAuthPolicy(run);
  if (policy === 'unknown') {
    return notObserved(code, 'The served version\u2019s auth policy was not established.');
  }
  const versionRunsAsCaller = policy === 'enabled';
  if (appSendsSignedInUser && versionRunsAsCaller) {
    return result(
      code,
      'pass',
      'The app build asks to run as the signed-in user and the served version was logged to do ' + 'exactly that.'
    );
  }
  if (!appSendsSignedInUser && !versionRunsAsCaller) {
    return result(
      code,
      'pass',
      'The app build sends no identity mode and the served version was logged without a user auth ' +
        'policy. The older pairing, and a working one.'
    );
  }
  if (appSendsSignedInUser) {
    return result(
      code,
      'fail',
      'The app build asks to run as the signed-in user and the served version was logged WITHOUT ' +
        'a user auth policy, so it has no invoker token to be. Every question refuses with ' +
        'IDENTITY_REQUIRED, and there is no service-principal path left to fall back to. Re-log ' +
        'the version with the policy, or deploy the app build that pairs with this one.'
    );
  }
  return result(
    code,
    'fail',
    'The served version was logged with a user auth policy and the app build sends no identity ' +
      'mode. The version refuses a request that declares no user, so every question fails. This ' +
      'is the same release arriving in halves, in the other order.'
  );
}

// --- The live app ------------------------------------------------------------

export function probeAgentEndpoint(preflight: PreflightRecord | null): CheckResult {
  if (!preflight) {
    return notObserved('AGENT_ENDPOINT_REACHABLE', 'The app did not answer /api/preflight.');
  }
  const check = (preflight.checks ?? []).find((entry) => entry.id === 'agent-endpoint');
  if (!check) {
    return result(
      'AGENT_ENDPOINT_REACHABLE',
      'unknown',
      'The preflight response carried no agent-endpoint check, so whether the app can invoke the ' +
        'Player Insights Agent model was not reported.'
    );
  }
  if (check.status === 'ok') {
    return result(
      'AGENT_ENDPOINT_REACHABLE',
      'pass',
      'The app invoked the endpoint and it answered. Nothing behind it is covered by this: the ' +
        'served version no longer reports its dependencies.'
    );
  }
  return result(
    'AGENT_ENDPOINT_REACHABLE',
    'fail',
    `The app could not invoke the Player Insights Agent model. ${check.detail ?? ''}`.trim()
  );
}

export function probeDrift(settings: SettingsRecord | null): CheckResult {
  if (!settings) return notObserved('CONFIGURATION_DRIFT_CLEAR', 'The app did not answer /api/settings.');
  const blocking = (settings.drift ?? []).filter((finding) => finding.severity === 'blocking');
  if (blocking.length > 0) {
    return result(
      'CONFIGURATION_DRIFT_CLEAR',
      'fail',
      `${blocking.length} blocking drift finding(s): ` +
        blocking.map((finding) => finding.headline ?? finding.id ?? '?').join('; ') +
        '.'
    );
  }
  if (settings.status === 'unknown' || settings.orchestratorReported === false) {
    return result(
      'CONFIGURATION_DRIFT_CLEAR',
      'unknown',
      'The Player Insights Agent model did not report its configuration, so what the running system used could ' +
        'not be compared with what it was configured with. No blocking finding is not the same as ' +
        'no drift.'
    );
  }
  return result(
    'CONFIGURATION_DRIFT_CLEAR',
    'pass',
    'The app reports no resource in use that differs from the one configured.'
  );
}
