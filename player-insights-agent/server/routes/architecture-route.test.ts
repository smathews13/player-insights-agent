import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARCHITECTURE_EXPERIMENT_TIMEOUT_MS,
  architecturePayload,
  semanticIndexReport,
} from './architecture-routes';
import type { InsightsAppKit } from './insights-routes';

/**
 * An appkit whose Lakebase answers nothing, which is the shape the settings
 * resolver degrades on. The route must still answer.
 */
function appkitWith(rows: Record<string, unknown>[] | Error): InsightsAppKit {
  return {
    lakebase: {
      query: vi.fn(() => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve({ rows }))),
    },
  } as unknown as InsightsAppKit;
}

const VARIABLES = [
  'DATABRICKS_HOST',
  'DATABRICKS_SERVING_ENDPOINT_NAME',
  'DATABRICKS_SQL_WAREHOUSE_ID',
  'PLAYER_INSIGHTS_EXPERIMENT_ID',
  'PLAYER_INSIGHTS_EXPERIMENT_PATH',
  'PLAYER_INSIGHTS_BUILD_SHA',
  'DATABRICKS_CLIENT_ID',
];

describe('architecturePayload', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const variable of VARIABLES) {
      saved.set(variable, process.env[variable]);
      delete process.env[variable];
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const [variable, value] of saved) {
      if (value === undefined) delete process.env[variable];
      else process.env[variable] = value;
    }
  });

  it('reads every value from the environment rather than from a literal', async () => {
    process.env.DATABRICKS_HOST = 'example-workspace.invalid';
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'an-endpoint';
    process.env.DATABRICKS_SQL_WAREHOUSE_ID = 'wh1';
    process.env.PLAYER_INSIGHTS_BUILD_SHA = 'abc1234';
    process.env.DATABRICKS_CLIENT_ID = 'a-principal';

    const payload = await architecturePayload(appkitWith([]));

    expect(payload.workspaceHost).toBe('https://example-workspace.invalid');
    expect(payload.canDeepLink).toBe(true);
    expect(payload.servingEndpoint).toEqual({ value: 'an-endpoint', variable: 'DATABRICKS_SERVING_ENDPOINT_NAME' });
    expect(payload.appWarehouse).toEqual({ value: 'wh1', variable: 'DATABRICKS_SQL_WAREHOUSE_ID' });
    expect(payload.appBuildSha).toBe('abc1234');
    expect(payload.appServicePrincipal).toBe('a-principal');
  });

  /**
   * The state a deployment is in when nobody set DATABRICKS_HOST. Every node
   * on the page then renders its identifier with nothing to click, which is the
   * behaviour honesty rule 4 asks for.
   */
  it('reports no host rather than guessing one', async () => {
    const payload = await architecturePayload(appkitWith([]));
    expect(payload.workspaceHost).toBe('');
    expect(payload.canDeepLink).toBe(false);
  });

  /**
   * An empty value keeps the name of the variable that is unset, so the page
   * can say which one to go and set instead of rendering a blank.
   */
  it('names the variable behind a value that is not set', async () => {
    const payload = await architecturePayload(appkitWith([]));
    expect(payload.servingEndpoint).toEqual({ value: '', variable: 'DATABRICKS_SERVING_ENDPOINT_NAME' });
    expect(payload.appWarehouse).toEqual({ value: '', variable: 'DATABRICKS_SQL_WAREHOUSE_ID' });
  });

  it('prefers a saved experiment override to the variable, as the trace links do', async () => {
    process.env.PLAYER_INSIGHTS_EXPERIMENT_ID = 'from-the-variable';
    const payload = await architecturePayload(appkitWith([
        { resource_id: 'experiment-id', value: 'saved-here', intent: 'active', note: '', updated_at: '', updated_by: '' },
      ])
    );
    expect(payload.experimentId).toBe('saved-here');
  });

  it('falls back to the variable when nothing was saved', async () => {
    process.env.PLAYER_INSIGHTS_EXPERIMENT_ID = 'from-the-variable';
    const payload = await architecturePayload(appkitWith([]));
    expect(payload.experimentId).toBe('from-the-variable');
  });

  // The page explains a degraded deployment, so it must not fail with it.
  it('still answers when the store is down', async () => {
    const payload = await architecturePayload(appkitWith(new Error('lakebase is not answering')));
    expect(payload.experimentId).toBe('');
    expect(payload.readAt).toBeTruthy();
  });

  it('still answers when the experiment lookup never settles', async () => {
    vi.useFakeTimers();
    const appkit = {
      lakebase: { query: vi.fn(() => new Promise(() => undefined)) },
    } as unknown as InsightsAppKit;

    const pending = architecturePayload(appkit);
    await vi.advanceTimersByTimeAsync(ARCHITECTURE_EXPERIMENT_TIMEOUT_MS);
    const payload = await pending;

    expect(payload.experimentId).toBe('');
    expect(payload.readAt).toBeTruthy();
  });

  it('does not invoke the serving endpoint', async () => {
    const appkit = appkitWith([]);
    await architecturePayload(appkit);
    // Only the settings read. An endpoint invocation on first paint is the cold
    // start this route exists to avoid, and it would arrive as a second client.
    expect(Object.keys(appkit as unknown as Record<string, unknown>)).toEqual(['lakebase']);
  });
});

describe('semanticIndexReport', () => {
  /**
   * This route used to be where the app admitted it could not tell whether a
   * deployment had an index. It can now: the orchestrator reports the setting,
   * `semantic-index` is a registry entry, and the value arrives through
   * `/api/settings` with every other connection. What is left here is the half
   * that route cannot say.
   */
  it('names the variable that decides it, so a deployer can go and look', () => {
    expect(semanticIndexReport().decidedBy).toBe('PLAYER_INSIGHTS_SEMANTIC_INDEX');
  });

  it('says changing it means logging a model rather than editing a setting', () => {
    expect(semanticIndexReport().reason).toMatch(/logging a new model version/i);
  });

  it('does not restate a value that now arrives with the connections', () => {
    // Two sources for one fact is how a page comes to contradict itself. This one
    // explains the mechanism; the node beside it reports the state.
    const report = semanticIndexReport() as unknown as Record<string, unknown>;
    expect(report.state).toBeUndefined();
    expect(report.value).toBeUndefined();
  });
});
