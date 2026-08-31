/** Long enough to avoid flashing a skeleton for a warm chunk. */
export const ROUTE_SKELETON_DELAY_MS = 140;

export function scheduleRouteSkeleton(onReady: () => void): () => void {
  const timer = globalThis.setTimeout(onReady, ROUTE_SKELETON_DELAY_MS);
  return () => globalThis.clearTimeout(timer);
}
