export const ACTIVITY_HEARTBEAT_INTERVAL_MS = 30_000;
export const ACTIVITY_HEARTBEAT_PATH = '/api/activity/heartbeat';

type VisibleDocument = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

/**
 * Observe app activity only while the page is visible.
 *
 * The request has no body. The server derives identity from Databricks Apps
 * authentication and deduplicates retries and multiple tabs by user/minute.
 */
export function startActivityHeartbeat(
  documentRef: VisibleDocument = document,
  fetchImpl: typeof fetch = fetch,
  timers: Pick<typeof globalThis, 'setInterval' | 'clearInterval'> = globalThis
): () => void {
  const heartbeat = () => {
    if (documentRef.visibilityState !== 'visible') return;
    void fetchImpl(ACTIVITY_HEARTBEAT_PATH, {
      method: 'POST',
      keepalive: true,
    }).catch(() => {
      // Activity is optional telemetry. It must never interrupt the app.
    });
  };

  heartbeat();
  documentRef.addEventListener('visibilitychange', heartbeat);
  const interval = timers.setInterval(heartbeat, ACTIVITY_HEARTBEAT_INTERVAL_MS);

  return () => {
    documentRef.removeEventListener('visibilitychange', heartbeat);
    timers.clearInterval(interval);
  };
}
