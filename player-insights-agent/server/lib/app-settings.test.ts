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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_RUNTIME_RESOLVERS,
  appEnvironment,
  classifyWrite,
  computeDrift,
  driftStatus,
  forgetResolvedExperimentIds,
  readStoredSettings,
  resolveExperimentId,
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

/**
 * A reported setting carrying a field no TypeScript signature would allow.
 *
 * Built past the types deliberately. The orchestrator's report arrives over the
 * wire from a model version that was logged separately from this build, and its
 * schema keeps `value` open on purpose so a version reporting something this
 * build has never heard of does not fail the parse and cost the page every other
 * value. Nothing in the type system polices what actually turns up there, so the
 * tests that matter cannot be written inside it.
 */
function unreadable(partial: Record<string, unknown> & { key: string }): Configured {
  return { ...configured({ key: partial.key }), ...partial } as unknown as Configured;
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

/** A settings store that answers with exactly these rows. */
const client = (rows: Record<string, unknown>[]) => ({
  lakebase: { query: () => Promise.resolve({ rows }) },
});

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

  it('keeps every list entry rather than summarising the count', () => {
    // The Connections page labels each data_catalogs entry as a whole catalog
    // or a single schema. "5 entries" threw the names away, which is exactly
    // the boundary a customer needs to see.
    const all = states({
      report: report({
        configuration: [configured({ key: 'catalog_allowlist', value: ['a', 'b', 'c', 'd', 'e'] })],
      }),
      environment: {},
      stored: stored(),
    });

    expect(state(all, 'catalog-allowlist').configured).toBe('a, b, c, d, e');
  });

  it('shows nothing for a list it could only half read', () => {
    // A list joined element-wise puts `[object Object]` in the middle of an
    // otherwise plausible sentence, which is the worst of the three outcomes: a
    // reader skims past it and takes the readable half as the whole answer.
    const all = states({
      report: report({
        configuration: [unreadable({ key: 'catalog_allowlist', value: [{ catalog: 'a' }, 'b'] })],
      }),
      environment: {},
      stored: stored(),
    });

    expect(state(all, 'catalog-allowlist').configured).toBe('');
  });
});

describe('what the page refuses to call healthy', () => {
  it('reports everything as unmeasured when the orchestrator did not answer', () => {
    // The most important failure mode on the page. Without this the app-side half
    // renders normally and a deployer reads a page of green rows about an
    // orchestrator that never replied.
    const findings = computeDrift({ report: null, states: [] });

    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('orchestrator-unreachable');
    expect(driftStatus(findings)).toBe('unknown');
  });

  /**
   * An endpoint that answered without a report is not an endpoint that failed.
   * Both leave the values below unconfirmed, so both stay `unknown`, but only
   * one of them is a fault. The page said the endpoint had not answered while
   * `/api/preflight` said it had, on the same deployment, at the same moment,
   * and this is the page a deployer would show a customer as proof of wiring.
   */
  it('does not call a retired report an endpoint that failed to answer', () => {
    const findings = computeDrift({
      report: null,
      states: [],
      endpointAnswered: true,
    });

    expect(findings.map((finding) => finding.id)).toEqual(['orchestrator-report-retired']);
    // Still unknown: nothing below was measured either way.
    expect(driftStatus(findings)).toBe('unknown');
    const [finding] = findings;
    expect(finding.headline).not.toMatch(/could not be read|did not answer/i);
    /**
     * The claim, not a word. This asserted /reachable/ and so failed when the copy
     * was rewritten to say "answering normally" — a rewrite that made the notice
     * MORE of what this test is defending, because the reader who prompted it had
     * just told us the old wording did not land. Pinning vocabulary makes a test
     * argue against its own purpose the first time somebody improves the sentence.
     *
     * What has to hold is that a reader learns nothing is wrong. Both halves are
     * asserted: it says so, and it does not say the opposite.
     */
    expect(finding.detail).toMatch(/nothing here means anything is broken/i);
    expect(finding.detail).not.toMatch(/did not (reply|answer)|failed/i);
    // No remedy, because there is nothing to do. A remedy offered when nothing
    // is wrong is one nobody reads when something is.
    expect(finding.remedy).toBe('');
  });

  /**
   * THE TEST ABOVE WENT ON PASSING THROUGH THE DEFECT IT GUARDS, because the
   * route stopped producing `report: null` on this path and started synthesising
   * a report from the configuration. The invariant was still asserted, against an
   * input the app no longer generates, so the page lost this notice with a green
   * suite.
   *
   * The shape it is fed here is the one the route now builds: values reported,
   * nothing measured, `status: 'unverified'`, and a `source` that is not 'agent'.
   */
  it('says nothing was measured when the endpoint reported values without checking them', () => {
    const findings = computeDrift({
      report: {
        ...report(),
        source: 'configuration',
        status: 'unverified',
        checked_at: '',
        principal: '',
        principal_resolved: false,
        build_sha: 'aaaa1111',
        configuration: [{ key: 'catalog', env_var: '', value: 'main', source: 'artifact', mutability: 'model-version', baked: true, required: true }],
        counts: { ok: 0, failed: 0, unverified: 0 },
      },
      states: [],
      endpointAnswered: true,
    });

    expect(findings.map((finding) => finding.id)).toContain('orchestrator-report-retired');
    expect(driftStatus(findings)).toBe('unknown');
  });

  it('does not turn independent build stamps into a compatibility warning', () => {
    const findings = computeDrift({
      report: {
        ...report(),
        source: 'configuration',
        status: 'unverified',
        build_sha: 'bbbb2222',
        configuration: [{ key: 'build_sha', env_var: '', value: 'bbbb2222', source: 'artifact', mutability: 'model-version', baked: true, required: false }],
        counts: { ok: 0, failed: 0, unverified: 0 },
      },
      states: [],
      endpointAnswered: true,
    });

    const ids = findings.map((finding) => finding.id);
    expect(ids).toContain('orchestrator-report-retired');
    expect(ids).not.toContain('build-skew');
    expect(ids).not.toContain('build-skew-unknown');
    expect(ids).not.toContain('build-freshness');
  });

  it('reports an unanswered endpoint as unreachable when nobody established otherwise', () => {
    // The default matters more than the explicit case: a caller that forgets to
    // say must get the cautious reading, not the quiet one.
    const silent = computeDrift({ report: null, states: [] });
    const explicit = computeDrift({
      report: null,
      states: [],
      endpointAnswered: false,
    });

    expect(silent[0].id).toBe('orchestrator-unreachable');
    expect(explicit[0].id).toBe('orchestrator-unreachable');
  });

  it('tells an old model version apart from one that reported no drift', () => {
    // A version logged before the configuration report existed sends no
    // configuration block. Reading that absence as "nothing to report" would turn
    // "we cannot see it" into "we checked and it is fine".
    const findings = computeDrift({
      report: report({ configuration: [] }),
      states: [],
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
    const findings = computeDrift({ report: report(), states: all });

    const provenance = findings.find((finding) => finding.id === 'provenance-sql-warehouse');
    expect(provenance?.severity).toBe('blocking');
    expect(provenance?.remedy).toContain('agent-release.sh');
    expect(driftStatus(findings)).toBe('blocked');
  });

  it('does not call an optional setting nobody set a provenance failure', () => {
    /**
     * THE LIVE DEFECT THIS PINS. `llm_gateway` is optional and unset on every
     * target: empty means reach the serving endpoint directly. Settings resolves it
     * from its own default, which is neither the artifact nor the app environment,
     * so the provenance loop raised BLOCKING against it — and one blocking finding
     * turns the whole page's status to `blocked`. example read as misconfigured while
     * being in exactly the state its bundle asked for.
     *
     * An empty value names no workspace's data, so both halves of that finding's
     * claim are vacuous: nothing is pointed anywhere, and nothing is granted that
     * could differ from it.
     */
    const all = states({
      report: report({
        configuration: [configured({ key: 'llm_gateway', value: '', source: 'default' })],
      }),
      environment: {},
      stored: stored(),
    });
    const findings = computeDrift({ report: report(), states: all });

    expect(findings.map((finding) => finding.id)).not.toContain('provenance-llm-gateway');
    expect(driftStatus(findings)).not.toBe('blocked');
  });

  it('still flags a value that is present and came from somewhere else', () => {
    // The other half, so the guard above cannot be widened into "default is fine".
    // A NAMED endpoint resolved from a default is the leak the loop exists for.
    const all = states({
      report: report({
        configuration: [
          configured({ key: 'llm_gateway', value: 'gateway-from-a-shell', source: 'default' }),
        ],
      }),
      environment: {},
      stored: stored(),
    });
    const findings = computeDrift({ report: report(), states: all });

    expect(findings.find((finding) => finding.id === 'provenance-llm-gateway')?.severity).toBe('blocking');
    expect(driftStatus(findings)).toBe('blocked');
  });

  /**
   * THE SAME MISTAKE AS THE `llm_gateway` ONE ABOVE, arriving by a different
   * door. That one raised BLOCKING against a value that was empty; this one
   * raises BLOCKING against a value that was never legible in the first place.
   *
   * `String(someObject)` is `'[object Object]'` — a NON-EMPTY string. So every
   * emptiness guard on this page waves it through and every equality test
   * rejects it, and a setting nobody could read is promoted to a setting that
   * loudly disagrees. One blocking finding turns the whole page red.
   */
  it('does not raise a provenance failure about a value it could not read', () => {
    const all = states({
      report: report({
        configuration: [unreadable({ key: 'warehouse_id', value: { id: 'wh-1' }, source: 'environment' })],
      }),
      environment: {},
      stored: stored(),
    });
    const findings = computeDrift({ report: report(), states: all });

    // What the pane prints. '' renders as "not set"; the alternative was the
    // literal words "[object Object]" in the value column of a customer demo.
    expect(state(all, 'sql-warehouse').configured).toBe('');
    expect(findings.map((finding) => finding.id)).not.toContain('provenance-sql-warehouse');
    expect(driftStatus(findings)).not.toBe('blocked');
  });

  it('does not report a disagreement between a measured value and an unreadable one', () => {
    // The other half. `actual` here was genuinely measured inside the endpoint,
    // so only `configured` is in doubt — and a comparison against a value nobody
    // could read is not evidence that the running system is wrong.
    const all = states({
      report: report({
        configuration: [unreadable({ key: 'data_genie_space_id', value: { space: '01f0' } })],
        checks: [check({ id: 'genie-data', kind: 'genie', name: '01f0-in-use' })],
      }),
      environment: {},
      stored: stored(),
    });
    const findings = computeDrift({ report: report(), states: all });

    expect(findings.map((finding) => finding.id)).not.toContain('mismatch-genie-data');
    expect(driftStatus(findings)).not.toBe('blocked');
  });

  it('does not treat a provenance it could not read as a route the artifact did not sanction', () => {
    // `source` is the field the provenance loop branches on. An unreadable one
    // matches neither `artifact` nor `app-environment`, so before the guard it
    // fell straight through to BLOCKING — and printed itself into the sentence,
    // which told the reader their warehouse "was resolved from [object Object]".
    const all = states({
      report: report({
        configuration: [unreadable({ key: 'warehouse_id', value: 'wh-acme', source: { kind: 'artifact' } })],
      }),
      environment: {},
      stored: stored(),
    });
    const findings = computeDrift({ report: report(), states: all });

    expect(state(all, 'sql-warehouse').configuredFrom).toBe('');
    expect(findings.map((finding) => finding.id)).not.toContain('provenance-sql-warehouse');
    expect(driftStatus(findings)).not.toBe('blocked');
  });

  it('accepts a value that came from the artifact', () => {
    const all = states({
      report: report({
        configuration: [configured({ key: 'warehouse_id', value: 'wh-acme' })],
      }),
      environment: {},
      stored: stored(),
    });

    expect(computeDrift({ report: report(), states: all })
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
    const findings = computeDrift({ report: report(), states: all });

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
    const findings = computeDrift({ report: report(), states: all });

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

    expect(computeDrift({ report: report(), states: all })
      .map((finding) => finding.id)).not.toContain('pending-genie-data');
  });

  it('never presents an orchestrator setting as editable', () => {
    const all = states({ report: report(), environment: {}, stored: stored() });

    expect(state(all, 'genie-data').editable).toBe(false);
    expect(state(all, 'judge-endpoint').editable).toBe(true);
  });
});

describe('app against orchestrator', () => {
  it('leaves divergent build stamps as facts instead of warnings', () => {
    const findings = computeDrift({
      report: report({ build_sha: 'bbbb2222', configuration: [configured({ key: 'catalog', value: 'c' })] }),
      states: [],
    });

    expect(findings.map((finding) => finding.id)).not.toContain('build-skew');
  });

  it('leaves an older orchestrator stamp as a fact instead of a finding', () => {
    const findings = computeDrift({
      report: report({ build_sha: '11be12b', configuration: [configured({ key: 'catalog', value: 'c' })] }),
      states: [],
    });

    expect(findings.map((finding) => finding.id)).not.toContain('build-freshness');
    expect(findings.map((finding) => finding.id)).not.toContain('build-skew');
  });

  it('does not warn when either independent stamp is absent', () => {
    const findings = computeDrift({
      report: report({ configuration: [configured({ key: 'catalog', value: 'c' })] }),
      states: [],
    });

    expect(findings.map((finding) => finding.id)).not.toContain('build-skew-unknown');
    expect(findings.map((finding) => finding.id)).not.toContain('build-skew');
    expect(driftStatus(findings)).toBe('ok');
  });

  it('does not turn a dirty build stamp into a Connections finding', () => {
    const findings = computeDrift({
      report: report({ build_sha: 'aaaa1111+dirty', configuration: [configured({ key: 'catalog', value: 'c' })] }),
      states: [],
    });

    expect(findings.map((finding) => finding.id)).not.toContain('build-dirty');
    const spoken = findings.map((finding) => `${finding.headline} ${finding.detail} ${finding.remedy}`).join(' ');
    expect(spoken).not.toMatch(/modified working tree/i);
    expect(spoken).not.toMatch(/clean worktree/i);
  });

  it('is quiet when the two agree and everything was measured', () => {
    const findings = computeDrift({
      report: report({ build_sha: 'aaaa1111', configuration: [configured({ key: 'catalog', value: 'c' })] }),
      states: [],
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

  it('accepts an intention for every connection row an admin can open', () => {
    // Option B: padlocks unlock for admins; recording is not applying. Lakebase
    // schema stays app-redeploy (not live), but an intended value is allowed.
    const decision = classifyWrite('lakebase-schema', 'intended');
    expect(decision).toEqual({
      ok: true,
      intent: 'intended',
      changedBy: 'app-redeploy',
    });
  });

  it('still refuses an active write for something that cannot apply live', () => {
    const decision = classifyWrite('lakebase-schema', 'active');
    expect(decision.ok).toBe(false);
  });

  it('refuses a resource this deployment does not have', () => {
    expect(classifyWrite('genie-space-from-a-different-app', 'intended').ok).toBe(false);
  });
});

describe('the judge model a benchmark run scores with', () => {
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
        query: () =>
          Promise.reject(
            new Error('relation "player_insights.deployment_settings" does not exist')
          ),
      },
    };

    await expect(resolveJudgeEndpoint(broken)).resolves.toMatch(/^databricks-/);
  });

  it('falls back to the compiled default rather than scoring against a value it could not read', async () => {
    // A stored value that is not a scalar used to come back as the string
    // '[object Object]', which is truthy — so an `active` row of that shape was
    // preferred over the default and every benchmark run went looking for a
    // serving endpoint of that name. Unreadable is not the same as chosen.
    const resolved = await resolveJudgeEndpoint(client([
        { resource_id: 'judge-endpoint', value: { endpoint: 'x' }, intent: 'active', updated_by: 'a@b.c' },
      ])
    );

    expect(resolved).toMatch(/^databricks-/);
  });
});

describe('reading the settings table', () => {
  it('reads a column it cannot render as absent rather than as a value', async () => {
    const stored = await readStoredSettings(client([
        {
          resource_id: 'judge-endpoint',
          value: { endpoint: 'x' },
          intent: 'active',
          note: { why: 'because' },
          updated_at: { when: 'now' },
          updated_by: { who: 'someone' },
        },
      ])
    );
    const saved = stored.get('judge-endpoint');

    expect(saved?.value).toBe('');
    expect(saved?.note).toBe('');
    expect(saved?.updatedAt).toBe('');
    expect(saved?.updatedBy).toBe('');
  });

  it('does not file a row under a resource id it cannot read', async () => {
    // The id is the key every lookup on the page goes through. Stringifying a
    // non-scalar one files the row under the literal '[object Object]', which is
    // a key that exists, answers `has`, and belongs to no resource.
    const stored = await readStoredSettings(client([{ resource_id: { id: 'judge-endpoint' }, value: 'x', intent: 'active' }])
    );

    expect(stored.has('[object Object]')).toBe(false);
  });

  it('still reads the columns it is actually given', async () => {
    // The guard must not cost the normal path. A timestamptz arrives as a Date
    // from the driver and has to keep coming back as an instant, not as the
    // local-time sentence `String(date)` would produce.
    const stored = await readStoredSettings(client([
        {
          resource_id: 'judge-endpoint',
          value: 'saved-judge',
          intent: 'active',
          note: 'why',
          updated_at: new Date('2026-08-05T11:00:00Z'),
          updated_by: 'a@b.c',
        },
      ])
    );

    expect(stored.get('judge-endpoint')).toEqual({
      resourceId: 'judge-endpoint',
      value: 'saved-judge',
      intent: 'active',
      note: 'why',
      updatedAt: '2026-08-05T11:00:00.000Z',
      updatedBy: 'a@b.c',
    });
  });
});

/**
 * The promise the `app-runtime` tier makes, enforced structurally.
 */
describe('every app-runtime resource is actually read at serving time', () => {
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

describe('resolving the experiment id', () => {
  const ID = 'PLAYER_INSIGHTS_EXPERIMENT_ID';
  const PATH = 'PLAYER_INSIGHTS_EXPERIMENT_PATH';
  let savedId: string | undefined;
  let savedPath: string | undefined;

  beforeEach(() => {
    savedId = process.env[ID];
    savedPath = process.env[PATH];
    delete process.env[ID];
    delete process.env[PATH];
    forgetResolvedExperimentIds();
  });
  afterEach(() => {
    if (savedId === undefined) delete process.env[ID]; else process.env[ID] = savedId;
    if (savedPath === undefined) delete process.env[PATH]; else process.env[PATH] = savedPath;
    forgetResolvedExperimentIds();
  });

  /** A resolver that records what it was asked, so caching can be observed. */
  const spyResolver = (id: string) => {
    const calls: string[] = [];
    const resolve = (path: string) => {
      calls.push(path);
      return Promise.resolve(id);
    };
    return { calls, resolve };
  };

  it('prefers an active saved override over both the env id and the path', async () => {
    process.env[ID] = 'from-env';
    process.env[PATH] = '/Shared/x';
    const { calls, resolve } = spyResolver('from-path');
    const value = await resolveExperimentId(
      client([{ resource_id: 'experiment-id', value: 'from-store', intent: 'active' }]),
      resolve,
    );

    expect(value).toBe('from-store');
    expect(calls, 'a stored override is the answer; the path must not be resolved').toEqual([]);
  });

  it('takes the release-supplied id ahead of the path', async () => {
    process.env[ID] = '424242';
    process.env[PATH] = '/Shared/x';
    const { calls, resolve } = spyResolver('from-path');
    const value = await resolveExperimentId(client([]), resolve);

    expect(value).toBe('424242');
    expect(calls, 'a baked id wins, so nothing is resolved at runtime').toEqual([]);
  });

  it('resolves the path to an id when no id was supplied, the From-Git case', async () => {
    process.env[PATH] = '/Shared/player-insights-agent';
    const { calls, resolve } = spyResolver('987654');
    const value = await resolveExperimentId(client([]), resolve);

    expect(value).toBe('987654');
    expect(calls).toEqual(['/Shared/player-insights-agent']);
  });

  it('resolves a path once and reuses the answer', async () => {
    process.env[PATH] = '/Shared/player-insights-agent';
    const { calls, resolve } = spyResolver('987654');
    const first = await resolveExperimentId(client([]), resolve);
    const second = await resolveExperimentId(client([]), resolve);

    expect([first, second]).toEqual(['987654', '987654']);
    expect(calls, 'the id a path maps to does not change, so it is resolved once').toEqual([
      '/Shared/player-insights-agent',
    ]);
  });

  it('does not cache an empty resolve, so an experiment made later is picked up', async () => {
    process.env[PATH] = '/Shared/player-insights-agent';
    const calls: string[] = [];
    let answer = '';
    const resolve = (path: string) => {
      calls.push(path);
      return Promise.resolve(answer);
    };

    expect(await resolveExperimentId(client([]), resolve)).toBe('');
    answer = '135790';
    expect(await resolveExperimentId(client([]), resolve)).toBe('135790');
    expect(calls, 'a failed resolve is retried rather than held').toHaveLength(2);
  });

  it('returns nothing, and asks nothing, when neither id nor path is set', async () => {
    const { calls, resolve } = spyResolver('unused');
    const value = await resolveExperimentId(client([]), resolve);

    expect(value).toBe('');
    expect(calls).toEqual([]);
  });
});
