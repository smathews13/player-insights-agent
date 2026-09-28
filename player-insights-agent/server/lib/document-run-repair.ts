import { APP_SCHEMA } from '../../shared/app-schema';
import { TraceSchema } from '../../shared/run-trace-contract';
import { recordedDocumentRunTrace } from './document-run-trace';

interface DocumentRepairStore {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface DocumentRunRepairResult {
  candidates: number;
  repaired: number;
  unrepairable: number;
  remaining: number;
}

export const DOCUMENT_RUN_REPAIR_CANDIDATES = `
  SELECT m.id AS message_id, r.run_id, r.trace_id, r.created_at, r.completed_at,
         COALESCE(
           jsonb_agg(e.payload ORDER BY e.seq) FILTER (WHERE e.payload IS NOT NULL),
           '[]'::jsonb
         ) AS stages
  FROM ${APP_SCHEMA}.messages m
  LEFT JOIN ${APP_SCHEMA}.runs r ON r.terminal_message_id = m.id
  LEFT JOIN ${APP_SCHEMA}.run_events e
    ON e.run_id = r.run_id AND e.event_type = 'stage'
  WHERE m.role = 'assistant'
    AND m.response_json->>'type' IN ('dashboard', 'report')
    AND jsonb_typeof(m.response_json->'trace') IS DISTINCT FROM 'object'
  GROUP BY m.id, r.run_id, r.trace_id, r.created_at, r.completed_at
  ORDER BY MIN(m.created_at)
  LIMIT 200`;

export const DOCUMENT_RUN_REPAIR_REMAINING = `
  SELECT count(*)::int AS count
  FROM ${APP_SCHEMA}.messages m
  WHERE m.role = 'assistant'
    AND m.response_json->>'type' IN ('dashboard', 'report')
    AND jsonb_typeof(m.response_json->'trace') IS DISTINCT FROM 'object'`;

const DOCUMENT_RUN_REPAIR_UPDATE = `
  UPDATE ${APP_SCHEMA}.messages
  SET response_json = jsonb_set(response_json, '{trace}', $2::jsonb, true)
  WHERE id = $1
    AND role = 'assistant'
    AND response_json->>'type' IN ('dashboard', 'report')
    AND jsonb_typeof(response_json->'trace') IS DISTINCT FROM 'object'
  RETURNING id`;

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

function stages(value: unknown): Record<string, unknown>[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter(
        (stage): stage is Record<string, unknown> =>
          stage !== null && typeof stage === 'object' && !Array.isArray(stage)
      )
    : [];
}

function ledgerDuration(row: Record<string, unknown>): number {
  const created = timestamp(row.created_at);
  const completed = timestamp(row.completed_at);
  return Number.isFinite(created) && Number.isFinite(completed) && completed >= created ? completed - created : 0;
}

/**
 * Repair only historical document envelopes that can be reconstructed from the
 * exact run linked by terminal_message_id and its persisted stage events.
 */
export async function repairHistoricalDocumentRuns(store: DocumentRepairStore): Promise<DocumentRunRepairResult> {
  const candidates = await store.query(DOCUMENT_RUN_REPAIR_CANDIDATES);
  let repaired = 0;
  let unrepairable = 0;
  for (const row of candidates.rows) {
    const messageId = text(row.message_id);
    const runId = text(row.run_id);
    const recordedStages = stages(row.stages);
    if (!messageId || !runId || recordedStages.length === 0) {
      unrepairable += 1;
      continue;
    }
    const trace = recordedDocumentRunTrace(recordedStages, text(row.trace_id), ledgerDuration(row));
    if (!TraceSchema.safeParse(trace).success) {
      unrepairable += 1;
      continue;
    }
    const updated = await store.query(DOCUMENT_RUN_REPAIR_UPDATE, [messageId, JSON.stringify(trace)]);
    repaired += updated.rows.length;
  }
  const remaining = await store.query(DOCUMENT_RUN_REPAIR_REMAINING);
  return {
    candidates: candidates.rows.length,
    repaired,
    unrepairable,
    remaining: Number(remaining.rows[0]?.count ?? 0),
  };
}
