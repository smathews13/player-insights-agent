import { warehouseStartPath, warehouseStatePath } from './warehouse-warmup';
import { ExpiringLruCache } from './expiring-lru';

export const GENIE_WARMUP_COOLDOWN_MS = 60_000;
export const GENIE_WARMUP_TIMEOUT_MS = 10_000;
export const GENIE_WARMUP_CACHE_MAX_ENTRIES = 2_048;

type FetchLike = typeof fetch;

export type GenieWarehouseWarmupOutcome =
  | { kind: 'started'; warehouseId: string; spaceIds: readonly string[]; from: string }
  | { kind: 'already-warm'; warehouseId: string; spaceIds: readonly string[]; state: string }
  | { kind: 'app-warehouse'; warehouseId: string; spaceIds: readonly string[] }
  | { kind: 'cooling-down'; spaceId: string }
  | { kind: 'failed'; spaceId: string; at: 'space' | 'state' | 'start'; message: string };

export interface GenieWarehouseWarmup {
  warm(input: {
    host: string;
    token: string;
    subject: string;
    spaceIds: readonly string[];
    appWarehouseId: string;
  }): Promise<readonly GenieWarehouseWarmupOutcome[]>;
}

const ALREADY_WARM = new Set(['RUNNING', 'STARTING']);
const NOTHING_TO_WARM = new Set(['DELETING', 'DELETED']);

function messageOf(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

async function jsonRequest(
  call: FetchLike,
  url: string,
  token: string,
  method: 'GET' | 'POST',
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const response = await call(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: '{}' } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`workspace returned HTTP ${response.status}`);
  return ((await response.json()) ?? {}) as Record<string, unknown>;
}

/**
 * Warm warehouses selected by adopted Genie spaces under the arriving reader.
 *
 * The app service principal is intentionally not granted access to customer
 * Genie warehouses. The signed-in reader already needs CAN RUN on the space and
 * CAN USE on its warehouse to ask a question, so the same short-lived token is
 * the only identity that can safely discover and start that compute.
 */
export function createGenieWarehouseWarmup(
  options: {
    fetchImpl?: FetchLike;
    now?: () => number;
    cooldownMs?: number;
    timeoutMs?: number;
    maxEntries?: number;
  } = {}
): GenieWarehouseWarmup {
  const call = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? GENIE_WARMUP_COOLDOWN_MS;
  const timeoutMs = options.timeoutMs ?? GENIE_WARMUP_TIMEOUT_MS;
  const lastAttempt = new ExpiringLruCache<true>(options.maxEntries ?? GENIE_WARMUP_CACHE_MAX_ENTRIES, cooldownMs);

  return {
    async warm({ host, token, subject, spaceIds, appWarehouseId }) {
      const base = host.replace(/\/+$/, '');
      const reader = subject.trim().toLowerCase();
      if (!base || !token || !reader) return [];

      const outcomes: GenieWarehouseWarmupOutcome[] = [];
      const warehouses = new Map<string, string[]>();
      await Promise.all(
        [...new Set(spaceIds.filter(Boolean))].map(async (spaceId) => {
          const key = `${reader}\u0000${base}\u0000${spaceId}`;
          const checkedAt = now();
          if (lastAttempt.get(key, checkedAt)) {
            outcomes.push({ kind: 'cooling-down', spaceId });
            return;
          }
          lastAttempt.set(key, true, checkedAt);
          try {
            const space = await jsonRequest(
              call,
              `${base}/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}`,
              token,
              'GET',
              timeoutMs
            );
            const warehouseId = typeof space.warehouse_id === 'string' ? space.warehouse_id.trim() : '';
            if (!warehouseId) {
              outcomes.push({ kind: 'failed', spaceId, at: 'space', message: 'space reported no warehouse' });
              return;
            }
            warehouses.set(warehouseId, [...(warehouses.get(warehouseId) ?? []), spaceId].sort());
          } catch (error) {
            outcomes.push({ kind: 'failed', spaceId, at: 'space', message: messageOf(error) });
          }
        })
      );

      await Promise.all(
        [...warehouses].map(async ([warehouseId, resolvedSpaces]) => {
          if (warehouseId === appWarehouseId) {
            outcomes.push({ kind: 'app-warehouse', warehouseId, spaceIds: resolvedSpaces });
            return;
          }
          let state = '';
          try {
            const body = await jsonRequest(call, `${base}${warehouseStatePath(warehouseId)}`, token, 'GET', timeoutMs);
            state = typeof body.state === 'string' ? body.state.trim().toUpperCase() : '';
            if (!state) throw new Error('warehouse reported no state');
          } catch (error) {
            outcomes.push({
              kind: 'failed',
              spaceId: resolvedSpaces.join(','),
              at: 'state',
              message: messageOf(error),
            });
            return;
          }
          if (ALREADY_WARM.has(state) || NOTHING_TO_WARM.has(state)) {
            outcomes.push({ kind: 'already-warm', warehouseId, spaceIds: resolvedSpaces, state });
            return;
          }
          try {
            await jsonRequest(call, `${base}${warehouseStartPath(warehouseId)}`, token, 'POST', timeoutMs);
            outcomes.push({ kind: 'started', warehouseId, spaceIds: resolvedSpaces, from: state });
          } catch (error) {
            outcomes.push({
              kind: 'failed',
              spaceId: resolvedSpaces.join(','),
              at: 'start',
              message: messageOf(error),
            });
          }
        })
      );
      return outcomes;
    },
  };
}
