/**
 * Whether this deployment is doing what it was configured to do.
 *
 * The claim these tests defend is narrow and load-bearing: the page must never
 * report agreement it did not measure. Every finding below distinguishes three
 * states that a naive comparison collapses into two, configured and actual
 * agree, they disagree, and nothing established what actual is. The third is the
 * one that has burned this project: configuration that looked set and was inert
 * at serving time, twice, once serving our own demo data.
 */
import { describe, expect, it } from 'vitest';
import {
  APP_RUNTIME_RESOLVERS,
  appEnvironment,
  classifyWrite,
  computeDrift,
  driftStatus,
  resolveJudgeEndpoint,
  resourceStates,
  settingsPayload,
  type StoredSetting,
} from './app-settings';
import { RUNTIME_EDITABLE_IDS } from '../../shared/deployment-config';
import type { PreflightReport } from '../routes/insights-routes';

type Check = PreflightReport['checks'][number];

function check(partial: Partial<Check> & { id: string }): Check {
  return {
    kind: 'resource',
    name: '',
    status: 'ok',
    detail: '',
    verified: true,
    blocking: false,
    evidence: null,
    remedy: null,
    ...partial,
  } as Check;
}

type Configured = PreflightReport['configuration'][number];

/**
 * The settings that name one workspace's data, from `agent/config.py`'s
 * `REQUIRED_KEYS`.
 */
const REQUIRED_KEYS = [
  'catalog',
  'schema',
  'warehouse_id',
  'data_genie_space_id',
  'dictionary_genie_space_id',
];

/**
 * A resolved orchestrator setting, as `Settings.configuration_report()` emits it.
 *
 * The defaults describe a setting baked into the model artifact, which every key
 * these tests use is. `source` defaults to `artifact` because that is the only
 * provenance a correctly released version reports: the test about a value that
 * leaked in from a shell overrides it, since that is the thing it is testing.
 * `env_var` is empty as a report from a version logged before the field existed
 * carries it, and because no assertion here reads it.
 */
function configured(partial: Partial<Configured> & { key: string }): Configured {
  return {
    env_var: '',
    value: '',
    source: 'artifact',
    mutability: 'model-version',
    baked: true,
    required: REQUIRED_KEYS.includes(partial.key),
    ...partial,
  } as Configured;
}

function report(partial: Partial<PreflightReport> = {}): PreflightReport {
  return {
    checked_at: '2026-08-05T12:00:00Z',
    status: 'ok',
    principal: 'sp-1',
    principal_resolved: true,
    table_source: 'manifest',
    build_sha: 'aaaa1111',
    configuration: [],
    checks: [],
    assumptions: [],
    counts: { ok: 1, failed: 0, unverified: 0 },
    source: 'agent',
    ...partial,
  } as PreflightReport;
}

function stored(...settings: Array<Partial<StoredSetting> & { resourceId: string }>) {
  return new Map(settings.map((setting) => [
      setting.resourceId,
      {
        value: '',
        intent: 'intended' as const,
        note: '',
        updatedAt: '2026-08-05T11:00:00Z',
        updatedBy: 'someone@example.com',
        ...setting,
      },
    ])
  );
}

function states(input: Parameters<typeof resourceStates>[0]) {
  return resourceStates(input);
}

function state(all: ReturnType<typeof resourceStates>, id: string) {
  return all.find((entry) => entry.resource.id === id)!;
}

describe('lining up configured against actual', () => {
  it('takes the value in use from the check that ran inside the endpoint', () => {
    // The whole basis of the comparison. The orchestrator's own report of what it
    // resolved is a claim; a check that reached the space and came back names what
    // it actually used.
    const all = states({
      report: report({
        configuration: [configured({ key: 'data_genie_space_id', value: '01f0-configured' })],
        checks: [check({ id: 'genie-data', kind: 'genie', name: '01f0-in-use' })],
      }),
      environment: {},
      stored: stored(),
    });

    expect(state(all, 'genie-data').configured).toBe('01f0-configured');
    expect(state(all, 'genie-data').actual).toBe('01f0-in-use');
    expect(state(all, 'genie-data').actualObserved).toBe(true);
  });

  it('does not treat an unmeasured value as agreeing', () => {
    // A check that ran but named nothing proves nothing about a value, and the
    // absence of a name must not read as "the same as configured".
    const all = states({
      report: report({
        configuration: [configured({ key: 'catalog', value: 'acme_catalog' })],
        checks: [check({ id: 'genie-data', kind: 'genie', name: '' })],
      }),
      environment: {},
      stored: stored(),
    });

    expect(state(all, 'catalog').actualObserved).toBe(false);
    expect(state(all, 'catalog').actual).toBe('');
  });

  it('reads app-owned values from the container environment', () => {
    const all = states({
      report: report(),
      environment: { DATABRICKS_SERVING_ENDPOINT_NAME: 'player-insights-agent' },
      stored: stored(),
    });

    expect(state(all, 'agent-endpoint').configured).toBe('player-insights-agent');
    expect(state(all, 'agent-endpoint').configuredFrom).toBe('app-environment');
  });

  it('shows what an unset app variable will actually do', () => {
    // An empty variable is not "no value": the code behind it falls through to a
    // compiled default and the deployment behaves accordingly. A dash here would
    // hide the behaviour the deployer is getting.
    const all = states({ report: report(), environment: {}, stored: stored() });

    expect(state(all, 'judge-endpoint').configured).toMatch(/^databricks-/);
    expect(state(all, 'judge-endpoint').configuredFrom).toBe('app-default');
    expect(state(all, 'shared-conversation-rail').configured).toBe('false');
  });

  it('shows a saved runtime value as the one in force', () => {
    // The page must agree with the code that resolves the value.
    // `resolveJudgeEndpoint` prefers a saved active value over the variable, so
    // reporting the variable here would tell a deployer their change did not take.
    const all = states({
      report: report(),
      environment: { PLAYER_INSIGHTS_JUDGE_ENDPOINT: 'deployed-judge' },
      stored: stored({ resourceId: 'judge-endpoint', value: 'saved-judge', intent: 'active' }),
    });

    expect(state(all, 'judge-endpoint').configured).toBe('saved-judge');
    expect(state(all, 'judge-endpoint').configuredFrom).toBe('app-saved');
    // Not also reported as pending: it is in force, not waiting on anything.
    expect(state(all, 'judge-endpoint').intended).toBeNull();
  });

  it('reads the namespace in use from the tables the orchestrator reached', () => {
    // Worth more than the blank row it replaces: the model version serving this
    // deployment reports no configuration at all, and the table checks are the
    // only evidence of which namespace it actually read.
    const all = states({
      report: report({
        checks: [
          check({ id: 't1', kind: 'table', name: 'acme_catalog.player_insights.players' }),
          check({ id: 't2', kind: 'table', name: 'acme_catalog.player_insights.sessions' }),
        ],
      }),
      environment: {},
      stored: stored(),
    });

    expect(state(all, 'catalog').actual).toBe('acme_catalog');
    expect(state(all, 'schema').actual).toBe('player_insights');
    expect(state(all, 'catalog').actualObserved).toBe(true);
  });

  it('refuses to name one namespace when the tables span several', () => {
    // Picking the most common would invent a single answer where the truth is
    // that there is not one, and this row is read as "what the orchestrator uses".
    const all = states({
      report: report({
        checks: [
          check({ id: 't1', kind: 'table', name: 'cat_a.player_insights.players' }),
          check({ id: 't2', kind: 'table', name: 'cat_b.player_insights.sessions' }),
        ],
      }),
      environment: {},
      stored: stored(),
    });

    expect(state(all, 'catalog').actualObserved).toBe(false);
  });

  it('summarises a long list rather than printing all of it', () => {
    const all = states({
      report: report({
        configuration: [configured({ key: 'catalog_allowlist', value: ['a', 'b', 'c', 'd', 'e'] })],
      }),
      environment: {},
      stored: stored(),
    });

    expect(state(all, 'catalog-allowlist').configured).toBe('5 entries');
  });
});

describe('what the page refuses to call healthy', () => {
  it('reports everything as unmeasured when the orchestrator did not answer', () => {
    // The most important failure mode on the page. Without this the app-side half
    // renders normally and a deployer reads a page of green rows about an
    // orchestrator that never replied.
    const findings = computeDrift({ report: null, states: [], appBuildSha: 'aaaa1111' });

    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('orchestrator-unreachable');
    expect(driftStatus(findings)).toBe('unknown');
  });

  it('tells an old model version apart from one that reported no drift', () => {
    // A version logged before the configuration report existed sends no
    // configuration block. Reading that absence as "nothing to report" would turn
    // "we cannot see it" into "we checked and it is fine".
    const findings = computeDrift({
      report: report({ configuration: [] }),
      states: [],
      appBuildSha: 'aaaa1111',
    });

    expect(findings.map((finding) => finding.id)).toContain('configuration-unreported');
    expect(driftStatus(findings)).toBe('unknown');
  });

  it('flags an orchestrator value that did not come from the model artifact', () => {
    // config.py exists to make this impossible, and this is that guarantee seen
    // from outside: a serving container resolving a Genie space id from a shell
    // has no record in its model version of where its data came from.
    const all = states({
      report: report({
        configuration: [configured({ key: 'warehouse_id', value: 'wh-leaked', source: 'environment' })],
      }),
      environment: {},
      stored: stored(),
    });
    const findings = computeDrift({ report: report(), states: all, appBuildSha: 'aaaa1111' });

    const provenance = findings.find((finding) => finding.id === 'provenance-sql-warehouse');
    expect(provenance?.severity).toBe('blocking');
    expect(provenance?.remedy).toContain('agent-release.sh');
    expect(driftStatus(findings)).toBe('blocked');
  });

  it('accepts a value that came from the artifact', () => {
    const all = states({
      report: report({
        configuration: [configured({ key: 'warehouse_id', value: 'wh-acme' })],
      }),
      environment: {},
      stored: stored(),
    });

    expect(computeDrift({ report: report(), states: all, appBuildSha: 'aaaa1111' })
      .map((finding) => finding.id)).not.toContain('provenance-sql-warehouse');
  });

  it('flags a resource in use that is not the one configured', () => {
    // The single most valuable thing this page can say, and the reason it shows
    // two columns rather than one.
    const all = states({
      report: report({
        configuration: [configured({ key: 'data_genie_space_id', value: 'space-configured' })],
        checks: [check({ id: 'genie-data', kind: 'genie', name: 'space-actually-used' })],
      }),
      environment: {},
      stored: stored(),
    });
    const findings = computeDrift({ report: report(), states: all, appBuildSha: 'aaaa1111' });

    const mismatch = findings.find((finding) => finding.id === 'mismatch-genie-data');
    expect(mismatch?.severity).toBe('blocking');
    expect(mismatch?.detail).toContain('space-actually-used');
  });
});

describe('a value somebody saved but nobody applied', () => {
  it('is reported as pending rather than as the value', () => {
    // The lie this surface was built to avoid. Saving a Genie space id records an
    // intention; the orchestrator keeps using the one in its artifact until a new
    // model version carries the change.
    const all = states({
      report: report({
        configuration: [configured({ key: 'data_genie_space_id', value: 'space-old' })],
      }),
      environment: {},
      stored: stored({ resourceId: 'genie-data', value: 'space-new', intent: 'intended' }),
    });
    const findings = computeDrift({ report: report(), states: all, appBuildSha: 'aaaa1111' });

    const pending = findings.find((finding) => finding.id === 'pending-genie-data');
    expect(pending?.severity).toBe('pending');
    expect(pending?.detail).toContain('changed nothing about the running system');
    expect(pending?.remedy).toContain('agent-release.sh');
    expect(state(all, 'genie-data').intended).toBe('space-new');
  });

  it('stops being pending once the deployment actually uses it', () => {
    // How a deployer confirms a release landed: the finding disappears because the
    // endpoint now reports the value that was intended.
    const all = states({
      report: report({
        configuration: [configured({ key: 'data_genie_space_id', value: 'space-new' })],
        checks: [check({ id: 'genie-data', kind: 'genie', name: 'space-new' })],
      }),
      environment: {},
      stored: stored({ resourceId: 'genie-data', value: 'space-new', intent: 'intended' }),
    });

    expect(computeDrift({ report: report(), states: all, appBuildSha: 'aaaa1111' })
      .map((finding) => finding.id)).not.toContain('pending-genie-data');
  });

  it('never presents an orchestrator setting as editable', () => {
    const all = states({ report: report(), environment: {}, stored: stored() });

    expect(state(all, 'genie-data').editable).toBe(false);
    expect(state(all, 'judge-endpoint').editable).toBe(true);
  });
});

describe('app against orchestrator', () => {
  it('reports skew between the two builds', () => {
    const findings = computeDrift({
      report: report({ build_sha: 'bbbb2222', configuration: [configured({ key: 'catalog', value: 'c' })] }),
      states: [],
      appBuildSha: 'aaaa1111',
    });

    const skew = findings.find((finding) => finding.id === 'build-skew');
    expect(skew?.severity).toBe('warning');
    expect(skew?.detail).toContain('aaaa1111');
    expect(skew?.detail).toContain('bbbb2222');
  });

  it('says the comparison is impossible rather than passing it', () => {
    // An unstamped build must not read as a matching one. This is the case that
    // exists in production today, where the app carries no stamp at all.
    const findings = computeDrift({
      report: report({ configuration: [configured({ key: 'catalog', value: 'c' })] }),
      states: [],
      appBuildSha: '',
    });

    expect(findings.map((finding) => finding.id)).toContain('build-skew-unknown');
    expect(findings.map((finding) => finding.id)).not.toContain('build-skew');
    expect(driftStatus(findings)).toBe('unknown');
  });

  it('reports a build made from a modified worktree', () => {
    const findings = computeDrift({
      report: report({ build_sha: 'aaaa1111', configuration: [configured({ key: 'catalog', value: 'c' })] }),
      states: [],
      appBuildSha: 'aaaa1111+dirty',
    });

    expect(findings.find((finding) => finding.id === 'build-dirty')?.severity).toBe('warning');
  });

  it('is quiet when the two agree and everything was measured', () => {
    const findings = computeDrift({
      report: report({ build_sha: 'aaaa1111', configuration: [configured({ key: 'catalog', value: 'c' })] }),
      states: [],
      appBuildSha: 'aaaa1111',
    });

    expect(findings).toEqual([]);
    expect(driftStatus(findings)).toBe('ok');
  });
});

describe('refusing a write the app cannot honour', () => {
  it('refuses to make an orchestrator setting active, and says what would', () => {
    // Not downgraded to an intention silently. A caller that asked to apply a
    // customer's Genie space id has to be told it did not, or it will report
    // success to the customer.
    const decision = classifyWrite('genie-data', 'active');

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toContain('agent-release.sh');
      expect(decision.reason).toContain('intended value');
    }
  });

  it('accepts an intention for an orchestrator setting', () => {
    expect(classifyWrite('genie-data', 'intended')).toEqual({
      ok: true,
      intent: 'intended',
      changedBy: 'model-version',
    });
  });

  it('accepts an immediate change only where the app re-reads the value', () => {
    expect(classifyWrite('judge-endpoint', 'active')).toEqual({
      ok: true,
      intent: 'active',
      changedBy: 'app-runtime',
    });
  });

  it('refuses an intention for something no command here can apply', () => {
    // The Lakebase schema is a literal in app source. Recording an intended value
    // would suggest this app could act on it.
    const decision = classifyWrite('lakebase-schema', 'intended');

    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('editing the source');
  });

  it('refuses a resource this deployment does not have', () => {
    expect(classifyWrite('genie-space-from-a-different-app', 'intended').ok).toBe(false);
  });
});

describe('the judge model a benchmark run scores with', () => {
  const client = (rows: Record<string, unknown>[]) => ({
    lakebase: { query: async () => ({ rows }) },
  });

  it('prefers a value saved in the app', async () => {
    const resolved = await resolveJudgeEndpoint(client([{ resource_id: 'judge-endpoint', value: 'saved-judge', intent: 'active', updated_by: 'a@b.c' }])
    );

    expect(resolved).toBe('saved-judge');
  });

  it('ignores an intention, which is not the same as a saved value', async () => {
    // An `intended` row is a note about a future release. Scoring with it would
    // make the store's two meanings interchangeable.
    const resolved = await resolveJudgeEndpoint(client([{ resource_id: 'judge-endpoint', value: 'someday-judge', intent: 'intended', updated_by: 'a@b.c' }])
    );

    expect(resolved).not.toBe('someday-judge');
  });

  it('falls back to the compiled default when the store is unreachable', async () => {
    // Benchmarking must not fail because a settings table is missing. The default
    // is what every deployment used before this was configurable at all.
    const broken = {
      lakebase: {
        query: async () => {
          throw new Error('relation "player_insights.deployment_settings" does not exist');
        },
      },
    };

    await expect(resolveJudgeEndpoint(broken)).resolves.toMatch(/^databricks-/);
  });
});

/**
 * The promise the `app-runtime` tier makes, enforced structurally.
 */
describe('every app-runtime resource is actually read at serving time', () => {
  const client = (rows: Record<string, unknown>[]) => ({
    lakebase: { query: async () => ({ rows }) },
  });

  it('has a resolver for each id the settings form may write', () => {
    expect(Object.keys(APP_RUNTIME_RESOLVERS).sort()).toEqual([...RUNTIME_EDITABLE_IDS].sort());
  });

  it.each(RUNTIME_EDITABLE_IDS)('reads a saved active value for %s', async (resourceId) => {
    const resolve = APP_RUNTIME_RESOLVERS[resourceId];
    expect(resolve).toBeTypeOf('function');

    const resolved = await resolve(client([
        {
          resource_id: resourceId,
          value: `saved-${resourceId}`,
          intent: 'active',
          updated_by: 'deployer@acme.com',
        },
      ])
    );

    // The whole tier reduces to this line. If a saved active value does not come
    // back out of the resolver, the pane's "in force" is a guess.
    expect(resolved).toBe(`saved-${resourceId}`);
  });

  it.each(RUNTIME_EDITABLE_IDS)('ignores an intention for %s', async (resourceId) => {
    const resolved = await APP_RUNTIME_RESOLVERS[resourceId](client([
        {
          resource_id: resourceId,
          value: `someday-${resourceId}`,
          intent: 'intended',
          updated_by: 'deployer@acme.com',
        },
      ])
    );

    expect(resolved).not.toBe(`someday-${resourceId}`);
  });
});

describe('the whole payload', () => {
  it('says whether the orchestrator reported its own configuration', () => {
    const withReport = settingsPayload({
      report: report({ configuration: [configured({ key: 'catalog', value: 'c' })] }),
      environment: {},
      stored: stored(),
      appBuildSha: 'aaaa1111',
      storeAvailable: true,
    });
    const without = settingsPayload({
      report: report({ configuration: [] }),
      environment: {},
      stored: stored(),
      appBuildSha: 'aaaa1111',
      storeAvailable: true,
    });

    expect(withReport.orchestratorReported).toBe(true);
    expect(without.orchestratorReported).toBe(false);
  });

  it('carries the sentence explaining each row rather than only a label', () => {
    const payload = settingsPayload({
      report: report(),
      environment: {},
      stored: stored(),
      appBuildSha: 'aaaa1111',
      storeAvailable: true,
    });

    for (const resource of payload.resources) {
      expect(resource.changedByLabel.length).toBeGreaterThan(3);
      expect(resource.changedByNote.length).toBeGreaterThan(40);
    }
  });

  it('reads app-owned values from the process environment, once', () => {
    const before = process.env.PLAYER_INSIGHTS_JUDGE_ENDPOINT;
    process.env.PLAYER_INSIGHTS_JUDGE_ENDPOINT = 'env-judge';
    try {
      expect(appEnvironment().PLAYER_INSIGHTS_JUDGE_ENDPOINT).toBe('env-judge');
    } finally {
      if (before === undefined) delete process.env.PLAYER_INSIGHTS_JUDGE_ENDPOINT;
      else process.env.PLAYER_INSIGHTS_JUDGE_ENDPOINT = before;
    }
  });
});
