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
// The word a reader sees, and the three ways `unverified` happens, decided in one
// module so a row and the strip that counts the rows cannot disagree about one
// check. See `shared/check-verdict.ts` for why the status itself is not widened.
import { CHECK_VERDICT_LABEL, checkVerdict, type CheckStop, type CheckVerdict } from '../../shared/check-verdict';

export type PreflightStatus = 'ok' | 'failed' | 'unverified';

export interface PreflightRemedy {
  /**
   * `sql` runs in a SQL editor, `cli` is a Databricks CLI call, and `ui` is
   * something the reader does in their own browser with no workspace authority.
   * The renderer treats the third differently on purpose: a private window is
   * not a command, and a code block would send somebody looking for a terminal.
   */
  kind: 'sql' | 'cli' | 'ui';
  statement: string;
  /**
   * One short line a reader needs to carry the statement out correctly, or `''`.
   *
   * MOSTLY EMPTY, and rendered only when it is not. This was `note`, and it held
   * the "Why this is the fix" paragraph that was cut from Connections for reading
   * as narrative; the field went on being generated after the fold came off, so
   * it reached no screen at all and a blocked row showed an instruction with no
   * reasoning. It is back as one line, on the few remedies whose statement is not
   * enough on its own. The test a sentence has to pass to be here is in
   * `DiagnosisRemedy.guidance` in `shared/stated-cause.ts`.
   */
  guidance: string;
  /**
   * Who can run it, where `kind` alone would send the reader to the wrong
   * person. Absent for almost every remedy; see the schema in
   * `server/routes/insights-routes.ts` for the one case that sets it.
   */
  run_by?: string;
}

export interface PreflightCheck {
  id: string;
  kind: string;
  name: string;
  /** Human-readable workspace name when the API returned one; raw id stays in `name`. */
  display_name?: string;
  label: string;
  status: PreflightStatus;
  detail: string;
  checked_with: string;
  duration_ms: number;
  error: string;
  remedy: PreflightRemedy | null;
  /**
   * When the object's CONTENT was last written, where it holds content somebody
   * rebuilds rather than serving it live. ISO 8601.
   *
   * Absent or `''` MEANS NOTHING REPORTED ONE, and both readers of this field
   * have to say so. The temptation is to fall back to the time of the check,
   * which is always available and always wrong: it says when we asked, and a
   * card that prints it is telling a reader the content is minutes old when
   * what is minutes old is the question.
   */
  content_at?: string;
  /**
   * Which of the three ways this check established nothing, while `status` is
   * `unverified`.
   *
   * Optional because the orchestrator's own report predates it and carries none.
   * `checkVerdict` reads its absence as unasked or unreachable and never as a
   * refusal; see the fallback note there.
   */
  stopped?: CheckStop;
  /**
   * The permission a refusal turned on, in the Apps-API spelling, or absent.
   *
   * Read rather than derived: the probe that took the refusal is the only thing
   * that knows which API family the call belonged to, and a second reading of
   * that vocabulary on this side has already printed a wrong verdict once. See
   * the same field in `server/routes/insights-routes.ts` for which branch sets
   * it, and `optional-scope-findings.ts` for what this page does with it.
   */
  scope?: string;
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
  /**
   * Who measured it: 'agent' inside the endpoint, 'app' when the endpoint never
   * answered, 'configuration' when it answered with its settings and ran no
   * checks. The third is not a variant of the first. See the same field in
   * `server/routes/insights-routes.ts` for what conflating them cost.
   */
  source: 'agent' | 'app' | 'configuration';
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
        setError(
          `The preflight route answered ${response.status} but not with a dependency report. The app may be mid-deploy.`
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

/**
 * The three statuses as words, for the readers that only hold a status.
 *
 * NOT WHAT A CHECK ROW SHOWS ANY MORE. `unverified` covers a refusal, a broken
 * call and a probe nobody ran, and calling all three "Not checked" put that word
 * beside `HTTP 403` on twelve table rows at once. Anything holding a whole check
 * uses {@link checkVerdictLabel}, which can tell them apart.
 */
export const PREFLIGHT_STATUS_LABEL: Record<PreflightStatus, string> = {
  ok: 'Reachable',
  failed: 'Blocked',
  unverified: 'Not checked',
};

export function preflightBadgeVariant(status: PreflightStatus) {
  return status === 'ok' ? 'secondary' : status === 'failed' ? 'destructive' : 'outline';
}

/** What one check's badge says, from the whole check rather than its status. */
export function checkVerdictLabel(check: Pick<PreflightCheck, 'status' | 'error' | 'stopped'>): string {
  return CHECK_VERDICT_LABEL[checkVerdict(check)];
}

/** The chip variant a verdict earns. */
export function verdictBadgeVariant(verdict: CheckVerdict) {
  return verdict === 'reachable' ? 'secondary' : verdict === 'blocked' ? 'destructive' : 'outline';
}

/** The chip variant for one check, on the same reading as its word. */
export function checkBadgeVariant(check: Pick<PreflightCheck, 'status' | 'error' | 'stopped'>) {
  return verdictBadgeVariant(checkVerdict(check));
}

export function formatCheckedAt(value: string) {
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return value;
  return when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function countPreflightChecks(checks: readonly PreflightCheck[]) {
  return {
    ok: checks.filter((check) => check.status === 'ok').length,
    failed: checks.filter((check) => check.status === 'failed').length,
    unverified: checks.filter((check) => check.status === 'unverified').length,
  };
}

/**
 * The one-line verdict over a set of checks, whoever ran them.
 *
 * Takes the checks rather than the report because the report is no longer the
 * only thing that produces them: the app asks the workspace about the
 * deployment's dependencies itself, and a headline computed from the
 * orchestrator's own counts would describe two checks while the page below it
 * listed twenty. Never 'reachable' while anything is unverified, which is the
 * same rule `overallStatus` applies on the server: a check that did not run is
 * not a check that passed.
 */
export function checksHeadline(checks: readonly PreflightCheck[]): string {
  if (checks.length === 0) return 'No dependency check answered';
  const counts = countPreflightChecks(checks);
  if (counts.failed > 0) return `${counts.failed} of ${checks.length} dependencies are blocked`;
  if (counts.unverified > 0) return 'Some dependencies could not be checked';
  return 'Every dependency is reachable';
}

/** The one-line verdict over the whole dependency set. */
export function preflightHeadline(report: PreflightReport): string {
  return checksHeadline(report.checks);
}
