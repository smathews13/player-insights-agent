import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { DeclaredTablesSection } from './ConnectionsPage';
import { HealthBody } from './OpsPage';
import { healthConnectionsHref, healthRowsForDisplay } from './health-resource-view';
import type { PreflightCheck } from './preflight';
import type { DependencyResult, HealthDependency, OpsHealthPayload } from '../../shared/ops-contract';

const CHECKED_AT = '2026-08-29T22:41:23.000Z';

function table(index: number, result: DependencyResult = 'answered'): HealthDependency {
  return {
    id: `table:${index}`,
    kind: 'table',
    connectionsId: '',
    label: `catalog.schema.table_${index}`,
    name: `catalog.schema.table_${index}`,
    result,
    lastCheckedAt: result === 'not-checked' ? '' : CHECKED_AT,
    reason: result === 'answered' ? '' : `table_${index} did not establish reachability.`,
  };
}

function manifest(result: DependencyResult = 'answered'): HealthDependency {
  return {
    id: 'declared-manifest',
    kind: 'manifest',
    connectionsId: 'declared-manifest',
    label: 'Declared tables \u00b7 12',
    name: '',
    result,
    lastCheckedAt: result === 'not-checked' ? '' : CHECKED_AT,
    reason: 'Legacy aggregate evidence.',
  };
}

function endpoint(): HealthDependency {
  return {
    id: 'agent-endpoint',
    kind: 'serving-endpoint',
    connectionsId: 'agent-endpoint',
    label: 'Orchestrator serving endpoint \u00b7 player-insights-agent',
    name: 'player-insights-agent',
    result: 'answered',
    lastCheckedAt: CHECKED_AT,
    reason: '',
  };
}

function health(dependencies: HealthDependency[]): OpsHealthPayload {
  return {
    checkedAt: CHECKED_AT,
    dependencies,
    platform: [],
    app: {
      telemetry: 'not-enabled',
      variable: '',
      table: '',
      grant: null,
      insightsHref: '',
      requestsPerHour: [],
      lastServedAt: '',
      recordingSince: '',
      signInsPerDay: [],
      errors: { count: 0, recent: [] },
      reason: '',
    },
    reason: '',
  };
}

function renderHealth(payload: OpsHealthPayload): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <HealthBody block={{ data: payload, busy: false, failed: '', refresh: () => {} }} />
    </MemoryRouter>
  );
}

function preflight(row: HealthDependency): PreflightCheck {
  return {
    id: row.id,
    kind: 'table',
    name: row.name,
    label: row.label,
    status: row.result === 'answered' ? 'ok' : row.result === 'did-not-answer' ? 'failed' : 'unverified',
    detail: row.reason,
    checked_with: '',
    duration_ms: 0,
    error: '',
    remedy: null,
  };
}

describe('declared tables in the Health resource list', () => {
  it('renders twelve healthy tables as one honest aggregate and keeps other resources unchanged', () => {
    const tables = Array.from({ length: 12 }, (_, index) => table(index));
    const payload = health([...tables, endpoint(), manifest()]);
    const rows = healthRowsForDisplay(payload);
    const aggregates = rows.filter((row) => row.id === 'declared-manifest');

    expect(payload.dependencies).toHaveLength(14);
    expect(rows.filter((row) => row.kind === 'table')).toEqual([]);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]).toMatchObject({
      label: 'Declared tables \u00b7 12 tables',
      notes: '12 connected \u00b7 0 unverified \u00b7 0 failed',
      pill: { label: 'Declared tables', value: 'Connected' },
    });
    expect(aggregates[0].pill.tone).toContain('ast-pill--pos');

    const serving = rows.find((row) => row.id === 'agent-endpoint');
    expect(serving).toMatchObject({
      label: 'Orchestrator serving endpoint \u00b7 player-insights-agent',
      name: 'player-insights-agent',
      connectionsId: 'agent-endpoint',
      pill: { label: 'Serving endpoint', value: 'Connected' },
    });

    const markup = renderHealth(payload);
    expect(markup).toContain('Declared tables \u00b7 12 tables');
    expect(markup).toContain('href="/connections#declared-tables"');
    expect(markup).not.toContain('catalog.schema.table_0');
  });

  it('makes any failed table a non-green aggregate with complete counts', () => {
    const tables = [
      ...Array.from({ length: 9 }, (_, index) => table(index)),
      table(9, 'not-checked'),
      table(10, 'not-checked'),
      table(11, 'did-not-answer'),
    ];
    const [aggregate] = healthRowsForDisplay(health([...tables, manifest('answered')])).filter(
      (row) => row.id === 'declared-manifest'
    );

    expect(aggregate.pill.value).toBe('Disconnected');
    expect(aggregate.pill.tone).toContain('ast-pill--neg');
    expect(aggregate.pill.tone).not.toContain('ast-pill--pos');
    expect(aggregate.notes).toContain('9 connected \u00b7 2 unverified \u00b7 1 failed');
    expect(aggregate.notes).not.toMatch(/tables?:|open|section|evidence|\.$/i);
  });

  it('keeps every comparable Notes cell to a noun phrase or metric group', () => {
    const rows = healthRowsForDisplay(health([table(0), endpoint(), manifest()]));
    for (const row of rows) {
      expect(row.notes).not.toMatch(/\bopen\b|\bclick\b|\bgo to\b|\bsection\b|[.!?]$/i);
    }
    const aggregate = rows.find((row) => row.id === 'declared-manifest');
    expect(aggregate?.label).toBe('Declared tables \u00b7 1 table');
    expect(aggregate?.notes).toBe('1 connected \u00b7 0 unverified \u00b7 0 failed');
    expect(aggregate?.notes).not.toContain('1 table');
  });

  it('leaves all twelve probes in the dedicated governed-table section', () => {
    const tables = Array.from({ length: 12 }, (_, index) => table(index));
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <DeclaredTablesSection tableChecks={tables.map(preflight)} requestedEntity="" checkedAt={CHECKED_AT} />
      </MemoryRouter>
    );

    expect(markup).toContain('id="declared-tables"');
    expect(markup.match(/data-entity-part="table"/g)).toHaveLength(12);
    for (let index = 0; index < 12; index += 1) expect(markup).toContain(`table_${index}`);
  });

  it('handles zero-table, legacy aggregate-only, and missing-rollup payloads', () => {
    expect(healthRowsForDisplay(health([]))).toEqual([]);

    const legacy = healthRowsForDisplay(health([manifest('not-checked')]));
    expect(legacy).toHaveLength(1);
    expect(legacy[0].label).toBe('Declared tables \u00b7 12');
    expect(healthConnectionsHref(legacy[0])).toBe('/connections#declared-tables');

    const withoutRollup = healthRowsForDisplay(health([table(0), table(1)]));
    expect(withoutRollup.filter((row) => row.kind === 'table')).toEqual([]);
    expect(withoutRollup).toHaveLength(1);
    expect(withoutRollup[0]).toMatchObject({
      id: 'declared-manifest',
      label: 'Declared tables \u00b7 2 tables',
      pill: { value: 'Connected' },
    });
  });
});
