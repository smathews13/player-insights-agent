import type { BrandProduct } from './brand-icons';

export type HealthResourceIconSpec =
  | { type: 'brand'; product: BrandProduct }
  | { type: 'table' }
  | { type: 'resource' };

const brand = (product: BrandProduct): HealthResourceIconSpec => ({ type: 'brand', product });
const table: HealthResourceIconSpec = { type: 'table' };
const resource: HealthResourceIconSpec = { type: 'resource' };

/**
 * The icon for every resource kind Ops Health understands.
 *
 * Keep aliases here as wire/config decoders evolve. The fallback is deliberately
 * visible: an unfamiliar kind is still a resource, never an accidental blank.
 */
const HEALTH_RESOURCE_ICONS: Readonly<Record<string, HealthResourceIconSpec>> = {
  'sql-warehouse': brand('databricks-sql'),
  'genie-space': brand('genie'),
  catalog: brand('unity-catalog'),
  schema: brand('unity-catalog'),
  table: brand('unity-catalog'),
  'serving-endpoint': brand('mosaic-ai'),
  'vector-index': brand('mosaic-ai'),
  'vector-endpoint': brand('mosaic-ai'),
  app: brand('apps'),
  lakebase: brand('lakebase'),

  // MLflow has appeared under each of these names across configuration,
  // health-probe, and workspace-link contracts.
  observability: brand('mlflow'),
  mlflow: brand('mlflow'),
  experiment: brand('mlflow'),
  'experiment-id': brand('mlflow'),
  'mlflow-experiment': brand('mlflow'),

  // The Health view rolls individual table probes into this configured row.
  manifest: table,
  'declared-manifest': table,
  'declared-tables': table,
};

/** Canonical kinds emitted by the current Ops Health payload. */
export const KNOWN_HEALTH_RESOURCE_KINDS = [
  'sql-warehouse',
  'genie-space',
  'catalog',
  'schema',
  'table',
  'serving-endpoint',
  'vector-index',
  'vector-endpoint',
  'app',
  'lakebase',
  'observability',
  'manifest',
] as const;

function normalizedKind(kind: string): string {
  return kind.trim().toLowerCase().replaceAll('_', '-');
}

export function healthResourceIconSpec(kind: string): HealthResourceIconSpec {
  return HEALTH_RESOURCE_ICONS[normalizedKind(kind)] ?? resource;
}
