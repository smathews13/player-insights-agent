/**
 * Whether an id is one MLflow actually issued.
 *
 * MLflow's own ids are `tr-` plus hex. The agent used to mint `trace-<uuid>`
 * when no span was active, and Databricks serving sometimes stamps a request id
 * that is not that shape. `mlflowReference` already refused to link either of
 * those; the rest of the app still painted the local stage list as a recorded
 * run. This helper is the one predicate every surface has to share so that
 * split cannot come back.
 *
 * Do not loosen this to "any non-empty string" or to a Review App request id.
 * An invented link is worse than no link.
 */
const MLFLOW_TRACE_ID = /^tr-[0-9a-f]+$/i;
const MLFLOW_HEX32 = /^[0-9a-f]{32}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMlflowTraceId(value: unknown): boolean {
  return typeof value === 'string' && MLFLOW_TRACE_ID.test(value.trim());
}

/**
 * `tr-<hex>` if `value` is a real MLflow id, else empty.
 *
 * Accepts the prefixed form and a bare 32-char hex (what a LiveSpan stores).
 * Refuses a UUID request id, a minted `trace-<uuid>`, and anything else.
 */
export function asMlflowTraceId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.toLowerCase().startsWith('trace-') || /NO_OP/i.test(text)) return '';
  if (UUID.test(text)) return '';
  if (MLFLOW_TRACE_ID.test(text)) return `tr-${text.slice(3).toLowerCase()}`;
  if (MLFLOW_HEX32.test(text)) return `tr-${text.toLowerCase()}`;
  return '';
}

/**
 * The MLflow id Databricks serving put on the envelope, if it did.
 *
 * The agent stamps `answer.trace.id` from the span it opened. On a streamed
 * serving call that span's contextvars can be gone by the time the id is read,
 * so the payload falls back to a local id while the platform still recorded a
 * real trace and put its id on the stream. `databricks_request_id` is often a
 * UUID, which is not that id. Stage events and `custom_outputs.trace_id` are.
 */
export function servingMlflowTraceId(payload: unknown): string {
  for (const candidate of servingTraceCandidates(payload)) {
    const recorded = asMlflowTraceId(candidate);
    if (recorded) return recorded;
  }
  return '';
}

function servingTraceCandidates(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const buckets: unknown[] = [record.custom_outputs, record.databricks_output, record];
  for (const key of ['data', 'response', 'result', 'body']) {
    const nested = record[key];
    if (nested && typeof nested === 'object') {
      const inner = nested as Record<string, unknown>;
      buckets.push(inner.custom_outputs, inner.databricks_output, inner);
    }
  }
  const found: unknown[] = [];
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== 'object') continue;
    const row = bucket as Record<string, unknown>;
    found.push(row.databricks_request_id, row.trace_id, row.traceId, row.mlflow_trace_id);
    const answer = row.answer;
    if (answer && typeof answer === 'object') {
      const trace = (answer as Record<string, unknown>).trace;
      if (trace && typeof trace === 'object') {
        found.push((trace as Record<string, unknown>).id);
      }
    }
  }
  return found;
}

/**
 * Stamp a serving-envelope MLflow id onto an answer that did not already have one.
 *
 * Leaves a real `tr-` id untouched. Refuses anything that is not that shape, so
 * a UUID request id cannot become a fake Open-in-MLflow link.
 */
export function bindServingMlflowTraceId<T extends { trace: { id: string } }>(answer: T, platformTraceId: string): T {
  const recorded = asMlflowTraceId(platformTraceId);
  if (isMlflowTraceId(answer.trace.id) || !recorded) return answer;
  return { ...answer, trace: { ...answer.trace, id: recorded } };
}

/**
 * Drop the local Gantt when MLflow never issued a `tr-` id.
 *
 * Keep wall time and the agent's tool-call counter. Those are RunLog
 * measurements, not MLflow, and zeroing them made Explorer say "0 tools" and
 * "not set" on a run that had called SQL and burned the budget.
 */
export function withoutUntracedTimeline<T extends { id: string; stages?: unknown[] }>(trace: T): T {
  if (isMlflowTraceId(trace.id)) return trace;
  if (!Array.isArray(trace.stages) || trace.stages.length === 0) return trace;
  return { ...trace, stages: [] };
}

/**
 * Take the process view off an answer that has no recorded MLflow trace.
 *
 * The agent's `RunLog` always records local stages, even when MLflow handed
 * back a no-op span. Those stages are what made Keep in mind say "no trace"
 * while the card still drew a convincing Gantt. Figures, SQL, wall time and
 * the tool-call count stay: they are the answer and the agent's own meters.
 * The timeline does not.
 */
export function withoutUntracedProcess<
  T extends { trace: { id: string; stages?: unknown[]; totalMs?: number; toolCalls?: number } },
>(answer: T): T {
  const trace = withoutUntracedTimeline(answer.trace);
  return trace === answer.trace ? answer : { ...answer, trace };
}
