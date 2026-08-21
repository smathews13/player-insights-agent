import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  connectionSubjects,
  scopeForPath,
  scopesProbesNeed,
  tokenCarriesScope,
} from './dependency-probes';

/**
 * The bundle must declare every scope the probes call with.
 *
 * THIS IS THE TEST THAT STOPS IT RECURRING, and it is worth saying why the other
 * one is not enough. The diagnosis tests make a missing scope legible once it
 * happens: the row says "the app is short of `vector-search`" instead of
 * printing a GRANT. Good, but still after the fact, on a customer's screen. This
 * one fails at build time, on the developer's machine, on the commit that adds a
 * probe against an API the app never asked permission for.
 *
 * That was the actual gap. The probes were reviewed, tested and audited, and
 * every one of those passes ran under a full local credential where the scopes
 * were irrelevant. Nothing anywhere compared the APIs the probes call against
 * the scopes the app declares, so the two could drift apart silently, and they
 * did -- until a deploy turned twenty-odd rows red at once.
 *
 * Read as TEXT rather than through a YAML parser on purpose. The bundle is
 * variable-interpolated (`${var.app_user_api_scopes}`) and target-layered, so a
 * parse of one file resolves nothing; and `databricks bundle validate` needs a
 * workspace, which a unit test must not need. Reading the literal list under the
 * target is cruder and cannot be fooled by an interpolation that looks right.
 */

const REPO = join(__dirname, '..', '..', '..');
const BUNDLE = join(REPO, 'databricks.yml');

/** The `app_user_api_scopes:` block of one target, as raw lines. */
function scopeBlock(target: string): string[] {
  const bundle = readFileSync(BUNDLE, 'utf8');
  const at = bundle.indexOf(`\n  ${target}:\n`);
  if (at < 0) throw new Error(`databricks.yml declares no target named ${target}`);
  // To the next target, so a later target's list cannot be read as this one's.
  const next = bundle.slice(at + 1).search(/\n {2}\w+:\n/);
  const section = next < 0 ? bundle.slice(at) : bundle.slice(at, at + 1 + next);

  const key = section.indexOf('app_user_api_scopes:');
  if (key < 0) return [];
  const lines: string[] = [];
  for (const line of section.slice(key).split('\n').slice(1)) {
    // A comment is part of the block; the first line that is neither a comment
    // nor an entry is the next key, and ends it.
    if (/^\s*#/.test(line) || /^\s+- \S+\s*$/.test(line)) lines.push(line);
    else break;
  }
  return lines;
}

/** The scopes one target lists in a block of its OWN, empty if it has none. */
function declaredScopes(target: string): string[] {
  return scopeBlock(target)
    .map((line) => /^\s+- (\S+)\s*$/.exec(line)?.[1])
    .filter((scope): scope is string => Boolean(scope));
}

/**
 * The scopes a target actually REQUESTS: its own block if it has one, else the
 * shared default it inherits. A DAB complex-variable override replaces the
 * default rather than merging (bundle/scope-contract.py and bundle/drift-check.py
 * both resolve it this way), so this is either/or, not a union.
 */
function effectiveScopes(target: string): string[] {
  const own = declaredScopes(target);
  return own.length > 0 ? own : defaultScopes();
}

/**
 * The `app_user_api_scopes` VARIABLE default -- what a target with no override
 * block of its own inherits, i.e. what a customer / customer deployment requests.
 *
 * Read as text for the same reason as the target blocks: a DAB complex variable
 * is target-layered and a YAML parse of one file resolves nothing. A target
 * override REPLACES this default rather than merging with it (see
 * bundle/scope-contract.py), so this list is exactly the customer/T2 request.
 */
function defaultScopes(): string[] {
  const bundle = readFileSync(BUNDLE, 'utf8');
  const at = bundle.indexOf('\n  app_user_api_scopes:');
  if (at < 0) throw new Error('databricks.yml declares no app_user_api_scopes variable');
  const next = bundle.slice(at + 1).search(/\n {2}\w+:\n/);
  const section = next < 0 ? bundle.slice(at) : bundle.slice(at, at + 1 + next);
  const tail = section.slice(section.indexOf('default:'));
  return [...tail.matchAll(/^\s+- (\S+)\s*$/gm)].map((m) => m[1]);
}

/**
 * The scopes one target has written down but commented out.
 *
 * A STAGED SCOPE IS A DELIBERATE STATE, NOT A GAP, and this reader is what lets
 * the guard below tell the two apart. Valid and issuable are different
 * questions: the Apps API answers the first for free, and nothing answers the
 * second except a human signing in, at which point a name the workspace refuses
 * has already locked out everyone. So names go live in small groups, and the
 * ones waiting their turn stay in the bundle where the person running the next
 * step will see them.
 *
 * Without this, staging would mean deleting the names, which would make the
 * derivation test pass by forgetting the requirement rather than by meeting it
 * -- the exact failure that test exists to prevent.
 *
 * When the target has no scope block of its own it inherits the shared default,
 * including whatever is staged there (overnight 2026-08-18: postgres and
 * workspace.workspace:read).
 */
function stagedScopes(target: string): string[] {
  const own = scopeBlock(target);
  if (own.length === 0) return defaultStagedScopes();
  return own
    .map((line) => /^\s*# - (\S+)\s*$/.exec(line)?.[1])
    .filter((scope): scope is string => Boolean(scope));
}

/** Commented-out `# - name` entries in the shared `app_user_api_scopes` default. */
function defaultStagedScopes(): string[] {
  const bundle = readFileSync(BUNDLE, 'utf8');
  const at = bundle.indexOf('\n  app_user_api_scopes:');
  if (at < 0) throw new Error('databricks.yml declares no app_user_api_scopes variable');
  const next = bundle.slice(at + 1).search(/\n {2}\w+:\n/);
  const section = next < 0 ? bundle.slice(at) : bundle.slice(at, at + 1 + next);
  const tail = section.slice(section.indexOf('default:'));
  return [...tail.matchAll(/^\s*# - (\S+)\s*$/gm)].map((m) => m[1]);
}

/** Every subject the live example deployment probes, including its tables. */
const SUBJECTS = connectionSubjects({
  configured: {
    'sql-warehouse': 'wh-0001',
    'genie-data': 'space-data',
    'genie-dictionary': 'space-dictionary',
    catalog: 'a_catalog',
    schema: 'a_schema',
    'llm-endpoint': 'a-model',
    'judge-endpoint': 'a-judge',
    'semantic-index': 'a_catalog.a_schema.an_index',
  },
  tables: ['a_catalog.a_schema.a_table'],
});

describe('the scopes the bundle declares against the scopes the probes call with', () => {
  it('accounts for every scope the example probes need, as declared or as staged', () => {
    const declared = effectiveScopes('example');
    const staged = stagedScopes('example');
    const needed = scopesProbesNeed(SUBJECTS).filter(Boolean);
    const unaccounted = needed.filter(
      (scope) => !declared.includes(scope) && !staged.includes(scope),
    );

    // Named individually, because the failure message is the whole point: the
    // developer who trips this is adding a probe and has to be told which scope
    // to add, not merely that something is inconsistent.
    expect({ unaccounted, declared, staged }).toEqual({ unaccounted: [], declared, staged });
  });

  /**
   * The exact list, pinned. Consent is all-or-nothing on Databricks Apps, so an
   * unnecessary scope is not free: one the workspace will not issue fails the
   * whole sign-in, ahead of the app, with nothing in any log to say so. That has
   * happened here, with `serving.serving-endpoints-data-plane`, and it cost a
   * day. So an ADDITION has to break this test too, not just a removal.
   */
  it('requests those and no more, so an added scope is a decision rather than a drift', () => {
    // example inherits the shared default. Workspace read and postgres are now
    // requested for the released notebook and Lakebase browsers.
    expect(effectiveScopes('example')).toEqual([
      'serving.serving-endpoints',
      'model-serving',
      'sql',
      'dashboards.genie',
      'catalog.catalogs:read',
      'catalog.schemas:read',
      'catalog.tables:read',
      'workspace.workspace:read',
      'vectorsearch.vector-search-indexes:read',
      'vectorsearch.vector-search-endpoints:read',
      'postgres',
    ]);
  });

  /**
   * example carries no scope override of its own any more. It used to re-list the
   * whole default plus the Vector Search pair; now the pair is in the default,
   * so the override was an exact duplicate -- a second copy to drift out of step
   * -- and was removed. This pins the inheritance so a well-meaning "be explicit"
   * re-list does not quietly reintroduce the drift trap.
   */
  it('carries no scope block of its own, inheriting the shared default', () => {
    expect(declaredScopes('example')).toEqual([]);
  });

  it('has no staged scopes after releasing Lakebase browse', () => {
    expect(stagedScopes('example')).toEqual([]);
  });

  // A scope cannot be both. Advancing a staged name means moving it, not
  // copying it, and a stale commented copy left behind would make the staged
  // list read as pending forever.
  it('never has a scope declared and staged at once', () => {
    const declared = effectiveScopes('example');
    expect(stagedScopes('example').filter((scope) => declared.includes(scope))).toEqual([]);
  });

  /**
   * NOT THE NAMES THE OAUTH SERVER ADVERTISES, and this test exists because the
   * obvious tidying is to make them so.
   *
   *   curl -s "$HOST/oidc/.well-known/oauth-authorization-server" | jq .scopes_supported
   *
   * answers with 56 coarse families including `unity-catalog` and
   * `vector-search`. A previous version of this file pinned those two AS the
   * right answer, on that evidence. The Apps API then rejected `unity-catalog`
   * and failed the whole bundle deploy. `user_api_scopes` is validated against a
   * narrower Apps list that overlaps the OAuth one without matching it -- in
   * both directions, since `dashboards.genie` is valid here and absent there.
   *
   * Every name in the list above was checked against the Apps API, which answers
   * without deploying and creates nothing, because it validates the scope names
   * before it checks whether the app name is taken:
   *
   *   databricks api post /api/2.0/apps -p "<your profile>" \
   *     --json '{"name":"player-insights-agent","user_api_scopes":["<name>"]}'
   *
   * "An app with the same name already exists" is a pass; "The specified scope
   * <name> is not a valid scope" is a fail. Run it before changing this list.
   */
  it('names the scopes the way the Apps API does, not the way the OAuth server does', () => {
    const declared = effectiveScopes('example');
    // `workspace` joined this list on 2026-08-18, on the same evidence and by
    // the same route: it is advertised by the OAuth server, it was written into
    // the browse code from the documentation, and the Apps API answers "The
    // specified scope workspace is not a valid scope". The accepted read name
    // is `workspace.workspace:read`. Twice now the OAuth family name has looked
    // like the answer, so the guard is a list rather than a fixed pair.
    for (const rejected of [
      'unity-catalog',
      'vector-search',
      'catalog',
      'vectorsearch',
      'workspace',
    ]) {
      expect(declared).not.toContain(rejected);
    }
  });

  /**
   * One scope per API family, rather than one coarse scope covering several.
   *
   * The coarse form is what the OAuth metadata suggests and it is not available
   * here: `catalog` alone is rejected, and so is `catalog.volumes`, so the
   * family cannot be extended by guessing either. Each probe path therefore has
   * to name its own, and a path nobody has mapped resolves to '' and fails the
   * first test above rather than borrowing a neighbour's scope.
   */
  it('maps each probed API path to its own checked scope name', () => {
    expect(scopeForPath('/api/2.1/unity-catalog/catalogs/c')).toBe('catalog.catalogs:read');
    expect(scopeForPath('/api/2.1/unity-catalog/schemas/c.s')).toBe('catalog.schemas:read');
    expect(scopeForPath('/api/2.1/unity-catalog/tables/c.s.t')).toBe('catalog.tables:read');
    expect(scopeForPath('/api/2.0/vector-search/indexes/c.s.i')).toBe(
      'vectorsearch.vector-search-indexes:read',
    );
    expect(scopeForPath('/api/2.0/vector-search/endpoints/e')).toBe(
      'vectorsearch.vector-search-endpoints:read',
    );

    // Unmapped, on purpose. A probe added against either reports no scope and
    // fails the declaration test, which is the whole guard.
    expect(scopeForPath('/api/2.1/unity-catalog/volumes/c.s.v')).toBe('');
    expect(scopeForPath('/api/2.1/unity-catalog/functions/c.s.f')).toBe('');
  });

  /**
   * Reading a token is not the same as declaring a scope, and conflating the two
   * would reintroduce the original bug with the sign flipped.
   *
   * The forwarded token's `scope` claim is minted by the OAuth server, so it
   * spells our catalog reads `unity-catalog`. If the refusal classifier compared
   * that claim to the Apps name literally, it would decide the scope is missing
   * on a token that carries it, and print a scope remedy for what is really a
   * missing grant.
   */
  it('recognises the OAuth spelling of a scope on a forwarded token', () => {
    expect(tokenCarriesScope(['unity-catalog'], 'catalog.tables:read')).toBe(true);
    expect(tokenCarriesScope(['vector-search'], 'vectorsearch.vector-search-indexes:read')).toBe(
      true,
    );
    expect(tokenCarriesScope(['catalog.tables:read'], 'catalog.tables:read')).toBe(true);
    expect(tokenCarriesScope(['workspace'], 'workspace.workspace:read')).toBe(true);
    expect(tokenCarriesScope(['all-apis'], 'catalog.tables:read')).toBe(true);

    expect(tokenCarriesScope(['sql'], 'catalog.tables:read')).toBe(false);
    expect(tokenCarriesScope([], 'catalog.tables:read')).toBe(false);
  });
});

/**
 * The shared default a customer / customer deployment inherits.
 *
 * WHY THIS IS THE GUARD THAT MATTERS. The default is now the ONE source of the
 * scope list -- example inherits it rather than re-listing it (see the block
 * above). The regression this stops: the browse scopes were once the demo workspace-ONLY, so
 * every customer deploy shipped without catalog/table listings or picker browse,
 * and the Connections page had no way to enumerate anything. They were moved
 * into the variable default on 2026-08-18, and the Vector Search pair joined
 * them on Sam's call, so every target -- customer and example alike -- requests the
 * same list. A DAB complex-variable override REPLACES the default, so the only
 * thing that keeps a *customer* deploy from silently losing them is asserting
 * the default itself -- a target that declares no block of its own gets exactly
 * this list.
 */
describe('the shared default every customer / T2 deployment inherits', () => {
  it('requests the catalog browse scopes, not just example', () => {
    const declared = defaultScopes();
    for (const scope of [
      'catalog.catalogs:read',
      'catalog.schemas:read',
      'catalog.tables:read',
    ]) {
      expect(declared).toContain(scope);
    }
  });

  it('still carries the four load-bearing base scopes', () => {
    const declared = defaultScopes();
    for (const scope of ['serving.serving-endpoints', 'model-serving', 'sql', 'dashboards.genie']) {
      expect(declared).toContain(scope);
    }
  });

  /**
   * Sam's call (2026-08-18): the Vector Search browse pair is in the SHARED
   * default alongside catalog/workspace, not example-only, so the Connections
   * pickers can enumerate VS endpoints and indexes on every deployment. It is
   * optional for OUR login gate (shared/optional-user-api-scopes.ts). The
   * caveat, kept honest: Apps consent is all-or-nothing, so a workspace that
   * cannot issue these still fails sign-in ahead of the app -- "optional" is
   * about our gate, not the platform's. That is the accepted trade for making
   * browse work everywhere by default.
   */
  it('requests the Vector Search browse scopes too, not just example', () => {
    const declared = defaultScopes();
    expect(declared).toContain('vectorsearch.vector-search-indexes:read');
    expect(declared).toContain('vectorsearch.vector-search-endpoints:read');
  });

  it('declares workspace and Lakebase browse with nothing staged', () => {
    expect(defaultScopes()).toContain('workspace.workspace:read');
    expect(defaultScopes()).toContain('postgres');
    expect(defaultStagedScopes()).toEqual([]);
  });

  /**
   * The exact default, pinned. An addition here reaches every customer's OAuth
   * consent, so it has to be a decision that updates this test, not a drift that
   * slips through. example inherits this exact list.
   */
  it('declares exactly these scopes and no more', () => {
    expect(defaultScopes()).toEqual([
      'serving.serving-endpoints',
      'model-serving',
      'sql',
      'dashboards.genie',
      'catalog.catalogs:read',
      'catalog.schemas:read',
      'catalog.tables:read',
      'workspace.workspace:read',
      'vectorsearch.vector-search-indexes:read',
      'vectorsearch.vector-search-endpoints:read',
      'postgres',
    ]);
  });
});
