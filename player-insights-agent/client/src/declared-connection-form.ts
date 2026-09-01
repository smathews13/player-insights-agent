import type { ConnectionEntry } from './connection-model';
import type { DeclaredResourceType } from '../../shared/notebook-declaration';

export interface CreateConnectionInput {
  id: string;
  label: string;
  kind: string;
  resourceType: DeclaredResourceType;
  value: string;
}

export type CreateConnectionResult = { ok: true; entry: ConnectionEntry } | { ok: false; detail: string };

export type DeleteConnectionResult =
  | { ok: true; outcome: 'forgotten'; deletedCount: number; deletedIds: string[] }
  | { ok: false; detail: string };

/** One in-flight mutation per logical row, even before React can re-render. */
export function createConnectionDeleteGate() {
  const pending = new Set<string>();
  return {
    async run<T>(id: string, mutation: () => Promise<T>): Promise<T | null> {
      if (pending.has(id)) return null;
      pending.add(id);
      try {
        return await mutation();
      } finally {
        pending.delete(id);
      }
    },
    pending(id: string): boolean {
      return pending.has(id);
    },
  };
}

/** POST one connection and keep the server's persisted provenance verbatim. */
export async function createDeclaredConnection(
  input: CreateConnectionInput,
  fetchImpl: typeof fetch = fetch
): Promise<CreateConnectionResult> {
  try {
    const response = await fetchImpl('/api/settings/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await response.json().catch(() => ({}))) as {
      connection?: ConnectionEntry['connection'];
      impact?: ConnectionEntry['impact'];
      detail?: string;
    };
    if (!response.ok || !body.connection || !body.impact) {
      return { ok: false, detail: body.detail ?? 'The connection was not added.' };
    }
    return { ok: true, entry: { connection: body.connection, impact: body.impact } };
  } catch (error) {
    return {
      ok: false,
      detail: `The connection was not added: ${(error as Error).message || 'the app could not be reached.'}`,
    };
  }
}

/**
 * Delete once, and accept success only after the server confirms persistence.
 */
export async function deleteDeclaredConnection(
  connection: Pick<ConnectionEntry['connection'], 'id' | 'state'>,
  fetchImpl: typeof fetch = fetch
): Promise<DeleteConnectionResult> {
  const url = `/api/settings/connections/${encodeURIComponent(connection.id)}`;
  try {
    const response = await fetchImpl(url, { method: 'DELETE' });
    const body = (await response.json().catch(() => ({}))) as {
      connection?: ConnectionEntry['connection'];
      forgotten?: { id: string };
      deletedCount?: number;
      deletedIds?: string[];
      detail?: string;
    };
    if (!response.ok) {
      return {
        ok: false,
        detail: body.detail ?? 'The connection was not deleted.',
      };
    }
    if (body.forgotten?.id === connection.id && (body.deletedCount ?? 1) > 0) {
      return {
        ok: true,
        outcome: 'forgotten',
        deletedCount: body.deletedCount ?? 1,
        deletedIds: body.deletedIds?.filter((id): id is string => typeof id === 'string') ?? [connection.id],
      };
    }
    return { ok: false, detail: 'The server did not confirm that the connection changed.' };
  } catch (error) {
    return {
      ok: false,
      detail: `The connection was not deleted: ${(error as Error).message || 'the app could not be reached.'}`,
    };
  }
}

/** Stable, URL-safe key derived from a selection, with collisions made explicit. */
export function derivedConnectionKey(
  resourceType: DeclaredResourceType,
  value: string,
  existing: readonly string[]
): string {
  const stem =
    `${resourceType}-${value}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 55) || `${resourceType}-resource`;
  if (!existing.includes(stem)) return stem;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${stem.slice(0, 57 - String(suffix).length)}-${suffix}`;
    if (!existing.includes(candidate)) return candidate;
  }
  const checksum = [...value].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) >>> 0, 0);
  return `${stem.slice(0, 46)}-${checksum.toString(36)}`;
}

export function connectionValueError(resourceType: DeclaredResourceType, raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  const parts = value.split('.').filter(Boolean);
  if (resourceType === 'schema' && parts.length !== 2) return 'Use catalog.schema.';
  if ((resourceType === 'table' || resourceType === 'vector-search-index') && parts.length !== 3) {
    return 'Use catalog.schema.name.';
  }
  if (resourceType === 'volume' && !/^\/Volumes\/[^/]+\/[^/]+\/[^/]+$/.test(value)) {
    return 'Use /Volumes/catalog/schema/volume.';
  }
  return '';
}
