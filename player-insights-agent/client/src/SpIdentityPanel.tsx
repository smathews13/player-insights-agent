/**
 * Settings → Identity: the backend-defined service-principal personas.
 *
 * This table only lists and renames identities that already have credentials
 * behind them. Person-to-persona assignment lives in the human roster table so
 * one person is represented by one row.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  SP_IDENTITY_MINTING_UNAVAILABLE,
  type SpIdentityAdminPayload,
  type SpMintingStatus,
  type SpPersona,
} from '../../shared/sp-identity';
import { EMPTY_SP_IDENTITY, loadSpIdentityAdmin, renameSpPersona } from './identity-settings-api';
import { Button, Input } from './ui';

export function SpIdentityEditor({
  enabled,
  payload,
  busy,
  error,
  onRename,
}: {
  enabled: boolean;
  payload: SpIdentityAdminPayload;
  busy: boolean;
  error: string | null;
  onRename: (id: string, displayName: string) => void;
}) {
  return (
    <fieldset className="sp-identity-cluster" disabled={!enabled} data-testid="sp-identity-pane">
      <legend className="settings-section-title">SP Personas</legend>
      {!enabled ? <p className="settings-row-note">Turn SP identities on under Experimental</p> : null}
      <MintingNotice minting={payload.minting} />
      {error ? (
        <p className="settings-status settings-error" role="alert">
          {error}
        </p>
      ) : null}

      <SpPersonaTable personas={payload.personas} busy={busy || !enabled} onRename={onRename} />
    </fieldset>
  );
}

/**
 * A frontend-only role cannot execute anything: the backend needs an existing
 * client id and secret reference before it can mint an SP token. This editor
 * therefore only renames identities that the backend already defines. It never
 * POSTs invented credential placeholders and never deletes the stored identity.
 */
function SpPersonaTable({
  personas,
  busy,
  onRename,
}: {
  personas: SpPersona[];
  busy: boolean;
  onRename: (id: string, displayName: string) => void;
}) {
  return (
    <div className="settings-table-frame sp-personas-frame" data-testid="sp-personas-table">
      <table className="settings-data-table sp-personas-table">
        <thead>
          <tr>
            <th scope="col">Persona</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {personas.map((persona) => (
            <SpPersonaRow
              key={`${persona.id}:${persona.displayName}`}
              persona={persona}
              busy={busy}
              onRename={onRename}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SpPersonaRow({
  persona,
  busy,
  onRename,
}: {
  persona: SpPersona;
  busy: boolean;
  onRename: (id: string, displayName: string) => void;
}) {
  const [draftName, setDraftName] = useState(persona.displayName);
  const name = draftName.trim();
  const canSave = !busy && name.length > 0 && name !== persona.displayName;
  return (
    <tr>
      <td>
        <Input
          value={draftName}
          aria-label={`Persona name for ${persona.displayName}`}
          autoComplete="off"
          onChange={(event) => setDraftName(event.target.value)}
        />
      </td>
      <td className="sp-persona-action">
        <Button
          type="button"
          variant="outline"
          data-variant="outline"
          className="roster-control"
          disabled={!canSave}
          onClick={() => onRename(persona.id, name)}
        >
          Rename
        </Button>
      </td>
    </tr>
  );
}

function MintingNotice({ minting }: { minting: SpMintingStatus }) {
  const detail = minting.detail.trim();
  if (!detail || minting.available || detail === SP_IDENTITY_MINTING_UNAVAILABLE) return null;
  return (
    <p className="settings-status settings-error" role="status" data-testid="sp-identity-minting">
      {detail}
    </p>
  );
}

export function SpIdentityPanel({ enabled }: { enabled: boolean }) {
  const [payload, setPayload] = useState<SpIdentityAdminPayload>(EMPTY_SP_IDENTITY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPayload(await loadSpIdentityAdmin());
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SpIdentityEditor
      enabled={enabled}
      payload={payload}
      busy={busy}
      error={error}
      onRename={(id, displayName) =>
        void run(async () => {
          await renameSpPersona(id, displayName);
          await load();
        })
      }
    />
  );
}
