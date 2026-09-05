import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { HealthResourceIcon } from './HealthResourceIcon';
import {
  KNOWN_HEALTH_RESOURCE_KINDS,
  healthResourceIconSpec,
  type HealthResourceIconSpec,
} from './health-resource-icon';
import { HealthBody, type Block } from './OpsPage';
import type { OpsHealthPayload } from '../../shared/ops-contract';

const EXPECTED: Readonly<Record<(typeof KNOWN_HEALTH_RESOURCE_KINDS)[number], HealthResourceIconSpec>> = {
  'sql-warehouse': { type: 'brand', product: 'databricks-sql' },
  'genie-space': { type: 'brand', product: 'genie' },
  catalog: { type: 'brand', product: 'unity-catalog' },
  schema: { type: 'brand', product: 'unity-catalog' },
  table: { type: 'brand', product: 'unity-catalog' },
  'serving-endpoint': { type: 'brand', product: 'mosaic-ai' },
  'vector-index': { type: 'brand', product: 'mosaic-ai' },
  'vector-endpoint': { type: 'brand', product: 'mosaic-ai' },
  app: { type: 'brand', product: 'apps' },
  lakebase: { type: 'brand', product: 'lakebase' },
  observability: { type: 'brand', product: 'mlflow' },
  manifest: { type: 'table' },
};

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe('Ops Health resource icons', () => {
  it.each(KNOWN_HEALTH_RESOURCE_KINDS)('maps the known %s kind to a settled icon', (kind) => {
    expect(healthResourceIconSpec(kind)).toEqual(EXPECTED[kind]);
    expect(render(<HealthResourceIcon kind={kind} />)).toContain('ops-dependency-mark');
  });

  it('keeps decoder and configuration aliases on their canonical icons', () => {
    for (const kind of ['mlflow', 'experiment', 'experiment-id', 'mlflow_experiment']) {
      expect(healthResourceIconSpec(kind), kind).toEqual({ type: 'brand', product: 'mlflow' });
    }
    expect(healthResourceIconSpec('sql_warehouse')).toEqual({ type: 'brand', product: 'databricks-sql' });
    expect(healthResourceIconSpec('declared_tables')).toEqual({ type: 'table' });
  });

  it('renders the approved MLflow wordmark and a table glyph for the two restored rows', () => {
    const mlflow = render(<HealthResourceIcon kind="observability" />);
    expect(mlflow).toContain('brand-icon wordmark ops-dependency-mark');
    expect(mlflow).toContain('--brand-icon-size:16px');
    expect(mlflow).toContain('fill="var(--foreground)"');
    expect(mlflow).not.toContain('lucide-box');

    const tables = render(<HealthResourceIcon kind="manifest" />);
    expect(tables).toContain('lucide-table-properties');
    expect(tables).toContain('ops-dependency-mark-generic');
    expect(tables).toContain('aria-hidden="true"');
  });

  it('uses a visible neutral resource icon for an unknown kind', () => {
    expect(healthResourceIconSpec('future-resource')).toEqual({ type: 'resource' });
    const markup = render(<HealthResourceIcon kind="future-resource" />);
    expect(markup).toContain('lucide-box');
    expect(markup).toContain('ops-dependency-mark-generic');
  });

  it('integrates MLflow, the Declared tables aggregate, and the unknown fallback into Health rows', () => {
    const checkedAt = '2026-09-04T19:11:57.000Z';
    const payload: OpsHealthPayload = {
      checkedAt,
      reason: '',
      dependencies: [
        {
          id: 'experiment-id',
          kind: 'observability',
          connectionsId: 'experiment-id',
          label: 'MLflow experiment',
          name: '<mlflow-experiment-id>',
          result: 'answered',
          lastCheckedAt: checkedAt,
          reason: '',
        },
        {
          id: 'table:catalog.schema.players',
          kind: 'table',
          connectionsId: '',
          label: 'catalog.schema.players',
          name: 'catalog.schema.players',
          result: 'answered',
          lastCheckedAt: checkedAt,
          reason: '',
        },
        {
          id: 'future-resource',
          kind: 'future-resource',
          connectionsId: '',
          label: 'Future resource',
          name: '',
          result: 'answered',
          lastCheckedAt: checkedAt,
          reason: '',
        },
      ],
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
    };
    const block: Block<OpsHealthPayload> = { data: payload, busy: false, failed: '', refresh: () => {} };
    const markup = render(<HealthBody block={block} />);

    expect(markup).toContain('MLflow experiment');
    expect(markup).toContain('brand-icon wordmark ops-dependency-mark');
    expect(markup).toContain('Declared tables · 1 table');
    expect(markup).toContain('lucide-table-properties');
    expect(markup).toContain('Future resource');
    expect(markup).toContain('lucide-box');
  });
});
