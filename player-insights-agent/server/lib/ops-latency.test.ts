import { describe, expect, it } from 'vitest';

import { PERCENTILE_FLOOR } from '../../client/src/monitoring-view';
import { SPAN_PERCENTILE_FLOOR } from '../../shared/ops-contract';
import { SERVER_SPAN_KIND, buildLatencyStatement, readLatencyRows, spansTable } from './ops-telemetry';

/**
 * Per-route latency, read from the spans this codebase used to say did not exist.
 *
 * Four files asserted `otel_spans` was permanently empty and that a latency
 * panel would therefore render empty forever. None of it was measured, and all
 * of it was wrong. What these assertions hold is that the replacement does not
 * repeat the failure in the other direction: every figure here is read, the
 * window it covers is the window the rows actually span, a percentile computed
 * over too few spans is withheld rather than printed, and the prior half is
 * present so a baseline comparison can refuse a verdict when it has nothing to
 * compare against.
 */

const TABLE = 'a_catalog.a_schema.otel_spans';

describe('the statement that times the routes', () => {
  const sql = buildLatencyStatement(TABLE);

  it('counts only the spans that are this app answering a request', () => {
    expect(sql).toContain(`kind = '${SERVER_SPAN_KIND}'`);
    expect(SERVER_SPAN_KIND).toBe('SPAN_KIND_SERVER');
  });

  it('computes the duration, because the platform stores only the two ends', () => {
    expect(sql).toContain('end_time_unix_nano - start_time_unix_nano');
    expect(sql).toContain('/ 1e6');
  });

  it('is not bounded by the Ops range, and reports its real extent instead', () => {
    expect(sql).not.toContain('from_at');
    expect(sql).not.toContain('to_at');
    expect(sql).toContain("'covered'");
    expect(sql).toContain('MIN(time)');
    expect(sql).toContain('MAX(time)');
  });

  it('splits the covered window so each route can be compared to its own prior half', () => {
    expect(sql).toContain("'prior'");
    expect(sql).toContain("'current'");
    expect(sql).toContain('prior_p50');
    expect(sql).toContain('prior_spans');
  });

  it('counts HTTP 5xx from attributes as errors, never as refusals', () => {
    expect(sql).toContain('http.status_code');
    expect(sql).toContain('is_error');
    expect(sql).not.toMatch(/refus/i);
  });

  it('asks for p99 and the slowest span alongside the existing percentiles', () => {
    expect(sql).toContain('0.99');
    expect(sql).toContain('AS slowest');
    expect(sql).toContain('AS p99');
  });

  it('names the table it was given, and nothing when there is none', () => {
    expect(sql).toContain(`FROM ${TABLE}`);
    expect(spansTable('a_catalog.a_schema')).toBe(TABLE);
    expect(spansTable('')).toBe('');
  });
});

describe('reading the timings back', () => {
  /** Shaped as the warehouse returns them: eleven string columns, stacked. */
  const ROWS = [
    // kind, label, spans, p50, p95, p99, slowest, errors, last_at, prior_spans, prior_p50
    [
      'route',
      'POST /api/insights/ask',
      '8',
      '73743.9',
      '135600.2',
      '140000',
      '150000',
      '0',
      '2026-08-17 16:40:00',
      '0',
      '',
    ],
    ['route', 'GET /api/storage', '818', '0.7', '1.0', '1.2', '2.0', '3', '2026-08-17 16:43:00', '400', '0.6'],
    ['route', 'GET /api/preflight', '26', '169.9', '430.9', '500', '600', '1', '2026-08-17 16:42:00', '22', '120'],
    ['covered', '', '2026-08-16 19:30:59', '2026-08-17 16:43:41', '', '', '', '', '', '', ''],
  ];

  it('reports the window the rows actually cover', () => {
    const { coveredFrom, coveredTo } = readLatencyRows(ROWS);

    expect(coveredFrom).toBe('2026-08-16 19:30:59');
    expect(coveredTo).toBe('2026-08-17 16:43:41');
  });

  it('puts the slowest route first, which is why anybody opens this', () => {
    expect(readLatencyRows(ROWS).routes.map((entry) => entry.route)).toEqual([
      'POST /api/insights/ask',
      'GET /api/preflight',
      'GET /api/storage',
    ]);
  });

  /**
   * A 95th over eight spans is the slowest of eight wearing the name of a
   * percentile. Withheld as null -- never a zero, never the p50 repeated, both
   * of which are numbers a reader would compare against a real percentile. The
   * labelled slowest stays on the row.
   */
  it('withholds high percentiles below the floor and keeps the slowest', () => {
    const routes = readLatencyRows(ROWS).routes;
    const ask = routes.find((entry) => entry.route === 'POST /api/insights/ask');
    const preflight = routes.find((entry) => entry.route === 'GET /api/preflight');

    expect(ask).toMatchObject({
      spans: 8,
      p50Ms: 73743.9,
      p95Ms: null,
      p99Ms: null,
      slowestMs: 150000,
      priorSpans: 0,
      priorP50Ms: null,
      refusalCount: null,
    });
    expect(preflight).toMatchObject({ spans: 26, p95Ms: 430.9, p99Ms: 500, errorCount: 1 });
  });

  it('withholds at one span below the floor and reports at exactly the floor', () => {
    const under = readLatencyRows([
      ['route', 'a', String(SPAN_PERCENTILE_FLOOR - 1), '5', '9', '10', '11', '0', '', '0', ''],
    ]).routes[0];
    const at = readLatencyRows([
      ['route', 'a', String(SPAN_PERCENTILE_FLOOR), '5', '9', '10', '11', '0', '', '20', '4'],
    ]).routes[0];

    expect(under.p95Ms).toBeNull();
    expect(under.p99Ms).toBeNull();
    expect(at.p95Ms).toBe(9);
    expect(at.p99Ms).toBe(10);
    expect(at.priorP50Ms).toBe(4);
  });

  it('keeps refusals null so they cannot be summed with errors', () => {
    const storage = readLatencyRows(ROWS).routes.find((entry) => entry.route === 'GET /api/storage');
    expect(storage?.errorCount).toBe(3);
    expect(storage?.refusalCount).toBeNull();
  });

  it('establishes nothing from rows it cannot read', () => {
    expect(readLatencyRows(null)).toEqual({ routes: [], coveredFrom: '', coveredTo: '' });
    expect(readLatencyRows([['route', 'a']]).routes).toEqual([]);
  });
});

/**
 * THE TWO SURFACES MUST AGREE ABOUT WHEN A PERCENTILE IS WORTH PRINTING.
 *
 * Monitoring's floor lives in a client module and this contract is shared, so
 * the value is duplicated rather than imported. This is the assertion that
 * makes the duplication safe: the moment somebody tunes one, this fails.
 */
describe('the percentile floor', () => {
  it('is the same figure Monitoring already applies', () => {
    expect(SPAN_PERCENTILE_FLOOR).toBe(PERCENTILE_FLOOR);
  });
});
