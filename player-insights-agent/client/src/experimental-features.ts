/**
 * Which unfinished surfaces this deployment offers.
 *
 * The canonical values live in Lakebase and are loaded once by the app shell.
 * Every consumer receives that same snapshot so navigation, direct routes and
 * Settings cannot disagree. Browser storage is deliberately absent: it may not
 * become the source of truth for an administrator's app-wide choice.
 */
import { NO_EXPERIMENTS, type ExperimentalFeatures } from '../../shared/experimental-settings-browser';

export { NO_EXPERIMENTS };
export type { ExperimentalFeatures };

/** Browser preference adapter retained for unrelated per-person display choices. */
export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function browserPreferenceStore(): PreferenceStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Stage one deployment-wide experiment without writing it to storage. */
export function withExperimentalFeature<K extends keyof ExperimentalFeatures>(
  features: ExperimentalFeatures,
  name: K,
  enabled: boolean
): ExperimentalFeatures {
  return { ...features, [name]: enabled };
}

/**
 * Whether Benchmarking, its scorers and its judge details are offered.
 *
 * Read by the navigation and by the `/benchmarks` route, so a pasted URL and the
 * tab cannot disagree about whether the surface exists.
 */
export function showsBenchmarkLab(features: ExperimentalFeatures): boolean {
  return features.benchmarkLab;
}

/**
 * Whether the egress panel is drawn on the Settings page.
 *
 * Governs ONE surface and no route, unlike the Benchmark Lab flag above: the
 * panel is a set of cards on a page an administrator is already on, so there is
 * no URL for this to hide and none for a bookmark to keep working. Read by the
 * page and by nothing else, because a second reader is how two surfaces come to
 * disagree about whether something exists.
 */
export function showsEgressControls(features: ExperimentalFeatures): boolean {
  return features.egressControls;
}

/** Whether Ops draws the deployment-wide forecasting scenario beneath Cost. */
export function showsForecasting(features: ExperimentalFeatures): boolean {
  return features.forecasting;
}

/** Whether Connections offers notebook selection and staged model-version apply. */
export function showsNotebookAgentSync(features: ExperimentalFeatures): boolean {
  return features.notebookAgentSync;
}
