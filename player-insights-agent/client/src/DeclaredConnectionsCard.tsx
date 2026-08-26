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
import { useId, useState } from 'react';
import { Trash2 } from 'lucide-react';
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

export interface DeclaredConnectionsCardProps {
  entries?: ConnectionEntry[];
  /** Whether the store that holds these is answering. */
  storeAvailable?: boolean;
  /** Administrators only may add, withdraw or forget. Consumers still see the list. */
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
  /** The id awaiting permanent deletion, kept separate from recoverable removal. */
  const [forgetting, setForgetting] = useState('');
  /** The row added in this sitting, which carries the badge until the page is left. */
  const [justAdded, setJustAdded] = useState('');
  const formId = useId();

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
  const identifierLabel = picker.typeLabel
    .replace(/^Or type (an?|a) /i, '')
    .replace(/^./, (letter) => letter.toUpperCase());
  const emptyBrowseNote = ['tables', 'catalogs', 'volumes'].includes(chosenKind.browse)
    ? 'No catalogs are visible to this sign-in, usually because it has no Unity Catalog grants. You can still enter the name manually.'
    : `No ${chosenKind.label.toLowerCase()} are visible to this sign-in. You can still enter the identifier manually.`;
  // Only workspace-minted hexadecimal ids need a second, human-facing name.
  // A table, catalog, volume, index or endpoint already carries a readable name
  // in its identifier, so showing another blank name box asks for the same fact
  // twice and produces no additional information on the saved row.
  const needsDisplayName = chosenKind.id === 'genie-space' || chosenKind.id === 'sql-warehouse';
  const disabledReason = !storeAvailable
    ? 'The connection store is not answering.'
    : !value.trim()
      ? `Enter or choose a ${identifierLabel.toLowerCase()}.`
      : !id.trim()
        ? 'Enter a connection key.'
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
      setForgetting('');
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
          {/* THE DECISION COMES FIRST. The old row asked for a name before it
              said what was being named, then changed the meaning of the value
              box several controls later. Kind now leads both visual and
              keyboard order, and changing it clears values that belong to the
              previous kind rather than offering to submit a table as a model. */}
          <div className="plane-kind-field">
            <AppSelect
              label="Kind"
              ariaLabel="Kind"
              value={kindChoice}
              onValueChange={(next) => {
                setKindChoice(next);
                setId('');
                setLabel('');
                setValue('');
                setError('');
              }}
              options={ADDABLE_KINDS.map((entry) => ({ value: entry.id, label: entry.label }))}
              className="plane-field-select"
            />
          </div>

          <div className="plane-identifier-field">
            <label className="plane-field-label" htmlFor={`${formId}-identifier`}>
              {identifierLabel}
            </label>
            <input
              id={`${formId}-identifier`}
              className="plane-field ast-mono"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={picker.typeLabel.replace(/^Or type (an?|a) /i, '')}
            />
            {/* The browser is an alternative to typing, not a prerequisite.
                It follows the manual field so a missing optional browse grant
                never stands between the reader and the control that works. */}
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
                  setId(
                    (current) =>
                      current || `${chosenKind.id}-${stored.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '')}`
                  );
                }}
              />
              <p className="plane-picker-empty-note">{emptyBrowseNote}</p>
            </div>
          </div>

          {/* These names are not aliases. The display name is what a person
              sees in the list; the connection key is the stable id used when a
              saved row is removed or restored. Naming both jobs prevents the
              two blank "name" and "label" boxes from looking redundant while
              preserving the payload the server already accepts. */}
          <div className="plane-form-pair">
            {needsDisplayName ? (
              <label className="plane-field-group" htmlFor={`${formId}-label`}>
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
            <label className="plane-field-group" htmlFor={`${formId}-key`}>
              <span className="plane-field-label">Connection key</span>
              <input
                id={`${formId}-key`}
                className="plane-field ast-mono"
                value={id}
                onChange={(event) => setId(event.target.value)}
                placeholder={`${chosenKind.id}-name`}
              />
            </label>
          </div>
          <div className="plane-form-actions">
            <button
              type="button"
              className="plane-button"
              disabled={Boolean(disabledReason)}
              aria-describedby={disabledReason ? `${formId}-add-reason` : undefined}
              onClick={() => void add()}
            >
              Add
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
                {entry.connection.id === justAdded ? <span className="plane-row-new">{JUST_ADDED_LABEL}</span> : null}
              </span>
              <span className="plane-row-value ast-mono" title={row.fullIdentifier}>
                {row.identifier}
              </span>
              {/* A removed asset keeps its way back. This app is usually mid
                  demonstration when somebody removes the wrong thing, so the
                  row stays and offers "Put back" rather than disappearing. */}
              {allowMutations ? (
                <span className="plane-row-actions">
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
                </span>
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
