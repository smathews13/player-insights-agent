import { describe, expect, it, vi } from 'vitest';

import {
  createDatabricksQueryHistoryTransport,
  readWarehouseQueryAttribution as readWarehouseQueryAttributionWithEvidence,
  type WarehouseQueryHistoryTransport,
} from './ops-query-history';

const INTERACTIVE_RUNS = [{ runId: 'run-1', requestId: 'req-1', correlationId: 'corr-1' }];
function readWarehouseQueryAttribution(
  input: Omit<Parameters<typeof readWarehouseQueryAttributionWithEvidence>[0], 'interactiveRuns'>
) {
  return readWarehouseQueryAttributionWithEvidence({ ...input, interactiveRuns: INTERACTIVE_RUNS });
}

function row(id: string, executionMs: number | null, application = '') {
  return {
    query_id: id,
    warehouse_id: 'warehouse-1',
    query_tags: application ? { application, surface: 'ask', tool: 'run_sql', run_id: 'run-1' } : {},
    ...(executionMs === null ? {} : { metrics: { execution_time_ms: executionMs } }),
    // These provider fields must never appear in the aggregate returned to Ops.
    query_text: 'SELECT secret FROM private_table',
    executed_as_user_name: 'person@example.test',
  };
}

describe('Ops Query History attribution', () => {
  it('counts only completed-run Ask tags and excludes preflight, Ops, telemetry, benchmark, Genie, and unrelated SQL', async () => {
    const tagged = (id: string, surface: string, executionMs: number, extra: Record<string, unknown> = {}) => ({
      ...row(id, executionMs),
      query_tags: { application: 'Astrolabe', surface, run_id: 'run-1' },
      ...extra,
    });
    const result = await readWarehouseQueryAttribution({
      warehouseId: 'warehouse-1',
      startTimeMs: 1_000,
      endTimeMs: 2_000,
      transport: {
        listQueries: vi.fn().mockResolvedValue({
          res: [
            tagged('ask', 'ask', 30),
            tagged('preflight', 'preflight', 24),
            tagged('ops', 'ops', 236),
            tagged('telemetry', 'telemetry', 116),
            tagged('benchmark', 'benchmark', 80),
            tagged('genie', 'ask', 50, { query_source: { genie_space_id: 'space-data' } }),
            { ...row('unrelated', 200), query_tags: { application: 'Other' } },
          ],
          has_next_page: false,
        }),
      },
    });
    expect(result).toMatchObject({
      complete: true,
      astrolabeQueries: 1,
      astrolabeExecutionMs: 30,
      totalQueries: 7,
      totalExecutionMs: 736,
      askRuns: [{ runId: 'run-1', executionMs: 30 }],
    });
  });

  it('paginates the complete range and allocates only exact Astrolabe tags', async () => {
    const listQueries = vi
      .fn()
      .mockResolvedValueOnce({
        res: [row('app-1', 25, 'Astrolabe'), row('other-1', 75, 'Other')],
        next_page_token: 'page-2',
        has_next_page: true,
      })
      .mockResolvedValueOnce({
        res: [row('app-2', 100, 'Astrolabe')],
        has_next_page: false,
      });
    const result = await readWarehouseQueryAttribution({
      warehouseId: 'warehouse-1',
      startTimeMs: 1_000,
      endTimeMs: 2_000,
      transport: { listQueries },
    });

    expect(result).toMatchObject({
      complete: true,
      astrolabeQueries: 2,
      totalQueries: 3,
      astrolabeExecutionMs: 125,
      totalExecutionMs: 200,
      genieSpaces: [],
      coverage: {
        state: 'complete',
        rowsRead: 3,
        pagesRead: 2,
        chunksRead: 1,
        reasons: [],
      },
    });
    expect(listQueries).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pageToken: 'page-2', startTimeMs: 1_000, endTimeMs: 2_000 })
    );
    expect(JSON.stringify(result)).not.toMatch(/SELECT|private_table|example\.test/);
  });

  it('fails closed when the denominator lacks execution time but preserves the Astrolabe count', async () => {
    const transport: WarehouseQueryHistoryTransport = {
      listQueries: vi.fn().mockResolvedValue({
        res: [row('app-1', 25, 'Astrolabe'), row('other-1', null, 'Other')],
        has_next_page: false,
      }),
    };
    const result = await readWarehouseQueryAttribution({
      warehouseId: 'warehouse-1',
      startTimeMs: 1_000,
      endTimeMs: 2_000,
      transport,
    });

    expect(result.complete).toBe(false);
    expect(result.astrolabeQueries).toBe(1);
    expect(result.totalQueries).toBe(2);
  });

  it('fails closed on broken pagination instead of calling a partial denominator complete', async () => {
    const transport: WarehouseQueryHistoryTransport = {
      listQueries: vi.fn().mockResolvedValue({
        res: [row('app-1', 25, 'Astrolabe')],
        has_next_page: true,
      }),
    };
    const result = await readWarehouseQueryAttribution({
      warehouseId: 'warehouse-1',
      startTimeMs: 1_000,
      endTimeMs: 2_000,
      transport,
    });
    expect(result).toMatchObject({ complete: false, astrolabeQueries: 1, totalQueries: 1 });
  });

  it('requests execution metrics and the exact bounded range', async () => {
    const request = vi.fn((_options: unknown): Promise<unknown> => Promise.resolve({ res: [] }));
    const transport = createDatabricksQueryHistoryTransport({ request: (options) => request(options) });
    await transport.listQueries({
      warehouseId: 'warehouse-1',
      startTimeMs: 1_000,
      endTimeMs: 2_000,
      pageToken: 'next',
      maxResults: 999,
      signal: new AbortController().signal,
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/2.0/sql/history/queries',
        method: 'GET',
        raw: false,
        query: {
          filter_by: {
            warehouse_ids: ['warehouse-1'],
            query_start_time_range: { start_time_ms: 1_000, end_time_ms: 2_000 },
          },
          include_metrics: true,
          max_results: 999,
          page_token: 'next',
        },
      })
    );
    const called = request.mock.calls[0]?.[0] as { headers?: unknown } | undefined;
    expect(called?.headers).toBeInstanceOf(Headers);
  });

  it('splits periods longer than the Query History 30-day limit and keeps one complete denominator', async () => {
    const listQueries = vi
      .fn()
      .mockResolvedValueOnce({ res: [row('app-1', 10, 'Astrolabe')], has_next_page: false })
      .mockResolvedValueOnce({ res: [row('other-1', 20, 'Other')], has_next_page: false })
      .mockResolvedValueOnce({ res: [row('app-2', 30, 'Astrolabe')], has_next_page: false });
    const start = Date.parse('2026-06-01T00:00:00Z');
    const end = Date.parse('2026-08-14T23:59:59.999Z');

    const result = await readWarehouseQueryAttribution({
      warehouseId: 'warehouse-1',
      startTimeMs: start,
      endTimeMs: end,
      transport: { listQueries },
    });

    expect(result).toMatchObject({
      complete: true,
      astrolabeQueries: 2,
      totalQueries: 3,
      astrolabeExecutionMs: 40,
      totalExecutionMs: 60,
      genieSpaces: [],
      coverage: { state: 'complete', pagesRead: 3, chunksRead: 3, reasons: [] },
    });
    expect(listQueries).toHaveBeenCalledTimes(3);
    const first = listQueries.mock.calls[0]?.[0] as { startTimeMs: number; endTimeMs: number };
    const second = listQueries.mock.calls[1]?.[0] as { startTimeMs: number; endTimeMs: number };
    expect(second.startTimeMs).toBe(first.endTimeMs + 1);
  });

  it('falls back to query duration when execution metrics are absent', async () => {
    const result = await readWarehouseQueryAttribution({
      warehouseId: 'warehouse-1',
      startTimeMs: 1_000,
      endTimeMs: 2_000,
      transport: {
        listQueries: vi.fn().mockResolvedValue({
          res: [{ ...row('app-1', null, 'Astrolabe'), duration: 25 }],
          has_next_page: false,
        }),
      },
    });
    expect(result).toMatchObject({
      complete: true,
      astrolabeQueries: 1,
      totalQueries: 1,
      astrolabeExecutionMs: 25,
      totalExecutionMs: 25,
    });
  });

  it('separates generated SQL by Genie space and never also counts it as Astrolabe SQL', async () => {
    const genieRow = (id: string, spaceId: string, executionMs: number) => ({
      ...row(id, executionMs, 'Astrolabe'),
      query_source: { genie_space_id: spaceId },
    });
    const result = await readWarehouseQueryAttribution({
      warehouseId: 'warehouse-1',
      startTimeMs: 1_000,
      endTimeMs: 2_000,
      transport: {
        listQueries: vi.fn().mockResolvedValue({
          res: [
            genieRow('data-1', 'space-data', 20),
            genieRow('data-2', 'space-data', 30),
            genieRow('dictionary-1', 'space-dictionary', 10),
            row('app-1', 40, 'Astrolabe'),
          ],
          has_next_page: false,
        }),
      },
    });

    expect(result).toMatchObject({
      complete: true,
      astrolabeQueries: 1,
      astrolabeExecutionMs: 40,
      totalQueries: 4,
      totalExecutionMs: 100,
    });
    expect(result.genieSpaces).toEqual([
      { spaceId: 'space-data', queries: 2, executionMs: 50 },
      { spaceId: 'space-dictionary', queries: 1, executionMs: 10 },
    ]);
  });

  it('keeps only matching human actor and privilege identities for user allocation', async () => {
    const result = await readWarehouseQueryAttribution({
      warehouseId: 'warehouse-1',
      startTimeMs: 1_000,
      endTimeMs: 2_000,
      transport: {
        listQueries: vi.fn().mockResolvedValue({
          res: [
            {
              ...row('human-sql', 40, 'Astrolabe'),
              user_name: 'Person@Example.Test',
              executed_as_user_name: 'person@example.test',
            },
            {
              ...row('human-genie', 20, 'Astrolabe'),
              user_name: 'person@example.test',
              executed_as_user_name: 'person@example.test',
              query_source: { genie_space_id: 'space-data' },
            },
            {
              ...row('sp-only', 80, 'Astrolabe'),
              user_name: 'app-service-principal',
              executed_as_user_name: 'app-service-principal',
            },
            {
              ...row('mixed', 10, 'Astrolabe'),
              user_name: 'person@example.test',
              executed_as_user_name: 'app-service-principal',
            },
          ],
          has_next_page: false,
        }),
      },
    });

    expect(result.users).toEqual([
      {
        email: 'person@example.test',
        astrolabeExecutionMs: 40,
        genieSpaces: [{ spaceId: 'space-data', executionMs: 20 }],
      },
    ]);
  });

  it('stops on a repeated next-page token and returns the rows already evidenced as partial', async () => {
    const listQueries = vi.fn().mockResolvedValue({
      res: [row('same', 10, 'Astrolabe')],
      next_page_token: 'loop',
      has_next_page: true,
    });
    const result = await readWarehouseQueryAttribution({
      warehouseId: 'warehouse-1',
      startTimeMs: 1_000,
      endTimeMs: 2_000,
      transport: { listQueries },
    });

    expect(listQueries).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      complete: false,
      totalQueries: 1,
      coverage: { state: 'partial', pagesRead: 2, rowsRead: 2, reasons: ['repeated-page-token'] },
    });
  });

  it('enforces one page cap across every cursor and date chunk', async () => {
    let token = 0;
    const listQueries = vi.fn().mockImplementation(() =>
      Promise.resolve({
        res: [row(`row-${token}`, 1)],
        next_page_token: `page-${(token += 1)}`,
        has_next_page: true,
      })
    );
    const result = await readWarehouseQueryAttribution({
      warehouseId: 'warehouse-1',
      startTimeMs: 1_000,
      endTimeMs: 2_000,
      transport: { listQueries },
      maxPages: 3,
    });

    expect(listQueries).toHaveBeenCalledTimes(3);
    expect(result.coverage).toMatchObject({ state: 'partial', pagesRead: 3, reasons: ['page-cap'] });
  });

  it('uses one deadline for the operation and aborts a hanging page immediately', async () => {
    vi.useFakeTimers();
    try {
      const listQueries = vi.fn(
        ({ signal }: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
              { once: true }
            );
          })
      );
      const pending = readWarehouseQueryAttribution({
        warehouseId: 'warehouse-1',
        startTimeMs: 1_000,
        endTimeMs: 2_000,
        transport: { listQueries },
        deadlineMs: 5,
      });
      await vi.advanceTimersByTimeAsync(5);

      await expect(pending).resolves.toMatchObject({
        complete: false,
        coverage: { state: 'partial', pagesRead: 0, reasons: ['deadline'] },
      });
      expect((listQueries.mock.calls[0]?.[0] as { signal: AbortSignal }).signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops immediately when its caller aborts', async () => {
    const controller = new AbortController();
    const listQueries = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
            { once: true }
          );
        })
    );
    const pending = readWarehouseQueryAttribution({
      warehouseId: 'warehouse-1',
      startTimeMs: 1_000,
      endTimeMs: 2_000,
      transport: { listQueries },
      signal: controller.signal,
    });
    controller.abort(new Error('caller stopped'));

    await expect(pending).resolves.toMatchObject({
      complete: false,
      coverage: { state: 'partial', pagesRead: 0, reasons: ['caller-abort'] },
    });
  });

  it('clamps an all-time request to bounded chunks and never calls the older range complete', async () => {
    const now = Date.parse('2026-08-30T23:59:59.999Z');
    const listQueries = vi.fn().mockResolvedValue({ res: [], has_next_page: false });
    const result = await readWarehouseQueryAttribution({
      warehouseId: 'warehouse-1',
      startTimeMs: 0,
      endTimeMs: now,
      transport: { listQueries },
      now: () => now,
    });

    expect(result.coverage).toMatchObject({
      state: 'partial',
      pagesRead: 13,
      chunksRead: 13,
      reasons: ['range-clamped'],
    });
    expect(listQueries).toHaveBeenCalledTimes(13);
    const first = listQueries.mock.calls[0]?.[0] as { startTimeMs: number };
    expect(first.startTimeMs).toBeGreaterThan(0);
  });

  it('aggregates large pages as they arrive and retains no raw private fields in the result', async () => {
    const pages = Array.from({ length: 3 }, (_, page) =>
      Array.from({ length: 999 }, (_, index) => row(`${page}-${index}`, 1, index % 2 ? '' : 'Astrolabe'))
    );
    const listQueries = vi
      .fn()
      .mockResolvedValueOnce({ res: pages[0], next_page_token: 'two', has_next_page: true })
      .mockResolvedValueOnce({ res: pages[1], next_page_token: 'three', has_next_page: true })
      .mockResolvedValueOnce({ res: pages[2], has_next_page: false });
    const result = await readWarehouseQueryAttribution({
      warehouseId: 'warehouse-1',
      startTimeMs: 1_000,
      endTimeMs: 2_000,
      transport: { listQueries },
    });

    expect(result).toMatchObject({
      complete: true,
      totalQueries: 2_997,
      totalExecutionMs: 2_997,
      coverage: { state: 'complete', rowsRead: 2_997, pagesRead: 3 },
    });
    expect(JSON.stringify(result)).not.toMatch(/query_text|executed_as_user_name|private_table/);
  });
});
