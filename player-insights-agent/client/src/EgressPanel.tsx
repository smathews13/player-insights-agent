import { useEffect, useState } from 'react';
import {
  controllablePaths,
  egressAllowed,
  type EgressChannel,
  type EgressControls,
  type EgressPath,
} from '../../shared/egress-contract';
import { adoptEgressControls, egressControlsSnapshot } from './egress-policy';
import { controlAccessibleName, enforcementPill } from './egress-panel';
import { egressControlsFromResponse, retainPendingEgressDrafts } from './egress-settings-api';
import type { SettingsSaveState } from './settings-save-state';
import { StateSwitch } from './StateSwitch';

export const EGRESS_SETTINGS_FORM_ID = 'settings-egress-form';

function ControlRow({
  path,
  allowed,
  disabled,
  onChange,
}: {
  path: EgressPath;
  allowed: boolean;
  disabled: boolean;
  onChange: (allowed: boolean) => void;
}) {
  const pill = enforcementPill(path);
  const blocked = path.enforcement === 'enforced' && !allowed ? ' · Blocked by the server' : '';
  return (
    <div className="egress-row">
      <div className="egress-row-head">
        <p>
          {path.label}
          <span className={`egress-mode egress-mode-${path.enforcement}`}>{pill.label}</span>
        </p>
        <StateSwitch
          checked={allowed}
          disabled={disabled}
          onCheckedChange={onChange}
          aria-label={controlAccessibleName(path)}
        />
      </div>
      <p className="egress-facts">
        {path.where}
        {blocked}
      </p>
    </div>
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
  const [failure, setFailure] = useState<{ operation: 'load' | 'save'; message: string } | null>(null);
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
      <div className="egress-list">
        {controllablePaths().map((path) => (
          <ControlRow
            key={path.channel}
            path={path}
            allowed={egressAllowed(controls, path.channel)}
            disabled={controlsDisabled}
            onChange={(allowed) => {
              setFailure((current) => (current?.operation === 'save' ? null : current));
              setState('ready');
              setControls((current) => ({ ...current, [path.channel]: allowed }));
            }}
          />
        ))}
      </div>
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
