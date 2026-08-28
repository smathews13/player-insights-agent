/**
 * Settings → Identity: the backend-defined service-principal personas.
 *
 * Connected identities remain rename-only. The generator saves a separate
 * credential-free operator plan because this app cannot administer Databricks
 * account service principals or grants with its declared scopes.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import {
  SP_CAPABILITY_EXAMPLES,
  SP_IDENTITY_MINTING_UNAVAILABLE,
  type SpIdentityAdminPayload,
  type SpMintingStatus,
  type SpPersona,
  type SpPersonaDefinition,
  type SpPersonaDefinitionWrite,
} from '../../shared/sp-identity';
import {
  createSpPersonaDefinition,
  deleteSpPersonaDefinition,
  EMPTY_SP_IDENTITY,
  loadSpIdentityAdmin,
  renameSpPersona,
  updateSpPersonaDefinition,
} from './identity-settings-api';
import { isSpPersonaDefinitionComplete } from './sp-persona-definition';
import { Button, Input, Textarea } from './ui';

export function SpIdentityEditor({
  enabled,
  payload,
  busy,
  error,
  success = null,
  onRename,
  onCreateDefinition,
  onUpdateDefinition,
  onDeleteDefinition,
}: {
  enabled: boolean;
  payload: SpIdentityAdminPayload;
  busy: boolean;
  error: string | null;
  success?: string | null;
  onRename: (id: string, displayName: string) => void;
  onCreateDefinition?: (write: SpPersonaDefinitionWrite) => boolean | Promise<boolean>;
  onUpdateDefinition?: (id: string, write: SpPersonaDefinitionWrite) => boolean | Promise<boolean>;
  onDeleteDefinition?: (id: string) => void;
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
      {success ? (
        <p className="settings-status" role="status">
          {success}
        </p>
      ) : null}

      <SpPersonaDefinitionBuilder
        busy={busy || !enabled || Boolean(error)}
        definitions={payload.personaDefinitions ?? []}
        onCreate={onCreateDefinition}
        onUpdate={onUpdateDefinition}
        onDelete={onDeleteDefinition}
      />
      <SpPersonaTable personas={payload.personas} busy={busy || !enabled} onRename={onRename} />
    </fieldset>
  );
}

const NEW_DEFINITION: SpPersonaDefinitionWrite = {
  displayName: '',
  description: '',
  capabilities: [...SP_CAPABILITY_EXAMPLES],
};

function SpPersonaDefinitionBuilder({
  busy,
  definitions,
  onCreate,
  onUpdate,
  onDelete,
}: {
  busy: boolean;
  definitions: SpPersonaDefinition[];
  onCreate?: (write: SpPersonaDefinitionWrite) => boolean | Promise<boolean>;
  onUpdate?: (id: string, write: SpPersonaDefinitionWrite) => boolean | Promise<boolean>;
  onDelete?: (id: string) => void;
}) {
  const [draft, setDraft] = useState<SpPersonaDefinitionWrite>(NEW_DEFINITION);
  const [editingId, setEditingId] = useState<string | null>(null);
  const canSubmit =
    !busy && isSpPersonaDefinitionComplete(draft) && (editingId ? Boolean(onUpdate) : Boolean(onCreate));

  function reset(): void {
    setEditingId(null);
    setDraft({ ...NEW_DEFINITION, capabilities: [...NEW_DEFINITION.capabilities] });
  }

  function edit(definition: SpPersonaDefinition): void {
    setEditingId(definition.id);
    setDraft({
      displayName: definition.displayName,
      description: definition.description,
      capabilities: [...definition.capabilities],
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    const write = {
      displayName: draft.displayName.trim(),
      description: draft.description.trim(),
      capabilities: draft.capabilities.map((capability) => capability.trim()),
    };
    const saved = editingId ? await onUpdate?.(editingId, write) : await onCreate?.(write);
    if (saved) reset();
  }

  return (
    <div className="sp-persona-definition-workspace">
      <form className="sp-persona-builder" onSubmit={(event) => void submit(event)}>
        <div className="sp-persona-builder-head">
          <div>
            <strong>{editingId ? 'Edit persona configuration' : 'Define a persona'}</strong>
            <p>
              Saves a credential-free plan. This app cannot create an account service principal or apply these grants.
            </p>
          </div>
          {editingId ? (
            <Button type="button" variant="outline" className="roster-control" onClick={reset} disabled={busy}>
              Cancel edit
            </Button>
          ) : null}
        </div>

        <div className="sp-persona-fields">
          <label className="runtime-field">
            <span className="runtime-field-label">Persona name</span>
            <Input
              value={draft.displayName}
              onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))}
              placeholder="Finance reporting reader"
              aria-label="Persona name"
              autoComplete="off"
              disabled={busy}
              required
            />
          </label>
          <label className="runtime-field">
            <span className="runtime-field-label">Purpose (optional)</span>
            <Textarea
              value={draft.description}
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
              placeholder="What this identity is for"
              aria-label="Persona purpose"
              disabled={busy}
              rows={2}
            />
          </label>
        </div>

        <div className="sp-capability-editor">
          <div className="sp-capability-heading">
            <span>Permissions and capabilities</span>
            <Button
              type="button"
              variant="outline"
              className="roster-control"
              disabled={busy || draft.capabilities.length >= 12}
              onClick={() => setDraft((current) => ({ ...current, capabilities: [...current.capabilities, ''] }))}
            >
              <Plus className="size-3.5" /> Add permission
            </Button>
          </div>
          {draft.capabilities.map((capability, index) => (
            // Positional identity keeps focus stable while an editable value changes.
            // eslint-disable-next-line react/no-array-index-key
            <div className="sp-capability-row" key={`${index}:${draft.capabilities.length}`}>
              <Input
                value={capability}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    capabilities: current.capabilities.map((value, item) =>
                      item === index ? event.target.value : value
                    ),
                  }))
                }
                aria-label={`Permission ${index + 1}`}
                disabled={busy}
                placeholder="Databricks object — permission"
              />
              <Button
                type="button"
                variant="ghost"
                className="sp-icon-button"
                disabled={busy}
                aria-label={`Remove permission ${index + 1}`}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    capabilities: current.capabilities.filter((_, item) => item !== index),
                  }))
                }
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>

        <div className="sp-persona-builder-foot">
          <p>An account admin must create the principal and grant this plan before it can run or be assigned.</p>
          <Button type="submit" disabled={!canSubmit}>
            {editingId ? 'Save persona' : 'Generate SP'}
          </Button>
        </div>
      </form>

      <SpPersonaDefinitionTable definitions={definitions} busy={busy} onEdit={edit} onDelete={onDelete} />
    </div>
  );
}

function SpPersonaDefinitionTable({
  definitions,
  busy,
  onEdit,
  onDelete,
}: {
  definitions: SpPersonaDefinition[];
  busy: boolean;
  onEdit: (definition: SpPersonaDefinition) => void;
  onDelete?: (id: string) => void;
}) {
  if (definitions.length === 0) {
    return <p className="sp-persona-empty">No SP persona configurations yet.</p>;
  }
  return (
    <div className="settings-table-frame sp-definitions-frame">
      <table className="settings-data-table sp-definitions-table">
        <thead>
          <tr>
            <th scope="col">Persona</th>
            <th scope="col">Purpose</th>
            <th scope="col">Permissions</th>
            <th scope="col">State</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {definitions.map((definition) => (
            <tr key={definition.id}>
              <td className="sp-definition-name" title={definition.displayName}>
                {definition.displayName}
              </td>
              <td className="sp-definition-purpose" title={definition.description || undefined}>
                {definition.description || '—'}
              </td>
              <td
                className="sp-definition-capabilities"
                title={definition.capabilities.join('\n')}
              >{`${definition.capabilities.length} selected`}</td>
              <td>
                <span className="ast-pill ast-pill--neutral-outline sp-definition-state">Configuration only</span>
              </td>
              <td className="sp-definition-actions">
                <Button
                  type="button"
                  variant="ghost"
                  className="sp-icon-button"
                  disabled={busy}
                  aria-label={`Edit ${definition.displayName}`}
                  onClick={() => onEdit(definition)}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="sp-icon-button settings-destructive"
                  disabled={busy || !onDelete}
                  aria-label={`Remove ${definition.displayName}`}
                  onClick={() => onDelete?.(definition.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A generated definition cannot execute anything: the credential-backed table
 * below still contains only identities an operator connected outside this UI.
 * Keeping those records separate prevents a configuration plan from appearing
 * in the human assignment dropdown before it can mint a token.
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
  const [success, setSuccess] = useState<string | null>(null);

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

  const run = async (successMessage: string, work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await work();
      setSuccess(successMessage);
      return true;
    } catch (caught) {
      setError((caught as Error).message);
      return false;
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
      success={success}
      onRename={(id, displayName) =>
        void run('Persona renamed.', async () => {
          await renameSpPersona(id, displayName);
          await load();
        })
      }
      onCreateDefinition={(write) =>
        run('SP persona configuration saved.', async () => {
          await createSpPersonaDefinition(write);
          await load();
        })
      }
      onUpdateDefinition={(id, write) =>
        run('SP persona configuration saved.', async () => {
          await updateSpPersonaDefinition(id, write);
          await load();
        })
      }
      onDeleteDefinition={(id) =>
        void run('SP persona configuration removed.', async () => {
          await deleteSpPersonaDefinition(id);
          await load();
        })
      }
    />
  );
}
