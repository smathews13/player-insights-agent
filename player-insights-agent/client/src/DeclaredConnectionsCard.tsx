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
import {
  ADDABLE_KINDS,
  REMOVE_LABEL,
  RESTORE_LABEL,
  orderConnections,
} from './declared-connection-view';
import type { ConnectionEntry } from './connection-model';
import { AssetPicker } from './AssetPicker';
import type { AssetPickerSpec } from './asset-picker';

const ADD_CONNECTION_PICKERS: Record<'tables' | 'genie-spaces' | 'catalogs', AssetPickerSpec> = {
  tables: {
    field: 'add-table',
    levels: ['catalogs', 'schemas', 'tables'],
    pickAt: 'last',
    multi: false,
    title: 'Tables your sign-in can see',
    typeLabel: 'Or type a three-part table name',
    typeNote: '',
  },
  'genie-spaces': {
    field: 'add-genie-space',
    levels: ['genie-spaces'],
    pickAt: 'last',
    multi: false,
    title: 'Genie spaces your sign-in can see',
    typeLabel: 'Or type a Genie space ID',
    typeNote: '',
  },
  catalogs: {
    field: 'add-catalog',
    levels: ['catalogs'],
    pickAt: 'last',
    multi: false,
    title: 'Catalogs your sign-in can see',
    typeLabel: 'Or type a catalog name',
    typeNote: '',
  },
};

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

  const listed = orderConnections(entries ?? []);
  const chosenKind = ADDABLE_KINDS.find((entry) => entry.id === kindChoice) ?? ADDABLE_KINDS[0];
  const picker = chosenKind.browse ? ADD_CONNECTION_PICKERS[chosenKind.browse] : null;

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
          {picker ? (
            <AssetPicker
              spec={picker}
              current={value}
              onPick={(picked) => {
                setValue(picked);
                setLabel((current) => current || picked.split(/[./]/).filter(Boolean).at(-1) || picked);
                setId(
                  (current) =>
                    current || `${chosenKind.id}-${picked.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '')}`
                );
              }}
            />
          ) : null}
          <input
            className="plane-field ast-mono"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="catalog.schema.table"
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
        return (
          <div key={entry.connection.id} className="plane-stack">
            <div className="plane-row" data-state={entry.connection.state}>
              <span className="plane-row-name">{entry.connection.label}</span>
              <span className="plane-row-value ast-mono" title={entry.connection.value}>
                {entry.connection.value}
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
