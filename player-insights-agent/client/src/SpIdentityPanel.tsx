/**
 * Settings → Identity: personas and who is assigned which one.
 *
 * Changes save immediately, like Roles. The pane is grayed until the
 * Experimental SP-identities switch is on — same pattern as Benchmarking.
 * There is no picker on Ask: an administrator assigns one persona per person.
 */
import { useCallback, useEffect, useState } from 'react';
import type { SpIdentityAdminPayload, SpIdentityRosterRow, SpMintingStatus, SpPersona } from '../../shared/sp-identity';
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
  const [displayName, setDisplayName] = useState('');
  const [clientId, setClientId] = useState('');
  const [secretScope, setSecretScope] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const canAdd = enabled && !busy && displayName.trim() && clientId.trim() && secretScope.trim() && secretKey.trim();

  const personaOptions = [
    { value: UNASSIGNED_PERSONA, label: 'OAuth (signed-in user)' },
    ...payload.personas.map((persona) => ({ value: persona.id, label: persona.displayName })),
  ];

  return (
    <fieldset className="sp-identity-cluster" disabled={!enabled} data-testid="sp-identity-pane">
      <legend className="runtime-section-label">Service principal personas</legend>
      <p className="settings-row-note">
        {enabled
          ? 'Each named identity is a Databricks service principal this app may run as. Assign one per person. People without an assignment still use OAuth.'
          : 'Turn SP identities on under Experimental to edit these. Until then, everyone still runs as themselves over OAuth.'}
      </p>
      <MintingNotice minting={payload.minting} />
      {error ? (
        <p className="settings-status settings-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="sp-identity-add">
        <label className="runtime-field">
          <span className="runtime-field-label">Display name</span>
          <Input
            type="text"
            autoComplete="off"
            aria-label="Persona display name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <label className="runtime-field">
          <span className="runtime-field-label">Application / client id</span>
          <Input
            type="text"
            autoComplete="off"
            aria-label="Service principal application id"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
          />
        </label>
        <label className="runtime-field">
          <span className="runtime-field-label">Secret scope</span>
          <Input
            type="text"
            autoComplete="off"
            aria-label="Databricks secret scope"
            value={secretScope}
            onChange={(event) => setSecretScope(event.target.value)}
          />
        </label>
        <label className="runtime-field">
          <span className="runtime-field-label">Secret key</span>
          <Input
            type="text"
            autoComplete="off"
            aria-label="Databricks secret key"
            value={secretKey}
            onChange={(event) => setSecretKey(event.target.value)}
          />
        </label>
        <p className="runtime-control-note">
          The OAuth client secret stays in Databricks Secrets. This app stores only the scope and key names, never the
          secret itself.
        </p>
        <Button
          type="button"
          data-variant="primary"
          disabled={!canAdd}
          onClick={() => {
            onAdd({
              displayName: displayName.trim(),
              clientId: clientId.trim(),
              secretScope: secretScope.trim(),
              secretKey: secretKey.trim(),
            });
            setDisplayName('');
            setClientId('');
            setSecretScope('');
            setSecretKey('');
          }}
        >
          Add persona
        </Button>
      </div>

      {payload.personas.length > 0 ? (
        <ul className="sp-identity-list">
          {payload.personas.map((persona) => (
            <li key={persona.id} className="sp-identity-persona">
              <div>
                <p className="sp-identity-persona-name">{persona.displayName}</p>
                <p className="sp-identity-persona-id">
                  <code>{persona.clientId}</code>
                  <span>
                    {' '}
                    · secret {persona.secretScope}/{persona.secretKey}
                  </span>
                </p>
              </div>
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
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-row-note">No personas yet.</p>
      )}

      <p className="runtime-section-label">Who runs as which persona</p>
      <p className="settings-row-note">
        Administrators assign this. People using the app do not pick a persona on Ask.
      </p>
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
  if (minting.available) {
    return (
      <p className="settings-row-note" data-testid="sp-identity-minting">
        {minting.detail}
      </p>
    );
  }
  return (
    <p className="settings-status settings-error" role="status" data-testid="sp-identity-minting">
      {minting.detail ||
        'This app cannot mint a token for another service principal. Assigned people would stay on OAuth.'}
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
    return (
      <p className="settings-row-note">
        Nobody is on the roster yet, so there is nobody to assign. Add people under Roles first.
      </p>
    );
  }
  const known = new Set(personas.map((persona) => persona.id));
  return (
    <ul className="sp-identity-assignments">
      {roster.map((row) => (
        <li key={row.email} className="sp-identity-assignment">
          <span className="sp-identity-assignment-email">{row.email}</span>
          <AppSelect
            label="Persona"
            ariaLabel={`Persona for ${row.email}`}
            value={row.personaId && known.has(row.personaId) ? row.personaId : UNASSIGNED_PERSONA}
            disabled={busy}
            onValueChange={(value) => onAssign(row.email, value === UNASSIGNED_PERSONA ? null : value)}
            options={options}
            className="sp-identity-assign-select"
          />
        </li>
      ))}
    </ul>
  );
}

export function SpIdentityPanel({ enabled }: { enabled: boolean }) {
  const [payload, setPayload] = useState<SpIdentityAdminPayload>(EMPTY_SP_IDENTITY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch('/api/admin/sp-identity');
      setPayload(await readPayload(response, 'loaded'));
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
