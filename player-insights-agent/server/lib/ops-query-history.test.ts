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

  it('requests metrics and the exact bounded time range through the Workspace SDK transport', async () => {
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
});
