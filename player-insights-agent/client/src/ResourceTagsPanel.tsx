import { useState } from 'react';
import { ConceptFlicker } from './ConceptFlicker';
import { ExperimentalFeatureName } from './ExperimentalBadge';
import { Button } from './ui';

export const RESOURCE_TAG_REQUEST_TIMEOUT_MS = 20_000;

export type TagResult = {
  label: string;
  status: 'tagged' | 'already-correct' | 'not-supported' | 'permission-required' | 'failed';
  detail: string;
  technicalDetail?: string;
};

export type TagSummary = {
  headline: string;
  total: number;
  correct: number;
  tagged: number;
  alreadyCorrect: number;
  notSupported: number;
  permissionRequired: number;
  failed: number;
  results: TagResult[];
};

function isSummary(value: unknown): value is TagSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<TagSummary>;
  return (
    typeof summary.headline === 'string' &&
    typeof summary.total === 'number' &&
    typeof summary.correct === 'number' &&
    typeof summary.tagged === 'number' &&
    typeof summary.alreadyCorrect === 'number' &&
    typeof summary.notSupported === 'number' &&
    typeof summary.permissionRequired === 'number' &&
    typeof summary.failed === 'number' &&
    Array.isArray(summary.results)
  );
}

function errorDetail(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const detail = (value as { detail?: unknown }).detail;
  return typeof detail === 'string' ? detail : '';
}

/**
 * The first line answers whether the repair worked; each row then says either
 * what is already right, what Databricks cannot tag, or the exact grant a human
 * must make. Raw API payloads are deliberately behind disclosure because their
 * first 240 characters used to crowd out the instruction and end mid-JSON.
 */
export function ResourceTagResults({ summary }: { summary: TagSummary }) {
  return (
    <div className="resource-tag-result" role="status" aria-live="polite">
      <p>{summary.headline}</p>
      <ul>
        {summary.results.map((result) => (
          <li key={`${result.label}-${result.status}`}>
            <strong>{result.label}</strong>: {result.detail}
            {result.technicalDetail ? (
              <details>
                <summary>Technical details</summary>
                <pre>{result.technicalDetail}</pre>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
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
  if (error || (summary?.failed ?? 0) > 0) return { tone: 'ast-pill--neg', label: 'Failed' };
  if ((summary?.permissionRequired ?? 0) > 0) return { tone: 'ast-pill--warn', label: 'Needs access' };
  if (summary) return { tone: 'ast-pill--pos', label: 'Applied' };
  return { tone: 'ast-pill--neutral', label: 'Idle' };
}

export function ResourceTagsPanel() {
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<TagSummary | null>(null);
  const [error, setError] = useState('');

  const apply = async () => {
    setRunning(true);
    setError('');
    try {
      const response = await fetch('/api/settings/resource-tags', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(RESOURCE_TAG_REQUEST_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(errorDetail(body) || `Databricks answered ${response.status}.`);
      }
      if (!isSummary(body)) throw new Error('Databricks returned an incomplete tag result.');
      setSummary(body);
    } catch (cause) {
      const timeout =
        cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
      setError(
        timeout
          ? 'Databricks did not finish the tag update within 20 seconds. Retry to confirm which tags landed.'
          : cause instanceof Error
            ? cause.message
            : 'The tags were not applied.'
      );
    } finally {
      setRunning(false);
    }
  };
  const status = resourceTagStatus(running, summary, error);

  return (
    <tr className="settings-resource-tags">
      <td>
        <ExperimentalFeatureName>Resource tags</ExperimentalFeatureName>
        <p className="settings-row-note">
          <code>system_billing=astrolabe</code>
        </p>
        {summary ? <ResourceTagResults summary={summary} /> : null}
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
  );
}
