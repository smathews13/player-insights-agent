/**
 * THE set of things this deployment is connected to, and what it takes to change
 * each one.
 *
 *   - App settings arrive as environment variables in the app container, written
 *     into the deployed app.yaml by scripts/deploy-app-yaml.mjs at release time.
 *     An app redeploy changes them.
 *   - Orchestrator settings are BAKED INTO THE MLFLOW MODEL ARTIFACT at log
 *     time, by `mlflow.pyfunc.log_model(model_config=...)`. Nothing the app can
 *     write reaches them. The Genie space ids and the catalog the orchestrator
 *     actually uses live in that artifact, and only a new model version changes
 *     them.
 *
 * Nothing in the app can apply an orchestrator setting. The pane can STAGE one,
 * recording the value the deployer intends, and reports it as staged rather
 * than active until a model version carries it; `applyWith` is the command that
 * closes that gap. `stageable` and `changedBy` are separate fields so staging
 * cannot be mistaken for applying.
 */

/** What it takes to change a value, once a deployment exists. */
export type ChangedBy =
  /** In the model artifact. Only a new model version changes it. */
  | 'model-version'
  /** In the app container's environment. Only an app redeploy changes it. */
  | 'app-redeploy'
  /** The app reads it per request, so a stored override applies at once. */
  | 'app-runtime'
  /** A literal in application source. Only editing the source changes it. */
  | 'app-source'
  /** Read from a process environment a served entity does not inherit. */
  | 'agent-environment';

/**
 * The five tiers, with the sentence a reader needs.
 *
 * The identifiers are shared with `agent/config.py`, which names the same five
 * for the settings it resolves; `deployment-config.test.ts` parses that file and
 * fails if this list drifts from it. The prose is authored here, once, because
 * this is the side that displays it: a second copy in Python would be a second
 * thing to keep in step for no reader's benefit.
 */
export const CHANGED_BY: Record<
  ChangedBy,
  { label: string; note: string; appliesImmediately: boolean }
> = {
  'model-version': {
    label: 'New model version',
    note:
      'Baked into the MLflow model artifact when the agent was logged. No form can change it: the ' +
      'same values name the resources automatic authentication passthrough grants this version, so ' +
      'a runtime override could aim the orchestrator at a warehouse it has no permission to use.',
    appliesImmediately: false,
  },
  'app-redeploy': {
    label: 'App redeploy',
    note:
      'Arrives as an environment variable in the app container, written into the deployed app.yaml ' +
      'at release time. Set it in the bundle target and release the app.',
    appliesImmediately: false,
  },
  'app-runtime': {
    label: 'Editable here',
    note: 'The app reads this on every request, so a value saved here takes effect immediately.',
    appliesImmediately: true,
  },
  'app-source': {
    label: 'Edit app source',
    note:
      'A literal in application source with no variable that overrides it. Changing it means ' +
      'editing the source and redeploying.',
    appliesImmediately: false,
  },
  'agent-environment': {
    label: 'Not reachable in serving',
    note:
      'Read from the orchestrator process environment, which a served entity does not inherit from ' +
      'anything a deployer controls. Inside the endpoint it is always the compiled default.',
    appliesImmediately: false,
  },
};

/** What kind of thing is on the other end, for grouping and iconography. */
export type ResourceKind =
  | 'agent'
  | 'model'
  | 'genie-space'
  | 'sql-warehouse'
  | 'unity-catalog'
  | 'lakebase'
  | 'volume'
  | 'observability'
  | 'app-behaviour';

export interface ConnectedResource {
  /** Stable key. Used by both surfaces and by any stored override. */
  id: string;
  label: string;
  kind: ResourceKind;
  /** What the deployment uses it for, in one sentence. */
  purpose: string;
  changedBy: ChangedBy;
  /** How the value physically reaches the process that reads it. */
  arrivesBy: string;
  /** The bundle variable a deployer sets, when there is one. */
  bundleVariable: string | null;
  /** The `agent/config.py` field, when the orchestrator owns this value. */
  agentKey: string | null;
  /** The app's environment variable, when the app owns this value. */
  appEnvVar: string | null;
  /**
   * The preflight check whose `name` carries the value ACTUALLY in use.
   *
   * This is what makes "configured" and "in use" separable. The check ran inside
   * the serving endpoint against the value the artifact gave it, so a check name
   * that disagrees with what the deployer believes they configured is the drift
   * this whole surface exists to expose.
   */
  actualFromCheck: string | null;
  /** The command that applies a change. Shown verbatim, to be copied. */
  applyWith: string;
  /**
   * Whether the settings pane may record an intended value for it.
   *
   * Staging is not applying. A staged orchestrator setting is reported as
   * pending until a model version carries it.
   */
  stageable: boolean;
}

const AGENT_RELEASE = 'TARGET=<target> bundle/agent-release.sh --apply';
const APP_RELEASE = 'TARGET=<target> bundle/app-release.sh --apply';

/**
 * Every connection, orchestrator first because that is the half people are
 * surprised by.
 *
 * Derived from the code rather than from a description of it: the orchestrator
 * entries are exactly `config.py`'s `ENV_VARS` keys that name a resource, and
 * the app entries are exactly the variables `app.yaml` declares plus the two
 * resources it reads through `valueFrom`.
 */
export const CONNECTED_RESOURCES: ConnectedResource[] = [
  {
    id: 'agent-endpoint',
    label: 'Orchestrator serving endpoint',
    kind: 'agent',
    purpose: 'Runs the Player Insights orchestrator. Every question the app asks goes through it.',
    changedBy: 'app-redeploy',
    arrivesBy:
      'The app resource named `serving-endpoint`, read into DATABRICKS_SERVING_ENDPOINT_NAME by ' +
      'app.yaml. The endpoint itself is created by databricks.agents.deploy(), not by the bundle.',
    bundleVariable: 'serving_endpoint_name',
    agentKey: null,
    appEnvVar: 'DATABRICKS_SERVING_ENDPOINT_NAME',
    actualFromCheck: 'agent-endpoint',
    applyWith: `${APP_RELEASE}   # after changing the app resource in databricks.yml`,
    stageable: false,
  },
  {
    id: 'llm-endpoint',
    label: 'Foundation model',
    kind: 'model',
    purpose: 'The model the orchestrator plans with, reads Genie results with, and writes prose with.',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config, baked by agent/log_model.py at log time.',
    bundleVariable: 'llm_endpoint',
    agentKey: 'llm_endpoint',
    appEnvVar: null,
    actualFromCheck: 'llm-endpoint',
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'llm-gateway',
    label: 'AI Gateway route',
    kind: 'model',
    purpose:
      'Whether model calls go through your Unity AI Gateway, so your usage tracking, cost ' +
      'attribution, rate limits and guardrails apply to them. Blank (the default), calls ' +
      'the serving endpoint directly and is correct for a workspace with no gateway.',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config, baked by agent/log_model.py at log time.',
    bundleVariable: 'llm_gateway',
    agentKey: 'llm_gateway',
    appEnvVar: null,
    // No check probes this. Preflight makes a real one-token call over whichever
    // route is bound, so a gateway that refuses this deployment fails the
    // release rather than the first stakeholder's question, which is a better
    // answer than a green tick here would be.
    actualFromCheck: null,
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'genie-data',
    label: 'Data Genie space',
    kind: 'genie-space',
    purpose: 'Answers governed metric questions and returns cited query results.',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config, and a DatabricksGenieSpace resource on the same model version.',
    bundleVariable: 'genie_data_space_id, or resources.genie_spaces.data_genie_space when the bundle made it',
    agentKey: 'data_genie_space_id',
    appEnvVar: null,
    actualFromCheck: 'genie-data',
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'genie-dictionary',
    label: 'Dictionary Genie space',
    kind: 'genie-space',
    purpose: 'Resolves business definitions before an ambiguous field is used.',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config, and a DatabricksGenieSpace resource on the same model version.',
    bundleVariable:
      'genie_dictionary_space_id, or resources.genie_spaces.dictionary_genie_space when the bundle made it',
    agentKey: 'dictionary_genie_space_id',
    appEnvVar: null,
    actualFromCheck: 'genie-dictionary',
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'sql-warehouse',
    label: 'SQL warehouse',
    kind: 'sql-warehouse',
    purpose: 'Runs the orchestrator’s read-only generated SQL and every table read probe.',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config, and a DatabricksSQLWarehouse resource on the same model version.',
    bundleVariable: 'warehouse_id',
    agentKey: 'warehouse_id',
    appEnvVar: null,
    actualFromCheck: 'sql-warehouse',
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'catalog',
    label: 'Unity Catalog catalog',
    kind: 'unity-catalog',
    purpose: 'Holds the player-insights tables and the registered orchestrator model.',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config, baked by agent/log_model.py at log time.',
    bundleVariable: 'catalog',
    agentKey: 'catalog',
    appEnvVar: null,
    actualFromCheck: null,
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'schema',
    label: 'Unity Catalog schema',
    kind: 'unity-catalog',
    purpose: 'The schema inside the catalog that the data contract’s tables live in.',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config, baked by agent/log_model.py at log time.',
    bundleVariable: 'schema',
    agentKey: 'schema',
    appEnvVar: null,
    actualFromCheck: null,
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'catalog-allowlist',
    label: 'Readable scopes',
    kind: 'unity-catalog',
    purpose:
      'The scopes the orchestrator may read. Enumerated at log time into one DatabricksTable ' +
      'resource per table, which is exactly what the serving principal is granted.',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config; the table list it produces is baked alongside it.',
    bundleVariable: 'catalog_allowlist',
    agentKey: 'catalog_allowlist',
    appEnvVar: null,
    actualFromCheck: null,
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'catalog-denylist',
    label: 'Excluded tables',
    kind: 'unity-catalog',
    purpose:
      'Patterns naming tables that must never be declared even inside an allowlisted scope. ' +
      'The one setting whose absence widens what the orchestrator can read.',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config, baked by agent/log_model.py at log time.',
    bundleVariable: 'catalog_denylist',
    agentKey: 'catalog_denylist',
    appEnvVar: null,
    actualFromCheck: null,
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'declared-manifest',
    label: 'Declared tables',
    kind: 'unity-catalog',
    purpose:
      'Every table named as a model resource, and so the exact reach of the serving principal. ' +
      'Generated from the readable scopes at log time, never written by hand.',
    changedBy: 'model-version',
    arrivesBy: 'Generated by agent/preflight.py during the log, then baked into the artifact.',
    bundleVariable: null,
    agentKey: 'declared_manifest',
    appEnvVar: null,
    actualFromCheck: null,
    applyWith: AGENT_RELEASE,
    stageable: false,
  },
  {
    id: 'max-output-tokens',
    label: 'Answer length limit',
    kind: 'model',
    purpose: 'Caps the orchestrator’s output tokens.',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config, baked by agent/log_model.py at log time.',
    bundleVariable: 'max_output_tokens',
    agentKey: 'max_output_tokens',
    appEnvVar: null,
    actualFromCheck: null,
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'lakebase',
    label: 'Lakebase (Postgres)',
    kind: 'lakebase',
    purpose:
      'Stores conversations, documents, feedback and benchmark runs. While it is unreachable ' +
      'every list in the app shows seeded demonstration rows instead of the deployment’s own.',
    changedBy: 'app-redeploy',
    arrivesBy: 'The app resource named `postgres`, read into LAKEBASE_ENDPOINT by app.yaml.',
    bundleVariable: 'lakebase_project_id / lakebase_branch_id / lakebase_database_id',
    agentKey: null,
    appEnvVar: 'LAKEBASE_ENDPOINT',
    actualFromCheck: 'lakebase-storage',
    applyWith: `${APP_RELEASE}   # after changing the app resource in databricks.yml`,
    stageable: false,
  },
  {
    id: 'lakebase-schema',
    label: 'Lakebase schema',
    kind: 'lakebase',
    purpose: 'The Postgres schema the app creates and owns inside that database.',
    changedBy: 'app-source',
    arrivesBy:
      'A bare SQL identifier in the app’s own DDL (server/routes/insights-routes.ts). ' +
      'var.lakebase_app_schema documents it but nothing reads that variable. Postgres ' +
      'privileges live inside the database, out of the control plane’s reach.',
    // Null on purpose, even though `var.lakebase_app_schema` exists. NOTHING
    // READS THAT VARIABLE, so recording it here as this resource's configuration
    // route would offer a value that changes nothing when set, which is the
    // exact shape of the defect this registry is built to prevent and the one
    // place in this deployment where it is already true.
    bundleVariable: null,
    agentKey: null,
    appEnvVar: null,
    actualFromCheck: null,
    applyWith:
      'Edit the DDL in server/routes/insights-routes.ts, var.lakebase_app_schema, and the grant\n' +
      'script that parses the DDL (scripts/grant-app-db-access.mjs). All three have to move\n' +
      'together: change one alone and the deployer grants on a schema the app never creates,\n' +
      'after which every route serves representative data and still answers HTTP 200. A\n' +
      'release-time advisory check compares the first two and prints a mismatch, but it\n' +
      'reports rather than gates, so nothing stops a release that carries one.',
    stageable: false,
  },
  {
    id: 'assets-volume',
    label: 'Assets volume',
    kind: 'volume',
    purpose:
      'A Unity Catalog volume the bundle creates for raw snapshots. NOTHING READS IT AT RUNTIME: ' +
      'the orchestrator never opens it, and per-conversation documents come from uploads stored ' +
      'in Lakebase. It used to hold published knowledge documents describing the demo data; those ' +
      'were removed rather than shipped, because they describe a dataset a customer does not have.',
    changedBy: 'app-redeploy',
    arrivesBy: 'Created empty by the bundle. Nothing in a deploy writes to it.',
    bundleVariable: 'volume',
    agentKey: null,
    appEnvVar: null,
    actualFromCheck: null,
    applyWith: 'Set var.volume and redeploy the bundle.',
    stageable: false,
  },
  {
    id: 'experiment-id',
    label: 'MLflow experiment',
    kind: 'observability',
    purpose:
      'The experiment the endpoint traces into. Used only to deep-link a stored trace; without ' +
      'it the trace id is still shown, just not as a link.',
    changedBy: 'app-runtime',
    arrivesBy:
      'PLAYER_INSIGHTS_EXPERIMENT_ID, resolved from var.experiment_path at release time. The app ' +
      'reads a saved override first, so a deployment whose experiment did not exist at release ' +
      'can fix the link without a redeploy.',
    bundleVariable: 'experiment_path',
    agentKey: null,
    appEnvVar: 'PLAYER_INSIGHTS_EXPERIMENT_ID',
    actualFromCheck: null,
    applyWith: 'Save it here, or set var.experiment_path and release the app.',
    stageable: false,
  },
  {
    id: 'judge-endpoint',
    label: 'Benchmark judge model',
    kind: 'model',
    purpose: 'Scores benchmark answers. Used by the Benchmark Lab, never on the answer path.',
    changedBy: 'app-runtime',
    arrivesBy:
      'PLAYER_INSIGHTS_JUDGE_ENDPOINT, read per benchmark run. The app reads a saved override ' +
      'first, then the variable, then a compiled default.',
    bundleVariable: 'judge_endpoint',
    agentKey: null,
    appEnvVar: 'PLAYER_INSIGHTS_JUDGE_ENDPOINT',
    actualFromCheck: null,
    applyWith: 'Save it here, or set var.judge_endpoint and release the app.',
    stageable: false,
  },
  {
    id: 'shared-conversation-rail',
    label: 'Shared conversation rail',
    kind: 'app-behaviour',
    purpose:
      'Whether the rail lists everyone’s conversations or only the signed-in user’s. Off ' +
      'everywhere by default: per-user scoping is the fix for an identity-tenancy hole.',
    changedBy: 'app-redeploy',
    arrivesBy: 'PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL, resolved from the bundle at release time.',
    bundleVariable: 'shared_conversation_rail',
    agentKey: null,
    appEnvVar: 'PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL',
    actualFromCheck: null,
    // Deliberately NOT app-runtime even though the value is a boolean the app
    // could read per request. Widening it exposes one person's conversations to
    // another, and a control that dangerous should require a release someone
    // reviewed, not a switch on a settings page.
    applyWith: `${APP_RELEASE}   # after setting var.shared_conversation_rail`,
    stageable: false,
  },
];

const BY_ID = new Map(CONNECTED_RESOURCES.map((resource) => [resource.id, resource]));

export function connectedResource(id: string): ConnectedResource | undefined {
  return BY_ID.get(id);
}

/** The ids a form on the settings page may write, and nothing else. */
export const RUNTIME_EDITABLE_IDS = CONNECTED_RESOURCES.filter((resource) => resource.changedBy === 'app-runtime'
).map((resource) => resource.id);

/**
 * The ids the settings pane may record an intended value for.
 */
export const STAGEABLE_IDS = CONNECTED_RESOURCES.filter((resource) => resource.stageable).map((resource) => resource.id
);

/** Whether a value saved for this id would take effect, or only be recorded. */
export function appliesImmediately(id: string): boolean {
  const resource = BY_ID.get(id);
  return resource ? CHANGED_BY[resource.changedBy].appliesImmediately : false;
}
