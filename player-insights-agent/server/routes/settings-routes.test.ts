import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  completeReachabilityTables,
  configuredNotebookPath,
  readOrchestratorReport,
  releaseDeclaration,
  validateAndStoreNotebookPath,
} from './settings-routes';
import { extractConfigurationReport, type InsightsAppKit, type ServingTransport } from './insights-routes';
import { resourceStates, settingsPayload } from '../lib/app-settings';
import { qualifyDataContractTables } from '../../shared/data-contract';

/**
 * What the endpoint says it is configured with has to survive the trip.
 *
 * These tests exist because it did not. `extractPreflightReport` looks for
 * `custom_outputs.preflight`, the shape from when the endpoint still ran
 * dependency checks; every current version answers `preflight_retired` and puts
 * its configuration at the top level of `custom_outputs`. `/api/settings` no
 * longer invokes serving, but the parser remains so an old payload can still
 * be read. The fixture below is the literal payload
 * `agent.py::_preflight_retired` returns.
 */

/** The payload the served orchestrator actually returns, key for key. */
function retiredPreflight(configuration: Record<string, unknown>[]) {
  return {
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] }],
    custom_outputs: { type: 'preflight_retired', configuration },
  };
}

function entry(key: string, value: string, over: Record<string, unknown> = {}) {
  return {
    key,
    env_var: `PLAYER_INSIGHTS_${key.toUpperCase()}`,
    value,
    source: 'artifact',
    mutability: 'model-version',
    baked: true,
    required: true,
    ...over,
  };
}

function appkit(transport: ServingTransport): InsightsAppKit {
  return {
    servingTransport: transport,
    lakebase: { query: () => Promise.resolve({ rows: [] }) },
    server: { extend: () => {} },
  } as unknown as InsightsAppKit;
}

function appkitAnswering(raw: unknown): InsightsAppKit {
  return appkit(() => Promise.resolve(raw));
}

const RELEASE_ENV_KEYS = [
  'DATABRICKS_SERVING_ENDPOINT_NAME',
  'DATABRICKS_SQL_WAREHOUSE_ID',
  'PLAYER_INSIGHTS_CATALOG',
  'PLAYER_INSIGHTS_SCHEMA',
  'PLAYER_INSIGHTS_BUILD_SHA',
  'PLAYER_INSIGHTS_DECLARED_MANIFEST',
  'PLAYER_INSIGHTS_TABLES',
  'PLAYER_INSIGHTS_DATA_GENIE_ID',
  'PLAYER_INSIGHTS_DICTIONARY_GENIE_ID',
  'PLAYER_INSIGHTS_WAREHOUSE_ID',
  'PLAYER_INSIGHTS_LLM_ENDPOINT',
  'PLAYER_INSIGHTS_SEMANTIC_INDEX',
] as const;

const savedReleaseEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of RELEASE_ENV_KEYS) {
    savedReleaseEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'an-endpoint';
});

afterEach(() => {
  for (const key of RELEASE_ENV_KEYS) {
    const value = savedReleaseEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('the configuration survives the retired-preflight shape', () => {
  it('finds the list where the current agent puts it', () => {
    const found = extractConfigurationReport(retiredPreflight([entry('catalog', 'a_catalog')]));
    expect(found.map((item) => item.key)).toEqual(['catalog']);
    // Every field, not just key and value: `source` is what lets the pane say a
    // value came from the artifact rather than from a guess, and it is the first
    // thing a hand-rolled `{key, value}` mapping loses.
    expect(found[0]).toMatchObject({ value: 'a_catalog', source: 'artifact', mutability: 'model-version' });
  });

  it('still finds it inside a full report, for a version that sends one', () => {
    const inReport = {
      custom_outputs: { preflight: { configuration: [entry('catalog', 'a_catalog')], checks: [] } },
    };
    expect(extractConfigurationReport(inReport).map((item) => item.key)).toEqual(['catalog']);
  });

  it('reads nothing out of an endpoint error rather than half a list', () => {
    expect(extractConfigurationReport({ error_code: 'RESOURCE_DOES_NOT_EXIST', message: 'no' })).toEqual([]);
  });

  it('leaves out entries with no key instead of carrying a blank row', () => {
    const mixed = retiredPreflight([entry('catalog', 'a_catalog'), { value: 'orphan' }]);
    expect(extractConfigurationReport(mixed).map((item) => item.key)).toEqual(['catalog']);
  });
});

describe('what /api/settings makes of this release, without asking the agent', () => {
  it('unions configured and discovered tables even when their counts do not grow', () => {
    const equalSized = completeReachabilityTables(
      ['a_catalog.a_schema.players', 'a_catalog.a_schema.sessions'],
      ['a_catalog.a_schema.sessions', 'a_catalog.a_schema.feedback']
    );
    expect(equalSized).toHaveLength(3);
    expect(equalSized).toEqual(
      expect.arrayContaining([
        'a_catalog.a_schema.players',
        'a_catalog.a_schema.sessions',
        'a_catalog.a_schema.feedback',
      ])
    );
    const shorterDiscovery = completeReachabilityTables(
      ['a_catalog.a_schema.players', 'a_catalog.a_schema.sessions'],
      ['a_catalog.a_schema.feedback']
    );
    expect(shorterDiscovery).toHaveLength(3);
    expect(shorterDiscovery).toEqual(
      expect.arrayContaining([
        'a_catalog.a_schema.players',
        'a_catalog.a_schema.sessions',
        'a_catalog.a_schema.feedback',
      ])
    );
  });

  it('reports the configuration from the app container', async () => {
    process.env.PLAYER_INSIGHTS_CATALOG = 'a_catalog';
    process.env.PLAYER_INSIGHTS_SCHEMA = 'a_schema';
    const read = await readOrchestratorReport();
    expect(read.answered).toBe(false);
    expect(read.report?.configuration.map((item) => item.key)).toEqual(
      expect.arrayContaining(['catalog', 'schema', 'declared_manifest'])
    );
    const catalog = read.report?.configuration.find((item) => item.key === 'catalog');
    expect(catalog).toMatchObject({ value: 'a_catalog', source: 'app-environment' });
  });

  it('carries the build stamp this release wrote, rather than calling it unstamped', async () => {
    process.env.PLAYER_INSIGHTS_BUILD_SHA = 'deadbeef';
    process.env.PLAYER_INSIGHTS_CATALOG = 'a_catalog';
    process.env.PLAYER_INSIGHTS_SCHEMA = 'a_schema';
    const read = await readOrchestratorReport();
    expect(read.report?.build_sha).toBe('deadbeef');
  });

  it('claims nothing about agent health, because serving was not invoked', async () => {
    process.env.PLAYER_INSIGHTS_CATALOG = 'a_catalog';
    process.env.PLAYER_INSIGHTS_SCHEMA = 'a_schema';
    const read = await readOrchestratorReport();
    expect(read.report?.status).toBe('unverified');
    expect(read.report?.checked_at).toBe('');
    expect(read.report?.principal).toBe('');
    expect(read.report?.principal_resolved).toBe(false);
    expect(read.report?.assumptions).toEqual([]);
    expect(read.report?.source).toBe('configuration');
  });

  it('keeps the Lakebase check the app can make for itself, and not a fake agent ping', async () => {
    process.env.PLAYER_INSIGHTS_CATALOG = 'a_catalog';
    process.env.PLAYER_INSIGHTS_SCHEMA = 'a_schema';
    const read = await readOrchestratorReport();
    const ids = read.report?.checks.map((check) => check.id) ?? [];
    expect(ids).not.toContain('agent-endpoint');
    expect(ids.some((id) => id.includes('lakebase'))).toBe(true);
  });

  it('still answers when serving would have been unreachable', async () => {
    const read = await readOrchestratorReport();
    expect(read.answered).toBe(false);
    expect(read.report).not.toBeNull();
    expect(read.report?.source).toBe('configuration');
  });

  it('gives the pane a configured value to show, from this release', async () => {
    process.env.PLAYER_INSIGHTS_CATALOG = 'a_catalog';
    process.env.PLAYER_INSIGHTS_SCHEMA = 'a_schema';
    const read = await readOrchestratorReport();
    const states = resourceStates({ report: read.report, environment: {}, stored: new Map() });
    const catalog = states.find((state) => state.resource.id === 'catalog');
    expect(catalog?.configured).toBe('a_catalog');
    expect(catalog?.configuredFrom).toBe('app-environment');
    expect(read.report?.configuration.find((item) => item.key === 'declared_manifest')?.value).toEqual(
      qualifyDataContractTables('a_catalog', 'a_schema')
    );
    expect(read.report?.configuration.find((item) => item.key === 'declared_manifest')?.source).toBe('data-contract');
  });

  it('does not let the page claim agreement it never measured', async () => {
    process.env.PLAYER_INSIGHTS_BUILD_SHA = 'deadbeef';
    process.env.PLAYER_INSIGHTS_CATALOG = 'a_catalog';
    process.env.PLAYER_INSIGHTS_SCHEMA = 'a_schema';
    const read = await readOrchestratorReport();
    const payload = settingsPayload({
      report: read.report,
      environment: {},
      stored: new Map(),
      appBuildSha: 'deadbeef',
      storeAvailable: true,
      endpointAnswered: read.answered,
    });

    expect(payload.status).toBe('ok');
    expect(payload.drift.map((finding) => finding.id)).not.toContain('orchestrator-report-retired');
    expect(read.report?.status).toBe('unverified');
    const observed = payload.resources
      .filter((resource) => resource.actualObserved)
      .map((resource) => resource.resource.id);
    expect(observed.sort()).toEqual(['lakebase']);
  });
});

describe('saving a workspace notebook path', () => {
  it('prefers a saved path, falls back to the optional environment value, and otherwise stays empty', () => {
    const saved = new Map([
      [
        'notebook-path',
        {
          resourceId: 'notebook-path',
          value: '/Shared/saved',
          intent: 'active' as const,
          updatedAt: '',
          updatedBy: '',
          note: '',
        },
      ],
    ]);
    expect(configuredNotebookPath(saved, { PLAYER_INSIGHTS_NOTEBOOK_PATH: '/Shared/default' })).toBe('/Shared/saved');
    expect(configuredNotebookPath(new Map(), { PLAYER_INSIGHTS_NOTEBOOK_PATH: '/Shared/default' })).toBe(
      '/Shared/default'
    );
    expect(configuredNotebookPath(new Map(), {})).toBe('');
  });

  it('stores the validated path under its own setting without replacing the declarations table', async () => {
    const write = vi.fn(
      (_appkit: unknown, setting: Parameters<typeof import('../lib/app-settings').writeStoredSetting>[1]) =>
        Promise.resolve({
          ...setting,
          updatedAt: '2026-08-19T16:00:00.000Z',
        })
    );
    const result = await validateAndStoreNotebookPath({
      appkit: appkitAnswering({}),
      path: '/Shared/player-insights',
      host: 'https://workspace.invalid',
      token: 'user-token',
      updatedBy: 'admin@example.invalid',
      validate: vi.fn(() => Promise.resolve({ ok: true as const, path: '/Shared/player-insights' })),
      write: write as typeof import('../lib/app-settings').writeStoredSetting,
    });
    expect(result.ok).toBe(true);
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resourceId: 'notebook-path',
        value: '/Shared/player-insights',
        intent: 'active',
      })
    );
  });

  it('does not write a folder or a notebook the user cannot read', async () => {
    const write = vi.fn();
    const result = await validateAndStoreNotebookPath({
      appkit: appkitAnswering({}),
      path: '/Shared/folder',
      host: 'https://workspace.invalid',
      token: 'user-token',
      updatedBy: 'admin@example.invalid',
      validate: vi.fn(() =>
        Promise.resolve({
          ok: false as const,
          status: 400 as const,
          detail: 'Choose a notebook, not a workspace folder.',
        })
      ),
      write: write as typeof import('../lib/app-settings').writeStoredSetting,
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(write).not.toHaveBeenCalled();
  });
});

describe('the release declaration', () => {
  it('is the exact settings document Python consumes, with a stable revision', () => {
    const plan = {
      knobs: [
        { key: 'warehouse_id', label: 'Warehouse', value: 'wh-1', source: 'intended' as const, envVar: 'X' },
        { key: 'catalog', label: 'Catalog', value: 'catalog_a', source: 'notebook' as const, envVar: 'Y' },
      ],
      notes: [],
      command: 'unused',
      hasOverrides: true,
    };
    const first = releaseDeclaration(plan);
    const second = releaseDeclaration({ ...plan, knobs: [...plan.knobs].reverse() });
    expect(first.settings).toEqual({ warehouse_id: 'wh-1', catalog: 'catalog_a' });
    expect(first.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.revision).toBe(first.revision);
  });
});
