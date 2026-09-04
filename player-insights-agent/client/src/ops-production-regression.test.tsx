import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { CostBody, HealthBody, LatencyBody, type Block } from './OpsPage';
import type { HealthDependency, OpsCostPayload, OpsHealthPayload, OpsLatencyPayload } from '../../shared/ops-contract';

const CHECKED_AT = '2026-09-04T19:11:57.000Z';

function dependency(id: string, kind: string, label: string): HealthDependency {
  return {
    id,
    kind,
    connectionsId: id,
    label,
    name: `${id}-configured`,
    result: 'answered',
    verdict: 'reachable',
    lastCheckedAt: CHECKED_AT,
    reason: '',
  };
}

function block<T>(data: T | null, busy = false, failed = ''): Block<T> {
  return { data, busy, failed, refresh: () => {} };
}

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe('production-shaped Ops regressions', () => {
  it('keeps the configured resource inventory, including MLflow, Genie, and Vector Search', () => {
    const payload: OpsHealthPayload = {
      checkedAt: CHECKED_AT,
      reason: '',
      dependencies: [
        dependency('sql-warehouse', 'sql-warehouse', 'SQL warehouse'),
        dependency('agent-endpoint', 'serving-endpoint', 'Orchestrator serving endpoint'),
        dependency('judge-endpoint', 'serving-endpoint', 'Benchmark judge model'),
        dependency('genie-data', 'genie-space', 'Data Genie space'),
        dependency('genie-dictionary', 'genie-space', 'Dictionary Genie space'),
        dependency('semantic-index', 'vector-index', 'Semantic Vector Search index'),
        dependency('experiment-id', 'observability', 'MLflow experiment'),
      ],
      platform: [
        { id: 'app', label: 'App', state: 'Running', read: true, rows: [], reason: '' },
        { id: 'lakebase', label: 'Lakebase', state: 'Connected', read: true, rows: [], reason: '' },
      ],
      app: {
        telemetry: 'reading',
        variable: 'PLAYER_INSIGHTS_TELEMETRY_SCHEMA',
        table: 'catalog.telemetry.otel_logs',
        grant: null,
        insightsHref: '',
        requestsPerHour: [],
        lastServedAt: CHECKED_AT,
        recordingSince: CHECKED_AT,
        signInsPerDay: [],
        errors: { count: 0, recent: [] },
        reason: '',
      },
    };

    const markup = render(<HealthBody block={block(payload)} />);
    for (const label of [
      'SQL warehouse',
      'Orchestrator serving endpoint',
      'Benchmark judge model',
      'Data Genie space',
      'Dictionary Genie space',
      'Semantic Vector Search index',
      'MLflow experiment',
      'App',
      'Lakebase',
    ]) {
      expect(markup, label).toContain(label);
    }
  });

  it('does not call telemetry off when configuration is unreadable and explains the independent latency source', () => {
    const health: OpsHealthPayload = {
      checkedAt: CHECKED_AT,
      reason: '',
      dependencies: [],
      platform: [],
      app: {
        telemetry: 'unreadable',
        variable: 'PLAYER_INSIGHTS_TELEMETRY_SCHEMA',
        table: '',
        grant: null,
        insightsHref: '',
        requestsPerHour: [],
        lastServedAt: '',
        recordingSince: '',
        signInsPerDay: [],
        errors: { count: 0, recent: [] },
        reason: 'The Apps record could not be read, so telemetry configuration is unknown.',
      },
    };
    const latency: OpsLatencyPayload = {
      period: 'current_month',
      readAt: CHECKED_AT,
      state: 'ready',
      reason: '',
      grant: null,
      table: 'player_insights.request_latency',
      routes: [
        {
          route: 'GET /api/example',
          spans: 25,
          p50Ms: 12,
          p95Ms: 20,
          p99Ms: 24,
          slowestMs: 30,
          errorCount: 0,
          refusalCount: null,
          lastSpanAt: CHECKED_AT,
          priorSpans: 25,
          priorP50Ms: 11,
        },
      ],
      coveredFrom: CHECKED_AT,
      coveredTo: CHECKED_AT,
      coverage: { state: 'complete', missingDays: 0 },
    };

    const markup = render(
      <>
        <HealthBody block={block(health)} />
        <LatencyBody block={block(latency)} />
      </>
    );
    expect(markup).toContain('Telemetry could not be read');
    expect(markup).not.toContain('App telemetry is off');
    expect(markup).toContain('App-owned request timings');
    expect(markup).toContain('GET');
    expect(markup).toContain('/api/example');
  });

  it('shows an explicit Cost loading state while the first slow billing read is pending', () => {
    const markup = render(<CostBody block={block<OpsCostPayload>(null, true)} />);
    expect(markup).toContain('Loading cost tracking');
    expect(markup).toContain('aria-busy="true"');
  });
});
