/**
 * Settings → Identity: the backend-defined service-principal personas.
 *
 * Connected identities remain rename-only. The generator saves a separate
 * credential-free operator plan because this app cannot administer Databricks
 * account service principals or grants with its declared scopes.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Copy, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import {
  SP_GRANT_MATRIX,
  SP_GRANT_RESOURCE_TYPES,
  SP_IDENTITY_MINTING_UNAVAILABLE,
  spGrantIdentifierFault,
  spGrantKey,
  spGrantSummary,
  type SpGrant,
  type SpGrantAction,
  type SpGrantResource,
  type SpGrantResourceType,
  type SpIdentityAdminPayload,
  type SpMintingStatus,
  type SpPersona,
  type SpPersonaDefinition,
  type SpPersonaDefinitionWrite,
} from '../../shared/sp-identity';
import {
  createSpPersonaDefinition,
  deleteSpPersonaDefinition,
  loadSpIdentityAdmin,
  renameSpPersona,
  updateSpPersonaDefinition,
} from './identity-settings-api';
import {
  changeSpGrantAction,
  changeSpGrantType,
  grantsFromLegacy,
  isSpPersonaDefinitionComplete,
  newSpGrant,
} from './sp-persona-definition';
import {
  failSpIdentityRead,
  finishSpIdentityRead,
  INITIAL_SP_IDENTITY_READ_STATE,
  startSpIdentityRead,
} from './sp-identity-read-state';
import { AppSelect } from './AppSelect';
import { Button, Empty, EmptyHeader, EmptyMedia, EmptyTitle, Input, Textarea } from './ui';

export type SpIdentityMutationError = {
  operation: 'definition-save' | 'definition-delete' | 'rename';
  message: string;
};

export function SpIdentityEditor({
  enabled,
  payload,
  busy,
  loading = false,
  readError = null,
  hasLastGoodPayload = true,
  mutationError = null,
  success = null,
  onRetryRead,
  onRename,
  onCreateDefinition,
  onUpdateDefinition,
  onDeleteDefinition,
}: {
  enabled: boolean;
  payload: SpIdentityAdminPayload;
  busy: boolean;
  loading?: boolean;
  readError?: string | null;
  hasLastGoodPayload?: boolean;
  mutationError?: SpIdentityMutationError | null;
  success?: string | null;
  onRetryRead?: () => void;
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
      {readError && hasLastGoodPayload ? (
        <div className="settings-status settings-error" role="alert">
          <p>Saved SP persona configurations are shown from the last successful refresh. {readError}</p>
          {onRetryRead ? (
            <Button type="button" variant="outline" className="roster-control" disabled={loading} onClick={onRetryRead}>
              Retry refresh
            </Button>
          ) : null}
        </div>
      ) : null}
      {success ? (
        <p className="settings-status" role="status">
          {success}
        </p>
      ) : null}

      {readError && !hasLastGoodPayload ? (
        <div className="sp-resource-state settings-error" role="alert">
          <p>{readError}</p>
          {onRetryRead ? (
            <Button type="button" variant="outline" className="roster-control" disabled={loading} onClick={onRetryRead}>
              Retry SP personas
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <SpPersonaDefinitionBuilder
            busy={busy || !enabled || !hasLastGoodPayload}
            definitions={payload.personaDefinitions ?? []}
            resourceDiscovery={payload.grantResourceDiscovery}
            loading={loading && !hasLastGoodPayload}
            saveError={mutationError?.operation === 'definition-save' ? mutationError.message : null}
            deleteError={mutationError?.operation === 'definition-delete' ? mutationError.message : null}
            onCreate={onCreateDefinition}
            onUpdate={onUpdateDefinition}
            onDelete={onDeleteDefinition}
          />
          <SpPersonaTable
            personas={payload.personas}
            busy={busy || !enabled}
            error={mutationError?.operation === 'rename' ? mutationError.message : null}
            onRename={onRename}
          />
        </>
      )}
    </fieldset>
  );
}

const CUSTOM_RESOURCE = '__custom_resource__';

function newDefinition(resources: readonly SpGrantResource[] = []): SpPersonaDefinitionWrite {
  const defaultType = resources.some((resource) => resource.type === 'TABLE')
    ? 'TABLE'
    : (resources[0]?.type ?? 'TABLE');
  return {
    displayName: '',
    description: '',
    capabilities: [],
    grants: [newSpGrant(resources, defaultType)],
    legacyCapabilities: [],
  };
}

function SpPersonaDefinitionBuilder({
  busy,
  definitions,
  resourceDiscovery,
  loading,
  saveError,
  deleteError,
  onCreate,
  onUpdate,
  onDelete,
}: {
  busy: boolean;
  definitions: SpPersonaDefinition[];
  resourceDiscovery: SpIdentityAdminPayload['grantResourceDiscovery'];
  loading: boolean;
  saveError: string | null;
  deleteError: string | null;
  onCreate?: (write: SpPersonaDefinitionWrite) => boolean | Promise<boolean>;
  onUpdate?: (id: string, write: SpPersonaDefinitionWrite) => boolean | Promise<boolean>;
  onDelete?: (id: string) => void;
}) {
  const resources = resourceDiscovery?.resources ?? [];
  const [draft, setDraft] = useState<SpPersonaDefinitionWrite>(() => newDefinition(resourceDiscovery?.resources ?? []));
  const [editingId, setEditingId] = useState<string | null>(null);
  const canSubmit =
    !busy && isSpPersonaDefinitionComplete(draft) && (editingId ? Boolean(onUpdate) : Boolean(onCreate));

  function reset(): void {
    setEditingId(null);
    setDraft(newDefinition(resources));
  }

  function edit(definition: SpPersonaDefinition): void {
    setEditingId(definition.id);
    setDraft({
      displayName: definition.displayName,
      description: definition.description,
      capabilities: [],
      grants: [...(definition.grants ?? [])],
      legacyCapabilities:
        definition.legacyCapabilities ?? ((definition.grants?.length ?? 0) > 0 ? [] : [...definition.capabilities]),
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    const write = {
      displayName: draft.displayName.trim(),
      description: draft.description.trim(),
      capabilities: [
        ...draft.grants.map(spGrantSummary),
        ...draft.legacyCapabilities.map((capability) => capability.trim()),
      ],
      grants: draft.grants.map((grant) => ({ ...grant, resource: grant.resource.trim() })),
      legacyCapabilities: draft.legacyCapabilities.map((capability) => capability.trim()),
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
              Configure permission grants here and save a credential-free plan. An account or workspace admin must still
              create the principal and apply the plan externally.
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
              disabled={busy || draft.grants.length >= 24}
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  grants: [...current.grants, newDefinition(resources).grants[0]],
                }))
              }
            >
              <Plus className="size-3.5" /> Add permission
            </Button>
          </div>
          {loading ? (
            <p className="sp-resource-state" role="status">
              Loading configured resources…
            </p>
          ) : resourceDiscovery === undefined ? (
            <p className="sp-resource-state">
              Configured resource discovery is unavailable on this server. Validated identifiers still work.
            </p>
          ) : resourceDiscovery.status === 'error' ? (
            <p className="sp-resource-state settings-error" role="alert">
              {resourceDiscovery.detail ||
                'Configured resources could not be loaded. Validated identifiers still work.'}
            </p>
          ) : resources.length === 0 ? (
            <p className="sp-resource-state">
              No configured resources were found. Enter a validated Databricks identifier in each grant.
            </p>
          ) : null}
          {draft.grants.map((grant, index) => (
            <StructuredGrantRow
              // A grant's position is stable while its fields change.
              // eslint-disable-next-line react/no-array-index-key
              key={`${index}:${draft.grants.length}`}
              grant={grant}
              index={index}
              grants={draft.grants}
              resources={resources}
              busy={busy}
              onChange={(next) =>
                setDraft((current) => ({
                  ...current,
                  grants: current.grants.map((value, item) => (item === index ? next : value)),
                }))
              }
              onDuplicate={() =>
                setDraft((current) => ({
                  ...current,
                  grants:
                    current.grants.length >= 24
                      ? current.grants
                      : [...current.grants.slice(0, index + 1), { ...grant }, ...current.grants.slice(index + 1)],
                }))
              }
              onRemove={() =>
                setDraft((current) => ({
                  ...current,
                  grants: current.grants.filter((_, item) => item !== index),
                }))
              }
            />
          ))}
          {draft.legacyCapabilities.map((capability, index) => (
            // Legacy strings have no identifier and may contain duplicates.
            // eslint-disable-next-line react/no-array-index-key
            <div className="sp-legacy-grant" key={`legacy-${index}`}>
              <div className="sp-legacy-grant-head">
                <span className="ast-pill ast-pill--neutral-outline">Legacy permission — needs conversion</span>
                <Button
                  type="button"
                  variant="outline"
                  className="roster-control"
                  disabled={busy || draft.grants.length >= 24}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      grants: [...current.grants, ...grantsFromLegacy(capability)].slice(0, 24),
                      legacyCapabilities: current.legacyCapabilities.filter((_, item) => item !== index),
                    }))
                  }
                >
                  Convert
                </Button>
              </div>
              <div className="sp-legacy-grant-edit">
                <Input
                  value={capability}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      legacyCapabilities: current.legacyCapabilities.map((value, item) =>
                        item === index ? event.target.value : value
                      ),
                    }))
                  }
                  aria-label={`Legacy permission ${index + 1}`}
                  disabled={busy}
                />
                <Button
                  type="button"
                  variant="ghost"
                  className="sp-icon-button"
                  disabled={busy}
                  aria-label={`Remove legacy permission ${index + 1}`}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      legacyCapabilities: current.legacyCapabilities.filter((_, item) => item !== index),
                    }))
                  }
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
          {draft.grants.length > 0 ? (
            <div className="sp-operator-summary">
              <strong>Operator-ready grant plan</strong>
              {draft.grants.map((grant, index) => (
                // Duplicate validation can temporarily render two identical summaries.
                // eslint-disable-next-line react/no-array-index-key
                <code key={`${spGrantKey(grant)}:${index}`}>
                  {spGrantIdentifierFault(grant.resourceType, grant.resource)
                    ? `${SP_GRANT_MATRIX[grant.resourceType].label} — choose a resource`
                    : spGrantSummary(grant)}
                </code>
              ))}
              <span>Apply these entries to the externally created service principal.</span>
            </div>
          ) : null}
        </div>

        <div className="sp-persona-builder-foot">
          <p>Generate SP saves this plan only. An administrator must create the principal and apply every grant.</p>
          <Button type="submit" disabled={!canSubmit}>
            {editingId ? 'Save persona' : 'Generate SP'}
          </Button>
        </div>
        {saveError ? (
          <p className="settings-status settings-error" role="alert">
            {saveError}
          </p>
        ) : null}
      </form>

      <SpPersonaDefinitionTable
        definitions={definitions}
        busy={busy}
        loading={loading}
        actionError={deleteError}
        onEdit={edit}
        onDelete={onDelete}
      />
    </div>
  );
}

function StructuredGrantRow({
  grant,
  grants,
  index,
  resources,
  busy,
  onChange,
  onDuplicate,
  onRemove,
}: {
  grant: SpGrant;
  grants: SpGrant[];
  index: number;
  resources: SpGrantResource[];
  busy: boolean;
  onChange: (grant: SpGrant) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const matchingResources = resources.filter((resource) => resource.type === grant.resourceType);
  const enumerated = matchingResources.some((resource) => resource.id === grant.resource);
  const resourceChoice = enumerated ? grant.resource : CUSTOM_RESOURCE;
  const identifierFault = spGrantIdentifierFault(grant.resourceType, grant.resource);
  const duplicate = grants.findIndex((candidate) => spGrantKey(candidate) === spGrantKey(grant)) !== index;
  const typeOptions = SP_GRANT_RESOURCE_TYPES.map((type) => ({ value: type, label: SP_GRANT_MATRIX[type].label }));
  const actionOptions = SP_GRANT_MATRIX[grant.resourceType].options.map((option) => ({
    value: option.action,
    label: `${option.label} — ${option.privilege}`,
  }));
  return (
    <div className="sp-structured-grant">
      <div className="sp-grant-fields">
        <AppSelect<SpGrantResourceType>
          label="Resource type"
          ariaLabel={`Resource type for permission ${index + 1}`}
          value={grant.resourceType}
          options={typeOptions}
          disabled={busy}
          showLabel={false}
          onValueChange={(next) => onChange(changeSpGrantType(next, resources))}
          className="sp-grant-select"
        />
        <div className="sp-grant-resource">
          {matchingResources.length > 0 ? (
            <AppSelect
              label="Resource"
              ariaLabel={`Resource for permission ${index + 1}`}
              value={resourceChoice}
              options={[
                ...matchingResources.map((resource) => ({
                  value: resource.id,
                  label: `${resource.label} · ${resource.id}`,
                })),
                { value: CUSTOM_RESOURCE, label: 'Enter another identifier' },
              ]}
              disabled={busy}
              showLabel={false}
              onValueChange={(next) => onChange({ ...grant, resource: next === CUSTOM_RESOURCE ? '' : next })}
              className="sp-grant-select"
            />
          ) : null}
          {matchingResources.length === 0 || !enumerated ? (
            <Input
              value={grant.resource}
              onChange={(event) => onChange({ ...grant, resource: event.target.value })}
              aria-label={`Resource identifier for permission ${index + 1}`}
              placeholder={SP_GRANT_MATRIX[grant.resourceType].identifierHint}
              disabled={busy}
              className="ast-mono"
            />
          ) : null}
        </div>
        <AppSelect<SpGrantAction>
          label="Permission"
          ariaLabel={`Permission for grant ${index + 1}`}
          value={grant.action}
          options={actionOptions}
          disabled={busy}
          showLabel={false}
          onValueChange={(next) => onChange(changeSpGrantAction(grant, next))}
          className="sp-grant-select"
        />
        <span className="sp-grant-actions">
          <Button
            type="button"
            variant="ghost"
            className="sp-icon-button"
            disabled={busy || grants.length >= 24}
            aria-label={`Duplicate permission ${index + 1}`}
            onClick={onDuplicate}
          >
            <Copy className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="sp-icon-button"
            disabled={busy}
            aria-label={`Remove permission ${index + 1}`}
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </span>
      </div>
      {identifierFault || duplicate ? (
        <p className="sp-grant-error" role="alert">
          {duplicate ? 'This exact resource and permission is already in the plan.' : identifierFault}
        </p>
      ) : null}
    </div>
  );
}

function SpPersonaDefinitionTable({
  definitions,
  busy,
  loading,
  actionError,
  onEdit,
  onDelete,
}: {
  definitions: SpPersonaDefinition[];
  busy: boolean;
  loading: boolean;
  actionError: string | null;
  onEdit: (definition: SpPersonaDefinition) => void;
  onDelete?: (id: string) => void;
}) {
  if (loading) {
    return (
      <p className="sp-resource-state" role="status">
        Reading SP persona configurations…
      </p>
    );
  }
  if (definitions.length === 0) {
    return (
      <Empty className="sp-persona-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UserRound aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No SP persona configurations yet.</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  const legacyFor = (definition: SpPersonaDefinition) =>
    definition.legacyCapabilities ?? ((definition.grants?.length ?? 0) > 0 ? [] : definition.capabilities);
  return (
    <>
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
                  title={[...(definition.grants ?? []).map(spGrantSummary), ...legacyFor(definition)].join('\n')}
                >{`${(definition.grants?.length ?? 0) + legacyFor(definition).length} selected${
                  legacyFor(definition).length > 0 ? ` · ${legacyFor(definition).length} legacy permission` : ''
                }`}</td>
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
      {actionError ? (
        <p className="settings-status settings-error" role="alert">
          {actionError}
        </p>
      ) : null}
    </>
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
  error,
  onRename,
}: {
  personas: SpPersona[];
  busy: boolean;
  error: string | null;
  onRename: (id: string, displayName: string) => void;
}) {
  if (personas.length === 0) return null;
  return (
    <>
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
      {error ? (
        <p className="settings-status settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
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
  const [readState, setReadState] = useState(INITIAL_SP_IDENTITY_READ_STATE);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<SpIdentityMutationError | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async (): Promise<boolean> => {
    setReadState(startSpIdentityRead);
    try {
      const payload = await loadSpIdentityAdmin();
      setReadState((current) => finishSpIdentityRead(current, payload));
      return true;
    } catch (caught) {
      setReadState((current) => failSpIdentityRead(current, (caught as Error).message));
      return false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (
    operation: SpIdentityMutationError['operation'],
    successMessage: string,
    work: () => Promise<void>
  ) => {
    setBusy(true);
    setMutationError(null);
    setSuccess(null);
    try {
      await work();
      setSuccess(successMessage);
      await load();
      return true;
    } catch (caught) {
      setMutationError({ operation, message: (caught as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <SpIdentityEditor
      enabled={enabled}
      payload={readState.payload}
      busy={busy}
      loading={readState.loading}
      readError={readState.error}
      hasLastGoodPayload={readState.hasLastGoodPayload}
      mutationError={mutationError}
      success={success}
      onRetryRead={() => void load()}
      onRename={(id, displayName) =>
        void run('rename', 'Persona renamed.', async () => {
          await renameSpPersona(id, displayName);
        })
      }
      onCreateDefinition={(write) =>
        run('definition-save', 'SP persona configuration saved.', async () => {
          await createSpPersonaDefinition(write);
        })
      }
      onUpdateDefinition={(id, write) =>
        run('definition-save', 'SP persona configuration saved.', async () => {
          await updateSpPersonaDefinition(id, write);
        })
      }
      onDeleteDefinition={(id) =>
        void run('definition-delete', 'SP persona configuration removed.', async () => {
          await deleteSpPersonaDefinition(id);
        })
      }
    />
  );
}
