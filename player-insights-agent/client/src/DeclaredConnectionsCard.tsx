/**
 * Adding and removing declared assets.
 *
 * Ordinary removal is recoverable: a removed asset stays listed with a way to put
 * it back, because this app is usually mid demonstration when somebody removes
 * the wrong thing. A separate trash control permanently forgets stale remembered
 * rows, and it asks an irreversible question before touching the store.
 *
 * THE PALETTE IS NO LONGER IN THIS FILE, and neither is the operating system's
 * menu. Both arrived with the plane as working markup to be restyled: the colours
 * were inline style objects written hex by hex, and the kind picker was a native
 * `<select>`, which opens a menu the platform draws and the app cannot style. The
 * geometry is now `.plane-*` in `connections.css` and the picker is the same Radix
 * Select the rest of the app opens, through `./ui`.
 *
 * None of what the card DOES moved. Every string is still
 * `declared-connection-view.ts`'s, the list is still addable and removable, a
 * ordinary removal still offers "Put back", permanent removal is explicit, and
 * adding still grants nobody anything.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle, Trash2 } from 'lucide-react';
import { AppSelect } from './AppSelect';
import { BrandIcon } from './BrandIcon';
import { VisitInDatabricks } from './DataEntityLinks';
import { RESOURCE_PRODUCT } from './connections-view';
import {
  ADDABLE_KINDS,
  ADD_CONNECTION_PICKERS,
  DELETE_CONNECTION_LABEL,
  addedConnectionLabel,
  addedConnectionValue,
  JUST_ADDED_LABEL,
  RESTORE_LABEL,
  connectionDatabricksObject,
  connectionRowView,
  forgetConnectionDetail,
  orderConnections,
} from './declared-connection-view';
import type { ConnectionEntry } from './connection-model';
import { AssetPicker } from './AssetPicker';
import { StatusBadge } from './StatusBadge';
import { UserIdentityChip } from './UserIdentityChip';
import {
  connectionValueError,
  createDeclaredConnection,
  deleteDeclaredConnection,
  derivedConnectionKey,
} from './declared-connection-form';
import type { ConnectionTypesResponse } from '../../shared/browse-contract';
import type { DeclaredResourceType } from '../../shared/notebook-declaration';
import { Button } from './ui';

function ConnectionProvenance({ connection }: { connection: ConnectionEntry['connection'] }) {
  const created = connection.createdAt ? new Date(connection.createdAt) : null;
  const validCreated = created && !Number.isNaN(created.getTime()) ? created : null;
  if (!connection.createdBy && !validCreated) {
    return <span className="connection-provenance-badge">Added previously</span>;
  }
  return (
    <span className="connection-provenance">
      {connection.createdBy ? (
        <span className="connection-provenance-badge">
          Added by <UserIdentityChip identity={connection.createdBy} compact />
        </span>
      ) : null}
      {validCreated ? (
        <time
          className="connection-provenance-badge"
          dateTime={connection.createdAt}
          title={validCreated.toLocaleString()}
        >
          Added {validCreated.toLocaleDateString()}
        </time>
      ) : null}
    </span>
  );
}

export interface DeclaredConnectionsCardProps {
  entries?: ConnectionEntry[];
  /** Whether the store that holds these is answering. */
  storeAvailable?: boolean;
  /** Administrators only may add, withdraw or forget. Consumers still see the list. */
  allowMutations?: boolean;
  onChanged: () => void | Promise<void>;
}

export function DeclaredConnectionsCard({
  entries,
  storeAvailable = true,
  allowMutations = false,
  onChanged,
}: DeclaredConnectionsCardProps) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [kindChoice, setKindChoice] = useState<DeclaredResourceType>('catalog');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [typeDiscovery, setTypeDiscovery] = useState<ConnectionTypesResponse | null>(null);
  const [typeDiscoveryError, setTypeDiscoveryError] = useState('');
  const [instantEntries, setInstantEntries] = useState<ConnectionEntry[]>([]);
  const [hiddenEntries, setHiddenEntries] = useState<Set<string>>(() => new Set());
  /** The id awaiting a confirmed removal, so the impact is read before it happens. */
  const [confirming, setConfirming] = useState('');
  /** The row added in this sitting, which carries the badge until the page is left. */
  const [justAdded, setJustAdded] = useState('');
  const [rowError, setRowError] = useState<{ id: string; detail: string } | null>(null);
  const newRowRef = useRef<HTMLDivElement | null>(null);
  const formId = useId();

  useEffect(() => {
    if (!adding || typeDiscovery || typeDiscoveryError) return;
    let live = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(new DOMException('Resource discovery timed out', 'TimeoutError')),
      15_000
    );
    fetch('/api/browse/connection-types', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`the discovery endpoint answered ${response.status}`);
        return response.json() as Promise<ConnectionTypesResponse>;
      })
      .then(
        (response) => {
          if (!live) return;
          setTypeDiscovery(response);
          const first = response.available[0]?.id;
          if (first) setKindChoice(first);
        },
        (caught: unknown) => {
          if (live) {
            setTypeDiscoveryError(
              (caught as Error)?.name === 'TimeoutError'
                ? 'Resource discovery timed out.'
                : (caught as Error).message || 'Resource types could not be listed.'
            );
          }
        }
      );
    return () => {
      live = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [adding, typeDiscovery, typeDiscoveryError]);

  useEffect(() => {
    const persisted = new Set((entries ?? []).map((entry) => entry.connection.id));
    setInstantEntries((current) => current.filter((entry) => !persisted.has(entry.connection.id)));
    setHiddenEntries((current) => new Set([...current].filter((id) => persisted.has(id))));
  }, [entries]);

  const mergedById = new Map((entries ?? []).map((entry) => [entry.connection.id, entry]));
  for (const entry of instantEntries) mergedById.set(entry.connection.id, entry);
  const merged = [...mergedById.values()].filter((entry) => !hiddenEntries.has(entry.connection.id));
  const ordered = orderConnections(merged);
  const listed = ordered;
  const chosenKind = ADDABLE_KINDS.find((entry) => entry.id === kindChoice) ?? ADDABLE_KINDS[0];
  const picker = ADD_CONNECTION_PICKERS[chosenKind.browse];
  const discoveredIds = new Set(typeDiscovery?.available.map((entry) => entry.id) ?? []);
  const typeChoices = ADDABLE_KINDS.filter((entry) => discoveredIds.has(entry.id));
  const selectedId = derivedConnectionKey(
    chosenKind.id,
    value.trim(),
    merged.map((entry) => entry.connection.id)
  );
  const connectionId = selectedId;
  const valueError = connectionValueError(chosenKind.id, value);
  const disabledReason = !storeAvailable
    ? 'The connection store is not answering.'
    : !value.trim()
      ? kindChoice === 'sql-warehouse'
        ? 'Choose a warehouse first.'
        : `Choose a ${chosenKind.label.toLowerCase()} first.`
      : valueError
        ? valueError
        : busy
          ? 'Adding this connection.'
          : '';

  async function add() {
    const duplicate = listed.some(
      (entry) =>
        entry.connection.state === 'declared' &&
        entry.connection.kind === chosenKind.kind &&
        entry.connection.value === value.trim()
    );
    if (duplicate) {
      setError('That connection is already in the list.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await createDeclaredConnection({
        id: connectionId,
        label: label.trim(),
        kind: chosenKind.kind,
        resourceType: chosenKind.id,
        value: value.trim(),
      });
      if (!result.ok) {
        setError(result.detail);
        return;
      }
      setInstantEntries((current) => [
        ...current.filter((entry) => entry.connection.id !== result.entry.connection.id),
        result.entry,
      ]);
      setJustAdded(result.entry.connection.id);
      setLabel('');
      setValue('');
      setAdding(false);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!justAdded || !newRowRef.current) return;
    newRowRef.current.focus({ preventScroll: true });
    newRowRef.current.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [justAdded]);

  async function restore(entryId: string) {
    if (busy) return;
    setBusy(true);
    setRowError(null);
    try {
      const response = await fetch(`/api/settings/connections/${encodeURIComponent(entryId)}/restore`, {
        method: 'POST',
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { detail?: string };
        setRowError({ id: entryId, detail: body.detail ?? 'That did not take effect.' });
        return;
      }
      setConfirming('');
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry: ConnectionEntry) {
    if (busy) return;
    setBusy(true);
    setRowError(null);
    try {
      const result = await deleteDeclaredConnection(entry.connection);
      if (!result.ok) {
        setRowError({ id: entry.connection.id, detail: result.detail });
        return;
      }
      if (result.outcome === 'forgotten') {
        setHiddenEntries((current) => new Set(current).add(entry.connection.id));
      } else if (result.connection) {
        setInstantEntries((current) => [
          ...current.filter((candidate) => candidate.connection.id !== entry.connection.id),
          { ...entry, connection: result.connection! },
        ]);
      }
      setConfirming('');
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!storeAvailable ? (
        <span className="plane-error">
          The store that holds this list is not answering, so nothing can be added or removed.
        </span>
      ) : null}

      {listed.length > 0 ? <p className="declared-connections-heading">User-added resources</p> : null}
      {listed.map((entry) => {
        const removed = entry.connection.state === 'withdrawn';
        const row = connectionRowView(entry.connection);
        const destination = connectionDatabricksObject(entry.connection);
        const name = row.name || row.fullIdentifier || row.kindLabel;
        const confirmOpen = confirming === entry.connection.id;
        return (
          <div
            key={entry.connection.id}
            ref={entry.connection.id === justAdded ? newRowRef : undefined}
            className="connection-row plane-stack declared-connection-row"
            data-state={entry.connection.state}
            data-testid={`declared-connection-${entry.connection.id}`}
            role="group"
            aria-label={`${row.kindLabel}: ${name}`}
            tabIndex={-1}
          >
            <div className="connection-row-summary declared-connection-summary">
              <BrandIcon product={RESOURCE_PRODUCT[entry.connection.kind]} className="plane-row-product" />
              <span className="connection-row-kind">{row.kindLabel}</span>
              {destination ? <VisitInDatabricks name={name} object={destination} /> : null}
              {row.name ? (
                <span className="connection-row-title" title={row.name}>
                  <StatusBadge value={row.name} tone="plain" title={row.name} />
                </span>
              ) : null}
              {entry.connection.id === justAdded ? <span className="plane-row-new">{JUST_ADDED_LABEL}</span> : null}
              {row.identifier ? (
                <code className="declared-connection-id" title={row.fullIdentifier} aria-label={row.fullIdentifier}>
                  {row.identifier}
                </code>
              ) : null}
              <StatusBadge value={removed ? 'Withdrawn' : 'Declared'} tone="plain" />
              <ConnectionProvenance connection={entry.connection} />
              {allowMutations ? (
                <div className="plane-row-actions">
                  {removed ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !storeAvailable}
                      onClick={() => void restore(entry.connection.id)}
                    >
                      {RESTORE_LABEL}
                    </Button>
                  ) : null}
                  {!confirmOpen ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      className="plane-delete-connection"
                      disabled={busy || !storeAvailable}
                      onClick={() => {
                        setRowError(null);
                        setConfirming(entry.connection.id);
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                      {DELETE_CONNECTION_LABEL}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
            {entry.connection.note ? <p className="connection-row-note">{entry.connection.note}</p> : null}

            {allowMutations && confirmOpen ? (
              <div className="plane-confirm" role="group" aria-label={`${DELETE_CONNECTION_LABEL}: ${name}`}>
                <span className="plane-confirm-headline">
                  {removed ? 'Delete this remembered connection permanently?' : entry.impact.headline}
                </span>
                {removed ? (
                  <span className="plane-confirm-detail">{forgetConnectionDetail(entry.connection.origin)}</span>
                ) : (
                  <ul className="plane-confirm-list">
                    {entry.impact.consequences.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
                <span className="plane-confirm-actions">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="plane-delete-connection"
                    disabled={busy}
                    onClick={() => void remove(entry)}
                  >
                    <Trash2 aria-hidden="true" />
                    {busy ? 'Deleting\u2026' : DELETE_CONNECTION_LABEL}
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirming('')}>
                    Keep
                  </Button>
                </span>
              </div>
            ) : null}
            {rowError?.id === entry.connection.id ? (
              <span className="plane-error declared-connection-error" role="alert">
                {rowError.detail}
              </span>
            ) : null}
          </div>
        );
      })}

      {allowMutations && !adding ? (
        <div className="plane-add-row" data-testid="add-connection-row">
          <button
            type="button"
            className="plane-add-connection"
            aria-expanded={adding}
            aria-controls={`${formId}-form`}
            onClick={() => {
              setError('');
              setAdding((open) => !open);
            }}
          >
            + Add a new connection
          </button>
        </div>
      ) : null}

      {allowMutations && adding ? (
        <div className="plane-form" id={`${formId}-form`} data-testid="add-connection-form">
          <div className="plane-kind-field">
            <label className="plane-field-label" id={`${formId}-type-label`}>
              Resource type
            </label>
            {typeChoices.length > 0 ? (
              <AppSelect
                label="Resource type"
                ariaLabel="Resource type"
                showLabel={false}
                value={kindChoice}
                onValueChange={(next) => {
                  setKindChoice(next);
                  setLabel('');
                  setValue('');
                  setError('');
                }}
                options={typeChoices.map((entry) => ({ value: entry.id, label: entry.label }))}
                className="plane-field-select"
              />
            ) : typeDiscoveryError ? (
              <span className="plane-error">Resource types could not be listed: {typeDiscoveryError}</span>
            ) : typeDiscovery ? (
              <span className="plane-note">No resource categories returned visible items for your sign-in.</span>
            ) : (
              <span className="plane-picker-discovery" role="status">
                <LoaderCircle className="asset-picker-spinner" aria-hidden="true" />
                Finding resources your sign-in can access…
              </span>
            )}
          </div>

          {typeChoices.length > 0 ? (
            <div className="plane-picker">
              <AssetPicker
                key={chosenKind.id}
                spec={picker}
                current={value}
                onPick={(picked, pickedRow) => {
                  const stored = addedConnectionValue(chosenKind.id, picked, pickedRow?.cursor);
                  setValue(stored);
                  const named = addedConnectionLabel(stored, pickedRow?.item.label);
                  setLabel((current) => current || named);
                  setError('');
                }}
              />
            </div>
          ) : null}

          {error ? (
            <span className="plane-error plane-form-error" role="alert">
              {error}
            </span>
          ) : null}

          <div className="plane-form-actions" data-sticky="true">
            <button
              type="button"
              className="plane-button"
              disabled={Boolean(disabledReason)}
              aria-describedby={disabledReason ? `${formId}-add-reason` : undefined}
              onClick={() => void add()}
            >
              {busy ? `Adding ${chosenKind.label.toLowerCase()}…` : `Add ${chosenKind.label.toLowerCase()}`}
            </button>
            <button
              type="button"
              className="plane-button-quiet"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setError('');
              }}
            >
              Cancel
            </button>
            {disabledReason ? (
              <span className="plane-add-reason" id={`${formId}-add-reason`}>
                {disabledReason}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
