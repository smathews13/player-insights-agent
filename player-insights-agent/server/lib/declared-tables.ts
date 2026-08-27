/**
 * Tables Unity Catalog actually exposes in this release's schema, minus the
 * ones a log would refuse to declare.
 *
 * The Connections matrix used to list only the six names in the committed data
 * contract, because the app container is never given the baked
 * `declared_manifest` a log generates. Schema enumeration at log time is what
 * produced the longer list a reader expects. This module redoes that listing
 * as the signed-in user, with the same payload-table and denylist exclusions
 * `agent/preflight.py` applies, and never invents a name that was not returned.
 */
import { qualifyDataContractTables } from '../../shared/data-contract';

/** Same four columns `agent/preflight.py` uses to recognise an inference log. */
export const PAYLOAD_TABLE_SIGNATURE = new Set([
  'databricks_request_id',
  'request',
  'response',
  'served_entity_id',
]);

export const UNDECLARABLE_SCHEMAS = new Set(['information_schema']);

/** The Vector Search index object, which has its own Connections row. */
export const SEMANTIC_LAYER_INDEX_TABLE = 'semantic_layer_index';

export interface ListedTable {
  fullName: string;
  schemaName: string;
  shortName: string;
  columns: string[] | null;
}

export interface ListTablesPage {
  tables: ListedTable[];
  nextPageToken: string;
}

/**
 * Whether a listing entry is an AI Gateway request log.
 *
 * `null` means the entry carried no column metadata, so the signature could not
 * be evaluated. Distinguished from `false` because an unscreened table is a gap,
 * not a table that was checked and cleared — the Python log reports those
 * rather than silently dropping them. Here we keep an unscreened table: dropping
 * it would hide a name the workspace actually returned.
 */
export function isInferencePayloadTable(columns: readonly string[] | null): boolean | null {
  if (columns === null) return null;
  const names = new Set(columns);
  for (const column of PAYLOAD_TABLE_SIGNATURE) {
    if (!names.has(column)) return false;
  }
  return true;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function denylistMatch(
  fullName: string,
  shortName: string,
  patterns: readonly string[]
): string | null {
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    const match = globToRegExp(pattern);
    if (match.test(fullName) || match.test(shortName)) return pattern;
  }
  return null;
}

/**
 * Why this table must not appear on the Connections matrix, or null to keep it.
 */
export function exclusionReason(
  table: ListedTable,
  denylist: readonly string[] = []
): string | null {
  if (UNDECLARABLE_SCHEMAS.has(table.schemaName)) {
    return `schema ${table.schemaName} is not declarable`;
  }
  if (table.shortName === SEMANTIC_LAYER_INDEX_TABLE) {
    return 'Vector Search index, listed on its own row';
  }
  const pattern = denylistMatch(table.fullName, table.shortName, denylist);
  if (pattern) return `catalog_denylist pattern ${pattern}`;
  if (isInferencePayloadTable(table.columns) === true) {
    return 'inference payload table';
  }
  return null;
}

export function listedTableFromBody(row: unknown): ListedTable | null {
  if (!row || typeof row !== 'object') return null;
  const record = row as Record<string, unknown>;
  const fullName = String(record.full_name ?? '').trim();
  const name = String(record.name ?? '').trim();
  const resolved = fullName || (name.includes('.') ? name : '');
  if (!resolved || resolved.split('.').length !== 3) return null;
  const parts = resolved.split('.');
  const columns = Array.isArray(record.columns)
    ? record.columns
        .map((column) => {
          if (!column || typeof column !== 'object') return '';
          return String((column as Record<string, unknown>).name ?? '').trim();
        })
        .filter(Boolean)
    : null;
  return {
    fullName: resolved,
    schemaName: parts[1] ?? '',
    shortName: parts[2] ?? name,
    columns,
  };
}

export function tablesFromListing(
  rows: readonly ListedTable[],
  denylist: readonly string[] = []
): string[] {
  const names: string[] = [];
  for (const table of rows) {
    if (exclusionReason(table, denylist)) continue;
    if (!names.includes(table.fullName)) names.push(table.fullName);
  }
  return names.sort();
}

export function isDataContractFallback(
  tables: readonly string[],
  catalog: string,
  schema: string
): boolean {
  const contract = qualifyDataContractTables(catalog, schema);
  if (contract.length === 0) return false;
  if (tables.length !== contract.length) return false;
  const listed = [...tables].map((table) => table.trim()).filter(Boolean).sort();
  return listed.every((table, index) => table === contract[index]);
}

export function unionTableNames(...lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat().map((table) => table.trim()).filter(Boolean))].sort();
}

const TABLES_PATH = '/api/2.1/unity-catalog/tables';

/**
 * Page through Unity Catalog tables in one schema as the signed-in user.
 *
 * Never throws: a missing token, a refusal or a timeout returns [] so the
 * caller keeps the data-contract fallback rather than blanking the matrix.
 */
export async function listDeclarableTablesInSchema(input: {
  catalog: string;
  schema: string;
  host: string;
  token: string;
  denylist?: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string[]> {
  const catalog = input.catalog.trim();
  const schema = input.schema.trim();
  if (!catalog || !schema || !input.host || !input.token) return [];
  if (UNDECLARABLE_SCHEMAS.has(schema)) return [];

  const call = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 15_000;
  const found: ListedTable[] = [];
  let pageToken = '';
  for (let pages = 0; pages < 20; pages += 1) {
    const query = [
      `catalog_name=${encodeURIComponent(catalog)}`,
      `schema_name=${encodeURIComponent(schema)}`,
      'omit_columns=false',
      'max_results=100',
      pageToken ? `page_token=${encodeURIComponent(pageToken)}` : '',
    ]
      .filter(Boolean)
      .join('&');
    try {
      const response = await call(`${input.host}${TABLES_PATH}?${query}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${input.token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return tablesFromListing(found, input.denylist);
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const rows = Array.isArray(body.tables) ? body.tables : [];
      for (const row of rows) {
        const table = listedTableFromBody(row);
        if (table) found.push(table);
      }
      pageToken = String(body.next_page_token ?? '').trim();
      if (!pageToken) break;
    } catch {
      return tablesFromListing(found, input.denylist);
    }
  }
  return tablesFromListing(found, input.denylist);
}
