import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LAKEBASE_USER_API_SCOPE,
  OPTIONAL_USER_API_SCOPES,
  WORKSPACE_READ_USER_API_SCOPE,
} from '../../shared/optional-user-api-scopes';
import { auditGuidance } from '../../shared/stated-cause';
import { DECLARED_SCOPES_VAR, declaredUserApiScopes, sessionFreshness } from './session-freshness';

/**
 * A forwarded token as Databricks Apps actually hands one over: three segments,
 * a `scope` claim, and a signature nothing here checks. Same construction as
 * `access-verification.test.ts`, which owns `scopesFromToken`.
 */
function tokenWithScopes(scope: string | null): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encode({ alg: 'RS256', typ: 'JWT' }),
    encode({
      iss: 'https://example.cloud.databricks.com/oidc',
      sub: 'reviewer@example.com',
      ...(scope === null ? {} : { scope }),
    }),
    'not-a-real-signature',
  ].join('.');
}

/** What the demo target declares today. Seven names, four of them the default. */
const DECLARED = [
  'serving.serving-endpoints',
  'model-serving',
  'sql',
  'dashboards.genie',
  'catalog.catalogs:read',
  'catalog.schemas:read',
  'catalog.tables:read',
];

/** The four a session from before the catalog declaration carries. */
const BEFORE_CATALOG = 'serving.serving-endpoints model-serving sql dashboards.genie offline_access';

describe('declaredUserApiScopes', () => {
  it('reads a comma-separated list, which is the form the release passes', () => {
    expect(declaredUserApiScopes({ [DECLARED_SCOPES_VAR]: 'sql,dashboards.genie' })).toEqual([
      'sql',
      'dashboards.genie',
    ]);
  });

  it('accepts whitespace too, so a hand-set value in a .env does not fail silently', () => {
    expect(declaredUserApiScopes({ [DECLARED_SCOPES_VAR]: ' sql  dashboards.genie ' })).toEqual([
      'sql',
      'dashboards.genie',
    ]);
  });

  /**
   * NULL, NOT []. An empty list would mean the app asks for nothing, which makes
   * every session look current. Unset means this build does not know what it asks
   * for, and that has to reach the reader as "undetermined".
   */
  it('reports not knowing as null rather than as an empty list', () => {
    expect(declaredUserApiScopes({})).toBeNull();
    expect(declaredUserApiScopes({ [DECLARED_SCOPES_VAR]: '' })).toBeNull();
    expect(declaredUserApiScopes({ [DECLARED_SCOPES_VAR]: '  ,  , ' })).toBeNull();
  });
});

describe('sessionFreshness', () => {
  it('reports the token\u2019s own scope list, which nothing reported before', () => {
    const report = sessionFreshness({ token: tokenWithScopes('sql dashboards.genie'), declared: ['sql'] });
    expect(report.tokenScopes).toEqual(['sql', 'dashboards.genie']);
  });

  it('calls a sign-in current when it carries every declared permission', () => {
    const report = sessionFreshness({
      token: tokenWithScopes(`${DECLARED.join(' ')} offline_access`),
      declared: DECLARED,
    });
    expect(report.state).toBe('current');
    expect(report.missingScopes).toEqual([]);
    expect(report.remedy).toBeNull();
  });

  /**
   * The incident, reproduced. A session minted before the catalog scopes were
   * declared, against a deployment that declares them.
   */
  it('names exactly the permissions a session from before the declaration lacks', () => {
    const report = sessionFreshness({ token: tokenWithScopes(BEFORE_CATALOG), declared: DECLARED });
    expect(report.state).toBe('stale');
    expect(report.missingScopes).toEqual([
      'catalog.catalogs:read',
      'catalog.schemas:read',
      'catalog.tables:read',
    ]);
  });

  /**
   * THE CLAIM IS THE NARROW ONE. Two things produce a declared scope missing from
   * a token: a session older than the declaration, or an app that has not been
   * stopped and started since it. One token cannot tell them apart, so the cause
   * recorded is the comparison itself and nothing more. Widening this string to
   * name the session as the cause is the 2026-08-16 mistake, in this file.
   */
  it('records only what the comparison established, not why', () => {
    const report = sessionFreshness({ token: tokenWithScopes(BEFORE_CATALOG), declared: DECLARED });
    expect(report.cause).toBe('token-lacks-declared-scope');
    expect(report.evidence).toContain('`catalog.tables:read`');
    expect(report.evidence).toContain('`sql`');
  });

  /**
   * This USED TO ASSERT THE OPPOSITE. The remedy named the other possibility --
   * "if a brand new sign-in still does not carry it, the deployment was never
   * stopped and started" -- so that a reader could tell the two apart themselves.
   *
   * That is a second action hung off the first, which `auditGuidance` refuses, and
   * it is refused for the reason the 2026-08-16 remedy demonstrated: a reader
   * working down a list cannot tell which rung they are on. The app re-probes on
   * the next request and states its own verdict, and `scope-refusal` reaches the
   * never-restarted one from the other direction.
   *
   * WHAT THIS GIVES UP, because it is a real cost and not nothing: neither surface
   * asserts "this one is the app's problem, not yours", so a reader who opens a
   * private window and still lacks the scope is told the same thing twice. It is
   * the one drop in this pass that loses something a reader was using. Reverting
   * it means putting the sentence back HERE, in `freshSignIn`, and allowing a
   * contingency in `guidance` -- not widening `auditGuidance`.
   */
  it('refuses to hang a second action off the fresh sign-in', () => {
    const report = sessionFreshness({ token: tokenWithScopes(BEFORE_CATALOG), declared: DECLARED });
    const guidance = report.remedy?.guidance ?? '';
    expect(guidance).not.toContain('still does not carry');
    expect(guidance).not.toContain('stopped and started');
    expect(auditGuidance('session freshness', guidance)).toEqual([]);
  });

  /**
   * The remedy has to be one that works. Databricks Apps has no supported way for
   * an app to end its own sign-in, and the session lives on the app's own host
   * rather than the workspace's, so a workspace sign-out is the wrong instruction
   * and a re-consent is an instruction to do something that does not exist.
   *
   * The sign-out trap is the reason this remedy keeps a line at all: without it a
   * reader signs out of Databricks first, which does nothing, and concludes the
   * instruction is wrong. That is Sam's own worked example of guidance earning
   * its place.
   */
  it('offers a fresh session in a way that actually clears the app\u2019s own sign-in', () => {
    const report = sessionFreshness({ token: tokenWithScopes(BEFORE_CATALOG), declared: DECLARED });
    expect(report.remedy?.statement).toContain('private browsing window');
    expect(report.remedy?.guidance).toContain('Signing out of Databricks does not clear');
    // The instruction that sent the reader in circles. It must not come back.
    expect(report.remedy?.statement.toLowerCase()).not.toContain('sign out of');
  });

  /**
   * The OAuth server spells our catalog reads `unity-catalog` while the bundle has
   * to spell them `catalog.tables:read`, and a literal comparison of the two reads
   * a token that carries the scope as a token that lacks it. That is the same
   * confusion that once printed a GRANT for a missing scope, arrived at from the
   * other direction, and it would now put a false warning above every page.
   */
  it('recognises the OAuth spelling on the token rather than calling it missing', () => {
    const report = sessionFreshness({
      token: tokenWithScopes('unity-catalog sql dashboards.genie model-serving serving.serving-endpoints'),
      declared: DECLARED,
    });
    expect(report.state).toBe('current');
  });

  it('treats the catch-all CLI scope as carrying everything', () => {
    const report = sessionFreshness({ token: tokenWithScopes('all-apis'), declared: DECLARED });
    expect(report.state).toBe('current');
  });

  describe('the three states nothing can be concluded from', () => {
    it('says so when the request carried no forwarded sign-in', () => {
      const report = sessionFreshness({ token: null, declared: DECLARED });
      expect(report.state).toBe('undetermined');
      expect(report.remedy).toBeNull();
      expect(report.tokenScopes).toBeNull();
    });

    it('says so when the token does not list its own permissions', () => {
      const report = sessionFreshness({ token: tokenWithScopes(null), declared: DECLARED });
      expect(report.state).toBe('undetermined');
      expect(report.remedy).toBeNull();
    });

    it('says so when this build was not told which permissions it asks for', () => {
      const report = sessionFreshness({ token: tokenWithScopes('sql'), declared: null });
      expect(report.state).toBe('undetermined');
      expect(report.remedy).toBeNull();
      // The half that IS knowable is still reported: the reader came for this.
      expect(report.tokenScopes).toEqual(['sql']);
    });

    /**
     * The tempting shortcut, refused. An unknown declared list could be filled in
     * from the scopes the probes need, which is a list this app does hold. It
     * would be wrong: the demo target declares nine names and the customer
     * default is four, and a target is free to stage a name it has not proved
     * issuable. Guessing would put a warning above every page of a deployment
     * that is configured exactly as intended.
     */
    it('never fills an unknown declared list in from the scopes it needs', () => {
      const report = sessionFreshness({ token: tokenWithScopes('sql'), declared: [] });
      expect(report.state).toBe('undetermined');
      expect(report.declaredScopes).toBeNull();
      expect(report.missingScopes).toEqual([]);
    });
  });
});

/**
 * The variable has to be authored in app.yaml for the release to be able to set
 * it. A generated app.yaml only carries what the authored one declares, and this
 * mechanism has silently swallowed a variable before.
 */
describe('the authored app.yaml', () => {
  const appYaml = readFileSync(join(__dirname, '..', '..', 'app.yaml'), 'utf8');

  it(`declares ${DECLARED_SCOPES_VAR}`, () => {
    expect(appYaml).toContain(`- name: ${DECLARED_SCOPES_VAR}`);
  });

  /**
   * THE ASK-PATH SCOPES PLUS WORKSPACE BROWSE, NOT EMPTY. A Git deploy has no
   * bundle target, so this authored value is what the login gate uses. Workspace
   * browse must be requested for the notebook picker and Lakebase picker even
   * though both remain optional to the gate. The other optional families stay out.
   */
  it('authors the required ask-path scopes and workspace browse for a Git deploy', () => {
    const value =
      new RegExp(`- name: ${DECLARED_SCOPES_VAR}\\n\\s+value: '?([^'\\n]*)'?`).exec(appYaml)?.[1] ??
      '';
    const declared = value.split(',').filter(Boolean);

    expect(declared).toEqual([
      'serving.serving-endpoints',
      'model-serving',
      'sql',
      'dashboards.genie',
      WORKSPACE_READ_USER_API_SCOPE,
      LAKEBASE_USER_API_SCOPE,
    ]);
    for (const optional of OPTIONAL_USER_API_SCOPES.filter(
      (scope) => scope !== WORKSPACE_READ_USER_API_SCOPE && scope !== LAKEBASE_USER_API_SCOPE
    )) {
      expect(declared).not.toContain(optional);
    }
  });
});
