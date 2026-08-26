import type { WorkspaceMonitor } from '../../shared/eval-live-scoring';

/**
 * Probe MLflow GenAI production monitoring on the experiment.
 *
 * Apps cannot register Python `@scorer` functions — Databricks requires that
 * from a notebook. This lists scorers that already exist and tries to start
 * them. A missing scope or empty list is reported, not dressed up as "on".
 */

export const MLFLOW_SCORER_LIST_PATHS = [
  '/api/2.0/mlflow/genai/scorers/list',
  '/api/2.0/mlflow/scorers/list',
] as const;

export interface MonitorWorkspaceClient {
  apiClient: {
    request(input: { method: string; path: string; query?: Record<string, string> }): Promise<unknown>;
  };
}

export function parseScorerNames(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  const lists = [record.scorers, record.registered_scorers, record.entities];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    const names = list
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim();
        if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
          return (entry as { name: string }).name.trim();
        }
        return '';
      })
      .filter(Boolean);
    if (names.length > 0) return [...new Set(names)];
  }
  return [];
}

export function workspaceMonitorFromError(error: unknown): WorkspaceMonitor {
  const message = error instanceof Error ? error.message : String(error);
  const blocked =
    /403|401|PERMISSION|scope|UNAUTHORIZED|not found|404|does not exist|INVALID_PARAMETER/i.test(
      message
    );
  return {
    status: blocked ? 'blocked' : 'unknown',
    note: blocked
      ? `Workspace monitoring is not available to this app: ${message} Production scorers have to be registered from a Databricks notebook. Sampled Ask turns are still scored here.`
      : `Workspace monitoring could not be checked: ${message} Sampled Ask turns are still scored here.`,
    scorers: [],
  };
}

export async function probeWorkspaceMonitoring(
  client: MonitorWorkspaceClient,
  experimentId: string
): Promise<WorkspaceMonitor> {
  const named = experimentId.trim();
  if (!named) {
    return {
      status: 'unknown',
      note: 'No MLflow experiment id is configured, so workspace monitoring cannot be listed. Sampled Ask turns are still scored here.',
      scorers: [],
    };
  }
  let lastError: unknown = new Error('No scorer list path answered.');
  for (const path of MLFLOW_SCORER_LIST_PATHS) {
    try {
      const body = await client.apiClient.request({
        method: 'GET',
        path,
        query: { experiment_id: named },
      });
      const scorers = parseScorerNames(body);
      if (scorers.length > 0) {
        return {
          status: 'active',
          note: `Workspace monitoring already has ${scorers.length} scorer(s) on this experiment. Sampled Ask turns are also scored in this app.`,
          scorers,
        };
      }
      return {
        status: 'blocked',
        note: 'The experiment has no registered production scorers. Apps cannot register Python scorers — that has to happen in a Databricks notebook. Sampled Ask turns are scored in this app instead.',
        scorers: [],
      };
    } catch (error) {
      lastError = error;
    }
  }
  return workspaceMonitorFromError(lastError);
}
