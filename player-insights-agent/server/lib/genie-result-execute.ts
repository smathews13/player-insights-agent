import { classifyGenieMiss } from '../../shared/eval-flywheel';
import { executedTableFromMatrix, type ExecutedTable } from '../../shared/benchmark-lab-v3';

/**
 * Run one statement on the app warehouse so Genie accuracy can score executed
 * results, not SQL text.
 *
 * A warehouse still starting, or a 50s cancel, is returned as a miss kind the
 * runner already knows how to exclude. This module does not invent a pass.
 */

export const GENIE_RESULT_WAIT = '50s';

export type SqlExecuteOk = { ok: true; table: ExecutedTable };
export type SqlExecuteMiss = { ok: false; note: string };
export type SqlExecuteResult = SqlExecuteOk | SqlExecuteMiss;

export type SqlExecutor = (sql: string) => Promise<SqlExecuteResult>;

type FetchLike = typeof fetch;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function columnNames(payload: Record<string, unknown>): string[] {
  const manifest = asRecord(payload.manifest);
  const schema = asRecord(manifest?.schema) ?? asRecord(payload.schema) ?? asRecord(asRecord(payload.result)?.schema);
  const columns = schema?.columns;
  if (Array.isArray(columns)) {
    return columns.map((entry, index) => {
      const column = asRecord(entry);
      return text(column?.name) || text(column?.display_name) || `col_${index}`;
    });
  }
  return [];
}

function dataArray(payload: Record<string, unknown>): unknown[][] {
  const result = asRecord(payload.result);
  const rows = result?.data_array ?? payload.data_array;
  if (!Array.isArray(rows)) return [];
  return rows.filter(Array.isArray) as unknown[][];
}

export function sqlIsResultQuery(sql: string): boolean {
  const head = sql.trim().replace(/^\(+/, '').toLowerCase();
  return /^(select|with)\b/.test(head);
}

export function tableFromStatementPayload(payload: unknown): ExecutedTable | null {
  const root = asRecord(payload);
  if (!root) return null;
  const rows = dataArray(root);
  const names = columnNames(root);
  const width = names.length || rows[0]?.length || 0;
  if (width <= 0 && rows.length === 0) return { rowCount: 0, columns: [] };
  const columns = (names.length > 0 ? names : Array.from({ length: width }, (_, index) => `col_${index}`));
  return executedTableFromMatrix(columns, rows);
}

export function createSqlExecutor(options: {
  host: string;
  token: string;
  warehouseId: string;
  fetchImpl?: FetchLike;
}): SqlExecutor | null {
  const host = options.host.replace(/\/+$/, '');
  const warehouseId = options.warehouseId.trim();
  if (!host || !options.token || !warehouseId) return null;
  const call = options.fetchImpl ?? fetch;

  return async (sql: string): Promise<SqlExecuteResult> => {
    if (!sqlIsResultQuery(sql)) {
      return { ok: false, note: 'Statement is not a result set. Matching needs a SELECT.' };
    }
    try {
      const response = await call(`${host}/api/2.0/sql/statements`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          warehouse_id: warehouseId,
          statement: sql,
          wait_timeout: GENIE_RESULT_WAIT,
          on_wait_timeout: 'CANCEL',
          format: 'JSON_ARRAY',
          disposition: 'INLINE',
        }),
        signal: AbortSignal.timeout(55_000),
      });
      const payload = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      if (!response.ok) {
        const note = text(payload.message) || text(payload.error) || `warehouse returned HTTP ${response.status}`;
        return { ok: false, note };
      }
      const status = asRecord(payload.status);
      const state = text(status?.state).toUpperCase();
      if (state && state !== 'SUCCEEDED') {
        const error = asRecord(status?.error);
        const note = text(error?.message) || `statement ended in ${state}`;
        return { ok: false, note };
      }
      const table = tableFromStatementPayload(payload);
      if (!table) return { ok: false, note: 'Warehouse returned no result table.' };
      return { ok: true, table };
    } catch (error) {
      const timedOut = (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError';
      return {
        ok: false,
        note: timedOut
          ? 'SQL cancelled or timed out after 50s.'
          : `The SQL warehouse could not be reached: ${(error as Error).message}`,
      };
    }
  };
}

export function executeMissKind(note: string): ReturnType<typeof classifyGenieMiss> {
  return classifyGenieMiss(note);
}
