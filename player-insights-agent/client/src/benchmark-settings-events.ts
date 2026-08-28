export const BENCHMARK_SETTINGS_SAVED_EVENT = 'astrolabe:benchmark-settings-saved';

type BenchmarkSettingsEventTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>;

function browserTarget(): BenchmarkSettingsEventTarget | null {
  return typeof window === 'undefined' ? null : window;
}

/** Tell already-mounted Benchmark Lab readers that persisted settings changed. */
export function notifyBenchmarkSettingsSaved(target: BenchmarkSettingsEventTarget | null = browserTarget()): void {
  target?.dispatchEvent(new Event(BENCHMARK_SETTINGS_SAVED_EVENT));
}

/** Subscribe to successful saves only; staging and refused saves emit nothing. */
export function onBenchmarkSettingsSaved(
  listener: EventListener,
  target: BenchmarkSettingsEventTarget | null = browserTarget()
): () => void {
  if (!target) return () => {};
  target.addEventListener(BENCHMARK_SETTINGS_SAVED_EVENT, listener);
  return () => target.removeEventListener(BENCHMARK_SETTINGS_SAVED_EVENT, listener);
}
