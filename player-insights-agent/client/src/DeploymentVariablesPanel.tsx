import { CircleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  deploymentVariableSourceLabel,
  sortedDeploymentVariables,
  type DeploymentVariable,
} from './deployment-variables-view';

async function loadDeploymentVariables(): Promise<DeploymentVariable[]> {
  const response = await fetch('/api/admin/deployment-variables');
  if (!response.ok) throw new Error('Saved deployment values could not be loaded.');
  const body = (await response.json()) as { variables?: DeploymentVariable[] };
  return body.variables ?? [];
}

/** What this deployment restores on every Git deploy, and where each value came from. Read only. */
export function DeploymentVariablesPanel() {
  const [rows, setRows] = useState<DeploymentVariable[] | null>(null);
  const [failed, setFailed] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadDeploymentVariables()
      .then((loaded) => {
        if (!cancelled) setRows(sortedDeploymentVariables(loaded));
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setFailed(error instanceof Error ? error.message : 'Saved deployment values could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="settings-table-frame" aria-labelledby="deployment-variables-title">
      <h4 id="deployment-variables-title">Saved deployment values</h4>
      <p className="admin-list-note">
        Restored before the app starts on every Deploy from Git. Secrets are stored separately and never shown.
      </p>
      {failed ? (
        <p className="slack-connection-error" role="alert">
          <CircleAlert aria-hidden="true" />
          {failed}
        </p>
      ) : rows === null ? (
        <p className="admin-list-note">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="admin-list-note">Nothing saved yet. The next release or Git deploy saves these values.</p>
      ) : (
        <table className="settings-data-table">
          <thead>
            <tr>
              <th scope="col">Setting</th>
              <th scope="col">Value</th>
              <th scope="col">Set by</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.scope}:${row.name}`}>
                <td>
                  <code>{row.name}</code>
                </td>
                <td>
                  <code>{row.value}</code>
                </td>
                <td>{deploymentVariableSourceLabel(row.source)}</td>
                <td title={row.updatedBy}>{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
