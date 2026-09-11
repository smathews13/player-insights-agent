/**
 * The roster: who this deployment knows, and what each of them may open.
 *
 * DRAWN ONLY FOR THE SUPER ADMIN, AND THAT IS NOT THE PERMISSION. `/api/users`
 * refuses a plain administrator with 403 whatever this component does. Not drawing
 * it is why an administrator does not meet a panel every control on which the server
 * would refuse.
 *
 * WHAT MAY BE DONE TO A ROW COMES FROM THE SERVER, never from a rule written here.
 * Each row arrives with the roles it may be changed to and whether it may be
 * removed, because the control on screen and the refusal on the route have to be one
 * rule rather than two implementations of one. A menu offering a change the route
 * would refuse is the failure that shape prevents.
 *
 * A PROMOTION IS ONE FACT: A ROW IN LAKEBASE. It used to be two. Appointing an
 * administrator also asked Unity Catalog for read on the telemetry schema and the
 * `system.billing` tables, and each row carried the outcome. Granting on `system`
 * needs an account admin who is also a metastore admin, so the panel's usual state
 * was a refusal beside a person who had just been promoted successfully. Read access
 * to billing is a separate request to a metastore admin, and it is not a condition
 * of the role, so it is no longer on this screen.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Copy, ExternalLink, Trash2, UserPlus, UsersRound } from 'lucide-react';
import { Button, Input } from './ui';
import { PiaBusyButtonContent, PiaLoader } from './PiaLoader';
import { CopyableCommand } from './AdminListEditor';
import {
  addDisabledReason,
  canSubmit,
  claimRosterMutation,
  normalizeRosterEmail,
  roleWord,
  rosterEmailError,
  stepsDownFrom,
  type RosterEntry,
} from './user-roster';
import { isRole, type Role, type RosterPayload } from '../../shared/user-roster-contract';
import type { SpIdentityAdminPayload, SpPersona, SpPersonaConnectionWrite } from '../../shared/sp-identity';
import { AppSelect } from './AppSelect';
import { roleOptions } from './user-role-options';
import { RoleBadgePill } from './RoleBadge';
import { OrganizationUserBadge } from './OrganizationUserBadge';
import { OrganizationAvatar } from './OrganizationAvatar';
import { organizationForEmail } from '../../shared/organization-mapping';
import { notifyIdentitySettingsChanged } from './identity-settings-events';
import {
  assignSpPersona,
  checkSpPersonaDefinitionStatus,
  changeHumanRole,
  connectSpPersonaDefinition,
  createSpPersonaDefinition,
  deleteSpPersonaDefinition,
  EMPTY_SP_IDENTITY,
  loadGroupMembers,
  loadHumanRoster,
  loadSpIdentityAdmin,
  renameSpPersona,
  resetGroupRoleMapping,
  UNASSIGNED_PERSONA,
  updateSpPersonaDefinition,
  writeGroupRoleMapping,
  writeHumanRoster,
} from './identity-settings-api';
import { SpIdentityEditor, type SpIdentityMutationError } from './SpIdentityPanel';

/** The #24a add row appoints an Admin or Consumer. Super-admin promotion stays
 * on an existing row, where the server names it in `assignable` and protects the
 * last-super-admin rule. */
const ADDABLE_ROLES: readonly Role[] = ['admin', 'consumer'];

function rosterFromSpIdentity(payload: SpIdentityAdminPayload): RosterPayload {
  const entries = payload.roster.map((row) => ({
    email: row.email,
    role: isRole(row.role) ? row.role : ('consumer' as const),
    isDeploymentOwner: row.isDeploymentOwner,
    seedFloor: 'consumer' as const,
    setBy: '',
    setAt: '',
    isYou: false,
    assignable: [],
    canRemove: false,
  }));
  return {
    entries,
    storedRosterReadable: true,
    roleColumnPresent: true,
    pendingSchemaStatement: '',
    superAdminCount: entries.filter((entry) => entry.role === 'super_admin').length,
    recoveryStatement: '',
    organizations: payload.organizations ?? [],
  };
}

/**
 * One row's role control, or the line saying why there is none.
 *
 * ABSENT RATHER THAN DISABLED, which is the decision this app already made for the
 * navigation: a greyed control a reader can never enable is a permanent invitation
 * to ask why. The line in its place says what to change instead.
 *
 * The shared app dropdown keeps the current role visible and preserves Radix's
 * keyboard navigation and typeahead.
 */
function RoleControl({
  entry,
  busy,
  onChange,
}: {
  entry: RosterEntry;
  busy: boolean;
  onChange: (entry: RosterEntry, role: Role) => void;
}) {
  if (entry.assignable.length === 0) {
    return <RoleBadgePill state={entry.role} />;
  }
  return (
    <AppSelect
      label="User role"
      ariaLabel={`User role for ${entry.email}`}
      value={entry.role}
      disabled={busy}
      onValueChange={(role) => onChange(entry, role)}
      options={roleOptions(entry).map((option) => ({
        ...option,
        content: <RoleBadgePill state={option.value} />,
      }))}
      className="roster-control roster-role-select"
    />
  );
}

const APP_ACCESS_LABEL = {
  can_use: 'Can use app',
  can_manage: 'Can manage app',
  inherited: 'Inherited app access',
  missing: 'No app access',
  unknown: 'App access not checked',
} as const;

export function AppAccessBadge({ state, detail }: { state: RosterEntry['appAccess']; detail?: string }) {
  if (!state || state === 'unknown') return null;
  const tone = state === 'missing' ? 'ast-pill--neg' : 'ast-pill--pos';
  return (
    <span className={`ast-pill roster-app-access ${tone}`.trim()} title={detail || undefined}>
      {APP_ACCESS_LABEL[state]}
    </span>
  );
}

function PersonaControl({
  email,
  personaId,
  personas,
  disabled,
  onChange,
  isDeploymentOwner = false,
}: {
  email: string;
  personaId: string | null;
  personas: SpPersona[];
  disabled: boolean;
  onChange?: (email: string, personaId: string | null) => void;
  isDeploymentOwner?: boolean;
}) {
  if (isDeploymentOwner)
    return (
      <span title="Owner: creator of this app's earliest successful deployment" className="ast-pill roster-owner-badge">
        Owner
      </span>
    );
  const options = [
    { value: UNASSIGNED_PERSONA, label: 'No persona' },
    ...personas.map((persona) => ({ value: persona.id, label: persona.displayName })),
  ];
  const known = new Set(personas.map((persona) => persona.id));
  const value = personaId && known.has(personaId) ? personaId : UNASSIGNED_PERSONA;
  return (
    <AppSelect
      label="Persona"
      ariaLabel={`Persona for ${email}`}
      value={value}
      disabled={disabled || !onChange}
      onValueChange={(next) => onChange?.(email, next === UNASSIGNED_PERSONA ? null : next)}
      options={options}
      className="roster-control roster-persona-select"
    />
  );
}

/** The table footer is a row, not a floating form, so every control shares the
 * same explicit column geometry as the identities above it. Exported to keep
 * enabled, disabled and alignment states render-tested without a network read. */
export function RosterAddRow({
  draft,
  role,
  busy,
  adding = false,
  error = '',
  descriptionId = 'roster-add-description',
  onDraftChange,
  onRoleChange,
  onAdd,
}: {
  draft: string;
  role: Role;
  busy: boolean;
  adding?: boolean;
  error?: string;
  descriptionId?: string;
  onDraftChange: (value: string) => void;
  onRoleChange: (role: Role) => void;
  onAdd: () => void;
}) {
  const validationError = draft.trim() ? rosterEmailError(draft) : '';
  const feedback = error || (draft.trim() ? validationError : '');
  const disabledReason = addDisabledReason(draft, role, busy);
  return (
    <tr className="roster-add-row">
      <td className="roster-email">
        <Input
          type="email"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !canSubmit(draft, busy, role)) return;
            event.preventDefault();
            onAdd();
          }}
          placeholder="name@example.com"
          aria-label="Email address to put on the roster"
          aria-invalid={Boolean(feedback)}
          aria-describedby={descriptionId}
        />
        <span
          id={descriptionId}
          className={`roster-add-feedback${feedback ? ' admin-list-error' : ''}`}
          role={feedback ? 'alert' : undefined}
        >
          {feedback}
        </span>
      </td>
      <td className="roster-organization">—</td>
      <td className="roster-role">
        <AppSelect<Role>
          label="User role"
          ariaLabel="User role to give them"
          value={role}
          disabled={busy}
          onValueChange={onRoleChange}
          options={ADDABLE_ROLES.map((option) => ({
            value: option,
            label: roleWord(option),
            content: <RoleBadgePill state={option} />,
          }))}
          className="roster-control roster-role-select"
        />
      </td>
      <td className="roster-add-persona">Assign after adding</td>
      <td className="roster-action">
        <Button
          type="button"
          variant="outline"
          data-variant="outline"
          className="roster-control roster-action-button"
          disabled={Boolean(disabledReason)}
          title={disabledReason || `Add ${normalizeRosterEmail(draft)} as ${roleWord(role)}`}
          aria-describedby={descriptionId}
          aria-busy={adding || undefined}
          onClick={onAdd}
        >
          <PiaBusyButtonContent
            busy={adding}
            label="Add"
            busyLabel="Adding"
            tone="light"
            icon={<UserPlus className="roster-action-icon" aria-hidden="true" />}
          />
        </Button>
      </td>
    </tr>
  );
}

/**
 * The rows, as a function of the payload and nothing else.
 *
 * Split from the editor below so they can be rendered in a test without a fetch or
 * an effect. That matters more here than it usually does: the claims worth defending
 * are about which controls a row offers in each state, and asserting them against
 * the source of a component nobody rendered is how this repository has shipped
 * screens that were wrong while every test passed.
 */
export function RosterRows({
  payload,
  busy,
  onChange,
  onRemove,
  personas = [],
  personaByEmail = new Map<string, string | null>(),
  personaDisabled = true,
  onPersonaChange,
  showPersona = false,
  manageHumanRoles = true,
  onGroupRoleChange,
  onGroupReset,
  footer,
}: {
  payload: RosterPayload;
  busy: boolean;
  onChange: (entry: RosterEntry, role: Role) => void;
  onRemove: (entry: RosterEntry) => void;
  personas?: SpPersona[];
  personaByEmail?: ReadonlyMap<string, string | null>;
  personaDisabled?: boolean;
  onPersonaChange?: (email: string, personaId: string | null) => void;
  showPersona?: boolean;
  manageHumanRoles?: boolean;
  onGroupRoleChange?: (entry: GroupRoleEntry, role: Extract<Role, 'admin' | 'consumer'>) => void;
  onGroupReset?: (entry: GroupRoleEntry) => void;
  footer?: ReactNode;
}) {
  return (
    <>
      {/* The way back into a deployment nobody can administer. Present only when
          nobody can act at all, which is the one state where there is nobody to
          withhold it from. */}
      {payload.recoveryStatement ? (
        <CopyableCommand command={payload.recoveryStatement} label="Appoint a super admin" />
      ) : null}

      {payload.pendingSchemaStatement ? (
        <CopyableCommand command={payload.pendingSchemaStatement} label="Add the role column" />
      ) : null}

      <div className="settings-table-frame roster-frame">
        <table
          className={`settings-data-table roles-table roles-table--${
            manageHumanRoles ? 'editable' : 'assignment-only'
          }${manageHumanRoles ? ' settings-actions-table' : ''}`}
        >
          <colgroup>
            <col className="roster-email-column" />
            <col className="roster-organization-column" />
            <col className="roster-role-column" />
            {showPersona ? <col className="roster-persona-column" /> : null}
            {manageHumanRoles ? <col className="roster-action-column" /> : null}
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Organization</th>
              <th scope="col">User role</th>
              {showPersona ? <th scope="col">Persona</th> : null}
              {manageHumanRoles ? <th scope="col">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {showPersona && manageHumanRoles
              ? (payload.groupRoleMappings ?? []).map((entry) => (
                  <GroupRoleRow
                    key={`group:${entry.groupName}`}
                    entry={entry}
                    busy={busy}
                    organizations={payload.organizations}
                    onRoleChange={(mapping, role) => onGroupRoleChange?.(mapping, role)}
                    onReset={(mapping) => onGroupReset?.(mapping)}
                  />
                ))
              : null}
            {payload.entries.map((entry) => {
              const organization = organizationForEmail(entry.email, payload.organizations ?? []);
              return (
                <tr key={entry.email} className="admin-row">
                  <td className="roster-email" title={entry.email}>
                    <span className="admin-row-email">
                      <span className="roster-email-details">
                        <OrganizationUserBadge
                          identity={entry.email}
                          organization={organization}
                          className="admin-row-address"
                          canOpen
                        />
                        <AppAccessBadge state={entry.appAccess} detail={entry.appAccessDetail} />
                      </span>
                      {entry.isYou ? <span className="admin-row-you">you</span> : null}
                      <Button
                        type="button"
                        variant="ghost"
                        className="roster-email-copy"
                        aria-label={`Copy email ${entry.email}`}
                        title={`Copy ${entry.email}`}
                        onClick={() => void navigator.clipboard?.writeText(entry.email)}
                      >
                        <Copy className="size-3.5" aria-hidden="true" />
                      </Button>
                    </span>
                  </td>
                  <td className="roster-organization">
                    <span className="roster-organization-value">
                      <OrganizationAvatar organization={organization} />
                      <span>{organization.name}</span>
                    </span>
                  </td>
                  <td className="roster-role">
                    <RoleControl
                      entry={manageHumanRoles ? entry : { ...entry, assignable: [] }}
                      busy={busy}
                      onChange={onChange}
                    />
                  </td>
                  {showPersona ? (
                    <td className="roster-persona">
                      <PersonaControl
                        email={entry.email}
                        personaId={personaByEmail.get(entry.email) ?? null}
                        personas={personas}
                        disabled={busy || personaDisabled}
                        onChange={onPersonaChange}
                        isDeploymentOwner={entry.isDeploymentOwner}
                      />
                    </td>
                  ) : null}
                  {manageHumanRoles ? (
                    <td className="roster-action">
                      {entry.canRemove ? (
                        <Button
                          variant="destructive"
                          data-variant="destructive"
                          className="roster-control settings-destructive roster-action-button"
                          size="sm"
                          disabled={busy}
                          onClick={() => onRemove(entry)}
                          aria-label={`Reset ${entry.email} to Consumer`}
                        >
                          <Trash2 className="roster-action-icon" aria-hidden="true" />
                          Reset role
                        </Button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
          {footer ? <tfoot>{footer}</tfoot> : null}
        </table>
      </div>
    </>
  );
}

type GroupRoleEntry = NonNullable<RosterPayload['groupRoleMappings']>[number];

function GroupRoleRow({
  entry,
  busy,
  onRoleChange,
  onReset,
  organizations,
}: {
  entry: GroupRoleEntry;
  busy: boolean;
  onRoleChange: (entry: GroupRoleEntry, role: Extract<Role, 'admin' | 'consumer'>) => void;
  onReset: (entry: GroupRoleEntry) => void;
  organizations: RosterPayload['organizations'];
}) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Array<{ email: string; displayName: string }> | null>(null);
  const [detail, setDetail] = useState('');
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || members) return;
    setLoading(true);
    setDetail('');
    try {
      const result = await loadGroupMembers(entry.groupName);
      setMembers(result.members);
      setDetail(result.detail);
    } catch (cause) {
      setDetail(cause instanceof Error ? cause.message : 'Workspace membership could not be read.');
    } finally {
      setLoading(false);
    }
  };
  const organization = organizationForEmail('group@example.com', organizations ?? []);

  return (
    <>
      <tr className="admin-row group-role-row">
        <td className="roster-email" title={entry.groupName}>
          <div className="group-role-identity admin-row-email">
            <button
              type="button"
              className="group-role-toggle"
              aria-expanded={open}
              aria-label={`${open ? 'Hide' : 'Show'} members of ${entry.groupName}`}
              onClick={() => void toggle()}
            >
              <ChevronRight className={open ? 'rotate-90' : ''} aria-hidden="true" />
            </button>
            <UsersRound aria-hidden="true" />
            {entry.scimConfirmed && entry.identityManagementUrl ? (
              <a
                className="group-role-link"
                href={entry.identityManagementUrl}
                target="_blank"
                rel="noreferrer"
                title={`Open Databricks identity management for ${entry.groupName}`}
              >
                <span>{entry.groupName}</span>
                <ExternalLink aria-hidden="true" />
              </a>
            ) : (
              <span>{entry.groupName}</span>
            )}
          </div>
        </td>
        <td className="roster-organization">
          <span className="roster-organization-value">
            <OrganizationAvatar organization={organization} />
            <span>{organization.name}</span>
          </span>
        </td>
        <td className="roster-role">
          <AppSelect
            label="Player Insights Agent role"
            ariaLabel={`Player Insights Agent role for ${entry.groupName}`}
            value={entry.role}
            disabled={busy}
            onValueChange={(role) => onRoleChange(entry, role)}
            options={(['admin', 'consumer'] as const).map((role) => ({
              value: role,
              label: roleWord(role),
              content: <RoleBadgePill state={role} />,
            }))}
            className="roster-control roster-role-select group-role-select"
          />
        </td>
        <td className="roster-persona">
          <AppSelect
            label="Persona"
            ariaLabel={`Persona for group ${entry.groupName}`}
            value={UNASSIGNED_PERSONA}
            disabled
            onValueChange={() => undefined}
            options={[{ value: UNASSIGNED_PERSONA, label: 'No persona' }]}
            className="roster-control roster-persona-select"
          />
        </td>
        <td className="roster-action">
          {entry.setBy ? (
            <Button
              variant="destructive"
              data-variant="destructive"
              className="roster-control settings-destructive roster-action-button"
              size="sm"
              disabled={busy}
              onClick={() => onReset(entry)}
              aria-label={`Reset ${entry.groupName} to Consumer`}
            >
              <Trash2 className="roster-action-icon" aria-hidden="true" />
              Reset role
            </Button>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr className="group-role-members-row">
          <td colSpan={5}>
            {loading ? <PiaLoader variant="inline" label="Reading group members" className="settings-status" /> : null}
            {!loading && members ? (
              <div className="group-role-members">
                <p>
                  {members.length} individual {members.length === 1 ? 'member' : 'members'}
                </p>
                {members.length > 0 ? (
                  <ul>
                    {members.map((member) => (
                      <li key={member.email}>
                        <OrganizationUserBadge identity={member.email} label={member.displayName} canOpen />
                      </li>
                    ))}
                  </ul>
                ) : null}
                {detail ? <p className="settings-status">{detail}</p> : null}
              </div>
            ) : null}
            {!loading && !members && detail ? (
              <p className="settings-status settings-error" role="alert">
                {detail}
              </p>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function UserRoleEditor({ canManageHumanRoles = true }: { canManageHumanRoles?: boolean }) {
  const [payload, setPayload] = useState<RosterPayload | null>(null);
  const [spPayload, setSpPayload] = useState<SpIdentityAdminPayload>(EMPTY_SP_IDENTITY);
  const [spLoaded, setSpLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [spError, setSpError] = useState<string | null>(null);
  const [spMutationError, setSpMutationError] = useState<SpIdentityMutationError | null>(null);
  const [busyAction, setBusyAction] = useState<'add' | 'other' | null>(null);
  const [writeError, setWriteError] = useState('');
  const [notice, setNotice] = useState('');
  const loadGeneration = useRef(0);
  const mutationInFlight = useRef(false);
  const busy = busyAction !== null;

  /** The roster and persona assignment are one screen, so one refresh reads both. */
  const load = useCallback(
    async (showLoading = true) => {
      const generation = ++loadGeneration.current;
      if (showLoading) setLoading(true);
      setError('');
      setSpError(null);
      const humanRequest = canManageHumanRoles ? loadHumanRoster() : Promise.resolve<RosterPayload | null>(null);
      const [spResult, humanResult] = await Promise.allSettled([loadSpIdentityAdmin(), humanRequest]);
      if (generation !== loadGeneration.current) return;

      if (spResult.status === 'fulfilled') {
        setSpPayload(spResult.value);
        setSpLoaded(true);
        if (!canManageHumanRoles) setPayload(rosterFromSpIdentity(spResult.value));
      } else {
        setSpError(spResult.reason instanceof Error ? spResult.reason.message : 'SP personas could not be read.');
        if (!canManageHumanRoles) setPayload(null);
      }

      if (canManageHumanRoles) {
        if (humanResult.status === 'fulfilled' && humanResult.value) setPayload(humanResult.value);
        else {
          setError(
            humanResult.status === 'rejected' && humanResult.reason instanceof Error
              ? humanResult.reason.message
              : 'The human roster could not be read.'
          );
        }
      }
      setLoading(false);
    },
    [canManageHumanRoles]
  );

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * One synchronous latch sits in front of React state. Two clicks can arrive
   * before a disabled paint, but only the first may reach the server.
   */
  async function run<T>(
    work: () => Promise<T>,
    said: string,
    options: {
      spOperation?: SpIdentityMutationError['operation'];
      action?: 'add' | 'other';
      apply?: (result: T) => void;
      onError?: (message: string) => void;
    } = {}
  ): Promise<boolean> {
    if (!claimRosterMutation(mutationInFlight)) return false;
    setBusyAction(options.action ?? 'other');
    setWriteError('');
    setSpMutationError(null);
    setNotice('');
    try {
      const result = await work();
      if (options.apply) {
        // Supersede any older read before applying the server-confirmed write
        // response. The mutation payload is the authoritative roster.
        loadGeneration.current += 1;
        options.apply(result);
      } else {
        await load(false);
      }
      notifyIdentitySettingsChanged();
      setNotice(said);
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The identity change failed. Try again.';
      if (options.spOperation) setSpMutationError({ operation: options.spOperation, message });
      else if (options.onError) options.onError(message);
      else setWriteError(message);
      return false;
    } finally {
      mutationInFlight.current = false;
      setBusyAction(null);
    }
  }

  const personaByEmail = new Map(spPayload.roster.map((row) => [row.email, row.personaId]));

  return (
    <div className="identity-table-content">
      <section className="settings-identity-section" aria-labelledby="human-roles-title">
        <h4 id="human-roles-title" className="settings-section-title">
          Databricks App members and Player Insights Agent roles
        </h4>
        {loading ? <PiaLoader variant="inline" label="Reading identity settings" className="admin-list-note" /> : null}
        {error ? (
          <p className="admin-list-note admin-list-error">
            The roster could not be read. Nobody has lost a role. Reload the page.
          </p>
        ) : null}
        {payload ? (
          <>
            {payload.appAccessAvailable === false ? null : (
              <p className="admin-list-note">
                {payload.appAccessMessage ||
                  'Databricks App permissions determine membership. Player Insights Agent determines each member’s app role.'}
              </p>
            )}
            <RosterRows
              payload={payload}
              busy={busy}
              personas={spPayload.personas}
              personaByEmail={personaByEmail}
              personaDisabled={Boolean(spError) && !spLoaded}
              showPersona={true}
              manageHumanRoles={canManageHumanRoles}
              onGroupRoleChange={(mapping, role) =>
                void run(
                  () => writeGroupRoleMapping(mapping.groupName, role),
                  `${mapping.groupName} now maps to ${roleWord(role).toLowerCase()}.`,
                  { apply: setPayload }
                )
              }
              onGroupReset={(mapping) =>
                void run(() => resetGroupRoleMapping(mapping.groupName), `${mapping.groupName} is now a Consumer.`, {
                  apply: setPayload,
                })
              }
              onPersonaChange={(email, personaId) =>
                (() => {
                  if (mutationInFlight.current) return;
                  const before = spPayload;
                  setSpPayload((current) => ({
                    ...current,
                    roster: current.roster.map((row) => (row.email === email ? { ...row, personaId } : row)),
                  }));
                  void run(
                    () => assignSpPersona(email, personaId),
                    personaId ? `${email} now uses the selected persona.` : `${email} now has no persona.`,
                    {
                      apply: setSpPayload,
                      onError: (message) => {
                        setSpPayload(before);
                        setWriteError(message);
                      },
                    }
                  );
                })()
              }
              onChange={(entry, role) =>
                (() => {
                  if (mutationInFlight.current) return;
                  const before = payload;
                  setPayload((current) =>
                    current
                      ? {
                          ...current,
                          entries: current.entries.map((row) => (row.email === entry.email ? { ...row, role } : row)),
                        }
                      : current
                  );
                  void run(
                    () => changeHumanRole(entry.email, role),
                    [`${entry.email} is now ${roleWord(role).toLowerCase()}.`, stepsDownFrom(entry, role)]
                      .filter(Boolean)
                      .join(' '),
                    {
                      apply: setPayload,
                      onError: (message) => {
                        setPayload(before);
                        setWriteError(message);
                      },
                    }
                  );
                })()
              }
              onRemove={(entry) =>
                void run(
                  () => writeHumanRoster(`/api/users/${encodeURIComponent(entry.email)}`, 'DELETE', {}),
                  `${entry.email} is now a Consumer. Their Databricks App access is unchanged.`,
                  { apply: setPayload }
                )
              }
            />
            {payload.appAccessPrincipals?.some((principal) => principal.kind === 'service_principal') ? (
              <div className="roster-app-principals" aria-label="Other Databricks App access">
                <span className="roster-app-principals-title">Service principals</span>
                <div className="roster-app-principal-list">
                  {payload.appAccessPrincipals
                    .filter((principal) => principal.kind === 'service_principal')
                    .map((principal) => (
                      <span
                        key={`${principal.kind}:${principal.name}`}
                        className="ast-pill roster-app-principal"
                        title={
                          principal.inherited
                            ? 'Inherited Databricks App permission'
                            : 'Direct Databricks App permission'
                        }
                      >
                        {principal.displayName} · {principal.permission === 'CAN_MANAGE' ? 'Can manage' : 'Can use'}
                      </span>
                    ))}
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      <section className="settings-identity-section" aria-label="Service principal personas">
        <SpIdentityEditor
          payload={spPayload}
          busy={busy}
          loading={loading}
          readError={spError}
          hasLastGoodPayload={spLoaded}
          mutationError={spMutationError}
          onRetryRead={() => void load()}
          onRename={(id, displayName) =>
            void run(() => renameSpPersona(id, displayName), `Persona renamed to ${displayName}.`, {
              spOperation: 'rename',
            })
          }
          onCreateDefinition={(write) =>
            run(
              () => createSpPersonaDefinition(write),
              `${write.displayName} permissions saved. Connect its service principal next.`,
              {
                spOperation: 'definition-save',
              }
            )
          }
          onUpdateDefinition={(id, write) =>
            run(
              () => updateSpPersonaDefinition(id, write),
              `${write.displayName} permissions updated. Run Check status again.`,
              {
                spOperation: 'definition-save',
              }
            )
          }
          onConnectDefinition={(id: string, write: SpPersonaConnectionWrite) =>
            run(
              () => connectSpPersonaDefinition(id, write),
              'Credential reference saved. Run Check status to verify the connection and permissions.',
              { spOperation: 'connection-save', apply: setSpPayload }
            )
          }
          onCheckDefinition={(id) =>
            run(() => checkSpPersonaDefinitionStatus(id), 'Connection and permission status checked.', {
              spOperation: 'status-check',
              apply: setSpPayload,
            })
          }
          onDeleteDefinition={(id) =>
            void run(
              () => deleteSpPersonaDefinition(id),
              'Persona configuration removed. No Databricks account identity was changed.',
              { spOperation: 'definition-delete' }
            )
          }
        />
      </section>

      {/* One live region for both, because they are the same slot on screen and two
          regions would be two announcements for one action. */}
      <p className="admin-list-note admin-list-outcome" role="status" aria-live="polite">
        {writeError || notice}
      </p>
    </div>
  );
}
