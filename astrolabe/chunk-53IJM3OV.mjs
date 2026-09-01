
import {
  CONNECTED_RESOURCES
} from "./chunk-IE53KQ3R.mjs";
import {
  APP_SCHEMA
} from "./chunk-7DTM6FIL.mjs";

// shared/notebook-declaration.ts
var DECLARED_RESOURCE_TYPES = [
  "catalog",
  "schema",
  "table",
  "sql-warehouse",
  "serving-endpoint",
  "genie-space",
  "vector-search-endpoint",
  "vector-search-index",
  "volume"
];
var DECLARABLE_KEYS = {
  catalog_allowlist: {
    label: "Readable scopes",
    flow: "refused",
    reason: "The scopes this names are enumerated when the model is logged, and the table list it produces is what the serving principal is granted. Widening it from a published document would move a boundary Unity Catalog holds."
  },
  catalog_denylist: {
    label: "Excluded tables",
    flow: "needs-model-version",
    reason: "Applied when the table list is generated, before the model is logged. Narrowing takes a new model version, the same as widening."
  },
  warehouse_id: {
    label: "SQL warehouse",
    flow: "needs-model-version",
    reason: "Named as a resource on the model version, which is what grants the endpoint access to it."
  },
  data_genie_space_id: {
    label: "Data Genie space",
    flow: "needs-model-version",
    reason: "Named as a resource on the model version, which is what grants the endpoint access to it."
  },
  dictionary_genie_space_id: {
    label: "Dictionary Genie space",
    flow: "needs-model-version",
    reason: "Named as a resource on the model version, which is what grants the endpoint access to it."
  },
  llm_endpoint: {
    label: "Foundation model",
    flow: "needs-model-version",
    reason: "Read from the model artifact when the container starts."
  },
  max_output_tokens: {
    label: "Answer length limit",
    flow: "needs-model-version",
    reason: "Read from the model artifact when the container starts."
  },
  catalog: {
    label: "Unity Catalog catalog",
    flow: "needs-model-version",
    reason: "Read from the model artifact when the container starts."
  },
  schema: {
    label: "Unity Catalog schema",
    flow: "needs-model-version",
    reason: "Read from the model artifact when the container starts."
  },
  max_turns: {
    label: "Reasoning turn cap",
    flow: "needs-model-version",
    reason: "A loop bound inside the orchestrator. Nothing outside the model artifact is read for it."
  },
  knowledge_dir: {
    label: "Knowledge files",
    flow: "needs-model-version",
    reason: "Compiled into the model artifact when it is logged. The running endpoint opens no volume for it."
  },
  upload_volume: {
    label: "Attachment staging volume",
    flow: "needs-model-version",
    reason: "Compiled into the model artifact when it is logged."
  }
};
function declarationFlow(key) {
  return DECLARABLE_KEYS[key]?.flow ?? "needs-model-version";
}
var SCOPES_KEY = "catalog_allowlist";
var MAX_DECLARATION_BYTES = 64 * 1024;
var MAX_DECLARED_CONNECTIONS = 200;
var DECLARABLE_KINDS = [
  "genie-space",
  "sql-warehouse",
  "unity-catalog",
  "volume",
  "vector-search",
  "model"
];
function isDeclarableKind(value) {
  return typeof value === "string" && DECLARABLE_KINDS.includes(value);
}
function isDeclaredResourceType(value) {
  return typeof value === "string" && DECLARED_RESOURCE_TYPES.includes(value);
}
function field(value, limit = 500) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}
function parseDeclaration(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const document = raw;
  const settings = [];
  const seenKeys = /* @__PURE__ */ new Set();
  let emptyScopes = false;
  const rawSettings = document.settings;
  if (typeof rawSettings === "object" && rawSettings !== null && !Array.isArray(rawSettings)) {
    for (const [key, value] of Object.entries(rawSettings)) {
      const name = field(key, 120);
      const stated = field(value);
      if (name === SCOPES_KEY && !stated) emptyScopes = true;
      if (!name || !stated || seenKeys.has(name)) continue;
      seenKeys.add(name);
      settings.push({ key: name, value: stated });
    }
  }
  const connections = [];
  const seenIds = /* @__PURE__ */ new Set();
  const rawConnections = document.connections;
  if (Array.isArray(rawConnections)) {
    for (const entry of rawConnections.slice(0, MAX_DECLARED_CONNECTIONS)) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry;
      const id = field(record.id, 120);
      const value = field(record.value);
      if (!id || !value || seenIds.has(id) || !isDeclarableKind(record.kind)) continue;
      seenIds.add(id);
      connections.push({
        id,
        label: field(record.label, 200) || id,
        kind: record.kind,
        resourceType: isDeclaredResourceType(record.resourceType ?? record.resource_type) ? record.resourceType ?? record.resource_type : void 0,
        value,
        note: field(record.note)
      });
    }
  }
  if (settings.length === 0 && connections.length === 0) return null;
  return {
    source: field(document.source),
    revision: field(document.revision, 120),
    publishedAt: field(document.published_at ?? document.publishedAt, 60),
    publishedBy: field(document.published_by ?? document.publishedBy, 200),
    settings,
    connections,
    emptyScopes
  };
}
function compareDeclaration(declaration, live) {
  return declaration.settings.map((setting) => {
    const flow = declarationFlow(setting.key);
    const running = live[setting.key] ?? "";
    let verdict;
    if (!running) {
      verdict = "unknown";
    } else if (running === setting.value) {
      verdict = "agrees";
    } else {
      verdict = flow === "refused" ? "refused" : "pending";
    }
    return {
      key: setting.key,
      label: DECLARABLE_KEYS[setting.key]?.label ?? setting.key,
      declared: setting.value,
      live: running,
      flow,
      verdict
    };
  });
}

// server/lib/declared-connections.ts
var DECLARED_CONNECTIONS_QUERY = `
  SELECT id, label, kind, resource_type, value, note, state, origin, created_at, created_by, changed_at, changed_by
  FROM ${APP_SCHEMA}.declared_connections
  ORDER BY created_at, id`;
var UPSERT_DECLARED_CONNECTION_QUERY = `
  INSERT INTO ${APP_SCHEMA}.declared_connections
    (id, label, kind, resource_type, value, note, state, origin, created_by, changed_by, changed_at)
  VALUES ($1, $2, $3, $4, $5, $6, 'declared', $7, $8, $8, now())
  ON CONFLICT (id) DO UPDATE
    SET label = EXCLUDED.label,
        kind = EXCLUDED.kind,
        resource_type = EXCLUDED.resource_type,
        value = EXCLUDED.value,
        note = EXCLUDED.note,
        state = 'declared',
        origin = EXCLUDED.origin,
        changed_by = EXCLUDED.changed_by,
        changed_at = now()
  RETURNING id, label, kind, resource_type, value, note, state, origin, created_at, created_by, changed_at, changed_by`;
var WITHDRAW_DECLARED_CONNECTION_QUERY = `
  UPDATE ${APP_SCHEMA}.declared_connections
     SET state = 'withdrawn', changed_by = $2, changed_at = now()
   WHERE id = $1 AND state = 'declared'
  RETURNING id, label, kind, resource_type, value, note, state, origin, created_at, created_by, changed_at, changed_by`;
var RESTORE_DECLARED_CONNECTION_QUERY = `
  UPDATE ${APP_SCHEMA}.declared_connections
     SET state = 'declared', changed_by = $2, changed_at = now()
   WHERE id = $1 AND state = 'withdrawn'
  RETURNING id, label, kind, resource_type, value, note, state, origin, created_at, created_by, changed_at, changed_by`;
var FORGET_DECLARED_CONNECTION_QUERY = `
  WITH target AS (
    SELECT lower(btrim(id)) AS id,
           lower(btrim(kind)) AS kind,
           lower(btrim(coalesce(resource_type, ''))) AS resource_type,
           lower(btrim(value)) AS value
      FROM ${APP_SCHEMA}.declared_connections
     WHERE lower(btrim(id)) = lower(btrim($1))
     ORDER BY created_at, id
     LIMIT 1
  )
  DELETE FROM ${APP_SCHEMA}.declared_connections AS connection
   USING target
   WHERE lower(btrim(connection.id)) = target.id
      OR (
        lower(btrim(connection.kind)) = target.kind
        AND lower(btrim(coalesce(connection.resource_type, ''))) = target.resource_type
        AND lower(btrim(connection.value)) = target.value
      )
  RETURNING connection.id`;
function text(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
function timestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return text(value);
}
function storedFromRow(row) {
  const kind = text(row.kind);
  const resourceType = text(row.resource_type);
  return {
    id: text(row.id),
    label: text(row.label),
    // Read through the allowlist rather than cast. A kind that is no longer one
    // this build declares would otherwise reach the client as an icon lookup that
    // silently renders nothing.
    kind: DECLARABLE_KINDS.includes(kind) ? kind : "unity-catalog",
    resourceType: DECLARED_RESOURCE_TYPES.includes(resourceType) ? resourceType : void 0,
    value: text(row.value),
    note: text(row.note),
    state: row.state === "withdrawn" ? "withdrawn" : "declared",
    origin: row.origin === "notebook" ? "notebook" : "app",
    createdAt: timestamp(row.created_at),
    createdBy: text(row.created_by),
    changedAt: timestamp(row.changed_at),
    changedBy: text(row.changed_by)
  };
}
async function readDeclaredConnections(client) {
  try {
    const result = await client.lakebase.query(DECLARED_CONNECTIONS_QUERY);
    return (result?.rows ?? []).map(storedFromRow).filter((entry) => entry.id !== "");
  } catch (error) {
    console.warn("[connections] Declared connections could not be read:", error.message);
    return [];
  }
}
async function writeDeclaredConnection(client, connection) {
  const result = await client.lakebase.query(UPSERT_DECLARED_CONNECTION_QUERY, [
    connection.id,
    connection.label,
    connection.kind,
    connection.resourceType ?? "",
    connection.value,
    connection.note,
    connection.origin,
    connection.changedBy
  ]);
  const row = (result?.rows ?? [])[0];
  if (!row) throw new Error("the declared connection was not written back");
  return storedFromRow(row);
}
async function restoreDeclaredConnection(client, id, changedBy) {
  const result = await client.lakebase.query(RESTORE_DECLARED_CONNECTION_QUERY, [id, changedBy]);
  const row = (result?.rows ?? [])[0];
  return row ? storedFromRow(row) : null;
}
async function forgetDeclaredConnection(client, id) {
  const result = await client.lakebase.query(FORGET_DECLARED_CONNECTION_QUERY, [id]);
  return (result?.rows ?? []).map((row) => text(row.id)).filter(Boolean);
}
var ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,60}$/;
function addFault(input) {
  if (!ID_PATTERN.test(input.id)) {
    return "A name may use lower-case letters, digits and hyphens, must start with a letter or digit, and is between 2 and 61 characters.";
  }
  if (CONNECTED_RESOURCES.some((resource) => resource.id === input.id)) {
    return `${input.id} is already the name of one of this deployment's own settings. Choose another name.`;
  }
  if (!DECLARABLE_KINDS.includes(input.kind)) {
    return `${input.kind} is not a kind of asset that can be added here.`;
  }
  if (input.resourceType) {
    const expectedKind = {
      catalog: "unity-catalog",
      schema: "unity-catalog",
      table: "unity-catalog",
      volume: "volume",
      "sql-warehouse": "sql-warehouse",
      "serving-endpoint": "model",
      "genie-space": "genie-space",
      "vector-search-endpoint": "vector-search",
      "vector-search-index": "vector-search"
    };
    if (!DECLARED_RESOURCE_TYPES.includes(input.resourceType)) {
      return `${input.resourceType} is not a resource type that can be added here.`;
    }
    if (expectedKind[input.resourceType] !== input.kind) {
      return `${input.resourceType} does not match the submitted connection kind.`;
    }
  }
  if (!input.value.trim()) {
    return "An asset needs an identifier, such as a three-part table name.";
  }
  const value = input.value.trim();
  if (input.resourceType === "schema" && value.split(".").filter(Boolean).length !== 2) {
    return "A schema identifier must be catalog.schema.";
  }
  if ((input.resourceType === "table" || input.resourceType === "vector-search-index") && value.split(".").filter(Boolean).length !== 3) {
    return "This resource identifier must have three parts: catalog.schema.name.";
  }
  if (input.resourceType === "volume" && !/^\/Volumes\/[^/]+\/[^/]+\/[^/]+$/.test(value)) {
    return "A volume identifier must be /Volumes/catalog/schema/volume.";
  }
  return null;
}
function addedConnectionEffect() {
  return "Recorded as an asset the agent may consider. It grants nobody access: whether a person can read it is decided by their own Unity Catalog grants.";
}
function removalImpact(connection, liveValues) {
  const consequences = ["The agent stops being offered this asset when it chooses where to look."];
  const normalised = connection.value.trim().toLowerCase();
  const alsoLive = liveValues.some((value) => value.trim().toLowerCase() === normalised);
  if (alsoLive) {
    consequences.push(
      "The running agent is configured with this same value, so it keeps using it. Removing the row here changes what this page lists, not what the agent reaches."
    );
  }
  if (connection.origin === "notebook") {
    consequences.push("It was published from a notebook, so publishing again will add it back.");
  }
  return {
    headline: alsoLive ? `Remove ${connection.label} from the list. The running agent is configured with this value and keeps using it.` : `Remove ${connection.label} from the assets the agent may consider.`,
    consequences,
    recoverable: false
  };
}

export {
  DECLARED_RESOURCE_TYPES,
  declarationFlow,
  MAX_DECLARATION_BYTES,
  parseDeclaration,
  compareDeclaration,
  readDeclaredConnections,
  writeDeclaredConnection,
  restoreDeclaredConnection,
  forgetDeclaredConnection,
  addFault,
  addedConnectionEffect,
  removalImpact
};
