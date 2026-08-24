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
  /** Drive one request through the middleware and report when it finished. */
  function finish(middleware: ReturnType<typeof requestLatencyRecorder>, path: string, statusCode = 200) {
    const request = { method: 'get', baseUrl: '', route: { path } } as unknown as Request;
    const response = Object.assign(new EventEmitter(), { statusCode }) as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    middleware(request, response, next);
    response.emit('finish');
    return next;
  }

  it('writes the matched route template after a response finishes', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const middleware = requestLatencyRecorder({ query });

    const next = finish(middleware, '/api/conversations/:id');
    await middleware.flush();

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
    await middleware.flush();

    expect(query).not.toHaveBeenCalled();
  });

  /*
   * The point of the batch. One INSERT per finished response put a statement on
   * a ten-connection pool for every api call the app makes, poll traffic
   * included, in front of the reads those requests were waiting on.
   */
  it('writes many finished requests as one statement', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const middleware = requestLatencyRecorder({ query });

    finish(middleware, '/api/conversations');
    finish(middleware, '/api/runs');
    finish(middleware, '/api/identity', 500);
    await middleware.flush();

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('($1, $2, $3, $4)');
    expect(sql).toContain('($9, $10, $11, $12)');
    // Every span is present and none is collapsed: three routes, and the 500 is
    // still a 500, because Ops counts errors per route off exactly these rows.
    expect(params).toHaveLength(12);
    expect(params).toContain('/api/conversations');
    expect(params).toContain('/api/runs');
    expect(params).toContain(500);
  });

  it('writes early rather than letting a burst sit unwritten', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const middleware = requestLatencyRecorder({ query }, { maxBuffered: 2 });

    finish(middleware, '/api/one');
    expect(query).not.toHaveBeenCalled();
    finish(middleware, '/api/two');

    expect(query).toHaveBeenCalledOnce();
  });

  it('does not lose or double-write a span that arrives during a write', async () => {
    let release = () => undefined as void;
    const blocked = new Promise<{ rows: [] }>((resolve) => {
      release = () => resolve({ rows: [] });
    });
    const query = vi.fn().mockReturnValueOnce(blocked).mockResolvedValue({ rows: [] });
    const middleware = requestLatencyRecorder({ query });

    finish(middleware, '/api/first');
    const writing = middleware.flush();
    // Arrives while the first statement is still in flight. The reset inside
    // flush must not take this one with it.
    finish(middleware, '/api/second');
    release();
    await writing;

    await middleware.flush();
    expect(query).toHaveBeenCalledTimes(2);
    expect((query.mock.calls[1] as [string, unknown[]])[1]).toContain('/api/second');
  });

  it('says how many spans were lost when the write fails, rather than one line per span', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const query = vi.fn().mockRejectedValue(new Error('pool exhausted'));
    const middleware = requestLatencyRecorder({ query });

    finish(middleware, '/api/one');
    finish(middleware, '/api/two');
    await middleware.flush();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('2 request latency span(s)');
    warn.mockRestore();
  });
});
