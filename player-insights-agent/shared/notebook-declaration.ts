/**
 * A notebook as a connection, and the narrow set of its declarations that can
 * reach a running deployment without a new model version.
 *
 * WHY THIS EXISTS. The orchestrator's configuration is baked into the MLflow
 * model artifact at log time (`agent/config.py`: every field is
 * `BAKED_AT_LOG_TIME`). The serving container inherits nothing from the shell
 * that logged it, and the table list baked beside those values is what automatic
 * authentication passthrough grants the serving principal. So a notebook cannot
 * hand the running agent a new setting, and the honest thing to build is not a
 * pretence that it can.
 *
 * What a notebook CAN do is PUBLISH what it intends. This module is the contract
 * for that document, plus the one decision that matters: for each declared key,
 * whether saying it in a notebook changes anything now, changes nothing until the
 * model is re-logged, or is refused outright because applying it would widen what
 * a person can read.
 *
 * THE THIRD CASE IS NOT A LIMITATION TO BE ENGINEERED AWAY. `catalog_allowlist`
 * generates the declared manifest, the manifest is what passthrough grants, and
 * the SQL guard refuses anything outside it. A notebook that could widen that
 * list at runtime would move the boundary Unity Catalog is supposed to hold, from
 * a document the app read over the network. It is refused here, by name, so that
 * a later reader looking for the wiring finds the reason instead.
 *
 * WHAT A DECLARATION IS NOT. It is not a grant. Publishing an asset here means
 * "the deployment intends the agent to consider this", never "this person may now
 * read it". Unity Catalog decides the second, per reader, by their own grants.
 * Every surface that shows a declaration has to say so, because a reader will
 * assume the opposite.
 */
import type { ResourceKind } from './deployment-config';

/** The concrete resource shape shown by the Connections add flow. */
export const DECLARED_RESOURCE_TYPES = [
  'catalog',
  'schema',
  'table',
  'sql-warehouse',
  'serving-endpoint',
  'genie-space',
  'vector-search-endpoint',
  'vector-search-index',
  'volume',
] as const;

export type DeclaredResourceType = (typeof DECLARED_RESOURCE_TYPES)[number];

/**
 * What publishing a value in a notebook actually achieves.
 *
 * Three outcomes rather than a boolean, because "does nothing yet" and "will
 * never be done" are different promises and a reader who cannot tell them apart
 * waits for the wrong thing.
 */
export type DeclarationFlow =
  /** The app reads it per request. A published value is in force on the next one. */
  | 'flows'
  /** Baked into the model artifact. Recorded, and inert until the model is re-logged. */
  | 'needs-model-version'
  /** Refused. Applying it could widen what a reader can reach. */
  | 'refused';

/** The sentence each outcome owes a reader, and whether it is already in force. */
export const DECLARATION_FLOW: Record<DeclarationFlow, { label: string; note: string; inForce: boolean }> = {
  flows: {
    label: 'In force',
    note: 'The app reads this on every request, so the published value is already being used.',
    inForce: true,
  },
  'needs-model-version': {
    label: 'Recorded',
    note: 'Baked into the model artifact when the agent was logged. The published value is recorded here and is not in use until the model is logged again.',
    inForce: false,
  },
  refused: {
    label: 'Not applied',
    note: 'This decides which tables the agent is granted. It is read from the model artifact only, so a published value is shown for comparison and never applied.',
    inForce: false,
  },
};

/**
 * Every key a notebook may publish, and what publishing it achieves.
 *
 * Keyed by the `agent/config.py` field name where there is one, so a declaration
 * lines up against `configuration_report()` without a translation table. The
 * three with no agent field are notebook-only knobs that have no counterpart in
 * the deployment at all; they are listed rather than dropped, because a reader
 * comparing the two documents needs to be told that, not left to infer it from an
 * absence.
 */
export const DECLARABLE_KEYS: Record<string, { label: string; flow: DeclarationFlow; reason: string }> = {
  catalog_allowlist: {
    label: 'Readable scopes',
    flow: 'refused',
    reason:
      'The scopes this names are enumerated when the model is logged, and the table list it produces is what the serving principal is granted. Widening it from a published document would move a boundary Unity Catalog holds.',
  },
  catalog_denylist: {
    label: 'Excluded tables',
    flow: 'needs-model-version',
    reason:
      'Applied when the table list is generated, before the model is logged. Narrowing takes a new model version, the same as widening.',
  },
  warehouse_id: {
    label: 'SQL warehouse',
    flow: 'needs-model-version',
    reason: 'Named as a resource on the model version, which is what grants the endpoint access to it.',
  },
  data_genie_space_id: {
    label: 'Data Genie space',
    flow: 'needs-model-version',
    reason: 'Named as a resource on the model version, which is what grants the endpoint access to it.',
  },
  dictionary_genie_space_id: {
    label: 'Dictionary Genie space',
    flow: 'needs-model-version',
    reason: 'Named as a resource on the model version, which is what grants the endpoint access to it.',
  },
  llm_endpoint: {
    label: 'Foundation model',
    flow: 'needs-model-version',
    reason: 'Read from the model artifact when the container starts.',
  },
  max_output_tokens: {
    label: 'Answer length limit',
    flow: 'needs-model-version',
    reason: 'Read from the model artifact when the container starts.',
  },
  catalog: {
    label: 'Unity Catalog catalog',
    flow: 'needs-model-version',
    reason: 'Read from the model artifact when the container starts.',
  },
  schema: {
    label: 'Unity Catalog schema',
    flow: 'needs-model-version',
    reason: 'Read from the model artifact when the container starts.',
  },
  max_turns: {
    label: 'Reasoning turn cap',
    flow: 'needs-model-version',
    reason: 'A loop bound inside the orchestrator. Nothing outside the model artifact is read for it.',
  },
  knowledge_dir: {
    label: 'Knowledge files',
    flow: 'needs-model-version',
    reason: 'Compiled into the model artifact when it is logged. The running endpoint opens no volume for it.',
  },
  upload_volume: {
    label: 'Attachment staging volume',
    flow: 'needs-model-version',
    reason: 'Compiled into the model artifact when it is logged.',
  },
};

/** Whether this deployment recognises a declared key at all. */
export function isDeclarableKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(DECLARABLE_KEYS, key);
}

/**
 * What publishing this key achieves, for a key that may not be one we know.
 *
 * An unknown key is `needs-model-version` rather than `flows`: a notebook that
 * publishes something this build has never heard of must not have it reported as
 * being in force. The two documents version separately, and a newer notebook
 * naming a newer setting is the normal case rather than a fault.
 */
export function declarationFlow(key: string): DeclarationFlow {
  return DECLARABLE_KEYS[key]?.flow ?? 'needs-model-version';
}

/**
 * An asset a notebook or an administrator says the agent should consider.
 *
 * `value` is the identifier as published. It is never resolved, probed or
 * expanded here: this is a record of intent, and the reachability answer belongs
 * to the reader's own grants.
 */
export interface DeclaredConnection {
  /** Stable key within the declaration. */
  id: string;
  label: string;
  kind: ResourceKind;
  /**
   * The concrete resource category selected by the publisher.
   *
   * Optional for declarations and stored rows written before the category was
   * persisted. Readers infer a safe label from `kind`/`value` in that case.
   */
  resourceType?: DeclaredResourceType;
  /** The identifier as published, e.g. a three-part table name. */
  value: string;
  /** Free text the publisher left. Shown as given, never parsed. */
  note: string;
}

/** One published setting, as the notebook stated it. */
export interface DeclaredSetting {
  key: string;
  value: string;
}

/**
 * What a notebook published, and enough about the publishing to judge it.
 *
 * `revision` and `publishedAt` are the notebook's own account of itself. Neither
 * is trusted for anything but display: a declaration is a document fetched over
 * the network, and the only fact this app establishes about it is that it could
 * be read under the reader's own credential.
 */
export interface NotebookDeclaration {
  /** Where the declaration was published from, for a reader to go and look. */
  source: string;
  /** The publisher's own revision marker. Empty when it published none. */
  revision: string;
  publishedAt: string;
  publishedBy: string;
  settings: DeclaredSetting[];
  connections: DeclaredConnection[];
  /**
   * The declaration named the readable-scopes key and left it empty.
   *
   * THE ONE EMPTY VALUE THAT IS NOT AN ABSENCE. Every other key published with
   * no value is dropped, because "published as nothing" and "not published" are
   * the same intent. This one is recorded, because the two documents read an
   * empty scopes list OPPOSITELY: a notebook that sets it to `[]` means no
   * restriction, and `Settings.from_env` reads an empty one as the deployment's
   * own catalog (`resolved["catalog_allowlist"] or catalog`), which
   * `discovery_scopes` then resolves to its configured schema. So the same
   * empty value means "everything" upstream and "one schema" here, in the one
   * setting that decides what the agent may read.
   *
   * Recorded rather than reconciled. Which meaning is correct is a decision
   * about the notebook, not something to silently pick a side of here. All this
   * flag buys is that the tab can state what THIS deployment does with an empty
   * value, so a reader can tell the two apart instead of concluding the app
   * ignored their notebook.
   */
  emptyScopes: boolean;
}

/** The key whose empty value the two documents disagree about. */
export const SCOPES_KEY = 'catalog_allowlist';

/** The largest declaration this app will read, in bytes. */
export const MAX_DECLARATION_BYTES = 64 * 1024;

/** The most connections one declaration may carry. */
export const MAX_DECLARED_CONNECTIONS = 200;

/**
 * Every `ResourceKind` a declaration may name.
 *
 * An allowlist rather than the full `ResourceKind` union: a declaration is
 * untrusted input, and the kinds it may claim are the ones that name an asset a
 * reader could hold a grant on. `app-behaviour` and `observability` describe the
 * app's own wiring and are not a customer's to publish.
 */
export const DECLARABLE_KINDS: readonly ResourceKind[] = [
  'genie-space',
  'sql-warehouse',
  'unity-catalog',
  'volume',
  'vector-search',
  'model',
];

function isDeclarableKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && (DECLARABLE_KINDS as readonly string[]).includes(value);
}

function isDeclaredResourceType(value: unknown): value is DeclaredResourceType {
  return typeof value === 'string' && (DECLARED_RESOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * A string field of an untrusted document, bounded.
 *
 * Anything that is not a string reads as absent rather than being stringified,
 * for the reason `app-settings.ts` gives about the same guard: `String(object)`
 * is a non-empty string, so every emptiness test below it passes and a value
 * nobody can read becomes a value that loudly disagrees with the one in use.
 */
function field(value: unknown, limit = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/**
 * Read a published declaration, keeping only what is well formed.
 *
 * Returns `null` when the document is not a declaration at all. A document that
 * IS one but carries a malformed entry keeps the rest: a single bad row in a list
 * a customer maintains by hand should not cost them the page, and every entry
 * that survives is individually complete.
 *
 * Nothing here resolves, probes or trusts a value. The identifiers are recorded
 * as published and shown as published.
 */
export function parseDeclaration(raw: unknown): NotebookDeclaration | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const document = raw as Record<string, unknown>;

  const settings: DeclaredSetting[] = [];
  const seenKeys = new Set<string>();
  let emptyScopes = false;
  const rawSettings = document.settings;
  if (typeof rawSettings === 'object' && rawSettings !== null && !Array.isArray(rawSettings)) {
    for (const [key, value] of Object.entries(rawSettings as Record<string, unknown>)) {
      const name = field(key, 120);
      const stated = field(value);
      // A key with no readable value is dropped rather than recorded empty.
      // "Published as nothing" and "not published" are the same intent, and only
      // one of them invites a diff against a value that is in use.
      //
      // The scopes key is the exception, and only to the extent of remembering
      // that it happened: see `emptyScopes`.
      if (name === SCOPES_KEY && !stated) emptyScopes = true;
      if (!name || !stated || seenKeys.has(name)) continue;
      seenKeys.add(name);
      settings.push({ key: name, value: stated });
    }
  }

  const connections: DeclaredConnection[] = [];
  const seenIds = new Set<string>();
  const rawConnections = document.connections;
  if (Array.isArray(rawConnections)) {
    for (const entry of rawConnections.slice(0, MAX_DECLARED_CONNECTIONS)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = field(record.id, 120);
      const value = field(record.value);
      if (!id || !value || seenIds.has(id) || !isDeclarableKind(record.kind)) continue;
      seenIds.add(id);
      connections.push({
        id,
        label: field(record.label, 200) || id,
        kind: record.kind,
        resourceType: isDeclaredResourceType(record.resourceType ?? record.resource_type)
          ? ((record.resourceType ?? record.resource_type) as DeclaredResourceType)
          : undefined,
        value,
        note: field(record.note),
      });
    }
  }

  // A declaration with neither a setting nor a connection is not one. Returning
  // an empty declaration would render a Connections row claiming a notebook is
  // publishing, next to nothing it published.
  if (settings.length === 0 && connections.length === 0) return null;

  return {
    source: field(document.source),
    revision: field(document.revision, 120),
    publishedAt: field(document.published_at ?? document.publishedAt, 60),
    publishedBy: field(document.published_by ?? document.publishedBy, 200),
    settings,
    connections,
    emptyScopes,
  };
}

/** How a published setting compares with what the deployment is running. */
export type DeclarationVerdict =
  /** Published and in use. */
  | 'agrees'
  /** Published, differs from what is in use, and a re-log would apply it. */
  | 'pending'
  /** Published, differs, and this app will not apply it. */
  | 'refused'
  /** Published, and nothing was read to compare it with. */
  | 'unknown';

export interface DeclarationComparison {
  key: string;
  label: string;
  declared: string;
  /** What the deployment reported for this key, or '' when it reported nothing. */
  live: string;
  flow: DeclarationFlow;
  verdict: DeclarationVerdict;
}

/**
 * Line up every published setting against the value in use.
 *
 * `live` comes from the orchestrator's own configuration report, which is the
 * artifact's answer read inside the serving container. An absent one produces
 * `unknown` rather than a disagreement: this page's worst failure is a red row
 * about a healthy deployment, so nothing is called drift on the strength of a
 * value nobody read.
 */
export function compareDeclaration(
  declaration: NotebookDeclaration,
  live: Record<string, string>
): DeclarationComparison[] {
  return declaration.settings.map((setting) => {
    const flow = declarationFlow(setting.key);
    const running = live[setting.key] ?? '';
    let verdict: DeclarationVerdict;
    if (!running) {
      verdict = 'unknown';
    } else if (running === setting.value) {
      verdict = 'agrees';
    } else {
      verdict = flow === 'refused' ? 'refused' : 'pending';
    }
    return {
      key: setting.key,
      label: DECLARABLE_KEYS[setting.key]?.label ?? setting.key,
      declared: setting.value,
      live: running,
      flow,
      verdict,
    };
  });
}
