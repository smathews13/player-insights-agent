import type { ConnectionReading } from './connection-model';
import type { PreflightCheck } from './preflight';
import { formatCheckedAt } from './preflight';
import { contentAge } from './semantic-freshness';
import { PRIMARY_CONNECTION_LABEL, primaryConnectionState } from './connection-status';

export interface ConnectionDetail {
  label: string;
  value: string;
}

export interface ConnectionComparison {
  expected: string;
  observed: string;
  status: 'Drift';
}

export interface ConnectionResourceView {
  identity: string;
  displayIdentity: string;
  secondaryIdentity: string;
  status: string;
  connected: boolean;
  details: ConnectionDetail[];
  comparison: ConnectionComparison | null;
  description: string;
  declaredNames: string[];
}

interface ResourceViewContext {
  checkedAt?: string;
  declaredNames?: readonly string[];
  tableChecks?: readonly PreflightCheck[];
  hostedIndex?: string;
  now?: number;
}

const ABSENT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'llm-gateway':
    'An AI Gateway route can sit between the orchestrator and its foundation model to apply routing, limits, and observability.',
  'semantic-index':
    'A Vector Search index can provide the semantic layer used to retrieve player and title vocabulary.',
  'semantic-index-endpoint': 'A Vector Search endpoint hosts the semantic index when semantic retrieval is enabled.',
};

function clean(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed === '(unset)' ? '' : trimmed;
}

function fact(check: PreflightCheck | undefined, key: string): string {
  return clean(check?.facts?.[key]);
}

function add(details: ConnectionDetail[], label: string, value: unknown): void {
  const readable = clean(value);
  if (readable && !details.some((entry) => entry.label === label && entry.value === readable)) {
    details.push({ label, value: readable });
  }
}

function statusFor(reading: ConnectionReading): string {
  const state = primaryConnectionState(reading.status, reading.resource.namesRemoteObject);
  return state === 'connected' ? PRIMARY_CONNECTION_LABEL.connected : PRIMARY_CONNECTION_LABEL.disconnected;
}

function activeIdentity(reading: ConnectionReading): string {
  if (reading.row.actualObserved) {
    const observed = clean(reading.row.actual);
    if (observed) return observed;
  }
  return clean(reading.check?.name) || clean(reading.row.configured);
}

function declaredAccess(checks: readonly PreflightCheck[]): string {
  if (checks.length === 0) return '';
  const connected = checks.filter((check) => check.status === 'ok').length;
  const disconnected = checks.length - connected;
  const parts = [`${connected} of ${checks.length} connected`];
  if (disconnected) parts.push(`${disconnected} disconnected`);
  return parts.join(' · ');
}

/**
 * The only display reading of a built-in Connections row.
 *
 * Identity is resolved once from observed, checked, then configured evidence.
 * Both the collapsed header and expanded body render this object, so an
 * observed-only resource cannot be active in one and absent in the other.
 */
export function connectionResourceView(
  reading: ConnectionReading,
  context: ResourceViewContext = {}
): ConnectionResourceView {
  const { row, check } = reading;
  const id = row.resource.id;
  const identity = activeIdentity(reading);
  const connected = Boolean(identity);
  const displayName = clean(check?.display_name) || fact(check, 'display_name');
  let displayIdentity = displayName || identity || 'Disconnected';
  const secondaryIdentity = displayName && displayName !== identity ? identity : '';
  const status = statusFor(reading);
  const details: ConnectionDetail[] = [];
  const declaredNames = [...new Set((context.declaredNames ?? []).map(clean).filter(Boolean))];
  const tableChecks = context.tableChecks ?? [];
  if (id === 'declared-manifest' && declaredNames.length > 0) {
    displayIdentity = `${declaredNames.length} ${declaredNames.length === 1 ? 'table' : 'tables'}`;
  }

  const comparison =
    row.actualObserved && clean(row.configured) && clean(row.actual) && clean(row.configured) !== clean(row.actual)
      ? { expected: clean(row.configured), observed: clean(row.actual), status: 'Drift' as const }
      : null;

  if (!connected) {
    return {
      identity: '',
      displayIdentity,
      secondaryIdentity: '',
      status,
      connected,
      details: [],
      comparison: null,
      description:
        ABSENT_DESCRIPTIONS[id] ?? `${row.resource.label} is optional and no active connection was reported.`,
      declaredNames,
    };
  }

  switch (id) {
    case 'agent-endpoint':
      add(details, 'Endpoint', identity);
      add(details, 'Served model', fact(check, 'served_model'));
      add(details, 'Traffic', fact(check, 'traffic'));
      break;
    case 'llm-endpoint':
      add(details, 'Model endpoint', identity);
      add(details, 'Role', 'Answer generation');
      break;
    case 'judge-endpoint':
      add(details, 'Model endpoint', identity);
      add(details, 'Role', 'Benchmark scoring');
      break;
    case 'llm-gateway':
      add(details, 'Route', identity);
      add(details, 'Role', 'Foundation model routing');
      break;
    case 'genie-data':
    case 'genie-dictionary':
      add(details, 'Display name', displayName);
      add(details, 'Space ID', identity);
      add(details, 'Curated tables', fact(check, 'table_count'));
      add(details, 'Warehouse', fact(check, 'warehouse_id'));
      break;
    case 'sql-warehouse':
      add(details, 'Display name', displayName);
      add(details, 'Warehouse ID', identity);
      add(details, 'Type', fact(check, 'warehouse_type'));
      add(details, 'Size', fact(check, 'cluster_size'));
      break;
    case 'catalog':
      add(details, 'Catalog', identity);
      add(details, 'Access', status);
      break;
    case 'schema':
      add(details, 'Schema', identity);
      add(details, 'Access', status);
      break;
    case 'declared-manifest':
      add(details, 'Tables', `${declaredNames.length} ${declaredNames.length === 1 ? 'table' : 'tables'}`);
      add(details, 'Access', declaredAccess(tableChecks) || status);
      break;
    case 'lakebase':
      add(details, 'Endpoint', fact(check, 'endpoint') || identity);
      add(details, 'Branch', fact(check, 'branch'));
      add(details, 'Database', fact(check, 'database'));
      add(details, 'Connection', status);
      break;
    case 'semantic-index':
      add(details, 'Index', identity);
      add(details, 'Host endpoint', fact(check, 'endpoint'));
      add(details, 'Index type', fact(check, 'index_type'));
      add(details, 'Source table', fact(check, 'source_table'));
      if (check?.content_at) add(details, 'Rebuild', contentAge(check.content_at, context.now ?? Date.now()).label);
      break;
    case 'semantic-index-endpoint':
      add(details, 'Endpoint', identity);
      add(details, 'Type', fact(check, 'endpoint_type'));
      add(details, 'Hosted index', context.hostedIndex);
      break;
    default:
      add(details, row.resource.label, identity);
  }

  add(details, 'Status', status);
  if (context.checkedAt) add(details, 'Last check', formatCheckedAt(context.checkedAt));

  return {
    identity,
    displayIdentity,
    secondaryIdentity,
    status,
    connected,
    details,
    comparison,
    description: '',
    declaredNames,
  };
}
