/**
 * The assets this deployment says the agent should consider, and what removing
 * one costs.
 *
 * WHAT ADDING ONE DOES, AND THE THING IT DOES NOT DO. A row here records intent.
 * It does not grant anything, it does not widen what any person can read, and it
 * does not reach the running orchestrator: the tables the agent may query are
 * enumerated when the model is logged and baked into the artifact as the manifest
 * the SQL guard checks (see `shared/notebook-declaration.ts` for why that is a
 * safety property rather than a gap). A reader will assume the opposite, so
 * `addedConnectionEffect` states it and the surface shows it on the row.
 *
 * WHY ORDINARY REMOVAL IS A STATE CHANGE AND NOT A DELETE. The demo this app
 * runs is a conversation, and an asset withdrawn halfway through one is exactly
 * when somebody needs it back. A withdrawn row keeps its value, so restoring it
 * is a click rather than a three-part table name recalled from memory.
 * `removalImpact` is the other half of the same idea: it says what stops working
 * BEFORE the withdrawal, because the alternative is finding out from the next
 * question. Permanent forgetting is a separate query and an explicitly
 * destructive UI path; it does not weaken this safe default.
 */
import { APP_SCHEMA } from '../../shared/app-schema';
import {
  DECLARABLE_KINDS,
  type DeclaredConnection,
} from '../../shared/notebook-declaration';
import { CONNECTED_RESOURCES, type ResourceKind } from '../../shared/deployment-config';
import type { LakebaseReader } from './lakebase-store';

/** Whether a declaration is current, or withdrawn and restorable. */
export type DeclarationState = 'declared' | 'withdrawn';

/** Who put the row there. `app` is the Connections tab; `notebook` is a publish. */
export type DeclarationOrigin = 'app' | 'notebook';

export interface StoredDeclaredConnection extends DeclaredConnection {
  state: DeclarationState;
  origin: DeclarationOrigin;
  createdAt: string;
  createdBy: string;
  changedAt: string;
  changedBy: string;
}

export const DECLARED_CONNECTIONS_QUERY = `
  SELECT id, label, kind, value, note, state, origin, created_at, created_by, changed_at, changed_by
  FROM ${APP_SCHEMA}.declared_connections
  ORDER BY created_at, id`;

export const UPSERT_DECLARED_CONNECTION_QUERY = `
  INSERT INTO ${APP_SCHEMA}.declared_connections
    (id, label, kind, value, note, state, origin, created_by, changed_by, changed_at)
  VALUES ($1, $2, $3, $4, $5, 'declared', $6, $7, $7, now())
  ON CONFLICT (id) DO UPDATE
    SET label = EXCLUDED.label,
        kind = EXCLUDED.kind,
        value = EXCLUDED.value,
        note = EXCLUDED.note,
        state = 'declared',
        origin = EXCLUDED.origin,
        changed_by = EXCLUDED.changed_by,
        changed_at = now()
  RETURNING id, label, kind, value, note, state, origin, created_at, created_by, changed_at, changed_by`;

/**
 * Withdraw a declaration, keeping the row.
 *
 * `RETURNING` so the caller can tell "withdrew it" from "there was nothing to
 * withdraw" without a second read, and so a withdrawal of an already-withdrawn
 * row reports honestly rather than as a fresh one.
 */
export const WITHDRAW_DECLARED_CONNECTION_QUERY = `
  UPDATE ${APP_SCHEMA}.declared_connections
     SET state = 'withdrawn', changed_by = $2, changed_at = now()
   WHERE id = $1 AND state = 'declared'
  RETURNING id, label, kind, value, note, state, origin, created_at, created_by, changed_at, changed_by`;

export const RESTORE_DECLARED_CONNECTION_QUERY = `
  UPDATE ${APP_SCHEMA}.declared_connections
     SET state = 'declared', changed_by = $2, changed_at = now()
   WHERE id = $1 AND state = 'withdrawn'
  RETURNING id, label, kind, value, note, state, origin, created_at, created_by, changed_at, changed_by`;

/**
 * Forget one stored declaration rather than merely withdrawing it.
 *
 * This is deliberately separate from {@link WITHDRAW_DECLARED_CONNECTION_QUERY}.
 * Withdrawal is the safe default during a demonstration and keeps a one-click
 * recovery path. Permanent removal exists for stale remembered rows whose
 * identifiers should no longer remain in the store, and `RETURNING` lets the
 * route distinguish a completed deletion from an id that was never there.
 */
export const FORGET_DECLARED_CONNECTION_QUERY = `
  DELETE FROM ${APP_SCHEMA}.declared_connections
   WHERE id = $1
  RETURNING id`;

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return text(value);
}

function storedFromRow(row: Record<string, unknown>): StoredDeclaredConnection {
  const kind = text(row.kind);
  return {
    id: text(row.id),
    label: text(row.label),
    // Read through the allowlist rather than cast. A kind that is no longer one
    // this build declares would otherwise reach the client as an icon lookup that
    // silently renders nothing.
    kind: (DECLARABLE_KINDS as readonly string[]).includes(kind)
      ? (kind as ResourceKind)
      : 'unity-catalog',
    value: text(row.value),
    note: text(row.note),
    state: row.state === 'withdrawn' ? 'withdrawn' : 'declared',
    origin: row.origin === 'notebook' ? 'notebook' : 'app',
    createdAt: timestamp(row.created_at),
    createdBy: text(row.created_by),
    changedAt: timestamp(row.changed_at),
    changedBy: text(row.changed_by),
  };
}

/**
 * Every declaration, current and withdrawn.
 *
 * An outage answers with an empty list rather than throwing, matching
 * `readStoredSettings`: the Connections tab is the page somebody opens to find
 * out why the rest of the app is degraded, and failing its read would take that
 * page down too. The caller reports the store's own state beside this.
 */
export async function readDeclaredConnections(
  client: LakebaseReader
): Promise<StoredDeclaredConnection[]> {
  try {
    const result = await client.lakebase.query(DECLARED_CONNECTIONS_QUERY);
    return (result?.rows ?? []).map(storedFromRow).filter((entry) => entry.id !== '');
  } catch (error) {
    console.warn('[connections] Declared connections could not be read:', (error as Error).message);
    return [];
  }
}

export async function writeDeclaredConnection(
  client: LakebaseReader,
  connection: {
    id: string;
    label: string;
    kind: ResourceKind;
    value: string;
    note: string;
    origin: DeclarationOrigin;
    changedBy: string;
  }
): Promise<StoredDeclaredConnection> {
  const result = await client.lakebase.query(UPSERT_DECLARED_CONNECTION_QUERY, [
    connection.id,
    connection.label,
    connection.kind,
    connection.value,
    connection.note,
    connection.origin,
    connection.changedBy,
  ]);
  const row = (result?.rows ?? [])[0];
  if (!row) throw new Error('the declared connection was not written back');
  return storedFromRow(row);
}

export async function withdrawDeclaredConnection(
  client: LakebaseReader,
  id: string,
  changedBy: string
): Promise<StoredDeclaredConnection | null> {
  const result = await client.lakebase.query(WITHDRAW_DECLARED_CONNECTION_QUERY, [id, changedBy]);
  const row = (result?.rows ?? [])[0];
  return row ? storedFromRow(row) : null;
}

export async function restoreDeclaredConnection(
  client: LakebaseReader,
  id: string,
  changedBy: string
): Promise<StoredDeclaredConnection | null> {
  const result = await client.lakebase.query(RESTORE_DECLARED_CONNECTION_QUERY, [id, changedBy]);
  const row = (result?.rows ?? [])[0];
  return row ? storedFromRow(row) : null;
}

/** Permanently remove one remembered declaration. */
export async function forgetDeclaredConnection(client: LakebaseReader, id: string): Promise<boolean> {
  const result = await client.lakebase.query(FORGET_DECLARED_CONNECTION_QUERY, [id]);
  return Boolean((result?.rows ?? [])[0]);
}

/** Characters an id may use, so it is safe as a URL path segment and a key. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,60}$/;

/**
 * Why this connection could not be added, or `null` when it can.
 *
 * The registry ids are refused because they are the deployment's own wiring: a
 * declaration that reused `sql-warehouse` would render two rows claiming the same
 * key, one of which the app resolves from the artifact and one from this table.
 */
export function addFault(input: {
  id: string;
  kind: string;
  value: string;
}): string | null {
  if (!ID_PATTERN.test(input.id)) {
    return 'A name may use lower-case letters, digits and hyphens, must start with a letter or digit, and is between 2 and 61 characters.';
  }
  if (CONNECTED_RESOURCES.some((resource) => resource.id === input.id)) {
    return `${input.id} is already the name of one of this deployment's own settings. Choose another name.`;
  }
  if (!(DECLARABLE_KINDS as readonly string[]).includes(input.kind)) {
    return `${input.kind} is not a kind of asset that can be added here.`;
  }
  if (!input.value.trim()) {
    return 'An asset needs an identifier, such as a three-part table name.';
  }
  return null;
}

/**
 * What adding this connection did, in the words the row has to carry.
 *
 * Written here rather than in the client because it is the load-bearing sentence
 * of the whole feature and it must not drift between the two surfaces that show
 * it. A customer reads "added a connection" as "granted access", and the one
 * thing this app must never do is let them believe that.
 */
export function addedConnectionEffect(): string {
  return 'Recorded as an asset the agent may consider. It grants nobody access: whether a person can read it is decided by their own Unity Catalog grants.';
}

/** What a withdrawal costs, and whether it can be undone. */
export interface RemovalImpact {
  /** The single line shown before the withdrawal is confirmed. */
  headline: string;
  /** What specifically stops working. Empty when nothing does. */
  consequences: string[];
  /** Whether this app can put it back. */
  recoverable: boolean;
}

/**
 * What stops working if this declaration is withdrawn.
 *
 * ASKED BEFORE THE WITHDRAWAL, NOT AFTER. The reason removal is dangerous here is
 * that the deployment is usually mid demo, and the failure shows up as the next
 * question answering worse rather than as an error anyone connects to a click.
 *
 * The honest content is narrow, and saying only what is true is the point. A
 * withdrawn declaration stops being offered to the agent as an asset to consider
 * and stops appearing on this page. It does NOT revoke a grant, and it does not
 * shrink what the agent may read, because that list is in the model artifact. So
 * a row whose value is also one of the deployment's live resources gets the
 * stronger warning, and everything else gets the true, milder one.
 */
export function removalImpact(
  connection: StoredDeclaredConnection,
  liveValues: readonly string[]
): RemovalImpact {
  const consequences: string[] = [
    'The agent stops being offered this asset when it chooses where to look.',
  ];
  const normalised = connection.value.trim().toLowerCase();
  const alsoLive = liveValues.some((value) => value.trim().toLowerCase() === normalised);
  if (alsoLive) {
    // The value is one the running model was configured with, so the agent will
    // keep reaching it whatever this table says. Withdrawing the row hides it
    // from the page and changes nothing about the running deployment, which is
    // the opposite of what a reader would assume from a removal.
    consequences.push(
      'The running agent is configured with this same value, so it keeps using it. Removing the row here changes what this page lists, not what the agent reaches.'
    );
  }
  if (connection.origin === 'notebook') {
    consequences.push(
      'It was published from a notebook, so publishing again will add it back.'
    );
  }
  return {
    headline: alsoLive
      ? `Remove ${connection.label} from the list. The running agent is configured with this value and keeps using it.`
      : `Remove ${connection.label} from the assets the agent may consider.`,
    consequences,
    recoverable: true,
  };
}
