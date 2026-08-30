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
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Copy, Trash2, UserPlus } from 'lucide-react';
import { Button, Input } from './ui';
import { CopyableCommand } from './AdminListEditor';
import { canSubmit, roleWord, setOn, stepsDownFrom, type RosterEntry } from './user-roster';
import { isRole, type Role, type RosterPayload } from '../../shared/user-roster-contract';
import type { SpIdentityAdminPayload, SpPersona } from '../../shared/sp-identity';
import { AppSelect } from './AppSelect';
import { roleOptions } from './user-role-options';
import { RoleBadge } from './RoleBadge';
import { organizationForEmail } from '../../shared/organization-mapping';
import {
  assignSpPersona,
  changeHumanRole,
  createSpPersonaDefinition,
  deleteSpPersonaDefinition,
  EMPTY_SP_IDENTITY,
  loadHumanRoster,
  loadSpIdentityAdmin,
  renameSpPersona,
  UNASSIGNED_PERSONA,
  updateSpPersonaDefinition,
  writeHumanRoster,
} from './identity-settings-api';
import { SpIdentityEditor, type SpIdentityMutationError } from './SpIdentityPanel';
import { AccessGuideDownload } from './AccessGuideDownload';

/** The #24a add row appoints an Admin or Consumer. Super-admin promotion stays
 * on an existing row, where the server names it in `assignable` and protects the
 * last-super-admin rule. */
const ADDABLE_ROLES: readonly Role[] = ['admin', 'consumer'];

function rosterFromSpIdentity(payload: SpIdentityAdminPayload): RosterPayload {
  const entries = payload.roster.map((row) => ({
    email: row.email,
    role: isRole(row.role) ? row.role : ('consumer' as const),
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
  if (entry.role === 'super_admin') return <RoleBadge state="super_admin" />;
  if (entry.assignable.length === 0) {
    return <span className="ast-pill ast-pill--neutral-outline roster-role-status">{roleWord(entry.role)}</span>;
  }
  return (
    <AppSelect
      label="User role"
      ariaLabel={`User role for ${entry.email}`}
      value={entry.role}
      disabled={busy}
      onValueChange={(role) => onChange(entry, role)}
      options={roleOptions(entry)}
      className="roster-control roster-role-select"
      showLabel={false}
    />
  );
}

function PersonaControl({
  email,
  personaId,
  personas,
  disabled,
  onChange,
  owner = false,
}: {
  email: string;
  personaId: string | null;
  personas: SpPersona[];
  disabled: boolean;
  onChange?: (email: string, personaId: string | null) => void;
  owner?: boolean;
}) {
  if (owner) return <span className="ast-pill roster-owner-badge">Owner</span>;
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
      showLabel={false}
    />
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
          }`}
        >
          <thead>
            <tr>
              <th scope="col">Email</th>
              {manageHumanRoles ? <th scope="col">Set by</th> : null}
              <th scope="col">User role</th>
              {showPersona ? <th scope="col">Persona</th> : null}
              {manageHumanRoles ? <th scope="col">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {payload.entries.map((entry) => {
              const setDate = setOn(entry);
              const organization = organizationForEmail(entry.email, payload.organizations ?? []);
              return (
                <tr key={entry.email} className="admin-row">
                  <td className="roster-email" title={entry.email}>
                    <span className="admin-row-email">
                      <span
                        className="roster-organization-mark"
                        aria-label={`Organization: ${organization.name}`}
                        title={organization.name}
                      >
                        {organization.monogram}
                      </span>
                      <span className="roster-email-details">
                        <span className="admin-row-address" title={entry.email}>
                          {entry.email}
                        </span>
                        <span className="roster-organization-name">{organization.name}</span>
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
                  {manageHumanRoles ? (
                    <td className="roster-set-by">
                      {entry.seedFloor !== 'consumer' ? (
                        <span title="Set at deployment. Edit the bundle variable to change it.">Deployment</span>
                      ) : (
                        <>
                          <span title={entry.setBy || undefined}>{entry.setBy || '—'}</span>
                          {setDate ? <time dateTime={entry.setAt}>{setDate}</time> : null}
                        </>
                      )}
                    </td>
                  ) : null}
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
                        owner={entry.role === 'super_admin'}
                      />
                    </td>
                  ) : null}
                  {manageHumanRoles ? (
                    <td className="roster-action">
                      {entry.canRemove ? (
                        <Button
                          variant="destructive"
                          data-variant="destructive"
                          className="roster-control settings-destructive"
                          size="sm"
                          disabled={busy}
                          onClick={() => onRemove(entry)}
                          aria-label={`Remove ${entry.email}`}
                        >
                          <Trash2 className="size-3.5" /> Remove
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

export function UserRoleEditor({
  spIdentityEnabled = false,
  canManageHumanRoles = true,
}: {
  spIdentityEnabled?: boolean;
  canManageHumanRoles?: boolean;
}) {
  const [payload, setPayload] = useState<RosterPayload | null>(null);
  const [spPayload, setSpPayload] = useState<SpIdentityAdminPayload>(EMPTY_SP_IDENTITY);
  const [spLoaded, setSpLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [spError, setSpError] = useState<string | null>(null);
  const [spMutationError, setSpMutationError] = useState<SpIdentityMutationError | null>(null);
  const [draft, setDraft] = useState('');
  const [draftRole, setDraftRole] = useState<Role>('admin');
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState('');
  const [notice, setNotice] = useState('');

  /** The roster and persona assignment are one screen, so one refresh reads both. */
  const load = useCallback(
    async (showLoading = true) => {
      if (showLoading) setLoading(true);
      setError('');
      setSpError(null);
      const humanRequest = canManageHumanRoles ? loadHumanRoster() : Promise.resolve<RosterPayload | null>(null);
      const [spResult, humanResult] = await Promise.allSettled([loadSpIdentityAdmin(), humanRequest]);

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

  /** Every mutation refreshes both halves so a person never shows mixed-time identity data. */
  async function run(
    work: () => Promise<unknown>,
    said: string,
    spOperation?: SpIdentityMutationError['operation']
  ): Promise<boolean> {
    setBusy(true);
    setWriteError('');
    setSpMutationError(null);
    setNotice('');
    try {
      await work();
      await load(false);
      setNotice(said);
      return true;
    } catch (cause) {
      if (spOperation) setSpMutationError({ operation: spOperation, message: (cause as Error).message });
      else setWriteError((cause as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const email = draft.trim();
    const added = await run(
      () => writeHumanRoster('/api/users', 'POST', { email, role: draftRole }),
      `${email} is now ${roleWord(draftRole).toLowerCase()}.`
    );
    if (added) setDraft('');
  }

  const personaByEmail = new Map(spPayload.roster.map((row) => [row.email, row.personaId]));

  return (
    <div className="identity-table-content">
      <section className="settings-identity-section" aria-labelledby="human-roles-title">
        <h4 id="human-roles-title" className="settings-section-title">
          Human roles and admins
        </h4>
        <AccessGuideDownload />
        {loading ? <p className="admin-list-note">Reading identity settings.</p> : null}
        {error ? (
          <p className="admin-list-note admin-list-error">
            The roster could not be read. Nobody has lost a role. Reload the page.
          </p>
        ) : null}
        {payload ? (
          <RosterRows
            payload={payload}
            busy={busy}
            personas={spPayload.personas}
            personaByEmail={personaByEmail}
            personaDisabled={!spIdentityEnabled || (Boolean(spError) && !spLoaded)}
            showPersona={true}
            manageHumanRoles={canManageHumanRoles}
            onPersonaChange={(email, personaId) =>
              void run(
                () => assignSpPersona(email, personaId),
                personaId ? `${email} now uses the selected persona.` : `${email} now has no persona.`
              )
            }
            onChange={(entry, role) =>
              void run(
                () => changeHumanRole(entry.email, role),
                [`${entry.email} is now ${roleWord(role).toLowerCase()}.`, stepsDownFrom(entry, role)]
                  .filter(Boolean)
                  .join(' ')
              )
            }
            onRemove={(entry) =>
              void run(
                () => writeHumanRoster(`/api/users/${encodeURIComponent(entry.email)}`, 'DELETE', {}),
                `${entry.email} is off the roster.`
              )
            }
            footer={
              canManageHumanRoles ? (
                <tr className="roster-add-row">
                  <td>
                    <Input
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder="name@example.com"
                      aria-label="Email address to put on the roster"
                    />
                  </td>
                  <td className="roster-add-help">Added by you</td>
                  <td>
                    <AppSelect<Role>
                      label="User role"
                      ariaLabel="User role to give them"
                      value={draftRole}
                      disabled={busy}
                      onValueChange={setDraftRole}
                      options={ADDABLE_ROLES.map((role) => ({ value: role, label: roleWord(role) }))}
                      className="roster-control roster-role-select"
                      showLabel={false}
                    />
                  </td>
                  <td className="roster-add-persona">Assign after adding</td>
                  <td className="roster-action">
                    <Button
                      variant="outline"
                      data-variant="outline"
                      className="roster-control"
                      disabled={!canSubmit(draft, busy)}
                      onClick={() => void add()}
                    >
                      <UserPlus className="size-3.5" /> Add
                    </Button>
                  </td>
                </tr>
              ) : undefined
            }
          />
        ) : null}
      </section>

      <section className="settings-identity-section" aria-label="Service principal personas">
        <SpIdentityEditor
          enabled={spIdentityEnabled}
          payload={spPayload}
          busy={busy}
          loading={loading}
          readError={spError}
          hasLastGoodPayload={spLoaded}
          mutationError={spMutationError}
          onRetryRead={() => void load()}
          onRename={(id, displayName) =>
            void run(() => renameSpPersona(id, displayName), `Persona renamed to ${displayName}.`, 'rename')
          }
          onCreateDefinition={(write) =>
            run(
              () => createSpPersonaDefinition(write),
              `${write.displayName} configuration generated. Account admin setup is still required.`,
              'definition-save'
            )
          }
          onUpdateDefinition={(id, write) =>
            run(
              () => updateSpPersonaDefinition(id, write),
              `${write.displayName} configuration updated. Account admin setup is still required.`,
              'definition-save'
            )
          }
          onDeleteDefinition={(id) =>
            void run(
              () => deleteSpPersonaDefinition(id),
              'Persona configuration removed. No Databricks account identity was changed.',
              'definition-delete'
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
