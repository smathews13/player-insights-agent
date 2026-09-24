/**
 * Ask the server to wake this deployment's SQL warehouse as soon as the app
 * paints.
 *
 * This intentionally returns nothing. The opening animation and login gate must
 * never wait for compute, and a failed warm-up must never become a failed login.
 */
export type WarehouseWarmupFetch = (input: string, init: { method: 'POST' }) => Promise<unknown>;

export function kickWarehouseWarmup(fetcher: WarehouseWarmupFetch = fetch): void {
  void fetcher('/api/warehouse-warmup', { method: 'POST' }).catch(() => undefined);
}

/** Wait for an explicit Ask to have runnable compute before its timer starts. */
export async function waitForWarehouseReady(fetcher: WarehouseWarmupFetch = fetch): Promise<boolean> {
  try {
    const response = (await fetcher('/api/warehouse-ready', { method: 'POST' })) as { ok?: boolean };
    return response.ok !== false;
  } catch {
    // Readiness is an optimization boundary, not permission to discard a question.
    return false;
  }
}
