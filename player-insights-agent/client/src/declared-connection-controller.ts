import { useEffect, useRef, useState } from 'react';
import type { ConnectionEntry } from './connection-model';
import {
  createConnectionDeleteGate,
  createDeclaredConnection,
  deleteDeclaredConnection,
  type CreateConnectionInput,
  type CreateConnectionResult,
  type DeleteConnectionResult,
} from './declared-connection-form';
import { isDeclaredTableConnection, orderConnections } from './declared-connection-view';
import { beginConnectionMutation, commitConnectionAddition, commitConnectionDeletion } from './session-checks';

const DELETE_TOMBSTONE_MS = 10_000;

export function normalizedConnectionValue(value: string): string {
  return value
    .trim()
    .split('.')
    .map((part) => part.trim())
    .join('.')
    .toLocaleLowerCase();
}

export function isDuplicateConnection(
  entries: readonly ConnectionEntry[],
  resourceType: CreateConnectionInput['resourceType'],
  value: string
): boolean {
  const normalized = normalizedConnectionValue(value);
  return entries.some(
    (entry) =>
      entry.connection.state === 'declared' &&
      (entry.connection.resourceType === resourceType ||
        (resourceType === 'table' && isDeclaredTableConnection(entry.connection))) &&
      normalizedConnectionValue(entry.connection.value) === normalized
  );
}

export function useDeclaredConnectionController({
  entries,
  onChanged,
}: {
  entries?: ConnectionEntry[];
  onChanged: () => void | Promise<void>;
}) {
  const [instantEntries, setInstantEntries] = useState<ConnectionEntry[]>([]);
  const [deleteTombstones, setDeleteTombstones] = useState<Map<string, number>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const [justAdded, setJustAdded] = useState('');
  const [confirming, setConfirming] = useState('');
  const [rowError, setRowError] = useState<{ id: string; detail: string } | null>(null);
  const [successNotice, setSuccessNotice] = useState('');
  const deleteGate = useRef(createConnectionDeleteGate());

  useEffect(() => {
    const persisted = new Set((entries ?? []).map((entry) => entry.connection.id));
    setInstantEntries((current) => current.filter((entry) => !persisted.has(entry.connection.id)));
  }, [entries]);

  useEffect(() => {
    if (deleteTombstones.size === 0) return;
    const expiresAt = Math.min(...deleteTombstones.values());
    const timeout = window.setTimeout(
      () => {
        const now = Date.now();
        setDeleteTombstones((current) => new Map([...current].filter(([, expiry]) => expiry > now)));
      },
      Math.max(0, expiresAt - Date.now())
    );
    return () => window.clearTimeout(timeout);
  }, [deleteTombstones]);

  const mergedById = new Map((entries ?? []).map((entry) => [entry.connection.id, entry]));
  for (const entry of instantEntries) mergedById.set(entry.connection.id, entry);
  const listed = orderConnections(
    [...mergedById.values()].filter((entry) => !deleteTombstones.has(entry.connection.id))
  );

  async function add(
    input: CreateConnectionInput,
    duplicateDetail = 'That connection is already in the list.'
  ): Promise<CreateConnectionResult> {
    if (isDuplicateConnection(listed, input.resourceType, input.value)) {
      return { ok: false, detail: duplicateDetail };
    }
    setBusy(true);
    setRowError(null);
    setSuccessNotice('');
    try {
      beginConnectionMutation();
      const result = await createDeclaredConnection(input);
      if (!result.ok) return result;
      setInstantEntries((current) => [
        ...current.filter((entry) => entry.connection.id !== result.entry.connection.id),
        result.entry,
      ]);
      setJustAdded(result.entry.connection.id);
      commitConnectionAddition(result.entry);
      await onChanged();
      return result;
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry: ConnectionEntry): Promise<DeleteConnectionResult | null> {
    if (busy || deleteGate.current.pending(entry.connection.id)) return null;
    setBusy(true);
    setRowError(null);
    setSuccessNotice('');
    try {
      const result = await deleteGate.current.run(entry.connection.id, async () => {
        beginConnectionMutation();
        return deleteDeclaredConnection(entry.connection);
      });
      if (!result) return null;
      if (!result.ok) {
        setRowError({ id: entry.connection.id, detail: result.detail });
        return result;
      }
      const expires = Date.now() + DELETE_TOMBSTONE_MS;
      setDeleteTombstones((current) => {
        const next = new Map(current);
        for (const id of result.deletedIds) next.set(id, expires);
        return next;
      });
      setInstantEntries((current) =>
        current.filter((candidate) => !result.deletedIds.includes(candidate.connection.id))
      );
      commitConnectionDeletion(result.deletedIds);
      setConfirming('');
      setSuccessNotice(
        result.deletedCount === 1
          ? 'Connection deleted.'
          : `Connection deleted with ${result.deletedCount - 1} duplicate ${
              result.deletedCount === 2 ? 'record' : 'records'
            }.`
      );
      await onChanged();
      return result;
    } finally {
      setBusy(false);
    }
  }

  return {
    listed,
    busy,
    setBusy,
    justAdded,
    setJustAdded,
    confirming,
    setConfirming,
    rowError,
    setRowError,
    successNotice,
    add,
    remove,
  };
}
