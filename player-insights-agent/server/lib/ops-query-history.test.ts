import { describe, expect, it, vi } from 'vitest';

import {
  createDatabricksQueryHistoryTransport,
  readWarehouseQueryAttribution,
  type WarehouseQueryHistoryTransport,
} from './ops-query-history';

function row(id: string, executionMs: number | null, application = '') {
  return {
    query_id: id,
    warehouse_id: 'warehouse-1',
    query_tags: application ? { application, surface: 'benchmark', tool: 'genie_result' } : {},
    ...(executionMs === null ? {} : { metrics: { execution_time_ms: executionMs } }),
    // These provider fields must never appear in the aggregate returned to Ops.
    query_text: 'SELECT secret FROM private_table',
    executed_as_user_name: 'person@example.test',
  };
}

describe('Ops Query History attribution', () => {
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

    expect(result).toEqual({
      complete: true,
      astrolabeQueries: 2,
      totalQueries: 3,
      astrolabeExecutionMs: 125,
      totalExecutionMs: 200,
      genieSpaces: [],
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

    expect(result).toEqual({
      complete: true,
      astrolabeQueries: 2,
      totalQueries: 3,
      astrolabeExecutionMs: 40,
      totalExecutionMs: 60,
      genieSpaces: [],
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
});
