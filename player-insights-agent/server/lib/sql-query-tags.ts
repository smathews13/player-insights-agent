import { createHash } from 'node:crypto';

/** Statement Execution accepts at most 20 tags with 128-character keys and values. */
export const SQL_QUERY_TAG_LIMIT = 20;
export const SQL_QUERY_TAG_TEXT_LIMIT = 128;

export interface SqlQueryTag {
  key: string;
  value: string;
}

type SqlQueryAttribution =
  | { surface: 'connections'; tool: 'access_verification'; operation: 'preflight' }
  | { surface: 'admin'; tool: 'admin_access'; operation: 'revoke' }
  | { surface: 'ops'; tool: 'ops_query'; operation: 'diagnostics' }
  | { surface: 'benchmark'; tool: 'genie_result'; operation: 'execute' }
  | { surface: 'declaration'; tool: 'notebook_declaration'; operation: 'read' }
  | { surface: 'telemetry'; tool: 'ops_telemetry'; operation: 'exporter_read' };

interface SqlQueryIdentifiers {
  /** Include only an existing run identifier, never user or SQL content. */
  runId?: string | null;
  /** Include only an existing request/correlation identifier. */
  correlationId?: string | null;
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]+$/;

/**
 * Keep identifiers useful when they already fit the documented tag boundary.
 * Anything else is represented by a stable digest so SQL, emails, table names,
 * or other accidental content can never be copied into Query History.
 */
export function safeSqlTagIdentifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= SQL_QUERY_TAG_TEXT_LIMIT && SAFE_IDENTIFIER.test(trimmed)) return trimmed;
  return `id_${createHash('sha256').update(trimmed).digest('hex')}`;
}

/**
 * Query-History attribution shared by every app-side Statement Execution call.
 *
 * The discriminated attribution type intentionally limits callers to stable,
 * non-user-authored labels. Only pre-existing run/correlation IDs are dynamic.
 */
export function sqlQueryTags(input: SqlQueryAttribution & SqlQueryIdentifiers): SqlQueryTag[] {
  const tags: SqlQueryTag[] = [
    { key: 'application', value: 'Astrolabe' },
    { key: 'surface', value: input.surface },
    { key: 'tool', value: input.tool },
    { key: 'operation', value: input.operation },
  ];
  const runId = input.runId ? safeSqlTagIdentifier(input.runId) : '';
  const correlationId = input.correlationId ? safeSqlTagIdentifier(input.correlationId) : '';
  if (runId) tags.push({ key: 'run_id', value: runId });
  if (correlationId) tags.push({ key: 'correlation_id', value: correlationId });
  return tags.slice(0, SQL_QUERY_TAG_LIMIT);
}
