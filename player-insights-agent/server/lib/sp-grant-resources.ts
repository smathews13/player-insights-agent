import type { ResourceKind } from '../../shared/deployment-config';
import type { SpGrantResource, SpGrantResourceType } from '../../shared/sp-identity';
import type { LakebaseReader } from './lakebase-store';
import { readDeclaredConnections } from './declared-connections';

interface Candidate {
  type: SpGrantResourceType;
  id: string;
  label: string;
  source: SpGrantResource['source'];
}

function candidate(
  type: SpGrantResourceType,
  id: string | undefined,
  label: string,
  source: SpGrantResource['source'] = 'configured'
): Candidate | null {
  const value = id?.trim() ?? '';
  return value ? { type, id: value, label, source } : null;
}

function unityCatalogType(value: string): SpGrantResourceType | null {
  const parts = value.split('.');
  if (parts.length === 1) return 'CATALOG';
  if (parts.length === 2) return 'SCHEMA';
  if (parts.length === 3) return 'TABLE';
  return null;
}

export function declaredGrantResourceType(input: {
  kind: ResourceKind;
  id: string;
  label: string;
  value: string;
}): SpGrantResourceType | null {
  switch (input.kind) {
    case 'agent':
    case 'model':
      return 'SERVING_ENDPOINT';
    case 'genie-space':
      return 'GENIE_SPACE';
    case 'sql-warehouse':
      return 'SQL_WAREHOUSE';
    case 'unity-catalog':
      return unityCatalogType(input.value);
    case 'volume':
      return 'VOLUME';
    case 'vector-search':
      return /endpoint/i.test(`${input.id} ${input.label}`) ? 'VECTOR_SEARCH_ENDPOINT' : 'VECTOR_SEARCH_INDEX';
    default:
      return null;
  }
}

/**
 * Resource identifiers already declared by the deployment or Connections.
 * Secret references, OAuth material, and tokens are not inputs to this list.
 */
export async function discoverSpGrantResources(
  client: LakebaseReader,
  env: NodeJS.ProcessEnv = process.env
): Promise<SpGrantResource[]> {
  const configured: Array<Candidate | null> = [
    candidate('SERVING_ENDPOINT', env.DATABRICKS_SERVING_ENDPOINT_NAME, 'Orchestrator serving endpoint'),
    candidate('SERVING_ENDPOINT', env.PLAYER_INSIGHTS_LLM_ENDPOINT, 'Foundation model endpoint'),
    candidate('SERVING_ENDPOINT', env.PLAYER_INSIGHTS_JUDGE_ENDPOINT, 'Benchmark judge endpoint'),
    candidate('SQL_WAREHOUSE', env.DATABRICKS_SQL_WAREHOUSE_ID, 'SQL warehouse'),
    candidate('CATALOG', env.PLAYER_INSIGHTS_CATALOG, 'App catalog'),
    candidate(
      'SCHEMA',
      env.PLAYER_INSIGHTS_CATALOG && env.PLAYER_INSIGHTS_SCHEMA
        ? `${env.PLAYER_INSIGHTS_CATALOG}.${env.PLAYER_INSIGHTS_SCHEMA}`
        : undefined,
      'App schema'
    ),
    candidate('GENIE_SPACE', env.PLAYER_INSIGHTS_DATA_GENIE_ID, 'Data Genie space'),
    candidate('GENIE_SPACE', env.PLAYER_INSIGHTS_DICTIONARY_GENIE_ID, 'Dictionary Genie space'),
    candidate(
      'VECTOR_SEARCH_INDEX',
      env.PLAYER_INSIGHTS_SEMANTIC_INDEX === 'true' ? undefined : env.PLAYER_INSIGHTS_SEMANTIC_INDEX,
      'Vector Search index'
    ),
  ];
  const declared = await readDeclaredConnections(client);
  const rows: Candidate[] = configured.filter((entry): entry is Candidate => Boolean(entry));
  for (const entry of declared) {
    if (entry.state !== 'declared') continue;
    const type = declaredGrantResourceType(entry);
    if (!type) continue;
    rows.push({ type, id: entry.value.trim(), label: entry.label || entry.value, source: 'declared' });
  }
  const unique = new Map<string, SpGrantResource>();
  for (const row of rows) {
    if (!row.id) continue;
    const key = `${row.type}\u0000${row.id.toLocaleLowerCase()}`;
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()].sort(
    (left, right) => left.type.localeCompare(right.type) || left.label.localeCompare(right.label)
  );
}
