
import {
  liveConfiguration,
  readModelRelease,
  readOrchestratorReport
} from "./chunk-6UVAABB4.mjs";
import "./chunk-4JRNDRTQ.mjs";
import {
  DiscoveryPageCache,
  discoveryLimiter
} from "./chunk-FDCMDFAJ.mjs";
import "./chunk-MTXPHPGN.mjs";
import {
  userEmail
} from "./chunk-7SO7JJCQ.mjs";
import {
  executionToken,
  scopesFromToken,
  tokenScopeVerdict
} from "./chunk-4IYCA3Q2.mjs";
import "./chunk-RPJTQHME.mjs";
import {
  forgetStoredSettings,
  readStoredSettings
} from "./chunk-YG4YL534.mjs";
import {
  normalizeWorkspaceHost
} from "./chunk-VHHJDNLO.mjs";
import {
  recordAdminAction
} from "./chunk-XIJCYHNA.mjs";
import "./chunk-FHPVN4JA.mjs";
import "./chunk-LVHEQTRD.mjs";
import "./chunk-JLYA46HN.mjs";
import {
  external_exports
} from "./chunk-5DRRUJAY.mjs";
import {
  APP_SCHEMA
} from "./chunk-7DTM6FIL.mjs";
import "./chunk-LLUDDZ3A.mjs";

// shared/ai-gateway-contract.ts
var AiGatewayModeSchema = external_exports.enum(["", "mlflow", "openai"]);
var AiGatewayCandidateKindSchema = external_exports.enum(["model-service", "legacy-endpoint", "direct-endpoint"]);
var AiGatewayCapabilitiesSchema = external_exports.strictObject({
  rateLimits: external_exports.boolean(),
  budgetEnforcement: external_exports.boolean(),
  usageTracking: external_exports.boolean(),
  inferenceTable: external_exports.boolean(),
  guardrails: external_exports.boolean(),
  routingFallback: external_exports.boolean()
});
var EMPTY_AI_GATEWAY_CAPABILITIES = {
  rateLimits: false,
  budgetEnforcement: false,
  usageTracking: false,
  inferenceTable: false,
  guardrails: false,
  routingFallback: false
};
var EnforcementSourceSchema = external_exports.discriminatedUnion("source", [
  external_exports.strictObject({
    source: external_exports.literal("advisory-resource-budget"),
    label: external_exports.literal("Advisory"),
    approximate: external_exports.literal(false),
    blocksUsage: external_exports.literal(false),
    detail: external_exports.string(),
    identifier: external_exports.string()
  }),
  external_exports.strictObject({
    source: external_exports.literal("gateway-rate-limit"),
    label: external_exports.literal("Rate limited"),
    approximate: external_exports.literal(true),
    blocksUsage: external_exports.literal(true),
    detail: external_exports.string(),
    identifier: external_exports.string()
  }),
  external_exports.strictObject({
    source: external_exports.literal("gateway-block-usage-budget"),
    label: external_exports.literal("BLOCK_USAGE"),
    approximate: external_exports.literal(true),
    blocksUsage: external_exports.literal(true),
    detail: external_exports.string(),
    identifier: external_exports.string()
  }),
  external_exports.strictObject({
    source: external_exports.literal("unavailable"),
    label: external_exports.literal("Unavailable"),
    approximate: external_exports.literal(false),
    blocksUsage: external_exports.literal(false),
    detail: external_exports.string(),
    identifier: external_exports.string()
  })
]);
var AiGatewayCandidateSchema = external_exports.strictObject({
  id: external_exports.string(),
  displayName: external_exports.string(),
  kind: AiGatewayCandidateKindSchema,
  ready: external_exports.boolean(),
  readiness: external_exports.string(),
  compatibleModes: external_exports.array(AiGatewayModeSchema),
  capabilities: AiGatewayCapabilitiesSchema,
  enforcement: external_exports.array(EnforcementSourceSchema)
});
var AiGatewayValidationStateSchema = external_exports.enum(["validated", "invalid", "permission-blocked", "unavailable"]);
var AiGatewayValidationSchema = external_exports.strictObject({
  state: AiGatewayValidationStateSchema,
  detail: external_exports.string(),
  validatedAt: external_exports.string(),
  candidate: AiGatewayCandidateSchema.nullable()
});
var AiGatewayDiscoverySchema = external_exports.strictObject({
  status: external_exports.enum(["ok", "permission-blocked", "unavailable"]),
  items: external_exports.array(AiGatewayCandidateSchema),
  detail: external_exports.string(),
  pagination: external_exports.strictObject({
    pagesRead: external_exports.number().int().nonnegative(),
    pageCap: external_exports.number().int().positive(),
    capped: external_exports.boolean()
  })
});
var AiGatewaySelectionSchema = external_exports.strictObject({
  mode: AiGatewayModeSchema,
  candidateId: external_exports.string().trim().min(1).max(500),
  expectedRevision: external_exports.string().trim().min(1).max(200)
});
function gatewayTransport(mode) {
  if (mode === "mlflow") return "MLflow";
  if (mode === "openai") return "OpenAI";
  return "Direct";
}

// server/lib/ai-gateway.ts
import { createHash, randomUUID } from "node:crypto";
var AI_GATEWAY_TIMEOUT_MS = 1e4;
var AI_GATEWAY_PAGE_SIZE = 50;
var AI_GATEWAY_PAGE_CAP = 5;
var AI_GATEWAY_RESULT_CAP = 100;
var AI_GATEWAY_REVISION_RESOURCE = "ai-gateway-revision";
var MODEL_SERVICES_PATH = "/api/2.1/unity-catalog/model-services";
var SERVING_ENDPOINTS_PATH = "/api/2.0/serving-endpoints";
var ALLOWED_PATHS = [
  /^\/api\/2\.1\/unity-catalog\/model-services(?:\/[^/?]+)?$/,
  /^\/api\/2\.0\/serving-endpoints(?:\/[^/?]+)?$/
];
var pageCache = new DiscoveryPageCache();
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function text(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
function present(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(text(value));
}
function cacheKey(pathAndQuery, options) {
  const principal = options.principal.trim().toLowerCase();
  if (!principal || !options.token) return "";
  const token = createHash("sha256").update(options.token).digest("base64url").slice(0, 16);
  return `${principal}\0${token}\0${pathAndQuery}`;
}
function combinedSignal(options) {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? AI_GATEWAY_TIMEOUT_MS);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}
async function gatewayWorkspaceGet(path, query2, options) {
  if (!ALLOWED_PATHS.some((allowed) => allowed.test(path))) {
    throw new Error("AI Gateway discovery refused a path outside its allowlist.");
  }
  const search = new URLSearchParams(query2);
  const pathAndQuery = search.size ? `${path}?${search.toString()}` : path;
  const key = options.cache === false ? "" : cacheKey(pathAndQuery, options);
  const cached = key ? pageCache.get(key) : void 0;
  if (cached) return cached;
  const signal = combinedSignal(options);
  const response = await discoveryLimiter.run(
    signal,
    () => (options.fetchImpl ?? fetch)(`${options.host}${pathAndQuery}`, {
      method: "GET",
      headers: { authorization: `Bearer ${options.token}`, accept: "application/json" },
      signal
    })
  );
  const raw = await response.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`The workspace returned malformed JSON for ${path}.`);
  }
  const answer = {
    status: response.status,
    body: raw,
    etag: response.headers.get("etag")?.trim() ?? ""
  };
  if (key && response.ok) pageCache.set(key, answer);
  return answer;
}
function readiness(body, kind) {
  const state = record(body.state);
  const value = (text(state.ready) || text(state.status) || text(body.readiness) || text(body.status) || text(body.state)).toUpperCase();
  const updating = text(state.config_update).toUpperCase();
  const ready = ["READY", "ACTIVE", "ONLINE"].includes(value) && !["UPDATING", "IN_PROGRESS"].includes(updating);
  return { ready, label: value || (kind === "model-service" ? "UNKNOWN" : "NOT_READY") };
}
function actionOf(value) {
  const object = record(value);
  return (text(object.action) || text(object.enforcement_action) || text(object.behavior) || text(object.mode) || text(object.action_type)).toUpperCase();
}
function gatewayConfiguration(body, kind) {
  if (kind === "model-service") return record(body.config);
  return record(body.ai_gateway);
}
function capabilitySummary(body, kind, identifier) {
  const config = gatewayConfiguration(body, kind);
  const usage = config.usage ?? config.usage_tracking ?? config.usage_tracking_config;
  const inference = config.inference_table ?? config.inference_table_config;
  const rateLimits = config.rate_limits ?? config.rate_limit;
  const budget = config.budget ?? config.budget_policy ?? record(usage).budget ?? body.budget_policy;
  const fallback = config.fallback ?? config.fallback_config;
  const capabilities = {
    rateLimits: present(rateLimits),
    budgetEnforcement: actionOf(budget) === "BLOCK_USAGE",
    usageTracking: present(usage),
    inferenceTable: present(inference),
    guardrails: present(config.guardrails),
    routingFallback: present(config.routing) || present(fallback)
  };
  const enforcement = [];
  if (capabilities.rateLimits) {
    enforcement.push({
      source: "gateway-rate-limit",
      label: "Rate limited",
      approximate: true,
      blocksUsage: true,
      detail: "Returns 429 near the configured limit; bounded overshoot is possible, so enforcement is approximate.",
      identifier
    });
  }
  if (capabilities.budgetEnforcement) {
    enforcement.push({
      source: "gateway-block-usage-budget",
      label: "BLOCK_USAGE",
      approximate: true,
      blocksUsage: true,
      detail: "Blocks usage from near-real-time budget data. This is approximate, not an exact spending ceiling.",
      identifier
    });
  }
  return { capabilities, enforcement };
}
function typeName(body) {
  return (text(body.endpoint_type) || text(body.service_type) || text(body.type) || text(record(body.config).endpoint_type)).toUpperCase();
}
function unsupportedType(body) {
  const type = typeName(body);
  return type.includes("AGENT") || type.includes("CUSTOM");
}
function foundationEndpoint(body) {
  const type = typeName(body);
  if (/(FOUNDATION|PAY_PER_TOKEN|EXTERNAL_MODEL|FMAPI)/.test(type)) return true;
  const config = record(body.config);
  const entities = Array.isArray(config.served_entities) ? config.served_entities.map(record) : Array.isArray(body.served_entities) ? body.served_entities.map(record) : [];
  return entities.length > 0 && entities.every((entity) => {
    const name = text(entity.entity_name) || text(entity.name);
    return name.startsWith("system.ai.") || present(entity.external_model);
  });
}
function candidateFromBody(body, kind, mode) {
  const id = text(body.full_name) || text(body.name) || text(body.id);
  if (!id || unsupportedType(body)) return null;
  if (kind !== "model-service" && !foundationEndpoint(body)) return null;
  const gateway = gatewayConfiguration(body, kind);
  if (kind === "legacy-endpoint" && !present(gateway)) return null;
  const state = readiness(body, kind);
  const safe = capabilitySummary(body, kind, id);
  const compatibleModes = kind === "model-service" ? ["mlflow", "openai"] : kind === "direct-endpoint" ? [""] : present(gateway.openai_compatible) || text(gateway.api_format).toUpperCase().includes("OPENAI") ? ["mlflow", "openai"] : ["mlflow"];
  if (!compatibleModes.includes(mode)) return null;
  return {
    id,
    displayName: text(body.display_name) || id,
    kind,
    ready: state.ready,
    readiness: state.label,
    compatibleModes,
    capabilities: kind === "direct-endpoint" ? EMPTY_AI_GATEWAY_CAPABILITIES : safe.capabilities,
    enforcement: kind === "direct-endpoint" ? [] : safe.enforcement
  };
}
function listRows(body, keys) {
  for (const key of keys) {
    if (Array.isArray(body[key])) return body[key].map(record);
  }
  return null;
}
async function listFamily(path, keys, options) {
  const rows = [];
  let token = "";
  let pages = 0;
  do {
    pages += 1;
    const query2 = { max_results: String(AI_GATEWAY_PAGE_SIZE) };
    if (token) query2.page_token = token;
    const answer = await gatewayWorkspaceGet(path, query2, options);
    if (answer.status === 401 || answer.status === 403) {
      const denied = new Error("permission-blocked");
      Object.assign(denied, { status: answer.status });
      throw denied;
    }
    if (answer.status < 200 || answer.status >= 300) throw new Error(`workspace HTTP ${answer.status}`);
    const found = listRows(answer.body, keys);
    if (!found) throw new Error(`The workspace returned a malformed ${path} list.`);
    rows.push(...found.map((body) => ({ body, etag: answer.etag })));
    token = text(answer.body.next_page_token) || text(answer.body.nextPageToken);
  } while (token && pages < AI_GATEWAY_PAGE_CAP && rows.length < AI_GATEWAY_RESULT_CAP);
  return { rows: rows.slice(0, AI_GATEWAY_RESULT_CAP), pages, capped: Boolean(token) };
}
async function endpointDetail(summary, options) {
  const name = text(summary.name) || text(summary.id);
  if (!name) return null;
  const answer = await gatewayWorkspaceGet(`${SERVING_ENDPOINTS_PATH}/${encodeURIComponent(name)}`, {}, options);
  if (answer.status < 200 || answer.status >= 300) return null;
  return { body: answer.body, etag: answer.etag };
}
async function discoverAiGatewayCandidates(input) {
  if (!input.options.host || !input.options.token) {
    return {
      status: "permission-blocked",
      items: [],
      detail: "The signed-in user token needed for workspace metadata discovery was not available.",
      pagination: { pagesRead: 0, pageCap: AI_GATEWAY_PAGE_CAP, capped: false }
    };
  }
  try {
    const families = input.mode === "" ? [] : [listFamily(MODEL_SERVICES_PATH, ["model_services", "services"], input.options)];
    const [services, endpoints] = await Promise.all([
      families[0] ?? Promise.resolve({ rows: [], pages: 0, capped: false }),
      listFamily(SERVING_ENDPOINTS_PATH, ["endpoints", "serving_endpoints"], input.options)
    ]);
    const detailed = await Promise.all(endpoints.rows.map((entry) => endpointDetail(entry.body, input.options)));
    const candidates = [
      ...services.rows.map((entry) => candidateFromBody(entry.body, "model-service", input.mode)),
      ...detailed.map(
        (entry) => entry ? candidateFromBody(entry.body, input.mode === "" ? "direct-endpoint" : "legacy-endpoint", input.mode) : null
      )
    ].filter((entry) => Boolean(entry));
    const query2 = input.query.trim().toLowerCase();
    const items = candidates.filter((entry) => !query2 || `${entry.displayName}
${entry.id}`.toLowerCase().includes(query2)).slice(0, AI_GATEWAY_RESULT_CAP);
    return {
      status: "ok",
      items,
      detail: "",
      pagination: {
        pagesRead: services.pages + endpoints.pages,
        pageCap: AI_GATEWAY_PAGE_CAP,
        capped: services.capped || endpoints.capped
      }
    };
  } catch (error) {
    const permission = error.status === 403 || error.message === "permission-blocked";
    return {
      status: permission ? "permission-blocked" : "unavailable",
      items: [],
      detail: permission ? "The workspace refused metadata discovery for this signed-in user." : `Gateway discovery is unavailable: ${error.message}`,
      pagination: { pagesRead: 0, pageCap: AI_GATEWAY_PAGE_CAP, capped: false }
    };
  }
}
function invocationPlausible(token) {
  const scopes = scopesFromToken(token);
  if (scopes === null) return true;
  return tokenScopeVerdict(scopes, "model-serving") !== false || tokenScopeVerdict(scopes, "serving.serving-endpoints") !== false;
}
async function validateAiGatewayCandidate(input) {
  const validatedAt = (/* @__PURE__ */ new Date()).toISOString();
  if (!input.options.host || !input.options.token) {
    return {
      state: "permission-blocked",
      detail: "A signed-in user token was not available for metadata validation.",
      validatedAt,
      candidate: null
    };
  }
  if (!invocationPlausible(input.options.token)) {
    return {
      state: "permission-blocked",
      detail: "The forwarded sign-in does not carry a Model Serving scope, so invocation permission is not plausible.",
      validatedAt,
      candidate: null
    };
  }
  const encoded = encodeURIComponent(input.candidateId.trim());
  const paths = input.mode === "" ? [{ path: `${SERVING_ENDPOINTS_PATH}/${encoded}`, kind: "direct-endpoint" }] : [
    { path: `${MODEL_SERVICES_PATH}/${encoded}`, kind: "model-service" },
    { path: `${SERVING_ENDPOINTS_PATH}/${encoded}`, kind: "legacy-endpoint" }
  ];
  let refused = false;
  try {
    for (const target of paths) {
      const answer = await gatewayWorkspaceGet(target.path, {}, { ...input.options, cache: false });
      if (answer.status === 401 || answer.status === 403) {
        refused = true;
        continue;
      }
      if (answer.status === 404) continue;
      if (answer.status < 200 || answer.status >= 300) {
        return {
          state: "unavailable",
          detail: `The workspace returned HTTP ${answer.status} while validating the candidate.`,
          validatedAt,
          candidate: null
        };
      }
      const candidate = candidateFromBody(answer.body, target.kind, input.mode);
      if (!candidate) {
        return {
          state: "invalid",
          detail: "The resource is not a supported foundation model service or AI-Gateway-enabled endpoint for this mode.",
          validatedAt,
          candidate: null
        };
      }
      if (!candidate.ready) {
        return {
          state: "unavailable",
          detail: `The resource exists but is not ready (${candidate.readiness}).`,
          validatedAt,
          candidate,
          etag: answer.etag
        };
      }
      return {
        state: "validated",
        detail: "Metadata is readable, the resource is ready, and Model Serving invocation permission is plausible. No model request was sent.",
        validatedAt,
        candidate,
        etag: answer.etag
      };
    }
  } catch (error) {
    const name = error.name;
    return {
      state: name === "AbortError" || name === "TimeoutError" ? "unavailable" : "unavailable",
      detail: `The workspace could not complete validation: ${error.message}`,
      validatedAt,
      candidate: null
    };
  }
  return {
    state: refused ? "permission-blocked" : "invalid",
    detail: refused ? "The workspace refused metadata access to the selected resource." : "The selected resource does not exist in this workspace.",
    validatedAt,
    candidate: null
  };
}
function parseMetadata(note) {
  try {
    const value = JSON.parse(note);
    if ((value.mode === "" || value.mode === "mlflow" || value.mode === "openai") && typeof value.candidateId === "string" && typeof value.validatedAt === "string" && typeof value.revision === "string") {
      return {
        mode: value.mode,
        candidateId: value.candidateId,
        validatedAt: value.validatedAt,
        etag: typeof value.etag === "string" ? value.etag : "",
        revision: value.revision
      };
    }
  } catch {
  }
  return null;
}
function gatewayRevision(stored) {
  return stored.get(AI_GATEWAY_REVISION_RESOURCE)?.value.trim() || "0";
}
async function stageAiGatewaySelection(input) {
  const revision = randomUUID();
  const note = JSON.stringify({
    mode: input.mode,
    candidateId: input.candidateId,
    validatedAt: input.validation.validatedAt,
    etag: input.validation.etag ?? "",
    revision
  });
  const result = await input.store.lakebase.query(
    `WITH gate AS (
       SELECT pg_advisory_xact_lock(hashtext('astrolabe-ai-gateway-stage'))
     ), current AS (
       SELECT COALESCE(
         (SELECT value FROM ${APP_SCHEMA}.deployment_settings WHERE resource_id = $1),
         '0'
       ) AS revision
       FROM gate
     ), accepted AS (
       SELECT 1 FROM current WHERE revision = $2
     ), written AS (
       INSERT INTO ${APP_SCHEMA}.deployment_settings
         (resource_id, value, intent, note, updated_by, updated_at)
       SELECT row.resource_id, row.value, 'intended', row.note, $3, now()
       FROM (VALUES
         ('llm-gateway', $4, $6),
         ('llm-endpoint', $5, $6),
         ($1, $7, '')
       ) AS row(resource_id, value, note)
       CROSS JOIN accepted
       ON CONFLICT (resource_id) DO UPDATE
         SET value = EXCLUDED.value,
             intent = EXCLUDED.intent,
             note = EXCLUDED.note,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()
       RETURNING resource_id, updated_at
     )
     SELECT resource_id, updated_at FROM written`,
    [AI_GATEWAY_REVISION_RESOURCE, input.expectedRevision, input.actor, input.mode, input.candidateId, note, revision]
  );
  if (result.rows.length !== 3) return { ok: false, reason: "stale" };
  forgetStoredSettings();
  const stamp = result.rows.find((row) => row.resource_id === AI_GATEWAY_REVISION_RESOURCE)?.updated_at;
  return {
    ok: true,
    revision,
    stagedAt: stamp instanceof Date ? stamp.toISOString() : text(stamp) || input.validation.validatedAt
  };
}
function summarizeAiGateway(input) {
  const activeMode = input.activeMode === "mlflow" || input.activeMode === "openai" ? input.activeMode : "";
  const gateway = input.stored.get("llm-gateway");
  const model = input.stored.get("llm-endpoint");
  const metadata = parseMetadata(gateway?.note ?? "");
  const coherent = gateway?.intent === "intended" && model?.intent === "intended" && metadata?.candidateId === model.value && metadata.mode === gateway.value && metadata.revision === gatewayRevision(input.stored);
  const staged = coherent && metadata ? { mode: metadata.mode, model: metadata.candidateId, transport: gatewayTransport(metadata.mode) } : null;
  const invalid = Boolean(gateway || model) && !coherent;
  return {
    active: { mode: activeMode, model: input.activeModel.trim(), transport: gatewayTransport(activeMode) },
    staged,
    configurationState: invalid ? "invalid" : staged ? input.validation && input.validation.state !== "validated" ? input.validation.state === "unavailable" ? "unavailable" : "invalid" : "staged" : "active",
    detail: invalid ? "A legacy partial Gateway intention exists. Select and stage the transport and model together." : staged ? input.validation?.detail || "Staged for agent release." : activeMode ? input.validation?.detail || "The running model version reports this Gateway route." : "Direct model traffic remains active.",
    validatedAt: input.validation?.validatedAt || metadata?.validatedAt || "",
    revision: gatewayRevision(input.stored),
    candidate: input.validation?.candidate ?? null,
    rollback: "Stage Direct with the existing foundation endpoint, then use the normal confirmed agent release."
  };
}

// server/routes/ai-gateway-routes.ts
var AI_GATEWAY_ROUTE_DEADLINE_MS = 12e3;
function query(req, key, max = 200) {
  const value = req.query[key];
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function requestOptions(req, res) {
  const disconnected = new AbortController();
  const onAbort = () => disconnected.abort(new DOMException("Client disconnected", "AbortError"));
  const onClose = () => {
    if (!res.writableEnded) onAbort();
  };
  req.once("aborted", onAbort);
  res.once("close", onClose);
  return {
    options: {
      host: normalizeWorkspaceHost(process.env.DATABRICKS_HOST),
      token: executionToken(req) ?? "",
      principal: userEmail(req),
      signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(AI_GATEWAY_ROUTE_DEADLINE_MS)])
    },
    cleanup: () => {
      req.off("aborted", onAbort);
      res.off("close", onClose);
    }
  };
}
function statusForValidation(state) {
  if (state === "permission-blocked") return 403;
  if (state === "unavailable") return 503;
  if (state === "invalid") return 400;
  return 200;
}
function browserValidation(validation) {
  return {
    state: validation.state,
    detail: validation.detail,
    validatedAt: validation.validatedAt,
    candidate: validation.candidate
  };
}
async function currentSummary(req, res, appkit) {
  const stored = await readStoredSettings(appkit);
  const { report } = await readOrchestratorReport();
  const active = liveConfiguration(report);
  const gateway = stored.get("llm-gateway");
  const model = stored.get("llm-endpoint");
  const stagedMode = gateway?.intent === "intended" ? AiGatewayModeSchema.safeParse(gateway.value) : null;
  const mode = stagedMode?.success ? stagedMode.data : void 0;
  const candidateId = model?.intent === "intended" ? model.value.trim() : "";
  const { options, cleanup } = requestOptions(req, res);
  try {
    const validation = mode !== void 0 && candidateId ? await validateAiGatewayCandidate({ mode, candidateId, options }) : active.llm_gateway && active.llm_endpoint ? await validateAiGatewayCandidate({
      mode: active.llm_gateway,
      candidateId: active.llm_endpoint,
      options
    }) : void 0;
    if (!res.destroyed && !res.writableEnded) {
      res.json(
        summarizeAiGateway({
          activeMode: active.llm_gateway ?? "",
          activeModel: active.llm_endpoint ?? "",
          stored,
          validation
        })
      );
    }
  } finally {
    cleanup();
  }
}
function setupAiGatewayRoutes(appkit) {
  appkit.server.extend((app) => {
    app.get("/api/admin/ai-gateway/summary", async (req, res) => {
      await currentSummary(req, res, appkit);
    });
    app.get("/api/admin/ai-gateway/candidates", async (req, res) => {
      const mode = AiGatewayModeSchema.safeParse(query(req, "mode", 20));
      if (!mode.success) {
        res.status(400).json({ error: "invalid_gateway_mode", detail: "Choose Direct, MLflow, or OpenAI." });
        return;
      }
      const { options, cleanup } = requestOptions(req, res);
      try {
        const payload = await discoverAiGatewayCandidates({
          mode: mode.data,
          query: query(req, "q"),
          options
        });
        if (!res.destroyed && !res.writableEnded) res.json(payload);
      } finally {
        cleanup();
      }
    });
    app.post("/api/admin/ai-gateway/validate", async (req, res) => {
      const parsed = AiGatewaySelectionSchema.omit({ expectedRevision: true }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_gateway_selection", detail: parsed.error.message });
        return;
      }
      const { options, cleanup } = requestOptions(req, res);
      try {
        const validation = await validateAiGatewayCandidate({ ...parsed.data, options });
        if (!res.destroyed && !res.writableEnded) {
          res.status(statusForValidation(validation.state)).json(browserValidation(validation));
        }
      } finally {
        cleanup();
      }
    });
    app.post("/api/admin/ai-gateway/stage", async (req, res) => {
      const parsed = AiGatewaySelectionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_gateway_selection", detail: parsed.error.message });
        return;
      }
      const { options, cleanup } = requestOptions(req, res);
      try {
        const validation = await validateAiGatewayCandidate({
          mode: parsed.data.mode,
          candidateId: parsed.data.candidateId,
          options
        });
        if (validation.state !== "validated") {
          res.status(statusForValidation(validation.state)).json(validation);
          return;
        }
        const staged = await stageAiGatewaySelection({
          store: appkit,
          ...parsed.data,
          actor: userEmail(req),
          validation
        });
        if (!staged.ok) {
          res.status(409).json({
            error: "stale_gateway_selection",
            detail: "Gateway settings changed after this form was opened. Reload and review the current pair."
          });
          return;
        }
        await recordAdminAction(appkit.lakebase, {
          actor: userEmail(req),
          action: "ai-gateway-selection-staged",
          subject: parsed.data.candidateId,
          detail: `Staged ${parsed.data.mode || "direct"} transport and model as one intended pair.`
        });
        res.json({
          state: "validated",
          detail: "Staged for agent release. Existing direct model traffic is unchanged.",
          validatedAt: validation.validatedAt,
          candidate: validation.candidate,
          revision: staged.revision,
          stagedAt: staged.stagedAt
        });
      } finally {
        cleanup();
      }
    });
    app.post("/api/admin/ai-gateway/releases/:id/validate", async (req, res) => {
      const release = await readModelRelease(appkit, req.params.id);
      if (!release) {
        res.status(404).json({ error: "no_such_release_request" });
        return;
      }
      const settings = release.declaration.settings;
      if (!Object.prototype.hasOwnProperty.call(settings, "llm_gateway")) {
        res.json({ state: "validated", detail: "This release does not change AI Gateway routing." });
        return;
      }
      const mode = AiGatewayModeSchema.safeParse(settings.llm_gateway);
      const candidateId = (settings.llm_endpoint ?? "").trim();
      if (!mode.success || !candidateId) {
        res.status(409).json({
          error: "invalid_gateway_release_pair",
          detail: "The approved release does not contain a coherent Gateway mode and foundation model pair."
        });
        return;
      }
      const { options, cleanup } = requestOptions(req, res);
      try {
        const validation = await validateAiGatewayCandidate({ mode: mode.data, candidateId, options });
        const status = validation.state === "validated" ? 200 : 409;
        res.status(status).json(browserValidation(validation));
      } finally {
        cleanup();
      }
    });
  });
}
export {
  AI_GATEWAY_ROUTE_DEADLINE_MS,
  setupAiGatewayRoutes
};
