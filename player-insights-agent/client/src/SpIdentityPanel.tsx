/**
 * Settings → Identity: executable SP roles and who is assigned which one.
 *
 * Changes save immediately, like human roles. The pane is grayed until the
 * Experimental SP-identities switch is on — same pattern as Benchmarking.
 * There is no picker on Ask: an administrator assigns one SP role per person.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  SP_IDENTITY_MINTING_UNAVAILABLE,
  type SpIdentityAdminPayload,
  type SpIdentityRosterRow,
  type SpMintingStatus,
  type SpPersona,
} from '../../shared/sp-identity';
import { ROLE_WORD, type Role } from '../../shared/user-roster-contract';
import { AppSelect } from './AppSelect';
import { Button, Input } from './ui';

export const EMPTY_SP_IDENTITY: SpIdentityAdminPayload = {
  enabled: false,
  minting: { available: false, detail: '' },
  personas: [],
  assignments: [],
  roster: [],
};

/** Radix Select refuses an empty string; this is "no SP role, stay on OAuth". */
export const UNASSIGNED_PERSONA = 'oauth';

function rosterRoleLabel(role: string): string {
  return role in ROLE_WORD ? ROLE_WORD[role as Role] : role;
}

function serverDetail(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const detail = (body as { detail?: unknown }).detail;
  return typeof detail === 'string' && detail.trim() ? detail.trim() : fallback;
}

export async function persistSpIdentityMode(enabled: boolean): Promise<SpIdentityAdminPayload> {
  const response = await fetch('/api/admin/sp-identity/mode', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  return readPayload(response, 'saved the experimental pivot');
}

export async function loadSpIdentityAdmin(): Promise<SpIdentityAdminPayload> {
  const response = await fetch('/api/admin/sp-identity');
  return readPayload(response, 'loaded');
}

async function readPayload(response: Response, operation: string): Promise<SpIdentityAdminPayload> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? `SP user roles returned an unreadable response when ${operation}.`
        : `SP user roles answered ${response.status} without an error message.`
    );
  }
  if (!response.ok) {
    throw new Error(serverDetail(body, `SP user roles answered ${response.status}.`));
  }
  return body as SpIdentityAdminPayload;
}

export function SpIdentityEditor({
  enabled,
  payload,
  busy,
  error,
  onRename,
  onAssign,
}: {
  enabled: boolean;
  payload: SpIdentityAdminPayload;
  busy: boolean;
  error: string | null;
  onRename: (id: string, displayName: string) => void;
  onAssign: (email: string, personaId: string | null) => void;
}) {
  const personaOptions = [
    { value: UNASSIGNED_PERSONA, label: 'Signed-in user (OAuth)' },
    ...payload.personas.map((persona) => ({ value: persona.id, label: persona.displayName })),
  ];

  return (
    <fieldset className="sp-identity-cluster" disabled={!enabled} data-testid="sp-identity-pane">
      <legend className="settings-section-title">SP user roles</legend>
      {!enabled ? <p className="settings-row-note">Turn SP identities on under Experimental</p> : null}
      <MintingNotice minting={payload.minting} />
      {error ? (
        <p className="settings-status settings-error" role="alert">
          {error}
        </p>
      ) : null}

      {payload.personas.length > 0 ? (
        <SpRoleNameEditor personas={payload.personas} busy={busy || !enabled} onRename={onRename} />
      ) : null}

      <AssignmentRows
        roster={payload.roster}
        personas={payload.personas}
        options={personaOptions}
        busy={busy || !enabled}
        onAssign={onAssign}
      />
    </fieldset>
  );
}

/**
 * A frontend-only role cannot execute anything: the backend needs an existing
 * client id and secret reference before it can mint an SP token. This editor
 * therefore only renames identities that the backend already defines. It never
 * POSTs invented credential placeholders and never deletes the stored identity.
 */
function SpRoleNameEditor({
  personas,
  busy,
  onRename,
}: {
  personas: SpPersona[];
  busy: boolean;
  onRename: (id: string, displayName: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(personas[0]?.id ?? '');
  const selected = personas.find((persona) => persona.id === selectedId) ?? personas[0];
  const [draftName, setDraftName] = useState(selected?.displayName ?? '');
  if (!selected) return null;
  const name = draftName.trim();
  const canSave = !busy && name.length > 0 && name !== selected.displayName;
  return (
    <div className="sp-role-name-editor" data-testid="sp-role-name-editor">
      <label className="runtime-field sp-role-picker">
        <span className="runtime-field-label">Existing SP role</span>
        <AppSelect
          label="SP role"
          ariaLabel="Existing SP role"
          value={selected.id}
          options={personas.map((persona) => ({ value: persona.id, label: persona.displayName }))}
          disabled={busy}
          onValueChange={(id) => {
            const next = personas.find((persona) => persona.id === id);
            setSelectedId(id);
            setDraftName(next?.displayName ?? '');
          }}
          className="sp-role-picker-select"
        />
      </label>
      <label className="runtime-field sp-role-name">
        <span className="runtime-field-label">SP role name</span>
        <Input
          value={draftName}
          aria-label="SP role name"
          autoComplete="off"
          onChange={(event) => setDraftName(event.target.value)}
        />
      </label>
      <Button
        type="button"
        variant="outline"
        data-variant="outline"
        className="roster-control sp-role-name-save"
        disabled={!canSave}
        onClick={() => onRename(selected.id, name)}
      >
        Save role name
      </Button>
    </div>
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

function AssignmentRows({
  roster,
  personas,
  options,
  busy,
  onAssign,
}: {
  roster: SpIdentityRosterRow[];
  personas: SpPersona[];
  options: { value: string; label: string }[];
  busy: boolean;
  onAssign: (email: string, personaId: string | null) => void;
}) {
  if (roster.length === 0) {
    return null;
  }
  const known = new Set(personas.map((persona) => persona.id));
  return (
    <div className="settings-table-frame sp-identity-table-frame sp-identity-assignments">
      <table className="settings-data-table sp-role-table">
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Human role</th>
            <th scope="col">SP role</th>
          </tr>
        </thead>
        <tbody>
          {roster.map((row) => (
            <tr key={row.email}>
              <td className="sp-identity-assignment-email" title={row.email}>
                {row.email}
              </td>
              <td>
                <span className="ast-pill ast-pill--neutral-outline">{rosterRoleLabel(row.role)}</span>
              </td>
              <td className="sp-identity-assignment-control">
                <AppSelect
                  label="SP role"
                  ariaLabel={`SP role for ${row.email}`}
                  value={row.personaId && known.has(row.personaId) ? row.personaId : UNASSIGNED_PERSONA}
                  disabled={busy}
                  onValueChange={(value) => onAssign(row.email, value === UNASSIGNED_PERSONA ? null : value)}
                  options={options}
                  className="sp-role-select"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
          const response = await fetch(`/api/admin/sp-identity/personas/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ displayName }),
          });
          if (!response.ok) {
            let body: unknown = null;
            try {
              body = await response.json();
            } catch {
              body = null;
            }
            throw new Error(serverDetail(body, `Saving the SP role name answered ${response.status}.`));
          }
          await load();
        })
      }
      onAssign={(email, personaId) =>
        void run(async () => {
          const response = await fetch('/api/admin/sp-identity/assignments', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email, personaId }),
          });
          const body = (await response.json().catch(() => null)) as { payload?: SpIdentityAdminPayload } | null;
          if (!response.ok) {
            throw new Error(serverDetail(body, `The assignment answered ${response.status}.`));
          }
          if (body?.payload) setPayload(body.payload);
          else await load();
        })
      }
    />
  );
}
