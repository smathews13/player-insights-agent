import type { EnvironmentInfo } from '../../shared/environment-info';

/**
 * Normalize the endpoint at the component boundary.
 *
 * The Settings panel must survive an older server, an empty JSON body shape, or
 * partially populated runtime metadata. Type assertions do not make those
 * network values complete at runtime.
 */
export function environmentInfoFromResponse(value: unknown): EnvironmentInfo {
  const payload = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const runtime =
    payload.runtime && typeof payload.runtime === 'object' ? (payload.runtime as Record<string, unknown>) : {};
  const variables = Array.isArray(payload.variables) ? payload.variables : [];
  const packages = Array.isArray(payload.packages) ? payload.packages : [];
  return {
    runtime: {
      python: typeof runtime.python === 'string' ? runtime.python : '',
      node: typeof runtime.node === 'string' ? runtime.node : '',
    },
    variables: variables.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const candidate = row as Record<string, unknown>;
      return typeof candidate.key === 'string' && typeof candidate.value === 'string'
        ? [{ key: candidate.key, value: candidate.value }]
        : [];
    }),
    packages: packages.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const candidate = row as Record<string, unknown>;
      return typeof candidate.name === 'string' && typeof candidate.version === 'string'
        ? [{ name: candidate.name, version: candidate.version }]
        : [];
    }),
  };
}
