/* eslint-disable react-refresh/only-export-components -- result parsing, status, and controls share one response contract */
import { Fragment, useEffect, useState } from 'react';
import { ConceptFlicker } from './ConceptFlicker';
import { ExperimentalFeatureName } from './ExperimentalBadge';
import { Button } from './ui';

export const RESOURCE_TAG_REQUEST_TIMEOUT_MS = 20_000;

export type TagStatus =
  | 'tagged'
  | 'already-correct'
  | 'permission-required'
  | 'failed'
  | 'unsupported'
  | 'not-applicable';

export type TagResult = {
  kind: string;
  name: string;
  label: string;
  support: 'supported' | 'unsupported' | 'not-applicable';
  billingAttribution: boolean;
  status: TagStatus;
  detail: string;
  nextAction: string;
  technicalDetail?: string;
};

export type TagSummary = {
  headline: string;
  supportedTotal: number;
  supportedCovered: number;
  tagged: number;
  alreadyCorrect: number;
  supportedFailed: number;
  permissionRequired: number;
  unsupported: number;
  notApplicable: number;
  results: TagResult[];
  updatedAt: string;
};

function isSummary(value: unknown): value is TagSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<TagSummary>;
  return (
    typeof summary.headline === 'string' &&
    typeof summary.supportedTotal === 'number' &&
    typeof summary.supportedCovered === 'number' &&
    typeof summary.supportedFailed === 'number' &&
    typeof summary.permissionRequired === 'number' &&
    typeof summary.unsupported === 'number' &&
    typeof summary.notApplicable === 'number' &&
    Array.isArray(summary.results)
  );
}

function errorDetail(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const detail = (value as { detail?: unknown }).detail;
  return typeof detail === 'string' ? detail : '';
}

export function supportLabel(result: TagResult): string {
  if (result.support === 'supported') return 'Billing supported';
  if (result.support === 'unsupported') return 'Unsupported';
  return 'Not applicable';
}

export function resultLabel(status: TagStatus): string {
  const labels: Record<TagStatus, string> = {
    tagged: 'Newly applied',
    'already-correct': 'Already correct',
    'permission-required': 'Permission required',
    failed: 'Failed',
    unsupported: 'Unsupported by platform',
    'not-applicable': 'Excluded from billing coverage',
  };
  return labels[status];
}

export function ResourceTagResults({
  summary,
  hidden = false,
  clearing = false,
  running = false,
  clearError = '',
  onToggle,
  onClear,
  onFullRecheck,
}: {
  summary: TagSummary;
  hidden?: boolean;
  clearing?: boolean;
  running?: boolean;
  clearError?: string;
  onToggle?: () => void;
  onClear?: () => void;
  onFullRecheck?: () => void;
}) {
  return (
    <section className="resource-tag-result" role="status" aria-live="polite">
      <div className="resource-tag-summary">
        <div>
          <strong>{summary.headline}</strong>
          <span>
            {summary.tagged} new · {summary.alreadyCorrect} already correct · {summary.permissionRequired} need access ·{' '}
            {summary.supportedFailed} failed
          </span>
          <span>
            {summary.unsupported} unsupported · {summary.notApplicable} excluded from billing coverage
          </span>
        </div>
        <div className="resource-tag-summary-actions">
          <Button type="button" variant="outline" onClick={onToggle}>
            {hidden ? 'Show details' : 'Hide details'}
          </Button>
          <Button type="button" variant="outline" disabled={running || clearing} onClick={onFullRecheck}>
            Recheck all
          </Button>
          <Button type="button" variant="outline" disabled={running || clearing} onClick={onClear}>
            {clearing ? 'Clearing…' : 'Clear results'}
          </Button>
        </div>
      </div>
      <p className="resource-tag-clear-note">
        Clearing removes this saved result, not tags already applied to Databricks resources.
      </p>
      {clearError ? (
        <p className="settings-status settings-error" role="alert">
          {clearError}
        </p>
      ) : null}
      {!hidden ? (
        <div className="settings-table-frame resource-tag-table-frame">
          <table className="settings-data-table resource-tag-table">
            <thead>
              <tr>
                <th>Resource</th>
                <th>Support</th>
                <th>Result</th>
                <th>Next action</th>
              </tr>
            </thead>
            <tbody>
              {summary.results.map((result) => (
                <tr key={`${result.kind}-${result.name}`}>
                  <td>
                    <strong>{result.label.split(' · ')[0]}</strong>
                    <code title={result.name}>{result.name}</code>
                  </td>
                  <td>
                    <span className={`resource-tag-support resource-tag-support--${result.support}`}>
                      {supportLabel(result)}
                    </span>
                  </td>
                  <td>
                    <strong>{resultLabel(result.status)}</strong>
                    <span>{result.detail}</span>
                    {result.technicalDetail ? (
                      <details>
                        <summary>Technical details</summary>
                        <pre>{result.technicalDetail}</pre>
                      </details>
                    ) : null}
                  </td>
                  <td>{result.nextAction || 'None'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export function ResourceTagsApplyButton({ running, onClick }: { running: boolean; onClick?: () => void }) {
  return (
    <Button type="button" disabled={running} aria-busy={running} onClick={onClick}>
      {running ? <ConceptFlicker seat="button" /> : null}
      Apply tags
    </Button>
  );
}

export function resourceTagStatus(
  running: boolean,
  summary: TagSummary | null,
  error: string
): { tone: string; label: string } {
  if (running) return { tone: 'ast-pill--warn', label: 'Applying' };
  if (error || (summary?.supportedFailed ?? 0) > 0) return { tone: 'ast-pill--neg', label: 'Failed' };
  if ((summary?.permissionRequired ?? 0) > 0) return { tone: 'ast-pill--warn', label: 'Needs access' };
  if (summary) return { tone: 'ast-pill--pos', label: 'Applied' };
  return { tone: 'ast-pill--neutral', label: 'Idle' };
}

export function ResourceTagsPanel() {
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<TagSummary | null>(null);
  const [hidden, setHidden] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');
  const [clearError, setClearError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/settings/resource-tags', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(errorDetail(body) || 'Saved Resource Tags results could not be loaded.');
        const saved = body && typeof body === 'object' ? (body as { summary?: unknown }).summary : null;
        if (saved !== null && !isSummary(saved)) throw new Error('The saved Resource Tags result is invalid.');
        setSummary(saved);
      })
      .catch((cause) => {
        if (cause instanceof Error && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : 'Saved Resource Tags results could not be loaded.');
      });
    return () => controller.abort();
  }, []);

  const apply = async (mode: 'unresolved' | 'full' = 'unresolved') => {
    setRunning(true);
    setError('');
    setClearError('');
    try {
      const response = await fetch('/api/settings/resource-tags', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
        signal: AbortSignal.timeout(RESOURCE_TAG_REQUEST_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorDetail(body) || `Databricks answered ${response.status}.`);
      if (!isSummary(body)) throw new Error('Databricks returned an incomplete tag result.');
      setSummary(body);
      setHidden(false);
    } catch (cause) {
      const timeout = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
      setError(
        timeout
          ? 'The bounded Resource Tags run was cancelled after 20 seconds. The previous saved result was kept.'
          : cause instanceof Error
            ? cause.message
            : 'The tags were not applied.'
      );
    } finally {
      setRunning(false);
    }
  };

  const clear = async () => {
    setClearing(true);
    setClearError('');
    try {
      const response = await fetch('/api/settings/resource-tags', {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorDetail(body) || 'Results were not cleared.');
      setSummary(null);
      setHidden(false);
      setError('');
    } catch (cause) {
      setClearError(cause instanceof Error ? cause.message : 'Results were not cleared.');
    } finally {
      setClearing(false);
    }
  };
  const status = resourceTagStatus(running, summary, error);

  return (
    <Fragment>
      <tr className="settings-resource-tags">
        <td>
          <ExperimentalFeatureName kind="resource-tags">Resource tags</ExperimentalFeatureName>
          <p className="settings-row-note">Applies billing attribution tags to supported Databricks resources.</p>
          {error ? (
            <p className="settings-status settings-error" role="alert">
              {error}
            </p>
          ) : null}
        </td>
        <td className="exp-feature-status">
          <span className={`ast-pill ${status.tone}`}>{status.label}</span>
        </td>
        <td className="exp-feature-control">
          <div className="exp-feature-control-inner">
            <ResourceTagsApplyButton running={running} onClick={() => void apply()} />
          </div>
        </td>
      </tr>
      {summary ? (
        <tr className="resource-tag-details-row">
          <td colSpan={3}>
            <ResourceTagResults
              summary={summary}
              hidden={hidden}
              clearing={clearing}
              running={running}
              clearError={clearError}
              onToggle={() => setHidden((value) => !value)}
              onClear={() => void clear()}
              onFullRecheck={() => void apply('full')}
            />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}
