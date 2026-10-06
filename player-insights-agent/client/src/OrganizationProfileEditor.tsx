import { useCallback, useEffect, useRef, useState } from 'react';
import { Building2, RotateCcw, Save, Trash2 } from 'lucide-react';
import { Button, Input } from './ui';
import { PiaBusyButtonContent, PiaLoader } from './PiaLoader';
import { OrganizationAvatar } from './OrganizationAvatar';
import { notifyIdentitySettingsChanged } from './identity-settings-events';
import {
  loadOrganizationProfiles,
  resetOrganizationProfile,
  saveOrganizationProfile,
} from './organization-profiles-api';
import { organizationDraftProblem, organizationFromRow } from './organization-profile-draft';
import { organizationProfileDomain } from '../../shared/organization-mapping';
import type { OrganizationProfileRow } from '../../shared/organization-mapping';

export function OrganizationRow({
  row,
  busy,
  canManage,
  onSave,
  onReset,
}: {
  row: OrganizationProfileRow;
  busy: boolean;
  canManage: boolean;
  onSave: (row: OrganizationProfileRow, name: string, monogram: string) => void;
  onReset: (row: OrganizationProfileRow) => void;
}) {
  const [name, setName] = useState(row.name);
  const [monogram, setMonogram] = useState(row.monogram);
  const problem = organizationDraftProblem({ name, monogram });
  const changed = name.trim() !== row.name || monogram.trim().toLocaleUpperCase() !== row.monogram;
  const hasLogo = row.logoKey !== 'monogram';
  const resettable = row.customized;
  const resetLabel = row.source === 'admin' ? 'Remove' : 'Reset';

  return (
    <tr className="organization-profile-row" data-organization-domain={row.domain}>
      <td className="organization-profile-name">
        <OrganizationAvatar organization={organizationFromRow({ ...row, name, monogram })} />
        {canManage ? (
          <Input
            value={name}
            disabled={busy}
            aria-label={`Organization name for ${row.domain}`}
            aria-invalid={Boolean(changed && problem)}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && changed && !problem) onSave(row, name, monogram);
            }}
          />
        ) : (
          <span>{row.name}</span>
        )}
      </td>
      <td className="organization-profile-domains">
        {row.domains.map((domain) => (
          <code key={domain}>@{domain}</code>
        ))}
      </td>
      <td className="organization-profile-mark">
        {canManage && !hasLogo ? (
          <Input
            value={monogram}
            maxLength={4}
            disabled={busy}
            aria-label={`Short mark for ${row.domain}`}
            onChange={(event) => setMonogram(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && changed && !problem) onSave(row, name, monogram);
            }}
          />
        ) : (
          <span title={hasLogo ? 'This organization keeps its logo.' : undefined}>
            {hasLogo ? 'Logo' : row.monogram}
          </span>
        )}
      </td>
      {canManage ? (
        <td className="organization-profile-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !changed || Boolean(problem)}
            title={problem || `Save ${row.domain}`}
            aria-label={`Save organization ${row.domain}`}
            onClick={() => onSave(row, name, monogram)}
          >
            <Save className="roster-action-icon" aria-hidden="true" /> Save
          </Button>
          {resettable ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              title={
                row.source === 'admin'
                  ? `Remove the organization added for ${row.domain}`
                  : `Return to “${row.defaultName}”`
              }
              aria-label={`${resetLabel} organization ${row.domain}`}
              onClick={() => onReset(row)}
            >
              {row.source === 'admin' ? (
                <Trash2 className="roster-action-icon" aria-hidden="true" />
              ) : (
                <RotateCcw className="roster-action-icon" aria-hidden="true" />
              )}
              {resetLabel}
            </Button>
          ) : null}
        </td>
      ) : null}
    </tr>
  );
}

/**
 * Organization profiles: which name and mark an email domain shows as.
 *
 * Both administrator ranks may edit; the server refuses everybody else. Built-in
 * organizations keep their logo and take the edited name, and an edit is a stored
 * row that can be reset to the built-in label.
 */
export function OrganizationProfileEditor({ canManage = false }: { canManage?: boolean }) {
  const [rows, setRows] = useState<OrganizationProfileRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState(false);
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');
  const [monogram, setMonogram] = useState('');
  const mutation = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await loadOrganizationProfiles());
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Organizations could not be read.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const run = useCallback(
    async (work: () => Promise<OrganizationProfileRow[]>, said: string): Promise<boolean> => {
      if (!canManage || mutation.current) return false;
      mutation.current = true;
      setBusy(true);
      setOutcome('');
      try {
        setRows(await work());
        setError('');
        setOutcome(said);
        notifyIdentitySettingsChanged();
        return true;
      } catch (cause) {
        setOutcome(cause instanceof Error ? cause.message : 'The organization was not saved.');
        return false;
      } finally {
        mutation.current = false;
        setBusy(false);
      }
    },
    [canManage]
  );

  const addProblem = organizationDraftProblem({ domain, name, monogram });
  const canAdd = !busy && !addProblem;
  const add = () => {
    if (!canAdd) return;
    const bare = organizationProfileDomain(domain);
    void run(
      () => saveOrganizationProfile({ domain: bare, name: name.trim(), monogram: monogram.trim() || undefined }),
      `@${bare} now shows as ${name.trim()}.`
    ).then((saved) => {
      if (!saved) return;
      setDomain('');
      setName('');
      setMonogram('');
    });
  };

  return (
    <section className="settings-identity-section organization-profiles" aria-labelledby="organization-profiles-title">
      <h4 id="organization-profiles-title" className="settings-section-title">
        Organizations
      </h4>
      <p className="admin-list-note">
        Each email domain shows as one organization across Identity, Monitoring and the conversation list. Rename an
        organization or add one by its domain, for example @example.com. Other screens pick up a change when they
        reload.
      </p>
      {loading ? <PiaLoader variant="inline" label="Reading organizations" className="admin-list-note" /> : null}
      {error ? (
        <p className="admin-list-error" role="alert">
          {error}
        </p>
      ) : null}
      {rows ? (
        <div className="settings-table-frame">
          <table className="organization-profile-table">
            <thead>
              <tr>
                <th scope="col">Organization</th>
                <th scope="col">Email domain</th>
                <th scope="col">Mark</th>
                {canManage ? <th scope="col">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <OrganizationRow
                  key={`${row.domain}|${row.name}|${row.monogram}`}
                  row={row}
                  busy={busy}
                  canManage={canManage}
                  onSave={(target, nextName, nextMonogram) =>
                    void run(
                      () =>
                        saveOrganizationProfile({
                          domain: target.domain,
                          name: nextName.trim(),
                          monogram: nextMonogram.trim() || undefined,
                        }),
                      `@${target.domain} now shows as ${nextName.trim()}.`
                    )
                  }
                  onReset={(target) =>
                    void run(
                      () => resetOrganizationProfile(target.domain),
                      target.source === 'admin'
                        ? `Removed the organization for @${target.domain}.`
                        : `@${target.domain} is back to ${target.defaultName}.`
                    )
                  }
                />
              ))}
              {canManage ? (
                <tr className="organization-profile-add-row">
                  <td className="organization-profile-name">
                    <Building2 className="organization-profile-add-icon" aria-hidden="true" />
                    <Input
                      value={name}
                      disabled={busy}
                      placeholder="Organization name"
                      aria-label="Name of the organization to add"
                      onChange={(event) => setName(event.target.value)}
                      onKeyDown={(event) => event.key === 'Enter' && add()}
                    />
                  </td>
                  <td className="organization-profile-domains">
                    <Input
                      value={domain}
                      disabled={busy}
                      placeholder="@example.com"
                      aria-label="Email domain of the organization to add"
                      onChange={(event) => setDomain(event.target.value)}
                      onKeyDown={(event) => event.key === 'Enter' && add()}
                    />
                  </td>
                  <td className="organization-profile-mark">
                    <Input
                      value={monogram}
                      maxLength={4}
                      disabled={busy}
                      placeholder="Mark"
                      aria-label="Short mark of the organization to add"
                      onChange={(event) => setMonogram(event.target.value)}
                      onKeyDown={(event) => event.key === 'Enter' && add()}
                    />
                  </td>
                  <td className="organization-profile-actions">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!canAdd}
                      title={addProblem || 'Add this organization'}
                      onClick={add}
                    >
                      <PiaBusyButtonContent busy={busy} label="Add" busyLabel="Saving" icon={<Building2 />} />
                    </Button>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="admin-list-note admin-list-outcome" role="status" aria-live="polite">
        {outcome}
      </p>
      {!canManage && rows ? <p className="admin-list-note">Only administrators can edit organizations.</p> : null}
    </section>
  );
}
