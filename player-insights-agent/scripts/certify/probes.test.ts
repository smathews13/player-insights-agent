import { describe, expect, it } from 'vitest';
import {
  manifestTables,
  probeAgentEndpoint,
  probeAttachments,
  probeBuildMatch,
  probeBuildStamps,
  probeDrift,
  probeManifestCoverage,
  probeOwnership,
  probeReleaseIdentity,
  probeScopesAsAuthored,
  probeScopesInEffect,
  probeServedVersion,
  probeStorage,
  probeDeclaredIdentity,
  probeIdentityContract,
  loggedAuthPolicy,
  servedVersion,
  unprobed,
  type AppRecord,
  type EndpointRecord,
} from './probes.ts';
import { emptyTuple, type ReleaseTuple } from './release-identity.ts';

function tuple(overrides: Partial<ReleaseTuple> = {}): ReleaseTuple {
  return {
    ...emptyTuple(),
    target: 'demo',
    appName: 'app',
    appBuildSha: 'a'.repeat(40),
    servingEndpoint: 'endpoint',
    modelName: 'cat.sch.model',
    modelVersion: '19',
    modelBuildSha: 'a'.repeat(40),
    declaredScopes: ['sql'],
    ...overrides,
  };
}

function run(params: Record<string, string>) {
  return { data: { params: Object.entries(params).map(([key, value]) => ({ key, value })) } };
}

function endpoint(routes: Array<[string, number]>, versions: Record<string, string> = {}): EndpointRecord {
  return {
    config: {
      served_entities: Object.entries(versions).map(([name, entity_version]) => ({ name, entity_version })),
      traffic_config: {
        routes: routes.map(([served_entity_name, traffic_percentage]) => ({
          served_entity_name,
          traffic_percentage,
        })),
      },
    },
  };
}

describe('a missing observation is never a pass', () => {
  // The single most important property in this file. Every probe takes its
  // input as nullable, and every null branch has to say that nothing was asked.
  const nulls = [
    probeAttachments(null),
    probeScopesAsAuthored(null, ['sql']),
    probeScopesInEffect(null),
    probeOwnership(null),
    probeStorage(null),
    probeServedVersion(null),
    probeManifestCoverage(null, []),
    probeDeclaredIdentity(null, null),
    probeIdentityContract(null, null),
    probeAgentEndpoint(null),
    probeDrift(null),
  ];

  it.each(nulls.map((outcome) => [outcome.code, outcome] as const))('%s is unknown', (_code, outcome) => {
    expect(outcome.status).toBe('unknown');
    expect(outcome.detail).toContain('nothing was asked');
  });
});

describe('probeReleaseIdentity', () => {
  it('passes on a complete tuple', () => {
    expect(probeReleaseIdentity(tuple()).status).toBe('pass');
  });

  it('fails, rather than reporting unknown, when the release cannot name itself', () => {
    // A release that does not identify itself is a real defect in the release,
    // not a gap in the observation: it means nothing recorded what was built.
    const outcome = probeReleaseIdentity(tuple({ appBuildSha: '' }));
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('appBuildSha');
  });
});

describe('probeBuildStamps', () => {
  it('fails a dirty build, because nothing can rebuild or roll back to it', () => {
    const outcome = probeBuildStamps(tuple({ appBuildSha: 'abc+dirty' }));
    expect(outcome.status).toBe('fail');
  });

  it('is unknown when a stamp is missing, not clean', () => {
    expect(probeBuildStamps(tuple({ modelBuildSha: '' })).status).toBe('unknown');
  });

  it('passes two clean stamps', () => {
    expect(probeBuildStamps(tuple()).status).toBe('pass');
  });
});

describe('probeBuildMatch', () => {
  it('passes matching commits', () => {
    expect(probeBuildMatch(tuple()).status).toBe('pass');
  });

  it('reports skew', () => {
    expect(probeBuildMatch(tuple({ modelBuildSha: 'b'.repeat(40) })).status).toBe('fail');
  });

  it('is unknown when one side is unstamped', () => {
    expect(probeBuildMatch(tuple({ modelBuildSha: '' })).status).toBe('unknown');
  });
});

describe('probeAttachments', () => {
  const attached = (...names: string[]): AppRecord => ({ resources: names.map((name) => ({ name })) });

  it('passes when all three are attached', () => {
    expect(probeAttachments(attached('postgres', 'serving-endpoint', 'sql-warehouse')).status).toBe('pass');
  });

  it('names the ones that are missing', () => {
    const outcome = probeAttachments(attached('postgres'));
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('serving-endpoint');
    expect(outcome.detail).toContain('sql-warehouse');
  });

  it('fails an app with no resources at all rather than reading it as nothing required', () => {
    expect(probeAttachments({}).status).toBe('fail');
  });
});

describe('probeScopesAsAuthored', () => {
  it('passes an exact match', () => {
    const app: AppRecord = { user_api_scopes: ['sql', 'model-serving'] };
    expect(probeScopesAsAuthored(app, ['model-serving', 'sql']).status).toBe('pass');
  });

  it('fails when a scope the bundle authors was dropped from the live app', () => {
    const outcome = probeScopesAsAuthored({ user_api_scopes: ['sql'] }, ['sql', 'dashboards.genie']);
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('dashboards.genie');
  });

  it('fails an extra scope too, since an unauthored scope is an undiagnosable lockout risk', () => {
    const app: AppRecord = { user_api_scopes: ['sql', 'serving.serving-endpoints-data-plane'] };
    const outcome = probeScopesAsAuthored(app, ['sql']);
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('serving.serving-endpoints-data-plane');
  });

  it('fails when the bundle authors none, rather than passing against an empty expectation', () => {
    expect(probeScopesAsAuthored({ user_api_scopes: [] }, []).status).toBe('fail');
  });
});

describe('probeScopesInEffect', () => {
  it('passes when every declared scope is in effect', () => {
    const app: AppRecord = {
      user_api_scopes: ['sql'],
      effective_user_api_scopes: ['sql', 'iam.current-user:read'],
    };
    expect(probeScopesInEffect(app).status).toBe('pass');
  });

  it('ignores platform scopes the app never declared, which are not drift', () => {
    const app: AppRecord = {
      user_api_scopes: ['sql'],
      effective_user_api_scopes: ['sql', 'iam.access-control:read'],
    };
    const outcome = probeScopesInEffect(app);
    expect(outcome.status).toBe('pass');
    expect(outcome.detail).not.toContain('iam.access-control:read');
  });

  it('fails a declared scope that is not in effect', () => {
    const app: AppRecord = {
      user_api_scopes: ['sql', 'dashboards.genie'],
      effective_user_api_scopes: ['sql'],
    };
    const outcome = probeScopesInEffect(app);
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('dashboards.genie');
  });

  it('says a pass here is not evidence that a user can consent', () => {
    const app: AppRecord = { user_api_scopes: ['sql'], effective_user_api_scopes: ['sql'] };
    expect(probeScopesInEffect(app).detail).toContain('OAUTH_SCOPE_CONSENT_PROVEN');
  });
});

describe('probeOwnership', () => {
  it('passes on exit 0', () => {
    expect(probeOwnership({ exitCode: 0, output: 'ok' }).status).toBe('pass');
  });

  it('fails on exit 1, the finding', () => {
    expect(probeOwnership({ exitCode: 1, output: 'OWNERSHIP:' }).status).toBe('fail');
  });

  it('is unknown on exit 2, which is the check saying it could not run', () => {
    const outcome = probeOwnership({ exitCode: 2, output: 'could not resolve' });
    expect(outcome.status).toBe('unknown');
    expect(outcome.detail).toContain('Not a finding');
  });
});

describe('probeStorage', () => {
  it('passes when the app read through its own schema', () => {
    expect(probeStorage({ state: 'ok', last_ok_at: '2026-08-10T09:00:00Z' }).status).toBe('pass');
  });

  it('fails an unavailable store and says the app is serving seeded rows at 200', () => {
    const outcome = probeStorage({ state: 'unavailable', access: 'denied' });
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('grant problem');
  });

  it('treats a store nothing has read yet as unknown, not healthy', () => {
    expect(probeStorage({ state: 'unknown' }).status).toBe('unknown');
  });
});

describe('served traffic', () => {
  it('passes a single route at 100%', () => {
    const outcome = probeServedVersion(endpoint([['model_19', 100]], { model_19: '19' }));
    expect(outcome.status).toBe('pass');
    expect(outcome.detail).toContain('19');
  });

  it('ignores versions parked at 0%, which is the normal state after a switch', () => {
    const record = endpoint(
      [
        ['model_19', 100],
        ['model_18', 0],
      ],
      { model_19: '19', model_18: '18' }
    );
    expect(probeServedVersion(record).status).toBe('pass');
    expect(servedVersion(record)).toBe('19');
  });

  it('fails a split, because no answer can then be attributed to a version', () => {
    const record = endpoint([
      ['model_19', 50],
      ['model_18', 50],
    ]);
    expect(probeServedVersion(record).status).toBe('fail');
    expect(servedVersion(record)).toBe('');
  });

  it('fails an endpoint carrying no traffic at all', () => {
    expect(probeServedVersion(endpoint([['model_19', 0]])).status).toBe('fail');
  });
});

describe('the manifest', () => {
  const version = {
    model_version_dependencies: {
      dependencies: [{ table: { table_full_name: 'cat.sch.b' } }, { table: { table_full_name: 'cat.sch.a' } }],
    },
  };

  it('reads and sorts the declared tables', () => {
    expect(manifestTables(version)).toEqual(['cat.sch.a', 'cat.sch.b']);
  });

  it('passes an exact match', () => {
    expect(probeManifestCoverage(version, ['cat.sch.a', 'cat.sch.b']).status).toBe('pass');
  });

  it('fails a table the contract names and the version does not', () => {
    const outcome = probeManifestCoverage(version, ['cat.sch.a', 'cat.sch.b', 'cat.sch.c']);
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('cat.sch.c');
    expect(outcome.detail).toContain('Passthrough grants nothing');
  });

  it('passes an over-granted version, and still names the surplus', () => {
    // The direction that matters is the missing one. Version 19 on the live demo
    // declares four tables the contract does not name, because the manifest is
    // enumerated from the catalog allowlist and the contract is narrower.
    // Failing that would fail every correct release.
    const outcome = probeManifestCoverage(version, ['cat.sch.a']);
    expect(outcome.status).toBe('pass');
    expect(outcome.detail).toContain('cat.sch.b');
    expect(outcome.detail).toContain('over-granted');
  });

  it('is unknown when the repository could not say what to expect', () => {
    expect(probeManifestCoverage(version, null).status).toBe('unknown');
  });
});

describe('the auth policy the served version was logged with', () => {
  it.each([
    ['True', 'enabled'],
    ['true', 'enabled'],
    ['false', 'disabled'],
    ['1', 'disabled'],
    ['yes', 'disabled'],
    ['ture', 'disabled'],
  ])('reads %s the way the serving container does', (raw, expected) => {
    expect(loggedAuthPolicy(run({ user_authorization: raw }))).toBe(expected);
  });

  it('reads a version logged before the key existed as disabled, since it bakes nothing', () => {
    expect(loggedAuthPolicy(run({ build_sha: 'a'.repeat(40) }))).toBe('disabled');
  });

  it('separates a run it could not read from a policy that is off', () => {
    expect(loggedAuthPolicy(null)).toBe('unknown');
  });
});

describe('the identity a target declares against the one it serves', () => {
  const enabled = run({ user_authorization: 'True' });
  const disabled = run({ user_authorization: 'False' });

  it('passes when a passthrough declaration meets a passthrough version', () => {
    expect(probeDeclaredIdentity('system-passthrough', disabled).status).toBe('pass');
  });

  it('passes when a user-authorization declaration meets a version logged with it', () => {
    expect(probeDeclaredIdentity('user-authorization', enabled).status).toBe('pass');
  });

  it('catches the release that meant to and did not, which is the whole point', () => {
    const outcome = probeDeclaredIdentity('user-authorization', disabled);
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('meant to and did not');
  });

  it('catches the declaration that is out of date in the other direction', () => {
    expect(probeDeclaredIdentity('system-passthrough', enabled).status).toBe('fail');
  });

  it('fails a declaration nothing recognises rather than guessing at it', () => {
    const outcome = probeDeclaredIdentity('user_authorization', enabled);
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('states no intent');
  });

  it('is unknown when the bundle resolved no declaration', () => {
    expect(probeDeclaredIdentity(null, enabled).status).toBe('unknown');
  });
});

describe('the two halves of the identity contract', () => {
  const enabled = run({ user_authorization: 'True' });
  const disabled = run({ user_authorization: 'False' });

  it('passes the new pairing', () => {
    expect(probeIdentityContract(true, enabled).status).toBe('pass');
  });

  it('passes the old pairing, which is not a defect', () => {
    expect(probeIdentityContract(false, disabled).status).toBe('pass');
  });

  it('fails a signed-in app against a passthrough version, and names the refusal', () => {
    // The deployment this check exists for. Both halves are correct alone and
    // every question refuses, with no fallback left to soften it.
    const outcome = probeIdentityContract(true, disabled);
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('IDENTITY_REQUIRED');
  });

  it('fails the same release arriving in halves the other way round', () => {
    const outcome = probeIdentityContract(false, enabled);
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('refuses a request that declares no user');
  });

  it('tells an app that sends nothing apart from one nothing was read from', () => {
    expect(probeIdentityContract(null, enabled).status).toBe('unknown');
    expect(probeIdentityContract(false, enabled).status).toBe('fail');
  });

  it('is unknown when the served version\u2019s policy was not established', () => {
    expect(probeIdentityContract(true, null).status).toBe('unknown');
  });
});

describe('probeAgentEndpoint', () => {
  it('passes when the app invoked the endpoint, and says nothing behind it was covered', () => {
    const outcome = probeAgentEndpoint({ checks: [{ id: 'agent-endpoint', status: 'ok' }] });
    expect(outcome.status).toBe('pass');
    expect(outcome.detail).toContain('Nothing behind it is covered');
  });

  it('fails when the endpoint could not be invoked', () => {
    const outcome = probeAgentEndpoint({
      error: 'preflight_unavailable',
      checks: [{ id: 'agent-endpoint', status: 'failed', detail: 'permission denied' }],
    });
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('permission denied');
  });

  it('is unknown when the response carried no such check', () => {
    expect(probeAgentEndpoint({ checks: [] }).status).toBe('unknown');
  });

  it('passes the retired-preflight response, which still proves the endpoint answered', () => {
    // /api/preflight answers 200 with error: preflight_retired when the served
    // version no longer emits a dependency report. The endpoint DID answer, and
    // that is the whole claim this check makes.
    const outcome = probeAgentEndpoint({
      error: 'preflight_retired',
      checks: [
        { id: 'agent-endpoint', status: 'ok' },
        { id: 'lakebase-storage', status: 'ok' },
      ],
    });
    expect(outcome.status).toBe('pass');
  });
});

describe('probeDrift', () => {
  it('passes a clean report', () => {
    expect(probeDrift({ status: 'ok', drift: [], orchestratorReported: true }).status).toBe('pass');
  });

  it('fails on a blocking finding and names it', () => {
    const outcome = probeDrift({
      status: 'blocked',
      orchestratorReported: true,
      drift: [
        { id: 'mismatch-sql-warehouse', severity: 'blocking', headline: 'Warehouse in use is not the one configured' },
      ],
    });
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('Warehouse in use');
  });

  it('is unknown when the orchestrator never reported, since nothing was compared', () => {
    const outcome = probeDrift({ status: 'unknown', drift: [], orchestratorReported: false });
    expect(outcome.status).toBe('unknown');
    expect(outcome.detail).toContain('not the same as');
  });
});

describe('unprobed', () => {
  it('reports an unobservable check with the catalogue reason, not a second wording', () => {
    const outcome = unprobed('OAUTH_SCOPE_CONSENT_PROVEN');
    expect(outcome.status).toBe('unverifiable');
    expect(outcome.detail).toContain('effective_user_api_scopes is not proof');
  });

  it('reports a browser check as unverifiable and says why no gate can start one', () => {
    const outcome = unprobed('CLIENT_RENDERS_UNAVAILABLE');
    expect(outcome.status).toBe('unverifiable');
    expect(outcome.detail).toContain('Browser automation is not run');
  });

  it('reports an unwritten probe as unknown', () => {
    expect(unprobed('SIGNED_USER_ASK_CANARY').status).toBe('unknown');
  });
});
