
import {
  isDataContractFallback,
  listDeclarableTablesInSchema,
  readAppBillingTag,
  readOrchestratorReport,
  resourceTagInventory,
  unionTableNames
} from "./chunk-6UVAABB4.mjs";
import "./chunk-4JRNDRTQ.mjs";
import {
  ANSWER_PATH_ENDPOINT_IDS,
  SERVING_ENDPOINT_KIND,
  probeConnections
} from "./chunk-FDCMDFAJ.mjs";
import {
  resolveSemanticIndexValue
} from "./chunk-MTXPHPGN.mjs";
import {
  ACTIVE_MINUTES_PER_DAY_QUERY,
  LEGACY_TRAFFIC_BREAKDOWNS_QUERY,
  MAX_PERSONA_FILTER_LENGTH,
  RAW_TRAFFIC_BREAKDOWNS_QUERY,
  REQUEST_LATENCY_QUERY,
  REQUEST_LATENCY_TABLE,
  TRAFFIC_BREAKDOWNS_QUERY,
  USER_ACTIVE_MINUTES_QUERY,
  USER_SPEND_RUNS_QUERY,
  attributableCostBudgets,
  buildSpendByUser,
  buildTelemetryStatement,
  buildUserMonitoringPage,
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
  userSpendDataRevision,
  validIanaTimeZone
} from "./chunk-7SO7JJCQ.mjs";
import {
  UNKNOWN_PRINCIPAL,
  accessDependenciesFrom,
  classifyDenial,
  executionToken,
  listSpAssignments,
  listSpPersonas,
  sqlQueryTags
} from "./chunk-4IYCA3Q2.mjs";
import "./chunk-RPJTQHME.mjs";
import {
  appEnvironment,
  readStoredSettings,
  resourceStates
} from "./chunk-YG4YL534.mjs";
import {
  normalizeWorkspaceHost,
  workspaceAppsUrl
} from "./chunk-VHHJDNLO.mjs";
import {
  effectiveRole,
  everyKnownUser,
  isRole,
  readRosterForRequest,
  seedRoles
} from "./chunk-XIJCYHNA.mjs";
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
} from "./chunk-LVHEQTRD.mjs";
import "./chunk-JLYA46HN.mjs";
import "./chunk-5DRRUJAY.mjs";
import {
  APP_SCHEMA
} from "./chunk-7DTM6FIL.mjs";
import "./chunk-LLUDDZ3A.mjs";

// server/lib/genie-accounting.ts
var GENIE_ALLOWANCE_DBUS_PER_USER = 150;
var GENIE_PROMOTION_END = "2027-01-31";
var GENIE_FREE_SKU = "GENIE_FREE_USAGE";
var ELIGIBLE_SURFACES = /* @__PURE__ */ new Set(["GENIE_CODE", "GENIE_ONE", "GENIE_AGENTS"]);
function uniqueConfiguredSpaces(spaces) {
  const unique = /* @__PURE__ */ new Map();
  for (const space of spaces) {
    const id = space.id.trim();
    if (!id) continue;
    const existing = unique.get(id);
    unique.set(id, existing ? { ...existing, label: `${existing.label} / ${space.label}` } : { ...space, id });
  }
  return [...unique.values()];
}
function buildGenieAccountingStatement(workspaceId, range, configuredSpaces = []) {
  if (!workspaceId.trim()) return null;
  const spaces = uniqueConfiguredSpaces(configuredSpaces);
  const spaceParameters = spaces.map((space, index) => ({
    name: `genieSpace${index}`,
    value: space.id.trim(),
    type: "STRING"
  }));
  const configuredSpaceSql = spaceParameters.length > 0 ? spaceParameters.map(({ name }, index) => `${index === 0 ? "SELECT" : "UNION ALL SELECT"} :${name} AS space_id`).join("\n  ") : "SELECT CAST(NULL AS STRING) AS space_id WHERE FALSE";
  return {
    parameters: [
      { name: "workspaceId", value: workspaceId.trim(), type: "STRING" },
      { name: "through_day", value: range.to, type: "DATE" },
      ...spaceParameters
    ],
    statement: `WITH configured_spaces AS (
  ${configuredSpaceSql}
),
genie_usage AS (
  SELECT
    COALESCE(CAST(u.record_id AS STRING),
      CONCAT_WS('|', CAST(u.workspace_id AS STRING), u.sku_name,
        CAST(u.usage_start_time AS STRING), CAST(u.usage_end_time AS STRING))) AS record_id,
    u.usage_date,
    u.usage_end_time,
    u.cloud,
    u.sku_name,
    u.usage_unit,
    u.usage_quantity,
    COALESCE(u.record_type, 'ORIGINAL') AS record_type,
    NULLIF(TRIM(u.identity_metadata.run_as), '') AS run_as,
    NULLIF(UPPER(TRIM(u.usage_metadata.genie.surface)), '') AS surface,
    NULLIF(UPPER(TRIM(u.usage_metadata.genie.channel)), '') AS channel,
    NULLIF(UPPER(TRIM(u.product_features.genie.offering_type)), '') AS offering_type
  FROM system.billing.usage u
  WHERE u.billing_origin_product = 'GENIE'
    AND u.workspace_id = :workspaceId
    AND u.usage_date >= DATE_TRUNC('MONTH', :through_day)
    AND u.usage_date <= :through_day
    AND UPPER(TRIM(u.usage_unit)) = 'DBU'
),
price_hits AS (
  SELECT
    usage.*,
    p.pricing.default AS unit_price,
    p.currency_code,
    COUNT(p.sku_name) OVER (PARTITION BY usage.record_id) AS price_match_count
  FROM genie_usage usage
  LEFT JOIN system.billing.list_prices p
    ON usage.sku_name <> '${GENIE_FREE_SKU}'
   AND usage.sku_name = p.sku_name
   AND usage.cloud = p.cloud
   AND usage.usage_unit = p.usage_unit
   AND usage.usage_end_time >= p.price_start_time
   AND (p.price_end_time IS NULL OR usage.usage_end_time < p.price_end_time)
),
deduped AS (
  SELECT
    record_id, usage_date, sku_name, usage_quantity, record_type, run_as, surface, channel, offering_type,
    MAX(price_match_count) AS price_match_count,
    MAX(unit_price) AS unit_price,
    MAX(currency_code) AS currency_code
  FROM price_hits
  GROUP BY record_id, usage_date, sku_name, usage_quantity, record_type, run_as, surface, channel, offering_type
),
query_space_evidence AS (
  SELECT
    CAST(q.start_time AS DATE) AS usage_date,
    LOWER(TRIM(q.executed_by)) AS run_as,
    q.query_source.genie_space_id AS space_id,
    COUNT(*) AS query_count,
    SUM(COALESCE(q.execution_duration_ms, 0)) AS execution_ms
  FROM system.query.history q
  INNER JOIN configured_spaces configured
    ON q.query_source.genie_space_id = configured.space_id
  WHERE q.workspace_id = :workspaceId
    AND q.start_time >= TIMESTAMP(DATE_TRUNC('MONTH', :through_day))
    AND q.start_time < TIMESTAMP(DATE_ADD(:through_day, 1))
  GROUP BY CAST(q.start_time AS DATE), LOWER(TRIM(q.executed_by)), q.query_source.genie_space_id
),
query_weights AS (
  SELECT
    *,
    CASE
      WHEN SUM(execution_ms) OVER (PARTITION BY usage_date, run_as) > 0
        THEN execution_ms / SUM(execution_ms) OVER (PARTITION BY usage_date, run_as)
      ELSE query_count / SUM(query_count) OVER (PARTITION BY usage_date, run_as)
    END AS allocation_weight,
    COUNT(*) OVER (PARTITION BY usage_date, run_as) AS matched_spaces
  FROM query_space_evidence
),
allocated AS (
  SELECT
    billing.*,
    COALESCE(weights.space_id, '') AS space_id,
    COALESCE(weights.allocation_weight, 1.0) AS allocation_weight,
    CASE
      WHEN weights.space_id IS NULL THEN 'unattributed'
      WHEN weights.matched_spaces = 1 THEN 'query-history-exact'
      ELSE 'query-history-allocation'
    END AS attribution_method
  FROM deduped billing
  LEFT JOIN query_weights weights
    ON billing.usage_date = weights.usage_date
   AND LOWER(TRIM(billing.run_as)) = weights.run_as
)
SELECT
  usage_date AS usage_day,
  COALESCE(run_as, '') AS identity,
  CASE WHEN run_as LIKE '%@%' THEN 'human'
       WHEN run_as IS NULL THEN 'unknown'
       ELSE 'service_principal' END AS identity_kind,
  COALESCE(surface, '') AS surface,
  COALESCE(channel, '') AS channel,
  COALESCE(offering_type, '') AS offering_type,
  sku_name,
  space_id,
  attribution_method,
  SUM(usage_quantity * allocation_weight) AS dbus,
  CASE
    WHEN sku_name = '${GENIE_FREE_SKU}' THEN CAST(0 AS DOUBLE)
    WHEN COUNT(*) FILTER (WHERE price_match_count <> 1 OR unit_price IS NULL) > 0 THEN CAST(NULL AS DOUBLE)
    ELSE SUM(usage_quantity * unit_price * allocation_weight)
  END AS paid_usd,
  COUNT(*) FILTER (WHERE sku_name <> '${GENIE_FREE_SKU}' AND price_match_count = 1 AND unit_price IS NOT NULL)
    AS priced_rows,
  COUNT(*) FILTER (WHERE sku_name <> '${GENIE_FREE_SKU}' AND (price_match_count <> 1 OR unit_price IS NULL))
    AS unpriced_rows,
  COUNT(*) FILTER (WHERE record_type ILIKE '%CORRECT%' OR usage_quantity < 0) AS correction_rows,
  MAX(usage_date) AS through_day
FROM allocated
GROUP BY usage_date, run_as, identity_kind, surface, channel, offering_type, sku_name, space_id, attribution_method
ORDER BY usage_date, identity_kind, identity, space_id, surface, sku_name`
  };
}
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
function number(value) {
  if (value === null || value === void 0 || text(value) === "") return null;
  const parsed = typeof value === "number" ? value : Number(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}
function readGenieAccountingRows(rows) {
  const parsed = [];
  for (const row of rows) {
    const dbus = number(row.dbus);
    const kind = text(row.identity_kind);
    if (dbus === null || !["human", "service_principal", "unknown"].includes(kind)) continue;
    parsed.push({
      usageDay: text(row.usage_day),
      identity: text(row.identity),
      identityKind: kind,
      surface: text(row.surface).toUpperCase(),
      channel: text(row.channel).toUpperCase(),
      offeringType: text(row.offering_type).toUpperCase(),
      skuName: text(row.sku_name),
      spaceId: text(row.space_id),
      attributionMethod: ["query-history-exact", "query-history-allocation"].includes(text(row.attribution_method)) ? text(row.attribution_method) : "unattributed",
      dbus,
      paidUsd: number(row.paid_usd),
      pricedRows: Math.max(0, number(row.priced_rows) ?? 0),
      unpricedRows: Math.max(0, number(row.unpriced_rows) ?? 0),
      correctionRows: Math.max(0, number(row.correction_rows) ?? 0),
      throughDay: text(row.through_day)
    });
  }
  return parsed;
}
function emptySlice(attribution) {
  return {
    allowance: 0,
    promotional: 0,
    chargedEffective: 0,
    chargedRaw: 0,
    paidUsd: 0,
    paidUsdComplete: true,
    hasRows: false,
    hasCharged: false,
    attribution,
    surfaces: /* @__PURE__ */ new Map()
  };
}
function sliceFor(map, key, attribution) {
  const existing = map.get(key);
  if (existing) {
    if (attribution === "query-history-allocation") existing.attribution = attribution;
    return existing;
  }
  const created = emptySlice(attribution);
  map.set(key, created);
  return created;
}
function surfaceKey(surface) {
  return ELIGIBLE_SURFACES.has(surface) ? surface : "UNKNOWN";
}
function addCategory(target, surface, category, quantity, raw, paidUsd, priced) {
  target.hasRows = true;
  const surfaceTarget = target.surfaces.get(surface) ?? emptySlice(target.attribution);
  target.surfaces.set(surface, surfaceTarget);
  surfaceTarget.hasRows = true;
  if (category === "allowance") {
    target.allowance += quantity;
    surfaceTarget.allowance += quantity;
  } else if (category === "promotional") {
    target.promotional += quantity;
    surfaceTarget.promotional += quantity;
  } else {
    target.hasCharged = true;
    surfaceTarget.hasCharged = true;
    target.chargedEffective += quantity;
    target.chargedRaw += raw;
    surfaceTarget.chargedEffective += quantity;
    surfaceTarget.chargedRaw += raw;
    if (!priced || paidUsd === null) {
      target.paidUsdComplete = false;
      surfaceTarget.paidUsdComplete = false;
    } else {
      target.paidUsd += paidUsd;
      surfaceTarget.paidUsd += paidUsd;
    }
  }
}
function pricingState(value) {
  if (!value.hasRows) return "none";
  if (!value.hasCharged || value.paidUsdComplete) return "priced";
  return value.paidUsd > 0 ? "partial" : "unpriced";
}
function surfaceResults(value) {
  return [...value.surfaces].map(([surface, item]) => ({
    surface,
    allowanceUsedDbus: Math.max(0, item.allowance),
    promotionalDbus: Math.max(0, item.promotional),
    chargedEffectiveDbus: Math.max(0, item.chargedEffective),
    chargedRawEquivalentDbus: Math.max(0, item.chargedRaw),
    paidUsd: item.paidUsdComplete ? Math.max(0, item.paidUsd) : null
  })).sort((left, right) => left.surface.localeCompare(right.surface));
}
function instanceResult(space, value) {
  return {
    spaceId: space.id,
    label: space.label,
    tileId: space.tileId,
    attribution: value.attribution,
    allowanceUsedDbus: Math.max(0, value.allowance),
    promotionalDbus: Math.max(0, value.promotional),
    chargedEffectiveDbus: Math.max(0, value.chargedEffective),
    chargedRawEquivalentDbus: Math.max(0, value.chargedRaw),
    paidUsd: value.paidUsdComplete ? Math.max(0, value.paidUsd) : null,
    underlyingTotalDbus: Math.max(0, value.allowance + value.promotional + value.chargedRaw),
    pricingState: pricingState(value),
    surfaces: surfaceResults(value)
  };
}
function userResult(identity, value, configured) {
  const allowanceUsed = Math.min(GENIE_ALLOWANCE_DBUS_PER_USER, Math.max(0, value.allowance));
  return {
    identity,
    allowanceUsedDbus: allowanceUsed,
    allowanceRemainingDbus: Math.max(0, GENIE_ALLOWANCE_DBUS_PER_USER - allowanceUsed),
    promotionalDbus: Math.max(0, value.promotional),
    chargedEffectiveDbus: Math.max(0, value.chargedEffective),
    chargedRawEquivalentDbus: Math.max(0, value.chargedRaw),
    paidUsd: value.paidUsdComplete ? Math.max(0, value.paidUsd) : null,
    instances: [...value.instances].map(([spaceId, instance]) => {
      const space = configured.get(spaceId) ?? { id: "", label: "Unattributed Genie", tileId: "genie:unattributed" };
      const result = instanceResult(space, instance);
      const { surfaces: _surfaces, pricingState: _pricingState, ...summary } = result;
      return summary;
    }).sort((left, right) => left.label.localeCompare(right.label))
  };
}
function classifyGenieAccounting(rows, throughDay, configuredSpaces = []) {
  const promo = throughDay <= GENIE_PROMOTION_END;
  const spaces = uniqueConfiguredSpaces(configuredSpaces);
  const configured = new Map(spaces.map((space) => [space.id, space]));
  const users = /* @__PURE__ */ new Map();
  const instances = /* @__PURE__ */ new Map();
  const diagnostics = /* @__PURE__ */ new Set();
  const overall = emptySlice("query-history-exact");
  let sourceDbus = 0;
  let newest = "";
  const human = (identity) => {
    const existing = users.get(identity);
    if (existing) return existing;
    const created = { ...emptySlice("query-history-exact"), instances: /* @__PURE__ */ new Map() };
    users.set(identity, created);
    return created;
  };
  for (const row of rows) {
    newest = row.throughDay > newest ? row.throughDay : newest;
    const quantity = row.dbus;
    sourceDbus += Math.max(0, quantity);
    overall.hasRows = true;
    const isFree = row.skuName === GENIE_FREE_SKU;
    const knownSurface = ELIGIBLE_SURFACES.has(row.surface);
    const person = row.identityKind === "human" ? human(row.identity || "Unknown human") : null;
    const key = configured.has(row.spaceId) ? row.spaceId : "";
    const attribution = key ? row.attributionMethod : "unattributed";
    const instance = sliceFor(instances, key, attribution);
    const userInstance = person ? sliceFor(person.instances, key, attribution) : null;
    const surface = surfaceKey(row.surface);
    if (isFree && row.identityKind === "human" && knownSurface) {
      if (promo && row.surface !== "GENIE_CODE") {
        addCategory(overall, surface, "promotional", quantity, quantity, 0, true);
        addCategory(instance, surface, "promotional", quantity, quantity, 0, true);
        if (person) addCategory(person, surface, "promotional", quantity, quantity, 0, true);
        if (userInstance) addCategory(userInstance, surface, "promotional", quantity, quantity, 0, true);
      } else {
        if (person) addCategory(person, surface, "allowance", quantity, quantity, 0, true);
        if (userInstance) addCategory(userInstance, surface, "allowance", quantity, quantity, 0, true);
      }
      continue;
    }
    if (isFree && row.identityKind === "human" && !knownSurface) {
      diagnostics.add("Free-SKU rows with an unknown Genie surface were withheld from allowance and promotion.");
      continue;
    }
    const raw = promo ? quantity * 0.75 : quantity;
    const effective = promo && isFree ? quantity / 0.75 : quantity;
    const rawEquivalent = isFree ? quantity : raw;
    const priced = row.paidUsd !== null && row.unpricedRows === 0 && !isFree;
    addCategory(overall, surface, "charged", effective, rawEquivalent, row.paidUsd, priced);
    addCategory(instance, surface, "charged", effective, rawEquivalent, row.paidUsd, priced);
    if (person) addCategory(person, surface, "charged", effective, rawEquivalent, row.paidUsd, priced);
    if (userInstance) addCategory(userInstance, surface, "charged", effective, rawEquivalent, row.paidUsd, priced);
    if (isFree && row.identityKind !== "human") {
      diagnostics.add("Ineligible non-human free-SKU rows are charged DBUs, but their USD price is unavailable.");
    }
    if (row.identityKind === "unknown") {
      diagnostics.add("Rows with missing identity were treated as charged, not as human allowance.");
    }
    if (row.correctionRows > 0) diagnostics.add("Billing corrections are included in the reconciliation.");
  }
  for (const user of users.values()) {
    const capped = Math.min(GENIE_ALLOWANCE_DBUS_PER_USER, Math.max(0, user.allowance));
    const scale = user.allowance > 0 ? capped / user.allowance : 0;
    user.allowance = capped;
    for (const [spaceId, userInstance] of user.instances) {
      userInstance.allowance *= scale;
      for (const surface of userInstance.surfaces.values()) surface.allowance *= scale;
      const target = sliceFor(instances, spaceId, userInstance.attribution);
      target.allowance += userInstance.allowance;
      target.hasRows ||= userInstance.hasRows;
      for (const [surface, userSurface] of userInstance.surfaces) {
        const targetSurface = target.surfaces.get(surface) ?? emptySlice(target.attribution);
        target.surfaces.set(surface, targetSurface);
        targetSurface.allowance += userSurface.allowance;
        targetSurface.hasRows ||= userSurface.hasRows;
      }
    }
    overall.allowance += capped;
  }
  const perUser = [...users].map(([identity, value]) => userResult(identity, value, configured)).sort(
    (left, right) => right.allowanceUsedDbus - left.allowanceUsedDbus || left.identity.localeCompare(right.identity)
  );
  const allowanceUsed = perUser.reduce((total, user) => total + user.allowanceUsedDbus, 0);
  const allowanceRemaining = perUser.reduce((total, user) => total + user.allowanceRemainingDbus, 0);
  const allowanceCapacity = perUser.length * GENIE_ALLOWANCE_DBUS_PER_USER;
  const instanceResults = spaces.map(
    (space) => instanceResult(space, instances.get(space.id) ?? emptySlice("query-history-exact"))
  );
  const unattributedValue = instances.get("");
  const unattributed = unattributedValue ? instanceResult({ id: "", label: "Unattributed Genie", tileId: "genie:unattributed" }, unattributedValue) : null;
  const attributedDbus = rows.filter((row) => configured.has(row.spaceId)).reduce((total, row) => total + Math.max(0, row.dbus), 0);
  const unattributedDbus = Math.max(0, sourceDbus - attributedDbus);
  return {
    month: throughDay.slice(0, 7),
    throughDay: newest || throughDay,
    humanUsers: perUser.length,
    allowanceDbusPerUser: GENIE_ALLOWANCE_DBUS_PER_USER,
    allowanceUsedDbus: Math.max(0, allowanceUsed),
    allowanceRemainingDbus: Math.max(0, allowanceRemaining),
    allowanceUtilization: allowanceCapacity > 0 ? Math.max(0, allowanceUsed) / allowanceCapacity : 0,
    promotionalDbus: Math.max(0, overall.promotional),
    chargedEffectiveDbus: Math.max(0, overall.chargedEffective),
    chargedRawEquivalentDbus: Math.max(0, overall.chargedRaw),
    paidUsd: overall.paidUsdComplete ? Math.max(0, overall.paidUsd) : overall.hasCharged ? null : 0,
    underlyingTotalDbus: Math.max(0, allowanceUsed + overall.promotional + overall.chargedRaw),
    pricingState: pricingState(overall),
    instances: instanceResults,
    unattributed,
    reconciliation: {
      sourceDbus,
      attributedDbus,
      unattributedDbus,
      attributedShare: sourceDbus > 0 ? attributedDbus / sourceDbus : 1
    },
    diagnostics: [...diagnostics],
    users: perUser
  };
}

// server/routes/ops-routes.ts
var STATEMENT_TIMEOUT_MS = 45e3;
var USER_MONITORING_CACHE_MS = 3e4;
var userMonitoringCache = /* @__PURE__ */ new Map();
function queryText(req, name) {
  const value = req.query[name];
  return typeof value === "string" ? value.trim() : "";
}
function text2(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return "";
}
function count(value) {
  const parsed = typeof value === "number" ? value : Number(text2(value));
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
    const drift = configuredEndpoint && configuredEndpoint !== endpoint ? `Released endpoint ${configuredEndpoint} differs from the active index host ${endpoint}.` : "";
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
      reason: endpointIndexCount === null ? "The hosting endpoint response carried no usable index count." : "",
      ...drift ? { drift } : {}
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
    const candidate = text2(record[key]).trim();
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
  const semanticValue = text2(configured["semantic-index"]) || configuredResourceName(semanticEntry?.value, ["index_name", "full_name", "name", "value"]) || text2(semanticEntry?.value);
  const vectorIndex = vectorIndexName(
    resolveSemanticIndexValue(semanticValue, text2(configured.catalog), text2(configured.schema)) || semanticCheck?.name || (process.env.PLAYER_INSIGHTS_SEMANTIC_INDEX ?? "")
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
      vectorIdentityDrift: vectorConnection.drift,
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
      message: text2(body.message) || `Databricks answered HTTP ${response.status} with no message body.`
    };
  }
  const state = text2(body.status?.state);
  if (state !== "SUCCEEDED") {
    return {
      ok: false,
      rows: null,
      message: text2(body.status?.error?.message) || `The statement ended in ${state || "an unknown state"}.`
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
    const parsed = Number(text2(value));
    return text2(value) !== "" && Number.isFinite(parsed) ? parsed : null;
  };
  return {
    runId: text2(row.run_id),
    correlationId: text2(row.correlation_id),
    traceId: text2(row.trace_id),
    completedAt: text2(row.completed_at),
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
      `[ops] NOT REGISTERED: the admin guard does not cover ${uncovered.join(", ")}. Add the prefix to ADMIN_ROUTE_PREFIXES in lib/admin-roles.ts. Registering these unguarded would report this deployment’s spend and traffic to any signed-in reader.`
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
      const userBrowse = queryText(req, "userBrowse") === "1";
      const spendUser = queryText(req, "spendUser").toLowerCase();
      const requestedUnit = queryText(req, "unit");
      const userUnit = requestedUnit === "DBU" ? "DBU" : "USD";
      const requestedRole = queryText(req, "role");
      const userRole = isRole(requestedRole) ? requestedRole : "";
      const requestedPersona = queryText(req, "persona").trim();
      const userPersona = requestedPersona === "none" ? "" : requestedPersona.slice(0, MAX_PERSONA_FILTER_LENGTH);
      const userMonitoringCacheKey = [
        userEmail(req),
        range.from,
        range.to,
        userUnit,
        queryText(req, "userSearch").toLowerCase(),
        userRole,
        userPersona,
        queryText(req, "userCursor"),
        queryText(req, "pageSize"),
        userSpendDataRevision()
      ].join("|");
      if (userBrowse) {
        const cached = userMonitoringCache.get(userMonitoringCacheKey);
        if (cached && cached.expiresAt > clock()) {
          res.json(cached.payload);
          return;
        }
        if (cached) userMonitoringCache.delete(userMonitoringCacheKey);
      }
      const sendCost = (payload) => {
        if (userBrowse) {
          userMonitoringCache.set(userMonitoringCacheKey, {
            expiresAt: clock() + USER_MONITORING_CACHE_MS,
            payload
          });
        }
        res.json(payload);
      };
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
      const [storedBudgets, resourceActivity, userRunsRead, userActivityRead, rosterRead, personaRead] = await Promise.all([
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
        })),
        userBrowse ? readRosterForRequest(appkit.lakebase, req).then((roster) => ({ available: true, rows: roster.rows, reason: "" })).catch((error) => ({
          available: false,
          rows: [],
          reason: `Current app roles could not be read: ${error.message}`
        })) : Promise.resolve({ available: true, rows: [], reason: "" }),
        userBrowse ? Promise.all([listSpPersonas(appkit), listSpAssignments(appkit)]).then(([personas, assignments]) => ({ available: true, personas, assignments, reason: "" })).catch((error) => ({
          available: false,
          personas: [],
          assignments: [],
          reason: `Current persona assignments could not be read: ${error.message}`
        })) : Promise.resolve({ available: true, personas: [], assignments: [], reason: "" })
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
        genieAccounting: null,
        genieInstances: [],
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
      const userMonitoringFor = (spend) => {
        if (!userBrowse) return void 0;
        const seed = seedRoles();
        const roles = new Map(
          everyKnownUser({ seed, stored: rosterRead.rows }).map((entry) => [entry.email, entry.role])
        );
        for (const email of spend.users.map((profile) => profile.email)) {
          if (!roles.has(email)) roles.set(email, effectiveRole({ seed, stored: rosterRead.rows, email }));
        }
        const personaOptions = personaRead.personas.map((persona) => ({ id: persona.id, name: persona.displayName }));
        const personaNames = new Map(personaOptions.map((persona) => [persona.id, persona.name]));
        const personas = new Map(
          personaRead.assignments.flatMap((assignment) => {
            const name = personaNames.get(assignment.personaId);
            return name ? [[assignment.email.toLowerCase(), { id: assignment.personaId, name }]] : [];
          })
        );
        const personaReason = personaRead.available ? "" : personaRead.reason;
        return buildUserMonitoringPage({
          spend: rosterRead.available && personaRead.available ? spend : {
            ...spend,
            state: "partial",
            reason: [spend.reason, rosterRead.reason, personaReason].filter(Boolean).join(" ")
          },
          runs: userRunsRead.users,
          activity: userActivityRead.users,
          roles,
          personas,
          personaOptions,
          unit: userUnit,
          search: queryText(req, "userSearch"),
          role: userRole,
          persona: userPersona,
          cursor: queryText(req, "userCursor"),
          pageSize: Number(queryText(req, "pageSize")) || void 0
        });
      };
      const unavailableUserSpend = (tiles, reason) => buildSpendByUser({
        readAt,
        requestedRange: range,
        range: spendWindow.range,
        tiles,
        queryComplete: false,
        queryUsers: [],
        runs: userRunsRead.users,
        activity: {
          available: userActivityRead.available,
          users: userActivityRead.users,
          recordedFrom: userActivityRead.recordedFrom,
          recordedThrough: userActivityRead.recordedThrough
        },
        partialReason: reason
      });
      if (!workspace || !warehouse || !token) {
        const tiles = buildTiles(ids, [], EMPTY_WAREHOUSE_QUERY_ATTRIBUTION, resourceActivity);
        sendCost({
          ...empty,
          state: "no-warehouse",
          tiles,
          userMonitoring: userMonitoringFor(unavailableUserSpend(tiles, "Billing could not be read.")),
          reason: "Billing could not be read because this app has no SQL warehouse, no workspace address, or no forwarded sign-in to read it with. Nothing about spend was established."
        });
        return;
      }
      const built = buildCostStatement(ids, range);
      if (!built) {
        const tiles = buildTiles(ids, [], EMPTY_WAREHOUSE_QUERY_ATTRIBUTION, resourceActivity);
        sendCost({
          ...empty,
          state: "ready",
          tiles,
          userMonitoring: userMonitoringFor(unavailableUserSpend(tiles, "No billable app resources were resolved."))
        });
        return;
      }
      try {
        const genieStatement = buildGenieAccountingStatement(ids.workspaceId, range, ids.genieSpaces);
        const [outcome, queryAttribution, genieOutcome] = await Promise.all([
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
          }),
          genieStatement ? runStatement({
            host: workspace,
            token,
            warehouseId: warehouse,
            statement: genieStatement.statement,
            parameters: genieStatement.parameters,
            fetchImpl: deps.fetchImpl
          }) : Promise.resolve({ ok: false, message: "No workspace id is configured for Genie billing." })
        ]);
        const genieRows = genieOutcome.ok ? readGenieAccountingRows(genieOutcome.rows) : [];
        const genieMonth = genieOutcome.ok ? classifyGenieAccounting(genieRows, range.to, ids.genieSpaces) : null;
        const geniePeriod = genieOutcome.ok ? classifyGenieAccounting(
          genieRows.filter((row) => row.usageDay >= range.from && row.usageDay <= range.to),
          range.to,
          ids.genieSpaces
        ) : null;
        const genieAccounting = genieMonth && geniePeriod ? { month: genieMonth, period: geniePeriod } : null;
        const genieReason = genieOutcome.ok ? "" : `Genie billing could not be read: ${genieOutcome.message}`;
        const inventoryCount = resourceTagInventory({ environment: process.env, report: resolved.report }).length;
        if (!outcome.ok) {
          const denial = classifyDenial(outcome.message, "system.billing.usage");
          if (denial.kind === "no-grant") {
            const tiles3 = buildTiles(ids, [], queryAttribution, resourceActivity, null, genieReason);
            sendCost({
              ...empty,
              state: "no-grant",
              grant: billingGrant(userEmail(req) || UNKNOWN_PRINCIPAL),
              tiles: tiles3,
              userMonitoring: userMonitoringFor(unavailableUserSpend(tiles3, "Billing access is unavailable.")),
              reason: `You do not have ${denial.permission} on ${denial.object}, so no spend was read. Billing runs under your own grants rather than this app’s, so being an administrator here does not grant it. SELECT is needed on both system.billing.usage and system.billing.list_prices.`
            });
            return;
          }
          const tiles2 = buildTiles(ids, [], queryAttribution, resourceActivity, null, genieReason);
          sendCost({
            ...empty,
            state: "unreadable",
            tiles: tiles2,
            genieAccounting: genieMonth,
            genieInstances: geniePeriod?.instances ?? [],
            userMonitoring: userMonitoringFor(unavailableUserSpend(tiles2, "Billing could not be read.")),
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
          const tiles2 = buildTiles(ids, [], queryAttribution, resourceActivity, genieAccounting, genieReason);
          const reason = unpropagated.length ? "Matching usage exists without the Astrolabe tag, but exact resource attribution remains available." : delayed ? "No exact tracked-resource billing rows yet. Later days may still be filling." : "No billing rows matched an exact tracked resource.";
          sendCost({
            ...empty,
            state: "no-rows",
            tiles: tiles2,
            genieAccounting: genieMonth,
            genieInstances: geniePeriod?.instances ?? [],
            userMonitoring: userMonitoringFor(unavailableUserSpend(tiles2, reason)),
            currency: split.meta?.currency ?? "",
            throughDay: split.meta?.lastDay || "",
            billingLagDays: lagDays(range.to, split.meta?.lastDay || ""),
            coverage,
            honesty: buildHonesty(range, split.meta, tiles2),
            reason
          });
          return;
        }
        const tiles = buildTiles(
          ids,
          split.components,
          queryAttribution,
          resourceActivity,
          genieAccounting,
          genieReason
        );
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
          direct: geniePeriod?.users.flatMap(
            (user) => (user.instances ?? []).filter((instance) => Boolean(instance.spaceId)).map((instance) => ({
              email: user.identity,
              componentId: instance.tileId,
              quality: "direct",
              usd: instance.paidUsd,
              dbu: instance.chargedEffectiveDbus
            }))
          ) ?? [],
          partialReason: [
            spendWindow.partial ? "Individual spend is limited to the most recent 90 complete days because raw user telemetry is retained for 90 days." : "",
            userRunsRead.reason,
            userActivityRead.reason
          ].filter(Boolean).join(" ")
        });
        const spendWithGenie = genieMonth ? {
          ...spendByUser,
          users: spendByUser.users.map((profile) => {
            const allowance = genieMonth.users.find(
              (user) => user.identity.toLowerCase() === profile.email.toLowerCase()
            );
            return {
              ...profile,
              genieAllowance: allowance ? {
                month: genieMonth.month,
                usedDbus: allowance.allowanceUsedDbus,
                remainingDbus: allowance.allowanceRemainingDbus,
                promotionalDbus: allowance.promotionalDbus,
                chargedEffectiveDbus: allowance.chargedEffectiveDbus,
                chargedRawEquivalentDbus: allowance.chargedRawEquivalentDbus
              } : null
            };
          })
        } : spendByUser;
        cacheUserSpend(spendCacheKey, spendWithGenie, clock());
        const userMonitoring = userMonitoringFor(spendWithGenie);
        const selectedSpendByUser = spendUser ? {
          ...spendWithGenie,
          users: spendWithGenie.users.filter((profile) => profile.email.toLowerCase() === spendUser)
        } : userBrowse ? { ...spendWithGenie, users: [] } : spendWithGenie;
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
        sendCost({
          ...empty,
          state: "ready",
          currency: split.meta?.currency ?? tiles.find((tile) => tile.pricing?.currency)?.pricing?.currency ?? "",
          throughDay: split.meta?.lastDay || "",
          billingLagDays: lagDays(range.to, split.meta?.lastDay || ""),
          tiles,
          genieAccounting: genieMonth,
          genieInstances: geniePeriod?.instances ?? [],
          perQuestion,
          spendByUser: selectedSpendByUser,
          userMonitoring,
          coverage,
          honesty: buildHonesty(range, split.meta, tiles)
        });
      } catch (error) {
        const tiles = buildTiles(ids, [], EMPTY_WAREHOUSE_QUERY_ATTRIBUTION, resourceActivity);
        sendCost({
          ...empty,
          state: "unreadable",
          tiles,
          userMonitoring: userMonitoringFor(unavailableUserSpend(tiles, "Billing could not be read.")),
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
        const questionsPerDay = questions.status === "fulfilled" ? questions.value.rows.map((row) => ({ day: text2(row.day), count: count(row.count) })) : [];
        const distinctAskersPerDay = askers.status === "fulfilled" ? askers.value.rows.map((row) => ({ day: text2(row.day), count: count(row.count) })) : [];
        const activeMinutesPerDay = activeMinutes.status === "fulfilled" ? activeMinutes.value.rows.filter((row) => Boolean(text2(row.day))).map((row) => ({ day: text2(row.day), count: count(row.count) })) : [];
        const activityBounds = activeMinutes.status === "fulfilled" ? activeMinutes.value.rows[0] : void 0;
        const activityCoverageState = text2(activityBounds?.coverage_state);
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
          text2(rejected[0].reason?.message)
        ) : "";
        const coverageRead = activityCoverage?.state === "partial" ? `Recorded active app minutes have ${activityCoverage.missingDays} missing UTC rollup day(s); the returned days are partial rather than zero-filled.` : "";
        const payload = {
          readAt,
          range,
          reason: rejected.length === readCount ? `Nothing about traffic could be read: ${text2(rejected[0].reason?.message) || "the store did not answer"}` : "",
          unread: [partialRead, coverageRead].filter(Boolean).join(" "),
          questionsPerDay,
          distinctAskersPerDay,
          activeMinutesPerDay,
          activeMinutesTimeZone,
          activeMinutesRecordedFrom: text2(activityBounds?.recorded_from),
          activeMinutesRecordedThrough: text2(activityBounds?.recorded_through),
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
