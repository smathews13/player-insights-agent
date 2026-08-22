import { describe, expect, it, vi } from 'vitest';

import { createGenieWarehouseWarmup } from './genie-warehouse-warmup';

const HOST = 'https://workspace.example.com';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('adopted Genie warehouse warm-up', () => {
  it('discovers and starts each distinct non-app warehouse under the signed-in user token', async () => {
    const call = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/genie/spaces/data')) return response({ warehouse_id: 'customer-warehouse' });
      if (url.endsWith('/genie/spaces/dictionary')) return response({ warehouse_id: 'customer-warehouse' });
      if (url.endsWith('/sql/warehouses/customer-warehouse')) return response({ state: 'STOPPED' });
      if (url.endsWith('/sql/warehouses/customer-warehouse/start')) return response({});
      throw new Error(`unexpected ${url} ${init?.method}`);
    });
    const warmup = createGenieWarehouseWarmup({
      fetchImpl: call as typeof fetch,
      cooldownMs: 60_000,
    });

    const outcomes = await warmup.warm({
      host: HOST,
      token: 'reader-token',
      spaceIds: ['data', 'dictionary'],
      appWarehouseId: 'app-warehouse',
    });

    expect(outcomes).toContainEqual({
      kind: 'started',
      warehouseId: 'customer-warehouse',
      spaceIds: ['data', 'dictionary'],
      from: 'STOPPED',
    });
    expect(call.mock.calls.filter(([url]) => String(url).endsWith('/customer-warehouse/start'))).toHaveLength(1);
    expect(call.mock.calls.every(([, init]) => init?.headers && JSON.stringify(init.headers).includes('reader-token'))).toBe(
      true
    );
  });

  it('leaves the app warehouse to the existing service-principal warm-up', async () => {
    const call = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/genie/spaces/data')) return response({ warehouse_id: 'app-warehouse' });
      throw new Error(`unexpected ${String(input)}`);
    });
    const warmup = createGenieWarehouseWarmup({ fetchImpl: call as typeof fetch });

    const outcomes = await warmup.warm({
      host: HOST,
      token: 'reader-token',
      spaceIds: ['data'],
      appWarehouseId: 'app-warehouse',
    });

    expect(outcomes).toContainEqual({
      kind: 'app-warehouse',
      warehouseId: 'app-warehouse',
      spaceIds: ['data'],
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('swallows permission failures and cools down repeated arrival attempts', async () => {
    let now = 1_000;
    const call = vi.fn(async () => response({ message: 'forbidden' }, 403));
    const warmup = createGenieWarehouseWarmup({
      fetchImpl: call as typeof fetch,
      now: () => now,
      cooldownMs: 60_000,
    });
    const input = {
      host: HOST,
      token: 'reader-token',
      spaceIds: ['data'],
      appWarehouseId: 'app-warehouse',
    };

    expect(await warmup.warm(input)).toContainEqual({
      kind: 'failed',
      spaceId: 'data',
      at: 'space',
      message: 'workspace returned HTTP 403',
    });
    now += 1_000;
    expect(await warmup.warm(input)).toEqual([{ kind: 'cooling-down', spaceId: 'data' }]);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
