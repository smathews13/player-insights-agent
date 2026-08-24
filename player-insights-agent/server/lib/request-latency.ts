import type { NextFunction, Request, Response } from 'express';

import { APP_SCHEMA } from '../../shared/app-schema';
import { SPAN_PERCENTILE_FLOOR, type RouteLatency } from '../../shared/ops-contract';

/** Durable, app-owned request timings. Customer deployments do not need OTEL. */
export const REQUEST_LATENCY_TABLE = `${APP_SCHEMA}.request_latencies`;

export const REQUEST_LATENCY_DDL = `CREATE TABLE IF NOT EXISTS ${REQUEST_LATENCY_TABLE} (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  duration_ms DOUBLE PRECISION NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

export const REQUEST_LATENCY_INDEX_DDL = `CREATE INDEX IF NOT EXISTS request_latencies_recorded_route_idx
  ON ${REQUEST_LATENCY_TABLE} (recorded_at DESC, method, route)`;

/**
 * One row per canonical Express route in the requested window.
 *
 * Route templates (`/api/conversations/:id`) are stored instead of concrete
 * URLs, so IDs do not create a separate row and distinct route templates cannot
 * collapse into one. The selected window is split in half exactly as the panel
 * says: the later half is current and the earlier half is the route's baseline.
 */
export const REQUEST_LATENCY_QUERY = `
  WITH coverage AS (
    SELECT MIN(recorded_at) AS covered_from,
           MAX(recorded_at) AS covered_to
    FROM ${REQUEST_LATENCY_TABLE}
  ),
  bounds AS (
    SELECT covered_from,
           covered_to,
           covered_from + ((covered_to - covered_from) / 2) AS split_at
    FROM coverage
  ),
  samples AS (
    SELECT CONCAT(r.method, ' ', r.route) AS route,
           r.duration_ms,
           r.status_code,
           r.recorded_at,
           b.split_at
    FROM ${REQUEST_LATENCY_TABLE} r, bounds b
  ),
  routes AS (
    SELECT
      s.route,
      COUNT(*) FILTER (WHERE s.recorded_at >= s.split_at)::int AS current_count,
      ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY s.duration_ms)
        FILTER (WHERE s.recorded_at >= s.split_at))::int AS current_p50_ms,
      ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY s.duration_ms)
        FILTER (WHERE s.recorded_at >= s.split_at))::int AS current_p95_ms,
      ROUND(percentile_cont(0.99) WITHIN GROUP (ORDER BY s.duration_ms)
        FILTER (WHERE s.recorded_at >= s.split_at))::int AS current_p99_ms,
      ROUND(MAX(s.duration_ms) FILTER (WHERE s.recorded_at >= s.split_at))::int AS slowest_ms,
      COUNT(*) FILTER (WHERE s.recorded_at >= s.split_at AND s.status_code >= 500)::int AS error_count,
      MAX(s.recorded_at) FILTER (WHERE s.recorded_at >= s.split_at) AS last_request_at,
      COUNT(*) FILTER (WHERE s.recorded_at < s.split_at)::int AS prior_count,
      ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY s.duration_ms)
        FILTER (WHERE s.recorded_at < s.split_at))::int AS prior_p50_ms
    FROM samples s
    GROUP BY s.route
    HAVING COUNT(*) FILTER (WHERE s.recorded_at >= s.split_at) > 0
  )
  SELECT r.*, b.covered_from, b.covered_to
  FROM routes r CROSS JOIN bounds b
  ORDER BY r.current_p50_ms DESC NULLS LAST, r.route`;

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return '';
}

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Convert route aggregates without merging or manufacturing rows. */
export function readRequestLatencyRows(rows: readonly Record<string, unknown>[]): {
  routes: RouteLatency[];
  coveredFrom: string;
  coveredTo: string;
} {
  const routes: RouteLatency[] = [];
  let coveredFrom = '';
  let coveredTo = '';
  for (const row of rows) {
    const route = text(row.route).trim();
    const spans = count(row.current_count);
    if (!route || spans <= 0) continue;
    coveredFrom ||= text(row.covered_from);
    coveredTo ||= text(row.covered_to);
    const priorSpans = count(row.prior_count);
    routes.push({
      route,
      spans,
      p50Ms: count(row.current_p50_ms),
      p95Ms: spans >= SPAN_PERCENTILE_FLOOR ? count(row.current_p95_ms) : null,
      p99Ms: spans >= SPAN_PERCENTILE_FLOOR ? count(row.current_p99_ms) : null,
      slowestMs: count(row.slowest_ms),
      errorCount: count(row.error_count),
      refusalCount: null,
      lastSpanAt: text(row.last_request_at),
      priorSpans,
      priorP50Ms: row.prior_p50_ms === null || priorSpans === 0 ? null : count(row.prior_p50_ms),
    });
  }
  routes.sort((left, right) => right.p50Ms - left.p50Ms || left.route.localeCompare(right.route));
  return { routes, coveredFrom, coveredTo };
}

type RequestLatencyStore = {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

/** Express types `route` as any, so narrow it before reading the matched path. */
function matchedRoutePath(req: Request): string {
  const matched: unknown = req.route;
  if (!matched || typeof matched !== 'object') return '';
  const path: unknown = Reflect.get(matched, 'path');
  return typeof path === 'string' ? path : '';
}

/** One finished request, waiting to be written with the others. */
type LatencySpan = [method: string, route: string, statusCode: number, durationMs: number];

/** How long a span may sit in memory before it is written. */
const FLUSH_MS = 2_000;
/** Write early rather than let a burst sit unwritten; also caps a single statement. */
const MAX_BUFFERED = 100;

export interface RequestLatencyRecorder {
  (req: Request, res: Response, next: NextFunction): void;
  /** Write whatever is buffered right now. For shutdown, and for tests. */
  flush(): Promise<void>;
}

/**
 * Record how long each matched API route took, in batches.
 *
 * Only matched API route templates are recorded; raw URLs and static assets are
 * not, so `/assets/app.js` and a 404 on an unrouted path write nothing.
 *
 * WHY THIS BATCHES. It used to run one INSERT per finished response, on a pool
 * capped at ten connections, for EVERY api call the app makes -- including the
 * poll traffic from open admin tabs. The write is fire-and-forget so it never
 * blocked an answer, but under a poll storm it still put one statement per
 * request in front of the reads those same requests were waiting on. Spans are
 * now collected and written together, which turns a hundred statements into one.
 *
 * WHY NOT SAMPLING, which is the other obvious answer. Ops reports a span COUNT
 * and an error count per route beside the percentiles, and it labels what it
 * shows with how good the figure is. Percentiles survive sampling; counts do
 * not, and a tenth of the errors presented as the errors would be this surface
 * telling a reader something untrue about their deployment. Batching costs the
 * same write amplification and costs no fidelity.
 *
 * WHAT IS GIVEN UP is the couple of seconds of spans a process holds when it
 * dies unexpectedly. That is the right trade for latency telemetry -- and it is
 * why the window is two seconds rather than a minute -- but it is a real loss,
 * so `flush` is exposed for a shutdown path to call.
 */
export function requestLatencyRecorder(
  store: RequestLatencyStore,
  { flushMs = FLUSH_MS, maxBuffered = MAX_BUFFERED }: { flushMs?: number; maxBuffered?: number } = {}
): RequestLatencyRecorder {
  let buffered: LatencySpan[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffered.length === 0) return;
    // Taken before the await so spans arriving during the write join the next
    // batch rather than being dropped by the reset, or written twice.
    const writing = buffered;
    buffered = [];

    const values = writing
      .map((_, index) => {
        const at = index * 4;
        return `($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4})`;
      })
      .join(', ');

    try {
      await store.query(
        `INSERT INTO ${REQUEST_LATENCY_TABLE} (method, route, status_code, duration_ms)
           VALUES ${values}`,
        writing.flat()
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[ops] ${writing.length} request latency span(s) were not recorded: ${reason}`);
    }
  };

  const record = (span: LatencySpan): void => {
    buffered.push(span);
    if (buffered.length >= maxBuffered) {
      void flush();
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushMs);
    // A pending batch of telemetry is not a reason to keep the process alive.
    timer.unref?.();
  };

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    res.once('finish', () => {
      const path = matchedRoutePath(req);
      if (!path.startsWith('/api/')) return;
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      record([req.method.toUpperCase(), `${req.baseUrl || ''}${path}`, res.statusCode, durationMs]);
    });
    next();
  };

  return Object.assign(middleware, { flush });
}
