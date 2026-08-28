import { useEffect, useState } from 'react';
import {
  controllablePaths,
  egressAllowed,
  type EgressChannel,
  type EgressControls,
  type EgressControlsPayload,
  type EgressPath,
} from '../../shared/egress-contract';
import { adoptEgressControls, egressControlsSnapshot } from './egress-policy';
import { controlAccessibleName, enforcementPill } from './egress-panel';
import type { SettingsSaveState } from './settings-save-state';
import { StateSwitch } from './StateSwitch';

export const EGRESS_SETTINGS_FORM_ID = 'settings-egress-form';

function ControlRow({
  path,
  allowed,
  onChange,
}: {
  path: EgressPath;
  allowed: boolean;
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
          onLabel="Allowed"
          offLabel="Blocked"
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

export function EgressPanel({ onSaveState = () => {} }: { onSaveState?: (state: SettingsSaveState) => void }) {
  const [controls, setControls] = useState<EgressControls>(() => egressControlsSnapshot());
  const [savedControls, setSavedControls] = useState<EgressControls>(() => egressControlsSnapshot());
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'failed'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch('/api/egress/controls', { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as EgressControlsPayload;
        if (!live || !payload?.controls) return;
        setControls(payload.controls);
        setSavedControls(payload.controls);
        adoptEgressControls(payload.controls);
        setState('ready');
      } catch (caught) {
        if (!live) return;
        setError((caught as Error).message);
        setState('failed');
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function save() {
    setState('saving');
    setError('');
    onSaveState({ kind: 'saving' });
    let latest = savedControls;
    try {
      for (const path of controllablePaths()) {
        const channel: EgressChannel = path.channel;
        if (controls[channel] === savedControls[channel]) continue;
        const response = await fetch('/api/egress/admin/controls', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel, allowed: controls[channel] }),
        });
        if (!response.ok) throw new Error(`Could not save ${path.label.toLowerCase()}. HTTP ${response.status}`);
        const payload = (await response.json()) as EgressControlsPayload;
        if (payload?.controls) latest = payload.controls;
      }
      setControls(latest);
      setSavedControls(latest);
      adoptEgressControls(latest);
      setState('saved');
      onSaveState({ kind: 'saved' });
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message);
      setState('failed');
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
            onChange={(allowed) => setControls((current) => ({ ...current, [path.channel]: allowed }))}
          />
        ))}
      </div>
      {state === 'loading' ? <p className="settings-status">Loading controls.</p> : null}
      {state === 'saving' ? <p className="settings-status">Saving controls.</p> : null}
      {state === 'saved' ? (
        <p className="settings-status" role="status">
          Egress controls saved.
        </p>
      ) : null}
      {error ? (
        <p className="settings-status settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
