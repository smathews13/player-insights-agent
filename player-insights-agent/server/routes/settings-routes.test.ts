import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configuredNotebookPath,
  readOrchestratorReport,
  releaseDeclaration,
  validateAndStoreNotebookPath,
} from './settings-routes';
import { extractConfigurationReport, type InsightsAppKit, type ServingTransport } from './insights-routes';
import { resourceStates, settingsPayload } from '../lib/app-settings';

/**
 * What the endpoint says it is configured with has to survive the trip.
 *
 * These tests exist because it did not. `extractPreflightReport` looks for
 * `custom_outputs.preflight`, the shape from when the endpoint still ran
 * dependency checks; every current version answers `preflight_retired` and puts
 * its configuration at the top level of `custom_outputs`. This route read the
 * configuration through that same function, so the parse failed and the route
 * returned no report at all -- and the Connections pane, given nothing to compare
 * the app's environment against, showed every single connection as "configured,
 * unmeasured" against an endpoint that was answering perfectly well.
 *
 * The lesson worth pinning is narrow: a route that wants the CONFIGURATION must
 * not read it through a parser whose subject is the CHECKS. The fixture below is
 * therefore the literal payload `agent.py::_preflight_retired` returns, so a
 * change on either side that separates them fails here.
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

// `invokeServing` throws without it, which would make every case below look like
// an unreachable endpoint rather than exercising what came back.
beforeEach(() => {
  process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'an-endpoint';
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

describe('what /api/settings makes of an endpoint that answered', () => {
  it('reports the configuration instead of discarding it', async () => {
    const read = await readOrchestratorReport(
      appkitAnswering(retiredPreflight([entry('catalog', 'a_catalog'), entry('sql_warehouse_id', 'abc123')]))
    );
    expect(read.answered).toBe(true);
    expect(read.report?.configuration.map((item) => item.key)).toEqual(['catalog', 'sql_warehouse_id']);
  });

  it('carries the build stamp the version reported, rather than calling it unstamped', async () => {
    // Left empty, the app tells an operator the served model "predates the build
    // stamp" and should be re-logged, while holding its stamp in the list beside
    // that sentence. The stamp is reported as a setting rather than as a field of
    // a report, which is exactly why it was being lost.
    const read = await readOrchestratorReport(
      appkitAnswering(retiredPreflight([entry('build_sha', 'deadbeef'), entry('catalog', 'a_catalog')]))
    );
    expect(read.report?.build_sha).toBe('deadbeef');
  });

  it('claims nothing about health, because nothing behind the endpoint was probed', async () => {
    const read = await readOrchestratorReport(appkitAnswering(retiredPreflight([entry('catalog', 'a_catalog')])));
    expect(read.report?.status).toBe('unverified');
    expect(read.report?.checked_at).toBe('');
    // The serving identity is only in the retired report. Unknown is the honest
    // answer; printing the app's own principal here would be a fabrication.
    expect(read.report?.principal).toBe('');
    expect(read.report?.principal_resolved).toBe(false);
    expect(read.report?.assumptions).toEqual([]);
  });

  it('keeps the two checks the app can make for itself', async () => {
    const read = await readOrchestratorReport(appkitAnswering(retiredPreflight([entry('catalog', 'a_catalog')])));
    const ids = read.report?.checks.map((check) => check.id) ?? [];
    expect(ids).toContain('agent-endpoint');
    expect(ids.some((id) => id.includes('lakebase'))).toBe(true);
  });

  it('separates an endpoint that said nothing from one that could not be reached', async () => {
    const silent = await readOrchestratorReport(appkitAnswering({ custom_outputs: { type: 'preflight_retired' } }));
    expect(silent).toEqual({ report: null, answered: true });

    const unreachable = await readOrchestratorReport(appkit(() => Promise.reject(new Error('endpoint is not ready'))));
    expect(unreachable).toEqual({ report: null, answered: false });
  });

  it('gives the pane a configured value to show, which is the bug the user saw', async () => {
    const read = await readOrchestratorReport(appkitAnswering(retiredPreflight([entry('catalog', 'a_catalog')])));
    const states = resourceStates({ report: read.report, environment: {}, stored: new Map() });
    const catalog = states.find((state) => state.resource.id === 'catalog');
    expect(catalog?.configured).toBe('a_catalog');
    expect(catalog?.configuredFrom).toBe('artifact');
  });

  /**
   * COMPOSED THROUGH TO THE VERDICT A READER ACTUALLY SEES, which is the step this
   * file was missing when it let a regression out.
   *
   * The test above it asserts `status: 'unverified'` on the report, and passed
   * throughout: the report said unverified while the payload built from it said
   * `ok`, because the synthesised report claimed `source: 'agent'` and the drift
   * check reads that as "an agent measured these". Nothing asserted the two
   * agreed, so the page reported nineteen unmeasured connections as agreeing and
   * the suite stayed green.
   */
  it('does not let the page claim agreement it never measured', async () => {
    const read = await readOrchestratorReport(
      appkitAnswering(retiredPreflight([entry('build_sha', 'deadbeef'), entry('catalog', 'a_catalog')]))
    );
    const payload = settingsPayload({
      report: read.report,
      environment: {},
      stored: new Map(),
      appBuildSha: 'deadbeef',
      storeAvailable: true,
      endpointAnswered: read.answered,
    });

    // Unknown, not ok, on a deployment whose stamps MATCH: agreement between two
    // configured values is not evidence, and this is the case that read as clean.
    expect(payload.status).toBe('unknown');
    expect(payload.drift.map((finding) => finding.id)).toContain('orchestrator-report-retired');
    // The report's own verdict and the page's verdict have to be the same claim.
    expect(read.report?.status).toBe('unverified');
    // The only rows carrying an observed value are the two the APP measured for
    // itself: whether it can reach the endpoint, and whether it can reach its own
    // store. Neither needs the orchestrator's cooperation, so both are real. Every
    // row that would need the endpoint to have checked something stays unmeasured.
    const observed = payload.resources
      .filter((resource) => resource.actualObserved)
      .map((resource) => resource.resource.id);
    expect(observed.sort()).toEqual(['agent-endpoint', 'lakebase']);
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
    expect(configuredNotebookPath(saved, { PLAYER_INSIGHTS_NOTEBOOK_PATH: '/Shared/default' })).toBe(
      '/Shared/saved',
    );
    expect(configuredNotebookPath(new Map(), { PLAYER_INSIGHTS_NOTEBOOK_PATH: '/Shared/default' })).toBe(
      '/Shared/default',
    );
    expect(configuredNotebookPath(new Map(), {})).toBe('');
  });

  it('stores the validated path under its own setting without replacing the declarations table', async () => {
    const write = vi.fn(async (_appkit, setting) => ({
      ...setting,
      updatedAt: '2026-08-19T16:00:00.000Z',
    }));
    const result = await validateAndStoreNotebookPath({
      appkit: appkitAnswering({}),
      path: '/Shared/player-insights',
      host: 'https://workspace.invalid',
      token: 'user-token',
      updatedBy: 'admin@example.invalid',
      validate: vi.fn(async () => ({ ok: true as const, path: '/Shared/player-insights' })),
      write: write as typeof import('../lib/app-settings').writeStoredSetting,
    });
    expect(result.ok).toBe(true);
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resourceId: 'notebook-path',
        value: '/Shared/player-insights',
        intent: 'active',
      }),
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
      validate: vi.fn(async () => ({
        ok: false as const,
        status: 400 as const,
        detail: 'Choose a notebook, not a workspace folder.',
      })),
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
