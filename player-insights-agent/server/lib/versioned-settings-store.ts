import type { LakebaseReader } from './lakebase-store';

export interface VersionedSettings<T> {
  settings: T;
  revision: number;
}

export class SettingsRevisionConflict extends Error {
  constructor() {
    super('These settings changed after this page loaded. Reload Settings, review the newer values, and try again.');
    this.name = 'SettingsRevisionConflict';
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merge only keys present in a patch, recursively.
 *
 * The raw stored document stays on the left so a client from an older build
 * cannot erase fields it does not know. Arrays and scalars are one setting and
 * replace as a unit; objects preserve unknown siblings at every depth.
 */
export function mergeSettingsPatch(current: unknown, patch: unknown): unknown {
  if (!object(current) || !object(patch)) return patch;
  const merged: JsonObject = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = key in current ? mergeSettingsPatch(current[key], value) : value;
  }
  return merged;
}

function revisionFrom(value: unknown): number {
  const revision = Number(value);
  return Number.isInteger(revision) && revision > 0 ? revision : 1;
}

export interface VersionedSettingsStore<T> {
  table: string;
  key: string;
  defaults: T;
  /** Remove retired fields before parsing and on the next durable write. */
  prepare?(value: unknown): unknown;
  parse(value: unknown): T;
}

async function storedRow<T>(
  client: LakebaseReader,
  store: VersionedSettingsStore<T>
): Promise<{ raw: unknown; revision: number } | null> {
  const result = await client.lakebase.query(`SELECT settings, revision FROM ${store.table} WHERE id = $1`, [
    store.key,
  ]);
  const rows = result?.rows ?? [];
  if (rows.length > 1) {
    throw new Error(`More than one durable settings row exists for ${store.key}; no value was chosen.`);
  }
  const row = rows[0];
  if (!row) return null;
  return { raw: row.settings, revision: revisionFrom(row.revision) };
}

export async function readVersionedSettings<T>(
  client: LakebaseReader,
  store: VersionedSettingsStore<T>
): Promise<VersionedSettings<T>> {
  const row = await storedRow(client, store);
  if (!row) return { settings: store.parse(store.defaults), revision: 0 };
  return { settings: store.parse(store.prepare?.(row.raw) ?? row.raw), revision: row.revision };
}

/**
 * Persist one partial document with optimistic revision protection.
 *
 * The read and write are separate statements because AppKit exposes a pool-level
 * query API, not a checked-out transaction. Correctness comes from the atomic
 * `WHERE revision = ...` update (or conflict-free first insert): a concurrent
 * writer can win, but can never be silently overwritten.
 */
export async function writeVersionedSettingsPatch<T>(
  client: LakebaseReader,
  store: VersionedSettingsStore<T>,
  patch: unknown,
  expectedRevision: number,
  updatedBy: string
): Promise<VersionedSettings<T>> {
  const current = await storedRow(client, store);
  if (!current) {
    if (expectedRevision !== 0) throw new SettingsRevisionConflict();
    const merged = mergeSettingsPatch(store.defaults, patch);
    const raw = store.prepare?.(merged) ?? merged;
    const settings = store.parse(raw);
    const inserted = await client.lakebase.query(
      `INSERT INTO ${store.table} (id, settings, revision, updated_by, updated_at)
       VALUES ($1, $2::jsonb, 1, $3, now())
       ON CONFLICT (id) DO NOTHING
       RETURNING settings, revision`,
      [store.key, JSON.stringify(raw), updatedBy]
    );
    const row = inserted?.rows?.[0];
    if (!row) throw new SettingsRevisionConflict();
    return { settings, revision: revisionFrom(row.revision) };
  }

  if (current.revision !== expectedRevision) throw new SettingsRevisionConflict();
  const merged = mergeSettingsPatch(current.raw, patch);
  const raw = store.prepare?.(merged) ?? merged;
  const settings = store.parse(raw);
  const updated = await client.lakebase.query(
    `UPDATE ${store.table}
        SET settings = $2::jsonb,
            revision = revision + 1,
            updated_by = $3,
            updated_at = now()
      WHERE id = $1 AND revision = $4
      RETURNING settings, revision`,
    [store.key, JSON.stringify(raw), updatedBy, expectedRevision]
  );
  const row = updated?.rows?.[0];
  if (!row) throw new SettingsRevisionConflict();
  return { settings, revision: revisionFrom(row.revision) };
}
