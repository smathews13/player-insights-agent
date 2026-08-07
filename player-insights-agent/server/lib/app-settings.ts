/**
 * What this deployment is connected to, what it was asked to be connected to,
 * and where those two disagree.
 */
import {
  CHANGED_BY,
  CONNECTED_RESOURCES,
  connectedResource,
  type ChangedBy,
  type ConnectedResource,
} from '../../shared/deployment-config';
import { DEFAULT_JUDGE_ENDPOINT } from '../../shared/benchmark-contract';
import type { LakebaseReader } from './lakebase-store';
import type { PreflightReport } from '../routes/insights-routes';

/**
 * Where a stored value sits between being typed and being in force.
 *
 * `active` is only ever written for a resource the app reads per request.
 * Everything else is `intended`, and the pane says so on the row: an intended
 * Genie space id has changed nothing until a model version carries it.
 */
export type StoredIntent = 'active' | 'intended';

export interface StoredSetting {
  resourceId: string;
  value: string;
  intent: StoredIntent;
  updatedAt: string;
  updatedBy: string;
  note: string;
}

/**
 * Added to the app's own DDL rather than created here, so there is one place the
 * app declares what it stores and one schema name to keep correct.
 */
export const DEPLOYMENT_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS player_insights.deployment_settings (resource_id TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     intent TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_by TEXT NOT NULL
   )`;

export const STORED_SETTINGS_QUERY = `
  SELECT resource_id, value, intent, note, updated_at, updated_by
  FROM player_insights.deployment_settings
  ORDER BY resource_id`;

/**
 * One row per resource, last write winning.
 *
 * Not versioned. A settings row is the current intention, and a history of
 * intentions nobody applied would be a second thing to read and reconcile
 * against the drift report, which is the record that actually matters.
 */
export const UPSERT_SETTING_QUERY = `
  INSERT INTO player_insights.deployment_settings (resource_id, value, intent, note, updated_by, updated_at)
  VALUES ($1, $2, $3, $4, $5, now())
  ON CONFLICT (resource_id) DO UPDATE
    SET value = EXCLUDED.value,
        intent = EXCLUDED.intent,
        note = EXCLUDED.note,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
  RETURNING resource_id, value, intent, note, updated_at, updated_by`;

export const DELETE_SETTING_QUERY = `
  DELETE FROM player_insights.deployment_settings WHERE resource_id = $1 RETURNING resource_id`;

function storedFromRow(row: Record<string, unknown>): StoredSetting {
  const updatedAt = row.updated_at;
  return {
    resourceId: String(row.resource_id ?? ''),
    value: String(row.value ?? ''),
    intent: row.intent === 'active' ? 'active' : 'intended',
    note: String(row.note ?? ''),
    updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : String(updatedAt ?? ''),
    updatedBy: String(row.updated_by ?? ''),
  };
}

/**
 * Every stored setting, or none.
 *
 * A Lakebase outage answers with an empty map rather than throwing, and the
 * caller reports the store as unavailable. The alternative (failing the whole
 * settings read), would take down the page whose job is to explain why the rest
 * of the app is degraded.
 */
export async function readStoredSettings(client: LakebaseReader): Promise<Map<string, StoredSetting>> {
  try {
    const result = await client.lakebase.query(STORED_SETTINGS_QUERY);
    const rows = (result?.rows ?? []) as Record<string, unknown>[];
    return new Map(rows.map((row) => [String(row.resource_id ?? ''), storedFromRow(row)]));
  } catch (error) {
    console.warn('[settings] Stored settings could not be read:', (error as Error).message);
    return new Map();
  }
}

export async function writeStoredSetting(client: LakebaseReader,
  setting: { resourceId: string; value: string; intent: StoredIntent; note: string; updatedBy: string }
): Promise<StoredSetting> {
  const result = await client.lakebase.query(UPSERT_SETTING_QUERY, [
    setting.resourceId,
    setting.value,
    setting.intent,
    setting.note,
    setting.updatedBy,
  ]);
  const row = ((result?.rows ?? []) as Record<string, unknown>[])[0];
  if (!row) throw new Error('the settings row was not written back');
  return storedFromRow(row);
}

export async function clearStoredSetting(client: LakebaseReader, resourceId: string): Promise<boolean> {
  const result = await client.lakebase.query(DELETE_SETTING_QUERY, [resourceId]);
  return ((result?.rows ?? []) as unknown[]).length > 0;
}

/**
 * The judge model a benchmark run should score with.
 */
export async function resolveJudgeEndpoint(client: LakebaseReader): Promise<string> {
  const stored = await readStoredSettings(client);
  const saved = stored.get('judge-endpoint');
  if (saved?.intent === 'active' && saved.value) return saved.value;
  return process.env.PLAYER_INSIGHTS_JUDGE_ENDPOINT?.trim() || DEFAULT_JUDGE_ENDPOINT;
}

/**
 * The MLflow experiment a stored trace id is deep-linked into.
 */
export async function resolveExperimentId(client: LakebaseReader): Promise<string> {
  const stored = await readStoredSettings(client);
  const saved = stored.get('experiment-id');
  if (saved?.intent === 'active' && saved.value) return saved.value;
  return process.env.PLAYER_INSIGHTS_EXPERIMENT_ID?.trim() ?? '';
}

/**
 * Every `app-runtime` resource, and the function that reads it per request.
 *
 * The point of the map is that it can be compared against the registry. A
 * resource in that tier with no entry here is a value the settings pane promises
 * takes effect immediately and nothing reads, which is the defect
 * `deployment-config.ts` was written to prevent, and which was sitting inside the
 * registry itself for `experiment-id`. `app-settings.test.ts` fails if the two
 * lists ever disagree, so the promise is enforced rather than remembered.
 */
export const APP_RUNTIME_RESOLVERS: Record<string, (client: LakebaseReader) => Promise<string>> = {
  'judge-endpoint': resolveJudgeEndpoint,
  'experiment-id': resolveExperimentId,
};

/** The app's own build, stamped into the deploy tree at release time. */
export function appBuildSha(): string {
  return process.env.PLAYER_INSIGHTS_BUILD_SHA?.trim() ?? '';
}

/**
 * What the app container's environment says, for the resources the app owns.
 *
 * Read here and nowhere else in this module, so the settings payload has exactly
 * one place the environment is consulted.
 */
export function appEnvironment(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const resource of CONNECTED_RESOURCES) {
    if (!resource.appEnvVar) continue;
    values[resource.appEnvVar] = process.env[resource.appEnvVar]?.trim() ?? '';
  }
  return values;
}

export type DriftSeverity = 'blocking' | 'warning' | 'pending' | 'unknown' | 'note';

export interface DriftFinding {
  id: string;
  severity: DriftSeverity;
  resourceId: string | null;
  headline: string;
  detail: string;
  /** What to do about it, or '' when the answer is "nothing, this is a statement". */
  remedy: string;
}

export interface ResourceState {
  resource: ConnectedResource;
  /** What the deployment was told to use, and where that came from. */
  configured: string;
  configuredFrom: string;
  /** What the running system demonstrably used, or '' when nothing proved it. */
  actual: string;
  /** Whether anything measured `actual`, as opposed to it merely being absent. */
  actualObserved: boolean;
  /** A value somebody saved and has not applied. */
  intended: string | null;
  intendedAt: string;
  intendedBy: string;
  /** Whether saving a value here changes the running system. */
  editable: boolean;
}

/**
 * What the app does when its variable is unset.
 *
 * An empty environment variable is not "no value": the code behind it falls
 * through to a compiled default and the deployment behaves accordingly. Showing a
 * dash for these would hide the behaviour a deployer is actually getting, which is
 * the same class of error as hiding drift. Only the two the app itself resolves
 * are listed; a variable with no fallback genuinely has nothing to show.
 */
const APP_DEFAULTS: Record<string, string> = {
  'judge-endpoint': DEFAULT_JUDGE_ENDPOINT,
  'shared-conversation-rail': 'false',
};

/**
 * The catalog and schema the orchestrator actually read from, taken from the
 * tables it proved it could reach.
 */
function namespaceInUse(checks: Array<{ kind?: string; name?: string }>) {
  const prefixes = new Set<string>();
  for (const check of checks) {
    if (check.kind !== 'table' || !check.name) continue;
    const parts = check.name.split('.');
    if (parts.length === 3) prefixes.add(`${parts[0]}.${parts[1]}`);
  }
  if (prefixes.size !== 1) return null;
  const [catalog, schema] = [...prefixes][0].split('.');
  return { catalog, schema };
}

/** A short, readable form of whatever a configuration value turned out to be. */
function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.length <= 3 ? value.join(', ') : `${value.length} entries`;
  }
  return String(value);
}

/**
 * Line up one resource's configured, actual and intended values.
 *
 * `actual` comes from the preflight check named on the resource, because that
 * check ran inside the serving endpoint against the value the artifact gave it.
 * `configured` prefers the orchestrator's own report of what it resolved and
 * falls back to the app's environment. For a resource with neither, both stay
 * empty and `actualObserved` is false, which the pane renders as "not measured"
 * rather than as agreement.
 */
export function resourceStates(input: {
  report: PreflightReport | null;
  environment: Record<string, string>;
  stored: Map<string, StoredSetting>;
}): ResourceState[] {
  const { report, environment, stored } = input;
  const byCheck = new Map((report?.checks ?? []).map((check) => [check.id, check]));
  const configuration = new Map((report?.configuration ?? []).map((entry) => [String(entry.key), entry])
  );
  const namespace = namespaceInUse(report?.checks ?? []);

  return CONNECTED_RESOURCES.map((resource) => {
    const entry = resource.agentKey ? configuration.get(resource.agentKey) : undefined;
    const check = resource.actualFromCheck ? byCheck.get(resource.actualFromCheck) : undefined;
    const saved = stored.get(resource.id);

    let configured = '';
    let configuredFrom = '';
    if (entry) {
      configured = displayValue((entry as { value?: unknown }).value);
      configuredFrom = String((entry as { source?: unknown }).source ?? '');
    } else if (resource.appEnvVar) {
      configured = environment[resource.appEnvVar] ?? '';
      configuredFrom = 'app-environment';
      if (!configured && resource.id in APP_DEFAULTS) {
        configured = APP_DEFAULTS[resource.id];
        configuredFrom = 'app-default';
      }
      // An active override IS the value in force. It is what the app reads on
      // the next request, ahead of both the variable and the default. Reporting
      // the variable here instead would make the page disagree with the code
      // that resolves the value, which is the one thing it must never do.
      if (saved?.intent === 'active' && saved.value) {
        configured = saved.value;
        configuredFrom = 'app-saved';
      }
    }

    // A check whose name is a table's full name, or the endpoint's own name, is
    // the value in use. A check with no name proved nothing about a value, and
    // the namespace fallback is a value the table checks demonstrated together
    // rather than one any single check reported.
    let actual = check?.name ?? '';
    let actualObserved = Boolean(check && check.name);
    if (!actualObserved && namespace) {
      if (resource.id === 'catalog') {
        actual = namespace.catalog;
        actualObserved = true;
      } else if (resource.id === 'schema') {
        actual = namespace.schema;
        actualObserved = true;
      }
    }

    return {
      resource,
      configured,
      configuredFrom,
      actual,
      actualObserved,
      intended: saved && saved.intent === 'intended' ? saved.value : null,
      intendedAt: saved?.updatedAt ?? '',
      intendedBy: saved?.updatedBy ?? '',
      editable: CHANGED_BY[resource.changedBy].appliesImmediately,
    };
  });
}

const ARTIFACT = 'artifact';

/**
 * Everywhere the deployment disagrees with itself.
 *
 * Ordered by how much it matters, because a page of equal-looking rows is a page
 * nobody reads to the bottom of. Each finding names the resource so the pane can
 * put it beside the row it is about as well as at the top.
 */
export function computeDrift(input: {
  report: PreflightReport | null;
  states: ResourceState[];
  appBuildSha: string;
}): DriftFinding[] {
  const { report, states, appBuildSha: appSha } = input;
  const findings: DriftFinding[] = [];

  // 1. The orchestrator never answered, so nothing below it was measured.
  if (!report || report.source !== 'agent') {
    findings.push({
      id: 'orchestrator-unreachable',
      severity: 'unknown',
      resourceId: 'agent-endpoint',
      headline: 'Nothing the orchestrator uses could be read',
      detail:
        'The serving endpoint did not answer with a report, so every value below is what this ' +
        'deployment was CONFIGURED with and none of it is what the orchestrator demonstrably used. ' +
        'Treat agreement as unknown rather than confirmed.',
      // Under "What to fix" on the same page since Sources & Capabilities was
      // merged into Connections. Sending a reader to another page for it would
      // now be sending them in a circle.
      remedy: 'Fix the blocked checks under “What to fix” above, then re-check.',
    });
    return findings;
  }

  // 2. The served version predates provenance reporting. Distinguished from
  //    "everything came from the artifact", which looks identical if the absence
  //    of the field is read as an empty answer.
  if (!report.configuration || report.configuration.length === 0) {
    findings.push({
      id: 'configuration-unreported',
      severity: 'unknown',
      resourceId: null,
      headline: 'The served model version does not report its own configuration',
      detail:
        'This endpoint answered, but the model version running on it was logged before the ' +
        'configuration report existed. What the orchestrator was configured with cannot be read ' +
        'from it, only what the checks below proved it could reach. The two are not the same claim.',
      remedy: 'Log and roll out a model version from a build that carries the report.',
    });
  }

  // 3. A value that names one workspace's data, which reached a serving
  //    container by some route other than the artifact. This is the defect
  //    config.py exists to prevent, seen from the outside.
  for (const state of states) {
    if (!state.resource.agentKey || !state.configuredFrom) continue;
    if (state.configuredFrom === ARTIFACT || state.configuredFrom === 'app-environment') continue;
    findings.push({
      id: `provenance-${state.resource.id}`,
      severity: 'blocking',
      resourceId: state.resource.id,
      headline: `${state.resource.label} did not come from the model artifact`,
      detail:
        `The orchestrator resolved this from ${state.configuredFrom}, not from the model version ` +
        'it is serving. Nothing in the registry records where that value came from, and the ' +
        'resources automatic authentication passthrough granted this version were named from the ' +
        'artifact, so what it is pointed at and what it is permitted to reach can differ.',
      remedy: state.resource.applyWith,
    });
  }

  // 4. Configured and actual disagree. Only reported where something actually
  //    measured `actual`; an unmeasured value is unknown, not equal.
  for (const state of states) {
    if (!state.actualObserved || !state.configured) continue;
    if (state.actual === state.configured) continue;
    findings.push({
      id: `mismatch-${state.resource.id}`,
      severity: 'blocking',
      resourceId: state.resource.id,
      headline: `${state.resource.label} in use is not the one configured`,
      detail:
        `Configured as ${state.configured}, but the check that ran inside the endpoint used ` +
        `${state.actual}. The running system is not doing what this deployment's configuration says.`,
      remedy: state.resource.applyWith,
    });
  }

  // 5. Somebody recorded an intention that has not been applied. Pending, not
  //    broken, but silently storing it and showing it as the value would be
  //    the lie this whole surface is built to avoid.
  for (const state of states) {
    if (!state.intended) continue;
    const inForce = state.actualObserved ? state.actual : state.configured;
    if (state.intended === inForce) continue;
    findings.push({
      id: `pending-${state.resource.id}`,
      severity: 'pending',
      resourceId: state.resource.id,
      headline: `${state.resource.label} has an intended value that is not in effect`,
      detail:
        `Saved as ${state.intended}${state.intendedBy ? ` by ${state.intendedBy}` : ''}, while the ` +
        `deployment is using ${inForce || '(nothing)'}. Saving it here recorded the intention; it ` +
        'changed nothing about the running system.',
      remedy: state.resource.applyWith,
    });
  }

  // 6. App and orchestrator built from different commits. This is the comparison
  //    the model version's build stamp was added for: it reports its own stamp
  //    and cannot see the app's, so the app is the only place the two meet.
  const modelSha = report.build_sha ?? '';
  if (!appSha || !modelSha) {
    findings.push({
      id: 'build-skew-unknown',
      severity: 'unknown',
      resourceId: null,
      headline: 'App and orchestrator builds cannot be compared',
      detail:
        (!appSha
          ? 'This app build carries no stamp, so it does not know which commit it came from. '
          : '') +
        (!modelSha
          ? 'The served model version carries no stamp, so it predates the build stamp. '
          : '') +
        'Agreement between the two is unknown here, not confirmed: a matching feature set cannot ' +
        'be assumed from the absence of a warning.',
      remedy: !modelSha ? 'Re-log the model to stamp it.' : 'Release the app from a stamped build.',
    });
  } else if (appSha !== modelSha) {
    findings.push({
      id: 'build-skew',
      severity: 'warning',
      resourceId: null,
      headline: 'App and orchestrator were built from different commits',
      detail:
        `The app is running ${appSha} and the served model version was logged from ${modelSha}. ` +
        'That is normal between releases (the two deploy separately), and it is the explanation ' +
        'to reach for first when the app expects a field the orchestrator does not send.',
      remedy: 'Release both from the same commit when the answer contract has changed.',
    });
  }

  const dirty = [appSha, modelSha].filter((sha) => sha.endsWith('+dirty'));
  if (dirty.length > 0) {
    findings.push({
      id: 'build-dirty',
      severity: 'warning',
      resourceId: null,
      headline: 'Something here was built from a modified working tree',
      detail:
        `${dirty.join(' and ')} records uncommitted tracked changes at build time, so the artifact ` +
        'cannot be reproduced from any commit.',
      remedy: 'Release from a clean worktree.',
    });
  }

  return findings;
}

/**
 * The overall verdict, on the same terms the preflight page uses: never
 * reassuring while anything is unmeasured.
 */
export function driftStatus(findings: DriftFinding[]): 'ok' | 'blocked' | 'pending' | 'unknown' {
  if (findings.some((finding) => finding.severity === 'blocking')) return 'blocked';
  if (findings.some((finding) => finding.severity === 'unknown')) return 'unknown';
  if (findings.some((finding) => finding.severity === 'pending')) return 'pending';
  return 'ok';
}

export interface SettingsPayload {
  resources: Array<
    Omit<ResourceState, 'resource'> & {
      resource: ConnectedResource;
      changedByLabel: string;
      changedByNote: string;
    }
  >;
  drift: DriftFinding[];
  status: ReturnType<typeof driftStatus>;
  appBuildSha: string;
  modelBuildSha: string;
  /** Whether the orchestrator's own configuration report was available. */
  orchestratorReported: boolean;
  storeAvailable: boolean;
  checkedAt: string;
}

/** Assemble the whole payload. Pure, so the route stays a courier. */
export function settingsPayload(input: {
  report: PreflightReport | null;
  environment: Record<string, string>;
  stored: Map<string, StoredSetting>;
  appBuildSha: string;
  storeAvailable: boolean;
}): SettingsPayload {
  const states = resourceStates(input);
  const drift = computeDrift({
    report: input.report,
    states,
    appBuildSha: input.appBuildSha,
  });
  return {
    resources: states.map((state) => ({
      ...state,
      changedByLabel: CHANGED_BY[state.resource.changedBy].label,
      changedByNote: CHANGED_BY[state.resource.changedBy].note,
    })),
    drift,
    status: driftStatus(drift),
    appBuildSha: input.appBuildSha,
    modelBuildSha: input.report?.build_sha ?? '',
    orchestratorReported: Boolean(input.report?.configuration?.length),
    storeAvailable: input.storeAvailable,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Whether a value may be written for this resource, and as what.
 */
export function classifyWrite(resourceId: string,
  requested: StoredIntent
): { ok: true; intent: StoredIntent; changedBy: ChangedBy } | { ok: false; reason: string } {
  const resource = connectedResource(resourceId);
  if (!resource) return { ok: false, reason: `${resourceId} is not a resource this deployment has.` };
  const tier = CHANGED_BY[resource.changedBy];
  if (requested === 'active' && !tier.appliesImmediately) {
    return {
      ok: false,
      reason:
        `${resource.label} cannot be changed by saving a value: ${tier.note} ` +
        `Save it as an intended value instead, then apply it with: ${resource.applyWith}`,
    };
  }
  if (requested === 'intended' && !resource.stageable && !tier.appliesImmediately) {
    return {
      ok: false,
      reason:
        `${resource.label} takes no intended value. ${tier.note} ` +
        'Recording an intention for it would suggest this app could apply it.',
    };
  }
  return { ok: true, intent: requested, changedBy: resource.changedBy };
}
