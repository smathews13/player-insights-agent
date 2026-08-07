import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  BLOCKED_STATUS,
  SCIM_USERS_PATH,
  SQL_ACCESS_ENTITLEMENT,
  UNKNOWN_USER_ID,
  WORKSPACE_ACCESS_ENTITLEMENT,
  classifyDenial,
  classifyGenieProbe,
  describeImpact,
  diagnoseUserToken,
  entitlementGrant,
  entitlementLookupVia,
  forwardedUserToken,
  genieSpaceGrant,
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
  type StatementRunner,
} from './access-verification';

function request(headers: Record<string, string> = {}) {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
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

const allowGenie = async (spaceId: string): Promise<GenieProbeResult> => ({ ok: true, space: spaceId });
const unreachableGenie = async (): Promise<GenieProbeResult> => {
  throw new Error('the probe should not have been called');
};

/** A Databricks OAuth token, in the shape the scopes are actually read from. */
function jwtWithScope(scope: string | null): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
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
  const allow: StatementRunner = async () => ({ ok: true });

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
    const outcome = await verifyTableAccess(['a.b.c'], async () => ({ ok: false, message: REAL_NOT_FOUND }));
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
    const outcome = await verifyTableAccess(['main.x.y'], async () => ({ ok: false, message: REAL_INSUFFICIENT }));
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
    const outcome = await verifyTableAccess(['main.x.y'], async () => ({ ok: false, message: REAL_INSUFFICIENT }));
    expect(outcome.verdicts[0].apiMessage).toBe(REAL_INSUFFICIENT);
  });

  it('names the exact object and permission when a grant is missing', async () => {
    const outcome = await verifyTableAccess(TABLES,
      async (table) =>
        table === 'main.silver.matches'
          ? { ok: false, message: 'PERMISSION_DENIED: User does not have SELECT on Table' }
          : { ok: true },
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
    expect(denied?.remedy?.statement).toContain('GRANT SELECT ON TABLE `main`.`silver`.`matches` TO `reviewer@example.com`;'
    );
    expect(isVerified(outcome)).toBe(false);
  });

  it('treats a table Unity Catalog hides as denied, and says the two are indistinguishable', async () => {
    const outcome = await verifyTableAccess(['main.silver.players'], async () => ({
      ok: false,
      message: '[TABLE_OR_VIEW_NOT_FOUND] The table or view cannot be found',
    }));
    expect(outcome.verdicts[0].status).toBe('denied');
    expect(outcome.verdicts[0].detail).toMatch(/hides objects it cannot traverse/);
    // And says what to conclude when the grants below it do not help.
    expect(outcome.verdicts[0].detail).toMatch(/the table is the one that is missing/);
  });

  it('records an unrecognised failure as unknown rather than as denied', async () => {
    const outcome = await verifyTableAccess(['main.silver.players'], async () => ({
      ok: false,
      message: 'Warehouse is starting',
    }));
    expect(outcome.verdicts[0].status).toBe('error');
    expect(outcome.verdicts[0].detail).toMatch(/not a permission result/);
    expect(outcome.errored).toBe(1);
    expect(isVerified(outcome)).toBe(false);
  });

  it('survives a runner that throws', async () => {
    const outcome = await verifyTableAccess(['main.silver.players'], async () => {
      throw new Error('socket hang up');
    });
    expect(outcome.verdicts[0].status).toBe('error');
  });

  it('stops and blames configuration when the token lacks the sql scope', async () => {
    const outcome = await verifyTableAccess(TABLES, async () => ({
      ok: false,
      message: 'Provided OAuth token does not have required scopes',
    }));
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
    const outcome = await verifyTableAccess(TABLES, async (table) =>
      table === 'main.silver.matches' ? { ok: false, message: 'PERMISSION_DENIED' } : { ok: true }
    );
    expect(outcome.ok).toBe(1);
    expect(isVerified(outcome)).toBe(false);
  });

  it('refuses to call an empty run verified', async () => {
    expect(isVerified(await verifyTableAccess([], allow))).toBe(false);
  });
});

describe('the summary written into the audit record', () => {
  it('states the boundary rather than implying there is none', async () => {
    const outcome = await verifyTableAccess(TABLES, async () => ({ ok: true }));
    const summary = verificationSummary(outcome, 'serving-sp');
    expect(summary).toContain('2 tables');
    expect(summary).toContain('execution still runs as serving-sp');
  });

  it('still names the boundary when the principal has not been observed', async () => {
    const outcome = await verifyTableAccess(['t'], async () => ({ ok: true }));
    expect(verificationSummary(outcome, null)).toContain('the agent serving principal');
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
    const denial = classifyDenial("[INSUFFICIENT_PERMISSIONS] Insufficient privileges:\nCatalog 'main' is not accessible in current workspace SQLSTATE: 42501",
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
    const denial = classifyDenial("[INSUFFICIENT_PERMISSIONS] Insufficient privileges: Schema 'main.silver' is not accessible SQLSTATE: 42501",
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
    expect(classifyDenial('[TABLE_OR_VIEW_NOT_FOUND] cannot be found', 'c.s.t').kind).toBe('hidden-or-absent'
    );
  });

  it('refuses to classify a failure it does not recognise', () => {
    expect(classifyDenial('socket hang up', 'c.s.t').kind).toBe('unrecognised');
    expect(classifyDenial('The statement ended in state CANCELED.', 'c.s.t').kind).toBe('unrecognised'
    );
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

  it('says who can run it, since that is the next thing a blocked reader has to find out', () => {
    expect(tableGrant('c.s.t', 'a@b.c').note).toMatch(/owns the catalog/);
    expect(tableGrant('c.s.t', 'a@b.c').note).toMatch(/metastore admin/);
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
    expect(warehouseGrant('wh-1', 'ca9f730e-186a-4809-b8b7-000000000000').statement).toContain('"service_principal_name":'
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
    message:
      'PERMISSION_DENIED: User does not have permission to use warehouse abc123. SQLSTATE: 42501',
  };

  it('passes silently when SELECT 1 succeeds', async () => {
    expect(await verifyWarehouseAccess('abc123', async () => ({ ok: true }))).toBeNull();
  });

  it('names CAN_USE on the warehouse, and says no table was checked', async () => {
    const blocked = await verifyWarehouseAccess('abc123', async () => denied, 'reviewer@example.com');
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
    const outcome = await verifyAccess({ tables: [...TABLES], warehouseId: 'abc123', principal: 'reviewer@example.com' },
      { warehouse: async () => denied, table: table as unknown as StatementRunner }
    );
    expect(outcome.verdicts).toEqual([]);
    expect(outcome.denied).toBe(0);
    expect(table).not.toHaveBeenCalled();
    expect(isVerified(outcome)).toBe(false);
  });

  it('separates a warehouse that is down from one that refused', async () => {
    const blocked = await verifyWarehouseAccess('abc123', async () => ({
      ok: false,
      message: 'The statement ended in state CANCELED.',
    }));
    expect(blocked?.kind).toBe('dependency-down');
    expect(blocked?.missing).toBeUndefined();
    expect(blocked?.summary).toMatch(/did not refuse it for a permission/);
  });

  it('still calls a missing scope a scope problem when it surfaces at the warehouse', async () => {
    const blocked = await verifyWarehouseAccess('abc123', async () => ({
      ok: false,
      message: 'Provided OAuth token does not have required scopes',
    }));
    expect(blocked?.kind).toBe('no-sql-scope');
    expect(blocked?.summary).toMatch(/not a permission you are missing/);
    expect(blocked?.remedy?.statement).toContain('databricks apps stop');
    expect(blocked?.remedy?.statement).toContain('databricks apps start');
  });

  it('probes with a statement that names no object, so its refusal cannot be about one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: { state: 'SUCCEEDED' } }),
    });
    const probe = warehouseProbeFor({
      host: 'https://h',
      token: 't',
      warehouseId: 'wh-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await probe()).toEqual({ ok: true });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string).statement).toBe('SELECT 1');
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
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status, json: async () => body });
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
    const blocked = await verifyWarehouseAccess('wh-1',
      probeAnswering(403, { message: 'Provided OAuth token does not have required scopes' }),
      'reviewer@example.com'
    );
    expect(blocked?.kind).toBe('no-sql-scope');
  });

  it('keeps reading permission wording on a 200 that failed, where there is no status to read', async () => {
    const blocked = await verifyWarehouseAccess('wh-1',
      async () => ({ ok: false, message: 'PERMISSION_DENIED: SQLSTATE: 42501' }),
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

  const lookupReturning = (body: unknown): EntitlementLookup =>
    entitlementLookupVia(async () => body);

  it('names the entitlement, not the warehouse, when SCIM says it is absent', async () => {
    const blocked = await verifyWarehouseAccess('wh-1',
      async () => REFUSED,
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
    expect(blocked?.remedy?.note).toMatch(/workspace or account admin/);
  });

  it('offers the SCIM patch against the real user id, not a permissions update', async () => {
    const blocked = await verifyWarehouseAccess('wh-1',
      async () => REFUSED,
      READER,
      lookupReturning(scimUser([WORKSPACE_ACCESS_ENTITLEMENT]))
    );

    expect(blocked?.remedy?.kind).toBe('cli');
    // The id comes from the lookup that just succeeded, so the command is
    // runnable as printed rather than a template to go and fill in.
    expect(blocked?.remedy?.statement).toContain('databricks api patch /api/2.0/preview/scim/v2/Users/1122334455667788'
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
    const blocked = await verifyWarehouseAccess('wh-1',
      async () => REFUSED,
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
    const blocked = await verifyWarehouseAccess('wh-1', async () => REFUSED, READER, async () => {
      throw new Error('403 PERMISSION_DENIED: cannot read users');
    });

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
    const blocked = await verifyWarehouseAccess('wh-1',
      async () => REFUSED,
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
    expect(await verifyWarehouseAccess('wh-1', async () => ({ ok: true }), READER, lookup)).toBeNull();
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
    await verifyWarehouseAccess('wh-1',
      async () => ({
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
    const outcome = await verifyAccess({ tables: [...TABLES], warehouseId: 'wh-1', principal: READER },
      {
        warehouse: async () => REFUSED,
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
    const blocked = await verifyWarehouseAccess('wh-1', async () => REFUSED, READER);
    expect(blocked?.kind).toBe('warehouse-denied');
    expect(blocked?.summary).toMatch(/You do not hold CAN_USE on SQL warehouse wh-1/);
    expect(blocked?.summary).not.toMatch(/could not be checked here/);
    expect(blocked?.summary).not.toContain(SQL_ACCESS_ENTITLEMENT);
  });
});

describe('reading the entitlements off a SCIM answer', () => {
  it('reads the values out of the complex attributes SCIM returns', () => {
    expect(readScimEntitlements({
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
    const reading = await entitlementLookupVia(async () => {
      throw new Error('PERMISSION_DENIED');
    })('a@b.c');
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

  it('says the id is not an email, and how to read it back', () => {
    const note = entitlementGrant('1').note;
    expect(note).toMatch(/numeric SCIM id, not an email/);
    expect(note).toMatch(/workspace or account admin/);
    // The trap that made this expensive: entitlements are usually assigned to
    // groups, and a group carrying none is invisible from the user's page.
    expect(note).toMatch(/held through a group/);
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
      const signal = (init as RequestInit | undefined)?.signal;
      signal?.addEventListener('abort', () => reject((signal as AbortSignal).reason as Error));
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
      json: async () => ({ status: { state: 'SUCCEEDED' } }),
    });
    const probe = warehouseProbeFor({
      host: 'https://h',
      token: 't',
      warehouseId: 'wh-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await probe();

    const signal = (fetchImpl.mock.calls[0][1] as RequestInit).signal;
    expect(signal).toBeInstanceOf(AbortSignal);
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

    const outcome = await verifyTableAccess(['a.b.one', 'a.b.two', 'a.b.three', 'a.b.four'],
      slow,
      undefined,
      { budgetMs: 60_000, now: () => clock }
    );

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
});

describe('saying what a partial result costs', () => {
  it('reports which of how many, not a bare count', async () => {
    const outcome = await verifyTableAccess(TABLES, async (table) =>
      table === 'main.silver.matches' ? { ok: false, message: 'SQLSTATE: 42501' } : { ok: true }
    );
    const impact = describeImpact(outcome, TABLES.length);
    expect(impact[0]).toBe('You can read 1 of the 2 tables these answers are built from.');
  });

  /**
   * The half a reader cannot work out for themselves: this is a property of
   * how Genie behaves, not of anything on the screen.
   */
  it('names the degradation rather than leaving it to be discovered mid-demo', async () => {
    const outcome = await verifyTableAccess(TABLES, async (table) =>
      table === 'main.silver.matches' ? { ok: false, message: 'SQLSTATE: 42501' } : { ok: true }
    );
    const impact = describeImpact(outcome, TABLES.length).join(' ');
    expect(impact).toMatch(/all-or-nothing per space/);
    expect(impact).toMatch(/fall back to direct SQL/);
    expect(impact).toMatch(/same voice as a complete one/);
  });

  it('does not describe a degradation for a run that established nothing', async () => {
    const outcome = await verifyTableAccess(TABLES, async () => ({
      ok: false,
      message: 'Provided OAuth token does not have required scopes',
    }));
    expect(describeImpact(outcome, TABLES.length)).toEqual([]);
  });

  it('keeps unknown separate from refused', async () => {
    const outcome = await verifyTableAccess(TABLES, async (table) =>
      table === 'main.silver.matches' ? { ok: false, message: 'socket hang up' } : { ok: true }
    );
    expect(describeImpact(outcome, 2).join(' ')).toMatch(/unknown rather than refused/);
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
    const [genie] = limitsOfThisCheck([
      { object: 'space-1', label: 'Data Genie space \u00b7 space-1', status: 'ok' },
    ]);
    expect(genie.insteadAs).toMatch(/as the agent serving principal/);
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
    // What a pass still does not prove, which is the invariant that must
    // survive every rewrite of this screen.
    expect(genie.why).toMatch(/the agent calls Genie as the serving principal/);
    expect(genie.why).toMatch(/not queried under your identity/);
  });

  it('warns about the failure that answers instead of erroring', () => {
    // Found rather than indexed: the list grows a "which tables" entry when the
    // run checked none, and this limit is stated whether or not it did.
    const filters = limitsOfThisCheck([]).find((limit) =>
      /row filter or a column mask/.test(limit.what)
    );
    expect(filters?.why).toMatch(/Neither reports itself/);
  });

  it('says the tables went unchecked only when they did', () => {
    const names = (tablesChecked: number) =>
      limitsOfThisCheck([], undefined, tablesChecked).map((limit) => limit.what);
    expect(names(0).join(' ')).toMatch(/read the tables behind an answer/);
    expect(names(2).join(' ')).not.toMatch(/read the tables behind an answer/);
  });

  it('is attached even to a run that was blocked before it started', async () => {
    const outcome = await verifyAccess({ tables: [...TABLES], warehouseId: 'w', principal: 'a@b.c' },
      {
        warehouse: async () => ({ ok: false, message: 'SQLSTATE: 42501 no permission' }),
        table: async () => ({ ok: true }),
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
    const outcome = await verifyGenieAccess([SPACES[0]],
      async () => ({ ok: false, status: 403, message: 'PERMISSION_DENIED' }),
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
    const outcome = await verifyGenieAccess([SPACES[0]],
      async () => ({ ok: false, status: 404, message: 'Space with id space-data not found' }),
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
    const outcome = await verifyGenieAccess([SPACES[0]],
      async () => ({ ok: true, space: null }),
      'a@b.c'
    );
    expect(outcome.verdicts[0].status).toBe('error');
    expect(outcome.verdicts[0].detail).toMatch(/An empty answer is not a yes/);
  });

  it('calls a refused token a token problem, not a missing grant', async () => {
    const outcome = await verifyGenieAccess([SPACES[0]],
      async () => ({ ok: false, status: 401, message: 'Credential was not sent' }),
      'a@b.c'
    );
    expect(outcome.verdicts[0].status).toBe('error');
    expect(outcome.verdicts[0].detail).toMatch(/not a permission you are missing/);
    expect(outcome.verdicts[0].missing).toBeUndefined();
  });

  it('reports a space that did not answer as unknown rather than refused', async () => {
    const outcome = await verifyGenieAccess([SPACES[0]],
      async () => ({ ok: false, message: 'Genie could not be reached: socket hang up' }),
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
    const outcome = await verifyGenieAccess(SPACES,
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
    const outcome = await verifyGenieAccess(SPACES,
      async () => ({
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
    const verdict = classifyGenieProbe({ ok: false, message: 'something unrecognised' },
      SPACES[0],
      'a@b.c'
    );
    expect(verdict.status).toBe('error');
    expect(verdict.apiMessage).toBe('something unrecognised');
  });
});

describe('what a Genie answer does and does not do to the verdict', () => {
  const allowTables = async () => ({ ok: true }) as const;

  async function run(genieSpace: (spaceId: string) => Promise<GenieProbeResult>) {
    return verifyAccess({
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
    const outcome = await run(async (spaceId) =>
      spaceId === 'space-dict'
        ? { ok: false, status: 403, message: 'PERMISSION_DENIED' }
        : { ok: true, space: spaceId }
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
    const outcome = await run(async () => ({ ok: false, message: 'socket hang up' }));
    expect(outcome.genie?.every((verdict) => verdict.status === 'error')).toBe(true);
    expect(isVerified(outcome)).toBe(true);
    expect(verificationSummary(outcome, 'sp')).toMatch(/unknown rather than granted/);
  });

  /**
   * Genie needs neither `CAN_USE` on the warehouse nor the `sql` scope (a
   * space runs its compute under the author's embedded credentials), so a
   * warehouse a reader cannot use is not a reason to go quiet about the
   * spaces they can.
   */
  it('still reports the spaces when the warehouse blocked everything else', async () => {
    const outcome = await verifyAccess({
        tables: [...TABLES],
        warehouseId: 'wh-1',
        principal: 'a@b.c',
        genieSpaces: SPACES,
        genieScope: true,
      },
      {
        warehouse: async () => ({ ok: false, status: 403, message: 'no' }),
        table: allowTables,
        genieSpace: allowGenie,
      }
    );
    expect(outcome.blocked?.kind).toBe('warehouse-denied');
    expect(outcome.genie?.map((verdict) => verdict.status)).toEqual(['ok', 'ok']);
  });

  it('says how many spaces passed in the audit record, and still names the boundary', async () => {
    const outcome = await run(allowGenie);
    const summary = verificationSummary(outcome, 'serving-sp');
    expect(summary).toContain('CAN RUN confirmed on 2 of 2 Genie spaces');
    // The invariant. Whatever is established about the reader, execution is
    // still the service principal's and this sentence must survive.
    expect(summary).toContain('execution still runs as serving-sp');
  });

  it('keeps saying Genie went unchecked when it did', async () => {
    const outcome = await verifyAccess({ tables: [...TABLES], warehouseId: 'wh-1', principal: 'a@b.c' },
      { warehouse: allowTables, table: allowTables }
    );
    expect(outcome.genie).toBeUndefined();
    expect(verificationSummary(outcome, 'sp')).toMatch(/Genie space access was not checked as you/);
  });
});

describe('reading a Genie space as the user', () => {
  it('sends the user\u2019s own bearer token to the space endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ space_id: 'space-data', title: 'Player Insights Data' }),
    });
    const probe = genieSpaceProbeFor({
      host: 'https://example.cloud.databricks.com',
      token: 'user-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await probe('space-data')).toEqual({ ok: true, space: 'space-data' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://example.cloud.databricks.com/api/2.0/genie/spaces/space-data');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer user-token');
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
      json: async () => ({}),
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
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const probe = genieSpaceProbeFor({
      host: 'https://h',
      token: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await probe('space-data')).toEqual({ ok: true, space: null });
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
      json: async () => ({ status: { state: 'SUCCEEDED' } }),
    });
    const run = statementRunnerFor({
      host: 'https://example.cloud.databricks.com',
      token: 'user-token',
      warehouseId: 'wh-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await run('main.silver.players')).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://example.cloud.databricks.com/api/2.0/sql/statements');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer user-token');
    const body = JSON.parse(init.body as string);
    expect(body.warehouse_id).toBe('wh-1');
    expect(body.statement).toContain('WHERE 1=0');
  });

  it('surfaces the API message when the statement fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: { state: 'FAILED', error: { message: 'PERMISSION_DENIED on Table x' } } }),
    });
    const run = statementRunnerFor({
      host: 'https://h',
      token: 't',
      warehouseId: 'w',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await run('x')).toEqual({ ok: false, message: 'PERMISSION_DENIED on Table x' });
  });

  it('surfaces an HTTP-level refusal, which is how a scope failure arrives', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Provided OAuth token does not have required scopes' }),
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
