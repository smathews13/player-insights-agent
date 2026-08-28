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
import { Lock, Trash2, UserPlus } from 'lucide-react';
import { Button, Input } from './ui';
import { CopyableCommand } from './AdminListEditor';
import { canSubmit, roleWord, rosterSummary, rowLocked, setOn, stepsDownFrom, type RosterEntry } from './user-roster';
import { type Role, type RosterPayload } from '../../shared/user-roster-contract';
import { AppSelect } from './AppSelect';
import { roleOptions } from './user-role-options';

/** The #24a add row appoints an Admin or Consumer. Super-admin promotion stays
 * on an existing row, where the server names it in `assignable` and protects the
 * last-super-admin rule. */
const ADDABLE_ROLES: readonly Role[] = ['admin', 'consumer'];

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
    return <span className="ast-pill ast-pill--neutral-outline roster-role-status">{roleWord(entry.role)}</span>;
  }
  return (
    <AppSelect
      label="Role"
      ariaLabel={`Role for ${entry.email}`}
      value={entry.role}
      disabled={busy}
      onValueChange={(role) => onChange(entry, role)}
      options={roleOptions(entry)}
      className="roster-control roster-role-select"
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
  footer,
}: {
  payload: RosterPayload;
  busy: boolean;
  onChange: (entry: RosterEntry, role: Role) => void;
  onRemove: (entry: RosterEntry) => void;
  footer?: ReactNode;
}) {
  return (
    <>
      <p className="admin-list-note roles-roster-summary">{rosterSummary(payload)}</p>

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
        <table className="settings-data-table roles-table">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Set by</th>
              <th scope="col">Role</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {payload.entries.map((entry) => {
              const locked = rowLocked(entry, payload);
              const setDate = setOn(entry);
              return (
                <tr key={entry.email} className="admin-row">
                  <td className="roster-email">
                    <span className="admin-row-email">
                      <span className="admin-row-address" title={entry.email}>
                        {entry.email}
                      </span>
                      {entry.isYou ? <span className="admin-row-you">you</span> : null}
                    </span>
                  </td>
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
                  <td className="roster-role">
                    <RoleControl entry={entry} busy={busy} onChange={onChange} />
                  </td>
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
                    ) : locked ? (
                      <Lock className="roster-row-lock" aria-label={locked} />
                    ) : null}
                  </td>
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

export function UserRoleEditor() {
  const [payload, setPayload] = useState<RosterPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [draftRole, setDraftRole] = useState<Role>('admin');
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState('');
  const [notice, setNotice] = useState('');

  /**
   * One read, and it is a read.
   *
   * There used to be a second call, a POST that asked Unity Catalog for the grants
   * every administrator's role was said to need. Opening this panel no longer
   * changes anybody's permissions.
   */
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/users');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setPayload((await response.json()) as RosterPayload);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** One write path, so an add and a change cannot report their outcome differently. */
  async function write(request: { url: string; method: string; body: unknown; said: string }) {
    setBusy(true);
    setWriteError('');
    setNotice('');
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
      const body = (await response.json()) as RosterPayload & { detail?: string };
      if (!response.ok) {
        setWriteError(body.detail ?? 'Nothing changed.');
        return false;
      }
      setPayload(body);
      setNotice(request.said);
      return true;
    } catch (cause) {
      setWriteError((cause as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const email = draft.trim();
    const added = await write({
      url: '/api/users',
      method: 'POST',
      body: { email, role: draftRole },
      said: `${email} is now ${roleWord(draftRole).toLowerCase()}.`,
    });
    if (added) setDraft('');
  }

  return (
    <div className="identity-table-content">
      {loading ? <p className="admin-list-note">Reading the roster.</p> : null}

      {error ? (
        <p className="admin-list-note admin-list-error">
          The roster could not be read. Nobody has lost a role. Reload the page.
        </p>
      ) : null}

      {payload ? (
        <RosterRows
          payload={payload}
          busy={busy}
          onChange={(entry, role) =>
            void write({
              url: `/api/users/${encodeURIComponent(entry.email)}`,
              method: 'PATCH',
              body: { role },
              // The warning goes in the outcome line, before the panel this reader
              // is standing on disappears from under them.
              said: [`${entry.email} is now ${roleWord(role).toLowerCase()}.`, stepsDownFrom(entry, role)]
                .filter(Boolean)
                .join(' '),
            })
          }
          onRemove={(entry) =>
            void write({
              url: `/api/users/${encodeURIComponent(entry.email)}`,
              method: 'DELETE',
              body: {},
              said: `${entry.email} is off the roster.`,
            })
          }
          footer={
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
                  label="Role"
                  ariaLabel="Role to give them"
                  value={draftRole}
                  disabled={busy}
                  onValueChange={setDraftRole}
                  options={ADDABLE_ROLES.map((role) => ({ value: role, label: roleWord(role) }))}
                  className="roster-control roster-role-select"
                />
              </td>
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
          }
        />
      ) : null}

      {/* One live region for both, because they are the same slot on screen and two
          regions would be two announcements for one action. */}
      <p className="admin-list-note admin-list-outcome" role="status" aria-live="polite">
        {writeError || notice}
      </p>
    </div>
  );
}
