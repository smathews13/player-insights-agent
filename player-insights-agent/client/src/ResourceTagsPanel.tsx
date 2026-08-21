import { useState } from 'react';
import { Button } from './ui';

type TagResult = {
  label: string;
  status: 'tagged' | 'already-tagged' | 'skipped' | 'failed';
  detail: string;
};

type TagSummary = {
  tagged: number;
  alreadyTagged: number;
  skipped: number;
  failed: number;
  results: TagResult[];
};

function isSummary(value: unknown): value is TagSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<TagSummary>;
  return (
    typeof summary.tagged === 'number' &&
    typeof summary.alreadyTagged === 'number' &&
    typeof summary.skipped === 'number' &&
    typeof summary.failed === 'number' &&
    Array.isArray(summary.results)
  );
}

function errorDetail(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const detail = (value as { detail?: unknown }).detail;
  return typeof detail === 'string' ? detail : '';
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
          Apply <code>astrolabe=true</code> to everything this app manages. This repairs older deployments that were
          created before Astrolabe added the tag automatically.
        </p>
        {summary ? (
          <div className="resource-tag-result" role="status" aria-live="polite">
            <p>
              {summary.tagged} tagged, {summary.skipped} skipped
              {summary.failed ? `, ${summary.failed} failed` : ''}
              {summary.alreadyTagged ? ` · ${summary.alreadyTagged} already tagged` : ''}.
            </p>
            <ul>
              {summary.results.map((result) => (
                <li key={`${result.label}-${result.status}`}>
                  <strong>{result.label}</strong>: {result.detail}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
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
