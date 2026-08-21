/**
 * Adding and removing declared assets.
 *
 * Removal is never destructive: a removed asset stays listed as removed with a way
 * to put it back, because this app is usually mid demonstration when somebody
 * removes the wrong thing.
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
 * removal still offers "Put back", and adding still grants nobody anything.
 */
import { useState } from 'react';
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
  RESTORE_LABEL,
  connectionRowView,
  orderConnections,
} from './declared-connection-view';
import type { ConnectionEntry } from './connection-model';
import { AssetPicker } from './AssetPicker';
import { StatusBadge } from './StatusBadge';

export interface DeclaredConnectionsCardProps {
  entries?: ConnectionEntry[];
  /** Whether the store that holds these is answering. */
  storeAvailable?: boolean;
  /** Administrators only may add or withdraw. Consumers still see the list. */
  allowMutations?: boolean;
  onChanged: () => void;
}

export function DeclaredConnectionsCard({
  entries,
  storeAvailable = true,
  allowMutations = false,
  onChanged,
}: DeclaredConnectionsCardProps) {
  const [adding, setAdding] = useState(false);
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [kindChoice, setKindChoice] = useState(ADDABLE_KINDS[0].id);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** The id awaiting a confirmed removal, so the impact is read before it happens. */
  const [confirming, setConfirming] = useState('');
  /** The row added in this sitting, which carries the badge until the page is left. */
  const [justAdded, setJustAdded] = useState('');

  const ordered = orderConnections(entries ?? []);
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
      const response = await fetch('/api/settings/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id.trim(), label: label.trim(), kind: chosenKind.kind, value: value.trim() }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { detail?: string };
        setError(body.detail ?? 'The asset was not added.');
        return;
      }
      setJustAdded(id.trim());
      setId('');
      setLabel('');
      setValue('');
      setAdding(false);
      onChanged();
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
      onChanged();
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
          <div className="plane-form-pair">
            <input
              className="plane-field"
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder="name"
              aria-label="Name"
            />
            {/* The app's own menu rather than the platform's. The trigger is a
                combobox whose accessible name is "Kind" and whose value is the
                chosen label, so a reader hears the same thing the native
                control said. */}
            <AppSelect
              label="Kind"
              ariaLabel="Kind"
              value={kindChoice}
              onValueChange={setKindChoice}
              options={ADDABLE_KINDS.map((entry) => ({ value: entry.id, label: entry.label }))}
              className="plane-field-select"
            />
          </div>
          {/* Every kind browses. The list is keyed by the chosen kind so that
              switching kinds opens a new browser rather than re-filtering the
              last one. */}
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
              setId(
                (current) =>
                  current || `${chosenKind.id}-${stored.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '')}`
              );
            }}
          />
          <input
            className="plane-field ast-mono"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            // Named for the kind on screen. It read "catalog.schema.table" for
            // every kind, including the six that do not take one.
            placeholder={picker.typeLabel.replace(/^Or type (an?|a) /i, '')}
            aria-label="Identifier"
          />
          <input
            className="plane-field"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="label"
            aria-label="Label"
          />
          <span>
            <button
              type="button"
              className="plane-button"
              disabled={busy || !id.trim() || !value.trim() || !storeAvailable}
              onClick={() => void add()}
            >
              Add
            </button>
          </span>
        </div>
      ) : null}

      {error ? <span className="plane-error">{error}</span> : null}

      {listed.map((entry) => {
        const removed = entry.connection.state === 'withdrawn';
        const row = connectionRowView(entry.connection);
        return (
          <div key={entry.connection.id} className="plane-stack">
            <div className="plane-row" data-state={entry.connection.state}>
              {/* READS LIKE THE ROWS ABOVE IT. The connected-resources list
                  names its product, shows the value as a pill and puts the raw
                  id beside it. These rows printed one string, which for an
                  asset picked from a list of Genie spaces was the space's hex
                  id and nothing else. */}
              <span className="plane-row-name">
                <BrandIcon product={RESOURCE_PRODUCT[entry.connection.kind]} className="plane-row-product" />
                <span className="plane-row-kind">{row.kindLabel}</span>
                {row.name ? (
                  <span className="plane-row-title" title={row.name}>
                    <StatusBadge value={row.name} tone="plain" title={row.name} />
                  </span>
                ) : null}
                {/* Said on the row somebody just added, because the list it
                    joins is long enough that a new entry at the foot of it is
                    otherwise indistinguishable from the rest. */}
                {entry.connection.id === justAdded ? (
                  <span className="plane-row-new">{JUST_ADDED_LABEL}</span>
                ) : null}
              </span>
              <span className="plane-row-value ast-mono" title={row.fullIdentifier}>
                {row.identifier}
              </span>
              {/* A removed asset keeps its way back. This app is usually mid
                  demonstration when somebody removes the wrong thing, so the
                  row stays and offers "Put back" rather than disappearing. */}
              {allowMutations ? (
                removed ? (
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
                    onClick={() => setConfirming(entry.connection.id)}
                  >
                    {REMOVE_LABEL}
                  </button>
                )
              ) : null}
            </div>

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
          </div>
        );
      })}

      {allowMutations ? (
        <div
          className="flex items-center rounded-[var(--radius-md)] border border-[var(--border)] p-3"
          data-testid="add-connection-row"
        >
          <button type="button" className="plane-button-quiet" onClick={() => setAdding((open) => !open)}>
            {adding ? 'Cancel' : '+ Add a new connection'}
          </button>
        </div>
      ) : null}
    </>
  );
}
