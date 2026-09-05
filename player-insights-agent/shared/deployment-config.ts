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
export const CHANGED_BY: Record<ChangedBy, { label: string; note: string; appliesImmediately: boolean }> = {
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
  | 'vector-search'
  | 'app-behaviour';

export interface ConnectedResource {
  /** Stable key. Used by both surfaces and by any stored override. */
  id: string;
  label: string;
  kind: ResourceKind;
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
  /**
   * Whether this value names something outside the app that a check could ask.
   *
   * False for the deployment's own settings -- a token cap, two lists of catalog
   * patterns, a Postgres schema name, a boolean -- and for the assets volume,
   * which no runtime path opens and which the Apps API refuses to grant a scope
   * for. The MLflow experiment is a remote trace destination even though its
   * probe runs as the app rather than through a forwarded user scope.
   *
   * IT DECIDES `Not checked` AGAINST `Nothing to reach`, and getting it from
   * `agentKey` was wrong. That field says who OWNS a value, not whether anything
   * is on the other end of it, so three orchestrator settings with no object
   * anywhere -- the token cap and both catalog lists -- sat permanently under
   * "Not checked", which promises a verdict that no check could ever deliver.
   */
  namesRemoteObject: boolean;
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
 * entries are `config.py`'s `ENV_VARS` keys that name a resource, and the app
 * entries are exactly the variables `app.yaml` declares plus the two resources it
 * reads through `valueFrom`.
 *
 * One orchestrator entry is not an `ENV_VARS` key: the semantic index. It is
 * resolved in `semantic_retrieval.py` rather than as a `Settings` field, and is
 * reported alongside the rest of the configuration. What matters here is that the
 * endpoint reports it, not where it lives in the agent.
 */
export const CONNECTED_RESOURCES: ConnectedResource[] = [
  {
    id: 'agent-endpoint',
    label: 'Orchestrator serving endpoint',
    kind: 'agent',
    changedBy: 'app-redeploy',
    arrivesBy:
      'The app resource named `serving-endpoint`, read into DATABRICKS_SERVING_ENDPOINT_NAME by ' +
      'app.yaml. The endpoint itself is created by databricks.agents.deploy(), not by the bundle.',
    bundleVariable: 'serving_endpoint_name',
    agentKey: null,
    appEnvVar: 'DATABRICKS_SERVING_ENDPOINT_NAME',
    actualFromCheck: 'agent-endpoint',
    namesRemoteObject: true,
    applyWith: `${APP_RELEASE}   # after changing the app resource in databricks.yml`,
    stageable: false,
  },
  {
    id: 'llm-endpoint',
    label: 'Foundation model',
    kind: 'model',
    changedBy: 'model-version',
    arrivesBy:
      'MLflow model_config, baked by agent/log_model.py at log time, or PLAYER_INSIGHTS_LLM_ENDPOINT ' +
      'when the app release wrote the same bundle variable into the container.',
    bundleVariable: 'llm_endpoint',
    agentKey: 'llm_endpoint',
    appEnvVar: 'PLAYER_INSIGHTS_LLM_ENDPOINT',
    actualFromCheck: 'llm-endpoint',
    namesRemoteObject: true,
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'llm-gateway',
    label: 'AI Gateway',
    kind: 'model',
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
    namesRemoteObject: true,
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'genie-data',
    label: 'Data Genie space',
    kind: 'genie-space',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config, and a DatabricksGenieSpace resource on the same model version.',
    bundleVariable: 'genie_data_space_id, naming a space the bundle attaches to rather than creates',
    agentKey: 'data_genie_space_id',
    appEnvVar: null,
    actualFromCheck: 'genie-data',
    namesRemoteObject: true,
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'genie-dictionary',
    label: 'Dictionary Genie space',
    kind: 'genie-space',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config, and a DatabricksGenieSpace resource on the same model version.',
    bundleVariable: 'genie_dictionary_space_id, naming a space the bundle attaches to rather than creates',
    agentKey: 'dictionary_genie_space_id',
    appEnvVar: null,
    actualFromCheck: 'genie-dictionary',
    namesRemoteObject: true,
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'sql-warehouse',
    label: 'SQL warehouse',
    kind: 'sql-warehouse',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config, and a DatabricksSQLWarehouse resource on the same model version.',
    bundleVariable: 'warehouse_id',
    agentKey: 'warehouse_id',
    appEnvVar: null,
    actualFromCheck: 'sql-warehouse',
    namesRemoteObject: true,
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'catalog',
    label: 'App catalog',
    kind: 'unity-catalog',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config, baked by agent/log_model.py at log time.',
    bundleVariable: 'app_catalog',
    agentKey: 'catalog',
    appEnvVar: null,
    actualFromCheck: null,
    namesRemoteObject: true,
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'schema',
    label: 'App schema',
    kind: 'unity-catalog',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config, baked by agent/log_model.py at log time.',
    bundleVariable: 'app_schema',
    agentKey: 'schema',
    appEnvVar: null,
    actualFromCheck: null,
    namesRemoteObject: true,
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'catalog-allowlist',
    label: 'Data catalogs',
    kind: 'unity-catalog',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config; the table list it produces is baked alongside it.',
    bundleVariable: 'data_catalogs',
    agentKey: 'catalog_allowlist',
    appEnvVar: null,
    actualFromCheck: null,
    namesRemoteObject: false,
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'catalog-denylist',
    label: 'Excluded tables',
    kind: 'unity-catalog',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config, baked by agent/log_model.py at log time.',
    bundleVariable: 'catalog_denylist',
    agentKey: 'catalog_denylist',
    appEnvVar: null,
    actualFromCheck: null,
    namesRemoteObject: false,
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'declared-manifest',
    label: 'Declared tables',
    kind: 'unity-catalog',
    changedBy: 'model-version',
    arrivesBy: 'Generated by agent/preflight.py during the log, then baked into the artifact.',
    bundleVariable: null,
    agentKey: 'declared_manifest',
    appEnvVar: null,
    // The rollup `withManifestRollup` derives from the individual table checks.
    // Named here rather than left null so a version that reported no manifest
    // reads `Not checked` -- unknown -- rather than as a row with nothing behind
    // it. There IS something behind it; twelve checks stand for it.
    actualFromCheck: 'declared-manifest',
    namesRemoteObject: true,
    applyWith: AGENT_RELEASE,
    stageable: false,
  },
  {
    id: 'max-output-tokens',
    label: 'Answer length limit',
    kind: 'model',
    changedBy: 'model-version',
    arrivesBy: 'MLflow model_config, baked by agent/log_model.py at log time.',
    bundleVariable: 'max_output_tokens',
    agentKey: 'max_output_tokens',
    appEnvVar: null,
    actualFromCheck: null,
    namesRemoteObject: false,
    applyWith: AGENT_RELEASE,
    stageable: true,
  },
  {
    id: 'lakebase',
    label: 'Lakebase (Postgres)',
    kind: 'lakebase',
    changedBy: 'app-redeploy',
    arrivesBy: 'The app resource named `postgres`, read into LAKEBASE_ENDPOINT by app.yaml.',
    bundleVariable: 'lakebase_project_id / lakebase_branch_id / lakebase_database_id',
    agentKey: null,
    appEnvVar: 'LAKEBASE_ENDPOINT',
    actualFromCheck: 'lakebase-storage',
    namesRemoteObject: true,
    applyWith: `${APP_RELEASE}   # after changing the app resource in databricks.yml`,
    stageable: false,
  },
  {
    id: 'lakebase-schema',
    label: 'Lakebase schema',
    kind: 'lakebase',
    changedBy: 'app-redeploy',
    arrivesBy:
      'PLAYER_INSIGHTS_APP_SCHEMA, resolved from var.lakebase_app_schema at release time ' +
      '(a source-only Git deploy maps the legacy authored player_insights value to the app-owned ' +
      'astrolabe schema). Created by the app on boot; bundle targets keep their configured schema.',
    bundleVariable: 'lakebase_app_schema',
    agentKey: null,
    appEnvVar: 'PLAYER_INSIGHTS_APP_SCHEMA',
    actualFromCheck: null,
    namesRemoteObject: false,
    applyWith:
      'Set var.lakebase_app_schema and release the app so PLAYER_INSIGHTS_APP_SCHEMA updates.\n' +
      'Then grant on the new schema (scripts/grant-app-db-access.mjs) and migrate any data.\n' +
      'Changing the variable alone does not move existing tables.',
    stageable: false,
  },
  {
    id: 'assets-volume',
    label: 'Assets volume',
    kind: 'volume',
    changedBy: 'app-redeploy',
    arrivesBy: 'Created empty by the bundle. Nothing in a deploy writes to it.',
    bundleVariable: 'volume',
    agentKey: null,
    appEnvVar: null,
    actualFromCheck: null,
    namesRemoteObject: false,
    applyWith: 'Set var.volume and redeploy the bundle.',
    stageable: false,
  },
  {
    id: 'semantic-index',
    label: 'Vector Search index',
    kind: 'vector-search',
    changedBy: 'model-version',
    arrivesBy:
      'PLAYER_INSIGHTS_SEMANTIC_INDEX, read from the environment when the model is logged and ' +
      'baked into the artifact. `true` derives the name from the catalog and schema, a ' +
      'three-level name adopts an index built elsewhere, and unset means this release has no ' +
      'semantic layer at all — which is a supported deployment, not a fault.',
    // There is no bundle variable for the flag itself. The bundle declares the
    // index and its endpoint; whether a model version SEARCHES one is decided by
    // the environment the release script logs it from.
    bundleVariable: null,
    agentKey: 'semantic_index',
    appEnvVar: 'PLAYER_INSIGHTS_SEMANTIC_INDEX',
    actualFromCheck: null,
    namesRemoteObject: true,
    applyWith: 'Set PLAYER_INSIGHTS_SEMANTIC_INDEX and re-log the model. The app cannot change it.',
    stageable: false,
  },
  {
    id: 'semantic-index-endpoint',
    label: 'Vector Search endpoint',
    kind: 'vector-search',
    changedBy: 'app-redeploy',
    arrivesBy:
      'Created by the bundle from var.semantic_index_endpoint. Nothing passes its name to the app or ' +
      'to the orchestrator, so it is read back from the index, which reports the endpoint serving it.',
    bundleVariable: 'semantic_index_endpoint',
    agentKey: null,
    appEnvVar: 'PLAYER_INSIGHTS_SEMANTIC_ENDPOINT',
    // The app's own probe, keyed by this id. Named here rather than left null so
    // an unprobed row reads `Not checked` -- `nothing-to-reach` is for a value
    // the app both resolves and applies, and this one has a real remote end.
    actualFromCheck: 'semantic-index-endpoint',
    namesRemoteObject: true,
    applyWith: 'Set var.semantic_index_endpoint and redeploy the bundle.',
    stageable: false,
  },
  {
    id: 'experiment-id',
    label: 'MLflow experiment',
    kind: 'observability',
    changedBy: 'app-runtime',
    arrivesBy:
      'PLAYER_INSIGHTS_EXPERIMENT_ID, resolved from var.experiment_path at release time, or ' +
      'PLAYER_INSIGHTS_EXPERIMENT_PATH resolved to an id at runtime when the id is empty (a ' +
      '"From Git" deploy, which never runs the release). The app reads a saved override first, so ' +
      'a deployment whose experiment did not exist at release can fix the link without a redeploy.',
    bundleVariable: 'experiment_path',
    agentKey: null,
    appEnvVar: 'PLAYER_INSIGHTS_EXPERIMENT_ID',
    // The app's own read, keyed by this id. It used to be null, which badged the
    // row `Nothing to reach` -- the state for a value the app resolves and applies
    // with no remote end -- on a card that says in its next line that the
    // experiment receives the trace of every run and offers a link to open it. A
    // deleted or mistyped id therefore rendered a dead link under a badge saying
    // there was nothing there to be wrong.
    //
    // Read as the APPLICATION and not as the reader, which is the only exception
    // in this file, because Databricks Apps has no MLflow scope to forward. See
    // server/lib/experiment-probe.ts, which carries the rejected names and says
    // in every verdict whose read it was.
    actualFromCheck: 'experiment-id',
    // A real remote destination. The app writes every trace there and probes it
    // under its own identity, so filtering remote resources must keep this row.
    // Marking it false dropped the successful check before Architecture derived
    // its cards, leaving the node red while Ops showed the same experiment green.
    namesRemoteObject: true,
    applyWith: 'Save it here, or set var.experiment_path and release the app.',
    stageable: false,
  },
  {
    id: 'judge-endpoint',
    label: 'Benchmark judge model',
    kind: 'model',
    changedBy: 'app-runtime',
    arrivesBy:
      'PLAYER_INSIGHTS_JUDGE_ENDPOINT, read per benchmark run. The app reads a saved override ' +
      'first, then the variable, then a compiled default.',
    bundleVariable: 'judge_endpoint',
    agentKey: null,
    appEnvVar: 'PLAYER_INSIGHTS_JUDGE_ENDPOINT',
    actualFromCheck: null,
    namesRemoteObject: true,
    applyWith: 'Save it here, or set var.judge_endpoint and release the app.',
    stageable: false,
  },
  {
    id: 'notebook-declaration',
    // NOT "Notebook", which is what this row said for as long as it has existed
    // and which is wrong in the one way that matters: a reader who is asked for
    // a notebook reasonably tries to give it one. The value is a TABLE. A
    // notebook writes a row into it saying what that notebook was configured
    // with, and this app reads the newest row. Pointing this at a notebook path
    // cannot work, and the reason is not a missing feature: what the app needs
    // is the values the notebook RAN with, and a notebook file holds variable
    // names rather than the values they resolved to. Only a run knows those,
    // and a run is what publishes the row.
    label: 'Notebook declarations table',
    kind: 'unity-catalog',
    // The one connection on this page whose value genuinely takes effect at once,
    // and it is worth being clear about what "takes effect" means for it: the app
    // reads the declaration this names on every settings read. It changes what this
    // page COMPARES AGAINST. It does not change what the orchestrator may read,
    // because that list is baked into the model artifact -- see
    // shared/notebook-declaration.ts, which classifies every publishable key and
    // refuses the one that grants tables.
    changedBy: 'app-runtime',
    arrivesBy:
      'The three-part Unity Catalog name of the table a notebook publishes to, not the notebook ' +
      'itself. A notebook run appends one row saying what it was configured with, and the app ' +
      'reads the newest row as the signed-in user on each settings read, so a value saved here ' +
      'is used on the next one. Which notebook published it is in the row, so this page can name ' +
      'the notebook without being told it. PLAYER_INSIGHTS_NOTEBOOK_DECLARATION supplies the ' +
      'initial value.',
    bundleVariable: null,
    agentKey: null,
    appEnvVar: 'PLAYER_INSIGHTS_NOTEBOOK_DECLARATION',
    // Probed by the read itself rather than by a dependency check: the useful
    // verdict is whether THIS reader could fetch the declaration under their own
    // grants, which is what the read establishes and a check on the table's
    // existence would not.
    actualFromCheck: 'notebook-declaration',
    namesRemoteObject: true,
    applyWith: 'Save it here, or set PLAYER_INSIGHTS_NOTEBOOK_DECLARATION before releasing the app.',
    // Not stageable, and the reason is the tier rather than an omission: staging is
    // for a value only a new model version can apply, and this one applies now.
    stageable: false,
  },
  {
    id: 'shared-conversation-rail',
    label: 'Shared conversation rail',
    kind: 'app-behaviour',
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
    namesRemoteObject: false,
    applyWith: `${APP_RELEASE}   # after setting var.shared_conversation_rail`,
    stageable: false,
  },
];

const BY_ID = new Map(CONNECTED_RESOURCES.map((resource) => [resource.id, resource]));

export function connectedResource(id: string): ConnectedResource | undefined {
  return BY_ID.get(id);
}

/** The ids a form on the settings page may write, and nothing else. */
export const RUNTIME_EDITABLE_IDS = CONNECTED_RESOURCES.filter((resource) => resource.changedBy === 'app-runtime').map(
  (resource) => resource.id
);

/**
 * The ids the settings pane may record an intended value for.
 */
export const STAGEABLE_IDS = CONNECTED_RESOURCES.filter((resource) => resource.stageable).map(
  (resource) => resource.id
);

/** Whether a value saved for this id would take effect, or only be recorded. */
export function appliesImmediately(id: string): boolean {
  const resource = BY_ID.get(id);
  return resource ? CHANGED_BY[resource.changedBy].appliesImmediately : false;
}
