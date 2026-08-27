import { useState } from 'react';
import { Button } from './ui';

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
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(errorDetail(body) || `Databricks answered ${response.status}.`);
      }
      if (!isSummary(body)) throw new Error('Databricks returned an incomplete tag result.');
      setSummary(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The tags were not applied.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="settings-row settings-resource-tags">
      <div>
        <p className="settings-row-label">Astrolabe resource tags</p>
        <p className="settings-row-note">
          Apply <code>system_billing=astrolabe</code> to everything this app manages. This repairs older deployments
          that were created before Astrolabe added the tag automatically, and removes the retired <code>astrolabe</code>{' '}
          key where the product API can delete it.
        </p>
        {summary ? <ResourceTagResults summary={summary} /> : null}
        {error ? (
          <p className="settings-status settings-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <Button variant="outline" type="button" disabled={running} onClick={() => void apply()}>
        {running ? 'Applying…' : 'Apply Astrolabe tags'}
      </Button>
    </div>
  );
}
