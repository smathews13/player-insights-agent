/**
 * Browser-safe Experimental settings contract.
 *
 * Layout imports this on the initial Ask path, so this module deliberately has
 * no runtime dependency. The Zod schemas live in experimental-settings.ts and
 * are imported only by the server and lazy Settings code.
 */
export interface ExperimentalFeatures {
  benchmarkLab: boolean;
  egressControls: boolean;
  forecasting: boolean;
}

export const EXPERIMENTAL_FEATURE_KEYS = ['benchmarkLab', 'egressControls', 'forecasting'] as const;

export const NO_EXPERIMENTS: Readonly<ExperimentalFeatures> = {
  benchmarkLab: false,
  egressControls: false,
  forecasting: false,
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Decode the complete server response shape Layout needs.
 *
 * Exact booleans and a nonnegative integer are the full contract. Unknown
 * response fields are ignored for forward compatibility. Missing known flags
 * default off, matching the authoritative server schema for legacy rows.
 */
export function decodeExperimentalSettingsDocument(
  value: unknown
): { settings: ExperimentalFeatures; revision: number } | null {
  const document = record(value);
  const settings = record(document?.settings);
  const revision = document?.revision;
  if (
    !settings ||
    !EXPERIMENTAL_FEATURE_KEYS.every((key) => settings[key] === undefined || typeof settings[key] === 'boolean') ||
    !Number.isInteger(revision) ||
    Number(revision) < 0
  ) {
    return null;
  }
  return {
    settings: {
      benchmarkLab: settings.benchmarkLab === true,
      egressControls: settings.egressControls === true,
      forecasting: settings.forecasting === true,
    },
    revision: Number(revision),
  };
}
