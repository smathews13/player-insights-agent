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
import { useEffect, useId, useState } from 'react';
import { ChevronRight, Trash2 } from 'lucide-react';
import { AppSelect } from './AppSelect';
import { BrandIcon } from './BrandIcon';
import { RESOURCE_PRODUCT } from './connections-view';
import {
  ADDABLE_KINDS,
  ADD_CONNECTION_PICKERS,
  addedConnectionLabel,
  addedConnectionValue,
  JUST_ADDED_LABEL,
  REMOVE_LABEL,
  REMOVE_FOREVER_LABEL,
  RESTORE_LABEL,
  connectionRowView,
  forgetConnectionDetail,
  orderConnections,
} from './declared-connection-view';
import type { ConnectionEntry } from './connection-model';
import { AssetPicker } from './AssetPicker';
import { StatusBadge } from './StatusBadge';
import { UserIdentityChip } from './UserIdentityChip';
import { connectionValueError, createDeclaredConnection, derivedConnectionKey } from './declared-connection-form';
import type { ConnectionTypesResponse } from '../../shared/browse-contract';
import type { DeclaredResourceType } from '../../shared/notebook-declaration';

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
  const [keyOverride, setKeyOverride] = useState('');
  const [label, setLabel] = useState('');
  const [kindChoice, setKindChoice] = useState<DeclaredResourceType>('catalog');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const [typeDiscovery, setTypeDiscovery] = useState<ConnectionTypesResponse | null>(null);
  const [typeDiscoveryError, setTypeDiscoveryError] = useState('');
  const [instantEntries, setInstantEntries] = useState<ConnectionEntry[]>([]);
  /** The id awaiting a confirmed removal, so the impact is read before it happens. */
  const [confirming, setConfirming] = useState('');
  /** The id awaiting permanent deletion, kept separate from recoverable removal. */
  const [forgetting, setForgetting] = useState('');
  /** The row added in this sitting, which carries the badge until the page is left. */
  const [justAdded, setJustAdded] = useState('');
  const formId = useId();

  useEffect(() => {
    if (!adding || typeDiscovery || typeDiscoveryError) return;
    let live = true;
    fetch('/api/browse/connection-types')
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
          if (live) setTypeDiscoveryError((caught as Error).message || 'Resource types could not be listed.');
        }
      );
    return () => {
      live = false;
    };
  }, [adding, typeDiscovery, typeDiscoveryError]);

  useEffect(() => {
    const persisted = new Set((entries ?? []).map((entry) => entry.connection.id));
    setInstantEntries((current) => current.filter((entry) => !persisted.has(entry.connection.id)));
  }, [entries]);

  const merged = [...(entries ?? []), ...instantEntries];
  const ordered = orderConnections(merged);
  // The row just added sits at the foot of the list, immediately above the
  // control that added it, which is where a reader is already looking.
  const listed = justAdded
    ? [
        ...ordered.filter((entry) => entry.connection.id !== justAdded),
        ...ordered.filter((entry) => entry.connection.id === justAdded),
      ]
    : ordered;
  const chosenKind = ADDABLE_KINDS.find((entry) => entry.id === kindChoice) ?? ADDABLE_KINDS[0];
  const picker = ADD_CONNECTION_PICKERS[chosenKind.browse];
  const identifierLabel = picker.typeLabel
    .replace(/^Or type (an?|a) /i, '')
    .replace(/^./, (letter) => letter.toUpperCase());
  const discoveredIds = new Set(typeDiscovery?.available.map((entry) => entry.id) ?? []);
  const typeChoices = manual ? ADDABLE_KINDS : ADDABLE_KINDS.filter((entry) => discoveredIds.has(entry.id));
  const selectedId = derivedConnectionKey(
    chosenKind.id,
    value.trim(),
    merged.map((entry) => entry.connection.id)
  );
  const baseConnectionId = derivedConnectionKey(chosenKind.id, value.trim(), []);
  const keyCollision = merged.some((entry) => entry.connection.id === baseConnectionId);
  const connectionId = keyOverride.trim() || selectedId;
  const valueError = connectionValueError(chosenKind.id, value);
  // Only workspace-minted hexadecimal ids need a second, human-facing name.
  // A table, catalog, volume, index or endpoint already carries a readable name
  // in its identifier, so showing another blank name box asks for the same fact
  // twice and produces no additional information on the saved row.
  const needsDisplayName = chosenKind.id === 'genie-space' || chosenKind.id === 'sql-warehouse';
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
      setKeyOverride('');
      setLabel('');
      setValue('');
      setAdding(false);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function act(entryId: string, method: 'DELETE' | 'POST', suffix = '') {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/settings/connections/${encodeURIComponent(entryId)}${suffix}`, {
        method,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { detail?: string };
        setError(body.detail ?? 'That did not take effect.');
        return;
      }
      setConfirming('');
      setForgetting('');
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

      {allowMutations && adding ? (
        <div className="plane-form">
          <div className="plane-kind-field">
            {typeChoices.length > 0 ? (
              <AppSelect
                label="Resource type"
                ariaLabel="Resource type"
                value={kindChoice}
                onValueChange={(next) => {
                  setKindChoice(next);
                  setKeyOverride('');
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
              <span className="plane-note">Finding resources your sign-in can see…</span>
            )}
          </div>

          {typeChoices.length > 0 && !manual ? (
            <div className="plane-picker">
              <AssetPicker
                key={chosenKind.id}
                spec={picker}
                current={value}
                onPick={(picked, row) => {
                  // A volume row carries a leaf name, and only the catalog and
                  // schema it was browsed through make it into a path the agent
                  // can be pointed at.
                  const stored = addedConnectionValue(chosenKind.id, picked, row?.cursor);
                  setValue(stored);
                  // THE NAME THE LIST SHOWED, not a fragment of the id. A Genie
                  // space and a warehouse both store a hex string, and deriving a
                  // label from one is how this list ended up printing hex at the
                  // reader. The picked row already carries the human name.
                  const named = addedConnectionLabel(stored, row?.item.label);
                  setLabel((current) => current || named);
                }}
              />
            </div>
          ) : null}

          <button type="button" className="plane-manual-toggle" onClick={() => setManual((shown) => !shown)}>
            {manual ? 'Use visible resources' : 'Enter an identifier manually'}
          </button>

          {manual ? (
            <label className="plane-field-group" htmlFor={`${formId}-identifier`}>
              <span className="plane-field-label">{identifierLabel}</span>
              <input
                id={`${formId}-identifier`}
                className="plane-field ast-mono"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={picker.typeLabel.replace(/^Or type (an?|a) /i, '')}
              />
            </label>
          ) : null}

          {needsDisplayName ? (
            <label className="plane-field-group plane-display-name" htmlFor={`${formId}-label`}>
              <span className="plane-field-label">Display name (optional)</span>
              <input
                id={`${formId}-label`}
                className="plane-field"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Name shown in this list"
              />
            </label>
          ) : null}

          {value && keyCollision ? (
            <label className="plane-field-group" htmlFor={`${formId}-key`}>
              <span className="plane-field-label">Connection key</span>
              <input
                id={`${formId}-key`}
                className="plane-field ast-mono"
                value={keyOverride}
                onChange={(event) => setKeyOverride(event.target.value)}
                placeholder={selectedId}
              />
            </label>
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

      {error ? <span className="plane-error">{error}</span> : null}

      {listed.map((entry) => {
        const removed = entry.connection.state === 'withdrawn';
        const row = connectionRowView(entry.connection);
        return (
          <div key={entry.connection.id} className="connection-row plane-stack">
            <details className="connection-accordion" data-state={entry.connection.state}>
              <summary className="connection-row-summary">
                <ChevronRight className="connection-row-chevron" aria-hidden="true" />
                <BrandIcon product={RESOURCE_PRODUCT[entry.connection.kind]} className="plane-row-product" />
                <span className="connection-row-kind">{row.kindLabel}</span>
                {row.name ? (
                  <span className="connection-row-title" title={row.name}>
                    <StatusBadge value={row.name} tone="plain" title={row.name} />
                  </span>
                ) : null}
                {entry.connection.id === justAdded ? <span className="plane-row-new">{JUST_ADDED_LABEL}</span> : null}
                <span className="connection-row-value ast-mono" title={row.fullIdentifier}>
                  {row.identifier}
                </span>
                <StatusBadge value={removed ? 'Withdrawn' : 'Declared'} tone="plain" />
              </summary>
              <div className="connection-row-detail">
                <ConnectionProvenance connection={entry.connection} />
                {entry.connection.note ? <p className="connection-row-note">{entry.connection.note}</p> : null}
                {allowMutations ? (
                  <div className="plane-row-actions">
                    {removed ? (
                      <button
                        type="button"
                        className="plane-button-quiet"
                        disabled={busy || !storeAvailable}
                        onClick={() => void act(entry.connection.id, 'POST', '/restore')}
                      >
                        {RESTORE_LABEL}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="plane-button-quiet"
                        disabled={busy || !storeAvailable}
                        onClick={() => {
                          setForgetting('');
                          setConfirming(entry.connection.id);
                        }}
                      >
                        {REMOVE_LABEL}
                      </button>
                    )}
                    {/* Permanent deletion is a distinct control, not a second
                      meaning hidden behind Remove. The ordinary action keeps a
                      restorable row; this one deletes the Lakebase record and
                      therefore asks its own irreversible question first. */}
                    <button
                      type="button"
                      className="plane-row-forget"
                      disabled={busy || !storeAvailable}
                      aria-label={`${REMOVE_FOREVER_LABEL}: ${row.name || row.kindLabel}`}
                      title={REMOVE_FOREVER_LABEL}
                      onClick={() => {
                        setConfirming('');
                        setForgetting(entry.connection.id);
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </div>
            </details>

            {allowMutations && confirming === entry.connection.id ? (
              <div className="plane-confirm">
                <span className="plane-confirm-headline">{entry.impact.headline}</span>
                <ul className="plane-confirm-list">
                  {entry.impact.consequences.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <span className="plane-confirm-actions">
                  <button
                    type="button"
                    className="plane-button-quiet"
                    disabled={busy}
                    onClick={() => void act(entry.connection.id, 'DELETE')}
                  >
                    {REMOVE_LABEL}
                  </button>
                  <button
                    type="button"
                    className="plane-button-quiet"
                    disabled={busy}
                    onClick={() => setConfirming('')}
                  >
                    Keep
                  </button>
                </span>
              </div>
            ) : null}

            {allowMutations && forgetting === entry.connection.id ? (
              <div
                className="plane-confirm"
                role="group"
                aria-label={`${REMOVE_FOREVER_LABEL}: ${row.name || row.kindLabel}`}
              >
                <span className="plane-confirm-headline">Remove this remembered connection forever?</span>
                <span className="plane-confirm-detail">{forgetConnectionDetail(entry.connection.origin)}</span>
                <span className="plane-confirm-actions">
                  <button
                    type="button"
                    className="plane-confirm-forever"
                    disabled={busy}
                    onClick={() => void act(entry.connection.id, 'DELETE', '/forever')}
                  >
                    {busy ? 'Removing\u2026' : REMOVE_FOREVER_LABEL}
                  </button>
                  <button
                    type="button"
                    className="plane-button-quiet"
                    disabled={busy}
                    onClick={() => setForgetting('')}
                  >
                    Keep
                  </button>
                </span>
              </div>
            ) : null}
          </div>
        );
      })}

      {allowMutations ? (
        <div className="plane-add-row" data-testid="add-connection-row">
          <button type="button" className="plane-add-connection" onClick={() => setAdding((open) => !open)}>
            {adding ? 'Cancel' : '+ Add a new connection'}
          </button>
        </div>
      ) : null}
    </>
  );
}
