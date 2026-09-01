
import {
  isDataContractFallback,
  listDeclarableTablesInSchema,
  readAppBillingTag,
  readOrchestratorReport,
  resourceTagInventory,
  unionTableNames
} from "./chunk-R4UE773J.mjs";
import "./chunk-53IJM3OV.mjs";
import {
  ANSWER_PATH_ENDPOINT_IDS,
  SERVING_ENDPOINT_KIND,
  probeConnections
} from "./chunk-V4SC7MBY.mjs";
import {
  resolveSemanticIndexValue
} from "./chunk-MTXPHPGN.mjs";
import {
  ACTIVE_MINUTES_PER_DAY_QUERY,
  LEGACY_TRAFFIC_BREAKDOWNS_QUERY,
  RAW_TRAFFIC_BREAKDOWNS_QUERY,
  REQUEST_LATENCY_QUERY,
  REQUEST_LATENCY_TABLE,
  TRAFFIC_BREAKDOWNS_QUERY,
  USER_ACTIVE_MINUTES_QUERY,
  USER_SPEND_RUNS_QUERY,
  attributableCostBudgets,
  buildSpendByUser,
  buildTelemetryStatement,
  cacheUserSpend,
  cachedUserSpend,
  capUserSpendRange,
  grantFor,
  hasHistory,
  logsTable,
  noHistoryReason,
  offMeasurement,
  opsDayRange,
  readCostBudgets,
  readRequestLatencyRows,
  readRuntimeSettings,
  readTelemetryRows,
  readTrafficBreakdowns,
  readUserActivitySpendEvidence,
  readUserRunSpendEvidence,
  stateFromFailure,
  telemetrySchema,
  uncheckedMeasurement,
  userEmail,
  userSpendCacheKey,
  validIanaTimeZone
} from "./chunk-VCNZS6CN.mjs";
import {
  UNKNOWN_PRINCIPAL,
  accessDependenciesFrom,
  classifyDenial,
  executionToken,
  sqlQueryTags
} from "./chunk-AN25GJD4.mjs";
import "./chunk-2E2CT3F3.mjs";
import {
  appEnvironment,
  readStoredSettings,
  resourceStates
} from "./chunk-IE53KQ3R.mjs";
import {
  normalizeWorkspaceHost,
  workspaceAppsUrl
} from "./chunk-VHHJDNLO.mjs";
import "./chunk-6FU36DZD.mjs";
import "./chunk-FHPVN4JA.mjs";
import {
  EMPTY_WAREHOUSE_QUERY_ATTRIBUTION,
  buildCostStatement,
  buildCoverage,
  buildHonesty,
  buildQuestionAttribution,
  buildTiles,
  createWorkspaceQueryHistoryTransport,
  readComponentRows,
  readResourceActivityRows,
  readWarehouseQueryAttribution,
  splitBillingRows,
  vectorIndexName
} from "./chunk-2REC7TER.mjs";
import "./chunk-ANRI5RX5.mjs";
import "./chunk-TVVFHZMK.mjs";
import {
  APP_SCHEMA
} from "./chunk-7DTM6FIL.mjs";
import "./chunk-LLUDDZ3A.mjs";

// server/routes/ops-routes.ts
var STATEMENT_TIMEOUT_MS = 45e3;
function queryText(req, name) {
  const value = req.query[name];
  return typeof value === "string" ? value.trim() : "";
}
function text(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return "";
}
function count(value) {
  const parsed = typeof value === "number" ? value : Number(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}
var ORG_ID_HEADER = "x-databricks-org-id";
var knownWorkspaceId = "";
function noteWorkspaceId(response) {
  if (knownWorkspaceId) return;
  const seen = response.headers.get(ORG_ID_HEADER)?.trim();
  if (seen) knownWorkspaceId = seen;
}
async function resolveWorkspaceId(input) {
  if (knownWorkspaceId) return knownWorkspaceId;
  if (!input.host || !input.token) return "";
  const call = input.fetchImpl ?? fetch;
  try {
    const response = await call(`${input.host}/api/2.0/preview/scim/v2/Me`, {
      headers: { authorization: `Bearer ${input.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(1e4)
    });
    noteWorkspaceId(response);
  } catch (error) {
    console.warn(
      `[ops] The workspace id could not be resolved (${error.message}), so Genie spend cannot be narrowed to this workspace and its tile says so rather than showing a figure.`
    );
  }
  return knownWorkspaceId;
}
function forgetWorkspaceId() {
  knownWorkspaceId = "";
}
async function lookupVectorConnection(input) {
  const configuredEndpoint = input.configuredEndpoint?.trim() ?? "";
  if (!input.index) return { endpoint: configuredEndpoint, endpointIndexCount: null, reason: "No active index name." };
  if (!input.host) {
    return { endpoint: configuredEndpoint, endpointIndexCount: null, reason: "No workspace address is configured." };
  }
  if (!input.token) {
    return {
      endpoint: configuredEndpoint,
      endpointIndexCount: null,
      reason: "No forwarded sign-in was available to verify the active Vector Search index."
    };
  }
  const call = input.fetchImpl ?? fetch;
  try {
    const response = await call(`${input.host}/api/2.0/vector-search/indexes/${encodeURIComponent(input.index)}`, {
      headers: { authorization: `Bearer ${input.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(1e4)
    });
    if (!response.ok) {
      return {
        endpoint: configuredEndpoint,
        endpointIndexCount: null,
        reason: `The active Vector Search index metadata read returned HTTP ${response.status}.`
      };
    }
    const body = await response.json();
    const endpoint = typeof body.endpoint_name === "string" ? body.endpoint_name.trim() : "";
    if (!endpoint) {
      return { endpoint: configuredEndpoint, endpointIndexCount: null, reason: "The active index named no endpoint." };
    }
    if (configuredEndpoint && configuredEndpoint !== endpoint) {
      return {
        endpoint,
        endpointIndexCount: null,
        reason: "The released endpoint name disagrees with the endpoint reported by the active index."
      };
    }
    const endpointResponse = await call(
      `${input.host}/api/2.0/vector-search/endpoints/${encodeURIComponent(endpoint)}`,
      {
        headers: { authorization: `Bearer ${input.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(1e4)
      }
    );
    if (!endpointResponse.ok) {
      return {
        endpoint,
        endpointIndexCount: null,
        reason: `The hosting Vector Search endpoint metadata read returned HTTP ${endpointResponse.status}.`
      };
    }
    const endpointBody = await endpointResponse.json();
    const parsedCount = Number(endpointBody.num_indexes);
    const endpointIndexCount = Number.isInteger(parsedCount) && parsedCount >= 0 ? parsedCount : null;
    return {
      endpoint,
      endpointIndexCount,
      reason: endpointIndexCount === null ? "The hosting endpoint response carried no usable index count." : ""
    };
  } catch (error) {
    return {
      endpoint: configuredEndpoint,
      endpointIndexCount: null,
      reason: `Vector Search connection metadata could not be read: ${error.message}`
    };
  }
}
function shownConnectionValue(state) {
  return (state.actualObserved ? state.actual : state.configured || state.actual).trim();
}
function configuredResourceName(value, keys) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value;
  for (const key of keys) {
    const candidate = text(record[key]).trim();
    if (candidate) return candidate;
  }
  return "";
}
async function costIdentifiersFor(appkit, req, extras) {
  const appName = (process.env.DATABRICKS_APP_NAME ?? "").trim();
  const [{ report }, stored, appBillingTag] = await Promise.all([
    (extras.readReport ?? readOrchestratorReport)(),
    readStoredSettings(appkit).catch(() => /* @__PURE__ */ new Map()),
    (extras.readAppBillingTag ?? readAppBillingTag)(appName)
  ]);
  const states = resourceStates({ report, environment: appEnvironment(), stored });
  const configured = Object.fromEntries(states.map((state) => [state.resource.id, shownConnectionValue(state)]));
  const configuration = [...report?.configuration ?? []];
  for (const [key, value] of [
    ["data_genie_space_id", configured["genie-data"]],
    ["dictionary_genie_space_id", configured["genie-dictionary"]]
  ]) {
    if (!value || configuration.some((entry) => entry.key === key)) continue;
    configuration.push({
      key,
      value,
      env_var: "",
      source: "connections",
      mutability: "",
      baked: false,
      required: false
    });
  }
  const configuredGenie = accessDependenciesFrom({ configuration, env: process.env }).genieSpaces;
  const dataGenie = configuredGenie.find((space) => space.role === "Data Genie space");
  const dictionaryGenie = configuredGenie.find((space) => space.role === "Dictionary Genie space");
  const semanticEntry = report?.configuration.find((entry) => entry.key === "semantic_index");
  const semanticCheck = report?.checks.find((check) => check.id === "semantic-index");
  const endpointCheck = report?.checks.find((check) => check.id === "semantic-index-endpoint");
  const semanticValue = text(configured["semantic-index"]) || configuredResourceName(semanticEntry?.value, ["index_name", "full_name", "name", "value"]) || text(semanticEntry?.value);
  const vectorIndex = vectorIndexName(
    resolveSemanticIndexValue(semanticValue, text(configured.catalog), text(configured.schema)) || semanticCheck?.name || (process.env.PLAYER_INSIGHTS_SEMANTIC_INDEX ?? "")
  );
  const configuredVectorEndpoint = endpointCheck?.name || configuredResourceName(semanticEntry?.value, ["endpoint_name", "endpoint"]) || configured["semantic-index-endpoint"];
  const vectorConnection = vectorIndex ? await lookupVectorConnection({
    host: host(),
    token: executionToken(req) ?? "",
    index: vectorIndex,
    configuredEndpoint: configuredVectorEndpoint,
    fetchImpl: extras.fetchImpl
  }) : {
    endpoint: configuredVectorEndpoint,
    endpointIndexCount: null,
    reason: "The active Vector Search index was not present in release configuration."
  };
  return {
    report,
    ids: {
      appName,
      endpointName: (process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? "").trim(),
      warehouseId: extras.warehouse,
      vectorEndpoint: vectorConnection.endpoint,
      vectorIndex,
      vectorEndpointIndexCount: vectorConnection.endpointIndexCount,
      vectorIdentityError: vectorConnection.reason,
      genieSpaces: [
        {
          id: dataGenie?.id || "",
          label: "Data Genie",
          tool: "data_genie",
          tileId: "genie:data"
        },
        {
          id: dictionaryGenie?.id || "",
          label: "Dictionary Genie",
          tool: "dictionary_genie",
          tileId: "genie:dictionary"
        }
      ],
      workspaceId: extras.workspaceId,
      telemetryEnabled: Boolean(telemetrySchema()),
      appBillingTag
    }
  };
}
async function runStatement(input) {
  const call = input.fetchImpl ?? fetch;
  let response;
  try {
    response = await call(`${input.host}/api/2.0/sql/statements`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        warehouse_id: input.warehouseId,
        statement: input.statement,
        query_tags: sqlQueryTags({
          surface: "ops",
          tool: "ops_query",
          operation: "diagnostics"
        }),
        ...input.parameters?.length ? { parameters: input.parameters } : {},
        wait_timeout: "30s",
        on_wait_timeout: "CANCEL",
        format: "JSON_ARRAY",
        disposition: "INLINE"
      }),
      signal: AbortSignal.timeout(STATEMENT_TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return {
      ok: false,
      rows: null,
      message: timedOut ? `The SQL warehouse did not answer within ${STATEMENT_TIMEOUT_MS} ms, so nothing was read.` : `The SQL warehouse could not be reached: ${error.message}`
    };
  }
  noteWorkspaceId(response);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      rows: null,
      status: response.status,
      message: text(body.message) || `Databricks answered HTTP ${response.status} with no message body.`
    };
  }
  const state = text(body.status?.state);
  if (state !== "SUCCEEDED") {
    return {
      ok: false,
      rows: null,
      message: text(body.status?.error?.message) || `The statement ended in ${state || "an unknown state"}.`
    };
  }
  return { ok: true, rows: body.result?.data_array ?? [], message: "" };
}
function host() {
  return normalizeWorkspaceHost(process.env.DATABRICKS_HOST);
}
function warehouseId() {
  return (process.env.DATABRICKS_SQL_WAREHOUSE_ID ?? "").trim();
}
function billingGrant(principal) {
  const usage = grantFor("system.billing.usage", principal);
  const prices = grantFor("system.billing.list_prices", principal);
  return {
    object: "system.billing",
    privilege: "SELECT",
    statement: `${usage.statement}
${prices.statement}`
  };
}
function resultFor(status) {
  if (status === "ok") return "answered";
  if (status === "failed") return "did-not-answer";
  return "not-checked";
}
function servingEndpointReading(rows) {
  const endpoints = rows.filter(
    (row) => row.kind === SERVING_ENDPOINT_KIND && ANSWER_PATH_ENDPOINT_IDS.includes(row.id)
  );
  const endpointRows = endpoints.map((row) => row.id);
  if (endpoints.some((row) => row.result === "did-not-answer")) {
    return { endpointState: "Did not answer", endpointRead: true, endpointRows };
  }
  if (endpoints.some((row) => row.result === "answered")) {
    return { endpointState: "Ready", endpointRead: true, endpointRows };
  }
  return { endpointState: "", endpointRead: false, endpointRows };
}
async function lakebaseReading(appkit) {
  const base = {
    id: "lakebase",
    label: "Lakebase",
    read: true,
    rows: []
  };
  try {
    await appkit.lakebase.query(`SELECT 1 FROM ${APP_SCHEMA}.deployment_settings LIMIT 1`);
    return { ...base, state: "Connected", reason: "" };
  } catch (error) {
    return { ...base, state: "Not answering", reason: error.message };
  }
}
function platformReadings(input, extra = []) {
  return [
    {
      id: "endpoint",
      label: "Serving endpoint",
      state: input.endpointRead ? input.endpointState : "",
      read: input.endpointRead,
      rows: [...input.endpointRows ?? []],
      reason: ""
    },
    // No rows: the app is not one of the dependencies this deployment probes, so
    // the table gives this reading a line of its own rather than leaving the one
    // resource every reader is standing in off the list.
    { id: "app", label: "App", state: "Running", read: true, rows: [], reason: "" },
    ...extra
  ];
}
async function readAppMeasurement(req, insightsHref) {
  const schema = telemetrySchema();
  if (!schema) return offMeasurement(insightsHref);
  const table = logsTable(schema);
  const base = offMeasurement(insightsHref);
  const workspace = host();
  const warehouse = warehouseId();
  const token = executionToken(req);
  const principal = userEmail(req) || UNKNOWN_PRINCIPAL;
  if (!workspace || !warehouse || !token) {
    return uncheckedMeasurement(
      insightsHref,
      "this app has no warehouse, workspace address or forwarded sign-in to read it with."
    );
  }
  const outcome = await runStatement({
    host: workspace,
    token,
    warehouseId: warehouse,
    statement: buildTelemetryStatement(table),
    parameters: []
  });
  if (!outcome.ok) {
    const classified = stateFromFailure(outcome.message, table);
    if (classified.state === "no-grant") {
      return {
        ...base,
        telemetry: "no-grant",
        table,
        grant: grantFor(classified.object, principal, classified.permission),
        reason: `App telemetry is switched on and writing to ${table}, and you do not have ${classified.permission} on ${classified.object}. Every admin needs their own grant; being an administrator of this app does not grant it. Run the statement below, or ask whoever owns that schema to.`
      };
    }
    return {
      ...base,
      telemetry: "unreadable",
      table,
      reason: `${table} could not be read, so nothing about what this app served was established. Databricks said: ${outcome.message}`
    };
  }
  const figures = readTelemetryRows(outcome.rows);
  if (!hasHistory(figures)) {
    return {
      ...base,
      ...figures,
      telemetry: "no-rows-yet",
      table,
      reason: noHistoryReason()
    };
  }
  return { ...base, ...figures, telemetry: "reading", table, reason: "" };
}
async function readDependencies(appkit, req, fetchImpl) {
  try {
    const [{ report }, stored] = await Promise.all([
      readOrchestratorReport(),
      readStoredSettings(appkit).catch(() => /* @__PURE__ */ new Map())
    ]);
    const states = resourceStates({ report, environment: appEnvironment(), stored });
    const configured = Object.fromEntries(states.map((state) => [state.resource.id, state.configured]));
    const configuration = report?.configuration ?? [];
    let tables = accessDependenciesFrom({ configuration, env: process.env }).tables;
    const catalog = configured.catalog ?? "";
    const schema = configured.schema ?? "";
    const manifest = configuration.find((entry) => entry.key === "declared_manifest");
    if (manifest?.source === "data-contract" || isDataContractFallback(tables, catalog, schema)) {
      const denylistEntry = configuration.find((entry) => entry.key === "catalog_denylist");
      const denylist = Array.isArray(denylistEntry?.value) ? denylistEntry.value.map((item) => String(item).trim()).filter(Boolean) : typeof denylistEntry?.value === "string" ? denylistEntry.value.split(",").map((item) => item.trim()).filter(Boolean) : [];
      const listed = await listDeclarableTablesInSchema({
        catalog,
        schema,
        host: host(),
        token: executionToken(req) ?? "",
        denylist,
        fetchImpl
      });
      if (listed.length > tables.length) tables = unionTableNames(tables, listed);
    }
    const checks = await probeConnections({
      configured,
      tables,
      host: host(),
      token: executionToken(req),
      principal: userEmail(req) || ""
    });
    const checkedAt = (/* @__PURE__ */ new Date()).toISOString();
    const documented = new Set(states.map((state) => state.resource.id));
    return {
      checkedAt,
      reason: "",
      rows: checks.map((check) => ({
        id: check.id,
        // The probe's own kind, carried so the platform pills can resolve
        // themselves by what a probe IS rather than by one of its ids.
        kind: check.kind,
        connectionsId: documented.has(check.id) ? check.id : "",
        label: check.label,
        name: check.name,
        result: resultFor(check.status),
        lastCheckedAt: check.status === "unverified" ? "" : checkedAt,
        // The probe's own words, not a restatement. A reason rewritten here is a
        // reason that drifts from the one Connections shows for the same probe.
        reason: check.status === "ok" ? "" : check.detail || check.error || ""
      }))
    };
  } catch (error) {
    return {
      rows: [],
      checkedAt: "",
      reason: `The dependency probes could not be run, so nothing was checked: ${error.message}`
    };
  }
}
var QUESTIONS_PER_DAY_QUERY = `
  SELECT to_char(date_trunc('day', m.created_at AT TIME ZONE $1), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
  FROM ${APP_SCHEMA}.messages m
  WHERE m.role = 'user'
    AND m.created_at >= ($2::date::timestamp AT TIME ZONE $1)
    AND m.created_at < (($3::date + 1)::timestamp AT TIME ZONE $1)
  GROUP BY 1
  ORDER BY 1`;
var DISTINCT_ASKERS_PER_DAY_QUERY = `
  SELECT to_char(date_trunc('day', m.created_at AT TIME ZONE $1), 'YYYY-MM-DD') AS day,
         COUNT(DISTINCT lower(c.user_email))::int AS count
  FROM ${APP_SCHEMA}.messages m
  JOIN ${APP_SCHEMA}.conversations c ON c.id = m.conversation_id
  WHERE m.role = 'user'
    AND m.created_at >= ($2::date::timestamp AT TIME ZONE $1)
    AND m.created_at < (($3::date + 1)::timestamp AT TIME ZONE $1)
  GROUP BY 1
  ORDER BY 1`;
function unreadNote(charts, message) {
  const named = charts.length === 1 ? charts[0] : `${charts.slice(0, -1).join(", ")} and ${charts[charts.length - 1]}`;
  const which = charts.length === 1 ? "that chart is" : "those charts are";
  return `${named} could not be read, so ${which} missing rather than empty: ${message || "the store did not answer"}`;
}
var RUN_OUTCOMES_QUERY = TRAFFIC_BREAKDOWNS_QUERY;
var TOOL_CALLS_QUERY = TRAFFIC_BREAKDOWNS_QUERY;
async function trafficBreakdownsFor(appkit, parameters) {
  try {
    const result = await appkit.lakebase.query(TRAFFIC_BREAKDOWNS_QUERY, parameters);
    return readTrafficBreakdowns(result.rows);
  } catch (rollupError) {
    try {
      const result = await appkit.lakebase.query(RAW_TRAFFIC_BREAKDOWNS_QUERY, parameters);
      return readTrafficBreakdowns(result.rows);
    } catch (durableError) {
      try {
        const result = await appkit.lakebase.query(LEGACY_TRAFFIC_BREAKDOWNS_QUERY, parameters);
        return readTrafficBreakdowns(result.rows, {
          state: "partial",
          reason: `Durable run/stage evidence was unavailable, so only historical stored answers were counted: ${durableError.message}`
        });
      } catch (legacyError) {
        throw new Error(
          `Rollup read failed (${rollupError.message}); raw durable read failed (${durableError.message}); historical answer read failed (${legacyError.message}).`
        );
      }
    }
  }
}
var QUESTION_COST_RUNS_QUERY = `
  WITH completed AS (
    SELECT r.run_id, COALESCE(r.correlation_id, '') AS correlation_id,
           COALESCE(r.trace_id, '') AS trace_id, r.completed_at,
           CASE
             WHEN COALESCE(m.response_json->'trace'->>'total_tokens', '') ~ '^[0-9]+$'
               THEN (m.response_json->'trace'->>'total_tokens')::bigint
             WHEN COALESCE(m.response_json->'trace'->>'prompt_tokens', '') ~ '^[0-9]+$'
              AND COALESCE(m.response_json->'trace'->>'completion_tokens', '') ~ '^[0-9]+$'
               THEN (m.response_json->'trace'->>'prompt_tokens')::bigint
                  + (m.response_json->'trace'->>'completion_tokens')::bigint
             ELSE NULL
           END AS total_tokens
    FROM ${APP_SCHEMA}.runs r
    LEFT JOIN ${APP_SCHEMA}.messages m ON m.id = r.terminal_message_id
    WHERE r.completed_at >= $1::date
      AND r.completed_at < ($2::date + INTERVAL '1 day')
  ),
  counted AS (
    SELECT *,
           COUNT(*) OVER ()::int AS runs_in_range,
           COUNT(*) FILTER (WHERE total_tokens IS NOT NULL AND total_tokens > 0) OVER ()::int AS token_covered_runs,
           COALESCE(SUM(total_tokens) FILTER (WHERE total_tokens IS NOT NULL AND total_tokens > 0) OVER (), 0)::bigint AS total_recorded_tokens
    FROM completed
  )
  SELECT run_id, correlation_id, trace_id, completed_at, total_tokens,
         runs_in_range, token_covered_runs, total_recorded_tokens
  FROM counted
  ORDER BY completed_at DESC
  LIMIT 100`;
var QUESTION_COST_LIMIT = 100;
var RESOURCE_ACTIVITY_QUERY = `
  WITH completed AS (
    SELECT m.response_json->'trace' AS trace
    FROM ${APP_SCHEMA}.runs r
    JOIN ${APP_SCHEMA}.messages m ON m.id = r.terminal_message_id
    WHERE r.completed_at >= $1::date
      AND r.completed_at < ($2::date + INTERVAL '1 day')
      AND jsonb_typeof(m.response_json->'trace') = 'object'
  ),
  configured(tile_id, tool, resource_id) AS (
    VALUES
      ('genie:data', 'data_genie', $3::text),
      ('genie:dictionary', 'dictionary_genie', $4::text),
      ('vector-search', 'search_semantics', $5::text)
  ),
  observed AS (
    SELECT CASE
             WHEN stage->>'id' ~ '(^|-)dictionary_genie$' THEN 'dictionary_genie'
             WHEN stage->>'id' ~ '(^|-)data_genie$' THEN 'data_genie'
             WHEN stage->>'id' ~ '(^|-)search_semantics$' THEN 'search_semantics'
           END AS tool,
           SUM(CASE WHEN COALESCE(stage->>'calls', '') ~ '^[0-9]+$'
                    THEN (stage->>'calls')::bigint ELSE 1 END)::bigint AS calls
    FROM completed,
         LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(trace->'stages') = 'array'
                THEN trace->'stages' ELSE '[]'::jsonb END
         ) AS stage
    WHERE stage->>'id' ~ '(^|-)(data_genie|dictionary_genie|search_semantics)$'
    GROUP BY 1
  ),
  attributed AS (
    SELECT resource->>'tool' AS tool,
           resource->>'id' AS resource_id,
           SUM(CASE WHEN COALESCE(resource->>'calls', '') ~ '^[0-9]+$'
                    THEN (resource->>'calls')::bigint ELSE 0 END)::bigint AS calls
    FROM completed,
         LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(trace->'resource_calls') = 'array'
                THEN trace->'resource_calls' ELSE '[]'::jsonb END
         ) AS resource
    WHERE resource->>'tool' IN ('data_genie', 'dictionary_genie', 'search_semantics')
    GROUP BY 1, 2
  ),
  legacy_genie AS (
    SELECT c.tile_id, COUNT(*)::bigint AS calls
    FROM completed
    JOIN configured c ON c.tool IN ('data_genie', 'dictionary_genie')
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(trace->'genie_spaces') = 'array'
             THEN trace->'genie_spaces' ELSE '[]'::jsonb END
      ) AS space
      WHERE space->>'id' = c.resource_id
    )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(trace->'resource_calls') = 'array'
               THEN trace->'resource_calls' ELSE '[]'::jsonb END
        ) AS resource
        WHERE resource->>'tool' = c.tool
          AND resource->>'id' = c.resource_id
      )
    GROUP BY c.tile_id
  )
  SELECT c.tile_id,
         (COALESCE(a.calls, 0) + COALESCE(l.calls, 0))::bigint AS astrolabe_calls,
         GREATEST(
           COALESCE(o.calls, 0),
           COALESCE(a.calls, 0) + COALESCE(l.calls, 0)
         )::bigint AS observed_calls
  FROM configured c
  LEFT JOIN attributed a ON a.tool = c.tool AND a.resource_id = c.resource_id
  LEFT JOIN legacy_genie l ON l.tile_id = c.tile_id
  LEFT JOIN observed o ON o.tool = c.tool
  ORDER BY c.tile_id`;
async function resourceActivityAttribution(appkit, ids, range) {
  try {
    const result = await appkit.lakebase.query(RESOURCE_ACTIVITY_QUERY, [
      range.from,
      range.to,
      ids.genieSpaces.find((space) => space.tileId === "genie:data")?.id ?? "",
      ids.genieSpaces.find((space) => space.tileId === "genie:dictionary")?.id ?? "",
      ids.vectorIndex
    ]);
    return readResourceActivityRows(result.rows);
  } catch (error) {
    console.warn(`[ops] Resource-scoped usage counts could not be read: ${error.message}`);
    return [];
  }
}
function questionRun(row) {
  const nullableNumber = (value) => {
    const parsed = Number(text(value));
    return text(value) !== "" && Number.isFinite(parsed) ? parsed : null;
  };
  return {
    runId: text(row.run_id),
    correlationId: text(row.correlation_id),
    traceId: text(row.trace_id),
    completedAt: text(row.completed_at),
    totalTokens: nullableNumber(row.total_tokens),
    runsInRange: count(row.runs_in_range),
    tokenCoveredRuns: count(row.token_covered_runs),
    totalRecordedTokens: count(row.total_recorded_tokens)
  };
}
function lagDays(rangeEnd, newestBillingDay) {
  const end = Date.parse(`${rangeEnd}T00:00:00Z`);
  const newest = Date.parse(`${newestBillingDay}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(newest)) return null;
  return Math.max(0, Math.round((end - newest) / 864e5));
}
async function warehouseQueryAttribution(input) {
  const startTimeMs = Date.parse(`${input.range.from}T00:00:00Z`);
  const endTimeMs = Date.parse(`${input.range.to}T00:00:00Z`) + 864e5 - 1;
  if (!input.host || !input.token || !input.warehouseId || !Number.isFinite(startTimeMs) || !Number.isFinite(endTimeMs)) {
    return { ...EMPTY_WAREHOUSE_QUERY_ATTRIBUTION };
  }
  try {
    const transport = input.transport ?? await createWorkspaceQueryHistoryTransport({
      host: input.host,
      token: input.token
    });
    return await readWarehouseQueryAttribution({
      warehouseId: input.warehouseId,
      startTimeMs,
      endTimeMs,
      transport,
      signal: input.signal
    });
  } catch (error) {
    console.warn(`[ops] Query History attribution was withheld: ${error.message}`);
    return {
      ...EMPTY_WAREHOUSE_QUERY_ATTRIBUTION,
      coverage: {
        state: "unavailable",
        requestedRange: {
          from: new Date(startTimeMs).toISOString(),
          to: new Date(endTimeMs).toISOString()
        },
        queriedRange: null,
        rowsRead: 0,
        pagesRead: 0,
        chunksRead: 0,
        reasons: ["transport-error"]
      }
    };
  }
}
var OPS_ROUTES = ["/api/ops/health", "/api/ops/cost", "/api/ops/traffic", "/api/ops/latency"];
function setupOpsRoutes(appkit, deps) {
  if (typeof deps?.isAdminRoute !== "function") {
    console.error(
      "[ops] NOT REGISTERED: no admin-route predicate was supplied, so there is no way to confirm these paths are guarded. They report what this deployment costs and how much of it people use. Pass isAdminRoute."
    );
    return;
  }
  const uncovered = OPS_ROUTES.filter((path) => !deps.isAdminRoute(path));
  if (uncovered.length > 0) {
    console.error(
      `[ops] NOT REGISTERED: the admin guard does not cover ${uncovered.join(", ")}. Add the prefix to ADMIN_ROUTE_PREFIXES in lib/admin-roles.ts. Registering these unguarded would report this deployment\u2019s spend and traffic to any signed-in reader.`
    );
    return;
  }
  const clock = deps.now ?? Date.now;
  appkit.server.extend((app) => {
    app.get("/api/ops/health", async (req, res) => {
      const workspace = host();
      const appsToken = executionToken(req);
      const appsWorkspaceId = appsToken ? await resolveWorkspaceId({ host: workspace, token: appsToken }).catch(() => "") : "";
      const insightsHref = workspaceAppsUrl(workspace, appsWorkspaceId);
      try {
        const [dependencies, appMeasurement, lakebase] = await Promise.all([
          readDependencies(appkit, req, deps.fetchImpl),
          readAppMeasurement(req, insightsHref).catch(
            (error) => uncheckedMeasurement(insightsHref, `reading it threw: ${error.message}.`)
          ),
          lakebaseReading(appkit)
        ]);
        const payload = {
          checkedAt: dependencies.checkedAt,
          dependencies: dependencies.rows,
          platform: platformReadings(servingEndpointReading(dependencies.rows), [lakebase]),
          app: appMeasurement,
          reason: dependencies.reason
        };
        res.json(payload);
      } catch (error) {
        const payload = {
          checkedAt: "",
          dependencies: [],
          platform: [],
          // Not `offMeasurement`. This block failing says nothing whatever about
          // whether telemetry is configured, and reporting off here told a
          // deployment that had switched it on to go and switch it on.
          app: uncheckedMeasurement(insightsHref, `the health block itself failed: ${error.message}.`),
          reason: `This block could not be read, so nothing here was checked: ${error.message}`
        };
        res.json(payload);
      }
    });
    app.get("/api/ops/cost", async (req, res) => {
      const readAt = new Date(clock()).toISOString();
      const range = opsDayRange(queryText(req, "from"), queryText(req, "to"), clock());
      const spendWindow = capUserSpendRange(range);
      const requestAbort = new AbortController();
      res.once?.("close", () => {
        if (!res.writableEnded) requestAbort.abort(new Error("The Cost caller disconnected."));
      });
      const workspace = host();
      const warehouse = warehouseId();
      const token = executionToken(req);
      const workspaceId = token ? await resolveWorkspaceId({ host: workspace, token, fetchImpl: deps.fetchImpl }) : "";
      const resolved = await costIdentifiersFor(appkit, req, {
        workspaceId,
        warehouse,
        fetchImpl: deps.fetchImpl,
        readAppBillingTag: deps.readAppBillingTag,
        readReport: deps.readOrchestratorReport
      });
      const ids = resolved.ids;
      const [storedBudgets, resourceActivity, userRunsRead, userActivityRead] = await Promise.all([
        readCostBudgets(appkit),
        resourceActivityAttribution(appkit, ids, range),
        appkit.lakebase.query(USER_SPEND_RUNS_QUERY, [spendWindow.range.from, spendWindow.range.to]).then((result) => ({ available: true, users: readUserRunSpendEvidence(result.rows), reason: "" })).catch((error) => ({
          available: false,
          users: [],
          reason: `Run identity evidence could not be read: ${error.message}`
        })),
        appkit.lakebase.query(USER_ACTIVE_MINUTES_QUERY, [spendWindow.range.from, spendWindow.range.to]).then((result) => ({
          available: true,
          ...readUserActivitySpendEvidence(result.rows),
          reason: ""
        })).catch((error) => ({
          available: false,
          users: [],
          recordedFrom: "",
          recordedThrough: "",
          reason: `Per-user active-minute evidence could not be read: ${error.message}`
        }))
      ]);
      const costBudgets = attributableCostBudgets(storedBudgets.budgets);
      const empty = {
        grant: null,
        reason: "",
        currency: "",
        throughDay: "",
        range,
        billingLagDays: null,
        readAt,
        perQuestion: {
          runs: [],
          runsInRange: 0,
          tokenCoveredRuns: 0,
          totalRecordedTokens: 0,
          limited: false,
          reason: ""
        },
        budgets: costBudgets,
        budgetsReadable: storedBudgets.readable
      };
      if (!workspace || !warehouse || !token) {
        res.json({
          ...empty,
          state: "no-warehouse",
          tiles: buildTiles(ids, [], EMPTY_WAREHOUSE_QUERY_ATTRIBUTION, resourceActivity),
          reason: "Billing could not be read because this app has no SQL warehouse, no workspace address, or no forwarded sign-in to read it with. Nothing about spend was established."
        });
        return;
      }
      const built = buildCostStatement(ids, range);
      if (!built) {
        res.json({
          ...empty,
          state: "ready",
          tiles: buildTiles(ids, [], EMPTY_WAREHOUSE_QUERY_ATTRIBUTION, resourceActivity)
        });
        return;
      }
      try {
        const [outcome, queryAttribution] = await Promise.all([
          runStatement({
            host: workspace,
            token,
            warehouseId: warehouse,
            statement: built.statement,
            parameters: built.parameters,
            fetchImpl: deps.fetchImpl
          }),
          warehouseQueryAttribution({
            host: workspace,
            token,
            warehouseId: warehouse,
            range,
            transport: deps.queryHistoryTransport,
            signal: requestAbort.signal
          })
        ]);
        const inventoryCount = resourceTagInventory({ environment: process.env, report: resolved.report }).length;
        if (!outcome.ok) {
          const denial = classifyDenial(outcome.message, "system.billing.usage");
          if (denial.kind === "no-grant") {
            res.json({
              ...empty,
              state: "no-grant",
              grant: billingGrant(userEmail(req) || UNKNOWN_PRINCIPAL),
              tiles: buildTiles(ids, [], queryAttribution, resourceActivity),
              reason: `You do not have ${denial.permission} on ${denial.object}, so no spend was read. Billing runs under your own grants rather than this app\u2019s, so being an administrator here does not grant it. SELECT is needed on both system.billing.usage and system.billing.list_prices.`
            });
            return;
          }
          res.json({
            ...empty,
            state: "unreadable",
            tiles: buildTiles(ids, [], queryAttribution, resourceActivity),
            reason: `Billing could not be read, so nothing about spend was established. Databricks said: ${outcome.message}`
          });
          return;
        }
        const split = splitBillingRows(readComponentRows(outcome.rows));
        const coverage = buildCoverage({
          inventoryCount,
          coverageRows: split.coverage,
          propagationRows: split.propagation,
          range,
          meta: split.meta,
          appBillingTag: ids.appBillingTag
        });
        const unpropagated = coverage.propagation.filter((row) => row.status === "unpropagated");
        const delayed = coverage.propagation.some((row) => row.status === "delayed");
        if (split.components.length === 0 && (!split.meta || split.meta.billedDays === 0)) {
          const tiles2 = buildTiles(ids, [], queryAttribution, resourceActivity);
          const reason = unpropagated.length ? "Matching usage exists without the Astrolabe tag, but exact resource attribution remains available." : delayed ? "No exact tracked-resource billing rows yet. Later days may still be filling." : "No billing rows matched an exact tracked resource.";
          res.json({
            ...empty,
            state: "no-rows",
            tiles: tiles2,
            currency: split.meta?.currency ?? "",
            throughDay: split.meta?.lastDay || "",
            billingLagDays: lagDays(range.to, split.meta?.lastDay || ""),
            coverage,
            honesty: buildHonesty(range, split.meta, tiles2),
            reason
          });
          return;
        }
        const tiles = buildTiles(ids, split.components, queryAttribution, resourceActivity);
        const spendCacheKey = userSpendCacheKey(userEmail(req), spendWindow.range);
        const spendByUser = cachedUserSpend(spendCacheKey, clock()) ?? buildSpendByUser({
          readAt,
          requestedRange: range,
          range: spendWindow.range,
          tiles: spendWindow.partial ? [] : tiles,
          queryComplete: !spendWindow.partial && queryAttribution.complete,
          queryUsers: !spendWindow.partial ? queryAttribution.users ?? [] : [],
          runs: userRunsRead.users,
          activity: {
            available: userActivityRead.available,
            users: userActivityRead.users,
            recordedFrom: userActivityRead.recordedFrom,
            recordedThrough: userActivityRead.recordedThrough
          },
          partialReason: [
            spendWindow.partial ? "Individual spend is limited to the most recent 90 complete days because raw user telemetry is retained for 90 days." : "",
            userRunsRead.reason,
            userActivityRead.reason
          ].filter(Boolean).join(" ")
        });
        cacheUserSpend(spendCacheKey, spendByUser, clock());
        let perQuestion = {
          ...empty.perQuestion,
          reason: "Per-question attribution could not be read from the run ledger."
        };
        try {
          const result = await appkit.lakebase.query(QUESTION_COST_RUNS_QUERY, [range.from, range.to]);
          perQuestion = buildQuestionAttribution(
            result.rows.map((row) => questionRun(row)),
            tiles,
            QUESTION_COST_LIMIT
          );
        } catch (error) {
          perQuestion.reason = `Per-question attribution could not be read from the run ledger: ${error.message}`;
        }
        res.json({
          ...empty,
          state: "ready",
          currency: split.meta?.currency ?? tiles.find((tile) => tile.pricing?.currency)?.pricing?.currency ?? "",
          throughDay: split.meta?.lastDay || "",
          billingLagDays: lagDays(range.to, split.meta?.lastDay || ""),
          tiles,
          perQuestion,
          spendByUser,
          coverage,
          honesty: buildHonesty(range, split.meta, tiles)
        });
      } catch (error) {
        res.json({
          ...empty,
          state: "unreadable",
          tiles: buildTiles(ids, [], EMPTY_WAREHOUSE_QUERY_ATTRIBUTION, resourceActivity),
          reason: `Billing could not be read, so nothing about spend was established: ${error.message}`
        });
      }
    });
    app.get("/api/ops/traffic", async (req, res) => {
      const readAt = new Date(clock()).toISOString();
      const range = opsDayRange(queryText(req, "from"), queryText(req, "to"), clock());
      try {
        const runtime = await readRuntimeSettings(appkit);
        const activeMinutesTimeZone = validIanaTimeZone(runtime.behavior.timezone) || validIanaTimeZone(queryText(req, "timeZone")) || "UTC";
        const [questions, askers, activeMinutes, breakdowns] = await Promise.allSettled([
          appkit.lakebase.query(QUESTIONS_PER_DAY_QUERY, [activeMinutesTimeZone, range.from, range.to]),
          appkit.lakebase.query(DISTINCT_ASKERS_PER_DAY_QUERY, [activeMinutesTimeZone, range.from, range.to]),
          appkit.lakebase.query(ACTIVE_MINUTES_PER_DAY_QUERY, [activeMinutesTimeZone, range.from, range.to]),
          trafficBreakdownsFor(appkit, [activeMinutesTimeZone, range.from, range.to])
        ]);
        const questionsPerDay = questions.status === "fulfilled" ? questions.value.rows.map((row) => ({ day: text(row.day), count: count(row.count) })) : [];
        const distinctAskersPerDay = askers.status === "fulfilled" ? askers.value.rows.map((row) => ({ day: text(row.day), count: count(row.count) })) : [];
        const activeMinutesPerDay = activeMinutes.status === "fulfilled" ? activeMinutes.value.rows.filter((row) => Boolean(text(row.day))).map((row) => ({ day: text(row.day), count: count(row.count) })) : [];
        const activityBounds = activeMinutes.status === "fulfilled" ? activeMinutes.value.rows[0] : void 0;
        const activityCoverageState = text(activityBounds?.coverage_state);
        const activityCoverage = activityCoverageState === "complete" || activityCoverageState === "partial" || activityCoverageState === "unavailable" ? {
          state: activityCoverageState,
          missingDays: count(activityBounds?.missing_days)
        } : void 0;
        const unavailableCoverage = {
          state: "unavailable",
          coveredRuns: 0,
          reason: breakdowns.status === "rejected" ? breakdowns.reason.message : "The shared run population could not be read."
        };
        const measured = breakdowns.status === "fulfilled" ? breakdowns.value : {
          runsInRange: 0,
          failuresByCause: [],
          refusalsByCause: [],
          toolCalls: [],
          outcomesCoverage: unavailableCoverage,
          toolCallsCoverage: unavailableCoverage
        };
        const outstanding = [
          { done: questions, charts: "Questions per day" },
          { done: askers, charts: "Distinct askers per day" },
          { done: activeMinutes, charts: "Recorded active app minutes per day" },
          { done: breakdowns, charts: "Failures, refusals and tool calls" }
        ].filter((read) => read.done.status === "rejected");
        const rejected = outstanding.map((read) => read.done);
        const readCount = 4;
        const partialRead = rejected.length > 0 && rejected.length < readCount ? unreadNote(
          outstanding.map((read) => read.charts),
          text(rejected[0].reason?.message)
        ) : "";
        const coverageRead = activityCoverage?.state === "partial" ? `Recorded active app minutes have ${activityCoverage.missingDays} missing UTC rollup day(s); the returned days are partial rather than zero-filled.` : "";
        const payload = {
          readAt,
          range,
          reason: rejected.length === readCount ? `Nothing about traffic could be read: ${text(rejected[0].reason?.message) || "the store did not answer"}` : "",
          unread: [partialRead, coverageRead].filter(Boolean).join(" "),
          questionsPerDay,
          distinctAskersPerDay,
          activeMinutesPerDay,
          activeMinutesTimeZone,
          activeMinutesRecordedFrom: text(activityBounds?.recorded_from),
          activeMinutesRecordedThrough: text(activityBounds?.recorded_through),
          activityCoverage,
          failuresByCause: measured.failuresByCause,
          refusalsByCause: measured.refusalsByCause,
          toolCalls: measured.toolCalls,
          runsInRange: measured.runsInRange,
          breakdownCoverage: {
            outcomes: measured.outcomesCoverage,
            toolCalls: measured.toolCallsCoverage
          }
        };
        res.json(payload);
      } catch (error) {
        const payload = {
          readAt,
          range,
          reason: `Nothing about traffic could be read: ${error.message}`,
          unread: "",
          questionsPerDay: [],
          distinctAskersPerDay: [],
          activeMinutesPerDay: [],
          activeMinutesTimeZone: "UTC",
          activeMinutesRecordedFrom: "",
          activeMinutesRecordedThrough: "",
          failuresByCause: [],
          refusalsByCause: [],
          toolCalls: [],
          runsInRange: 0,
          breakdownCoverage: {
            outcomes: { state: "unavailable", coveredRuns: 0, reason: error.message },
            toolCalls: { state: "unavailable", coveredRuns: 0, reason: error.message }
          },
          activityCoverage: { state: "unavailable", missingDays: 0 }
        };
        res.json(payload);
      }
    });
    app.get("/api/ops/latency", async (req, res) => {
      const readAt = new Date(clock()).toISOString();
      const range = opsDayRange(queryText(req, "from"), queryText(req, "to"), clock());
      const base = {
        readAt,
        range,
        state: "no-rows",
        reason: "",
        grant: null,
        table: REQUEST_LATENCY_TABLE,
        routes: [],
        coveredFrom: "",
        coveredTo: "",
        coverage: { state: "unavailable", missingDays: 0 }
      };
      try {
        const result = await appkit.lakebase.query(REQUEST_LATENCY_QUERY, [range.from, range.to]);
        const measured = readRequestLatencyRows(result.rows);
        if (measured.routes.length === 0) {
          res.json({
            ...base,
            reason: "No API request timings have been recorded. Recording starts with this release and does not backfill.",
            coveredFrom: measured.coveredFrom,
            coveredTo: measured.coveredTo,
            coverage: { state: measured.coverageState, missingDays: measured.missingDays }
          });
          return;
        }
        res.json({
          ...base,
          state: "ready",
          routes: measured.routes,
          coveredFrom: measured.coveredFrom,
          coveredTo: measured.coveredTo,
          coverage: { state: measured.coverageState, missingDays: measured.missingDays },
          reason: measured.coverageState === "partial" ? `${measured.missingDays} UTC day(s) are missing from raw and rolled request timings, so these figures are partial.` : ""
        });
      } catch (error) {
        const payload = {
          ...base,
          state: "unreadable",
          reason: `No stored API request timings could be read: ${error.message}`
        };
        res.json(payload);
      }
    });
  });
  console.log("[ops] Registered the Ops read routes. The admin guard's prefix list covers all of them.");
}
export {
  DISTINCT_ASKERS_PER_DAY_QUERY,
  OPS_ROUTES,
  QUESTIONS_PER_DAY_QUERY,
  QUESTION_COST_RUNS_QUERY,
  RESOURCE_ACTIVITY_QUERY,
  RUN_OUTCOMES_QUERY,
  TOOL_CALLS_QUERY,
  configuredResourceName,
  costIdentifiersFor,
  forgetWorkspaceId,
  host,
  lakebaseReading,
  lookupVectorConnection,
  platformReadings,
  resolveWorkspaceId,
  resourceActivityAttribution,
  resultFor,
  runStatement,
  servingEndpointReading,
  setupOpsRoutes,
  warehouseId,
  warehouseQueryAttribution
};
