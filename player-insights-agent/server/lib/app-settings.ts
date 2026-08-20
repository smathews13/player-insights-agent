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
import { APP_SCHEMA, DEFAULT_APP_SCHEMA } from '../../shared/app-schema';
import type { AppFacts } from '../../shared/app-facts';
import { parseAncestorList } from '../../shared/build-stamps';
import type { LakebaseReader } from './lakebase-store';
import type { PreflightReport } from '../routes/insights-routes';
import { workspaceExperimentIdResolver, type ExperimentIdResolver } from './experiment-probe';

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
export const DEPLOYMENT_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.deployment_settings (resource_id TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     intent TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_by TEXT NOT NULL
   )`;

export const STORED_SETTINGS_QUERY = `
  SELECT resource_id, value, intent, note, updated_at, updated_by
  FROM ${APP_SCHEMA}.deployment_settings
  ORDER BY resource_id`;

/**
 * One row per resource, last write winning.
 *
 * Not versioned. A settings row is the current intention, and a history of
 * intentions nobody applied would be a second thing to read and reconcile
 * against the drift report, which is the record that actually matters.
 */
export const UPSERT_SETTING_QUERY = `
  INSERT INTO ${APP_SCHEMA}.deployment_settings (resource_id, value, intent, note, updated_by, updated_at)
  VALUES ($1, $2, $3, $4, $5, now())
  ON CONFLICT (resource_id) DO UPDATE
    SET value = EXCLUDED.value,
        intent = EXCLUDED.intent,
        note = EXCLUDED.note,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
  RETURNING resource_id, value, intent, note, updated_at, updated_by`;

export const DELETE_SETTING_QUERY = `
  DELETE FROM ${APP_SCHEMA}.deployment_settings WHERE resource_id = $1 RETURNING resource_id`;

/**
 * A scalar, or nothing.
 *
 * Anything that is not already a string, number or boolean is read as ABSENT
 * rather than stringified, and that is the entire point. `String(someObject)` is
 * `'[object Object]'`, which is a NON-EMPTY string, so every emptiness guard
 * below it passes and every equality test below it fails — a value nobody could
 * read becomes a value that loudly disagrees with the one in use. On this page
 * that is a red blocking row about a resource that is fine, which is the one
 * thing it must never show.
 *
 * The same helper `insights-routes.ts` and `dependency-probes.ts` keep, and a
 * copy rather than an import on purpose: this module is imported BY
 * `insights-routes.ts`, so taking a value from it would close a require cycle
 * for four lines of code.
 */
function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function storedFromRow(row: Record<string, unknown>): StoredSetting {
  const updatedAt = row.updated_at;
  return {
    resourceId: text(row.resource_id) ?? '',
    value: text(row.value) ?? '',
    intent: row.intent === 'active' ? 'active' : 'intended',
    note: text(row.note) ?? '',
    updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : (text(updatedAt) ?? ''),
    updatedBy: text(row.updated_by) ?? '',
  };
}

/**
 * How long a resolver may reuse the settings table it already read.
 *
 * These rows are typed by an administrator once in a while and read on the hot
 * path: every answer resolves the judge endpoint, and every Monitoring drawer
 * resolves the experiment id. Both were a round trip to Lakebase per request for
 * a table that changes about never.
 *
 * Forty-five seconds is chosen against what the staleness can cost. An admin who
 * changes a value through THIS app sees it immediately, because writing clears
 * the entry (see below). The only stale read possible is a value changed on
 * another replica, and the worst it does is send one answer to the previous judge
 * endpoint or link a trace into the previous experiment. Neither is a wrong
 * answer to a person's question, and neither is a permission: nothing in this
 * table grants anything, so caching it cannot widen access.
 */
export const STORED_SETTINGS_TTL_MS = 45_000;

/**
 * Held per client, not per process.
 *
 * A `WeakMap` because the key is whoever asked, and two readers pointed at
 * different databases must not answer each other's questions. There is one
 * client in the running app, so this costs nothing there; it is what keeps the
 * cache honest anywhere there is more than one.
 */
let settingsCache = new WeakMap<object, { at: number; settings: Map<string, StoredSetting> }>();

/**
 * Forget the cached settings.
 *
 * Called by the two writers below, so an administrator who saves a value on this
 * deployment sees it in force on the next request rather than up to
 * {@link STORED_SETTINGS_TTL_MS} later. Exported for tests.
 */
export function forgetStoredSettings(): void {
  settingsCache = new WeakMap();
}

/**
 * Every stored setting, or none.
 *
 * A Lakebase outage answers with an empty map rather than throwing, and the
 * caller reports the store as unavailable. The alternative (failing the whole
 * settings read), would take down the page whose job is to explain why the rest
 * of the app is degraded.
 *
 * `maxAgeMs` is how old an already-read copy may be. It defaults to ZERO, so
 * every existing caller — the settings pane above all — still reads the table.
 * That default is deliberate: the pane's entire job is to state what this
 * deployment is set to, and a pane that can be 45 seconds behind the table it is
 * describing is the one place the staleness would be a defect rather than a
 * saving. The hot-path resolvers opt in instead.
 *
 * A FAILED read is never cached. Caching the empty map an outage produces would
 * turn one unavailable moment into 45 seconds of resolvers silently falling back
 * to environment defaults, which is a wrong value held on purpose.
 */
export async function readStoredSettings(client: LakebaseReader,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<Map<string, StoredSetting>> {
  const maxAge = options.maxAgeMs ?? 0;
  const now = options.now ?? Date.now();
  const cached = settingsCache.get(client);
  if (cached && maxAge > 0 && now - cached.at < maxAge) return cached.settings;
  try {
    const result = await client.lakebase.query(STORED_SETTINGS_QUERY);
    const rows = result?.rows ?? [];
    // Keyed from the row's OWN id rather than from a second reading of the same
    // column, so the key and the record it points at cannot come to disagree.
    const settings = new Map(rows.map((row) => {
        const setting = storedFromRow(row);
        return [setting.resourceId, setting] as const;
      })
    );
    settingsCache.set(client, { at: now, settings });
    return settings;
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
  const row = (result?.rows ?? [])[0];
  if (!row) throw new Error('the settings row was not written back');
  forgetStoredSettings();
  return storedFromRow(row);
}

export async function clearStoredSetting(client: LakebaseReader, resourceId: string): Promise<boolean> {
  const result = await client.lakebase.query(DELETE_SETTING_QUERY, [resourceId]);
  forgetStoredSettings();
  return (result?.rows ?? []).length > 0;
}

/**
 * The judge model a benchmark run should score with.
 */
export async function resolveJudgeEndpoint(client: LakebaseReader): Promise<string> {
  const stored = await readStoredSettings(client, { maxAgeMs: STORED_SETTINGS_TTL_MS });
  const saved = stored.get('judge-endpoint');
  if (saved?.intent === 'active' && saved.value) return saved.value;
  return process.env.PLAYER_INSIGHTS_JUDGE_ENDPOINT?.trim() || DEFAULT_JUDGE_ENDPOINT;
}

/**
 * A workspace experiment path resolved to its numeric id, kept for the life of
 * the process.
 *
 * The id a path maps to does not change while a deployment runs, so it is
 * resolved on the first Monitoring drawer that needs it and held after -- off the
 * MLflow API and off the request hot path, the way `bundle/app-release.sh`
 * resolved it once at release. Only a SUCCESSFUL resolve is kept: an empty answer
 * (no experiment at that path yet, or the workspace could not be asked) is
 * retried next time, so a deployment that creates the experiment after boot picks
 * it up without a restart. The same "a FAILED read is never cached" rule the
 * stored settings above follow.
 */
const experimentIdByPath = new Map<string, string>();

/** Forget resolved ids, so a test starts from a clean cache. Exported for tests. */
export function forgetResolvedExperimentIds(): void {
  experimentIdByPath.clear();
}

/**
 * The MLflow experiment a stored trace id is deep-linked into.
 *
 * Three sources, most specific first. An admin's active override, then the id the
 * release resolved into the environment, then -- when no id was supplied -- the
 * workspace PATH resolved to an id at runtime. A "From Git" deploy never runs the
 * release that fills the id, so it ships only the stable path; this is what gives
 * it the deep link the release path has always had.
 */
export async function resolveExperimentId(
  client: LakebaseReader,
  resolvePath: ExperimentIdResolver = workspaceExperimentIdResolver,
): Promise<string> {
  const stored = await readStoredSettings(client, { maxAgeMs: STORED_SETTINGS_TTL_MS });
  const saved = stored.get('experiment-id');
  if (saved?.intent === 'active' && saved.value) return saved.value;

  const fromEnv = process.env.PLAYER_INSIGHTS_EXPERIMENT_ID?.trim();
  if (fromEnv) return fromEnv;

  const path = process.env.PLAYER_INSIGHTS_EXPERIMENT_PATH?.trim();
  if (!path) return '';
  const cached = experimentIdByPath.get(path);
  if (cached) return cached;
  const resolved = (await resolvePath(path)).trim();
  if (resolved) experimentIdByPath.set(path, resolved);
  return resolved;
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
/**
 * The table a notebook publishes its declaration to.
 *
 * Read per settings read rather than per answer: this names a document the page
 * compares against, and nothing on the answer path consults it. Cached on the same
 * terms as the two above, which is safe for the same reason -- nothing in this
 * table grants anything, so a stale read cannot widen access.
 */
export async function resolveNotebookDeclaration(client: LakebaseReader): Promise<string> {
  const stored = await readStoredSettings(client, { maxAgeMs: STORED_SETTINGS_TTL_MS });
  const saved = stored.get('notebook-declaration');
  if (saved?.intent === 'active' && saved.value) return saved.value;
  return process.env.PLAYER_INSIGHTS_NOTEBOOK_DECLARATION?.trim() ?? '';
}

export const APP_RUNTIME_RESOLVERS: Record<string, (client: LakebaseReader) => Promise<string>> = {
  'judge-endpoint': resolveJudgeEndpoint,
  'experiment-id': resolveExperimentId,
  'notebook-declaration': resolveNotebookDeclaration,
};

/** The app's own build, stamped into the deploy tree at release time. */
export function appBuildSha(): string {
  return process.env.PLAYER_INSIGHTS_BUILD_SHA?.trim() ?? '';
}

/** Commits reachable from the stamped app build, captured while git was available. */
export function appBuildAncestors(): string[] {
  return parseAncestorList(process.env.PLAYER_INSIGHTS_BUILD_ANCESTORS);
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
  // Same string as DEFAULT_APP_SCHEMA / var.lakebase_app_schema. Authored into
  // app.yaml so From-Git deploys usually set the env; this fallback covers an
  // older deploy tree that pre-dates the env and must never show "not set".
  'lakebase-schema': DEFAULT_APP_SCHEMA,
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

/**
 * A short, readable form of whatever a configuration value turned out to be, or
 * '' when there is no honest short form of it.
 *
 * The orchestrator's report is deliberately permissive about this field — the
 * app and the model version deploy separately, so a version reporting a setting
 * this build has never heard of must not fail the parse and cost the page every
 * other value. That permissiveness ends here: a value this function cannot
 * render is reported as ABSENT, which the checks below already handle correctly
 * (see the note on the provenance loop) and which the pane already renders as
 * "not set". The alternative is `'[object Object]'` in a value column, and,
 * worse, in the sentence of a blocking finding claiming a disagreement.
 *
 * A list is unreadable if ANY of its elements is, rather than per element: half
 * a list read as a whole one is a wrong answer stated confidently, which is a
 * worse outcome on this page than no answer.
 *
 * Lists are always joined, never summarised as "N entries". The Connections
 * page labels each `data_catalogs` entry as a whole catalog or a single schema,
 * and that reading needs the names themselves. Counting them and discarding the
 * names was how the agent's read boundary became invisible on the page.
 */
function displayValue(value: unknown): string {
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (const item of value) {
      const entry = text(item);
      if (entry === null) return '';
      entries.push(entry);
    }
    return entries.join(', ');
  }
  return text(value) ?? '';
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
      configured = displayValue(entry.value);
      // Read through the same guard, because the empty string is what the
      // provenance loop below means by "this version did not say", and a
      // provenance nobody can read is exactly that rather than a route the
      // artifact did not sanction.
      configuredFrom = text(entry.source) ?? '';
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
 * The healthiest state this page has, written so a reader can tell.
 *
 * ONE CONSTANT BECAUSE THERE ARE TWO CALL SITES. An absent report and a
 * configuration-only report are different routes to the same sentence, and the
 * sentence was duplicated at both — which is how two copies of user-facing copy end
 * up disagreeing after one of them is edited.
 *
 * REWRITTEN BECAUSE IT DID NOT SURVIVE ITS FIRST READER. The previous wording led
 * with "does not report what it uses" and explained itself in terms of dependency
 * reports and model versions, so the person who owns this deployment read it and
 * asked what it meant. On a page whose only job is to be believed, a notice that has
 * to be explained is doing negative work: a reader who cannot tell a statement from
 * a fault assumes a fault, and the next real one arrives to an audience that has
 * already learnt this page cries wolf.
 *
 * So it leads with the fact that nothing is wrong, says what the values below are in
 * words that do not require knowing what a preflight was, and gives the reason in one
 * clause rather than a paragraph. `severity: 'unknown'` is unchanged: the page must
 * not claim to have confirmed agreement it never measured, which is the defect that
 * was removed from this file earlier.
 */
const ORCHESTRATOR_REPORT_RETIRED: DriftFinding = {
  id: 'orchestrator-report-retired',
  severity: 'unknown',
  resourceId: 'agent-endpoint',
  headline: 'Everything is running. The settings below are unconfirmed, not wrong',
  detail:
    'The agent is answering normally. It does not send back a list of what it used, and that ' +
    'is deliberate: whether a particular person can read a particular table is answered by ' +
    'Unity Catalog, which enforces it, rather than by the agent describing itself. So the ' +
    'values below are what this deployment was set up with, and this page does not claim to ' +
    'have watched them being used. Nothing here means anything is broken.',
  // Nothing to fix. Re-logging the model does not bring the report back, and a
  // remedy offered for a healthy deployment is how remedies stop being read on the
  // day one is real.
  remedy: '',
};

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
  /**
   * Whether the endpoint answered at all, whatever it answered with.
   *
   * Absent means unknown, which is reported as unreachable: the safe reading
   * when nobody established otherwise. Only an explicit `true` buys the
   * quieter wording below.
   */
  endpointAnswered?: boolean;
}): DriftFinding[] {
  const { report, states, endpointAnswered } = input;
  const findings: DriftFinding[] = [];

  // 1. No report, which is two conditions that read alike and are not alike.
  //    Both leave the values below unconfirmed, so both are `unknown`; only one
  //    of them is a fault. Saying the endpoint did not answer, of an endpoint
  //    that answered, sends a deployer to debug serving on the page they came
  //    to for reassurance, and it is the page they would show a customer.
  //
  //    Split from the `source` case below on purpose. This one has NOTHING to
  //    read, so it returns; that one has a configuration report and no
  //    measurements, and the checks that read a configuration still mean
  //    something there.
  if (!report) {
    findings.push(endpointAnswered === true
      ? { ...ORCHESTRATOR_REPORT_RETIRED }
      : {
          id: 'orchestrator-unreachable',
          severity: 'unknown',
          resourceId: 'agent-endpoint',
          // Plainer for the same reason as the constant above, and deliberately NOT
          // reassuring in the way that one is: this branch means the agent did not
          // answer, which is a fault, and the two must not read alike at a glance.
          headline: 'The agent did not answer, so nothing below could be checked',
          detail:
            'The serving endpoint did not reply, so the values below are only what this deployment ' +
            'was set up with. None of them have been checked against anything, and an answer asked ' +
            'right now would probably fail too.',
          // Under "What to fix" on the same page since Sources & Capabilities was
          // merged into Connections. Sending a reader to another page for it would
          // now be sending them in a circle.
          remedy: 'Fix the blocked checks under “What to fix” above, then re-check.',
        }
    );
    return findings;
  }

  // 1b. The endpoint answered with its configuration and measured nothing. Said
  //     here rather than left to the reader, because every value on the page
  //     came back from the endpoint and therefore LOOKS measured.
  //
  //     Deliberately not an early return, which is what the first fix for this
  //     did: the build stamp and the provenance of each value ARE reported on
  //     this path, so returning here threw away the two comparisons a
  //     configuration report can genuinely support, and a deployment running a
  //     stale model would have been told nothing. Everything below that needs a
  //     measurement already guards on having one.
  if (report.source !== 'agent') {
    findings.push({ ...ORCHESTRATOR_REPORT_RETIRED });
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
    /**
     * An ABSENT value has no provenance to doubt, which check 4 already knows and
     * this one did not.
     *
     * Read the sentence above the loop: the defect being hunted is a value that
     * NAMES ONE WORKSPACE'S DATA arriving by a route other than the artifact. An
     * empty string names nothing, points at nothing, and grants nothing, so there
     * is no gap between what it aims at and what passthrough permits — the two
     * halves of the claim in `detail` are both vacuous.
     *
     * WHAT THIS COST. `llm_gateway` is optional and deliberately unset on every
     * target: empty means talk to the serving endpoint directly. `Settings`
     * therefore resolves it from its own default, which is neither the artifact nor
     * the app environment, so every deployment without an AI Gateway raised a
     * BLOCKING finding — the strongest severity there is, and the one that turns
     * the whole page's status to `blocked`. A deployment in exactly the state its
     * bundle asked for read as misconfigured, on the one screen whose entire value
     * is that a reader can believe it. A check that cries wolf on a correct
     * deployment does not get read carefully on the day it is right.
     */
    if (!state.configured) continue;
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

  // App and orchestrator releases are independent. Their real stamps are exposed
  // in the Build and telemetry card, without turning a missing or different
  // commit into a warning that has no reliable compatibility meaning.

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
  appBuildAncestors: string[];
  modelBuildSha: string;
  /** Whether the orchestrator's own configuration report was available. */
  orchestratorReported: boolean;
  storeAvailable: boolean;
  checkedAt: string;
  /**
   * What the deployment says about itself, where the workspace answered.
   *
   * Assembled by `app-metadata.ts` rather than here, and passed in, because it
   * is the one part of this payload that needs a workspace call: keeping the
   * call out of this function is what leaves the rest of it pure.
   */
  app?: AppFacts;
}

/** Assemble the whole payload. Pure, so the route stays a courier. */
export function settingsPayload(input: {
  report: PreflightReport | null;
  environment: Record<string, string>;
  stored: Map<string, StoredSetting>;
  appBuildSha: string;
  appBuildAncestors?: readonly string[];
  storeAvailable: boolean;
  /** Whether the endpoint replied, which is not the same as it reporting. */
  endpointAnswered?: boolean;
  /** The app's own record, where the workspace answered about it. */
  app?: AppFacts;
}): SettingsPayload {
  const states = resourceStates(input);
  const drift = computeDrift({
    report: input.report,
    states,
    endpointAnswered: input.endpointAnswered,
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
    appBuildAncestors: [...(input.appBuildAncestors ?? [])],
    modelBuildSha: input.report?.build_sha ?? '',
    orchestratorReported: Boolean(input.report?.configuration?.length),
    storeAvailable: input.storeAvailable,
    checkedAt: new Date().toISOString(),
    app: input.app,
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
  // Option B (Sam 2026-08-18): admins may RECORD an intention for every
  // connection row, including ones that previously padlocked (Lakebase, VS,
  // Shared rail, orchestrator endpoint, …). Recording is not applying: only
  // app-runtime rows take effect live; everything else stays intended until
  // the documented applyWith path runs. stageable remains the Apply-plan flag
  // for model-version knobs and is independent of this gate.
  if (requested === 'intended') {
    return { ok: true, intent: 'intended', changedBy: resource.changedBy };
  }
  return { ok: true, intent: requested, changedBy: resource.changedBy };
}
