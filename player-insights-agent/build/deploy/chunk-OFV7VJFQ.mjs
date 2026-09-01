
import {
  DECLARED_RESOURCE_TYPES,
  MAX_DECLARATION_BYTES,
  addFault,
  addedConnectionEffect,
  compareDeclaration,
  declarationFlow,
  forgetDeclaredConnection,
  parseDeclaration,
  readDeclaredConnections,
  removalImpact,
  restoreDeclaredConnection,
  writeDeclaredConnection
} from "./chunk-4JRNDRTQ.mjs";
import {
  probeConnections,
  validateNotebookPath
} from "./chunk-FDCMDFAJ.mjs";
import {
  resolveSemanticIndexValue
} from "./chunk-MTXPHPGN.mjs";
import {
  lakebaseStorageCheck,
  parseServedModel,
  readAppFacts,
  userEmail
} from "./chunk-XO3UIQDJ.mjs";
import {
  accessDependenciesFrom,
  executionToken,
  qualifyDataContractTables,
  sqlQueryTags
} from "./chunk-4IYCA3Q2.mjs";
import {
  CONNECTED_RESOURCES,
  appBuildAncestors,
  appBuildSha,
  appEnvironment,
  checkExperimentAsApp,
  classifyWrite,
  clearStoredSetting,
  readStoredSettings,
  resolveExperimentId,
  resolveNotebookDeclaration,
  resourceStates,
  settingsPayload,
  writeStoredSetting
} from "./chunk-YG4YL534.mjs";
import {
  databricksLink,
  normalizeWorkspaceHost
} from "./chunk-VHHJDNLO.mjs";
import {
  recordAdminAction,
  requireAdmin
} from "./chunk-XIJCYHNA.mjs";
import {
  BILLING_TAG,
  RETIRED_BILLING_TAG_KEY,
  billingTagPair
} from "./chunk-P3NCP4CN.mjs";
import {
  external_exports
} from "./chunk-5DRRUJAY.mjs";
import {
  APP_SCHEMA
} from "./chunk-7DTM6FIL.mjs";

// server/routes/settings-routes.ts
import { createHash, randomUUID } from "node:crypto";

// shared/apply-declaration.ts
var APPLY_ENV_VARS = {
  catalog: "PLAYER_INSIGHTS_CATALOG",
  schema: "PLAYER_INSIGHTS_SCHEMA",
  warehouse_id: "PLAYER_INSIGHTS_WAREHOUSE_ID",
  data_genie_space_id: "PLAYER_INSIGHTS_DATA_GENIE_ID",
  dictionary_genie_space_id: "PLAYER_INSIGHTS_DICTIONARY_GENIE_ID",
  llm_endpoint: "PLAYER_INSIGHTS_LLM_ENDPOINT",
  llm_gateway: "PLAYER_INSIGHTS_LLM_GATEWAY",
  catalog_allowlist: "PLAYER_INSIGHTS_CATALOG_ALLOWLIST",
  catalog_denylist: "PLAYER_INSIGHTS_CATALOG_DENYLIST",
  max_output_tokens: "PLAYER_INSIGHTS_MAX_OUTPUT_TOKENS"
};
var APPLYABLE_KEYS = new Set(Object.keys(APPLY_ENV_VARS));
var NOTEBOOK_REFUSED_KEYS = /* @__PURE__ */ new Set(["catalog_allowlist"]);
var LABELS = Object.fromEntries(
  CONNECTED_RESOURCES.filter((resource) => resource.agentKey).map((resource) => [
    resource.agentKey,
    resource.label
  ])
);
function text(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return "";
}
function intendedFromResources(resources) {
  const out = {};
  for (const entry of resources ?? []) {
    const key = entry.resource?.agentKey;
    if (entry.intended === null || entry.intended === void 0) continue;
    const intended = text(entry.intended);
    if (!key || !intended && key !== "llm_gateway" || !APPLYABLE_KEYS.has(key)) continue;
    out[key] = intended;
  }
  return out;
}
function settingsFromDeclaration(declaration) {
  const out = {};
  if (!declaration) return out;
  for (const setting of declaration.settings) {
    const key = text(setting.key);
    const value = text(setting.value);
    if (!key || !value) continue;
    if (NOTEBOOK_REFUSED_KEYS.has(key)) continue;
    if (!APPLYABLE_KEYS.has(key)) continue;
    if (declarationFlow(key) === "refused") continue;
    out[key] = value;
  }
  return out;
}
function resolveApplyPlan(input) {
  const intended = input.intended ?? {};
  const notebook = input.notebook ?? {};
  const knobs = [];
  const notes = [];
  for (const key of [...APPLYABLE_KEYS].sort()) {
    const envVar = APPLY_ENV_VARS[key];
    if (!envVar) continue;
    if (Object.prototype.hasOwnProperty.call(intended, key)) {
      knobs.push({
        key,
        label: LABELS[key] ?? key,
        value: intended[key],
        source: "intended",
        envVar
      });
      continue;
    }
    if (notebook[key]) {
      knobs.push({
        key,
        label: LABELS[key] ?? key,
        value: notebook[key],
        source: "notebook",
        envVar
      });
    }
  }
  if (knobs.some((knob) => knob.key === "catalog_allowlist" && knob.source === "intended")) {
    notes.push(
      "Readable scopes were staged by an administrator. If the new list is wider than the live model, the release needs an explicit widen approval."
    );
  }
  if (knobs.some((knob) => knob.source === "notebook") && !knobs.some((knob) => knob.source === "intended")) {
    notes.push(
      "Values come from the notebook declaration. Intended settings on Connections override the notebook when both name the same key."
    );
  }
  const gateway = knobs.find((knob) => knob.key === "llm_gateway" && knob.source === "intended");
  const gatewayModel = knobs.find((knob) => knob.key === "llm_endpoint");
  if (gateway) {
    notes.push(
      `AI Gateway release pair: ${gateway.value || "Direct"} with ${gatewayModel?.value || "(missing model)"}. The notebook helper revalidates it before claiming the release. Rollback is Direct plus the existing endpoint through the same confirmed release.`
    );
  }
  const target = text(input.target) || "<your-target>";
  return {
    knobs,
    notes,
    hasOverrides: knobs.length > 0,
    command: `TARGET=${target} bundle/apply-declaration.sh --apply --i-am-deploying`
  };
}

// server/lib/declared-tables.ts
var PAYLOAD_TABLE_SIGNATURE = /* @__PURE__ */ new Set([
  "databricks_request_id",
  "request",
  "response",
  "served_entity_id"
]);
var UNDECLARABLE_SCHEMAS = /* @__PURE__ */ new Set(["information_schema"]);
function isInferencePayloadTable(columns) {
  if (columns === null) return null;
  const names = new Set(columns);
  for (const column of PAYLOAD_TABLE_SIGNATURE) {
    if (!names.has(column)) return false;
  }
  return true;
}
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}
function denylistMatch(fullName, shortName, patterns) {
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    const match = globToRegExp(pattern);
    if (match.test(fullName) || match.test(shortName)) return pattern;
  }
  return null;
}
function exclusionReason(table, denylist = []) {
  if (UNDECLARABLE_SCHEMAS.has(table.schemaName)) {
    return `schema ${table.schemaName} is not declarable`;
  }
  const pattern = denylistMatch(table.fullName, table.shortName, denylist);
  if (pattern) return `catalog_denylist pattern ${pattern}`;
  if (isInferencePayloadTable(table.columns) === true) {
    return "inference payload table";
  }
  return null;
}
function listedTableFromBody(row) {
  if (!row || typeof row !== "object") return null;
  const record = row;
  const fullName = String(record.full_name ?? "").trim();
  const name = String(record.name ?? "").trim();
  const resolved = fullName || (name.includes(".") ? name : "");
  if (!resolved || resolved.split(".").length !== 3) return null;
  const parts = resolved.split(".");
  const columns = Array.isArray(record.columns) ? record.columns.map((column) => {
    if (!column || typeof column !== "object") return "";
    return String(column.name ?? "").trim();
  }).filter(Boolean) : null;
  return {
    fullName: resolved,
    schemaName: parts[1] ?? "",
    shortName: parts[2] ?? name,
    columns
  };
}
function tablesFromListing(rows, denylist = []) {
  const names = [];
  for (const table of rows) {
    if (exclusionReason(table, denylist)) continue;
    if (!names.includes(table.fullName)) names.push(table.fullName);
  }
  return names.sort();
}
function isDataContractFallback(tables, catalog, schema) {
  const contract = qualifyDataContractTables(catalog, schema);
  if (contract.length === 0) return false;
  if (tables.length !== contract.length) return false;
  const listed = [...tables].map((table) => table.trim()).filter(Boolean).sort();
  return listed.every((table, index) => table === contract[index]);
}
function unionTableNames(...lists) {
  return [...new Set(lists.flat().map((table) => table.trim()).filter(Boolean))].sort();
}
var TABLES_PATH = "/api/2.1/unity-catalog/tables";
async function listDeclarableTablesInSchema(input) {
  const catalog = input.catalog.trim();
  const schema = input.schema.trim();
  if (!catalog || !schema || !input.host || !input.token) return [];
  if (UNDECLARABLE_SCHEMAS.has(schema)) return [];
  const call = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 15e3;
  const found = [];
  let pageToken = "";
  for (let pages = 0; pages < 20; pages += 1) {
    const query = [
      `catalog_name=${encodeURIComponent(catalog)}`,
      `schema_name=${encodeURIComponent(schema)}`,
      "omit_columns=false",
      "max_results=100",
      pageToken ? `page_token=${encodeURIComponent(pageToken)}` : ""
    ].filter(Boolean).join("&");
    try {
      const response = await call(`${input.host}${TABLES_PATH}?${query}`, {
        method: "GET",
        headers: { authorization: `Bearer ${input.token}` },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) return tablesFromListing(found, input.denylist);
      const body = await response.json().catch(() => ({}));
      const rows = Array.isArray(body.tables) ? body.tables : [];
      for (const row of rows) {
        const table = listedTableFromBody(row);
        if (table) found.push(table);
      }
      pageToken = String(body.next_page_token ?? "").trim();
      if (!pageToken) break;
    } catch {
      return tablesFromListing(found, input.denylist);
    }
  }
  return tablesFromListing(found, input.denylist);
}

// server/lib/release-configuration.ts
var EXTRA_ENV = {
  declared_manifest: "PLAYER_INSIGHTS_DECLARED_MANIFEST",
  tables: "PLAYER_INSIGHTS_TABLES",
  data_genie_space_title: "PLAYER_INSIGHTS_DATA_GENIE_TITLE",
  dictionary_genie_space_title: "PLAYER_INSIGHTS_DICTIONARY_GENIE_TITLE",
  semantic_index: "PLAYER_INSIGHTS_SEMANTIC_INDEX",
  build_sha: "PLAYER_INSIGHTS_BUILD_SHA",
  manifest_source: "PLAYER_INSIGHTS_MANIFEST_SOURCE"
};
var LIST_KEYS = /* @__PURE__ */ new Set(["catalog_allowlist", "catalog_denylist", "declared_manifest", "tables"]);
function splitList(raw) {
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}
function text2(env, name) {
  return (env[name] ?? "").trim();
}
function entryValue(entry) {
  return entry?.value;
}
function asStringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return splitList(value);
  return [];
}
function asString(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
function isEmptyValue(value) {
  if (value === void 0 || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return String(value).trim() === "";
}
function configurationFromRelease(env = process.env) {
  const mapping = { ...APPLY_ENV_VARS, ...EXTRA_ENV };
  const entries = [];
  for (const [key, envVar] of Object.entries(mapping)) {
    let raw = text2(env, envVar);
    if (!raw && key === "warehouse_id") raw = text2(env, "DATABRICKS_SQL_WAREHOUSE_ID");
    if (!raw) continue;
    if (key === "semantic_index") {
      raw = resolveSemanticIndexValue(
        raw,
        text2(env, "PLAYER_INSIGHTS_CATALOG"),
        text2(env, "PLAYER_INSIGHTS_SCHEMA")
      ) || raw;
    }
    entries.push({
      key,
      env_var: envVar,
      value: LIST_KEYS.has(key) ? splitList(raw) : raw,
      source: "app-environment",
      mutability: "model-version",
      baked: false,
      required: false
    });
  }
  const hasManifest = entries.some(
    (entry) => entry.key === "declared_manifest" && Array.isArray(entry.value) && entry.value.length > 0
  );
  if (!hasManifest) {
    const qualified = qualifyDataContractTables(text2(env, "PLAYER_INSIGHTS_CATALOG"), text2(env, "PLAYER_INSIGHTS_SCHEMA"));
    if (qualified.length > 0) {
      entries.push({
        key: "declared_manifest",
        env_var: "PLAYER_INSIGHTS_DECLARED_MANIFEST",
        value: qualified,
        source: "data-contract",
        mutability: "model-version",
        baked: false,
        required: false
      });
    }
  }
  return entries;
}
function catalogSchemaOf(entries) {
  return {
    catalog: asString(entryValue(entries.find((entry) => entry.key === "catalog"))),
    schema: asString(entryValue(entries.find((entry) => entry.key === "schema")))
  };
}
function isDataContractManifest(entry, catalog, schema) {
  if (entry.source === "data-contract") return true;
  return isDataContractFallback(asStringList(entry.value), catalog, schema);
}
function mergeReleaseConfiguration(fromEnv, fromBaked) {
  const byKey = new Map(fromEnv.map((entry) => [entry.key, entry]));
  const { catalog, schema } = catalogSchemaOf(fromEnv);
  for (const baked of fromBaked) {
    const existing = byKey.get(baked.key);
    if (!existing || isEmptyValue(existing.value)) {
      byKey.set(baked.key, baked);
      continue;
    }
    if (baked.key === "declared_manifest" && isDataContractManifest(existing, catalog, schema)) {
      const bakedList = asStringList(baked.value);
      if (bakedList.length > asStringList(existing.value).length) {
        byKey.set(baked.key, baked);
      }
      continue;
    }
    if (baked.key === "semantic_index") {
      const existingName = asString(existing.value);
      const bakedName = asString(baked.value);
      if (!existingName.includes(".") && bakedName.includes(".")) {
        byKey.set(baked.key, baked);
      }
    }
  }
  return [...byKey.values()];
}
function configurationForSettings(env = process.env, baked = []) {
  return mergeReleaseConfiguration(configurationFromRelease(env), baked);
}

// server/lib/baked-model-config.ts
var BAKED_TTL_MS = 45e3;
var EXTRA_ENV2 = {
  declared_manifest: "PLAYER_INSIGHTS_DECLARED_MANIFEST",
  tables: "PLAYER_INSIGHTS_TABLES",
  semantic_index: "PLAYER_INSIGHTS_SEMANTIC_INDEX",
  manifest_source: "PLAYER_INSIGHTS_MANIFEST_SOURCE"
};
var LIST_KEYS2 = /* @__PURE__ */ new Set(["catalog_allowlist", "catalog_denylist", "declared_manifest", "tables"]);
function text3(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return "";
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
function parseModelConfigDocument(source) {
  const trimmed = source.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const record = asRecord(parsed);
      const nested = asRecord(record.model_config);
      if (Object.keys(nested).length > 0) return nested;
      const flavors = asRecord(asRecord(record.flavors).python_function);
      const fromFlavor = asRecord(flavors.config ?? flavors.model_config);
      if (Object.keys(fromFlavor).length > 0) return fromFlavor;
      if ("llm_endpoint" in record || "declared_manifest" in record || "semantic_index" in record) {
        return record;
      }
    } catch {
      return {};
    }
  }
  const block = yamlBlock(source, ["model_config:", "config:"]);
  return block ? parseYamlMap(block) : {};
}
function yamlBlock(source, headers) {
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const header = headers.find((name) => line.trimStart().startsWith(name));
    if (!header) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const rest = line.trimStart().slice(header.length).trim();
    const collected = [];
    if (rest && rest !== "|" && rest !== ">" && rest !== "{}") {
      collected.push(`_inline: ${rest}`);
    }
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next];
      if (!candidate.trim()) {
        collected.push(candidate);
        continue;
      }
      const candidateIndent = candidate.match(/^\s*/)?.[0].length ?? 0;
      if (candidateIndent <= indent) break;
      collected.push(candidate.slice(indent + 2));
    }
    const body = collected.join("\n").trim();
    if (body) return body;
  }
  return "";
}
function parseYamlMap(block) {
  const result = {};
  const lines = block.split(/\r?\n/);
  let currentKey = "";
  let list = null;
  const flushList = () => {
    if (currentKey && list) result[currentKey] = list;
    list = null;
  };
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && currentKey) {
      list = list ?? [];
      list.push(unquote(item[1]));
      continue;
    }
    const pair = line.match(/^\s*([A-Za-z0-9_]+):\s*(.*)$/);
    if (!pair) continue;
    flushList();
    currentKey = pair[1];
    const raw = pair[2].trim();
    if (!raw || raw === "|" || raw === ">" || raw === "[]") {
      list = raw === "[]" ? [] : [];
      if (raw === "[]") {
        result[currentKey] = [];
        list = null;
      }
      continue;
    }
    if (raw.startsWith("[") && raw.endsWith("]")) {
      try {
        const parsed = JSON.parse(raw.replace(/'/g, '"'));
        result[currentKey] = Array.isArray(parsed) ? parsed.map((entry) => text3(entry)) : unquote(raw);
      } catch {
        result[currentKey] = unquote(raw);
      }
      continue;
    }
    if (raw === "null" || raw === "~") {
      result[currentKey] = "";
      continue;
    }
    result[currentKey] = unquote(raw);
  }
  flushList();
  return result;
}
function artifactText(body) {
  if (typeof body === "string") return body;
  const record = asRecord(body);
  if (typeof record.content === "string") return record.content;
  if (typeof record.data === "string") {
    try {
      return Buffer.from(record.data, "base64").toString("utf8");
    } catch {
      return record.data;
    }
  }
  if (typeof record.text === "string") return record.text;
  return "";
}
function runIdOf(body) {
  const record = asRecord(body);
  const version = asRecord(record.model_version ?? record.modelVersion);
  return text3(version.run_id ?? version.runId ?? record.run_id ?? record.runId);
}
function envVarFor(key) {
  return APPLY_ENV_VARS[key] ?? EXTRA_ENV2[key] ?? "";
}
function configurationFromBaked(config) {
  const entries = [];
  for (const [key, raw] of Object.entries(config)) {
    if (raw === void 0 || raw === null || raw === "") continue;
    const value = LIST_KEYS2.has(key) ? Array.isArray(raw) ? raw.map((item) => text3(item)).filter(Boolean) : text3(raw).split(",").map((item) => item.trim()).filter(Boolean) : text3(raw);
    if (Array.isArray(value) ? value.length === 0 : !value) continue;
    entries.push({
      key,
      env_var: envVarFor(key),
      value,
      source: "artifact",
      mutability: "model-version",
      baked: true,
      required: false
    });
  }
  return entries;
}
async function defaultGetJson(path, query = {}) {
  const { WorkspaceClient } = await import("./vendor-databricks-sdk-experimental.mjs");
  const client = new WorkspaceClient({});
  return client.apiClient.request({
    path,
    method: "GET",
    query,
    headers: new Headers({ Accept: "application/json" }),
    raw: false
  });
}
async function describeEndpoint(name) {
  const { WorkspaceClient } = await import("./vendor-databricks-sdk-experimental.mjs");
  return new WorkspaceClient({}).servingEndpoints.get({ name });
}
async function readModelConfigText(transport, runId) {
  const paths = ["agent/MLmodel", "MLmodel", "agent/model_config", "model_config.json", "agent/config.json"];
  for (const artifact of paths) {
    try {
      if (transport.getText) {
        const textBody = await transport.getText("/api/2.0/mlflow/artifacts/get", {
          run_id: runId,
          path: artifact
        });
        if (textBody.trim()) return textBody;
      }
      const body = await transport.getJson("/api/2.0/mlflow/artifacts/get", {
        run_id: runId,
        path: artifact
      });
      const extracted = artifactText(body);
      if (extracted.trim()) return extracted;
    } catch {
    }
  }
  try {
    const listed = asRecord(
      await transport.getJson("/api/2.0/mlflow/artifacts/list", { run_id: runId, path: "agent" })
    );
    const files = Array.isArray(listed.files) ? listed.files : [];
    const mlmodel = files.find((file) => {
      const path2 = text3(asRecord(file).path);
      return path2.endsWith("MLmodel") || path2.endsWith("model_config") || path2.endsWith("config.json");
    });
    const path = text3(asRecord(mlmodel).path);
    if (!path) return "";
    const body = await transport.getJson("/api/2.0/mlflow/artifacts/get", { run_id: runId, path });
    return artifactText(body);
  } catch {
    return "";
  }
}
async function runIdForServedModel(transport, entityName, version) {
  const attempts = [
    {
      path: `/api/2.1/unity-catalog/models/${encodeURIComponent(entityName)}/versions/${encodeURIComponent(version)}`,
      query: {}
    },
    {
      path: "/api/2.1/unity-catalog/model-versions/get",
      query: { full_name: entityName, version }
    },
    {
      path: "/api/2.0/mlflow/databricks/model-versions/get",
      query: { name: entityName, version }
    },
    {
      path: "/api/2.0/mlflow/model-versions/get",
      query: { name: entityName, version }
    }
  ];
  for (const attempt of attempts) {
    try {
      const runId = runIdOf(await transport.getJson(attempt.path, attempt.query));
      if (runId) return runId;
    } catch {
    }
  }
  return "";
}
var cache = null;
async function readBakedModelConfig(input = {}) {
  const endpointName = (input.endpointName ?? process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? "").trim();
  if (!endpointName) return [];
  if (!input.readEndpoint && !input.transport && !(process.env.DATABRICKS_HOST ?? "").trim()) return [];
  const now = input.now ?? Date.now();
  if (cache && cache.endpoint === endpointName && now - cache.at < BAKED_TTL_MS) {
    return cache.entries;
  }
  const transport = input.transport ?? { getJson: defaultGetJson };
  try {
    const served = parseServedModel(
      endpointName,
      await (input.readEndpoint ?? describeEndpoint)(endpointName)
    );
    if (!served.entityName || !served.version) return [];
    const runId = await runIdForServedModel(transport, served.entityName, served.version);
    if (!runId) return [];
    const document = await readModelConfigText(transport, runId);
    const entries = configurationFromBaked(parseModelConfigDocument(document));
    cache = { at: now, endpoint: endpointName, entries };
    return entries;
  } catch (error) {
    console.warn(
      "[settings] The served model version’s baked configuration could not be read:",
      error.message
    );
    return [];
  }
}

// shared/agent-model.ts
var NO_AGENT_MODEL = {
  model: "",
  version: "",
  url: "",
  versioned: false
};
function agentModelReference(input) {
  const model = input.model.trim();
  const version = input.version.trim();
  if (!model) return NO_AGENT_MODEL;
  const versioned = version.length > 0;
  const url = databricksLink(
    input.host,
    versioned ? { kind: "model-version", model, version } : { kind: "registered-model", model }
  ) ?? "";
  return {
    model,
    version,
    url,
    // Not merely "a version was reported": a version this app could not build a
    // link from must not leave the pane claiming it linked to one.
    versioned: versioned && url.length > 0
  };
}

// server/lib/agent-model.ts
async function describeEndpoint2(name) {
  const { WorkspaceClient } = await import("./vendor-databricks-sdk-experimental.mjs");
  return new WorkspaceClient({}).servingEndpoints.get({ name });
}
async function readAgentModel(input = {}) {
  const endpointName = (input.endpointName ?? process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? "").trim();
  const host = input.workspaceHost ?? process.env.DATABRICKS_HOST ?? "";
  const configuredModel = (input.configuredModel ?? process.env.PLAYER_INSIGHTS_MODEL_NAME ?? "").trim();
  let model = "";
  let version = "";
  if (endpointName) {
    try {
      const served = parseServedModel(endpointName, await (input.read ?? describeEndpoint2)(endpointName));
      model = served.entityName ?? "";
      version = served.version ?? "";
    } catch (error) {
      console.warn(
        `[settings] The endpoint ${endpointName} could not be asked which model version it serves:`,
        error.message
      );
    }
  }
  const resolved = model || configuredModel;
  if (!resolved) return NO_AGENT_MODEL;
  return agentModelReference({ host, model: resolved, version: model ? version : "" });
}

// server/lib/notebook-declaration-read.ts
var TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}(\.[A-Za-z_][A-Za-z0-9_]{0,127}){2}$/;
function isDeclarationLocation(value) {
  return TABLE_NAME.test(value.trim());
}
function declarationStatement(location) {
  return `SELECT document FROM ${location} ORDER BY published_at DESC LIMIT 1`;
}
var FAILURE_DETAIL = {
  "not-configured": "No notebook is connected. Add the table a notebook publishes to.",
  "bad-location": "The configured location is not a three-part Unity Catalog name, so nothing was read.",
  "no-token": "Sign in again to read this as yourself.",
  refused: "You do not have access to the table the notebook publishes to. Ask for SELECT on it.",
  empty: "The table is there and nothing has been published to it yet.",
  unreadable: "The published row is not a declaration this app can read.",
  unavailable: "The published declaration could not be read just now."
};
function failed(failure) {
  return { declaration: null, failure, detail: FAILURE_DETAIL[failure] };
}
var DECLARATION_TIMEOUT_MS = 8e3;
async function readPublishedDeclaration(input) {
  const location = input.location.trim();
  if (!location) return failed("not-configured");
  if (!isDeclarationLocation(location)) return failed("bad-location");
  if (!input.token) return failed("no-token");
  if (!input.host || !input.warehouseId.trim()) return failed("not-configured");
  const call = input.fetchImpl ?? fetch;
  let response;
  try {
    response = await call(`${input.host.replace(/\/$/, "")}/api/2.0/sql/statements`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        statement: declarationStatement(location),
        warehouse_id: input.warehouseId.trim(),
        query_tags: sqlQueryTags({
          surface: "declaration",
          tool: "notebook_declaration",
          operation: "read"
        }),
        wait_timeout: "30s",
        on_wait_timeout: "CANCEL",
        // One row of bounded text. Asked for inline so there is no external link
        // to fetch, which would be a second request on a different credential.
        format: "JSON_ARRAY",
        disposition: "INLINE",
        row_limit: 1
      }),
      signal: AbortSignal.timeout(DECLARATION_TIMEOUT_MS)
    });
  } catch (error) {
    console.warn("[connections] The published declaration could not be read:", error.message);
    return failed("unavailable");
  }
  if (response.status === 401 || response.status === 403) return failed("refused");
  if (!response.ok) return failed("unavailable");
  let body;
  try {
    body = await response.json();
  } catch {
    return failed("unavailable");
  }
  const document = firstCell(body);
  if (document === null) {
    return failed(statementSucceeded(body) ? "empty" : "unavailable");
  }
  if (document.length > MAX_DECLARATION_BYTES) return failed("unreadable");
  let parsed;
  try {
    parsed = JSON.parse(document);
  } catch {
    return failed("unreadable");
  }
  const declaration = parseDeclaration(parsed);
  if (!declaration) return failed("unreadable");
  return { declaration, failure: null, detail: "" };
}
function statementSucceeded(body) {
  if (typeof body !== "object" || body === null) return false;
  const status = body.status;
  return typeof status === "object" && status !== null && status.state === "SUCCEEDED";
}
function firstCell(body) {
  if (typeof body !== "object" || body === null) return null;
  const result = body.result;
  if (typeof result !== "object" || result === null) return null;
  const rows = result.data_array;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0];
  if (!Array.isArray(first) || first.length === 0) return null;
  return typeof first[0] === "string" ? first[0] : null;
}

// server/lib/model-release-store.ts
var COLUMNS = `id, status, requested_by, requested_at, declaration,
  declaration_revision, target, endpoint_name, model_name, v_from, v_to,
  preflight_at_request, preflight_result, started_at, completed_at,
  claimed_by, completed_by, error_summary`;
function text4(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return "";
}
function instant(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : text4(value) || null;
}
function jsonValue(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}
function modelReleaseFromRow(row) {
  return {
    id: text4(row.id),
    status: text4(row.status),
    requestedBy: text4(row.requested_by),
    requestedAt: instant(row.requested_at) ?? "",
    declaration: jsonValue(row.declaration),
    declarationRevision: text4(row.declaration_revision),
    target: text4(row.target),
    endpointName: text4(row.endpoint_name),
    modelName: text4(row.model_name),
    vFrom: text4(row.v_from) || null,
    vTo: text4(row.v_to) || null,
    preflightAtRequest: jsonValue(row.preflight_at_request),
    preflightResult: jsonValue(row.preflight_result),
    startedAt: instant(row.started_at),
    completedAt: instant(row.completed_at),
    claimedBy: text4(row.claimed_by) || null,
    completedBy: text4(row.completed_by) || null,
    errorSummary: text4(row.error_summary) || null
  };
}
async function createModelRelease(store, input) {
  const result = await store.lakebase.query(
    `INSERT INTO ${APP_SCHEMA}.model_release_requests
       (id, status, requested_by, declaration, declaration_revision, target,
        endpoint_name, model_name, v_from, preflight_at_request)
     VALUES ($1, 'approved', $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.requestedBy,
      JSON.stringify(input.declaration),
      input.declaration.revision,
      input.target,
      input.endpointName,
      input.modelName,
      input.vFrom,
      input.preflightAtRequest ? JSON.stringify(input.preflightAtRequest) : null
    ]
  );
  return modelReleaseFromRow(result.rows[0] ?? {});
}
async function readModelRelease(store, id) {
  const result = await store.lakebase.query(
    `SELECT ${COLUMNS}
       FROM ${APP_SCHEMA}.model_release_requests
      WHERE id = $1`,
    [id]
  );
  return result.rows[0] ? modelReleaseFromRow(result.rows[0]) : null;
}
async function listModelReleases(store, limit = 20) {
  const result = await store.lakebase.query(
    `SELECT ${COLUMNS}
       FROM ${APP_SCHEMA}.model_release_requests
      ORDER BY requested_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(limit, 100))]
  );
  return result.rows.map(modelReleaseFromRow);
}
async function claimModelRelease(store, id, executionId, actor) {
  const updated = await store.lakebase.query(
    `UPDATE ${APP_SCHEMA}.model_release_requests
        SET status = 'running', execution_id = $2, claimed_by = $3,
            started_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'approved'
      RETURNING ${COLUMNS}`,
    [id, executionId, actor]
  );
  if (updated.rows[0]) return { release: modelReleaseFromRow(updated.rows[0]), claimed: true };
  const existing = await store.lakebase.query(
    `SELECT ${COLUMNS}, execution_id
       FROM ${APP_SCHEMA}.model_release_requests
      WHERE id = $1`,
    [id]
  );
  const row = existing.rows[0];
  if (!row) return { release: null, claimed: false };
  return {
    release: modelReleaseFromRow(row),
    claimed: row.status === "running" && row.execution_id === executionId
  };
}
async function completeModelRelease(store, id, actor, completion) {
  const error = completion.status === "failed" ? (completion.errorSummary ?? "").slice(0, 1e3) : null;
  const updated = await store.lakebase.query(
    `UPDATE ${APP_SCHEMA}.model_release_requests
        SET status = $3, v_to = $4, preflight_result = $5::jsonb,
            error_summary = $6, completed_by = $7, completed_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'running' AND execution_id = $2
      RETURNING ${COLUMNS}`,
    [
      id,
      completion.executionId,
      completion.status,
      completion.vTo || null,
      completion.preflight ? JSON.stringify(completion.preflight) : null,
      error,
      actor
    ]
  );
  if (updated.rows[0]) return { release: modelReleaseFromRow(updated.rows[0]), updated: true };
  const existing = await store.lakebase.query(
    `SELECT ${COLUMNS}, execution_id
       FROM ${APP_SCHEMA}.model_release_requests
      WHERE id = $1`,
    [id]
  );
  const row = existing.rows[0];
  if (!row) return { release: null, updated: false };
  const release = modelReleaseFromRow(row);
  const idempotent = row.execution_id === completion.executionId && release.status === completion.status && (release.vTo ?? null) === (completion.vTo || null);
  return { release, updated: idempotent };
}

// server/lib/resource-tagging.ts
var ASTROLABE_TAG = BILLING_TAG;
function configurationValue(report, key) {
  const value = report?.configuration.find((entry) => entry.key === key)?.value;
  return typeof value === "string" ? value.trim() : "";
}
function text5(value) {
  return (value ?? "").trim();
}
function resourceTagInventory(input = {}) {
  const environment = input.environment ?? process.env;
  const report = input.report ?? null;
  const targets = [];
  const appName = text5(environment.DATABRICKS_APP_NAME);
  if (appName) {
    targets.push({ kind: "app", name: appName, label: `App · ${appName}`, action: "tag" });
  }
  const modelName = configurationValue(report, "model_name") || text5(environment.PLAYER_INSIGHTS_MODEL_NAME);
  const modelVersion = configurationValue(report, "model_version");
  if (modelName) {
    targets.push({
      kind: "registered-model",
      name: modelName,
      label: `Registered agent model · ${modelName}`,
      action: "tag"
    });
    if (modelVersion) {
      targets.push({
        kind: "model-version",
        name: modelName,
        version: modelVersion,
        label: `Agent model version · ${modelName} v${modelVersion}`,
        action: "tag"
      });
    }
  }
  const serving = text5(environment.DATABRICKS_SERVING_ENDPOINT_NAME);
  if (serving) {
    targets.push({
      kind: "serving-endpoint",
      name: serving,
      label: `Serving endpoint · ${serving}`,
      action: "tag"
    });
  }
  const foundationModel = configurationValue(report, "llm_endpoint");
  if (foundationModel) {
    targets.push({
      kind: "serving-endpoint",
      name: foundationModel,
      label: `Foundation model serving endpoint · ${foundationModel}`,
      action: "tag"
    });
  }
  for (const [key, label] of [
    ["data_genie_space_id", "Data Genie space"],
    ["dictionary_genie_space_id", "Dictionary Genie space"]
  ]) {
    const spaceId = configurationValue(report, key);
    if (!spaceId) continue;
    targets.push({
      kind: "genie-space",
      name: spaceId,
      label: `${label} · ${spaceId}`,
      action: "skip",
      reason: "Genie space tags are organizational only and do not propagate to billing by space id. SQL issued by this space is billed through its associated SQL warehouse."
    });
  }
  const experimentId = text5(environment.PLAYER_INSIGHTS_EXPERIMENT_ID);
  if (experimentId) {
    targets.push({
      kind: "mlflow-experiment",
      name: experimentId,
      label: `MLflow experiment · ${experimentId}`,
      action: "tag"
    });
  }
  const index = configurationValue(report, "semantic_index");
  if (index && index.includes(".")) {
    targets.push({
      kind: "vector-index",
      name: index,
      label: `Vector Search index · ${index}`,
      action: "skip",
      reason: "Databricks does not expose custom tags for Vector Search indexes. Nothing needs to be fixed on this index; Astrolabe tags its endpoint instead."
    });
  }
  const warehouse = text5(environment.DATABRICKS_SQL_WAREHOUSE_ID);
  if (warehouse) {
    targets.push({
      kind: "sql-warehouse",
      name: warehouse,
      label: `SQL warehouse · ${warehouse}`,
      action: "tag"
    });
  }
  const lakebaseBinding = text5(environment.LAKEBASE_ENDPOINT);
  const projectId = /^projects\/([^/]+)/.exec(lakebaseBinding)?.[1] ?? "";
  if (projectId) {
    targets.push({
      kind: "lakebase",
      name: `projects/${projectId}`,
      label: `Lakebase project · ${projectId}`,
      action: "tag"
    });
  }
  const seen = /* @__PURE__ */ new Set();
  return targets.filter((target) => {
    const key = `${target.kind}\0${target.name}\0${target.version ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function hasTag(tags) {
  return tags.some((tag) => tag.key === ASTROLABE_TAG.key && tag.value === ASTROLABE_TAG.value);
}
function hasRetiredTag(tags) {
  return tags.some((tag) => tag.key === RETIRED_BILLING_TAG_KEY);
}
function mergeTag(tags) {
  return [
    ...tags.filter((tag) => tag.key !== ASTROLABE_TAG.key && tag.key !== RETIRED_BILLING_TAG_KEY),
    { ...ASTROLABE_TAG }
  ];
}
function tagStateDetail(state, extra = "") {
  const lead = state === "already-correct" ? `Already correct: ${billingTagPair()}.` : `Now correct: tagged ${billingTagPair()}.`;
  return extra ? `${lead} ${extra}` : lead;
}
var RETRYABLE_STATUS = /* @__PURE__ */ new Set([502, 503, 504]);
var RETRYABLE_CODES = /* @__PURE__ */ new Set(["DEADLINE_EXCEEDED", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN"]);
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
function errorCode(error) {
  const shape = error;
  const code = shape?.error_code ?? shape?.code;
  return typeof code === "string" || typeof code === "number" ? String(code).toUpperCase() : "";
}
function isPermissionError(error) {
  const status = errorStatus(error);
  const raw = `${errorCode(error)} ${errorText(error)}`;
  return status === 403 || /PERMISSION_DENIED|FORBIDDEN|UNAUTHORI[ZS]ED/i.test(raw);
}
function isRetryable(error) {
  if (RETRYABLE_STATUS.has(errorStatus(error)) || RETRYABLE_CODES.has(errorCode(error))) return true;
  return /DEADLINE_EXCEEDED|Gateway Timeout|HTTP\s+(?:502|503|504)|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN/i.test(
    errorText(error)
  );
}
function technicalDetail(error) {
  const raw = errorText(error).trim();
  if (raw.length <= 8e3) return raw;
  return `${raw.slice(0, 8e3)}
…technical response truncated by Astrolabe`;
}
function principalId(error, fallback) {
  const fromError = errorText(error).match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[0];
  return fromError ?? (text5(fallback) || "the Astrolabe app service principal");
}
function permissionRequired(target, error, servicePrincipalId) {
  const principal = principalId(error, servicePrincipalId);
  let detail;
  if (target.kind === "app") {
    detail = `Workspace admin action: grant service principal ${principal} CAN_MANAGE on app “${target.name}” so it can change the app tag assignments. Databricks app tags are organizational and currently do not propagate to billing.`;
  } else if (target.kind === "vector-endpoint") {
    detail = `Workspace admin action: grant service principal ${principal} CAN_USE or CAN_MANAGE on Vector Search endpoint “${target.name}”.`;
  } else if (target.kind === "sql-warehouse") {
    detail = `Workspace admin action: grant service principal ${principal} CAN_MANAGE (or ownership) on SQL warehouse “${target.name}”.`;
  } else if (target.kind === "lakebase") {
    detail = `Workspace admin action: grant service principal ${principal} CAN_MANAGE (or ownership) on Lakebase project “${target.name.replace(/^projects\//, "")}” so it can update custom tags.`;
  } else {
    detail = `Workspace admin action: grant service principal ${principal} management permission on “${target.name}”.`;
  }
  return { ...target, status: "permission-required", detail, technicalDetail: technicalDetail(error) };
}
function failed2(target, error, servicePrincipalId) {
  if (isPermissionError(error)) return permissionRequired(target, error, servicePrincipalId);
  return {
    ...target,
    status: "failed",
    detail: "Databricks did not complete the tag update after Astrolabe retried transient failures.",
    technicalDetail: technicalDetail(error)
  };
}
function taggingDeadlineError() {
  return Object.assign(new Error("Astrolabe stopped waiting for the Databricks tag operation at its time limit."), {
    code: "ETIMEDOUT"
  });
}
async function insideTaggingDeadline(operation, policy) {
  const remaining = policy.deadline - policy.now();
  if (remaining <= 0) throw taggingDeadlineError();
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(taggingDeadlineError()), remaining);
      })
    ]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
async function retryTransient(operation, policy) {
  let lastError;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await insideTaggingDeadline(operation, policy);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === policy.maxAttempts) throw error;
      const delayMs = policy.baseDelayMs * (2 ** attempt - 1);
      if (policy.now() + delayMs >= policy.deadline) throw error;
      await policy.sleep(delayMs);
    }
  }
  throw lastError;
}
async function tagTargetOnce(target, platform) {
  if (target.action === "skip") {
    return {
      ...target,
      status: "not-supported",
      detail: target.reason ?? "Databricks does not expose a custom tag API for this resource."
    };
  }
  if (target.kind === "app") {
    const current = await platform.getAppTag(target.name);
    if (current === ASTROLABE_TAG.value) {
      return {
        ...target,
        status: "already-correct",
        detail: tagStateDetail(
          "already-correct",
          "Databricks app tags are organizational and currently do not propagate to billing."
        )
      };
    }
    if (current === null) await platform.createAppTag(target.name);
    else await platform.updateAppTag(target.name);
    return {
      ...target,
      status: "tagged",
      detail: tagStateDetail(
        "tagged",
        "Databricks app tags are organizational and currently do not propagate to billing."
      )
    };
  }
  if (target.kind === "serving-endpoint") {
    const tags = await platform.getServingTags(target.name);
    const current = hasTag(tags);
    const retired = hasRetiredTag(tags);
    if (!current) await platform.addServingTag(target.name);
    if (retired) await platform.deleteServingTag(target.name, RETIRED_BILLING_TAG_KEY);
    if (current && !retired) {
      return { ...target, status: "already-correct", detail: tagStateDetail("already-correct") };
    }
    return {
      ...target,
      status: "tagged",
      detail: retired ? tagStateDetail("tagged", `Removed retired key ${RETIRED_BILLING_TAG_KEY}.`) : tagStateDetail("tagged")
    };
  }
  if (target.kind === "registered-model") {
    const tags = await platform.getModelTags(target.name);
    const current = hasTag(tags);
    const retired = hasRetiredTag(tags);
    if (!current) await platform.setModelTag(target.name);
    if (retired) await platform.deleteModelTag(target.name, RETIRED_BILLING_TAG_KEY);
    if (current && !retired) {
      return { ...target, status: "already-correct", detail: tagStateDetail("already-correct") };
    }
    return {
      ...target,
      status: "tagged",
      detail: retired ? tagStateDetail("tagged", `Removed retired key ${RETIRED_BILLING_TAG_KEY}.`) : tagStateDetail("tagged")
    };
  }
  if (target.kind === "model-version") {
    const version = target.version;
    if (!version) throw new Error("The connected agent model version was not resolved.");
    const tags = await platform.getModelVersionTags(target.name, version);
    const current = hasTag(tags);
    const retired = hasRetiredTag(tags);
    if (!current) await platform.setModelVersionTag(target.name, version);
    if (retired) await platform.deleteModelVersionTag(target.name, version, RETIRED_BILLING_TAG_KEY);
    if (current && !retired) {
      return { ...target, status: "already-correct", detail: tagStateDetail("already-correct") };
    }
    return {
      ...target,
      status: "tagged",
      detail: retired ? tagStateDetail("tagged", `Removed retired key ${RETIRED_BILLING_TAG_KEY}.`) : tagStateDetail("tagged")
    };
  }
  if (target.kind === "mlflow-experiment") {
    const tags = await platform.getExperimentTags(target.name);
    const current = hasTag(tags);
    const retired = hasRetiredTag(tags);
    if (!current) await platform.setExperimentTag(target.name);
    if (retired) await platform.deleteExperimentTag(target.name, RETIRED_BILLING_TAG_KEY);
    if (current && !retired) {
      return { ...target, status: "already-correct", detail: tagStateDetail("already-correct") };
    }
    return {
      ...target,
      status: "tagged",
      detail: retired ? tagStateDetail("tagged", `Removed retired key ${RETIRED_BILLING_TAG_KEY}.`) : tagStateDetail("tagged")
    };
  }
  if (target.kind === "sql-warehouse") {
    const tags = await platform.getWarehouseTags(target.name);
    if (hasTag(tags) && !hasRetiredTag(tags)) {
      return { ...target, status: "already-correct", detail: tagStateDetail("already-correct") };
    }
    await platform.setWarehouseTags(target.name, mergeTag(tags));
    return {
      ...target,
      status: "tagged",
      detail: hasRetiredTag(tags) ? tagStateDetail("tagged", `Removed retired key ${RETIRED_BILLING_TAG_KEY}.`) : tagStateDetail("tagged")
    };
  }
  if (target.kind === "lakebase") {
    const tags = await platform.getLakebaseTags(target.name);
    if (hasTag(tags) && !hasRetiredTag(tags)) {
      return { ...target, status: "already-correct", detail: tagStateDetail("already-correct") };
    }
    await platform.setLakebaseTags(target.name, mergeTag(tags));
    return {
      ...target,
      status: "tagged",
      detail: hasRetiredTag(tags) ? tagStateDetail("tagged", `Removed retired key ${RETIRED_BILLING_TAG_KEY}.`) : tagStateDetail("tagged")
    };
  }
  return {
    ...target,
    status: "not-supported",
    detail: target.reason ?? "Databricks does not expose a custom tag API for this connected resource."
  };
}
async function readAppBillingTag(appName, platform) {
  const name = appName.trim();
  if (!name) return "unverified";
  try {
    const adapter = platform ?? await workspaceTagPlatform();
    const current = await adapter.getAppTag(name);
    return current === ASTROLABE_TAG.value ? "matched" : "missing";
  } catch {
    return "unverified";
  }
}
async function applyAstrolabeTags(input) {
  const platform = input.platform ?? await workspaceTagPlatform();
  const environment = input.environment ?? process.env;
  const targets = resourceTagInventory({ environment, report: input.report });
  const results = [];
  const now = input.retry?.now ?? Date.now;
  const maxAttempts = Math.max(1, Math.min(3, input.retry?.maxAttempts ?? 3));
  const baseDelayMs = Math.max(0, Math.min(1e3, input.retry?.baseDelayMs ?? 250));
  const timeBudgetMs = Math.max(1e3, Math.min(12e3, input.retry?.timeBudgetMs ?? 12e3));
  const policy = {
    maxAttempts,
    baseDelayMs,
    deadline: now() + timeBudgetMs,
    sleep: input.retry?.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))),
    now
  };
  const servicePrincipalId = environment.DATABRICKS_CLIENT_ID;
  for (const target of targets) {
    try {
      results.push(await retryTransient(() => tagTargetOnce(target, platform), policy));
    } catch (error) {
      results.push(failed2(target, error, servicePrincipalId));
    }
    if (target.kind !== "vector-index" || target.action !== "skip") continue;
    let endpointName = "";
    try {
      results.push(
        await retryTransient(async () => {
          endpointName = await platform.getVectorIndexEndpoint(target.name);
          const endpoint = {
            kind: "vector-endpoint",
            name: endpointName,
            label: `Vector Search endpoint · ${endpointName}`,
            action: "tag"
          };
          const tags = await platform.getVectorEndpointTags(endpointName);
          if (hasTag(tags) && !hasRetiredTag(tags)) {
            return { ...endpoint, status: "already-correct", detail: tagStateDetail("already-correct") };
          }
          await platform.setVectorEndpointTags(endpointName, mergeTag(tags));
          return {
            ...endpoint,
            status: "tagged",
            detail: hasRetiredTag(tags) ? tagStateDetail("tagged", `Removed retired key ${RETIRED_BILLING_TAG_KEY}.`) : tagStateDetail("tagged")
          };
        }, policy)
      );
    } catch (error) {
      results.push(
        failed2(
          {
            kind: "vector-endpoint",
            name: endpointName || target.name,
            label: endpointName ? `Vector Search endpoint · ${endpointName}` : "Vector Search endpoint",
            action: "tag"
          },
          error,
          servicePrincipalId
        )
      );
    }
  }
  const tagged = results.filter((result) => result.status === "tagged").length;
  const alreadyCorrect = results.filter((result) => result.status === "already-correct").length;
  const total = results.length;
  const correct = tagged + alreadyCorrect;
  const notSupported = results.filter((result) => result.status === "not-supported").length;
  const permissionRequired2 = results.filter((result) => result.status === "permission-required").length;
  const failedCount = results.filter((result) => result.status === "failed").length;
  return {
    headline: `${correct} of ${total} resources correctly tagged · ${notSupported} not supported by Databricks · ${permissionRequired2} need workspace grants · ${failedCount} failed after retries.`,
    total,
    correct,
    tagged,
    alreadyCorrect,
    notSupported,
    permissionRequired: permissionRequired2,
    failed: failedCount,
    results
  };
}
function errorStatus(error) {
  const shape = error;
  return Number(shape?.statusCode ?? shape?.status ?? 0);
}
async function workspaceTagPlatform() {
  const { WorkspaceClient } = await import("./vendor-databricks-sdk-experimental.mjs");
  const client = new WorkspaceClient({ httpTimeoutSeconds: 5, retryTimeoutSeconds: 0 });
  const jsonHeaders = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
  const appTagPath = (appName) => `/api/2.0/entity-tag-assignments/apps/${encodeURIComponent(appName)}/tags/${ASTROLABE_TAG.key}`;
  return {
    async getAppTag(appName) {
      try {
        const body = await client.apiClient.request({
          path: appTagPath(appName),
          method: "GET",
          headers: jsonHeaders,
          raw: false
        });
        return typeof body?.tag_value === "string" ? body.tag_value : "";
      } catch (error) {
        if (errorStatus(error) === 404) return null;
        throw error;
      }
    },
    async createAppTag(appName) {
      await client.apiClient.request({
        path: "/api/2.0/entity-tag-assignments",
        method: "POST",
        headers: jsonHeaders,
        payload: {
          entity_type: "apps",
          entity_id: appName,
          tag_key: ASTROLABE_TAG.key,
          tag_value: ASTROLABE_TAG.value
        },
        raw: false
      });
    },
    async updateAppTag(appName) {
      await client.apiClient.request({
        path: appTagPath(appName),
        method: "PATCH",
        headers: jsonHeaders,
        query: { update_mask: "tag_value" },
        payload: { tag_value: ASTROLABE_TAG.value },
        raw: false
      });
    },
    async getServingTags(name) {
      return (await client.servingEndpoints.get({ name })).tags ?? [];
    },
    async addServingTag(name) {
      await client.servingEndpoints.patch({ name, add_tags: [{ ...ASTROLABE_TAG }] });
    },
    async deleteServingTag(name, key) {
      await client.servingEndpoints.patch({ name, delete_tags: [key] });
    },
    async getModelTags(name) {
      return (await client.modelRegistry.getModel({ name })).registered_model_databricks?.tags ?? [];
    },
    async setModelTag(name) {
      await client.modelRegistry.setModelTag({ name, ...ASTROLABE_TAG });
    },
    async deleteModelTag(name, key) {
      await client.modelRegistry.deleteModelTag({ name, key });
    },
    async getModelVersionTags(name, version) {
      return (await client.modelRegistry.getModelVersion({ name, version })).model_version?.tags ?? [];
    },
    async setModelVersionTag(name, version) {
      await client.modelRegistry.setModelVersionTag({ name, version, ...ASTROLABE_TAG });
    },
    async deleteModelVersionTag(name, version, key) {
      await client.modelRegistry.deleteModelVersionTag({ name, version, key });
    },
    async getExperimentTags(experimentId) {
      return (await client.experiments.getExperiment({ experiment_id: experimentId })).experiment?.tags ?? [];
    },
    async setExperimentTag(experimentId) {
      await client.experiments.setExperimentTag({ experiment_id: experimentId, ...ASTROLABE_TAG });
    },
    async deleteExperimentTag(experimentId, key) {
      await client.apiClient.request({
        path: "/api/2.0/mlflow/experiments/delete-experiment-tag",
        method: "POST",
        headers: jsonHeaders,
        payload: { experiment_id: experimentId, key },
        raw: false
      });
    },
    async getWarehouseTags(warehouseId) {
      return (await client.warehouses.get({ id: warehouseId })).tags?.custom_tags ?? [];
    },
    async setWarehouseTags(warehouseId, tags) {
      await client.warehouses.edit({
        id: warehouseId,
        tags: {
          custom_tags: tags.map((tag) => ({ key: tag.key ?? "", value: tag.value ?? "" }))
        }
      });
    },
    async getLakebaseTags(projectName) {
      const project = await client.apiClient.request({
        path: `/api/2.0/postgres/${projectName}`,
        method: "GET",
        headers: jsonHeaders,
        raw: false
      });
      return project.spec?.custom_tags ?? [];
    },
    async setLakebaseTags(projectName, tags) {
      await client.apiClient.request({
        path: `/api/2.0/postgres/${projectName}`,
        method: "PATCH",
        headers: jsonHeaders,
        query: { update_mask: "spec.custom_tags" },
        payload: {
          spec: {
            custom_tags: tags.map((tag) => ({ key: tag.key ?? "", value: tag.value ?? "" }))
          }
        },
        raw: false
      });
    },
    async getVectorIndexEndpoint(indexName) {
      const endpoint = (await client.vectorSearchIndexes.getIndex({ index_name: indexName })).endpoint_name?.trim();
      if (!endpoint) throw new Error(`Vector Search index ${indexName} did not report its endpoint.`);
      return endpoint;
    },
    async getVectorEndpointTags(endpointName) {
      return (await client.vectorSearchEndpoints.getEndpoint({ endpoint_name: endpointName })).custom_tags ?? [];
    },
    async setVectorEndpointTags(endpointName, tags) {
      await client.vectorSearchEndpoints.updateEndpointCustomTags({
        endpoint_name: endpointName,
        custom_tags: tags.map((tag) => ({ key: tag.key ?? "", value: tag.value ?? "" }))
      });
    }
  };
}

// server/routes/settings-routes.ts
var WriteBody = external_exports.object({
  value: external_exports.string().trim().max(500),
  intent: external_exports.enum(["active", "intended"]),
  note: external_exports.string().trim().max(500).default("")
});
var NotebookPathBody = external_exports.strictObject({
  path: external_exports.string().trim().min(1).max(1024)
});
async function validateAndStoreNotebookPath(input) {
  const validate = input.validate ?? validateNotebookPath;
  const validation = await validate(input.path, {
    host: input.host,
    token: input.token
  });
  if (!validation.ok) return validation;
  const write = input.write ?? writeStoredSetting;
  const saved = await write(input.appkit, {
    resourceId: "notebook-path",
    value: validation.path,
    intent: "active",
    note: "Workspace notebook selected from Connections.",
    updatedBy: input.updatedBy
  });
  return { ok: true, saved };
}
var ConnectionBody = external_exports.object({
  id: external_exports.string().trim().max(80),
  label: external_exports.string().trim().max(200).default(""),
  kind: external_exports.string().trim().max(60),
  resourceType: external_exports.enum(DECLARED_RESOURCE_TYPES).optional(),
  value: external_exports.string().trim().max(500),
  note: external_exports.string().trim().max(500).default("")
});
var ClaimBody = external_exports.strictObject({
  executionId: external_exports.string().trim().min(8).max(200)
});
var CompletionBody = external_exports.strictObject({
  executionId: external_exports.string().trim().min(8).max(200),
  status: external_exports.enum(["succeeded", "failed"]),
  vTo: external_exports.string().trim().max(100).nullable().optional(),
  preflight: external_exports.strictObject({
    status: external_exports.string().trim().max(40),
    checkedAt: external_exports.string().trim().max(100),
    ok: external_exports.number().int().nonnegative(),
    failed: external_exports.number().int().nonnegative(),
    unverified: external_exports.number().int().nonnegative(),
    detail: external_exports.string().trim().max(1e3).optional()
  }).nullable().optional(),
  errorSummary: external_exports.string().trim().max(1e3).nullable().optional()
});
function configurationOnlyReport(configuration) {
  const stamped = configuration.find((entry) => entry.key === "build_sha");
  return {
    checked_at: "",
    status: "unverified",
    principal: "",
    principal_resolved: false,
    table_source: "",
    build_sha: typeof stamped?.value === "string" ? stamped.value : "",
    configuration,
    checks: [lakebaseStorageCheck()],
    assumptions: [],
    counts: { ok: 0, failed: 0, unverified: 0 },
    source: "configuration"
  };
}
async function readOrchestratorReport() {
  const baked = await readBakedModelConfig();
  return {
    report: configurationOnlyReport(configurationForSettings(process.env, baked)),
    answered: false
  };
}
function setupSettingsRoutes(appkit) {
  appkit.server.extend((app) => {
    app.get("/api/deployment", async (_req, res) => {
      const facts = await readAppFacts();
      res.json({ deployedAt: facts.deployedAt, deployedBy: facts.deployedBy, buildSha: appBuildSha() });
    });
    app.get("/api/settings/agent-model", async (_req, res) => {
      res.json(await readAgentModel());
    });
    app.post("/api/settings/resource-tags", async (req, res) => {
      try {
        const { report } = await readOrchestratorReport();
        const experimentId = await resolveExperimentId(appkit);
        const summary = await applyAstrolabeTags({
          report,
          environment: {
            ...process.env,
            PLAYER_INSIGHTS_EXPERIMENT_ID: experimentId
          }
        });
        await recordAdminAction(appkit.lakebase, {
          actor: userEmail(req),
          action: "resource-tags-applied",
          subject: "system_billing=astrolabe",
          detail: summary.headline
        });
        res.json(summary);
      } catch (error) {
        console.error("[settings] Resource tags could not be applied:", error.message);
        res.status(503).json({
          error: "resource_tagging_unavailable",
          detail: "Databricks did not start the resource tag update. No viewer credential was used."
        });
      }
    });
    app.get("/api/settings", async (req, res) => {
      const { report, answered } = await readOrchestratorReport();
      const stored = await readStoredSettings(appkit);
      const environment = appEnvironment();
      const payload = settingsPayload({
        report,
        endpointAnswered: answered,
        environment,
        stored,
        appBuildSha: appBuildSha(),
        appBuildAncestors: appBuildAncestors(),
        // Asked separately, because `readStoredSettings` degrades an outage to
        // an empty map and that is indistinguishable from "nothing saved yet"
        // unless the state of the store is reported beside it. The same
        // distinction /api/storage draws, for the same reason.
        storeAvailable: await storeAnswers(appkit),
        // The app's own record: the host, the description, the compute and the
        // release. Read here rather than on its own route so the Build card
        // cannot end up describing one moment while the rows below it describe
        // another, which is the reason every other fact on this page arrives on
        // this payload too.
        app: await readAppFacts()
      });
      const states = resourceStates({ report, environment, stored });
      res.json({
        ...payload,
        checks: await readReachability(req, { report, environment, stored }),
        // Assembled here rather than inside `settingsPayload` for the reason that
        // function's own comment gives: it is pure, and both of these need a round
        // trip. The notebook read also needs the request, because it is made as the
        // signed-in user.
        notebook: await readNotebook(req, appkit, report, stored),
        connections: await readConnections(appkit, states)
      });
    });
    app.put("/api/settings/notebook-path", requireAdmin(appkit.lakebase, userEmail), async (req, res) => {
      const parsed = NotebookPathBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_notebook_path", detail: parsed.error.message });
        return;
      }
      try {
        const savedResult = await validateAndStoreNotebookPath({
          appkit,
          path: parsed.data.path,
          host: normalizeWorkspaceHost(process.env.DATABRICKS_HOST),
          token: executionToken(req) ?? "",
          updatedBy: userEmail(req)
        });
        if (!savedResult.ok) {
          res.status(savedResult.status).json({
            error: "notebook_path_not_usable",
            detail: savedResult.detail
          });
          return;
        }
        await recordAdminAction(appkit.lakebase, {
          actor: userEmail(req),
          action: "connection-setting-saved",
          subject: "notebook-path",
          detail: "Configured the workspace notebook shown on Connections."
        });
        res.json({ path: savedResult.saved.value });
      } catch (error) {
        res.status(503).json({
          error: "settings_store_unavailable",
          detail: `The notebook path was validated but not saved: ${error.message}`
        });
      }
    });
    app.post("/api/settings/connections", async (req, res) => {
      const parsed = ConnectionBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_connection_body", detail: parsed.error.message });
        return;
      }
      const fault = addFault(parsed.data);
      if (fault) {
        res.status(400).json({ error: "connection_not_allowed", detail: fault });
        return;
      }
      try {
        const existing = await readDeclaredConnections(appkit);
        const duplicate = existing.find(
          (connection2) => connection2.state === "declared" && connection2.kind === parsed.data.kind && connection2.value === parsed.data.value
        );
        if (duplicate) {
          res.status(409).json({
            error: "duplicate_connection",
            detail: "That Databricks resource is already in the connection list."
          });
          return;
        }
        const connection = await writeDeclaredConnection(appkit, {
          id: parsed.data.id,
          label: parsed.data.label,
          kind: parsed.data.kind,
          resourceType: parsed.data.resourceType,
          value: parsed.data.value,
          note: parsed.data.note,
          origin: "app",
          changedBy: userEmail(req)
        });
        res.status(201).json({
          connection,
          impact: await impactFor(appkit, connection),
          effect: addedConnectionEffect()
        });
      } catch (error) {
        console.error("[connections] The connection could not be added:", error.message);
        res.status(503).json({
          error: "settings_store_unavailable",
          detail: "The connection was not added. The app stores these in Lakebase, and it is not answering: reporting success here would leave a row on screen that no restart would keep."
        });
      }
    });
    app.get("/api/settings/connections/:id/impact", async (req, res) => {
      const connections = await readDeclaredConnections(appkit);
      const connection = connections.find((entry) => entry.id === req.params.id);
      if (!connection) {
        res.status(404).json({ error: "no_such_connection", detail: "Nothing is declared under that name." });
        return;
      }
      res.json({ impact: await impactFor(appkit, connection) });
    });
    app.delete("/api/settings/connections/:id", async (req, res) => {
      try {
        const deletedIds = await forgetDeclaredConnection(appkit, req.params.id);
        if (deletedIds.length === 0) {
          res.status(404).json({ error: "no_such_connection", detail: "Nothing is declared under that name." });
          return;
        }
        res.json({
          forgotten: { id: req.params.id },
          deletedIds,
          deletedCount: deletedIds.length,
          restorable: false
        });
      } catch (error) {
        console.error("[connections] The connection could not be deleted:", error.message);
        res.status(503).json({
          error: "settings_store_unavailable",
          detail: "The connection was not deleted. Nothing changed; retry when Lakebase is available."
        });
      }
    });
    app.post("/api/settings/connections/:id/restore", async (req, res) => {
      try {
        const restored = await restoreDeclaredConnection(appkit, req.params.id, userEmail(req));
        if (!restored) {
          res.status(404).json({
            error: "no_such_connection",
            detail: "There is no withdrawn connection under that name to put back."
          });
          return;
        }
        res.json({ connection: restored, effect: addedConnectionEffect() });
      } catch (error) {
        console.error("[connections] The connection could not be restored:", error.message);
        res.status(503).json({ error: "settings_store_unavailable", detail: "The connection was not restored." });
      }
    });
    app.delete("/api/settings/connections/:id/forever", async (req, res) => {
      try {
        const deletedIds = await forgetDeclaredConnection(appkit, req.params.id);
        if (deletedIds.length === 0) {
          res.status(404).json({
            error: "no_such_connection",
            detail: "There is no remembered connection under that name."
          });
          return;
        }
        res.json({
          forgotten: { id: req.params.id },
          deletedIds,
          deletedCount: deletedIds.length,
          restorable: false
        });
      } catch (error) {
        console.error("[connections] The connection could not be forgotten:", error.message);
        res.status(503).json({
          error: "settings_store_unavailable",
          detail: "The remembered connection was not removed. Nothing changed."
        });
      }
    });
    app.put("/api/settings/values/:resourceId", async (req, res) => {
      const parsed = WriteBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_settings_body", detail: parsed.error.message });
        return;
      }
      const { resourceId } = req.params;
      if (resourceId === "llm-gateway") {
        res.status(409).json({
          error: "atomic_gateway_selection_required",
          detail: "AI Gateway mode cannot be staged by itself. Use the Gateway connection action so the mode and foundation model are validated and recorded together."
        });
        return;
      }
      const decision = classifyWrite(resourceId, parsed.data.intent);
      if (!decision.ok) {
        res.status(409).json({ error: "not_changeable_here", detail: decision.reason });
        return;
      }
      if (!parsed.data.value) {
        res.status(400).json({
          error: "empty_value",
          detail: 'Saving an empty value would read as "configured as nothing". Delete it instead.'
        });
        return;
      }
      try {
        const saved = await writeStoredSetting(appkit, {
          resourceId,
          value: parsed.data.value,
          intent: decision.intent,
          note: parsed.data.note,
          updatedBy: userEmail(req)
        });
        await recordAdminAction(appkit.lakebase, {
          actor: userEmail(req),
          action: "connection-setting-saved",
          subject: resourceId,
          detail: `${decision.intent} value recorded for ${resourceId}`
        });
        res.json({
          saved,
          appliesNow: decision.intent === "active"
        });
      } catch (error) {
        console.error(`[settings] ${resourceId} could not be saved:`, error.message);
        res.status(503).json({
          error: "settings_store_unavailable",
          detail: "The value was not saved. The app stores settings in Lakebase, and it is not answering: reporting success here would leave a value on screen that no restart would keep."
        });
      }
    });
    app.delete("/api/settings/values/:resourceId", async (req, res) => {
      try {
        const removed = await clearStoredSetting(appkit, req.params.resourceId);
        if (!removed) {
          res.status(404).json({ error: "no_such_setting", detail: "Nothing was stored for that resource." });
          return;
        }
        await recordAdminAction(appkit.lakebase, {
          actor: userEmail(req),
          action: "connection-setting-cleared",
          subject: req.params.resourceId,
          detail: `cleared stored setting for ${req.params.resourceId}`
        });
        res.json({ cleared: req.params.resourceId });
      } catch (error) {
        console.error(`[settings] ${req.params.resourceId} could not be cleared:`, error.message);
        res.status(503).json({ error: "settings_store_unavailable", detail: "The value was not cleared." });
      }
    });
    app.get("/api/settings/apply", async (req, res) => {
      res.json(await buildApplyResponse(req, appkit));
    });
    app.post("/api/admin/model-releases", async (req, res) => {
      try {
        const current = await buildApplyResponse(req, appkit);
        if (!current.plan.hasOverrides) {
          res.status(409).json({
            error: "nothing_to_release",
            detail: "Nothing is waiting on a new model version."
          });
          return;
        }
        if (!current.target || current.target.startsWith("<")) {
          res.status(409).json({
            error: "release_target_unavailable",
            detail: "This app was not released with its bundle target recorded. Redeploy the app before approving a notebook release."
          });
          return;
        }
        const declaration = releaseDeclaration(current.plan);
        const release = await createModelRelease(appkit, {
          id: randomUUID(),
          requestedBy: userEmail(req),
          declaration,
          target: current.target,
          endpointName: textEnv(process.env.DATABRICKS_SERVING_ENDPOINT_NAME),
          modelName: current.modelName,
          vFrom: current.vFrom,
          preflightAtRequest: current.preflight
        });
        res.status(201).json({ release });
      } catch (error) {
        console.error("[model-release] The approval could not be recorded:", error.message);
        res.status(503).json({
          error: "release_store_unavailable",
          detail: "The release request was not recorded. Lakebase did not accept the audit row."
        });
      }
    });
    app.get("/api/admin/model-releases", async (req, res) => {
      const requested = Number(req.query.limit ?? 20);
      const releases = await listModelReleases(appkit, Number.isFinite(requested) ? requested : 20);
      res.json({ releases });
    });
    app.get("/api/admin/model-releases/:id", async (req, res) => {
      const release = await readModelRelease(appkit, req.params.id);
      if (!release) {
        res.status(404).json({ error: "no_such_release_request" });
        return;
      }
      res.json({ release });
    });
    app.post("/api/admin/model-releases/:id/claim", async (req, res) => {
      const parsed = ClaimBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_claim", detail: parsed.error.message });
        return;
      }
      const result = await claimModelRelease(appkit, req.params.id, parsed.data.executionId, userEmail(req));
      if (!result.release) {
        res.status(404).json({ error: "no_such_release_request" });
        return;
      }
      if (!result.claimed) {
        res.status(409).json({
          error: "release_request_already_claimed",
          detail: "Another helper already claimed this request, or it is already complete.",
          release: result.release
        });
        return;
      }
      res.json({ release: result.release });
    });
    app.post("/api/admin/model-releases/:id/status", async (req, res) => {
      const parsed = CompletionBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_release_status", detail: parsed.error.message });
        return;
      }
      const result = await completeModelRelease(appkit, req.params.id, userEmail(req), parsed.data);
      if (!result.release) {
        res.status(404).json({ error: "no_such_release_request" });
        return;
      }
      if (!result.updated) {
        res.status(409).json({
          error: "invalid_release_transition",
          detail: "Only the helper that claimed a running request may complete it.",
          release: result.release
        });
        return;
      }
      res.json({ release: result.release });
    });
  });
}
async function buildApplyResponse(req, appkit) {
  const { report, answered } = await readOrchestratorReport();
  const stored = await readStoredSettings(appkit);
  const environment = appEnvironment();
  const payload = settingsPayload({
    report,
    endpointAnswered: answered,
    environment,
    stored,
    appBuildSha: appBuildSha(),
    appBuildAncestors: appBuildAncestors(),
    storeAvailable: await storeAnswers(appkit),
    app: await readAppFacts()
  });
  const notebookPanel = await readNotebook(req, appkit, report, stored);
  const intended = intendedFromResources(payload.resources);
  const notebook = settingsFromDeclaration(notebookPanel.read.declaration);
  const target = textEnv(process.env.PLAYER_INSIGHTS_TARGET) || textEnv(process.env.DATABRICKS_BUNDLE_TARGET) || "<your-target>";
  const plan = resolveApplyPlan({ intended, notebook, target });
  const live = liveConfiguration(report);
  const vFrom = live.model_version || null;
  return {
    status: plan.hasOverrides ? "ready" : "idle",
    plan,
    target,
    vFrom,
    modelName: live.model_name || textEnv(process.env.PLAYER_INSIGHTS_MODEL_NAME),
    preflight: releasePreflight(report)
  };
}
function releasePreflight(report) {
  if (!report) return null;
  return {
    status: report.status,
    checkedAt: report.checked_at,
    ok: report.counts.ok,
    failed: report.counts.failed,
    unverified: report.counts.unverified
  };
}
function canonicalSettings(settings) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(settings).sort(([left], [right]) => left.localeCompare(right)))
  );
}
function releaseDeclaration(plan) {
  const settings = Object.fromEntries(plan.knobs.map((knob) => [knob.key, knob.value]));
  const body = `connections-apply
${canonicalSettings(settings)}`;
  return {
    source: "connections-apply",
    revision: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    settings
  };
}
function textEnv(value) {
  return (value ?? "").trim();
}
function configuredNotebookPath(stored, environment = process.env) {
  const saved = stored.get("notebook-path");
  if (saved?.intent === "active" && saved.value.trim()) return saved.value.trim();
  return environment.PLAYER_INSIGHTS_NOTEBOOK_PATH?.trim() ?? "";
}
function liveConfiguration(report) {
  const live = {};
  for (const entry of report?.configuration ?? []) {
    const key = String(entry.key ?? "");
    if (!key) continue;
    const value = entry.value;
    if (typeof value === "string") live[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") live[key] = String(value);
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      live[key] = value.join(",");
    }
  }
  return live;
}
async function readNotebook(req, appkit, report, storedInput) {
  try {
    const stored = storedInput ?? await readStoredSettings(appkit);
    const configuredPath = configuredNotebookPath(stored);
    const location = await resolveNotebookDeclaration(appkit);
    const read = await readPublishedDeclaration({
      location,
      // The APP's own warehouse, which is what app.yaml binds. The orchestrator's
      // is in the model artifact and is not the app's to run statements on.
      warehouseId: process.env.DATABRICKS_SQL_WAREHOUSE_ID?.trim() ?? "",
      host: normalizeWorkspaceHost(process.env.DATABRICKS_HOST),
      // Absent reads as "nobody to read as", which the reader is told. It is never
      // replaced by the app's own credential.
      token: executionToken(req) ?? ""
    });
    return {
      location,
      configuredPath,
      observedPath: read.declaration?.source?.trim() ?? "",
      read,
      comparison: read.declaration ? compareDeclaration(read.declaration, liveConfiguration(report)) : []
    };
  } catch (error) {
    console.warn("[settings] The notebook declaration could not be read:", error.message);
    return {
      location: "",
      configuredPath: "",
      observedPath: "",
      read: {
        declaration: null,
        failure: "unavailable",
        detail: "The published declaration could not be read just now."
      },
      comparison: []
    };
  }
}
function configuredValues(states) {
  const values = [];
  for (const state of states) {
    if (state.configured) values.push(state.configured);
    if (state.actual) values.push(state.actual);
  }
  return values;
}
async function impactFor(appkit, connection) {
  const { report } = await readOrchestratorReport();
  const stored = await readStoredSettings(appkit);
  const states = resourceStates({ report, environment: appEnvironment(), stored });
  return removalImpact(connection, configuredValues(states));
}
async function readConnections(appkit, states) {
  const live = configuredValues(states);
  const connections = await readDeclaredConnections(appkit);
  return connections.map((connection) => ({
    connection,
    impact: removalImpact(connection, live)
  }));
}
function completeReachabilityTables(configured, discovered) {
  return unionTableNames(configured, discovered);
}
async function readReachability(req, input) {
  try {
    const configured = Object.fromEntries(resourceStates(input).map((state) => [state.resource.id, state.configured]));
    const configuration = input.report?.configuration ?? [];
    let tables = [
      ...accessDependenciesFrom({
        configuration,
        env: process.env
      }).tables
    ];
    const catalog = configured.catalog ?? "";
    const schema = configured.schema ?? "";
    const manifest = configuration.find((entry) => entry.key === "declared_manifest");
    if (manifest?.source === "data-contract" || isDataContractFallback(tables, catalog, schema)) {
      const denylistEntry = configuration.find((entry) => entry.key === "catalog_denylist");
      const denylist = Array.isArray(denylistEntry?.value) ? denylistEntry.value.map((item) => String(item).trim()).filter(Boolean) : typeof denylistEntry?.value === "string" ? denylistEntry.value.split(",").map((item) => item.trim()).filter(Boolean) : [];
      const listed = await listDeclarableTablesInSchema({
        catalog,
        schema,
        host: normalizeWorkspaceHost(process.env.DATABRICKS_HOST),
        token: executionToken(req) ?? "",
        denylist
      });
      tables = completeReachabilityTables(tables, listed);
    }
    const checks = await probeConnections({
      configured,
      tables,
      host: normalizeWorkspaceHost(process.env.DATABRICKS_HOST),
      token: executionToken(req),
      principal: req.header("x-forwarded-email")?.trim() ?? ""
    });
    const experiment = await checkExperimentAsApp(configured["experiment-id"] ?? "");
    return experiment ? [...checks, experiment] : checks;
  } catch (error) {
    console.warn("[settings] The dependency probes could not be run:", error.message);
    return [];
  }
}
async function storeAnswers(appkit) {
  try {
    await appkit.lakebase.query(`SELECT 1 FROM ${APP_SCHEMA}.deployment_settings LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

export {
  resourceTagInventory,
  readAppBillingTag,
  isDataContractFallback,
  unionTableNames,
  listDeclarableTablesInSchema,
  readModelRelease,
  validateAndStoreNotebookPath,
  readOrchestratorReport,
  setupSettingsRoutes,
  releaseDeclaration,
  configuredNotebookPath,
  liveConfiguration,
  completeReachabilityTables
};
