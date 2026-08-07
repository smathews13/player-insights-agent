/**
 * Live dependency state, from the agent by way of `/api/preflight`.
 *
 * Lifted out of App.tsx when the Sources page was merged into Connections. Two
 * modules now read this, and the page that renders it is no longer the file
 * that defines it, so a shared module is the only way to keep one definition;
 * ConnectionsPage.tsx importing from App.tsx would be a cycle, App.tsx imports
 * the page.
 */
import { useCallback, useEffect, useState } from 'react';

export type PreflightStatus = 'ok' | 'failed' | 'unverified';

export interface PreflightRemedy {
  kind: 'sql' | 'cli';
  statement: string;
  note: string;
}

export interface PreflightCheck {
  id: string;
  kind: string;
  name: string;
  label: string;
  status: PreflightStatus;
  detail: string;
  checked_with: string;
  duration_ms: number;
  error: string;
  remedy: PreflightRemedy | null;
}

export interface PreflightReport {
  checked_at: string;
  status: PreflightStatus;
  principal: string;
  principal_resolved: boolean;
  table_source: string;
  checks: PreflightCheck[];
  assumptions: string[];
  counts: { ok: number; failed: number; unverified: number };
  source: 'agent' | 'app';
}

export function isPreflightReport(value: unknown): value is PreflightReport {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.checks) && typeof record.status === 'string' && !!record.counts;
}

/**
 * The report, and whether asking for it worked.
 *
 * A 503 is not an error here: the route answers a *report* when the agent is
 * unreachable, describing that unreachability as a failed check. Rendering it
 * the same way any other failure is rendered is the point: the user gets the
 * remedy instead of a dead page. Only a body that is not a report at all, or a
 * fetch that never lands, becomes the error state.
 */
export function usePreflight() {
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/preflight');
      const payload: unknown = await response.json();
      if (isPreflightReport(payload)) {
        setReport(payload);
      } else {
        setReport(null);
        setError(`The preflight route answered ${response.status} but not with a dependency report. The app may be mid-deploy.`
        );
      }
    } catch {
      setReport(null);
      setError('Could not reach the preflight route. The app server may be restarting.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { report, error, loading, reload: load };
}

export const PREFLIGHT_STATUS_LABEL: Record<PreflightStatus, string> = {
  ok: 'Reachable',
  failed: 'Blocked',
  unverified: 'Not checked',
};

export function preflightBadgeVariant(status: PreflightStatus) {
  return status === 'ok' ? 'secondary' : status === 'failed' ? 'destructive' : 'outline';
}

export function formatCheckedAt(value: string) {
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return value;
  return when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** The one-line verdict over the whole dependency set. */
export function preflightHeadline(report: PreflightReport): string {
  if (report.status === 'ok') return 'Every dependency is reachable';
  if (report.status === 'failed') return `${report.counts.failed} of ${report.checks.length} dependencies are blocked`;
  return 'Some dependencies could not be checked';
}
