import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

import {
  readRequestLatencyRows,
  REQUEST_LATENCY_QUERY,
  requestLatencyRecorder,
} from './request-latency';

describe('the Lakebase route latency query', () => {
  it('groups by the full method and canonical route instead of collapsing distinct routes', () => {
    expect(REQUEST_LATENCY_QUERY).toContain("CONCAT(r.method, ' ', r.route) AS route");
    expect(REQUEST_LATENCY_QUERY).toContain('GROUP BY s.route');
    expect(REQUEST_LATENCY_QUERY).not.toContain('/api/insights/ask');
  });

  it('splits all recorded requests into two halves without date bounds', () => {
    expect(REQUEST_LATENCY_QUERY).toContain('MIN(recorded_at)');
    expect(REQUEST_LATENCY_QUERY).toContain('MAX(recorded_at)');
    expect(REQUEST_LATENCY_QUERY).not.toMatch(/\$[12]|from_at|to_at/);
  });

  it('ends the CTE list before the result SELECT', () => {
    expect(REQUEST_LATENCY_QUERY).toMatch(/\)\s+SELECT r\.\*, b\.covered_from, b\.covered_to/);
    expect(REQUEST_LATENCY_QUERY).not.toMatch(/\),\s+SELECT/);
  });

  it('returns one row for every recorded route', () => {
    const common = {
      current_count: 4,
      current_p50_ms: 20,
      current_p95_ms: 30,
      current_p99_ms: 35,
      slowest_ms: 40,
      error_count: 0,
      last_request_at: new Date('2026-08-20T20:00:00Z'),
      prior_count: 3,
      prior_p50_ms: 18,
      covered_from: new Date('2026-08-20T19:00:00Z'),
      covered_to: new Date('2026-08-20T20:00:00Z'),
    };

    const measured = readRequestLatencyRows([
      { ...common, route: 'GET /api/identity' },
      { ...common, route: 'POST /api/feedback', current_p50_ms: 25 },
      { ...common, route: 'GET /api/conversations/:id', current_p50_ms: 5 },
    ]);

    expect(measured.routes.map((row) => row.route)).toEqual([
      'POST /api/feedback',
      'GET /api/identity',
      'GET /api/conversations/:id',
    ]);
  });

  it('reports an honestly empty window without manufacturing routes', () => {
    expect(readRequestLatencyRows([])).toEqual({ routes: [], coveredFrom: '', coveredTo: '' });
  });
});

describe('the shared request recorder', () => {
  it('writes the matched route template after a response finishes', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const middleware = requestLatencyRecorder({ query });
    const request = {
      method: 'get',
      baseUrl: '',
      route: { path: '/api/conversations/:id' },
    } as unknown as Request;
    const response = Object.assign(new EventEmitter(), { statusCode: 200 }) as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    middleware(request, response, next);
    response.emit('finish');
    await Promise.resolve();

    expect(next).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO'),
      expect.arrayContaining(['GET', '/api/conversations/:id', 200])
    );
  });

  it('does not record static assets or unmatched raw URLs', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const middleware = requestLatencyRecorder({ query });
    const response = Object.assign(new EventEmitter(), { statusCode: 200 }) as unknown as Response;

    middleware(
      { method: 'GET', originalUrl: '/assets/app.js' } as unknown as Request,
      response,
      vi.fn() as unknown as NextFunction
    );
    response.emit('finish');
    await Promise.resolve();

    expect(query).not.toHaveBeenCalled();
  });
});
