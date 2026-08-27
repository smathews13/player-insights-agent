/**
 * Settings → Identity: personas and who is assigned which one.
 *
 * Changes save immediately, like Roles. The pane is grayed until the
 * Experimental SP-identities switch is on — same pattern as Benchmarking.
 * There is no picker on Ask: an administrator assigns one persona per person.
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

/** Radix Select refuses an empty string; this is "no persona, stay on OAuth". */
export const UNASSIGNED_PERSONA = 'oauth';

function rosterRoleLabel(role: string): string {
  return role in ROLE_WORD ? ROLE_WORD[role as Role] : role;
}

/** Field-help and ghost examples on Add persona. Invented values, never a live id. */
export const SP_PERSONA_FIELDS = [
  {
    key: 'displayName',
    label: 'Display name',
    ariaLabel: 'Persona display name',
    help: 'Name users will see for this persona.',
    placeholder: 'Analytics service principal',
  },
  {
    key: 'clientId',
    label: 'Application / client id',
    ariaLabel: 'Service principal application id',
    help: 'Application ID of the Databricks service principal.',
    placeholder: '00000000-0000-4000-a000-000000000000',
  },
  {
    key: 'secretScope',
    label: 'Secret scope',
    ariaLabel: 'Databricks secret scope',
    help: 'Secret scope containing its OAuth client secret.',
    placeholder: 'my-app-secrets',
  },
  {
    key: 'secretKey',
    label: 'Secret key',
    ariaLabel: 'Databricks secret key',
    help: 'Key holding the OAuth client secret.',
    placeholder: 'client-secret',
  },
] as const;

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
        ? `Service-principal personas returned an unreadable response when ${operation}.`
        : `Service-principal personas answered ${response.status} without an error message.`
    );
  }
  if (!response.ok) {
    throw new Error(serverDetail(body, `Service-principal personas answered ${response.status}.`));
  }
  return body as SpIdentityAdminPayload;
}

function PersonaDraftField({
  field,
  value,
  onChange,
}: {
  field: (typeof SP_PERSONA_FIELDS)[number];
  value: string;
  onChange: (value: string) => void;
}) {
  const helpId = `sp-persona-${field.key}-help`;
  return (
    <label className="runtime-field">
      <span className="runtime-field-label">{field.label}</span>
      <span id={helpId} className="runtime-control-note">
        {field.help}
      </span>
      <Input
        type="text"
        autoComplete="off"
        aria-label={field.ariaLabel}
        aria-describedby={helpId}
        placeholder={field.placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function SpIdentityEditor({
  enabled,
  payload,
  busy,
  error,
  onAdd,
  onRemove,
  onAssign,
}: {
  enabled: boolean;
  payload: SpIdentityAdminPayload;
  busy: boolean;
  error: string | null;
  onAdd: (persona: { displayName: string; clientId: string; secretScope: string; secretKey: string }) => void;
  onRemove: (id: string) => void;
  onAssign: (email: string, personaId: string | null) => void;
}) {
  const [draft, setDraft] = useState({
    displayName: '',
    clientId: '',
    secretScope: '',
    secretKey: '',
  });
  const canAdd =
    enabled &&
    !busy &&
    draft.displayName.trim() &&
    draft.clientId.trim() &&
    draft.secretScope.trim() &&
    draft.secretKey.trim();

  const personaOptions = [
    { value: UNASSIGNED_PERSONA, label: 'OAuth (signed-in user)' },
    ...payload.personas.map((persona) => ({ value: persona.id, label: persona.displayName })),
  ];

  return (
    <fieldset className="sp-identity-cluster" disabled={!enabled} data-testid="sp-identity-pane">
      <legend className="runtime-section-label">Service principal personas</legend>
      {!enabled ? <p className="settings-row-note">Turn SP identities on under Experimental</p> : null}
      <MintingNotice minting={payload.minting} />
      {error ? (
        <p className="settings-status settings-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="sp-identity-add">
        {SP_PERSONA_FIELDS.map((field) => (
          <PersonaDraftField
            key={field.key}
            field={field}
            value={draft[field.key]}
            onChange={(value) => setDraft((current) => ({ ...current, [field.key]: value }))}
          />
        ))}
        <Button
          type="button"
          data-variant="primary"
          disabled={!canAdd}
          onClick={() => {
            onAdd({
              displayName: draft.displayName.trim(),
              clientId: draft.clientId.trim(),
              secretScope: draft.secretScope.trim(),
              secretKey: draft.secretKey.trim(),
            });
            setDraft({ displayName: '', clientId: '', secretScope: '', secretKey: '' });
          }}
        >
          Add persona
        </Button>
      </div>

      {payload.personas.length > 0 ? (
        <div className="sp-identity-table-frame">
          <table className="settings-data-table sp-identity-personas">
            <thead>
              <tr>
                <th scope="col">Display name</th>
                <th scope="col">Application / client ID</th>
                <th scope="col">Secret reference</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {payload.personas.map((persona) => (
                <tr key={persona.id}>
                  <td className="sp-identity-persona-name">{persona.displayName}</td>
                  <td className="sp-identity-persona-id">
                    <code>{persona.clientId}</code>
                  </td>
                  <td className="sp-identity-secret-reference">
                    <code>
                      {persona.secretScope}/{persona.secretKey}
                    </code>
                  </td>
                  <td className="sp-identity-actions">
                    <Button
                      type="button"
                      variant="outline"
                      data-variant="outline"
                      disabled={!enabled || busy}
                      aria-label={`Remove ${persona.displayName}`}
                      onClick={() => onRemove(persona.id)}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
    <div className="sp-identity-table-frame sp-identity-assignments">
      <table className="settings-data-table">
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Persona</th>
          </tr>
        </thead>
        <tbody>
          {roster.map((row) => (
            <tr key={row.email}>
              <td className="sp-identity-assignment-email">{row.email}</td>
              <td>
                <span className="ast-pill ast-pill--neutral-outline">{rosterRoleLabel(row.role)}</span>
              </td>
              <td className="sp-identity-assignment-control">
                <AppSelect
                  label="Persona"
                  ariaLabel={`Persona for ${row.email}`}
                  value={row.personaId && known.has(row.personaId) ? row.personaId : UNASSIGNED_PERSONA}
                  disabled={busy}
                  onValueChange={(value) => onAssign(row.email, value === UNASSIGNED_PERSONA ? null : value)}
                  options={options}
                  className="sp-identity-assign-select"
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
      onAdd={(persona) =>
        void run(async () => {
          const response = await fetch('/api/admin/sp-identity/personas', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(persona),
          });
          if (!response.ok) {
            let body: unknown = null;
            try {
              body = await response.json();
            } catch {
              body = null;
            }
            throw new Error(serverDetail(body, `Adding the persona answered ${response.status}.`));
          }
          await load();
        })
      }
      onRemove={(id) =>
        void run(async () => {
          const response = await fetch(`/api/admin/sp-identity/personas/${encodeURIComponent(id)}`, {
            method: 'DELETE',
          });
          if (!response.ok && response.status !== 204) {
            throw new Error(`Removing the persona answered ${response.status}.`);
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
