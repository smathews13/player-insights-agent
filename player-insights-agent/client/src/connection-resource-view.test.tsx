import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { ConnectionRow } from './ConnectionsPage';
import { connectionResourceView } from './connection-resource-view';
import { readConnection, type ResourceRow } from './connection-model';
import type { PreflightCheck } from './preflight';
import { connectedResource } from '../../shared/deployment-config';

const BANNED = [
  'CONFIGURED',
  'not set',
  'Not checked',
  'Reachable',
  'Unreachable',
  'READY',
  'RUNNING',
  'Source: from the app container',
  'Deployment-owned',
  'New model version',
  'App redeploy',
  'Admin-managed · changes apply immediately',
  'Source: saved here, and in force ahead of the deployed value',
];

const RESOURCES = [
  ['agent-endpoint', 'Endpoint'],
  ['llm-endpoint', 'Role'],
  ['judge-endpoint', 'Role'],
  ['llm-gateway', 'Route'],
  ['genie-data', 'Space ID'],
  ['sql-warehouse', 'Warehouse ID'],
  ['catalog', 'Catalog'],
  ['schema', 'Schema'],
  ['declared-manifest', 'Tables'],
  ['lakebase', 'Database'],
  ['semantic-index', 'Index'],
  ['semantic-index-endpoint', 'Hosted index'],
] as const;

type State = 'observed-only' | 'match' | 'mismatch' | 'partial' | 'unavailable';

function row(id: string, state: State): ResourceRow {
  const configured = state === 'observed-only' ? '' : state === 'mismatch' ? `${id}-expected` : `${id}-active`;
  return {
    resource: connectedResource(id)!,
    configured,
    configuredFrom: state === 'observed-only' ? '' : 'artifact',
    actual: state === 'mismatch' ? `${id}-observed` : state === 'match' ? configured : '',
    actualObserved: state === 'match' || state === 'mismatch',
    intended: null,
    intendedAt: '',
    intendedBy: '',
    editable: id === 'judge-endpoint',
    changedByLabel: '',
    changedByNote: '',
  };
}

function check(id: string, state: State): PreflightCheck | undefined {
  if (state === 'partial') return undefined;
  const name = state === 'observed-only' ? `${id}-observed` : state === 'mismatch' ? `${id}-observed` : `${id}-active`;
  return {
    id,
    kind: 'dependency',
    name,
    label: id,
    status: state === 'unavailable' ? 'unverified' : 'ok',
    stopped: state === 'unavailable' ? 'unreachable' : undefined,
    detail: state === 'unavailable' ? 'The metadata call did not complete.' : 'The workspace answered.',
    checked_with: 'fixture',
    duration_ms: 1,
    error: '',
    remedy: null,
    facts:
      id === 'genie-data'
        ? { display_name: 'Player data space', warehouse_id: 'warehouse-1', table_count: 12 }
        : id === 'sql-warehouse'
          ? { display_name: 'Analytics warehouse', state: 'RUNNING', warehouse_type: 'PRO', cluster_size: 'Small' }
          : id === 'lakebase'
            ? { endpoint: name, database: 'app_db', branch: 'production' }
            : id === 'semantic-index'
              ? { endpoint: 'semantic-vs', index_type: 'TRIGGERED' }
              : id === 'semantic-index-endpoint'
                ? { endpoint_type: 'STANDARD', state: 'ONLINE' }
                : id === 'agent-endpoint'
                  ? {
                      served_model: 'player-insights-agent v7',
                      traffic: 'player-insights-agent-7 100%',
                      readiness: 'READY',
                    }
                  : undefined,
  };
}

function fixture(id: string, state: State) {
  return readConnection({ row: row(id, state), check: check(id, state), findings: [] });
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderRow(id: string, state: State): string {
  const reading = fixture(id, state);
  return renderToStaticMarkup(
    <MemoryRouter>
      <ConnectionRow
        reading={reading}
        tone={state === 'mismatch' ? 'drifted' : 'reachable'}
        saving={false}
        refreshing={false}
        requested
        allowMutations
        declaredTables={id === 'declared-manifest' ? ['catalog.schema.one', 'catalog.schema.two'] : undefined}
        tableChecks={
          id === 'declared-manifest'
            ? [
                { ...check('table:one', 'match')!, id: 'table:one', kind: 'table', name: 'catalog.schema.one' },
                { ...check('table:two', 'match')!, id: 'table:two', kind: 'table', name: 'catalog.schema.two' },
              ]
            : undefined
        }
        hostedIndex="catalog.schema.semantic_index"
        checkedAt="2026-08-31T22:00:00.000Z"
        onSave={() => Promise.resolve(true)}
        onClear={() => Promise.resolve()}
      />
    </MemoryRouter>
  );
}

describe('canonical Connections resource views', () => {
  it.each(RESOURCES)('%s maps authoritative fields into %s details', (id, requiredLabel) => {
    const reading = fixture(id, 'match');
    const view = connectionResourceView(reading, {
      checkedAt: '2026-08-31T22:00:00.000Z',
      declaredNames: id === 'declared-manifest' ? ['catalog.schema.one', 'catalog.schema.two'] : undefined,
      tableChecks: [],
      hostedIndex: 'catalog.schema.semantic_index',
      now: new Date('2026-08-31T22:00:00.000Z').getTime(),
    });
    expect(
      view.details.map((detail) => detail.label),
      id
    ).toContain(requiredLabel);
    expect(view.status, id).toBe('Connected');
  });

  it.each(
    RESOURCES.flatMap(([id]) =>
      (['observed-only', 'match', 'mismatch', 'partial', 'unavailable'] as State[]).map((state) => [id, state] as const)
    )
  )('%s stays internally consistent with %s evidence', (id, state) => {
    const markup = renderRow(id, state);
    const readable = text(markup);
    for (const phrase of BANNED) expect(readable, `${id}/${state}: ${phrase}`).not.toContain(phrase);

    const view = connectionResourceView(fixture(id, state), {
      declaredNames: id === 'declared-manifest' ? ['catalog.schema.one', 'catalog.schema.two'] : undefined,
      hostedIndex: 'catalog.schema.semantic_index',
    });
    expect(markup).toContain(`title="${view.displayIdentity}`);
    if (view.identity && id !== 'declared-manifest') {
      expect(readable, `${id}/${state}`).toContain(view.identity);
    }
    if (state === 'mismatch') {
      expect(readable).toContain('Expected');
      expect(readable).toContain('Observed');
      expect(readable).toContain('Drift');
    } else {
      expect(readable).not.toMatch(/\bExpected\b|\bObserved\b/);
    }
  });

  it('replaces collapsed and expanded connection statuses with loaders during a refresh', () => {
    const reading = fixture('sql-warehouse', 'match');
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ConnectionRow
          reading={reading}
          tone="reachable"
          saving={false}
          refreshing
          requested
          onSave={() => Promise.resolve(true)}
          onClear={() => Promise.resolve()}
        />
      </MemoryRouter>
    );
    expect(markup.match(/Checking SQL warehouse/g)).toHaveLength(2);
    expect(markup).not.toContain('connection status:');
    expect(markup).not.toMatch(/>(Connected|Disconnected|Reachable|Ready|Running|Not checked)</);
  });

  it('renders an absent AI Gateway as one normal neutral row', () => {
    const reading = readConnection({ row: row('llm-gateway', 'observed-only'), check: undefined, findings: [] });
    reading.row.configured = '';
    const view = connectionResourceView(reading);
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ConnectionRow
          reading={reading}
          tone="plain"
          saving={false}
          refreshing={false}
          requested
          onSave={() => Promise.resolve(true)}
          onClear={() => Promise.resolve()}
        />
      </MemoryRouter>
    );
    const readable = text(markup);
    expect(view.status).toBe('Disconnected');
    expect(readable).toContain('AI Gateway Disconnected');
    expect(readable).toContain('can sit between the orchestrator and its foundation model');
    expect(readable).not.toMatch(/lock|dependency/i);
    for (const phrase of BANNED) expect(readable).not.toContain(phrase);
  });

  it('uses one disconnected status while detailed evidence keeps the failure reason', () => {
    const base = row('llm-gateway', 'match');
    const states: PreflightCheck[] = [
      { ...check('llm-gateway', 'match')!, status: 'failed' },
      { ...check('llm-gateway', 'unavailable')!, stopped: 'refused' },
      { ...check('llm-gateway', 'unavailable')!, stopped: 'unreachable' },
    ];
    expect(
      states.map((entry) => connectionResourceView(readConnection({ row: base, check: entry, findings: [] })).status)
    ).toEqual(['Disconnected', 'Disconnected', 'Disconnected']);
  });
});
