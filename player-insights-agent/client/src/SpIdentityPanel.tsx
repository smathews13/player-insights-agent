/**
 * Settings → Identity: the backend-defined service-principal personas.
 *
 * Connected identities remain rename-only. The generator saves a separate
 * credential-free operator configuration because this app cannot administer Databricks
 * account service principals or grants with its declared scopes.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Copy, ExternalLink, FolderOpen, Pencil, Plus, RefreshCw, Search, Trash2, UserRound } from 'lucide-react';
import {
  SP_GRANT_MATRIX,
  SP_GRANT_RESOURCE_TYPES,
  SP_IDENTITY_MINTING_UNAVAILABLE,
  SP_PERSONA_GRANT_COUNT_MAX,
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
import type {
  SpPersonaTemplate,
  SpPersonaTemplateOverflow,
  SpPersonaTemplateUnresolved,
  SpPersonaTemplateVariant,
} from '../../shared/sp-persona-templates';
import {
  createSpPersonaDefinition,
  deleteSpPersonaDefinition,
  loadSpIdentityAdmin,
  renameSpPersona,
  updateSpPersonaDefinition,
} from './identity-settings-api';
import {
  activeSpPersonaUnresolved,
  changeSpGrantAction,
  changeSpGrantType,
  confirmDeletePermissionsDraft,
  duplicateSpPersonaGrantRow,
  grantsFromLegacy,
  isSpPersonaDraftDirty,
  isSpPersonaDefinitionComplete,
  newSpGrant,
  removeSpPersonaGrantRow,
  resolveSpPersonaTemplateVariant,
  spPersonaTemplateUseBlock,
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
            templates={payload.personaTemplates ?? []}
            templateWarning={payload.personaTemplateWarning ?? null}
            resourceDiscovery={payload.grantResourceDiscovery}
            accountConsoleUrl={payload.accountConsoleUrl ?? 'https://accounts.cloud.databricks.com'}
            loading={loading && !hasLastGoodPayload}
            saveError={mutationError?.operation === 'definition-save' ? mutationError.message : null}
            deleteError={mutationError?.operation === 'definition-delete' ? mutationError.message : null}
            onCreate={onCreateDefinition}
            onUpdate={onUpdateDefinition}
            onDelete={onDeleteDefinition}
            onRefreshResources={onRetryRead}
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

function newDefinition(resources: readonly SpGrantResource[] = []): SpPersonaDefinitionWrite {
  void resources;
  return {
    displayName: '',
    description: '',
    capabilities: [],
    grants: [],
    legacyCapabilities: [],
  };
}

function SpPersonaDefinitionBuilder({
  busy,
  definitions,
  templates,
  templateWarning,
  resourceDiscovery,
  accountConsoleUrl,
  loading,
  saveError,
  deleteError,
  onCreate,
  onUpdate,
  onDelete,
  onRefreshResources,
}: {
  busy: boolean;
  definitions: SpPersonaDefinition[];
  templates: SpPersonaTemplate[];
  templateWarning: string | null;
  resourceDiscovery: SpIdentityAdminPayload['grantResourceDiscovery'];
  accountConsoleUrl: string;
  loading: boolean;
  saveError: string | null;
  deleteError: string | null;
  onCreate?: (write: SpPersonaDefinitionWrite) => boolean | Promise<boolean>;
  onUpdate?: (id: string, write: SpPersonaDefinitionWrite) => boolean | Promise<boolean>;
  onDelete?: (id: string) => void;
  onRefreshResources?: () => void;
}) {
  const resources = resourceDiscovery?.resources ?? [];
  const [draft, setDraft] = useState<SpPersonaDefinitionWrite>(() => newDefinition(resourceDiscovery?.resources ?? []));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftError, setDraftError] = useState('');
  const [unresolvedSelections, setUnresolvedSelections] = useState<SpPersonaTemplateUnresolved[]>([]);
  const [templateOverflow, setTemplateOverflow] = useState<SpPersonaTemplateOverflow[]>([]);
  const [grantRowIds, setGrantRowIds] = useState<string[]>([]);
  const nextRowId = useRef(0);
  const dirty = isSpPersonaDraftDirty(draft);
  const activeUnresolved = activeSpPersonaUnresolved(draft.grants, grantRowIds, unresolvedSelections);
  const skippedOptional = unresolvedSelections.filter((selection) => selection.optional);
  const templateUseBlock = spPersonaTemplateUseBlock(editingId, dirty);
  const canSubmit =
    !busy &&
    templateOverflow.length === 0 &&
    isSpPersonaDefinitionComplete(draft) &&
    (editingId ? Boolean(onUpdate) : Boolean(onCreate));

  function reset(): void {
    setEditingId(null);
    setDraft(newDefinition(resources));
    setDraftError('');
    setUnresolvedSelections([]);
    setTemplateOverflow([]);
    setGrantRowIds([]);
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
    setUnresolvedSelections([]);
    setTemplateOverflow([]);
    setGrantRowIds((definition.grants ?? []).map((_, index) => `saved-${definition.id}-${index}`));
  }

  function useTemplate(template: SpPersonaTemplate, variant: SpPersonaTemplateVariant): void {
    if (spPersonaTemplateUseBlock(editingId, dirty)) return;
    const resolved = resolveSpPersonaTemplateVariant(variant, resources);
    setDraft({
      displayName: template.displayName,
      description: template.purpose,
      capabilities: [],
      grants: resolved.grants,
      legacyCapabilities: [],
    });
    setUnresolvedSelections(resolved.unresolved);
    setTemplateOverflow(resolved.overflow);
    setGrantRowIds(resolved.rowIds);
    setDraftError('');
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
      {templates.length > 0 || templateWarning ? (
        <ExampleProfiles
          templates={templates}
          warning={templateWarning}
          resources={resources}
          busy={busy}
          useBlockedReason={templateUseBlock}
          onUse={useTemplate}
        />
      ) : null}
      <form className="sp-persona-builder" onSubmit={(event) => void submit(event)}>
        <div className="sp-persona-builder-head">
          <div>
            <strong>{editingId ? 'Edit persona configuration' : 'Define a persona'}</strong>
          </div>
          {editingId || dirty ? (
            <Button
              type="button"
              variant={editingId ? 'outline' : 'destructive'}
              data-variant={editingId ? 'outline' : 'destructive'}
              className={`roster-control${editingId ? '' : ' settings-destructive'}`}
              onClick={() => {
                if (editingId || confirmDeletePermissionsDraft(window.confirm)) reset();
              }}
              disabled={busy}
            >
              {editingId ? 'Cancel edit' : 'Delete permissions'}
            </Button>
          ) : null}
        </div>

        <div className="sp-persona-fields">
          <label className="runtime-field">
            <span className="runtime-field-label">Persona name</span>
            <Input
              value={draft.displayName}
              onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))}
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
              aria-label="Persona purpose"
              disabled={busy}
              rows={2}
            />
          </label>
        </div>

        <div className="sp-capability-editor">
          <div className="sp-capability-heading">
            <span>Permissions and capabilities</span>
            <span className="sp-capability-actions">
              <Button
                type="button"
                variant="outline"
                className="roster-control"
                disabled={busy || draft.grants.length >= SP_PERSONA_GRANT_COUNT_MAX}
                onClick={() => {
                  setGrantRowIds((current) => [...current, `manual-${nextRowId.current++}`]);
                  setDraft((current) => ({
                    ...current,
                    grants: [...current.grants, newSpGrant([], 'TABLE')],
                  }));
                }}
              >
                <Plus className="size-3.5" /> Add permission
              </Button>
            </span>
          </div>
          {templateOverflow.length > 0 ? (
            <div className="sp-template-unresolved" role="alert">
              {templateOverflow.map((item) => (
                <p key={item.rowId}>
                  <strong>
                    {item.requiredGrantCount} resolved grants exceed the {item.grantLimit}-permission limit by{' '}
                    {item.overflowCount}.
                  </strong>{' '}
                  {item.candidateCount} resources matched “{item.choiceLabel}”; select and, if needed, duplicate at most{' '}
                  {item.selectableCount} permission rows before saving.
                </p>
              ))}
            </div>
          ) : null}
          {activeUnresolved.length > 0 ? (
            <div className="sp-template-unresolved" role="status">
              <strong>Choose {activeUnresolved.length} required resource(s) before saving</strong>
              <ul>
                {activeUnresolved.map((selection) => (
                  <li key={selection.rowId}>
                    Permission {grantRowIds.indexOf(selection.rowId) + 1} — {selection.choiceLabel}.{' '}
                    {selection.candidateCount > 1
                      ? `${selection.candidateCount} configured matches. `
                      : 'No configured match. '}
                    Open Browse in this row to choose or enter an identifier.
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {skippedOptional.length > 0 ? (
            <div className="sp-template-optional" role="status">
              Optional {skippedOptional.map((selection) => selection.choiceLabel).join(', ')}{' '}
              {skippedOptional.length === 1 ? 'was' : 'were'} skipped because it did not resolve to exactly one
              configured resource. Base permissions can still be saved.
            </div>
          ) : null}
          {draft.grants.map((grant, index) => (
            <StructuredGrantRow
              key={grantRowIds[index] ?? `untracked-${index}`}
              grant={grant}
              index={index}
              grants={draft.grants}
              resources={resources}
              resourceDiscovery={resourceDiscovery}
              resourcesLoading={loading}
              onRefreshResources={onRefreshResources}
              busy={busy}
              requiredChoice={activeUnresolved.find((selection) => selection.rowId === grantRowIds[index])}
              onChange={(next) => {
                const rowId = grantRowIds[index];
                if (next.resource.trim()) {
                  setUnresolvedSelections((selections) => selections.filter((selection) => selection.rowId !== rowId));
                  setTemplateOverflow((items) => items.filter((item) => item.rowId !== rowId));
                } else {
                  setUnresolvedSelections((selections) =>
                    selections.map((selection) =>
                      selection.rowId === rowId ? { ...selection, resourceType: next.resourceType } : selection
                    )
                  );
                }
                setDraft((current) => ({
                  ...current,
                  grants: current.grants.map((value, item) => (item === index ? next : value)),
                }));
              }}
              removeDisabled={templateOverflow.some((item) => item.rowId === grantRowIds[index])}
              onDuplicate={() => {
                if (draft.grants.length >= SP_PERSONA_GRANT_COUNT_MAX) return;
                const newRowId = `manual-${nextRowId.current++}`;
                const duplicated = duplicateSpPersonaGrantRow(grantRowIds, unresolvedSelections, index, newRowId);
                setGrantRowIds(duplicated.rowIds);
                setUnresolvedSelections(duplicated.unresolved);
                setDraft((current) => ({
                  ...current,
                  grants: [...current.grants.slice(0, index + 1), { ...grant }, ...current.grants.slice(index + 1)],
                }));
              }}
              onRemove={() => {
                const removed = removeSpPersonaGrantRow(grantRowIds, unresolvedSelections, index);
                setGrantRowIds(removed.rowIds);
                setUnresolvedSelections(removed.unresolved);
                setDraft((current) => ({
                  ...current,
                  grants: current.grants.filter((_, item) => item !== index),
                }));
              }}
            />
          ))}
          {draftError ? (
            <p className="sp-draft-error" role="alert">
              {draftError}
            </p>
          ) : null}
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
                  disabled={busy || draft.grants.length >= SP_PERSONA_GRANT_COUNT_MAX}
                  onClick={() => {
                    const converted = grantsFromLegacy(capability);
                    if (draft.grants.length + converted.length > SP_PERSONA_GRANT_COUNT_MAX) {
                      setDraftError(
                        `Converting this entry would exceed the ${SP_PERSONA_GRANT_COUNT_MAX}-permission limit. Remove or narrow permissions first.`
                      );
                      return;
                    }
                    setGrantRowIds((current) => [...current, ...converted.map(() => `manual-${nextRowId.current++}`)]);
                    setDraft((current) => ({
                      ...current,
                      grants: [...current.grants, ...converted],
                      legacyCapabilities: current.legacyCapabilities.filter((_, item) => item !== index),
                    }));
                  }}
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
        </div>

        <div className="sp-persona-builder-foot">
          <Button type="submit" disabled={!canSubmit} aria-label="Save persona permissions">
            Save permissions
          </Button>
          <Button asChild>
            <a
              href={accountConsoleUrl}
              data-account-console-link="true"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open Databricks Account Console to create a service principal in a new tab"
            >
              Open Account Console <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
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

export function ExampleProfiles({
  templates,
  warning,
  resources,
  busy,
  useBlockedReason = null,
  onUse,
}: {
  templates: SpPersonaTemplate[];
  warning: string | null;
  resources: SpGrantResource[];
  busy: boolean;
  useBlockedReason?: string | null;
  onUse: (template: SpPersonaTemplate, variant: SpPersonaTemplateVariant) => void;
}) {
  return (
    <section className="sp-example-profiles" aria-labelledby="sp-example-profiles-title">
      <div className="sp-example-profiles-head">
        <div>
          <strong id="sp-example-profiles-title">Example profiles</strong>
          <p>
            Stage editable, credential-free permissions. Nothing is saved, created, or granted until you review them.
          </p>
        </div>
      </div>
      {warning ? (
        <p className="settings-status settings-error" role="alert">
          {warning}
        </p>
      ) : null}
      <div className="sp-example-profile-grid">
        {templates.map((template) => {
          const leastPrivilege = template.variants.find((variant) => variant.leastPrivilege);
          const expanded = template.variants.filter((variant) => !variant.leastPrivilege);
          if (!leastPrivilege) return null;
          const leastResolved = resolveSpPersonaTemplateVariant(leastPrivilege, resources);
          return (
            <article className="sp-example-profile" key={template.id}>
              <div>
                <strong>{template.displayName}</strong>
                <p>{template.roleSummary}</p>
              </div>
              <ul className="sp-example-capabilities">
                {template.keyCapabilities.map((capability) => (
                  <li key={capability}>{capability}</li>
                ))}
              </ul>
              <p className="sp-example-grant-count">
                {leastPrivilege.grants.length} grant intents
                {leastResolved.overflow.length > 0
                  ? ` · ${leastResolved.overflow[0].requiredGrantCount} resolved grants exceed the ${leastResolved.overflow[0].grantLimit}-permission limit`
                  : leastResolved.unresolved.length > 0
                    ? ` · ${leastResolved.unresolved.length} resource choice(s) need review`
                    : ' · configured resources resolved'}
              </p>
              {expanded.map((variant) => (
                <p className="sp-example-variant-note" key={`${variant.id}-description`}>
                  {variant.description}
                </p>
              ))}
              {useBlockedReason ? <p className="settings-status">{useBlockedReason}</p> : null}
              <details>
                <summary>Review duties, boundaries, and exclusions</summary>
                <strong>Duties</strong>
                <ul>
                  {template.duties.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <strong>Data boundaries</strong>
                <ul>
                  {template.dataBoundaries.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <strong>Explicit exclusions</strong>
                <ul>
                  {template.exclusions.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </details>
              <div className="sp-example-profile-actions">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || Boolean(useBlockedReason)}
                  onClick={() => onUse(template, leastPrivilege)}
                >
                  Use profile
                </Button>
                {expanded.map((variant) => (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || Boolean(useBlockedReason)}
                    key={variant.id}
                    onClick={() => onUse(template, variant)}
                  >
                    {variant.label}
                  </Button>
                ))}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function ResourceBrowser({
  grant,
  resources,
  discovery,
  loading,
  busy,
  index,
  onPick,
  onManual,
  onRefresh,
}: {
  grant: SpGrant;
  resources: SpGrantResource[];
  discovery: SpIdentityAdminPayload['grantResourceDiscovery'];
  loading: boolean;
  busy: boolean;
  index: number;
  onPick: (resource: SpGrantResource) => void;
  onManual: (value: string) => void;
  onRefresh?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  const selected = resources.find(
    (resource) =>
      resource.type === grant.resourceType && resource.id.toLocaleLowerCase() === grant.resource.toLocaleLowerCase()
  );
  const filtered = resources.filter(
    (resource) =>
      resource.type === grant.resourceType &&
      `${resource.label} ${resource.id} ${SP_GRANT_MATRIX[resource.type].label}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase())
  );
  const groups = SP_GRANT_RESOURCE_TYPES.map((type) => ({
    type,
    resources: filtered.filter((resource) => resource.type === type),
  })).filter((group) => group.resources.length > 0);

  return (
    <div className="sp-resource-browser">
      <details ref={details} className="sp-resource-popover">
        <summary
          className="sp-resource-trigger roster-control"
          aria-label={`Browse configured resources for permission ${index + 1}`}
        >
          <FolderOpen className="size-3.5" aria-hidden="true" />
          {selected ? (
            <span>
              {selected.label} <code>{selected.id}</code>
            </span>
          ) : grant.resource ? (
            <code>{grant.resource}</code>
          ) : (
            'Browse'
          )}
        </summary>
        <div className="sp-resource-menu" role="dialog" aria-label="Configured resources">
          {resources.length > 4 ? (
            <label className="sp-resource-search">
              <Search className="size-3.5" aria-hidden="true" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter resources"
                aria-label="Filter configured resources"
                autoFocus
              />
            </label>
          ) : null}
          {loading ? <p role="status">Loading configured resources…</p> : null}
          {!loading && discovery?.status === 'error' ? (
            <div className="sp-resource-state" role="alert">
              <span>{discovery.detail || 'Configured resources could not be loaded.'}</span>
              {onRefresh ? (
                <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
                  <RefreshCw className="size-3.5" aria-hidden="true" /> Refresh
                </Button>
              ) : null}
            </div>
          ) : null}
          {!loading && discovery?.status === 'ready' && resources.length === 0 ? (
            <div className="sp-resource-state">
              <span>No configured resources found.</span>
              {onRefresh ? (
                <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
                  <RefreshCw className="size-3.5" aria-hidden="true" /> Refresh
                </Button>
              ) : null}
            </div>
          ) : null}
          {!loading && resources.length > 0 && groups.length === 0 ? <p>No resources match this filter.</p> : null}
          {groups.map((group) => (
            <section
              className="sp-resource-group"
              key={group.type}
              aria-labelledby={`resource-group-${index}-${group.type}`}
            >
              <strong id={`resource-group-${index}-${group.type}`}>{SP_GRANT_MATRIX[group.type].label}</strong>
              {group.resources.map((resource) => (
                <button
                  type="button"
                  key={`${resource.type}:${resource.id}`}
                  className="sp-resource-option"
                  onClick={() => {
                    onPick(resource);
                    details.current?.removeAttribute('open');
                  }}
                >
                  <span>{resource.label}</span>
                  <code>{resource.id}</code>
                </button>
              ))}
            </section>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="sp-manual-resource"
            onClick={() => {
              setManual(true);
              details.current?.removeAttribute('open');
            }}
          >
            Enter identifier
          </Button>
        </div>
      </details>
      {manual || (grant.resource && !selected) ? (
        <Input
          value={grant.resource}
          onChange={(event) => onManual(event.target.value)}
          aria-label={`Resource identifier for permission ${index + 1}`}
          disabled={busy}
          className="ast-mono"
          autoFocus={manual}
        />
      ) : null}
    </div>
  );
}

function StructuredGrantRow({
  grant,
  grants,
  index,
  resources,
  resourceDiscovery,
  resourcesLoading,
  onRefreshResources,
  busy,
  requiredChoice,
  onChange,
  onDuplicate,
  onRemove,
  removeDisabled = false,
}: {
  grant: SpGrant;
  grants: SpGrant[];
  index: number;
  resources: SpGrantResource[];
  resourceDiscovery: SpIdentityAdminPayload['grantResourceDiscovery'];
  resourcesLoading: boolean;
  onRefreshResources?: () => void;
  busy: boolean;
  requiredChoice?: SpPersonaTemplateUnresolved;
  onChange: (grant: SpGrant) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  removeDisabled?: boolean;
}) {
  const identifierFault = spGrantIdentifierFault(grant.resourceType, grant.resource);
  const duplicate = grants.findIndex((candidate) => spGrantKey(candidate) === spGrantKey(grant)) !== index;
  const typeOptions = SP_GRANT_RESOURCE_TYPES.map((type) => ({ value: type, label: SP_GRANT_MATRIX[type].label }));
  const actionOptions = SP_GRANT_MATRIX[grant.resourceType].options.map((option) => ({
    value: option.action,
    label: option.label,
    code: option.privilege,
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
          <ResourceBrowser
            grant={grant}
            resources={resources}
            discovery={resourceDiscovery}
            loading={resourcesLoading}
            busy={busy}
            index={index}
            onPick={(resource) => {
              const typed = changeSpGrantType(resource.type, resources);
              onChange({ ...typed, resource: resource.id });
            }}
            onManual={(resource) => onChange({ ...grant, resource })}
            onRefresh={onRefreshResources}
          />
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
            disabled={busy || grants.length >= SP_PERSONA_GRANT_COUNT_MAX}
            aria-label={`Duplicate permission ${index + 1}`}
            onClick={onDuplicate}
          >
            <Copy className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="sp-icon-button"
            disabled={busy || removeDisabled}
            aria-label={`Remove permission ${index + 1}`}
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </span>
      </div>
      {(grant.resource.trim() && identifierFault) || (grant.resource.trim() && duplicate) ? (
        <p className="sp-grant-error" role="alert">
          {duplicate ? 'This exact resource and permission is already selected.' : identifierFault}
        </p>
      ) : null}
      {requiredChoice && !grant.resource.trim() ? (
        <p className="sp-grant-required" role="alert">
          Required: {requiredChoice.choiceLabel}. Open Browse to choose or enter an identifier.
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
        <table className="settings-data-table settings-actions-table sp-definitions-table">
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
 * Keeping those records separate prevents a credential-free configuration from appearing
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
        <table className="settings-data-table settings-actions-table sp-personas-table">
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
