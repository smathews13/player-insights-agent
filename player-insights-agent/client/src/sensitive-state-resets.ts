type SensitiveStateReset = () => void;

const resets = new Set<SensitiveStateReset>();

/**
 * Register a reset only when a lazy feature has actually loaded.
 *
 * The app-session boundary imports this tiny registry, not every lazy feature
 * cache. That keeps Connections, Monitoring, and their migration code out of
 * the initial Ask bundle while still clearing them on sign-out or timeout.
 */
export function registerSensitiveStateReset(reset: SensitiveStateReset): () => void {
  resets.add(reset);
  return () => resets.delete(reset);
}

export function resetRegisteredSensitiveState(): void {
  for (const reset of [...resets]) reset();
}
