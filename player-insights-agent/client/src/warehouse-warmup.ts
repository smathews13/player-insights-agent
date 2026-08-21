/**
 * Ask the server to wake this deployment's SQL warehouse as soon as the app
 * paints.
 *
 * This intentionally returns nothing. The opening animation and login gate must
 * never wait for compute, and a failed warm-up must never become a failed login.
 */
export type WarehouseWarmupFetch = (
  input: string,
  init: { method: 'POST' }
) => Promise<unknown>;

export function kickWarehouseWarmup(fetcher: WarehouseWarmupFetch = fetch): void {
  void fetcher('/api/warehouse-warmup', { method: 'POST' }).catch(() => undefined);
}
