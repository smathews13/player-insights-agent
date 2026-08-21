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
  ),
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

/** Only matched API route templates are recorded; raw URLs and static assets are not. */
export function requestLatencyRecorder(store: RequestLatencyStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    res.once('finish', () => {
      const path = matchedRoutePath(req);
      if (!path.startsWith('/api/')) return;
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      void store
        .query(
          `INSERT INTO ${REQUEST_LATENCY_TABLE} (method, route, status_code, duration_ms)
           VALUES ($1, $2, $3, $4)`,
          [req.method.toUpperCase(), `${req.baseUrl || ''}${path}`, res.statusCode, durationMs]
        )
        .catch((error: Error) => {
          console.warn(`[ops] Request latency was not recorded for ${req.method} ${path}: ${error.message}`);
        });
    });
    next();
  };
}
