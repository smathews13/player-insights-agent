
import {
  APP_SCHEMA
} from "./chunk-7DTM6FIL.mjs";

// server/lib/experiment-probe.ts
var EXPERIMENT_PATH = "/api/2.0/mlflow/experiments/get";
var EXPERIMENT_BY_NAME_PATH = "/api/2.0/mlflow/experiments/get-by-name";
function textOf(value) {
  return typeof value === "string" ? value.trim() : "";
}
function experimentOf(body) {
  return body.experiment ?? body;
}
function experimentIdOf(body) {
  return textOf(experimentOf(body).experiment_id);
}
function describes(body) {
  const experiment = experimentOf(body);
  const name = textOf(experiment.name);
  const stage = textOf(experiment.lifecycle_stage);
  if (name && stage) return `${name}, ${stage}`;
  return name || stage;
}
var ACTIVE_STAGE = "active";
function experimentVerdict(input) {
  const experimentId = input.experimentId.trim();
  if (!experimentId) return null;
  const base = {
    id: "experiment-id",
    kind: "observability",
    name: experimentId,
    label: "MLflow experiment",
    checked_with: `Read as the application, not as you: GET ${EXPERIMENT_PATH}`,
    duration_ms: input.durationMs ?? 0,
    error: "",
    remedy: null
  };
  if (input.read.kind === "no-response") {
    return {
      ...base,
      status: "unverified",
      detail: "The workspace could not be asked about the experiment, so nothing was established either way.",
      error: input.read.message
    };
  }
  if (input.read.kind === "refused") {
    const { status, code, message } = input.read;
    const refusal = `HTTP ${status}${code ? ` ${code}` : ""}`;
    return {
      ...base,
      // FAILED RATHER THAN UNVERIFIED, and the difference is the identity. A
      // refusal of the reader's token leaves open whether the object is fine and
      // the person is short a grant; this call was made as the application that
      // writes the traces, so a refusal or a missing experiment means the trace
      // has nowhere to land -- a fact about the deployment, not about anybody's
      // permissions.
      status: "failed",
      detail: `${refusal}: ${message || "the workspace gave no message"}. Read as the application, not as you.`,
      error: message || refusal
    };
  }
  const observed = describes(input.read.body);
  const displayName = textOf(experimentOf(input.read.body).name);
  const stage = textOf(experimentOf(input.read.body).lifecycle_stage);
  if (stage && stage.toLowerCase() !== ACTIVE_STAGE) {
    return {
      ...base,
      display_name: displayName || void 0,
      // FAILED, on the same reasoning as a refusal: the identity that was
      // answered is the one that writes the traces, and it cannot write to
      // this. Reported as a fact about the deployment rather than about
      // anybody's permissions, because restoring the experiment is the fix and
      // no grant changes it.
      status: "failed",
      detail: `Read as the application, not as you${observed ? `: ${observed}` : ""}. The experiment exists but is ${stage}, not ${ACTIVE_STAGE}, so runs cannot be logged to it and the trace of every run is being dropped. Restore it in the workspace, or point PLAYER_INSIGHTS_EXPERIMENT_ID at one that is live.`,
      error: `the experiment is ${stage}`
    };
  }
  return {
    ...base,
    display_name: displayName || void 0,
    status: "ok",
    detail: `Read as the application, not as you${observed ? `: ${observed}` : ""}. Traces have somewhere to land; whether you can open it is your own grant.`
  };
}
var workspaceExperimentReader = async (experimentId) => {
  try {
    const { WorkspaceClient } = await import("./vendor-databricks-sdk-experimental.mjs");
    const client = new WorkspaceClient({});
    const body = await client.apiClient.request({
      path: EXPERIMENT_PATH,
      method: "GET",
      query: { experiment_id: experimentId },
      headers: new Headers({ Accept: "application/json" }),
      raw: false
    });
    return { kind: "ok", body: body ?? {} };
  } catch (error) {
    return readFailure(error);
  }
};
var workspaceExperimentIdResolver = async (experimentPath) => {
  const path = experimentPath.trim();
  if (!path) return "";
  try {
    const { WorkspaceClient } = await import("./vendor-databricks-sdk-experimental.mjs");
    const client = new WorkspaceClient({});
    const body = await client.apiClient.request({
      path: EXPERIMENT_BY_NAME_PATH,
      method: "GET",
      query: { experiment_name: path },
      headers: new Headers({ Accept: "application/json" }),
      raw: false
    });
    return experimentIdOf(body ?? {});
  } catch {
    return "";
  }
};
function readFailure(error) {
  const shape = error ?? {};
  const status = Number(shape.statusCode ?? shape.status ?? 0);
  const message = textOf(shape.message) || "the call did not complete";
  if (Number.isFinite(status) && status >= 400) {
    return { kind: "refused", status, code: textOf(shape.errorCode), message };
  }
  return { kind: "no-response", message };
}
async function checkExperimentAsApp(experimentId, read = workspaceExperimentReader) {
  const id = experimentId.trim();
  if (!id) return null;
  const started = Date.now();
  let outcome;
  try {
    outcome = await read(id);
  } catch (error) {
    outcome = readFailure(error);
  }
  return experimentVerdict({ experimentId: id, read: outcome, durationMs: Date.now() - started });
}

// shared/deployment-config.ts
var CHANGED_BY = {
  "model-version": {
    label: "New model version",
    note: "Baked into the MLflow model artifact when the agent was logged. No form can change it: the same values name the resources automatic authentication passthrough grants this version, so a runtime override could aim the orchestrator at a warehouse it has no permission to use.",
    appliesImmediately: false
  },
  "app-redeploy": {
    label: "App redeploy",
    note: "Arrives as an environment variable in the app container, written into the deployed app.yaml at release time. Set it in the bundle target and release the app.",
    appliesImmediately: false
  },
  "app-runtime": {
    label: "Editable here",
    note: "The app reads this on every request, so a value saved here takes effect immediately.",
    appliesImmediately: true
  },
  "app-source": {
    label: "Edit app source",
    note: "A literal in application source with no variable that overrides it. Changing it means editing the source and redeploying.",
    appliesImmediately: false
  },
  "agent-environment": {
    label: "Not reachable in serving",
    note: "Read from the orchestrator process environment, which a served entity does not inherit from anything a deployer controls. Inside the endpoint it is always the compiled default.",
    appliesImmediately: false
  }
};
var AGENT_RELEASE = "TARGET=<target> bundle/agent-release.sh --apply";
var APP_RELEASE = "TARGET=<target> bundle/app-release.sh --apply";
var CONNECTED_RESOURCES = [
  {
    id: "agent-endpoint",
    label: "Orchestrator serving endpoint",
    kind: "agent",
    changedBy: "app-redeploy",
    arrivesBy: "The app resource named `serving-endpoint`, read into DATABRICKS_SERVING_ENDPOINT_NAME by app.yaml. The endpoint itself is created by databricks.agents.deploy(), not by the bundle.",
    bundleVariable: "serving_endpoint_name",
    agentKey: null,
    appEnvVar: "DATABRICKS_SERVING_ENDPOINT_NAME",
    actualFromCheck: "agent-endpoint",
    namesRemoteObject: true,
    applyWith: `${APP_RELEASE}   # after changing the app resource in databricks.yml`,
    stageable: false
  },
  {
    id: "llm-endpoint",
    label: "Foundation model",
    kind: "model",
    changedBy: "model-version",
    arrivesBy: "MLflow model_config, baked by agent/log_model.py at log time, or PLAYER_INSIGHTS_LLM_ENDPOINT when the app release wrote the same bundle variable into the container.",
    bundleVariable: "llm_endpoint",
    agentKey: "llm_endpoint",
    appEnvVar: "PLAYER_INSIGHTS_LLM_ENDPOINT",
    actualFromCheck: "llm-endpoint",
    namesRemoteObject: true,
    applyWith: AGENT_RELEASE,
    stageable: true
  },
  {
    id: "llm-gateway",
    label: "AI Gateway",
    kind: "model",
    changedBy: "model-version",
    arrivesBy: "MLflow model_config, baked by agent/log_model.py at log time.",
    bundleVariable: "llm_gateway",
    agentKey: "llm_gateway",
    appEnvVar: null,
    // No check probes this. Preflight makes a real one-token call over whichever
    // route is bound, so a gateway that refuses this deployment fails the
    // release rather than the first stakeholder's question, which is a better
    // answer than a green tick here would be.
    actualFromCheck: null,
    namesRemoteObject: true,
    applyWith: AGENT_RELEASE,
    stageable: true
  },
  {
    id: "genie-data",
    label: "Data Genie space",
    kind: "genie-space",
    changedBy: "model-version",
    arrivesBy: "MLflow model_config, and a DatabricksGenieSpace resource on the same model version.",
    bundleVariable: "genie_data_space_id, naming a space the bundle attaches to rather than creates",
    agentKey: "data_genie_space_id",
    appEnvVar: null,
    actualFromCheck: "genie-data",
    namesRemoteObject: true,
    applyWith: AGENT_RELEASE,
    stageable: true
  },
  {
    id: "genie-dictionary",
    label: "Dictionary Genie space",
    kind: "genie-space",
    changedBy: "model-version",
    arrivesBy: "MLflow model_config, and a DatabricksGenieSpace resource on the same model version.",
    bundleVariable: "genie_dictionary_space_id, naming a space the bundle attaches to rather than creates",
    agentKey: "dictionary_genie_space_id",
    appEnvVar: null,
    actualFromCheck: "genie-dictionary",
    namesRemoteObject: true,
    applyWith: AGENT_RELEASE,
    stageable: true
  },
  {
    id: "sql-warehouse",
    label: "SQL warehouse",
    kind: "sql-warehouse",
    changedBy: "model-version",
    arrivesBy: "MLflow model_config, and a DatabricksSQLWarehouse resource on the same model version.",
    bundleVariable: "warehouse_id",
    agentKey: "warehouse_id",
    appEnvVar: null,
    actualFromCheck: "sql-warehouse",
    namesRemoteObject: true,
    applyWith: AGENT_RELEASE,
    stageable: true
  },
  {
    id: "catalog",
    label: "App catalog",
    kind: "unity-catalog",
    changedBy: "model-version",
    arrivesBy: "MLflow model_config, baked by agent/log_model.py at log time.",
    bundleVariable: "app_catalog",
    agentKey: "catalog",
    appEnvVar: null,
    actualFromCheck: null,
    namesRemoteObject: true,
    applyWith: AGENT_RELEASE,
    stageable: true
  },
  {
    id: "schema",
    label: "App schema",
    kind: "unity-catalog",
    changedBy: "model-version",
    arrivesBy: "MLflow model_config, baked by agent/log_model.py at log time.",
    bundleVariable: "app_schema",
    agentKey: "schema",
    appEnvVar: null,
    actualFromCheck: null,
    namesRemoteObject: true,
    applyWith: AGENT_RELEASE,
    stageable: true
  },
  {
    id: "catalog-allowlist",
    label: "Data catalogs",
    kind: "unity-catalog",
    changedBy: "model-version",
    arrivesBy: "MLflow model_config; the table list it produces is baked alongside it.",
    bundleVariable: "data_catalogs",
    agentKey: "catalog_allowlist",
    appEnvVar: null,
    actualFromCheck: null,
    namesRemoteObject: false,
    applyWith: AGENT_RELEASE,
    stageable: true
  },
  {
    id: "catalog-denylist",
    label: "Excluded tables",
    kind: "unity-catalog",
    changedBy: "model-version",
    arrivesBy: "MLflow model_config, baked by agent/log_model.py at log time.",
    bundleVariable: "catalog_denylist",
    agentKey: "catalog_denylist",
    appEnvVar: null,
    actualFromCheck: null,
    namesRemoteObject: false,
    applyWith: AGENT_RELEASE,
    stageable: true
  },
  {
    id: "declared-manifest",
    label: "Declared tables",
    kind: "unity-catalog",
    changedBy: "model-version",
    arrivesBy: "Generated by agent/preflight.py during the log, then baked into the artifact.",
    bundleVariable: null,
    agentKey: "declared_manifest",
    appEnvVar: null,
    // The rollup `withManifestRollup` derives from the individual table checks.
    // Named here rather than left null so a version that reported no manifest
    // reads `Not checked` -- unknown -- rather than as a row with nothing behind
    // it. There IS something behind it; twelve checks stand for it.
    actualFromCheck: "declared-manifest",
    namesRemoteObject: true,
    applyWith: AGENT_RELEASE,
    stageable: false
  },
  {
    id: "max-output-tokens",
    label: "Answer length limit",
    kind: "model",
    changedBy: "model-version",
    arrivesBy: "MLflow model_config, baked by agent/log_model.py at log time.",
    bundleVariable: "max_output_tokens",
    agentKey: "max_output_tokens",
    appEnvVar: null,
    actualFromCheck: null,
    namesRemoteObject: false,
    applyWith: AGENT_RELEASE,
    stageable: true
  },
  {
    id: "lakebase",
    label: "Lakebase (Postgres)",
    kind: "lakebase",
    changedBy: "app-redeploy",
    arrivesBy: "The app resource named `postgres`, read into LAKEBASE_ENDPOINT by app.yaml.",
    bundleVariable: "lakebase_project_id / lakebase_branch_id / lakebase_database_id",
    agentKey: null,
    appEnvVar: "LAKEBASE_ENDPOINT",
    actualFromCheck: "lakebase-storage",
    namesRemoteObject: true,
    applyWith: `${APP_RELEASE}   # after changing the app resource in databricks.yml`,
    stageable: false
  },
  {
    id: "lakebase-schema",
    label: "Lakebase schema",
    kind: "lakebase",
    changedBy: "app-redeploy",
    arrivesBy: "PLAYER_INSIGHTS_APP_SCHEMA, resolved from var.lakebase_app_schema at release time (a source-only Git deploy maps the legacy authored player_insights value to the app-owned astrolabe schema). Created by the app on boot; bundle targets keep their configured schema.",
    bundleVariable: "lakebase_app_schema",
    agentKey: null,
    appEnvVar: "PLAYER_INSIGHTS_APP_SCHEMA",
    actualFromCheck: null,
    namesRemoteObject: false,
    applyWith: "Set var.lakebase_app_schema and release the app so PLAYER_INSIGHTS_APP_SCHEMA updates.\nThen grant on the new schema (scripts/grant-app-db-access.mjs) and migrate any data.\nChanging the variable alone does not move existing tables.",
    stageable: false
  },
  {
    id: "assets-volume",
    label: "Assets volume",
    kind: "volume",
    changedBy: "app-redeploy",
    arrivesBy: "Created empty by the bundle. Nothing in a deploy writes to it.",
    bundleVariable: "volume",
    agentKey: null,
    appEnvVar: null,
    actualFromCheck: null,
    namesRemoteObject: false,
    applyWith: "Set var.volume and redeploy the bundle.",
    stageable: false
  },
  {
    id: "semantic-index",
    label: "Vector Search index",
    kind: "vector-search",
    changedBy: "model-version",
    arrivesBy: "PLAYER_INSIGHTS_SEMANTIC_INDEX, read from the environment when the model is logged and baked into the artifact. `true` derives the name from the catalog and schema, a three-level name adopts an index built elsewhere, and unset means this release has no semantic layer at all — which is a supported deployment, not a fault.",
    // There is no bundle variable for the flag itself. The bundle declares the
    // index and its endpoint; whether a model version SEARCHES one is decided by
    // the environment the release script logs it from.
    bundleVariable: null,
    agentKey: "semantic_index",
    appEnvVar: "PLAYER_INSIGHTS_SEMANTIC_INDEX",
    actualFromCheck: null,
    namesRemoteObject: true,
    applyWith: "Set PLAYER_INSIGHTS_SEMANTIC_INDEX and re-log the model. The app cannot change it.",
    stageable: false
  },
  {
    id: "semantic-index-endpoint",
    label: "Vector Search endpoint",
    kind: "vector-search",
    changedBy: "app-redeploy",
    arrivesBy: "Created by the bundle from var.semantic_index_endpoint. Nothing passes its name to the app or to the orchestrator, so it is read back from the index, which reports the endpoint serving it.",
    bundleVariable: "semantic_index_endpoint",
    agentKey: null,
    appEnvVar: "PLAYER_INSIGHTS_SEMANTIC_ENDPOINT",
    // The app's own probe, keyed by this id. Named here rather than left null so
    // an unprobed row reads `Not checked` -- `nothing-to-reach` is for a value
    // the app both resolves and applies, and this one has a real remote end.
    actualFromCheck: "semantic-index-endpoint",
    namesRemoteObject: true,
    applyWith: "Set var.semantic_index_endpoint and redeploy the bundle.",
    stageable: false
  },
  {
    id: "experiment-id",
    label: "MLflow experiment",
    kind: "observability",
    changedBy: "app-runtime",
    arrivesBy: 'PLAYER_INSIGHTS_EXPERIMENT_ID, resolved from var.experiment_path at release time, or PLAYER_INSIGHTS_EXPERIMENT_PATH resolved to an id at runtime when the id is empty (a "From Git" deploy, which never runs the release). The app reads a saved override first, so a deployment whose experiment did not exist at release can fix the link without a redeploy.',
    bundleVariable: "experiment_path",
    agentKey: null,
    appEnvVar: "PLAYER_INSIGHTS_EXPERIMENT_ID",
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
    actualFromCheck: "experiment-id",
    // Still false: the check reports whether the experiment exists, and the value
    // the app shows is the id it was configured with. There is no second reading
    // of the id itself to compare the first with, so this must not invite one.
    namesRemoteObject: false,
    applyWith: "Save it here, or set var.experiment_path and release the app.",
    stageable: false
  },
  {
    id: "judge-endpoint",
    label: "Benchmark judge model",
    kind: "model",
    changedBy: "app-runtime",
    arrivesBy: "PLAYER_INSIGHTS_JUDGE_ENDPOINT, read per benchmark run. The app reads a saved override first, then the variable, then a compiled default.",
    bundleVariable: "judge_endpoint",
    agentKey: null,
    appEnvVar: "PLAYER_INSIGHTS_JUDGE_ENDPOINT",
    actualFromCheck: null,
    namesRemoteObject: true,
    applyWith: "Save it here, or set var.judge_endpoint and release the app.",
    stageable: false
  },
  {
    id: "notebook-declaration",
    // NOT "Notebook", which is what this row said for as long as it has existed
    // and which is wrong in the one way that matters: a reader who is asked for
    // a notebook reasonably tries to give it one. The value is a TABLE. A
    // notebook writes a row into it saying what that notebook was configured
    // with, and this app reads the newest row. Pointing this at a notebook path
    // cannot work, and the reason is not a missing feature: what the app needs
    // is the values the notebook RAN with, and a notebook file holds variable
    // names rather than the values they resolved to. Only a run knows those,
    // and a run is what publishes the row.
    label: "Notebook declarations table",
    kind: "unity-catalog",
    // The one connection on this page whose value genuinely takes effect at once,
    // and it is worth being clear about what "takes effect" means for it: the app
    // reads the declaration this names on every settings read. It changes what this
    // page COMPARES AGAINST. It does not change what the orchestrator may read,
    // because that list is baked into the model artifact -- see
    // shared/notebook-declaration.ts, which classifies every publishable key and
    // refuses the one that grants tables.
    changedBy: "app-runtime",
    arrivesBy: "The three-part Unity Catalog name of the table a notebook publishes to, not the notebook itself. A notebook run appends one row saying what it was configured with, and the app reads the newest row as the signed-in user on each settings read, so a value saved here is used on the next one. Which notebook published it is in the row, so this page can name the notebook without being told it. PLAYER_INSIGHTS_NOTEBOOK_DECLARATION supplies the initial value.",
    bundleVariable: null,
    agentKey: null,
    appEnvVar: "PLAYER_INSIGHTS_NOTEBOOK_DECLARATION",
    // Probed by the read itself rather than by a dependency check: the useful
    // verdict is whether THIS reader could fetch the declaration under their own
    // grants, which is what the read establishes and a check on the table's
    // existence would not.
    actualFromCheck: "notebook-declaration",
    namesRemoteObject: true,
    applyWith: "Save it here, or set PLAYER_INSIGHTS_NOTEBOOK_DECLARATION before releasing the app.",
    // Not stageable, and the reason is the tier rather than an omission: staging is
    // for a value only a new model version can apply, and this one applies now.
    stageable: false
  },
  {
    id: "shared-conversation-rail",
    label: "Shared conversation rail",
    kind: "app-behaviour",
    changedBy: "app-redeploy",
    arrivesBy: "PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL, resolved from the bundle at release time.",
    bundleVariable: "shared_conversation_rail",
    agentKey: null,
    appEnvVar: "PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL",
    actualFromCheck: null,
    // Deliberately NOT app-runtime even though the value is a boolean the app
    // could read per request. Widening it exposes one person's conversations to
    // another, and a control that dangerous should require a release someone
    // reviewed, not a switch on a settings page.
    namesRemoteObject: false,
    applyWith: `${APP_RELEASE}   # after setting var.shared_conversation_rail`,
    stageable: false
  }
];
var BY_ID = new Map(CONNECTED_RESOURCES.map((resource) => [resource.id, resource]));
function connectedResource(id) {
  return BY_ID.get(id);
}
var RUNTIME_EDITABLE_IDS = CONNECTED_RESOURCES.filter(
  (resource) => resource.changedBy === "app-runtime"
).map((resource) => resource.id);
var STAGEABLE_IDS = CONNECTED_RESOURCES.filter((resource) => resource.stageable).map(
  (resource) => resource.id
);

// shared/benchmark-contract.ts
var MLFLOW_JUDGE_PROMPT_VERSION = "mlflow-3.14.0";
var DEFAULT_JUDGE_ENDPOINT = "databricks-claude-sonnet-4-5";
function judgeBadgeLabel(judgeEndpoint) {
  return `LLM judge · MLflow prompt · ${judgeEndpoint}`;
}
function judgeDisclosure(judgeEndpoint) {
  return `Scored by MLflow ${MLFLOW_JUDGE_PROMPT_VERSION.replace("mlflow-", "")}'s published judge prompts, run against the ${judgeEndpoint} serving endpoint through the same transport the app uses to call the agent. This is not the Databricks managed judge service: the prompts and the yes/no parsing are MLflow's, the model answering them is ${judgeEndpoint}.`;
}
var GROUNDEDNESS_BASIS = "The groundedness document is what the agent's own trace disclosed for that answer: its stage output, the SQL it ran, and the figures and sources it returned. A `no` therefore means the answer asserted something the app cannot substantiate from what it showed the user, which is not the same as contradicting the underlying data.";
function judgeProvenance(judgeName, judgeEndpoint) {
  return `MLflow ${MLFLOW_JUDGE_PROMPT_VERSION.replace("mlflow-", "")} ${judgeName} prompt, run against databricks:/${judgeEndpoint}`;
}
var BUDGET_TRUNCATION_CODE = "SUITE_BUDGET_EXHAUSTED";
var SUITE_CANCELLED_CODE = "SUITE_CANCELLED";
var BENCHMARK_RUNNER_VERSION = "benchmark-runner-2";

// shared/build-stamps.ts
var DIRTY_SUFFIX = "+dirty";
var MIN_ABBREV = 7;
function commitOf(sha) {
  const trimmed = sha.trim();
  return trimmed.endsWith(DIRTY_SUFFIX) ? trimmed.slice(0, -DIRTY_SUFFIX.length) : trimmed;
}
function parseAncestorList(raw) {
  if (!raw?.trim()) return [];
  return raw.trim().split(/[\s,]+/).map((entry) => commitOf(entry)).filter((entry) => entry.length >= MIN_ABBREV);
}

// server/lib/expiring-lru.ts
var ExpiringLruCache = class {
  constructor(maxEntries, ttlMs) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error("ttlMs must be a non-negative finite number");
  }
  entries = /* @__PURE__ */ new Map();
  get(key, now = Date.now()) {
    this.prune(now);
    const entry = this.entries.get(key);
    if (!entry) return void 0;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value, now = Date.now(), ttlMs = this.ttlMs) {
    this.prune(now);
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: now + Math.max(0, ttlMs), value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === void 0) break;
      this.entries.delete(oldest);
    }
  }
  delete(key) {
    return this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
  }
  get size() {
    return this.entries.size;
  }
  prune(now) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
};

// server/lib/app-settings.ts
var DEPLOYMENT_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.deployment_settings (resource_id TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     intent TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_by TEXT NOT NULL
   )`;
var STORED_SETTINGS_QUERY = `
  SELECT resource_id, value, intent, note, updated_at, updated_by
  FROM ${APP_SCHEMA}.deployment_settings
  ORDER BY resource_id`;
var UPSERT_SETTING_QUERY = `
  INSERT INTO ${APP_SCHEMA}.deployment_settings (resource_id, value, intent, note, updated_by, updated_at)
  VALUES ($1, $2, $3, $4, $5, now())
  ON CONFLICT (resource_id) DO UPDATE
    SET value = EXCLUDED.value,
        intent = EXCLUDED.intent,
        note = EXCLUDED.note,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
  RETURNING resource_id, value, intent, note, updated_at, updated_by`;
var DELETE_SETTING_QUERY = `
  DELETE FROM ${APP_SCHEMA}.deployment_settings WHERE resource_id = $1 RETURNING resource_id`;
function text(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}
function storedFromRow(row) {
  const updatedAt = row.updated_at;
  return {
    resourceId: text(row.resource_id) ?? "",
    value: text(row.value) ?? "",
    intent: row.intent === "active" ? "active" : "intended",
    note: text(row.note) ?? "",
    updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : text(updatedAt) ?? "",
    updatedBy: text(row.updated_by) ?? ""
  };
}
var STORED_SETTINGS_TTL_MS = 45e3;
var settingsCache = /* @__PURE__ */ new WeakMap();
function forgetStoredSettings() {
  settingsCache = /* @__PURE__ */ new WeakMap();
}
async function readStoredSettings(client, options = {}) {
  const maxAge = options.maxAgeMs ?? 0;
  const now = options.now ?? Date.now();
  const cached = settingsCache.get(client);
  if (cached && maxAge > 0 && now - cached.at < maxAge) return cached.settings;
  try {
    const result = await client.lakebase.query(STORED_SETTINGS_QUERY);
    const rows = result?.rows ?? [];
    const settings = new Map(
      rows.map((row) => {
        const setting = storedFromRow(row);
        return [setting.resourceId, setting];
      })
    );
    settingsCache.set(client, { at: now, settings });
    return settings;
  } catch (error) {
    console.warn("[settings] Stored settings could not be read:", error.message);
    return /* @__PURE__ */ new Map();
  }
}
async function writeStoredSetting(client, setting) {
  const result = await client.lakebase.query(UPSERT_SETTING_QUERY, [
    setting.resourceId,
    setting.value,
    setting.intent,
    setting.note,
    setting.updatedBy
  ]);
  const row = (result?.rows ?? [])[0];
  if (!row) throw new Error("the settings row was not written back");
  forgetStoredSettings();
  return storedFromRow(row);
}
async function clearStoredSetting(client, resourceId) {
  const result = await client.lakebase.query(DELETE_SETTING_QUERY, [resourceId]);
  forgetStoredSettings();
  return (result?.rows ?? []).length > 0;
}
async function resolveJudgeEndpoint(client) {
  const stored = await readStoredSettings(client, { maxAgeMs: STORED_SETTINGS_TTL_MS });
  const saved = stored.get("judge-endpoint");
  if (saved?.intent === "active" && saved.value) return saved.value;
  return process.env.PLAYER_INSIGHTS_JUDGE_ENDPOINT?.trim() || DEFAULT_JUDGE_ENDPOINT;
}
var EXPERIMENT_ID_CACHE_MAX_ENTRIES = 128;
var EXPERIMENT_ID_CACHE_TTL_MS = 60 * 6e4;
var experimentIdByPath = new ExpiringLruCache(EXPERIMENT_ID_CACHE_MAX_ENTRIES, EXPERIMENT_ID_CACHE_TTL_MS);
function forgetResolvedExperimentIds() {
  experimentIdByPath.clear();
}
async function resolveExperimentId(client, resolvePath = workspaceExperimentIdResolver, now = Date.now()) {
  const stored = await readStoredSettings(client, { maxAgeMs: STORED_SETTINGS_TTL_MS });
  const saved = stored.get("experiment-id");
  if (saved?.intent === "active" && saved.value) return saved.value;
  const fromEnv = process.env.PLAYER_INSIGHTS_EXPERIMENT_ID?.trim();
  if (fromEnv) return fromEnv;
  const path = process.env.PLAYER_INSIGHTS_EXPERIMENT_PATH?.trim();
  if (!path) return "";
  const cached = experimentIdByPath.get(path, now);
  if (cached) return cached;
  const resolved = (await resolvePath(path)).trim();
  if (resolved) experimentIdByPath.set(path, resolved, now);
  return resolved;
}
async function resolveNotebookDeclaration(client) {
  const stored = await readStoredSettings(client, { maxAgeMs: STORED_SETTINGS_TTL_MS });
  const saved = stored.get("notebook-declaration");
  if (saved?.intent === "active" && saved.value) return saved.value;
  return process.env.PLAYER_INSIGHTS_NOTEBOOK_DECLARATION?.trim() ?? "";
}
function appBuildSha() {
  return process.env.PLAYER_INSIGHTS_BUILD_SHA?.trim() ?? "";
}
function appBuildAncestors() {
  return parseAncestorList(process.env.PLAYER_INSIGHTS_BUILD_ANCESTORS);
}
function appEnvironment() {
  const values = {};
  for (const resource of CONNECTED_RESOURCES) {
    if (!resource.appEnvVar) continue;
    values[resource.appEnvVar] = process.env[resource.appEnvVar]?.trim() ?? "";
  }
  return values;
}
var APP_DEFAULTS = {
  "judge-endpoint": DEFAULT_JUDGE_ENDPOINT,
  "shared-conversation-rail": "false",
  // The process-resolved value, not the legacy string authored into app.yaml.
  // A direct Git deployment maps that old value to its app-owned schema.
  "lakebase-schema": APP_SCHEMA
};
function namespaceInUse(checks) {
  const prefixes = /* @__PURE__ */ new Set();
  for (const check of checks) {
    if (check.kind !== "table" || !check.name) continue;
    const parts = check.name.split(".");
    if (parts.length === 3) prefixes.add(`${parts[0]}.${parts[1]}`);
  }
  if (prefixes.size !== 1) return null;
  const [catalog, schema] = [...prefixes][0].split(".");
  return { catalog, schema };
}
function displayValue(value) {
  if (Array.isArray(value)) {
    const entries = [];
    for (const item of value) {
      const entry = text(item);
      if (entry === null) return "";
      entries.push(entry);
    }
    return entries.join(", ");
  }
  return text(value) ?? "";
}
function resourceStates(input) {
  const { report, environment, stored } = input;
  const byCheck = new Map((report?.checks ?? []).map((check) => [check.id, check]));
  const configuration = new Map((report?.configuration ?? []).map((entry) => [String(entry.key), entry]));
  const namespace = namespaceInUse(report?.checks ?? []);
  return CONNECTED_RESOURCES.map((resource) => {
    const entry = resource.agentKey ? configuration.get(resource.agentKey) : void 0;
    const check = resource.actualFromCheck ? byCheck.get(resource.actualFromCheck) : void 0;
    const saved = stored.get(resource.id);
    let configured = "";
    let configuredFrom = "";
    if (entry) {
      configured = displayValue(entry.value);
      configuredFrom = text(entry.source) ?? "";
    } else if (resource.appEnvVar) {
      configured = environment[resource.appEnvVar] ?? "";
      configuredFrom = "app-environment";
      if (resource.id === "lakebase-schema") {
        configured = APP_SCHEMA;
      }
      if (!configured && resource.id in APP_DEFAULTS) {
        configured = APP_DEFAULTS[resource.id];
        configuredFrom = "app-default";
      }
      if (saved?.intent === "active" && saved.value) {
        configured = saved.value;
        configuredFrom = "app-saved";
      }
    }
    let actual = check?.name ?? "";
    let actualObserved = Boolean(check && check.name);
    if (!actualObserved && namespace) {
      if (resource.id === "catalog") {
        actual = namespace.catalog;
        actualObserved = true;
      } else if (resource.id === "schema") {
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
      intended: saved && saved.intent === "intended" ? saved.value : null,
      intendedAt: saved?.updatedAt ?? "",
      intendedBy: saved?.updatedBy ?? "",
      editable: CHANGED_BY[resource.changedBy].appliesImmediately
    };
  });
}
var ARTIFACT = "artifact";
var TRUSTED_PROVENANCE = /* @__PURE__ */ new Set([ARTIFACT, "app-environment", "data-contract"]);
function computeDrift(input) {
  const { report, states, endpointAnswered } = input;
  const findings = [];
  if (!report) {
    if (endpointAnswered !== true) {
      findings.push({
        id: "orchestrator-unreachable",
        severity: "unknown",
        resourceId: "agent-endpoint",
        // Plainer for the same reason as the constant above, and deliberately NOT
        // reassuring in the way that one is: this branch means the agent did not
        // answer, which is a fault, and the two must not read alike at a glance.
        headline: "The agent did not answer, so nothing below could be checked",
        detail: "The serving endpoint did not reply, so the values below are only what this deployment was set up with. None of them have been checked against anything, and an answer asked right now would probably fail too.",
        // Under "What to fix" on the same page since Sources & Capabilities was
        // merged into Connections. Sending a reader to another page for it would
        // now be sending them in a circle.
        remedy: "Fix the blocked checks under “What to fix” above, then re-check."
      });
    }
    return findings;
  }
  if (report.source === "agent" && (!report.configuration || report.configuration.length === 0)) {
    findings.push({
      id: "configuration-unreported",
      severity: "unknown",
      resourceId: null,
      headline: "The served model version does not report its own configuration",
      detail: "This endpoint answered, but the model version running on it was logged before the configuration report existed. What the orchestrator was configured with cannot be read from it, only what the checks below proved it could reach. The two are not the same claim.",
      remedy: "Log and roll out a model version from a build that carries the report."
    });
  }
  for (const state of states) {
    if (!state.resource.agentKey || !state.configuredFrom) continue;
    if (TRUSTED_PROVENANCE.has(state.configuredFrom)) continue;
    if (!state.configured) continue;
    findings.push({
      id: `provenance-${state.resource.id}`,
      severity: "blocking",
      resourceId: state.resource.id,
      headline: `${state.resource.label} did not come from the model artifact`,
      detail: `The orchestrator resolved this from ${state.configuredFrom}, not from the model version it is serving. Nothing in the registry records where that value came from, and the resources automatic authentication passthrough granted this version were named from the artifact, so what it is pointed at and what it is permitted to reach can differ.`,
      remedy: state.resource.applyWith
    });
  }
  for (const state of states) {
    if (!state.actualObserved || !state.configured) continue;
    if (state.actual === state.configured) continue;
    findings.push({
      id: `mismatch-${state.resource.id}`,
      severity: "blocking",
      resourceId: state.resource.id,
      headline: `${state.resource.label} in use is not the one configured`,
      detail: `Configured as ${state.configured}, but the check that ran inside the endpoint used ${state.actual}. The running system is not doing what this deployment's configuration says.`,
      remedy: state.resource.applyWith
    });
  }
  for (const state of states) {
    if (!state.intended) continue;
    const inForce = state.actualObserved ? state.actual : state.configured;
    if (state.intended === inForce) continue;
    findings.push({
      id: `pending-${state.resource.id}`,
      severity: "pending",
      resourceId: state.resource.id,
      headline: `${state.resource.label} has an intended value that is not in effect`,
      detail: `Saved as ${state.intended}${state.intendedBy ? ` by ${state.intendedBy}` : ""}, while the deployment is using ${inForce || "(nothing)"}. Saving it here recorded the intention; it changed nothing about the running system.`,
      remedy: state.resource.applyWith
    });
  }
  return findings;
}
function driftStatus(findings) {
  if (findings.some((finding) => finding.severity === "blocking")) return "blocked";
  if (findings.some((finding) => finding.severity === "unknown")) return "unknown";
  if (findings.some((finding) => finding.severity === "pending")) return "pending";
  return "ok";
}
function settingsPayload(input) {
  const states = resourceStates(input);
  const drift = computeDrift({
    report: input.report,
    states,
    endpointAnswered: input.endpointAnswered
  });
  return {
    resources: states.map((state) => ({
      ...state,
      changedByLabel: CHANGED_BY[state.resource.changedBy].label,
      changedByNote: CHANGED_BY[state.resource.changedBy].note
    })),
    drift,
    status: driftStatus(drift),
    appBuildSha: input.appBuildSha,
    appBuildAncestors: [...input.appBuildAncestors ?? []],
    modelBuildSha: input.report?.build_sha ?? "",
    orchestratorReported: Boolean(input.report?.configuration?.length),
    storeAvailable: input.storeAvailable,
    checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
    app: input.app
  };
}
function classifyWrite(resourceId, requested) {
  const resource = connectedResource(resourceId);
  if (!resource) return { ok: false, reason: `${resourceId} is not a resource this deployment has.` };
  const tier = CHANGED_BY[resource.changedBy];
  if (requested === "active" && !tier.appliesImmediately) {
    return {
      ok: false,
      reason: `${resource.label} cannot be changed by saving a value: ${tier.note} Save it as an intended value instead, then apply it with: ${resource.applyWith}`
    };
  }
  if (requested === "intended") {
    return { ok: true, intent: "intended", changedBy: resource.changedBy };
  }
  return { ok: true, intent: requested, changedBy: resource.changedBy };
}

export {
  MLFLOW_JUDGE_PROMPT_VERSION,
  DEFAULT_JUDGE_ENDPOINT,
  judgeBadgeLabel,
  judgeDisclosure,
  GROUNDEDNESS_BASIS,
  judgeProvenance,
  BUDGET_TRUNCATION_CODE,
  SUITE_CANCELLED_CODE,
  BENCHMARK_RUNNER_VERSION,
  CONNECTED_RESOURCES,
  ExpiringLruCache,
  checkExperimentAsApp,
  DEPLOYMENT_SETTINGS_DDL,
  forgetStoredSettings,
  readStoredSettings,
  writeStoredSetting,
  clearStoredSetting,
  resolveJudgeEndpoint,
  forgetResolvedExperimentIds,
  resolveExperimentId,
  resolveNotebookDeclaration,
  appBuildSha,
  appBuildAncestors,
  appEnvironment,
  resourceStates,
  settingsPayload,
  classifyWrite
};
