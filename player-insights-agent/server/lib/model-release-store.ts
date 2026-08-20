import { APP_SCHEMA } from '../../shared/app-schema';
import type { LakebaseReader } from './lakebase-store';
import type {
  ModelReleaseCompletion,
  ModelReleaseDeclaration,
  ModelReleaseRequest,
  ReleasePreflight,
} from '../../shared/model-release';

const COLUMNS = `id, status, requested_by, requested_at, declaration,
  declaration_revision, target, endpoint_name, model_name, v_from, v_to,
  preflight_at_request, preflight_result, started_at, completed_at,
  claimed_by, completed_by, error_summary`;

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  return '';
}

function instant(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : text(value) || null;
}

function jsonValue<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

export function modelReleaseFromRow(row: Record<string, unknown>): ModelReleaseRequest {
  return {
    id: text(row.id),
    status: text(row.status) as ModelReleaseRequest['status'],
    requestedBy: text(row.requested_by),
    requestedAt: instant(row.requested_at) ?? '',
    declaration: jsonValue<ModelReleaseDeclaration>(row.declaration) as ModelReleaseDeclaration,
    declarationRevision: text(row.declaration_revision),
    target: text(row.target),
    endpointName: text(row.endpoint_name),
    modelName: text(row.model_name),
    vFrom: text(row.v_from) || null,
    vTo: text(row.v_to) || null,
    preflightAtRequest: jsonValue<ReleasePreflight>(row.preflight_at_request),
    preflightResult: jsonValue<ReleasePreflight>(row.preflight_result),
    startedAt: instant(row.started_at),
    completedAt: instant(row.completed_at),
    claimedBy: text(row.claimed_by) || null,
    completedBy: text(row.completed_by) || null,
    errorSummary: text(row.error_summary) || null,
  };
}

export async function createModelRelease(
  store: LakebaseReader,
  input: {
    id: string;
    requestedBy: string;
    declaration: ModelReleaseDeclaration;
    target: string;
    endpointName: string;
    modelName: string;
    vFrom: string | null;
    preflightAtRequest: ReleasePreflight | null;
  }
): Promise<ModelReleaseRequest> {
  const result = await store.lakebase.query(
    `INSERT INTO ${APP_SCHEMA}.model_release_requests
       (id, status, requested_by, declaration, declaration_revision, target,
        endpoint_name, model_name, v_from, preflight_at_request)
     VALUES ($1, 'approved', $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.requestedBy,
      JSON.stringify(input.declaration),
      input.declaration.revision,
      input.target,
      input.endpointName,
      input.modelName,
      input.vFrom,
      input.preflightAtRequest ? JSON.stringify(input.preflightAtRequest) : null,
    ]
  );
  return modelReleaseFromRow(result.rows[0] ?? {});
}

export async function readModelRelease(store: LakebaseReader, id: string): Promise<ModelReleaseRequest | null> {
  const result = await store.lakebase.query(
    `SELECT ${COLUMNS}
       FROM ${APP_SCHEMA}.model_release_requests
      WHERE id = $1`,
    [id]
  );
  return result.rows[0] ? modelReleaseFromRow(result.rows[0]) : null;
}

export async function listModelReleases(store: LakebaseReader, limit = 20): Promise<ModelReleaseRequest[]> {
  const result = await store.lakebase.query(
    `SELECT ${COLUMNS}
       FROM ${APP_SCHEMA}.model_release_requests
      ORDER BY requested_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(limit, 100))]
  );
  return result.rows.map(modelReleaseFromRow);
}

/**
 * Atomically lease an approved request to one helper execution.
 *
 * A retry with the same execution id receives the running row. A different
 * execution id cannot claim it, even when both helpers authenticate as the same
 * administrator.
 */
export async function claimModelRelease(
  store: LakebaseReader,
  id: string,
  executionId: string,
  actor: string
): Promise<{ release: ModelReleaseRequest | null; claimed: boolean }> {
  const updated = await store.lakebase.query(
    `UPDATE ${APP_SCHEMA}.model_release_requests
        SET status = 'running', execution_id = $2, claimed_by = $3,
            started_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'approved'
      RETURNING ${COLUMNS}`,
    [id, executionId, actor]
  );
  if (updated.rows[0]) return { release: modelReleaseFromRow(updated.rows[0]), claimed: true };

  const existing = await store.lakebase.query(
    `SELECT ${COLUMNS}, execution_id
       FROM ${APP_SCHEMA}.model_release_requests
      WHERE id = $1`,
    [id]
  );
  const row = existing.rows[0];
  if (!row) return { release: null, claimed: false };
  return {
    release: modelReleaseFromRow(row),
    claimed: row.status === 'running' && row.execution_id === executionId,
  };
}

export async function completeModelRelease(
  store: LakebaseReader,
  id: string,
  actor: string,
  completion: ModelReleaseCompletion
): Promise<{ release: ModelReleaseRequest | null; updated: boolean }> {
  const error = completion.status === 'failed' ? (completion.errorSummary ?? '').slice(0, 1000) : null;
  const updated = await store.lakebase.query(
    `UPDATE ${APP_SCHEMA}.model_release_requests
        SET status = $3, v_to = $4, preflight_result = $5::jsonb,
            error_summary = $6, completed_by = $7, completed_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'running' AND execution_id = $2
      RETURNING ${COLUMNS}`,
    [
      id,
      completion.executionId,
      completion.status,
      completion.vTo || null,
      completion.preflight ? JSON.stringify(completion.preflight) : null,
      error,
      actor,
    ]
  );
  if (updated.rows[0]) return { release: modelReleaseFromRow(updated.rows[0]), updated: true };

  const existing = await store.lakebase.query(
    `SELECT ${COLUMNS}, execution_id
       FROM ${APP_SCHEMA}.model_release_requests
      WHERE id = $1`,
    [id]
  );
  const row = existing.rows[0];
  if (!row) return { release: null, updated: false };
  const release = modelReleaseFromRow(row);
  const idempotent =
    row.execution_id === completion.executionId &&
    release.status === completion.status &&
    (release.vTo ?? null) === (completion.vTo || null);
  return { release, updated: idempotent };
}
