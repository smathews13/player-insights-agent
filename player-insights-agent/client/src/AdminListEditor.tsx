/**
 * Who administers this deployment: identity, origin, add and remove.
 *
 * WHAT THIS CARD NO LONGER SHOWS, AND WHY. Every row used to carry a second block
 * naming two Unity Catalog objects -- the app's telemetry schema and the
 * `system.billing` tables -- with a state word and, when a grant was refused, a
 * copyable GRANT statement. Granting on `system` needs an account admin who is also
 * a metastore admin, so the ordinary sight on this card was "Not granted" and
 * PERMISSION_DENIED beside the name of a colleague who had in fact just been made an
 * administrator. It read as a failed action, and it made a system table look like a
 * prerequisite for a role that never needed one.
 *
 * So the card is user management. Roles are rows in Lakebase, and this screen adds
 * and removes them. Nothing here asks Unity Catalog for anything.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Copy, Trash2, UserPlus } from 'lucide-react';
import { Button, Input } from './ui';
import { PiaLoader } from './PiaLoader';
import { addedOn, canSubmit, listSummary, originLabel, type AdminListEntry } from './admin-list';
import { reportEgress } from './egress-policy';
import type { AdminListPayload } from '../../shared/admin-contract';

/**
 * A statement in the shape Connections prints one: mono, on the code wash,
 * selectable whole, with the copy affordance beside it rather than over it.
 *
 * The roster card uses it for the two statements a deployment can genuinely need
 * from a screen: the one that appoints a super admin when nobody can, and the one
 * that adds the roster's role column. Deliberately the same panel and the same
 * words wherever a statement is printed, so a reader meets one presentation.
 */
export function CopyableCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="connections-command">
      <pre className="connections-code" aria-label={label}>
        {command}
      </pre>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(command);
          // Printed BECAUSE the app cannot run it, so copying it is the remedy
          // working. Recorded all the same: it names the app's own tables and a
          // principal, and an administrator reading the log is entitled to see
          // that somebody took one.
          reportEgress({ channel: 'grant-statement', itemCount: 1 });
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Copy className="size-3.5" /> {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

/**
 * The list itself, as a function of the payload and nothing else.
 *
 * Split from the editor below so the rows can be rendered in a test without a
 * fetch, a router or an effect. This repository has shipped screens that were wrong
 * while every test passed by checking the source of a component nobody rendered.
 */
export function AdminRows({
  payload,
  busy,
  onRemove,
  footer,
}: {
  payload: AdminListPayload;
  busy: boolean;
  onRemove: (entry: AdminListEntry) => void;
  footer?: ReactNode;
}) {
  return (
    <>
      <p className="admin-list-note">
        {listSummary({
          entries: payload.entries,
          addedAdminsReadable: payload.addedAdminsReadable,
          seedAdminCount: payload.seedAdminCount,
        })}
      </p>

      <div className="settings-table-frame admin-table-frame">
        <table className="settings-data-table roles-table admin-roles-table">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Set by</th>
              <th scope="col">Role</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {payload.entries.map((entry) => (
              <tr key={entry.email} className="admin-row">
                <td className="roster-email">
                  <span className="admin-row-email">
                    <span className="admin-row-address" title={entry.email}>
                      {entry.email}
                    </span>
                    {entry.isYou ? <span className="admin-row-you">You</span> : null}
                  </span>
                </td>
                <td className="roster-set-by">
                  <span>{originLabel(entry)}</span>
                  {addedOn(entry) ? <span>{addedOn(entry)}</span> : null}
                </td>
                <td className="roster-role">
                  <span className="ast-pill ast-pill--neutral-outline roster-role-status">Admin</span>
                </td>
                <td className="roster-action">
                  {/* Absent rather than disabled when the server forbids removal. */}
                  {entry.removable ? (
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
              </tr>
            ))}
          </tbody>
          {footer ? <tfoot>{footer}</tfoot> : null}
        </table>
      </div>
    </>
  );
}

export function AdminListEditor() {
  const [payload, setPayload] = useState<AdminListPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState('');
  const [notice, setNotice] = useState('');

  /**
   * One read, and it is a read.
   *
   * There used to be a second call here, a POST that reconciled Unity Catalog
   * grants for everybody on the list whenever the card was opened. Opening a
   * settings page no longer changes anybody's permissions.
   */
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/admins');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setPayload((await response.json()) as AdminListPayload);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    const email = draft.trim();
    setBusy(true);
    setWriteError('');
    setNotice('');
    try {
      const response = await fetch('/api/admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = (await response.json()) as AdminListPayload & { detail?: string };
      if (!response.ok) {
        setWriteError(body.detail ?? 'The administrator was not added.');
        return;
      }
      setPayload(body);
      setDraft('');
      setNotice(`${email} is now an administrator.`);
    } catch (cause) {
      setWriteError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry: AdminListEntry) {
    setBusy(true);
    setWriteError('');
    setNotice('');
    try {
      const response = await fetch(`/api/admins/${encodeURIComponent(entry.email)}`, { method: 'DELETE' });
      const body = (await response.json()) as AdminListPayload & { detail?: string };
      if (!response.ok) {
        setWriteError(body.detail ?? 'Nobody was removed.');
        return;
      }
      setPayload(body);
      setNotice(`${entry.email} is no longer an administrator.`);
    } catch (cause) {
      setWriteError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="identity-table-content">
      {loading ? (
        <PiaLoader variant="inline" label="Reading the administrator list" className="admin-list-note" />
      ) : null}

      {error ? (
        <p className="admin-list-note admin-list-error">
          The administrator list could not be read. Nobody has lost the role. Reload the page.
        </p>
      ) : null}

      {payload ? (
        <AdminRows
          payload={payload}
          busy={busy}
          onRemove={(entry) => void remove(entry)}
          footer={
            <tr className="roster-add-row">
              <td>
                <Input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="name@example.com"
                  aria-label="Email address of the administrator to add"
                />
              </td>
              <td className="roster-add-help">Added by you</td>
              <td>
                <span className="ast-pill ast-pill--neutral-outline roster-role-status">Admin</span>
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
      {/* One live region for both, because they are the same slot on screen and
          two regions would be two announcements for one action. */}
      <p className="admin-list-note admin-list-outcome" role="status" aria-live="polite">
        {writeError || notice}
      </p>
    </div>
  );
}
