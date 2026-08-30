import { DECLARED_TABLES_SECTION_ID } from './connections-view';
import { healthRows, resourceWord, RESULT_TONE, type HealthRow } from './ops-view';
import type { DependencyResult, HealthDependency, PlatformReading } from '../../shared/ops-contract';

type HealthRowsPayload = {
  dependencies?: readonly HealthDependency[];
  platform?: readonly PlatformReading[];
  checkedAt?: string;
} | null;

function isDeclaredTableManifest(row: Pick<HealthRow, 'id' | 'kind'>): boolean {
  return row.id === 'declared-manifest' || row.kind === 'manifest';
}

function aggregateResult(counts: { failed: number; unverified: number }): DependencyResult {
  if (counts.failed > 0) return 'did-not-answer';
  if (counts.unverified > 0) return 'not-checked';
  return 'answered';
}

/**
 * Health is a resource summary, while Connections owns the per-table evidence.
 *
 * The server payload remains lossless. This view model replaces its individual
 * table rows and manifest rollup with one honest aggregate for this one list.
 */
export function healthRowsForDisplay(payload: HealthRowsPayload): HealthRow[] {
  const rows = healthRows(payload);
  const dependencies = payload?.dependencies ?? [];
  const tables = dependencies.filter((row) => row.kind === 'table');
  if (tables.length === 0) return rows;

  const counts = {
    reachable: tables.filter((row) => row.result === 'answered').length,
    unverified: tables.filter((row) => row.result === 'not-checked').length,
    failed: tables.filter((row) => row.result === 'did-not-answer').length,
  };
  const result = aggregateResult(counts);
  const existing = rows.find(isDeclaredTableManifest);
  const total = tables.length;
  const aggregate: HealthRow = {
    id: existing?.id ?? 'declared-manifest',
    kind: 'manifest',
    label: `Declared tables \u00b7 ${total} ${total === 1 ? 'table' : 'tables'}`,
    name: '',
    connectionsId: existing?.connectionsId ?? '',
    lastCheckedAt:
      result === 'not-checked'
        ? ''
        : existing?.lastCheckedAt || tables.find((row) => row.lastCheckedAt)?.lastCheckedAt || '',
    notes:
      `${total} ${total === 1 ? 'table' : 'tables'}: ${counts.reachable} reachable \u00b7 ` +
      `${counts.unverified} unverified \u00b7 ${counts.failed} failed. ` +
      'Open the detailed tables section for per-table evidence.',
    pill: {
      label: resourceWord({ kind: 'manifest', label: 'Declared tables' }),
      value: result === 'answered' ? 'Reachable' : result === 'did-not-answer' ? 'Failed' : 'Unverified',
      tone: RESULT_TONE[result],
    },
  };

  const aggregateIndex = Math.max(
    0,
    rows.findIndex(isDeclaredTableManifest) >= 0
      ? rows.findIndex(isDeclaredTableManifest)
      : rows.findIndex((row) => row.kind === 'table')
  );
  const displayed: HealthRow[] = [];
  rows.forEach((row, index) => {
    if (index === aggregateIndex) displayed.push(aggregate);
    if (row.kind === 'table' || isDeclaredTableManifest(row)) return;
    displayed.push(row);
  });
  return displayed;
}

/** The in-app destination for a Health row, including the table aggregate. */
export function healthConnectionsHref(row: Pick<HealthRow, 'id' | 'kind' | 'connectionsId'>): string {
  if (isDeclaredTableManifest(row)) return `/connections#${DECLARED_TABLES_SECTION_ID}`;
  return row.connectionsId ? `/connections?entity=${encodeURIComponent(row.connectionsId)}` : '';
}
