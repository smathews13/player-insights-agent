import { describe, expect, it, vi, type Mock } from 'vitest';
import type { Request } from 'express';
import { qualifyDataContractTables } from '../../shared/data-contract';
import { auditGuidance } from '../../shared/stated-cause';
import {
  BLOCKED_STATUS,
  SCIM_USERS_PATH,
  SQL_ACCESS_ENTITLEMENT,
  UNKNOWN_USER_ID,
  WORKSPACE_ACCESS_ENTITLEMENT,
  accessDependenciesFrom,
  classifyDenial,
  classifyGenieProbe,
  describeImpact,
  diagnoseUserToken,
  entitlementGrant,
  entitlementLookupVia,
  extractServedConfiguration,
  forwardedUserToken,
  genieSpaceGrant,
  genieSpaceLabel,
  genieSpaceProbeFor,
  isVerified,
  limitsOfThisCheck,
  looksLikeMissingScope,
  probeStatement,
  readScimEntitlements,
  scimUserFilter,
  scopesFromToken,
  statementRunnerFor,
  statusForOutcome,
  tableGrant,
  tokenGrantsGenie,
  verificationSummary,
  verifyAccess,
  verifyGenieAccess,
  verifyTableAccess,
  verifyWarehouseAccess,
  warehouseGrant,
  warehouseProbeFor,
  type EntitlementLookup,
  type GenieProbeResult,
  type GenieSpace,
  type ProbeResult,
  type StatementRunner,
} from './access-verification';

function request(headers: Record<string, string> = {}) {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

/**
 * What a stubbed `fetch` was called with, read as a request.
 *
 * `vi.fn()` records its arguments as `any[]`, so every assertion about a
 * recorded call used to be an unchecked property read: `init.headers` compiled
 * whether or not a header was sent, and `JSON.parse(...).statement` compiled
 * against a body that had no statement in it. These three read the same calls
 * as the request they were, so a stub that stops sending a header fails the
 * case that says it sends one.
 */
function recordedRequest(mock: Mock, index = 0): { url: string; init: RequestInit } {
  const [url, init] = mock.mock.calls[index] as [string, RequestInit | undefined];
  return { url, init: init ?? {} };
}

/** The authorization header on a recorded request, in any of the three shapes. */
function authorizationOn(init: RequestInit): string {
  return new Headers(init.headers).get('authorization') ?? '';
}

/** The JSON body a recorded request carried, or an empty object. */
function jsonBodyOn(init: RequestInit): Record<string, unknown> {
  return JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>;
}

/**
 * A `fetch` stand-in that answers with one real `Response`.
 *
 * Typed as `fetch` rather than cast to it, and a genuine `Response` rather than
 * an object shaped like one, so `ok` follows from the status the way it does
 * against the real API instead of being asserted alongside it.
 */
function fetchAnswering(payload: unknown, status = 200): Mock<typeof fetch> {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    )
  );
}

const TABLES = ['main.silver.players', 'main.silver.matches'] as const;

/**
 * Two spaces, because the report always carries two and the interesting cases
 * are the ones where they disagree: a reader granted the data space and not
 * the dictionary gets a different answer per space or none worth having.
 */
const SPACES: readonly GenieSpace[] = [
  { id: 'space-data', label: 'Data Genie space \u00b7 space-data' },
  { id: 'space-dict', label: 'Dictionary Genie space \u00b7 space-dict' },
] as const;

const allowGenie = (spaceId: string): Promise<GenieProbeResult> => Promise.resolve({ ok: true, space: spaceId });
const unreachableGenie = (): Promise<GenieProbeResult> =>
  Promise.reject(new Error('the probe should not have been called'));

/** A Databricks OAuth token, in the shape the scopes are actually read from. */
function jwtWithScope(scope: string | null): string {
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

describe('telling apart the reasons there is no user token', () => {
  it('reports a present token as present', () => {
    const diagnosis = diagnoseUserToken(request({ 'x-forwarded-access-token': 'tok' }), false);
    expect(diagnosis.kind).toBe('present');
  });

  it('blames local development rather than the deployment when running outside Apps', () => {
    const diagnosis = diagnoseUserToken(request(), true);
    expect(diagnosis.kind).toBe('absent-local');
    if (diagnosis.kind === 'absent-local') {
      expect(diagnosis.layer).toBe('local development');
      expect(diagnosis.summary).toMatch(/Nothing is wrong with the deployment/);
    }
  });

  it('names app configuration, not this app\u2019s code, when Apps forwards nothing', () => {
    const diagnosis = diagnoseUserToken(request(), false);
    expect(diagnosis.kind).toBe('absent-in-apps');
    if (diagnosis.kind === 'absent-in-apps') {
      expect(diagnosis.layer).toBe('app configuration');
      // The two states that look identical, said out loud so nobody has to guess.
      expect(diagnosis.summary).toMatch(/user authorization is not enabled/i);
      expect(diagnosis.summary).toMatch(/stopped and started/i);
      expect(diagnosis.summary).toMatch(/redeploy alone does not apply/i);
    }
  });

  it('treats a blank header as absent', () => {
    expect(forwardedUserToken(request({ 'x-forwarded-access-token': '   ' }))).toBeNull();
  });
});

describe('recognising a token that lacks the scope', () => {
  it('spots the wording the platform actually uses', () => {
    expect(looksLikeMissingScope('Provided OAuth token does not have required scopes')).toBe(true);
    expect(looksLikeMissingScope('insufficient_scope')).toBe(true);
  });

  it('does not mistake a permission failure for a scope failure', () => {
    expect(looksLikeMissingScope('PERMISSION_DENIED: User does not have SELECT on Table')).toBe(false);
  });
});

describe('the probe', () => {
  it('proves the grant without reading a row of the customer\u2019s data', () => {
    expect(probeStatement('main.silver.players')).toBe('SELECT 1 FROM main.silver.players WHERE 1=0');
  });
});

describe('verifying table access', () => {
  const allow: StatementRunner = () => Promise.resolve({ ok: true });

  it('passes when every table can be read', async () => {
    const outcome = await verifyTableAccess(TABLES, allow);
    expect(outcome.ok).toBe(2);
    expect(isVerified(outcome)).toBe(true);
  });

  /**
   * Both strings were taken from the SQL Statement Execution API by running the
   * probe against a table that is not there and a catalog that is not readable,
   * with a real user token. Guessing at this wording is the failure mode the
   * whole classifier exists to avoid, so the fixtures are transcribed rather
   * than imagined: the fixture drifting from the API is the one way this can
   * be wrong in production and never wrong here.
   */
  const REAL_NOT_FOUND =
    '[TABLE_OR_VIEW_NOT_FOUND] The table or view `example`.`demo`.`no_such_table` cannot be found. ' +
    'Verify the spelling and correctness of the schema and catalog.';
  const REAL_INSUFFICIENT =
    "[INSUFFICIENT_PERMISSIONS] Insufficient privileges:\nCatalog 'main' is not accessible in current workspace SQLSTATE: 42501";

  it('reads the wording the API actually returns for a table it will not show you', async () => {
    const outcome = await verifyTableAccess(['a.b.c'], () => Promise.resolve({ ok: false, message: REAL_NOT_FOUND }));
    expect(outcome.verdicts[0].status).toBe('denied');
    expect(outcome.verdicts[0].reason).toBe('hidden-or-absent');
    expect(outcome.verdicts[0].missing).toEqual({
      object: 'a.b.c',
      permission: 'SELECT',
      objectKind: 'table',
    });
  });

  /**
   * The fixture names the CATALOG, not the table, and the grant that fixes it
   * is USE CATALOG. Telling this reader to grant themselves SELECT on a table
   * inside a catalog they cannot enter is a statement that runs, changes
   * nothing they can observe, and sends them back around the loop.
   */
  it('names the catalog and USE CATALOG when the refusal is at the catalog', async () => {
    const outcome = await verifyTableAccess(['main.x.y'], () =>
      Promise.resolve({ ok: false, message: REAL_INSUFFICIENT })
    );
    expect(outcome.verdicts[0].status).toBe('denied');
    expect(outcome.verdicts[0].reason).toBe('no-grant');
    expect(outcome.verdicts[0].missing).toEqual({
      object: 'main',
      permission: 'USE CATALOG',
      objectKind: 'catalog',
    });
    // The table it was reached through is still named, or the reader cannot
    // tell which of ten checks this was.
    expect(outcome.verdicts[0].detail).toContain('main.x.y');
  });

  it('keeps the API\u2019s own words beside the classification', async () => {
    const outcome = await verifyTableAccess(['main.x.y'], () =>
      Promise.resolve({ ok: false, message: REAL_INSUFFICIENT })
    );
    expect(outcome.verdicts[0].apiMessage).toBe(REAL_INSUFFICIENT);
  });

  it('names the exact object and permission when a grant is missing', async () => {
    const outcome = await verifyTableAccess(
      TABLES,
      (table) =>
        Promise.resolve(
          table === 'main.silver.matches'
            ? { ok: false, message: 'PERMISSION_DENIED: User does not have SELECT on Table' }
            : { ok: true }
        ),
      'reviewer@example.com'
    );
    const denied = outcome.verdicts.find((v) => v.status === 'denied');
    expect(denied?.missing).toEqual({
      object: 'main.silver.matches',
      permission: 'SELECT',
      objectKind: 'table',
    });
    expect(denied?.detail).toContain('main.silver.matches');
    // The point of the whole exercise: the statement that would fix it, ready
    // to paste, naming the person who is short of it.
    expect(denied?.remedy?.kind).toBe('sql');
    expect(denied?.remedy?.statement).toContain(
      'GRANT SELECT ON TABLE `main`.`silver`.`matches` TO `reviewer@example.com`;'
    );
    expect(isVerified(outcome)).toBe(false);
  });

  it('treats a table Unity Catalog hides as denied, and says the two are indistinguishable', async () => {
    const outcome = await verifyTableAccess(['main.silver.players'], () =>
      Promise.resolve({
        ok: false,
        message: '[TABLE_OR_VIEW_NOT_FOUND] The table or view cannot be found',
      })
    );
    expect(outcome.verdicts[0].status).toBe('denied');
    expect(outcome.verdicts[0].detail).toMatch(/hides objects it cannot traverse/);
    // And says what to conclude when the grants below it do not help.
    expect(outcome.verdicts[0].detail).toMatch(/the table is the one that is missing/);
  });

  it('records an unrecognised failure as unknown rather than as denied', async () => {
    const outcome = await verifyTableAccess(['main.silver.players'], () =>
      Promise.resolve({
        ok: false,
        message: 'Warehouse is starting',
      })
    );
    expect(outcome.verdicts[0].status).toBe('error');
    expect(outcome.verdicts[0].detail).toMatch(/not a permission result/);
    expect(outcome.errored).toBe(1);
    expect(isVerified(outcome)).toBe(false);
  });

  it('survives a runner that throws', async () => {
    const outcome = await verifyTableAccess(['main.silver.players'], () => Promise.reject(new Error('socket hang up')));
    expect(outcome.verdicts[0].status).toBe('error');
  });

  it('stops and blames configuration when the token lacks the sql scope', async () => {
    const outcome = await verifyTableAccess(TABLES, () =>
      Promise.resolve({
        ok: false,
        message: 'Provided OAuth token does not have required scopes',
      })
    );
    expect(outcome.blocked?.layer).toBe('app configuration');
    expect(outcome.blocked?.kind).toBe('no-sql-scope');
    expect(outcome.blocked?.summary).toMatch(/nothing about your own permissions was established/);
    // The sentence that stops this being read as a denial. The reader is not
    // short of anything; the app is, and no grant made to them would help.
    expect(outcome.blocked?.summary).toMatch(/not a permission you are missing/);
    // Not reported as a denial: the user was never actually asked about.
    expect(outcome.denied).toBe(0);
    expect(isVerified(outcome)).toBe(false);
  });

  it('refuses to call a partial pass verified', async () => {
    const outcome = await verifyTableAccess(TABLES, (table) =>
      Promise.resolve(table === 'main.silver.matches' ? { ok: false, message: 'PERMISSION_DENIED' } : { ok: true })
    );
    expect(outcome.ok).toBe(1);
    expect(isVerified(outcome)).toBe(false);
  });

  it('refuses to call an empty run verified', async () => {
    expect(isVerified(await verifyTableAccess([], allow))).toBe(false);
  });
});

describe('the summary written into the audit record', () => {
  it('states what was verified under the reader token, not who executes', async () => {
    const outcome = await verifyTableAccess(TABLES, () => Promise.resolve({ ok: true }));
    const summary = verificationSummary(outcome);
    expect(summary).toContain('2 tables');
    expect(summary).toContain('under your own token');
    expect(summary).not.toMatch(/execution still runs as/i);
  });

  it('still reads as a verification record when no serving principal was observed', async () => {
    const outcome = await verifyTableAccess(['t'], () => Promise.resolve({ ok: true }));
    expect(verificationSummary(outcome)).toContain('under your own token');
    expect(verificationSummary(outcome)).not.toMatch(/execution still runs as/i);
  });
});

/**
 * Both strings are the ones pinned above, re-read here as classification
 * rather than as verdicts, because the classifier is what everything else
 * hangs off and it is the piece that can be wrong in production and right
 * locally.
 */
describe('telling the failure modes apart', () => {
  it('reads INSUFFICIENT_PERMISSIONS as a grant that is missing, not an object that is absent', () => {
    const denial = classifyDenial(
      "[INSUFFICIENT_PERMISSIONS] Insufficient privileges:\nCatalog 'main' is not accessible in current workspace SQLSTATE: 42501",
      'main.x.y'
    );
    expect(denial).toEqual({
      kind: 'no-grant',
      object: 'main',
      objectKind: 'catalog',
      permission: 'USE CATALOG',
    });
  });

  it('reads a schema refusal as USE SCHEMA on that schema', () => {
    const denial = classifyDenial(
      "[INSUFFICIENT_PERMISSIONS] Insufficient privileges: Schema 'main.silver' is not accessible SQLSTATE: 42501",
      'main.silver.players'
    );
    expect(denial).toEqual({
      kind: 'no-grant',
      object: 'main.silver',
      objectKind: 'schema',
      permission: 'USE SCHEMA',
    });
  });

  it('falls back to SELECT on the table when the refusal names no level', () => {
    expect(classifyDenial('SQLSTATE: 42501 insufficient privileges', 'c.s.t')).toEqual({
      kind: 'no-grant',
      object: 'c.s.t',
      objectKind: 'table',
      permission: 'SELECT',
    });
  });

  it('will not claim a hidden object is a missing grant, or the reverse', () => {
    expect(classifyDenial('[TABLE_OR_VIEW_NOT_FOUND] cannot be found', 'c.s.t').kind).toBe('hidden-or-absent');
  });

  it('refuses to classify a failure it does not recognise', () => {
    expect(classifyDenial('socket hang up', 'c.s.t').kind).toBe('unrecognised');
    expect(classifyDenial('The statement ended in state CANCELED.', 'c.s.t').kind).toBe('unrecognised');
  });
});

describe('the statement that would fix it', () => {
  it('grants the traversal privileges as well as SELECT, because any of them can be the absent one', () => {
    const remedy = tableGrant('cat.sch.tbl', 'reviewer@example.com');
    expect(remedy.statement.split('\n')).toEqual([
      'GRANT USE CATALOG ON CATALOG `cat` TO `reviewer@example.com`;',
      'GRANT USE SCHEMA ON SCHEMA `cat`.`sch` TO `reviewer@example.com`;',
      'GRANT SELECT ON TABLE `cat`.`sch`.`tbl` TO `reviewer@example.com`;',
    ]);
  });

  /**
   * This USED TO ASSERT the note named who can run it. The same fact IS still
   * kept, on the probe's table grant in `dependency-probes.ts`, because there the
   * statement is a bare `GRANT SELECT` and the traversal privileges are the thing
   * a reader would miss. Here the statement already lists all three, so a
   * sentence explaining why is explaining what is on screen.
   *
   * Who can run them is a real gap and it is not this field's: it is a `run_by`,
   * which the gate does not offer yet.
   */
  it('adds nothing the statement above it does not already show', () => {
    expect(tableGrant('c.s.t', 'a@b.c').guidance).toBe('');
  });

  it('escapes a backtick rather than emitting a statement that will not parse', () => {
    expect(tableGrant('c.s.we`ird', 'a@b.c').statement).toContain('`we``ird`');
  });

  /**
   * A warehouse is a workspace object, so offering a SQL GRANT for it would
   * send the reader to a statement that cannot work. The CLI shape mirrors
   * `_permissions_cli` in the agent's preflight on purpose.
   */
  it('uses the permissions API for a warehouse, not a GRANT', () => {
    const remedy = warehouseGrant('wh-1', 'reviewer@example.com');
    expect(remedy.kind).toBe('cli');
    expect(remedy.statement).toContain('databricks permissions update warehouses wh-1');
    expect(remedy.statement).toContain('"user_name":"reviewer@example.com"');
    expect(remedy.statement).toContain('"permission_level":"CAN_USE"');
  });

  it('names a service principal by the field the API expects for one', () => {
    expect(warehouseGrant('wh-1', 'ca9f730e-186a-4809-b8b7-000000000000').statement).toContain(
      '"service_principal_name":'
    );
  });
});

/**
 * The bug this stage exists to fix. Without it a reader short of CAN_USE on
 * the warehouse is told ten times over that they lack SELECT on tables they
 * may well hold, ten wrong GRANTs, one real fix, and nothing on the screen
 * to tell them apart.
 */
describe('checking the warehouse before checking any table', () => {
  const denied = {
    ok: false as const,
    message: 'PERMISSION_DENIED: User does not have permission to use warehouse abc123. SQLSTATE: 42501',
  };

  it('passes silently when SELECT 1 succeeds', async () => {
    expect(await verifyWarehouseAccess('abc123', () => Promise.resolve({ ok: true }))).toBeNull();
  });

  it('names CAN_USE on the warehouse, and says no table was checked', async () => {
    const blocked = await verifyWarehouseAccess('abc123', () => Promise.resolve(denied), 'reviewer@example.com');
    expect(blocked?.kind).toBe('warehouse-denied');
    expect(blocked?.missing).toEqual({
      object: 'abc123',
      permission: 'CAN_USE',
      objectKind: 'sql-warehouse',
    });
    expect(blocked?.summary).toMatch(/No table was checked/);
    expect(blocked?.remedy?.statement).toContain('databricks permissions update warehouses abc123');
    expect(blocked?.apiMessage).toBe(denied.message);
  });

  it('reports no table verdicts at all when the warehouse refused, rather than ten false ones', async () => {
    const table = vi.fn();
    const outcome = await verifyAccess(
      { tables: [...TABLES], warehouseId: 'abc123', principal: 'reviewer@example.com' },
      { warehouse: () => Promise.resolve(denied), table: table as unknown as StatementRunner }
    );
    expect(outcome.verdicts).toEqual([]);
    expect(outcome.denied).toBe(0);
    expect(table).not.toHaveBeenCalled();
    expect(isVerified(outcome)).toBe(false);
  });

  it('separates a warehouse that is down from one that refused', async () => {
    const blocked = await verifyWarehouseAccess('abc123', () =>
      Promise.resolve({
        ok: false,
        message: 'The statement ended in state CANCELED.',
      })
    );
    expect(blocked?.kind).toBe('dependency-down');
    expect(blocked?.missing).toBeUndefined();
    expect(blocked?.summary).toMatch(/did not refuse it for a permission/);
  });

  it('still calls a missing scope a scope problem when it surfaces at the warehouse', async () => {
    const blocked = await verifyWarehouseAccess('abc123', () =>
      Promise.resolve({
        ok: false,
        message: 'Provided OAuth token does not have required scopes',
      })
    );
    expect(blocked?.kind).toBe('no-sql-scope');
    expect(blocked?.summary).toMatch(/not a permission you are missing/);
    expect(blocked?.remedy?.statement).toContain('databricks apps stop');
    expect(blocked?.remedy?.statement).toContain('databricks apps start');
  });

  it('probes with a statement that names no object, so its refusal cannot be about one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: { state: 'SUCCEEDED' } }),
    });
    const probe = warehouseProbeFor({
      host: 'https://h',
      token: 't',
      warehouseId: 'wh-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await probe()).toEqual({ ok: true });
    expect(jsonBodyOn(recordedRequest(fetchImpl).init).statement).toBe('SELECT 1');
  });
});

/**
 * The bug the access gate shipped with: an HTTP 403 read as an unhealthy
 * warehouse.
 *
 * A status code is not prose and should never have been classified as prose.
 * These pin each of the four codes to the thing it actually means, because
 * they send four different people to four different places.
 */
describe('the HTTP status a refusal arrived with', () => {
  /** A warehouse probe against an API that answers `status` with `body`. */
  function probeAnswering(status: number, body: Record<string, unknown> = {}) {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status, json: () => Promise.resolve(body) });
    return warehouseProbeFor({
      host: 'https://h',
      token: 't',
      warehouseId: 'wh-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  }

  it('carries the status out of the executor instead of flattening it into prose', async () => {
    // The whole root cause in one assertion: `HTTP 403` as a message is not a
    // fact anything downstream can read, and the number was the only fact there was.
    expect(await probeAnswering(403)()).toMatchObject({ ok: false, status: 403 });
  });

  it('reads a 403 as the permission refusal it is, not as an unhealthy warehouse', async () => {
    const blocked = await verifyWarehouseAccess('wh-1', probeAnswering(403), 'reviewer@example.com');
    expect(blocked?.kind).toBe('warehouse-denied');
    // The hint on the panel comes from this, and pointing at availability for a
    // 403 sends the reader to restart a warehouse that is already running.
    expect(blocked?.layer).toBe('SQL warehouse permissions');
    expect(blocked?.missing).toEqual({
      object: 'wh-1',
      permission: 'CAN_USE',
      objectKind: 'sql-warehouse',
    });
    expect(blocked?.remedy?.statement).toContain('databricks permissions update warehouses wh-1');
    // The two sentences that were false on the screen, named so they cannot come back.
    expect(blocked?.summary).not.toMatch(/stopped, starting, or unhealthy/);
    expect(blocked?.summary).not.toMatch(/did not refuse it for a permission/);
  });

  it('still calls a 403 a permission refusal when the body carries no message at all', async () => {
    const blocked = await verifyWarehouseAccess('wh-1', probeAnswering(403), 'reviewer@example.com');
    expect(blocked?.kind).toBe('warehouse-denied');
    // And says which code it read, so the classification can be checked.
    expect(blocked?.apiMessage).toMatch(/403/);
  });

  /**
   * A rejected token and a missing grant are not the same event and do not
   * have the same fix. Telling somebody to ask for CAN_USE when their token
   * expired sends them to an admin for a grant that would change nothing.
   */
  it('reads a 401 as a token that was rejected, not a grant that is missing', async () => {
    const blocked = await verifyWarehouseAccess('wh-1', probeAnswering(401), 'reviewer@example.com');
    expect(blocked?.kind).toBe('token-rejected');
    expect(blocked?.missing).toBeUndefined();
    expect(blocked?.summary).toMatch(/not a permission you are missing/);
    expect(blocked?.remedy?.statement).not.toContain('databricks permissions update');
  });

  /**
   * A warehouse id that resolves to nothing is an app configuration problem.
   * Reporting it as "unhealthy" sends somebody to restart a warehouse that
   * does not exist, and reporting it as CAN_USE sends them to grant a
   * permission on an object that cannot hold one.
   */
  it('reads a 404 as a warehouse id that does not resolve, and does not offer a grant for it', async () => {
    const blocked = await verifyWarehouseAccess('wh-1', probeAnswering(404), 'reviewer@example.com');
    expect(blocked?.kind).toBe('warehouse-missing');
    expect(blocked?.layer).toBe('SQL warehouse configuration');
    expect(blocked?.missing).toBeUndefined();
    expect(blocked?.summary).toMatch(/wh-1/);
    expect(blocked?.remedy?.statement).not.toContain('databricks permissions update');
    expect(blocked?.summary).not.toMatch(/stopped, starting, or unhealthy/);
  });

  it('leaves a 5xx as the dependency being down, which is what it is', async () => {
    const blocked = await verifyWarehouseAccess('wh-1', probeAnswering(503), 'reviewer@example.com');
    expect(blocked?.kind).toBe('dependency-down');
    expect(blocked?.missing).toBeUndefined();
  });

  /**
   * The one case where the body outranks the code. A scope failure arrives as
   * a 403 too, and it is not a grant the reader is short of. It is a scope
   * the app is short of, fixed by a stop and start rather than by an admin.
   */
  it('still calls a 403 carrying scope wording a scope problem, not a warehouse grant', async () => {
    const blocked = await verifyWarehouseAccess(
      'wh-1',
      probeAnswering(403, { message: 'Provided OAuth token does not have required scopes' }),
      'reviewer@example.com'
    );
    expect(blocked?.kind).toBe('no-sql-scope');
  });

  it('keeps reading permission wording on a 200 that failed, where there is no status to read', async () => {
    const blocked = await verifyWarehouseAccess(
      'wh-1',
      () => Promise.resolve({ ok: false, message: 'PERMISSION_DENIED: SQLSTATE: 42501' }),
      'reviewer@example.com'
    );
    expect(blocked?.kind).toBe('warehouse-denied');
  });
});

/**
 * The second thing a bare 403 means, and the confident wrong answer it used to
 * get.
 *
 * The distinction is not in the response, so it cannot be classified out of
 * one. It has to be a second question, and these pin what the screen says for
 * each of the three answers it can come back with.
 */
describe('telling a missing entitlement apart from a missing CAN_USE', () => {
  const REFUSED = { ok: false as const, status: 403, message: 'Databricks answered HTTP 403 with no message body.' };
  const READER = 'reviewer@example.com';

  /** A SCIM user search, in the shape the API actually answers with. */
  function scimUser(entitlements?: string[]) {
    return {
      totalResults: 1,
      Resources: [
        {
          id: '1122334455667788',
          userName: READER,
          displayName: 'A Reviewer',
          // Omitted entirely rather than sent as `[]` when there are none:
          // SCIM drops empty multi-valued attributes, which is how "this
          // account carries nothing" actually arrives on the wire.
          ...(entitlements ? { entitlements: entitlements.map((value) => ({ value })) } : {}),
        },
      ],
    };
  }

  const lookupReturning = (body: unknown): EntitlementLookup => entitlementLookupVia(() => Promise.resolve(body));

  it('names the entitlement, not the warehouse, when SCIM says it is absent', async () => {
    const blocked = await verifyWarehouseAccess(
      'wh-1',
      () => Promise.resolve(REFUSED),
      READER,
      lookupReturning(scimUser())
    );

    expect(blocked?.kind).toBe('no-sql-entitlement');
    expect(blocked?.layer).toBe('workspace entitlements');
    // The object short of something is the ACCOUNT. An entitlement is an
    // assignment on an identity, and naming the warehouse here is the whole
    // bug in one field.
    expect(blocked?.missing).toEqual({
      object: READER,
      permission: SQL_ACCESS_ENTITLEMENT,
      objectKind: 'workspace-entitlement',
    });
    expect(blocked?.summary).toContain(SQL_ACCESS_ENTITLEMENT);
    // The sentence that stops the reader going back to the ACL, which is where
    // the old message sent them and where there was nothing to find.
    expect(blocked?.summary).toMatch(/no CAN_USE added to that warehouse would change it/);
    expect(blocked?.summary).toMatch(/read from SCIM, not inferred from the refusal/);
    // The screen has to be enough on its own: the entitlement, who can grant it,
    // and the command. There is no document left to send anyone to.
    expect(blocked?.summary).toMatch(/A workspace admin can grant it/);
    expect(blocked?.remedy?.statement).toContain('scim/v2/Users');
    // Who can grant it is on the summary, asserted above. The remedy's one line
    // is now only the thing the statement can be got wrong on.
    expect(blocked?.remedy?.guidance).toMatch(/not an email/);
  });

  it('offers the SCIM patch against the real user id, not a permissions update', async () => {
    const blocked = await verifyWarehouseAccess(
      'wh-1',
      () => Promise.resolve(REFUSED),
      READER,
      lookupReturning(scimUser([WORKSPACE_ACCESS_ENTITLEMENT]))
    );

    expect(blocked?.remedy?.kind).toBe('cli');
    // The id comes from the lookup that just succeeded, so the command is
    // runnable as printed rather than a template to go and fill in.
    expect(blocked?.remedy?.statement).toContain(
      'databricks api patch /api/2.0/preview/scim/v2/Users/1122334455667788'
    );
    expect(blocked?.remedy?.statement).toContain('"op":"add","path":"entitlements"');
    expect(blocked?.remedy?.statement).toContain(`{"value":"${SQL_ACCESS_ENTITLEMENT}"}`);
    // And the remedy that does nothing for this reader is NOT on the screen.
    expect(blocked?.remedy?.statement).not.toContain('databricks permissions update');
  });

  /**
   * The other half of the same fix, and the one that keeps it honest: an
   * entitlement the reader HOLDS must not soften the CAN_USE finding. If this
   * regressed into always blaming the entitlement, the module would have
   * traded one confident wrong answer for another.
   */
  it('still names CAN_USE, with the warehouse remedy, when the entitlement is held', async () => {
    const blocked = await verifyWarehouseAccess(
      'wh-1',
      () => Promise.resolve(REFUSED),
      READER,
      lookupReturning(scimUser([WORKSPACE_ACCESS_ENTITLEMENT, SQL_ACCESS_ENTITLEMENT]))
    );

    expect(blocked?.kind).toBe('warehouse-denied');
    expect(blocked?.summary).toMatch(/You do not hold CAN_USE on SQL warehouse wh-1/);
    expect(blocked?.missing).toEqual({
      object: 'wh-1',
      permission: 'CAN_USE',
      objectKind: 'sql-warehouse',
    });
    expect(blocked?.remedy?.statement).toContain('databricks permissions update warehouses wh-1');
    // Says the other cause was ruled out rather than merely not mentioned, so
    // the reader knows the ACL is worth editing this time.
    expect(blocked?.summary).toMatch(/does carry the `databricks-sql-access` entitlement/);
  });

  /**
   * A non-admin token can generally read itself and nothing else, so the
   * lookup being refused is an ordinary outcome and not an error state. What
   * it must never do is turn silence into a finding: an unreadable account has
   * established nothing about anybody's entitlements, and reporting one either
   * way would be the same defect aimed at a different object.
   */
  it('falls back to today\u2019s message when SCIM itself refuses the lookup', async () => {
    const blocked = await verifyWarehouseAccess(
      'wh-1',
      () => Promise.resolve(REFUSED),
      READER,
      () => Promise.reject(new Error('403 PERMISSION_DENIED: cannot read users'))
    );

    expect(blocked?.kind).toBe('warehouse-denied');
    // Today's message, unchanged, down to the object and the remedy.
    expect(blocked?.summary).toMatch(/You do not hold CAN_USE on SQL warehouse wh-1/);
    expect(blocked?.remedy?.statement).toContain('databricks permissions update warehouses wh-1');
    // Plus the one thing that was learned, which is that nothing was learned.
    // Not a guess about the cause: a statement that the other cause is still
    // open, and the command to close it.
    expect(blocked?.summary).toMatch(/could not be checked here/);
    expect(blocked?.summary).toContain('cannot read users');
    expect(blocked?.summary).toContain('scim/v2/Users?filter=userName+eq+');
    // It must not claim the entitlement is missing, which is the failure mode
    // of guessing from a refused lookup.
    expect(blocked?.summary).not.toMatch(/does not carry the/);
  });

  it('treats a filter that matched nobody as unreadable, not as an account with nothing', async () => {
    const blocked = await verifyWarehouseAccess(
      'wh-1',
      () => Promise.resolve(REFUSED),
      READER,
      lookupReturning({ totalResults: 0, Resources: [] })
    );

    expect(blocked?.kind).toBe('warehouse-denied');
    expect(blocked?.summary).toMatch(/could not be checked here/);
  });

  /**
   * Cost. The lookup is a workspace round trip on a request somebody is
   * waiting on, and every reader who is correctly provisioned takes the happy
   * path, so it may only run once a refusal has made it matter.
   */
  it('does not ask SCIM anything when the warehouse answered', async () => {
    const lookup = vi.fn<EntitlementLookup>();
    expect(await verifyWarehouseAccess('wh-1', () => Promise.resolve({ ok: true }), READER, lookup)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  /**
   * And only for the refusal whose cause the response withheld. The other
   * codes already say what they are: 401 is a token, 404 is a configured id,
   * and a scope refusal names itself in the body. Asking SCIM about any of
   * them buys nothing and risks re-reporting a deployment state as something
   * about the reader.
   */
  it.each([
    ['a rejected token', 401, {}],
    ['an absent warehouse', 404, {}],
    ['a missing scope', 403, { message: 'Provided OAuth token does not have required scopes' }],
  ])('does not ask SCIM about %s', async (_label, status, body) => {
    const lookup = vi.fn<EntitlementLookup>();
    await verifyWarehouseAccess(
      'wh-1',
      () =>
        Promise.resolve({
          ok: false,
          status,
          message: String((body as { message?: string }).message ?? 'no body'),
        }),
      READER,
      lookup
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reports the entitlement block as a denial, because somebody was asked and told no', () => {
    expect(BLOCKED_STATUS['no-sql-entitlement']).toBe(403);
  });

  it('carries through the whole check without probing a single table', async () => {
    const table = vi.fn();
    const outcome = await verifyAccess(
      { tables: [...TABLES], warehouseId: 'wh-1', principal: READER },
      {
        warehouse: () => Promise.resolve(REFUSED),
        table: table as unknown as StatementRunner,
        entitlements: lookupReturning(scimUser()),
      }
    );

    expect(outcome.blocked?.kind).toBe('no-sql-entitlement');
    expect(table).not.toHaveBeenCalled();
    expect(outcome.verdicts).toEqual([]);
    expect(isVerified(outcome)).toBe(false);
    expect(statusForOutcome(outcome)).toBe(403);
  });

  /**
   * A deployment with no lookup wired reports exactly what it reported before
   * this existed. The correct degradation is to leave one of the two causes
   * unnamed, never to invent which one it was.
   */
  it('is unchanged when no lookup is supplied at all', async () => {
    const blocked = await verifyWarehouseAccess('wh-1', () => Promise.resolve(REFUSED), READER);
    expect(blocked?.kind).toBe('warehouse-denied');
    expect(blocked?.summary).toMatch(/You do not hold CAN_USE on SQL warehouse wh-1/);
    expect(blocked?.summary).not.toMatch(/could not be checked here/);
    expect(blocked?.summary).not.toContain(SQL_ACCESS_ENTITLEMENT);
  });
});

describe('reading the entitlements off a SCIM answer', () => {
  it('reads the values out of the complex attributes SCIM returns', () => {
    expect(
      readScimEntitlements({
        Resources: [
          {
            id: '42',
            entitlements: [{ value: 'workspace-access' }, { value: 'databricks-sql-access' }],
          },
        ],
      })
    ).toEqual({ kind: 'read', entitlements: ['workspace-access', 'databricks-sql-access'], userId: '42' });
  });

  /**
   * The state that actually produced both of today's failures: an account with
   * no entitlements of its own. SCIM omits an empty multi-valued attribute
   * rather than sending `[]`, so this is what "carries none" looks like, and
   * reading the absent key as "unknown" would make the check useless in the
   * exact case it exists for.
   */
  it('reads an omitted entitlements attribute as an account carrying none', () => {
    expect(readScimEntitlements({ Resources: [{ id: '42', userName: 'a@b.c' }] })).toEqual({
      kind: 'read',
      entitlements: [],
      userId: '42',
    });
  });

  it('does not read an empty search as an account with nothing', () => {
    const reading = readScimEntitlements({ totalResults: 0, Resources: [] });
    expect(reading.kind).toBe('unavailable');
    if (reading.kind === 'unavailable') {
      // Names the two readings it cannot tell apart, rather than picking one.
      expect(reading.why).toMatch(/cannot read that account or the address is not the one/);
    }
  });

  it('does not read a shapeless answer as an account with nothing', () => {
    expect(readScimEntitlements({}).kind).toBe('unavailable');
    expect(readScimEntitlements(null).kind).toBe('unavailable');
  });

  it('survives a user the API returned without an id', () => {
    expect(readScimEntitlements({ Resources: [{ entitlements: ['workspace-access'] }] })).toEqual({
      kind: 'read',
      entitlements: ['workspace-access'],
      userId: null,
    });
  });
});

describe('the lookup that asks the workspace', () => {
  /**
   * The filter travels as a QUERY, not inside the path, and this is not
   * stylistic. The Databricks SDK assigns `path` straight onto `URL.pathname`,
   * which percent-encodes a `?` rather than starting a query string, so a
   * filter smuggled into the path reaches the API as part of the resource name
   * and comes back 404. That would degrade to "the entitlement could not be
   * checked" on every single call, and would look like a permissions problem
   * rather than the URL bug it is.
   */
  it('sends the filter as a query parameter rather than inside the path', async () => {
    const get = vi.fn().mockResolvedValue({ Resources: [{ id: '7' }] });
    await entitlementLookupVia(get)('reviewer@example.com');

    expect(get).toHaveBeenCalledWith(SCIM_USERS_PATH, { filter: 'userName eq reviewer@example.com' });
    expect(SCIM_USERS_PATH).not.toContain('?');
  });

  /** The same query the remedy note tells a reader to run by hand. */
  it('builds the filter in the form a reader can reproduce from the CLI', () => {
    expect(scimUserFilter('a@b.c')).toEqual({ filter: 'userName eq a@b.c' });
  });

  it('reports a refusal as unreadable, with what the API said', async () => {
    const reading = await entitlementLookupVia(() => Promise.reject(new Error('PERMISSION_DENIED')))('a@b.c');
    expect(reading.kind).toBe('unavailable');
    if (reading.kind === 'unavailable') expect(reading.why).toContain('PERMISSION_DENIED');
  });

  /**
   * Local development signs in as a placeholder rather than an address, and
   * there is nothing to look up for one. Asking anyway would produce a refusal
   * reported as though the workspace had said something about somebody.
   */
  it('does not call the API for an identity that is not an address', async () => {
    const get = vi.fn();
    const reading = await entitlementLookupVia(get)('local-development');
    expect(get).not.toHaveBeenCalled();
    expect(reading.kind).toBe('unavailable');
  });
});

describe('the SCIM patch that clears it', () => {
  it('adds both entitlements, because the patch that adds one should add both', () => {
    const remedy = entitlementGrant('998877');
    expect(remedy.statement).toContain('/api/2.0/preview/scim/v2/Users/998877');
    expect(remedy.statement).toContain('"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"]');
    expect(remedy.statement).toContain(`{"value":"${SQL_ACCESS_ENTITLEMENT}"}`);
    expect(remedy.statement).toContain(`{"value":"${WORKSPACE_ACCESS_ENTITLEMENT}"}`);
  });

  /**
   * Left obviously unfilled rather than guessed, on the same reasoning as
   * `UNKNOWN_PRINCIPAL`: SCIM patches by numeric id, and a patch aimed at the
   * wrong id is a patch that runs.
   */
  it('leaves the id visibly blank rather than inventing one', () => {
    expect(entitlementGrant(null).statement).toContain(UNKNOWN_USER_ID);
    expect(entitlementGrant('   ').statement).toContain(UNKNOWN_USER_ID);
  });

  /**
   * The ONE fact kept out of the paragraph that used to sit here. The statement
   * carries `<numeric-user-id>` for the reader to fill in, and the obvious thing
   * to type there is the email address naming the person everywhere else on the
   * screen -- a patch that RUNS, against whatever that string resolves to.
   *
   * Dropped with the rest: who can run it (the summary says it), how to read the
   * id back (a second command), and that entitlements are usually held through a
   * group. The last was the most tempting; it explains why the Admin Settings
   * page disagrees with this screen, which is worth knowing and is not needed to
   * run the patch correctly.
   */
  it('says the id is not an email, which is the one way to get this patch wrong', () => {
    const guidance = entitlementGrant('1').guidance;
    expect(guidance).toMatch(/numeric SCIM id/);
    expect(guidance).toMatch(/not an email/);
    expect(auditGuidance('entitlement grant', guidance)).toEqual([]);
  });
});

/**
 * `wait_timeout: '30s'` bounds the statement inside the warehouse. It says
 * nothing about the socket, and the call carried no signal at all, so a
 * connection that was accepted and then went quiet left the probe pending
 * forever, one probe per table, with somebody sitting at the access gate.
 */
describe('a warehouse that accepts the connection and says nothing', () => {
  /** Behaves as `fetch` does: pending until the signal aborts, then rejecting. */
  const silentSocket: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason as Error));
    });

  it('gives up on the statement and says how long it waited', async () => {
    const run = statementRunnerFor({
      host: 'https://h',
      token: 't',
      warehouseId: 'wh-1',
      fetchImpl: silentSocket,
      timeoutMs: 30,
    });

    const result = await run('main.silver.players');

    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(/did not answer within 30 ms/);
  });

  it('leaves it as one unestablished table rather than a verified run', async () => {
    const run = statementRunnerFor({
      host: 'https://h',
      token: 't',
      warehouseId: 'wh-1',
      fetchImpl: silentSocket,
      timeoutMs: 30,
    });

    const outcome = await verifyTableAccess(['main.silver.players'], run);

    expect(outcome.errored).toBe(1);
    // Unknown is not permission: the mode's whole claim is that the user could
    // have read the data, and a check that never finished does not support it.
    expect(isVerified(outcome)).toBe(false);
  });

  it('passes the deadline to fetch as a signal, so the socket is actually dropped', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: { state: 'SUCCEEDED' } }),
    });
    const probe = warehouseProbeFor({
      host: 'https://h',
      token: 't',
      warehouseId: 'wh-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      waitTimeoutSeconds: 5,
    });

    await probe();

    const signal = (fetchImpl.mock.calls[0][1] as RequestInit).signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(jsonBodyOn(recordedRequest(fetchImpl).init)).toMatchObject({
      wait_timeout: '5s',
      on_wait_timeout: 'CANCEL',
    });
  });
});

describe('the budget over all the table probes', () => {
  it('stops probing once it is spent, and says which tables it never asked about', async () => {
    // A clock the probes move rather than a real wait: each probe costs 40 s, so
    // the third one is past a 60 s budget.
    let clock = 0;
    const slow: StatementRunner = () => {
      clock += 40_000;
      return Promise.resolve({ ok: true } as const);
    };

    const outcome = await verifyTableAccess(['a.b.one', 'a.b.two', 'a.b.three', 'a.b.four'], slow, undefined, {
      budgetMs: 60_000,
      now: () => clock,
    });

    expect(outcome.verdicts.map((verdict) => verdict.status)).toEqual(['ok', 'ok', 'error', 'error']);
    // Named, not dropped: a check that shrinks the set of tables that had to
    // pass is how a partial run turns into a green tick.
    expect(outcome.verdicts).toHaveLength(4);
    expect(outcome.verdicts[2].detail).toMatch(/60 s budget/);
    expect(outcome.verdicts[2].detail).toContain('a.b.three');
    expect(isVerified(outcome)).toBe(false);
  });

  it('does not interfere with a warehouse answering at a normal speed', async () => {
    let clock = 0;
    const quick: StatementRunner = () => {
      clock += 400;
      return Promise.resolve({ ok: true } as const);
    };

    const outcome = await verifyTableAccess(TABLES, quick, undefined, { now: () => clock });

    expect(isVerified(outcome)).toBe(true);
  });

  it('checks all twelve tables with bounded concurrency instead of twelve serial waits', async () => {
    const tables = Array.from({ length: 12 }, (_value, index) => `catalog.schema.table_${index + 1}`);
    let inFlight = 0;
    let maximumInFlight = 0;
    let calls = 0;
    const probe: StatementRunner = async () => {
      calls += 1;
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return { ok: true };
    };
    const started = performance.now();

    const outcome = await verifyTableAccess(tables, probe, undefined, {
      budgetMs: 1_000,
      concurrency: 6,
    });

    expect(performance.now() - started).toBeLessThan(150);
    expect(calls).toBe(12);
    expect(maximumInFlight).toBe(6);
    expect(outcome.verdicts).toHaveLength(12);
    expect(outcome.ok).toBe(12);
  });
});

describe('saying what a partial result costs', () => {
  /**
   * The counts moved to the screen, which holds them as numbers and prints them
   * as one count line. This used to open with "You can read 1 of the 2 tables
   * these answers are built from", above the count line saying the same thing,
   * and the reader met the fact twice before meeting the consequence once.
   * `tableCountLine` in `AccessGate.tsx` is where that sentence lives now, and
   * `access-gate-brevity.test.tsx` is where it is pinned.
   */
  it('leaves the counting to the screen and says only what a count cannot', async () => {
    const outcome = await verifyTableAccess(TABLES, (table) =>
      Promise.resolve(table === 'main.silver.matches' ? { ok: false, message: 'SQLSTATE: 42501' } : { ok: true })
    );
    const impact = describeImpact(outcome);
    expect(impact).toHaveLength(1);
    expect(impact[0]).not.toMatch(/1 of the 2 tables/);
  });

  /**
   * The half a reader cannot work out for themselves: this is a property of
   * how Genie behaves, not of anything on the screen. One sentence now, and it
   * still has to carry all three of these.
   */
  it('names the degradation rather than leaving it to be discovered mid-demo', async () => {
    const outcome = await verifyTableAccess(TABLES, (table) =>
      Promise.resolve(table === 'main.silver.matches' ? { ok: false, message: 'SQLSTATE: 42501' } : { ok: true })
    );
    const impact = describeImpact(outcome).join(' ');
    expect(impact).toMatch(/all-or-nothing per space/);
    expect(impact).toMatch(/falls back to direct SQL/);
    expect(impact).toMatch(/same voice as a complete one/);
  });

  it('does not describe a degradation for a run that established nothing', async () => {
    const outcome = await verifyTableAccess(TABLES, () =>
      Promise.resolve({
        ok: false,
        message: 'Provided OAuth token does not have required scopes',
      })
    );
    expect(describeImpact(outcome)).toEqual([]);
  });

  /**
   * A table the check could not reach is not a table that refused, and nothing
   * here may imply a degradation on its account. The screen names those tables
   * and calls them unknown rather than refused; this asserts the server does not
   * describe a Genie fallback that its refusal count does not support.
   */
  it('keeps unknown separate from refused', async () => {
    const outcome = await verifyTableAccess(TABLES, (table) =>
      Promise.resolve(table === 'main.silver.matches' ? { ok: false, message: 'socket hang up' } : { ok: true })
    );
    expect(outcome.errored).toBe(1);
    expect(outcome.denied).toBe(0);
    expect(describeImpact(outcome)).toEqual([]);
  });
});

describe('the limits of the check, stated rather than left to be assumed', () => {
  /**
   * The defect this replaced. The Genie limitation carried the sentence "this
   * app requests `sql` only" as a string literal and was returned
   * unconditionally, so the screen went on declining the check (and giving
   * that as the reason), for an entire release after `dashboards.genie` became
   * effective on the running app. A limitation stated as a constant outlives
   * whatever made it true.
   */
  it('never asserts a scope the app has not been asked about', () => {
    const [genie] = limitsOfThisCheck([]);
    expect(genie.why).not.toMatch(/`sql` only/);
    expect(genie.why).not.toMatch(/cannot ask that question as you/);
    // A run that did not reach the question says that, rather than inventing a
    // reason for it.
    expect(genie.why).toMatch(/did not get as far as asking/);
  });

  it('passes through what the serving principal saw, labelled as that identity', () => {
    const [genie] = limitsOfThisCheck([{ object: 'space-1', label: 'Data Genie space \u00b7 space-1', status: 'ok' }]);
    expect(genie.insteadAs).toMatch(/as the agent serving principal/);
    expect(genie.insteadAs).toMatch(/not a claim about who executes/);
    expect(genie.insteadAs).toContain('Data Genie space \u00b7 space-1 (ok)');
  });

  it('names the scope, and the start rather than the redeploy, when the token lacks it', async () => {
    const genieOutcome = await verifyGenieAccess(SPACES, unreachableGenie, 'a@b.c', false);
    const [genie] = limitsOfThisCheck([], genieOutcome);
    expect(genie.why).toMatch(/dashboards\.genie/);
    expect(genie.why).toMatch(/its own scope claim does not list it/);
    // The distinction the whole module exists for: a scope is the app's, a
    // grant is the reader's, and no grant made to them would help.
    expect(genie.why).toMatch(/rather than a permission you are missing/);
    expect(genie.why).toMatch(/STOP and START/);
    expect(genie.why).toMatch(/a redeploy leaves it inert/);
  });

  it('stops calling Genie unchecked once it has actually been checked', async () => {
    const genieOutcome = await verifyGenieAccess(SPACES, allowGenie, 'a@b.c', true);
    const [genie] = limitsOfThisCheck([], genieOutcome);
    expect(genie.what).not.toMatch(/Genie spaces are shared with you/);
    // What a pass still does not prove: coverage of every figure, not who
    // executes later asks (that is analyticalExecution / Connections).
    expect(genie.why).toMatch(/answered under your token/);
    expect(genie.why).toMatch(/execution identity/);
    expect(genie.why).not.toMatch(/calls Genie as the serving principal/);
  });

  it('warns about the failure that answers instead of erroring', () => {
    // Found rather than indexed: the list grows a "which tables" entry when the
    // run checked none, and this limit is stated whether or not it did.
    const filters = limitsOfThisCheck([]).find((limit) => /row filter or a column mask/.test(limit.what));
    expect(filters?.why).toMatch(/Neither reports itself/);
  });

  it('says the tables went unchecked only when they did', () => {
    const names = (tablesChecked: number) => limitsOfThisCheck([], undefined, tablesChecked).map((limit) => limit.what);
    expect(names(0).join(' ')).toMatch(/read the tables behind an answer/);
    expect(names(2).join(' ')).not.toMatch(/read the tables behind an answer/);
  });

  it('is attached even to a run that was blocked before it started', async () => {
    const outcome = await verifyAccess(
      { tables: [...TABLES], warehouseId: 'w', principal: 'a@b.c' },
      {
        warehouse: () => Promise.resolve({ ok: false, message: 'SQLSTATE: 42501 no permission' }),
        table: () => Promise.resolve({ ok: true }),
      }
    );
    expect(outcome.notChecked).toHaveLength(2);
  });
});

/**
 * The scope, read rather than declared.
 *
 * Everything downstream of this decides whether to ask Databricks a question
 * or to print a reason for not asking. Getting it wrong in the safe direction
 * costs one HTTP call; getting it wrong in the other direction is the defect
 * that shipped: a check declined by a constant, with a justification nobody
 * had verified since the day it was written.
 */
describe('reading what the forwarded token can actually do', () => {
  it('reads the scopes off the token', () => {
    expect(scopesFromToken(jwtWithScope('sql dashboards.genie offline_access'))).toEqual([
      'sql',
      'dashboards.genie',
      'offline_access',
    ]);
  });

  it('says yes when the token carries the Genie scope', () => {
    expect(tokenGrantsGenie(jwtWithScope('sql dashboards.genie'))).toBe(true);
  });

  it('says no when it carries `sql` and not the other', () => {
    expect(tokenGrantsGenie(jwtWithScope('sql offline_access'))).toBe(false);
  });

  it('treats the catch-all scope as covering Genie', () => {
    expect(tokenGrantsGenie(jwtWithScope('all-apis offline_access'))).toBe(true);
  });

  /**
   * The three ways a token can decline to say, each of which must read as
   * "unknown" and never as "no". A token this cannot parse is a token whose
   * scopes have to be established by asking the API, which is exactly what
   * `null` makes the caller do.
   */
  it('reports unknown, not refusal, for a token that does not enumerate its scopes', () => {
    expect(tokenGrantsGenie('dapi-an-opaque-personal-access-token')).toBeNull();
    expect(tokenGrantsGenie(jwtWithScope(null))).toBeNull();
    expect(tokenGrantsGenie('not.valid-base64.here')).toBeNull();
  });
});

describe('asking Genie the same question as the user', () => {
  it('passes a space that resolves under the caller\u2019s own token', async () => {
    const outcome = await verifyGenieAccess(SPACES, allowGenie, 'a@b.c', true);
    expect(outcome.notChecked).toBeUndefined();
    expect(outcome.verdicts.map((verdict) => verdict.status)).toEqual(['ok', 'ok']);
    expect(outcome.verdicts[0].detail).toMatch(/at least CAN RUN/);
    // Not overclaimed: a space being shared is not the tables inside it.
    expect(outcome.verdicts[0].detail).toMatch(/not about the tables it curates/);
  });

  it('reads a 403 as one grant on one space, with the command that makes it', async () => {
    const outcome = await verifyGenieAccess(
      [SPACES[0]],
      () => Promise.resolve({ ok: false, status: 403, message: 'PERMISSION_DENIED' }),
      'reviewer@example.com'
    );
    const [verdict] = outcome.verdicts;
    expect(verdict.status).toBe('denied');
    expect(verdict.reason).toBe('no-grant');
    expect(verdict.missing).toEqual({
      object: 'space-data',
      permission: 'CAN_RUN',
      objectKind: 'genie-space',
    });
    expect(verdict.remedy?.statement).toContain('databricks permissions update genie space-data');
    expect(verdict.remedy?.statement).toContain('"permission_level":"CAN_RUN"');
    // The person who is short of it, not the service principal.
    expect(verdict.remedy?.statement).toContain('"user_name":"reviewer@example.com"');
    // Says what it is not, because a Genie grant and a table grant get
    // confused in exactly this direction.
    expect(verdict.detail).toMatch(/says nothing about your Unity Catalog access/);
  });

  /**
   * Genie answers `NOT_FOUND` for a space id that does not exist (verified
   * against the workspace), and a space that is simply not shared is not
   * reliably distinguishable from it. The honest report names both readings
   * rather than picking the flattering one.
   */
  it('keeps a hidden space and an absent one apart from a plain refusal', async () => {
    const outcome = await verifyGenieAccess(
      [SPACES[0]],
      () => Promise.resolve({ ok: false, status: 404, message: 'Space with id space-data not found' }),
      'a@b.c'
    );
    const [verdict] = outcome.verdicts;
    expect(verdict.status).toBe('denied');
    expect(verdict.reason).toBe('hidden-or-absent');
    expect(verdict.detail).toMatch(/either a missing grant or a space that is gone/);
    expect(verdict.remedy?.statement).toContain('databricks permissions update genie');
  });

  /**
   * The failure mode named in the brief: Genie is reported to answer a caller
   * who is short a grant with an empty result rather than a refusal. Nothing
   * observed on the check path does that (a 200 from `GET /genie/spaces/{id}`
   * has always carried the space), but a check that treats any 2xx as a pass
   * would turn it into a green tick the first time it did, and that is not a
   * risk worth carrying into a governance screen.
   */
  it('refuses to read an empty answer as a pass', async () => {
    const outcome = await verifyGenieAccess([SPACES[0]], () => Promise.resolve({ ok: true, space: null }), 'a@b.c');
    expect(outcome.verdicts[0].status).toBe('error');
    expect(outcome.verdicts[0].detail).toMatch(/An empty answer is not a yes/);
  });

  it('calls a refused token a token problem, not a missing grant', async () => {
    const outcome = await verifyGenieAccess(
      [SPACES[0]],
      () => Promise.resolve({ ok: false, status: 401, message: 'Credential was not sent' }),
      'a@b.c'
    );
    expect(outcome.verdicts[0].status).toBe('error');
    expect(outcome.verdicts[0].detail).toMatch(/not a permission you are missing/);
    expect(outcome.verdicts[0].missing).toBeUndefined();
  });

  it('reports a space that did not answer as unknown rather than refused', async () => {
    const outcome = await verifyGenieAccess(
      [SPACES[0]],
      () => Promise.resolve({ ok: false, message: 'Genie could not be reached: socket hang up' }),
      'a@b.c'
    );
    expect(outcome.verdicts[0].status).toBe('error');
    expect(outcome.verdicts[0].detail).toMatch(/unknown rather than refused/);
  });

  /**
   * The spaces are asked at the same time, because a person is waiting.
   *
   * Serially this cost one `GENIE_PROBE_TIMEOUT_MS` per space of dead time,
   * 30 seconds on the usual two, in front of a spinner, before the warehouse
   * probe with its own 45 had even started, on a request the browser puts no
   * timeout on. Asserted by overlap rather than by elapsed time, so it is not a
   * test about how fast this machine is.
   */
  it('asks every space at once rather than one after another', async () => {
    let inFlight = 0;
    let overlapped = false;
    const outcome = await verifyGenieAccess(
      SPACES,
      async (spaceId) => {
        inFlight += 1;
        overlapped = overlapped || inFlight > 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { ok: true, space: spaceId };
      },
      'a@b.c'
    );

    expect(overlapped, 'the second space waited for the first').toBe(true);
    // And the order still comes from the report, not from whichever answered
    // first. This list is rendered, and it must not reshuffle per reload.
    expect(outcome.verdicts.map((verdict) => verdict.space)).toEqual(SPACES.map((s) => s.id));
  });

  it('does not call Genie at all when the token says it cannot', async () => {
    const probe = vi.fn(allowGenie);
    const outcome = await verifyGenieAccess(SPACES, probe, 'a@b.c', false);
    expect(probe).not.toHaveBeenCalled();
    expect(outcome.verdicts).toEqual([]);
    expect(outcome.notChecked?.why).toMatch(/dashboards\.genie/);
  });

  /**
   * A scope refusal is one problem with the app, not two with the reader.
   * Reported once, and never as a per-space denial, for the same reason the
   * warehouse stage exists on the SQL side.
   */
  it('reports a scope refusal from the API once, not once per space', async () => {
    const outcome = await verifyGenieAccess(
      SPACES,
      () =>
        Promise.resolve({
          ok: false,
          status: 403,
          message: 'Provided OAuth token does not have required scopes: dashboards.genie',
        }),
      'a@b.c',
      null
    );
    expect(outcome.verdicts).toEqual([]);
    expect(outcome.notChecked?.why).toMatch(/Databricks refused the call and said so/);
    expect(outcome.notChecked?.why).toMatch(/dashboards\.genie/);
  });

  it('says there was nothing to ask about when no space is configured', async () => {
    const outcome = await verifyGenieAccess([], unreachableGenie, 'a@b.c', true);
    expect(outcome.verdicts).toEqual([]);
    expect(outcome.notChecked?.why).toMatch(/named no Genie spaces/);
    expect(outcome.notChecked?.why).toMatch(/says nothing about your permissions/);
  });

  it('names the space in the grant rather than a space this repository knows', () => {
    // Customer deployments have their own ids, so nothing here may be a
    // constant read out of our own workspace.
    const remedy = genieSpaceGrant('01f0deadbeef', 'sp-1234');
    expect(remedy.statement).toContain('genie 01f0deadbeef');
    expect(remedy.statement).toContain('"service_principal_name":"sp-1234"');
  });

  it('classifies without a status the same way it classifies with one', () => {
    const verdict = classifyGenieProbe({ ok: false, message: 'something unrecognised' }, SPACES[0], 'a@b.c');
    expect(verdict.status).toBe('error');
    expect(verdict.apiMessage).toBe('something unrecognised');
  });
});

describe('what a Genie answer does and does not do to the verdict', () => {
  const allowTables = (): Promise<ProbeResult> => Promise.resolve({ ok: true });

  async function run(genieSpace: (spaceId: string) => Promise<GenieProbeResult>) {
    return verifyAccess(
      {
        tables: [...TABLES],
        warehouseId: 'wh-1',
        principal: 'a@b.c',
        genieSpaces: SPACES,
        genieScope: true,
      },
      { warehouse: allowTables, table: allowTables, genieSpace }
    );
  }

  it('admits a reader who holds the tables and both spaces', async () => {
    const outcome = await run(allowGenie);
    expect(outcome.genie?.map((verdict) => verdict.status)).toEqual(['ok', 'ok']);
    expect(isVerified(outcome)).toBe(true);
  });

  /**
   * The requirement this change exists for: a reader who cannot open a space
   * must not be admitted as verified on the strength of their table grants,
   * because the spaces are half of what an answer is built from.
   */
  it('refuses to verify a reader a space refused, even with every table green', async () => {
    const outcome = await run((spaceId) =>
      Promise.resolve(
        spaceId === 'space-dict'
          ? { ok: false, status: 403, message: 'PERMISSION_DENIED' }
          : { ok: true, space: spaceId }
      )
    );
    expect(outcome.ok).toBe(2);
    expect(outcome.denied).toBe(0);
    expect(isVerified(outcome)).toBe(false);
  });

  /**
   * And the other half of it. A space that did not answer is a dependency
   * state, and failing every reader of a deployment on one is how a scope gets
   * reported as a permission: the mistake this module exists to prevent. The
   * unknown is carried in the summary instead.
   */
  it('does not fail a reader because Genie itself did not answer', async () => {
    const outcome = await run(() => Promise.resolve({ ok: false, message: 'socket hang up' }));
    expect(outcome.genie?.every((verdict) => verdict.status === 'error')).toBe(true);
    expect(isVerified(outcome)).toBe(true);
    expect(verificationSummary(outcome)).toMatch(/unknown rather than granted/);
  });

  /**
   * Genie needs neither `CAN_USE` on the warehouse nor the `sql` scope (a
   * space runs its compute under the author's embedded credentials), so a
   * warehouse a reader cannot use is not a reason to go quiet about the
   * spaces they can.
   */
  it('still reports the spaces when the warehouse blocked everything else', async () => {
    const outcome = await verifyAccess(
      {
        tables: [...TABLES],
        warehouseId: 'wh-1',
        principal: 'a@b.c',
        genieSpaces: SPACES,
        genieScope: true,
      },
      {
        warehouse: () => Promise.resolve({ ok: false, status: 403, message: 'no' }),
        table: allowTables,
        genieSpace: allowGenie,
      }
    );
    expect(outcome.blocked?.kind).toBe('warehouse-denied');
    expect(outcome.genie?.map((verdict) => verdict.status)).toEqual(['ok', 'ok']);
  });

  it('says how many spaces passed in the audit record, without claiming who executes', async () => {
    const outcome = await run(allowGenie);
    const summary = verificationSummary(outcome);
    expect(summary).toContain('CAN RUN confirmed on 2 of 2 Genie spaces');
    expect(summary).toContain('under your own token');
    expect(summary).not.toMatch(/execution still runs as/i);
  });

  it('keeps saying Genie went unchecked when it did', async () => {
    const outcome = await verifyAccess(
      { tables: [...TABLES], warehouseId: 'wh-1', principal: 'a@b.c' },
      { warehouse: allowTables, table: allowTables }
    );
    expect(outcome.genie).toBeUndefined();
    expect(verificationSummary(outcome)).toMatch(/Genie space access was not checked as you/);
  });
});

describe('reading a Genie space as the user', () => {
  it('sends the user\u2019s own bearer token to the space endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ space_id: 'space-data', title: 'Player Insights Data' }),
    });
    const probe = genieSpaceProbeFor({
      host: 'https://example.cloud.databricks.com',
      token: 'user-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await probe('space-data')).toEqual({
      ok: true,
      space: 'space-data',
      title: 'Player Insights Data',
    });
    const { url, init } = recordedRequest(fetchImpl);
    expect(url).toBe('https://example.cloud.databricks.com/api/2.0/genie/spaces/space-data');
    expect(init.method).toBe('GET');
    expect(authorizationOn(init)).toBe('Bearer user-token');
  });

  it('keeps a live title so labels can say title · id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ space_id: 'space-data', title: 'example_poc' }),
    });
    const probe = genieSpaceProbeFor({
      host: 'https://h',
      token: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await probe('space-data');
    expect(result).toEqual({ ok: true, space: 'space-data', title: 'example_poc' });
  });

  /**
   * The same principle as the statement executor after d2ef914: a status code
   * is a fact and prose is an interpretation. This path refuses with a short
   * body or none, so a classifier reading only wording turns a refusal into a
   * dependency that never answered.
   */
  it('carries the status beside the message rather than inside it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({}),
    });
    const probe = genieSpaceProbeFor({
      host: 'https://h',
      token: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await probe('space-data')).toEqual({
      ok: false,
      status: 403,
      message: 'Databricks answered HTTP 403 with no message body.',
    });
  });

  it('falls back to the status sentence when the refusal names its message in an object', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ message: { error_code: 'PERMISSION_DENIED' } }),
    });
    const probe = genieSpaceProbeFor({
      host: 'https://h',
      token: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await probe('space-data')).toEqual({
      ok: false,
      status: 403,
      message: 'Databricks answered HTTP 403 with no message body.',
    });
  });

  it('reports a 200 that named no space as exactly that', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    const probe = genieSpaceProbeFor({
      host: 'https://h',
      token: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await probe('space-data')).toEqual({ ok: true, space: null, title: null });
  });

  it('does not leave a person waiting on a socket that went quiet', async () => {
    const probe = genieSpaceProbeFor({
      host: 'https://h',
      token: 't',
      timeoutMs: 5,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
          );
        })) as unknown as typeof fetch,
    });
    const result = await probe('space-data');
    expect(result).toEqual({ ok: false, message: 'Genie did not answer within 5 ms, so this check did not complete.' });
  });
});

describe('running the statement as the user', () => {
  it('sends the user\u2019s own bearer token, not the app\u2019s credentials', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: { state: 'SUCCEEDED' } }),
    });
    const run = statementRunnerFor({
      host: 'https://example.cloud.databricks.com',
      token: 'user-token',
      warehouseId: 'wh-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await run('main.silver.players')).toEqual({ ok: true });
    const { url, init } = recordedRequest(fetchImpl);
    expect(url).toBe('https://example.cloud.databricks.com/api/2.0/sql/statements');
    expect(authorizationOn(init)).toBe('Bearer user-token');
    const body = jsonBodyOn(init);
    expect(body.warehouse_id).toBe('wh-1');
    expect(body.statement).toContain('WHERE 1=0');
    expect(body.query_tags).toEqual([
      { key: 'application', value: 'Astrolabe' },
      { key: 'surface', value: 'connections' },
      { key: 'tool', value: 'access_verification' },
      { key: 'operation', value: 'preflight' },
    ]);
    expect(JSON.stringify(body.query_tags)).not.toContain('main.silver.players');
  });

  it('surfaces the API message when the statement fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: { state: 'FAILED', error: { message: 'PERMISSION_DENIED on Table x' } } }),
    });
    const run = statementRunnerFor({
      host: 'https://h',
      token: 't',
      warehouseId: 'w',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await run('x')).toEqual({ ok: false, message: 'PERMISSION_DENIED on Table x' });
  });

  /**
   * BEHAVIOUR CHANGE, and the reason it is one. The Genie probe beside this had
   * a case for exactly this shape ('falls back to the status sentence when the
   * refusal names its message in an object') and the statement executor did
   * not, because it read the field with `String()` instead of `asString`. A
   * refusal whose `message` is an object therefore reached the access panel as
   * the literal `[object Object]`, presented as Databricks' own words, in the
   * one place a locked-out reader is looking for a cause. The status sentence
   * is less specific and is at least true.
   */
  it('falls back to the status sentence when the refusal names its message in an object', async () => {
    const run = statementRunnerFor({
      host: 'https://h',
      token: 't',
      warehouseId: 'w',
      fetchImpl: fetchAnswering({ message: { error_code: 'PERMISSION_DENIED' } }, 403),
    });
    expect(await run('x')).toEqual({
      ok: false,
      status: 403,
      message: 'Databricks answered HTTP 403 with no message body.',
    });
  });

  /**
   * The same hole one level down: a FAILED statement whose `error.message` is
   * an object. `[object Object]` was reported as the reason the statement
   * failed; the state it ended in is what is actually known.
   */
  it('falls back to the state when a failed statement names its error in an object', async () => {
    const run = statementRunnerFor({
      host: 'https://h',
      token: 't',
      warehouseId: 'w',
      fetchImpl: fetchAnswering({
        status: { state: 'FAILED', error: { error_code: 'INTERNAL_ERROR' } },
      }),
    });
    expect(await run('x')).toEqual({
      ok: false,
      message: 'The statement ended in state FAILED.',
    });
  });

  /**
   * Unchanged behaviour, pinned because the narrowing above is what now keeps
   * it: a body with no `status` was safe only through optional chaining on an
   * `any`, so nothing stopped the next edit reading `body.status.state`.
   */
  it('reports a body carrying no status as an unknown state', async () => {
    const run = statementRunnerFor({
      host: 'https://h',
      token: 't',
      warehouseId: 'w',
      fetchImpl: fetchAnswering({}),
    });
    expect(await run('x')).toEqual({
      ok: false,
      message: 'The statement ended in state UNKNOWN.',
    });
  });

  it('surfaces an HTTP-level refusal, which is how a scope failure arrives', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ message: 'Provided OAuth token does not have required scopes' }),
    });
    const run = statementRunnerFor({
      host: 'https://h',
      token: 't',
      warehouseId: 'w',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await run('x');
    expect(result.ok).toBe(false);
    expect(looksLikeMissingScope((result as { message: string }).message)).toBe(true);
  });
});

describe('served configuration as the source of what to probe', () => {
  it('labels a space as title · id when both are known', () => {
    expect(genieSpaceLabel({ id: 'abc', title: 'Player Insights Data' })).toBe('Player Insights Data · abc');
    expect(genieSpaceLabel({ role: 'Data Genie space', title: 'example_poc' })).toBe('Data Genie space · example_poc');
    expect(genieSpaceLabel({ role: 'Data Genie space', id: 'abc' })).toBe('Data Genie space · abc');
  });

  it('prefers declared_manifest and Genie ids from configuration', () => {
    const deps = accessDependenciesFrom({
      configuration: [
        { key: 'declared_manifest', value: ['cat.sch.a', 'cat.sch.b'] },
        { key: 'data_genie_space_id', value: 'space-data' },
        { key: 'dictionary_genie_space_id', value: 'space-dict' },
        { key: 'data_genie_space_title', value: 'Player Insights Data' },
      ],
    });
    expect(deps.tables).toEqual(['cat.sch.a', 'cat.sch.b']);
    expect(deps.genieSpaces).toEqual([
      {
        id: 'space-data',
        role: 'Data Genie space',
        label: 'Player Insights Data · space-data',
      },
      {
        id: 'space-dict',
        role: 'Dictionary Genie space',
        label: 'Dictionary Genie space · space-dict',
      },
    ]);
  });

  it('falls back to PLAYER_INSIGHTS_* env when configuration is empty', () => {
    const deps = accessDependenciesFrom({
      configuration: [],
      env: {
        PLAYER_INSIGHTS_TABLES: 'c.s.t1,c.s.t2',
        PLAYER_INSIGHTS_DATA_GENIE_ID: 'from-env-data',
        PLAYER_INSIGHTS_DICTIONARY_GENIE_ID: 'from-env-dict',
      },
    });
    expect(deps.tables).toEqual(['c.s.t1', 'c.s.t2']);
    expect(deps.genieSpaces.map((space) => space.id)).toEqual(['from-env-data', 'from-env-dict']);
  });

  it('qualifies the committed data contract when catalog and schema are set', () => {
    const deps = accessDependenciesFrom({
      env: { PLAYER_INSIGHTS_CATALOG: 'cat', PLAYER_INSIGHTS_SCHEMA: 'sch' },
    });
    expect(deps.tables).toEqual(qualifyDataContractTables('cat', 'sch'));
  });

  it('reads configuration from a retired preflight response', () => {
    const entries = extractServedConfiguration({
      custom_outputs: {
        type: 'preflight_retired',
        configuration: [{ key: 'data_genie_space_id', value: 'space-1' }],
      },
    });
    expect(entries).toEqual([{ key: 'data_genie_space_id', value: 'space-1' }]);
  });

  /**
   * The report is `unknown` on the wire, so a value can arrive as an object.
   * Stringifying one put `[object Object]` where a catalog name or a space
   * title belongs, which a reader takes for corrupt data rather than for a
   * field the orchestrator never sent.
   */
  it('reads a Genie space id that arrived as an object or an array as absent', () => {
    const deps = accessDependenciesFrom({
      configuration: [
        { key: 'data_genie_space_id', value: { space_id: 'space-data' } },
        { key: 'dictionary_genie_space_id', value: ['space-dict'] },
      ],
    });
    expect(deps.genieSpaces).toEqual([]);
  });

  it('reads a null Genie space id as absent, as it always has', () => {
    const deps = accessDependenciesFrom({
      configuration: [{ key: 'data_genie_space_id', value: null }],
    });
    expect(deps.genieSpaces).toEqual([]);
    expect(deps.tables).toEqual([]);
  });

  it('drops a space title that arrived as an object rather than labelling the space with it', () => {
    const deps = accessDependenciesFrom({
      configuration: [
        { key: 'data_genie_space_id', value: 'space-data' },
        { key: 'data_genie_space_title', value: { title: 'Player Insights Data' } },
      ],
    });
    expect(deps.genieSpaces).toEqual([
      { id: 'space-data', role: 'Data Genie space', label: 'Data Genie space · space-data' },
    ]);
  });

  it('still names a Genie space whose id or title arrived as a number', () => {
    const deps = accessDependenciesFrom({
      configuration: [
        { key: 'data_genie_space_id', value: 4109 },
        { key: 'data_genie_space_title', value: 2026 },
      ],
    });
    expect(deps.genieSpaces.map((space) => space.label)).toEqual(['2026 · 4109']);
  });

  it('drops a configuration entry whose key arrived as an object, an array or null', () => {
    const entries = extractServedConfiguration({
      configuration: [
        { key: { name: 'tables' }, value: 'c.s.one' },
        { key: ['tables'], value: 'c.s.two' },
        { key: null, value: 'c.s.three' },
        { key: 'tables', value: 'c.s.four' },
      ],
    });
    expect(entries).toEqual([{ key: 'tables', value: 'c.s.four' }]);
  });

  it('keeps a configuration entry whose key arrived as a number or a boolean', () => {
    const entries = extractServedConfiguration({
      configuration: [
        { key: 7, value: 'seven' },
        { key: true, value: 'yes' },
        { key: '  padded  ', value: 'trimmed' },
      ],
    });
    expect(entries).toEqual([
      { key: '7', value: 'seven' },
      { key: 'true', value: 'yes' },
      { key: 'padded', value: 'trimmed' },
    ]);
  });

  it('upgrades a Genie verdict label when the probe returns a live title', () => {
    const verdict = classifyGenieProbe(
      { ok: true, space: 'space-data', title: 'example_poc' },
      { id: 'space-data', label: 'Data Genie space · space-data', role: 'Data Genie space' },
      'reader@example.com'
    );
    expect(verdict.label).toBe('example_poc · space-data');
    expect(verdict.status).toBe('ok');
  });
});
