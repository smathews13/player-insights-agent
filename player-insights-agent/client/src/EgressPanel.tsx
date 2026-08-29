import { useEffect, useState } from 'react';
import {
  controllablePaths,
  egressAllowed,
  type EgressChannel,
  type EgressControls,
  type EgressEventsPayload,
  type EgressPath,
  type EgressStorageMetadata,
} from '../../shared/egress-contract';
import { adoptEgressControls, egressControlsSnapshot } from './egress-policy';
import {
  controlAccessibleName,
  controlStatusPill,
  EGRESS_JUDGE_COPY,
  EGRESS_OBSERVATION_COPY,
  EGRESS_OUTCOME_LABEL,
  enforcementBoundary,
  eventFacts,
} from './egress-panel';
import {
  EgressRecordsError,
  egressControlsFromResponse,
  fetchEgressRecordsPage,
  retainPendingEgressDrafts,
} from './egress-settings-api';
import type { SettingsSaveState } from './settings-save-state';
import { StateSwitch } from './StateSwitch';

export const EGRESS_SETTINGS_FORM_ID = 'settings-egress-form';

function ControlRow({
  path,
  allowed,
  effectiveAllowed,
  policyLoaded,
  disabled,
  onChange,
}: {
  path: EgressPath;
  allowed: boolean;
  effectiveAllowed: boolean;
  policyLoaded: boolean;
  disabled: boolean;
  onChange: (allowed: boolean) => void;
}) {
  const pill = controlStatusPill(path, allowed, effectiveAllowed, policyLoaded);
  return (
    <div className="egress-row">
      <div className="egress-row-head">
        <p>
          {path.label}
          <span className={`egress-mode egress-mode-${pill.tone}`}>{pill.label}</span>
        </p>
        <StateSwitch
          checked={allowed}
          disabled={disabled}
          onCheckedChange={onChange}
          aria-label={controlAccessibleName(path)}
        />
      </div>
      <p className="egress-facts">{path.where}</p>
      <details className="egress-boundary">
        <summary>Boundary</summary>
        <p>{enforcementBoundary(path)}</p>
      </details>
    </div>
  );
}

export type EgressRecordsViewState = 'idle' | 'loading' | 'ready' | 'error' | 'authorization';

export function EgressRecordsViewer({
  state,
  payload,
  error,
  page,
  onView,
  onRefresh,
  onNewer,
  onOlder,
}: {
  state: EgressRecordsViewState;
  payload: EgressEventsPayload | null;
  error: string;
  page: number;
  onView: () => void;
  onRefresh: () => void;
  onNewer: () => void;
  onOlder: () => void;
}) {
  if (state === 'idle') {
    return (
      <button className="egress-record-button" type="button" onClick={onView}>
        View records
      </button>
    );
  }
  if (state === 'loading') {
    return (
      <p className="settings-status" role="status">
        Loading egress records.
      </p>
    );
  }
  if (state === 'authorization') {
    return (
      <div className="egress-record-state" role="alert">
        <p>Administrator access is required to view egress records.</p>
        <button className="egress-record-button" type="button" onClick={onRefresh}>
          Retry
        </button>
      </div>
    );
  }
  if (state === 'error' || !payload) {
    return (
      <div className="egress-record-state" role="alert">
        <p>{error || 'Egress records could not be loaded.'}</p>
        <button className="egress-record-button" type="button" onClick={onRefresh}>
          Retry
        </button>
      </div>
    );
  }

  const recordsAvailable = payload.readState === 'read';
  return (
    <div className="egress-records">
      <div className="egress-record-actions">
        <span className="settings-status">{recordsAvailable ? `Page ${page + 1}` : 'Records unavailable'}</span>
        <button className="egress-record-button" type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {payload.readState === 'not-migrated' ? (
        <p className="settings-status settings-error" role="alert">
          The egress event table has not been migrated on this deployment.
        </p>
      ) : null}
      {payload.readState === 'unavailable' ? (
        <p className="settings-status settings-error" role="alert">
          Lakebase did not answer the egress records query.
        </p>
      ) : null}
      {recordsAvailable && payload.events.length === 0 ? (
        <p className="settings-status">No reported egress records on this page.</p>
      ) : null}
      {recordsAvailable && payload.events.length > 0 ? (
        <div className="egress-record-table-wrap">
          <table className="egress-record-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Actor</th>
                <th scope="col">Record</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {payload.events.map((event) => (
                <tr key={event.id}>
                  <td>{event.occurredAt}</td>
                  <td>{event.actor}</td>
                  <td>{eventFacts(event).join(' · ')}</td>
                  <td>{EGRESS_OUTCOME_LABEL[event.outcome]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {recordsAvailable ? (
        <div className="egress-pagination" aria-label="Egress record pages">
          <button className="egress-record-button" type="button" disabled={page === 0} onClick={onNewer}>
            Newer
          </button>
          <button className="egress-record-button" type="button" disabled={!payload.nextCursor} onClick={onOlder}>
            Older
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function EgressStorageMetadataCard({ storage }: { storage: EgressStorageMetadata | null }) {
  if (!storage) {
    return <p className="settings-status">Storage metadata is unavailable until the policy endpoint answers.</p>;
  }
  return (
    <dl className="egress-storage">
      <div>
        <dt>Store</dt>
        <dd>
          {storage.store} · <code>{storage.eventsTable}</code> · <code>{storage.controlsTable}</code>
        </dd>
      </div>
      <div>
        <dt>Retains</dt>
        <dd>{storage.retained}</dd>
      </div>
      <div>
        <dt>Scope</dt>
        <dd>
          {storage.identityScope} {storage.retention}
        </dd>
      </div>
    </dl>
  );
}

export function EgressPanel({
  onSaveState = () => {},
  onDirtyChange = () => {},
}: {
  onSaveState?: (state: SettingsSaveState) => void;
  onDirtyChange?: (count: number) => void;
}) {
  const [controls, setControls] = useState<EgressControls>(() => egressControlsSnapshot());
  const [savedControls, setSavedControls] = useState<EgressControls>(() => egressControlsSnapshot());
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'failed'>('loading');
  const [stored, setStored] = useState<boolean | null>(null);
  const [storage, setStorage] = useState<EgressStorageMetadata | null>(null);
  const [failure, setFailure] = useState<{ operation: 'load' | 'save'; message: string } | null>(null);
  const [recordsState, setRecordsState] = useState<EgressRecordsViewState>('idle');
  const [records, setRecords] = useState<EgressEventsPayload | null>(null);
  const [recordsError, setRecordsError] = useState('');
  const [recordCursors, setRecordCursors] = useState<(string | null)[]>([null]);
  const recordPage = recordCursors.length - 1;
  const changedCount = controllablePaths().filter(
    (path) => controls[path.channel] !== savedControls[path.channel]
  ).length;
  const controlsDisabled = state === 'loading' || state === 'saving' || failure?.operation === 'load';

  useEffect(() => {
    onDirtyChange(changedCount);
  }, [changedCount, onDirtyChange]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch('/api/egress/controls', { headers: { Accept: 'application/json' } });
        const loaded = await egressControlsFromResponse(response, 'loaded');
        if (!live) return;
        setControls(loaded.controls);
        setSavedControls(loaded.controls);
        setStored(loaded.stored);
        setStorage(loaded.storage);
        adoptEgressControls(loaded.controls);
        setState('ready');
      } catch (caught) {
        if (!live) return;
        setFailure({ operation: 'load', message: (caught as Error).message });
        setState('failed');
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function loadRecords(cursor: string | null, cursors: (string | null)[]) {
    setRecordsState('loading');
    setRecordsError('');
    try {
      const payload = await fetchEgressRecordsPage(cursor);
      setRecords(payload);
      setStorage(payload.storage);
      setRecordCursors(cursors);
      setRecordsState('ready');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Egress records could not be loaded.';
      setRecordsError(message);
      setRecordsState(
        caught instanceof EgressRecordsError && caught.kind === 'authorization' ? 'authorization' : 'error'
      );
    }
  }

  async function save() {
    setState('saving');
    setFailure(null);
    onSaveState({ kind: 'saving' });
    const changes = controllablePaths().filter((path) => controls[path.channel] !== savedControls[path.channel]);
    const pending = new Set<EgressChannel>(changes.map((path) => path.channel));
    let latest = savedControls;
    try {
      for (const path of changes) {
        const channel: EgressChannel = path.channel;
        const response = await fetch('/api/egress/admin/controls', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel, allowed: controls[channel] }),
        });
        try {
          const saved = await egressControlsFromResponse(response, 'saved');
          latest = saved.controls;
          setStored(saved.stored);
          setStorage(saved.storage);
        } catch (caught) {
          throw new Error(`Could not save ${path.label.toLowerCase()}. ${(caught as Error).message}`);
        }
        pending.delete(channel);
      }
      setControls(latest);
      setSavedControls(latest);
      adoptEgressControls(latest);
      setState('saved');
      onDirtyChange(0);
      onSaveState({ kind: 'saved', count: changedCount });
    } catch (caught) {
      const message = (caught as Error).message;
      setControls((current) => retainPendingEgressDrafts(current, latest, pending));
      setSavedControls(latest);
      adoptEgressControls(latest);
      onDirtyChange(pending.size);
      setFailure({ operation: 'save', message });
      setState('ready');
      onSaveState({ kind: 'failed', message });
    }
  }

  return (
    <form
      id={EGRESS_SETTINGS_FORM_ID}
      className="settings-pane"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="settings-pane-heading">
        <h3>Egress controls</h3>
      </div>
      <div className="egress-summary">
        <div>
          <span>Policy</span>
          <strong>{stored === null ? 'Loading' : stored ? 'Lakebase + defaults' : 'Build defaults'}</strong>
        </div>
        <div>
          <span>PII judge</span>
          <strong>Not running</strong>
        </div>
        <div>
          <span>Observation</span>
          <strong>Partial</strong>
        </div>
      </div>
      <p className="egress-compact-note">{EGRESS_JUDGE_COPY}</p>
      <div className="egress-list">
        {controllablePaths().map((path) => (
          <ControlRow
            key={path.channel}
            path={path}
            allowed={egressAllowed(controls, path.channel)}
            effectiveAllowed={egressAllowed(savedControls, path.channel)}
            policyLoaded={failure?.operation !== 'load' && state !== 'loading'}
            disabled={controlsDisabled}
            onChange={(allowed) => {
              setFailure((current) => (current?.operation === 'save' ? null : current));
              setState('ready');
              setControls((current) => ({ ...current, [path.channel]: allowed }));
            }}
          />
        ))}
      </div>
      <section className="egress-ledger" aria-labelledby="egress-ledger-title">
        <div className="egress-ledger-head">
          <div>
            <h4 id="egress-ledger-title">Storage and recent records</h4>
            <p>{EGRESS_OBSERVATION_COPY}</p>
          </div>
        </div>
        <EgressStorageMetadataCard storage={storage} />
        <EgressRecordsViewer
          state={recordsState}
          payload={records}
          error={recordsError}
          page={recordPage}
          onView={() => void loadRecords(null, [null])}
          onRefresh={() => void loadRecords(null, [null])}
          onNewer={() => {
            const cursors = recordCursors.slice(0, -1);
            void loadRecords(cursors[cursors.length - 1] ?? null, cursors.length > 0 ? cursors : [null]);
          }}
          onOlder={() => {
            if (!records?.nextCursor) return;
            void loadRecords(records.nextCursor, [...recordCursors, records.nextCursor]);
          }}
        />
      </section>
      {state === 'loading' ? <p className="settings-status">Loading controls.</p> : null}
      {state === 'saving' ? <p className="settings-status">Saving controls.</p> : null}
      {stored === false && failure?.operation !== 'load' ? (
        <p className="settings-status">Stored policy is unavailable. Build defaults are shown.</p>
      ) : null}
      {state === 'saved' ? (
        <p className="settings-status" role="status">
          Egress controls saved.
        </p>
      ) : null}
      {failure ? (
        <p className="settings-status settings-error" role="alert">
          {failure.message}
        </p>
      ) : null}
    </form>
  );
}
