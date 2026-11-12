import { describe, expect, it } from 'vitest';
import { CHECKS, REQUIRED_CODES } from './catalogue.ts';
import { certify, observedTuple, runChecks, type Observations } from './runner.ts';
import { expectedManifestTables } from './expected-manifest.ts';
import { renderReport } from './report.ts';

const TABLES = ['cat.sch.gold_a', 'cat.sch.gold_b'];

/** A deployment where everything an API can see is right. */
function healthy(overrides: Partial<Observations> = {}): Observations {
  return {
    target: 'demo',
    issuedBy: 'someone@example.com',
    modelName: 'cat.sch.model',
    authoredScopes: ['sql', 'model-serving'],
    declaredIdentity: 'user-authorization',
    appIdentityMode: true,
    expectedTables: TABLES,
    app: {
      name: 'player-insights-agent',
      url: 'https://app.example.com',
      user_api_scopes: ['sql', 'model-serving'],
      effective_user_api_scopes: ['sql', 'model-serving', 'iam.current-user:read'],
      resources: [
        { name: 'postgres', postgres: { branch: 'projects/db/branches/production' } },
        { name: 'serving-endpoint', serving_endpoint: { name: 'endpoint' } },
        { name: 'sql-warehouse', sql_warehouse: { id: 'w1' } },
      ],
    },
    endpoint: {
      name: 'endpoint',
      config: {
        served_entities: [{ name: 'model_19', entity_version: '19' }],
        traffic_config: { routes: [{ served_entity_name: 'model_19', traffic_percentage: 100 }] },
      },
    },
    modelVersion: {
      version: 19,
      run_id: 'run1',
      model_version_dependencies: {
        dependencies: TABLES.map((table) => ({ table: { table_full_name: table } })),
      },
    },
    modelRun: {
      data: {
        params: [
          { key: 'build_sha', value: 'a'.repeat(40) },
          { key: 'user_authorization', value: 'True' },
        ],
      },
    },
    settings: {
      appBuildSha: 'a'.repeat(40),
      modelBuildSha: 'a'.repeat(40),
      status: 'ok',
      drift: [],
      orchestratorReported: true,
    },
    storage: { state: 'ok', last_ok_at: '2026-08-10T09:00:00Z' },
    preflight: { error: 'preflight_retired', checks: [{ id: 'agent-endpoint', status: 'ok' }] },
    ownership: { exitCode: 0, output: 'ok' },
    ...overrides,
  };
}

describe('observedTuple', () => {
  it('takes the app build from the running app and the version from the traffic route', () => {
    const tuple = observedTuple(healthy());
    expect(tuple.appBuildSha).toBe('a'.repeat(40));
    expect(tuple.modelVersion).toBe('19');
    expect(tuple.servingEndpoint).toBe('endpoint');
    expect(tuple.manifestTables).toEqual(TABLES);
  });

  it('leaves the model version unknown while traffic is split', () => {
    const split = healthy();
    split.endpoint!.config!.traffic_config!.routes = [
      { served_entity_name: 'model_19', traffic_percentage: 50 },
      { served_entity_name: 'model_18', traffic_percentage: 50 },
    ];
    expect(observedTuple(split).modelVersion).toBe('');
  });

  it('reads the auth policy from the run that logged the version', () => {
    expect(observedTuple(healthy()).userAuthPolicy).toBe('enabled');
  });

  it('leaves the policy unknown when that run could not be read', () => {
    expect(observedTuple(healthy({ modelRun: null })).userAuthPolicy).toBe('unknown');
  });

  it('records a passthrough version as such in the tuple', () => {
    // Version 19 on the live demo is logged this way. The tuple carrying it is
    // what voids an attestation across a change of who the query runs as.
    expect(observedTuple(passthroughRelease()).userAuthPolicy).toBe('disabled');
  });

  it('prefers the logging run to the app for the model stamp', () => {
    // The app can only report a model stamp while the orchestrator sends its
    // configuration with every answer, and the served version stopped doing
    // that. The run is the record that survives.
    const stale = healthy();
    stale.settings!.modelBuildSha = '';
    expect(observedTuple(stale).modelBuildSha).toBe('a'.repeat(40));
  });
});

/** A target that declares passthrough and runs the app build that pairs with it. */
function passthroughRelease(): Observations {
  const observations = healthy();
  observations.declaredIdentity = 'system-passthrough';
  observations.appIdentityMode = false;
  observations.modelRun!.data!.params![1] = { key: 'user_authorization', value: 'False' };
  return observations;
}

describe('the identity contract, end to end', () => {
  it('accepts a whole passthrough release, which is what every target does today', () => {
    const observations = passthroughRelease();
    const results = new Map(runChecks(observations, observedTuple(observations)).map((r) => [r.code, r]));
    expect(results.get('EXECUTION_IDENTITY_AS_DECLARED')?.status).toBe('pass');
    expect(results.get('IDENTITY_CONTRACT_PAIRED')?.status).toBe('pass');
  });

  it('fails the half-release that refuses every question', () => {
    // The new app against the old model version: the ordering constraint this
    // check exists for. Both halves are individually correct.
    const half = healthy();
    half.modelRun!.data!.params![1] = { key: 'user_authorization', value: 'False' };
    const certificate = certify({ observations: half, attestations: [], mode: 'shadow' });
    expect(certificate.status).toBe('FAIL');
    const codes = certificate.checks.filter((c) => c.status === 'fail').map((c) => c.code);
    expect(codes).toContain('IDENTITY_CONTRACT_PAIRED');
    expect(codes).toContain('EXECUTION_IDENTITY_AS_DECLARED');
  });

  it('fails the old app deployed against a version logged with the policy', () => {
    const half = healthy();
    half.appIdentityMode = false;
    const certificate = certify({ observations: half, attestations: [], mode: 'shadow' });
    expect(certificate.status).toBe('FAIL');
    expect(certificate.checks.find((c) => c.code === 'IDENTITY_CONTRACT_PAIRED')?.status).toBe('fail');
  });
});

describe('runChecks', () => {
  it('emits exactly one result per catalogue entry, in catalogue order', () => {
    const observations = healthy();
    const results = runChecks(observations, observedTuple(observations));
    expect(results.map((result) => result.code)).toEqual(CHECKS.map((check) => check.code));
  });

  it('reports the checks with no probe honestly rather than omitting them', () => {
    const observations = healthy();
    const byCode = new Map(runChecks(observations, observedTuple(observations)).map((r) => [r.code, r]));
    expect(byCode.get('OAUTH_SCOPE_CONSENT_PROVEN')?.status).toBe('unverifiable');
    expect(byCode.get('CLIENT_RENDERS_UNAVAILABLE')?.status).toBe('unverifiable');
    expect(byCode.get('SIGNED_USER_ASK_CANARY')?.status).toBe('unknown');
  });
});

describe('certify', () => {
  it('will not say PASS for a healthy deployment while three conditions are unobserved', () => {
    // The property that matters most in this whole workstream. Everything an
    // API can see is correct here, and the answer is still not PASS, because
    // consent, the client rendering and the ask canary were not established by
    // anything.
    const certificate = certify({ observations: healthy(), attestations: [], mode: 'shadow' });
    expect(certificate.status).toBe('INCOMPLETE');
  });

  it('says FAIL when something an API can see is wrong', () => {
    const broken = healthy();
    broken.storage = { state: 'unavailable', access: 'denied' };
    const certificate = certify({ observations: broken, attestations: [], mode: 'shadow' });
    expect(certificate.status).toBe('FAIL');
    const storage = certificate.checks.find((c) => c.code === 'LAKEBASE_STORAGE_READABLE');
    expect(storage?.status).toBe('fail');
  });

  it('records nothing observed as unknown when the workspace could not be reached', () => {
    const dark = healthy({
      app: null,
      endpoint: null,
      modelVersion: null,
      modelRun: null,
      settings: null,
      storage: null,
      preflight: null,
      ownership: null,
    });
    const certificate = certify({ observations: dark, attestations: [], mode: 'shadow' });
    expect(certificate.status).not.toBe('PASS');
    const failures = certificate.checks.filter((check) => check.status === 'fail');
    // RELEASE_IDENTITY_COMPLETE is the only legitimate failure here: a release
    // that cannot name itself is a defect whether or not anything answered.
    // Everything else must be unknown, because nothing was asked.
    expect(failures.map((f) => f.code)).toEqual(['RELEASE_IDENTITY_COMPLETE']);
  });

  it('covers every required code, so nothing can be forgotten into a pass', () => {
    const certificate = certify({ observations: healthy(), attestations: [], mode: 'shadow' });
    const emitted = new Set(certificate.checks.map((check) => check.code));
    for (const code of REQUIRED_CODES) expect(emitted.has(code)).toBe(true);
  });
});

describe('renderReport', () => {
  const certificate = certify({ observations: healthy(), attestations: [], mode: 'shadow' });
  const text = renderReport(certificate);

  it('leads with the verdict and the mode', () => {
    expect(text).toContain('INCOMPLETE  (shadow mode)');
  });

  it('prints what the certificate does not cover even on a clean run', () => {
    expect(text).toContain('What this certificate does NOT cover');
    expect(text).toContain('OAUTH_SCOPE_CONSENT_PROVEN  NOT ATTESTED');
  });

  it('names the release digest, which is what a promotion is matched on', () => {
    expect(text).toContain(certificate.tupleDigest);
  });

  it('separates what nothing established from what was found wrong', () => {
    expect(text).toContain('Not established');
    expect(text).not.toContain('==> Findings');
  });

  it('keeps an advisory failure out of the findings that decide the verdict', () => {
    const drifted = healthy();
    drifted.settings!.appBuildSha = 'b'.repeat(40);
    const report = renderReport(certify({ observations: drifted, attestations: [], mode: 'shadow' }));
    expect(report).not.toContain('==> Findings');
    expect(report).toContain('Advisory, and never a gate');
    expect(report).toContain('APP_MODEL_BUILD_MATCH');
  });
});

describe('expectedManifestTables', () => {
  const source = [
    'DATA_GENIE_TABLES = (',
    '    "gold_a",',
    '    "gold_b",',
    ')',
    '',
    'DICTIONARY_GENIE_TABLES = (',
    '    "data_dictionary",',
    ')',
  ].join('\n');

  it('qualifies bare names with the target namespace', () => {
    expect(expectedManifestTables(source, { catalog: 'cat', schema: 'sch' })).toEqual([
      'cat.sch.data_dictionary',
      'cat.sch.gold_a',
      'cat.sch.gold_b',
    ]);
  });

  it('leaves an already-qualified name alone rather than making a five-part name', () => {
    const qualified = 'DATA_GENIE_TABLES = (\n    "other.place.t",\n)';
    expect(expectedManifestTables(qualified, { catalog: 'cat', schema: 'sch' })).toEqual(['other.place.t']);
  });

  it('returns null when neither tuple is there, rather than an empty expectation', () => {
    expect(expectedManifestTables('NOTHING = 1', { catalog: 'cat', schema: 'sch' })).toBeNull();
  });

  it('returns null without a namespace, since a bare table name compares to nothing', () => {
    expect(expectedManifestTables(source, { catalog: '', schema: 'sch' })).toBeNull();
  });

  it('parses the real agent/preflight.py declaration, so the two cannot drift unnoticed', async () => {
    const { readFileSync } = await import('node:fs');
    const real = readFileSync(new URL('../../../agent/preflight.py', import.meta.url), 'utf8');
    const tables = expectedManifestTables(real, { catalog: 'cat', schema: 'sch' });
    expect(tables).not.toBeNull();
    expect(tables!.length).toBeGreaterThan(0);
    for (const table of tables!) expect(table.split('.')).toHaveLength(3);
  });
});
