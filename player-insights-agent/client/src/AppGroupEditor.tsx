import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, UserPlus, UsersRound } from 'lucide-react';
import { Button, Input } from './ui';
import { PiaBusyButtonContent, PiaLoader } from './PiaLoader';
import { OrganizationUserBadge } from './OrganizationUserBadge';
import type { AppGroup, AppGroupsSettings } from '../../shared/app-groups';
import { normalizeMemberEmail } from '../../shared/app-groups';
import { AppGroupsError, loadAppGroups, saveAppGroups } from './app-groups-api';
import { rosterEmailError } from './user-roster';

function newGroupId(): string {
  return `grp_${crypto.randomUUID()}`;
}

function TeamCard({
  group,
  busy,
  onRename,
  onAdd,
  onRemove,
  onDelete,
}: {
  group: AppGroup;
  busy: boolean;
  onRename: (id: string, name: string) => void;
  onAdd: (id: string, email: string) => Promise<boolean>;
  onRemove: (id: string, email: string) => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState(group.name);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const commitName = () => {
    const next = name.trim();
    if (next && next !== group.name) onRename(group.id, next);
    else setName(group.name);
  };
  const add = () => {
    const problem = rosterEmailError(email);
    if (problem) {
      setEmailError(problem);
      return;
    }
    setEmailError('');
    void onAdd(group.id, email).then((saved) => saved && setEmail(''));
  };

  return (
    <div className="app-group-card settings-table-frame">
      <div className="app-group-head">
        <Input
          className="app-group-name"
          value={name}
          disabled={busy}
          aria-label={`Name of team ${group.name}`}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitName();
          }}
        />
        <span className="app-group-count">
          {group.members.length} {group.members.length === 1 ? 'member' : 'members'}
        </span>
        <Button
          type="button"
          variant="destructive"
          size="icon"
          disabled={busy}
          aria-label={`Delete team ${group.name}`}
          title="Delete team"
          onClick={() => onDelete(group.id)}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      {group.members.length ? (
        <ul className="app-group-members">
          {group.members.map((member) => (
            <li key={member} className="app-group-member">
              <OrganizationUserBadge identity={member} canOpen />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={busy}
                aria-label={`Remove ${member} from ${group.name}`}
                onClick={() => onRemove(group.id, member)}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="admin-list-note">No members yet.</p>
      )}
      <div className="app-group-add-member">
        <Input
          type="email"
          value={email}
          disabled={busy}
          placeholder="name@example.com"
          aria-label={`Add a member to ${group.name} by email`}
          aria-invalid={Boolean(emailError)}
          onChange={(event) => {
            setEmail(event.target.value);
            setEmailError('');
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && email.trim()) add();
          }}
        />
        <Button type="button" variant="outline" disabled={busy || !email.trim()} onClick={add}>
          <UserPlus aria-hidden="true" /> Add
        </Button>
        {emailError ? (
          <span className="admin-list-error" role="alert">
            {emailError}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function AppGroupEditor({ canManage = false }: { canManage?: boolean }) {
  const [settings, setSettings] = useState<AppGroupsSettings | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [newName, setNewName] = useState('');
  const mutation = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const document = await loadAppGroups();
      setSettings(document.settings);
      setRevision(document.revision);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Teams could not be read.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const commit = useCallback(
    async (groups: AppGroup[], notice: string): Promise<boolean> => {
      if (!canManage || mutation.current) return false;
      mutation.current = true;
      setBusy(true);
      setOutcome('');
      try {
        const document = await saveAppGroups({ groups }, revision);
        setSettings(document.settings);
        setRevision(document.revision);
        setOutcome(notice);
        return true;
      } catch (cause) {
        setOutcome(cause instanceof Error ? cause.message : 'Teams were not saved.');
        if (cause instanceof AppGroupsError && cause.kind === 'conflict') await load();
        return false;
      } finally {
        mutation.current = false;
        setBusy(false);
      }
    },
    [canManage, load, revision]
  );
  const groups = settings?.groups ?? [];

  return (
    <section className="settings-identity-section app-groups" aria-labelledby="app-groups-title">
      <h4 id="app-groups-title" className="settings-section-title">
        Teams
      </h4>
      <p className="admin-list-note">
        Organize people so Monitoring can be filtered by who asked. Teams are app-specific and grant no access or
        Databricks permission.
      </p>
      {loading ? <PiaLoader variant="inline" label="Reading teams" className="admin-list-note" /> : null}
      {error ? (
        <p className="admin-list-error" role="alert">
          {error}
        </p>
      ) : null}
      {groups.length ? (
        <div className="app-group-list">
          {groups.map((group) => (
            <TeamCard
              key={group.id}
              group={group}
              busy={busy || !canManage}
              onRename={(id, name) =>
                void commit(
                  groups.map((item) => (item.id === id ? { ...item, name } : item)),
                  `Renamed the team to “${name}”.`
                )
              }
              onAdd={(id, raw) => {
                const email = normalizeMemberEmail(raw);
                return commit(
                  groups.map((item) =>
                    item.id === id && !item.members.includes(email)
                      ? { ...item, members: [...item.members, email] }
                      : item
                  ),
                  `Added ${email} to the team.`
                );
              }}
              onRemove={(id, email) =>
                void commit(
                  groups.map((item) =>
                    item.id === id ? { ...item, members: item.members.filter((member) => member !== email) } : item
                  ),
                  `Removed ${email} from the team.`
                )
              }
              onDelete={(id) =>
                void commit(
                  groups.filter((item) => item.id !== id),
                  'Deleted the team.'
                )
              }
            />
          ))}
        </div>
      ) : settings ? (
        <p className="admin-list-note">No teams yet.</p>
      ) : null}
      {canManage && settings ? (
        <div className="app-group-create">
          <Input
            value={newName}
            disabled={busy}
            placeholder="New team name"
            aria-label="New team name"
            onChange={(event) => setNewName(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy || !newName.trim()}
            onClick={() => {
              const name = newName.trim();
              void commit([...groups, { id: newGroupId(), name, members: [] }], `Created the “${name}” team.`).then(
                (saved) => saved && setNewName('')
              );
            }}
          >
            <PiaBusyButtonContent busy={busy} label="Add team" busyLabel="Saving" icon={<UsersRound />} />
          </Button>
        </div>
      ) : null}
      <p className="admin-list-note admin-list-outcome" role="status" aria-live="polite">
        {outcome}
      </p>
      {!canManage && settings ? <p className="admin-list-note">Only administrators can change teams.</p> : null}
    </section>
  );
}
