/**
 * Small run-display formatters shared by Ask and the lazy Benchmark route.
 *
 * Kept separate from benchmark-summary so the eager Ask surface does not pull
 * the benchmark analysis, failure taxonomy, and qualification model into its
 * entry chunk just to print a duration.
 */
export function formatDuration(ms: number) {
  if (ms < 90_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
}
