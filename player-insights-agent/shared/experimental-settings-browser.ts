/**
 * Browser-safe Experimental settings contract.
 *
 * Layout imports this on the initial Ask path, so this module deliberately has
 * no runtime dependency. The Zod schemas live in experimental-settings.ts and
 * are imported only by the server and lazy Settings code.
 */
export interface ExperimentalFeatures {
  aiGateway: boolean;
  benchmarkLab: boolean;
  egressControls: boolean;
  forecasting: boolean;
  genieCodeMcp?: boolean;
  notebookAgentSync: boolean;
}

export const EXPERIMENTAL_FEATURE_KEYS = [
  'aiGateway',
  'benchmarkLab',
  'egressControls',
  'forecasting',
  'genieCodeMcp',
  'notebookAgentSync',
] as const;

export const NO_EXPERIMENTS: Readonly<ExperimentalFeatures> = {
  aiGateway: false,
  benchmarkLab: false,
  egressControls: false,
  forecasting: false,
  genieCodeMcp: false,
  notebookAgentSync: false,
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
      aiGateway: settings.aiGateway === true,
      benchmarkLab: settings.benchmarkLab === true,
      egressControls: settings.egressControls === true,
      forecasting: settings.forecasting === true,
      genieCodeMcp: settings.genieCodeMcp === true,
      notebookAgentSync: settings.notebookAgentSync === true,
    },
    revision: Number(revision),
  };
}
