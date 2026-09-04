import { useEffect, useState } from 'react';
import { ExternalLink, Pencil, Save } from 'lucide-react';

import { isLakebaseRedeployPlan, type LakebaseRedeployPlan } from '../../shared/lakebase-binding';
import { AssetPickerField } from './AssetPicker';
import { PiaLoadingLabel } from './PiaLoadingLabel';
import { canStageLakebaseBinding, lakebaseBindingDraft } from './lakebase-binding-manager-state';
import { Button } from './ui';

interface LakebaseBindingManagerProps {
  enabled: boolean;
}

function detailRows(plan: LakebaseRedeployPlan) {
  return [
    ['Project', plan.active.project],
    ['Branch', plan.active.branch],
    ['Database', plan.active.database],
    ['Endpoint', plan.active.endpoint],
    ['App schema', plan.active.schema],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
}

export function LakebaseBindingPanel({
  plan,
  editing,
  draft,
  saving,
  message,
  onEdit,
  onDraft,
  onSave,
  onCancel,
}: {
  plan: LakebaseRedeployPlan;
  editing: boolean;
  draft: string;
  saving: boolean;
  message: string;
  onEdit: () => void;
  onDraft: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const staged = plan.desired;
  const canSave = canStageLakebaseBinding(plan, draft);
  return (
    <section className="lakebase-binding-manager" aria-labelledby="lakebase-binding-title">
      <div className="lakebase-binding-head">
        <div>
          <p className="lakebase-binding-kicker">Databricks App resource</p>
          <h4 id="lakebase-binding-title">Active Lakebase binding</h4>
        </div>
        {!editing ? (
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil className="size-3.5" aria-hidden="true" /> Change binding
          </Button>
        ) : null}
      </div>

      <dl className="lakebase-binding-details">
        {detailRows(plan).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd title={value}>{value}</dd>
          </div>
        ))}
      </dl>

      <p className="lakebase-binding-truth">
        AppKit opened this pool from deployment-injected Postgres settings. Choosing another database here cannot
        hot-swap app storage.
      </p>

      {staged ? (
        <div className="lakebase-binding-plan" data-state="redeploy-required">
          <div className="lakebase-binding-plan-head">
            <strong>Desired after redeploy</strong>
            <span className="ast-pill ast-pill--neutral">Redeploy required</span>
          </div>
          <dl className="lakebase-binding-details">
            <div>
              <dt>Project</dt>
              <dd title={staged.project}>{staged.project}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd title={staged.branch}>{staged.branch}</dd>
            </div>
            <div>
              <dt>Database</dt>
              <dd title={staged.database}>{staged.database}</dd>
            </div>
          </dl>
          <p>{plan.detail}</p>
          {plan.command ? (
            <>
              {!plan.targetKnown ? (
                <p className="lakebase-binding-warning" role="alert">
                  This Git deployment did not record its bundle target. Replace <code>&lt;target&gt;</code> before
                  running the plan.
                </p>
              ) : null}
              <pre className="lakebase-binding-command" aria-label="Lakebase redeploy command">
                <code>{plan.command}</code>
              </pre>
            </>
          ) : null}
          <div className="lakebase-binding-links">
            {plan.appSettingsUrl ? (
              <a href={plan.appSettingsUrl} target="_blank" rel="noreferrer">
                Open Databricks App resource settings <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            ) : null}
            <span>After the deployment is active, return here and run Update Lakebase if migrations are pending.</span>
          </div>
        </div>
      ) : null}

      {editing ? (
        <div className="lakebase-binding-editor" data-testid="lakebase-binding-editor">
          <AssetPickerField field="lakebase" current={draft} onPick={onDraft} />
          <div className="lakebase-binding-editor-actions">
            <Button disabled={saving || !canSave} onClick={onSave}>
              <Save className="size-3.5" aria-hidden="true" />
              {saving ? 'Staging…' : 'Save redeploy plan'}
            </Button>
            <Button variant="outline" disabled={saving} onClick={onCancel}>
              Cancel
            </Button>
            {!canSave ? <span>No binding change is staged.</span> : null}
          </div>
        </div>
      ) : null}

      {message ? (
        <p className="lakebase-binding-message" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}

export function LakebaseBindingManager({ enabled }: LakebaseBindingManagerProps) {
  const [plan, setPlan] = useState<LakebaseRedeployPlan | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch('/api/lakebase-binding', { signal: controller.signal, credentials: 'same-origin' })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok || !isLakebaseRedeployPlan(body)) {
          const detail =
            body && typeof body === 'object' && 'detail' in body && typeof body.detail === 'string'
              ? body.detail
              : 'The Lakebase binding plan could not be read.';
          throw new Error(detail);
        }
        setPlan(body);
        setDraft(lakebaseBindingDraft(body));
      })
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setMessage(error.message);
      });
    return () => controller.abort();
  }, [enabled]);

  if (!enabled) return null;
  if (!plan && !message) {
    return <PiaLoadingLabel label="Loading Lakebase binding" className="lakebase-binding-loading" />;
  }
  if (!plan) {
    return (
      <p className="lakebase-binding-message" role="alert">
        {message}
      </p>
    );
  }

  const beginEdit = () => {
    setDraft(lakebaseBindingDraft(plan));
    setMessage('');
    setEditing(true);
  };
  const cancel = () => {
    setDraft(lakebaseBindingDraft(plan));
    setMessage('');
    setEditing(false);
  };
  const save = async () => {
    setSaving(true);
    setMessage('');
    try {
      const response = await fetch('/api/lakebase-binding/stage', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          database: draft.trim(),
          expectedRevision: plan.desired?.revision ?? 0,
          expectedActiveDatabase: plan.active.database,
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !isLakebaseRedeployPlan(body)) {
        const detail =
          body && typeof body === 'object' && 'detail' in body && typeof body.detail === 'string'
            ? body.detail
            : 'Nothing was staged. The active Lakebase binding is unchanged.';
        throw new Error(detail);
      }
      setPlan(body);
      setDraft(lakebaseBindingDraft(body));
      setEditing(false);
      setMessage('Redeploy plan staged. The running Lakebase connection has not changed.');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <LakebaseBindingPanel
      plan={plan}
      editing={editing}
      draft={draft}
      saving={saving}
      message={message}
      onEdit={beginEdit}
      onDraft={(value) => {
        setDraft(value);
        setMessage('');
      }}
      onSave={() => void save()}
      onCancel={cancel}
    />
  );
}
