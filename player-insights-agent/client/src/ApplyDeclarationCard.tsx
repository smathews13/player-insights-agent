/**
 * Apply staged hard knobs by creating a new model version.
 *
 * WHY A COMMAND, NOT AN IN-APP RELEASE. Logging and deploying the agent needs a
 * deployer's CLI profile, bundle target, and privileges the app process should
 * not hold. This card shows drift that needs a re-log and the exact shared
 * entrypoint (`bundle/apply-declaration.sh`) a notebook cell also calls.
 *
 * Soft settings that take effect immediately are not listed here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApplyPlan } from '../../shared/apply-declaration';
import type { ModelReleaseRequest } from '../../shared/model-release';
import type { NotebookPanel } from './connection-model';
import { showsAdminSurfaces, useRole } from './role';
import { Button } from './ui';
import {
  NOTEBOOK_REQUIRED_ACTION,
  applyActionState,
  modelReleaseNotebookSnippet,
  releaseVersionLine,
} from './apply-declaration-state';

interface ApplyResponse {
  status: 'idle' | 'ready';
  plan: ApplyPlan;
  target: string;
  submitted?: boolean;
  detail?: string;
}

export function ApplyDeclarationCard({
  notebook,
  onRefresh,
}: {
  notebook?: NotebookPanel;
  onRefresh?: () => void;
}) {
  const role = useRole();
  const isAdmin = showsAdminSurfaces(role.state);
  const [plan, setPlan] = useState<ApplyResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'command' | 'notebook' | ''>('');
  const [release, setRelease] = useState<ModelReleaseRequest | null>(null);
  const refreshedTerminal = useRef('');

  const loadRelease = useCallback(async () => {
    if (!isAdmin) return;
    const response = await fetch('/api/admin/model-releases?limit=1');
    if (!response.ok) return;
    const body = (await response.json()) as { releases?: ModelReleaseRequest[] };
    const latest = body.releases?.[0] ?? null;
    setRelease(latest);
    if (
      latest &&
      (latest.status === 'succeeded' || latest.status === 'failed') &&
      refreshedTerminal.current !== latest.id
    ) {
      refreshedTerminal.current = latest.id;
      onRefresh?.();
    }
  }, [isAdmin, onRefresh]);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setBusy(true);
    setError('');
    try {
      const [response] = await Promise.all([fetch('/api/settings/apply'), loadRelease()]);
      if (response.status === 403) {
        setError('Only an administrator can request Apply.');
        setPlan(null);
        return;
      }
      if (!response.ok) {
        setError('The Apply plan could not be loaded.');
        setPlan(null);
        return;
      }
      setPlan((await response.json()) as ApplyResponse);
    } finally {
      setBusy(false);
    }
  }, [isAdmin, loadRelease]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (release?.status !== 'approved' && release?.status !== 'running') return;
    const timer = window.setInterval(() => void loadRelease(), 5000);
    return () => window.clearInterval(timer);
  }, [loadRelease, release?.status]);

  async function requestApply() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/admin/model-releases', { method: 'POST' });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { detail?: string };
        setError(body.detail ?? 'Apply could not be prepared.');
        return;
      }
      const body = (await response.json()) as { release: ModelReleaseRequest };
      setRelease(body.release);
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string, kind: 'command' | 'notebook') {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(''), 2000);
    } catch {
      setError('Could not copy the command. Select it and copy manually.');
    }
  }

  if (!isAdmin) return null;

  const knobs = plan?.plan.knobs ?? [];
  const notes = plan?.plan.notes ?? [];
  const notebookSnippet = release ? modelReleaseNotebookSnippet(release, window.location.origin) : '';
  const action = applyActionState({
    notebook,
    busy,
    knobCount: knobs.length,
    releaseStatus: release?.status,
  });

  return (
    <section className="plane-card" aria-label="Apply model settings" data-testid="apply-declaration">
      <div className="plane-card-head">
        <span>Apply → new model version</span>
        <span className="plane-card-head-aside">
          <button type="button" className="plane-button-quiet" disabled={busy} onClick={() => void load()}>
            Refresh
          </button>
        </span>
      </div>

      <ol className="plane-list plane-apply-steps">
        <li>Review the staged settings below.</li>
        <li>Approve the release request.</li>
        <li>Run the copied notebook cell.</li>
      </ol>
      <p className="plane-card-note">Outcome: a new model version with these settings, ready for deployment.</p>

      {error ? <p className="plane-card-error">{error}</p> : null}

      {knobs.length === 0 ? (
        <p className="plane-card-note">
          {notes[0] ?? (busy ? 'Reading staged settings…' : 'Nothing waiting on a re-log.')}
        </p>
      ) : (
        <ul className="plane-list">
          {knobs.map((knob) => (
            <li key={knob.key}>
              <strong>{knob.label}</strong>
              <span className="plane-muted"> ({knob.source === 'intended' ? 'Connections' : 'notebook'})</span>
              {': '}
              <code>{knob.value}</code>
            </li>
          ))}
        </ul>
      )}

      {release ? (
        <div className="plane-card-actions" data-testid="model-release-status">
          <p>
            Release request <code>{release.id}</code>
          </p>
          <p className="plane-card-note">
            Status: <strong>{release.status}</strong>
            {releaseVersionLine(release) ? <> · {releaseVersionLine(release)}</> : null}
          </p>
          {release.preflightResult ? (
            <p className="plane-card-note">
              Preflight: {release.preflightResult.status} ({release.preflightResult.ok} passed,{' '}
              {release.preflightResult.failed} failed, {release.preflightResult.unverified} unverified)
            </p>
          ) : null}
          {release.errorSummary ? <p className="plane-card-error">{release.errorSummary}</p> : null}
          <p className="plane-card-note">Run this notebook cell to create the model version:</p>
          <code className="plane-command" data-testid="apply-notebook-snippet">
            {notebookSnippet}
          </code>
          <Button type="button" variant="ghost" size="sm" onClick={() => void copy(notebookSnippet, 'notebook')}>
            {copied === 'notebook' ? 'Copied' : 'Copy notebook cell'}
          </Button>
        </div>
      ) : null}

      {/* The reason sits above the control it disables, so the refusal and its
          cause are read together. Grey rather than red: no notebook connected
          yet is an ordinary starting state, not a fault. */}
      {action.reason ? (
        <p className="plane-card-note" id="apply-notebook-required" data-testid="apply-notebook-required">
          {action.reason} {NOTEBOOK_REQUIRED_ACTION}
        </p>
      ) : null}

      {plan?.plan.command ? (
        <div className="plane-card-actions">
          <div className="plane-card-action-row">
            <Button
              type="button"
              size="sm"
              disabled={action.disabled}
              aria-describedby={action.reason ? 'apply-notebook-required' : undefined}
              onClick={() => void requestApply()}
            >
              Approve new model version
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
