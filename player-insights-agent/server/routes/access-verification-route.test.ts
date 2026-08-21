import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setupInsightsRoutes,
  type InsightsAppKit,
  type ServingTransport,
} from './insights-routes';
import type {
  Blocked,
  GenieVerdict,
  NotChecked,
  Remedy,
  TableVerdict,
} from './access-verification';
import {
  forgetAccessDecisions,
  forgetServingPrincipal,
  type AccessDecision,
} from './execution-identity';
import { resetLakebaseHealth } from '../lib/lakebase-store';
import { MANAGER_GRANT_USER_API_SCOPES } from '../lib/app-user-api-scopes';

/**
 * `/api/access-verification` from the outside, which is the only place several
 * of its distinctions are actually visible.
 */

const HOST = 'https://fake-workspace.cloud.databricks.com';
const STATEMENTS = `${HOST}/api/2.0/sql/statements`;
const GENIE = `${HOST}/api/2.0/genie/spaces/`;
const APP = `${HOST}/api/2.0/apps/astrolabe`;
const USER = 'reviewer@example.com';
const WAREHOUSE = 'wh-000000000000000';
const TABLES = ['cat.sch.gold_player_180d_summary', 'cat.sch.silver_purchases'] as const;

/**
 * The ids the route must take from the agent's report rather than from
 * anywhere in this repository. Deliberately not the ones on our own workspace:
 * a customer deployment has its own, and a constant here would be our demo's
 * spaces pointed at somebody else's data.
 */
const SPACES = ['space-data', 'space-dict'] as const;

/**
 * A forwarded token that says what it can do, which is what Databricks Apps
 * actually mints. The signature is never checked, see `scopesFromToken`.
 */
function tokenWithScopes(scope: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [encode({ alg: 'RS256' }), encode({ sub: USER, scope }), 'sig'].join('.');
}

const FULL_SCOPES = tokenWithScopes('sql dashboards.genie offline_access');
const SQL_ONLY = tokenWithScopes('sql offline_access');

/** Transcribed from the SQL Statement Execution API; see access-verification.test.ts. */
const REAL_INSUFFICIENT =
  "[INSUFFICIENT_PERMISSIONS] Insufficient privileges:\nUser does not have SELECT on Table 'cat.sch.silver_purchases' SQLSTATE: 42501";

/** `duration_ms`, `error` and `remedy` are required by the report contract. */
const CHECK_DEFAULTS = { duration_ms: 12, error: '', remedy: null };

function agentReport(overrides: Record<string, unknown> = {}) {
  return {
    checked_at: '2026-08-05T18:00:00+00:00',
    status: 'ok',
    principal: '7f3c1a20-0000-4000-8000-abcdefabcdef',
    principal_resolved: true,
    table_source: 'declared',
    configuration: [
      { key: 'declared_manifest', value: [...TABLES] },
      { key: 'data_genie_space_id', value: SPACES[0] },
      { key: 'dictionary_genie_space_id', value: SPACES[1] },
      { key: 'data_genie_space_title', value: 'Player Insights Data' },
      { key: 'dictionary_genie_space_title', value: 'Player Insights Dictionary' },
    ],
    checks: [
      {
        id: 'sql-warehouse',
        kind: 'sql-warehouse',
        name: WAREHOUSE,
        label: `SQL warehouse \u00b7 ${WAREHOUSE}`,
        status: 'ok',
        detail: 'SELECT 1 succeeded on the configured warehouse.',
        checked_with: "statement_execution.execute_statement('SELECT 1')",
        ...CHECK_DEFAULTS,
      },
      {
        id: 'genie-data',
        kind: 'genie-space',
        name: SPACES[0],
        label: `Data Genie space \u00b7 ${SPACES[0]}`,
        status: 'ok',
        detail: 'The space is visible to the serving principal.',
        checked_with: 'genie.get_space()',
        ...CHECK_DEFAULTS,
      },
      {
        id: 'genie-dictionary',
        kind: 'genie-space',
        name: SPACES[1],
        label: `Dictionary Genie space \u00b7 ${SPACES[1]}`,
        status: 'ok',
        detail: 'The space is visible to the serving principal.',
        checked_with: 'genie.get_space()',
        ...CHECK_DEFAULTS,
      },
      ...TABLES.map((name) => ({
        id: `table-${name}`,
        kind: 'table',
        name,
        label: `Table \u00b7 ${name}`,
        status: 'ok',
        detail: 'Metadata is readable and a single row was selected successfully.',
        checked_with: 'tables.get() + SELECT 1 ... LIMIT 1',
        ...CHECK_DEFAULTS,
      })),
    ],
    assumptions: [],
    counts: { ok: 4, failed: 0, unverified: 0 },
    ...overrides,
  };
}

/** What a current endpoint returns: no checks, but the configuration the gate needs. */
function retiredWithConfiguration(overrides: Record<string, unknown> = {}): ServingTransport {
  return () =>
    Promise.resolve({
      custom_outputs: {
        type: 'preflight_retired',
        configuration: [
          { key: 'declared_manifest', value: [...TABLES] },
          { key: 'data_genie_space_id', value: SPACES[0] },
          { key: 'dictionary_genie_space_id', value: SPACES[1] },
          { key: 'data_genie_space_title', value: 'Player Insights Data' },
          { key: 'dictionary_genie_space_title', value: 'Player Insights Dictionary' },
        ],
        ...overrides,
      },
    });
}

/** Retired and silent about configuration: warehouse-only verification. */
function retiredWithoutConfiguration(): ServingTransport {
  return () => Promise.resolve({ custom_outputs: { type: 'preflight_retired' } });
}

function reportingTransport(report: unknown): ServingTransport {
  return () => Promise.resolve({ custom_outputs: { type: 'preflight', preflight: report } });
}

const noLakebase: InsightsAppKit['lakebase'] = { query: () => Promise.resolve({ rows: [] }) };

async function startApp(transport: ServingTransport) {
  const app = express();
  app.use(express.json());
  await setupInsightsRoutes({
    lakebase: noLakebase,
    server: { extend: (fn) => fn(app) },
    servingTransport: transport,
  });
  // Loopback rather than the wildcard, or this binds a port another process holds
  // on 127.0.0.1 and the fetch below reaches that process. See shared-rail.test.ts.
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * What the route answers with, across all of its statuses.
 *
 * Everything is optional because the point of most cases below is which of
 * these fields the route left out: `blocked` absent is a pass, `genie` absent
 * is a run that could not ask, and neither reads the same as the empty list.
 * The route itself spreads a `VerificationOutcome` into the body, so the field
 * types come from there rather than being described a second time here.
 */
interface VerificationBody {
  error?: string;
  verified?: boolean;
  blocked?: Blocked;
  verdicts?: TableVerdict[];
  genie?: GenieVerdict[];
  notChecked?: NotChecked[];
  ok?: number;
  denied?: number;
  errored?: number;
  decision?: AccessDecision;
  mode?: string;
  servingPrincipal?: unknown;
}

async function verificationBody(response: Response): Promise<VerificationBody> {
  return (await response.json()) as VerificationBody;
}

/**
 * A field the case is about, or a failure naming what arrived instead.
 *
 * Reading these through a reader rather than with `?.` keeps the negative
 * assertions honest: `expect(body.blocked?.missing).toBeUndefined()` also
 * passes when there is no block at all, which is the opposite of what the
 * cases using it are about.
 */
function present<T>(value: T | undefined, what: string, body: VerificationBody): T {
  if (value === undefined) {
    throw new Error(`The response carried no ${what}: ${JSON.stringify(body)}`);
  }
  return value;
}

function blockedOn(body: VerificationBody): Blocked {
  return present(body.blocked, 'block', body);
}

function remedyOn(body: VerificationBody): Remedy {
  return present(blockedOn(body).remedy, 'remedy on its block', body);
}

function decisionOn(body: VerificationBody): AccessDecision {
  return present(body.decision, 'decision', body);
}

function genieOn(body: VerificationBody): GenieVerdict[] {
  return present(body.genie, 'Genie verdicts', body);
}

function notCheckedOn(body: VerificationBody): NotChecked[] {
  return present(body.notChecked, 'notChecked list', body);
}

interface StatementCall {
  statement: string;
  authorization: string;
  warehouseId: string;
}

interface GenieCall {
  spaceId: string;
  authorization: string;
}

/** What the Genie space endpoint says back, in the two shapes that matter. */
type GenieAnswer =
  | { status: 200; body: Record<string, unknown> }
  | { status: number; body: Record<string, unknown> };

/** Every space resolves, which is the case the other stubs should not perturb. */
const genieResolves = (spaceId: string): GenieAnswer => ({ status: 200, body: { space_id: spaceId } });

/** Recorded across the whole file so the SQL stub's signature does not grow. */
let genieCalls: GenieCall[] = [];

/** The three shapes `fetch` accepts, read as the string the stub matches on. */
function requestedUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * Read through `Headers` rather than by indexing the object, because a caller
 * may pass an array of pairs or a `Headers` instance and neither has an
 * `authorization` property. An assertion that the user's own token was sent
 * would pass on any of those by reading `undefined` from all of them.
 */
function authorizationOn(init: RequestInit | undefined): string {
  return new Headers(init?.headers).get('authorization') ?? '';
}

/** The statement request as the SQL API would read it. */
function statementBodyOn(init: RequestInit | undefined): {
  statement: string;
  warehouse_id: string;
} {
  const sent: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
  const body = sent && typeof sent === 'object' ? (sent as Record<string, unknown>) : {};
  return {
    statement: typeof body.statement === 'string' ? body.statement : '',
    warehouse_id: typeof body.warehouse_id === 'string' ? body.warehouse_id : '',
  };
}

/**
 * Answer the SQL API and the Genie API, and let everything else through.
 *
 * Delegating rather than replacing matters: these cases drive the route over
 * real HTTP, so a blanket stub would swallow the request under test. Genie is
 * answered here too because the route now asks it as the user, without a stub
 * the probe would leave the machine, and a DNS failure reads as a space that
 * did not answer, which is a true verdict about the wrong thing.
 */
function stubStatements(answer: (statement: string) => {
    ok: boolean;
    state?: string;
    message?: string;
    /**
     * The HTTP status to refuse with, for the refusals that never reach a
     * statement at all. The API returns `200` with a FAILED statement inside it
     * for anything it actually ran, which is why that is the default, but a
     * `401`, `403` or `404` arrives as a bare status with at most a one-line
     * body, and those are the ones the route classifies from the code rather
     * than from prose.
     */
    http?: number;
  },
  genieAnswer: (spaceId: string) => GenieAnswer = genieResolves
) {
  const calls: StatementCall[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = requestedUrl(input);
    if (url.startsWith(GENIE)) {
      const spaceId = url.slice(GENIE.length);
      genieCalls.push({ spaceId, authorization: authorizationOn(init) });
      const reply = genieAnswer(spaceId);
      return Promise.resolve(new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        })
      );
    }
    if (url !== STATEMENTS) return real(input, init);
    const body = statementBodyOn(init);
    calls.push({
      statement: body.statement,
      authorization: authorizationOn(init),
      warehouseId: body.warehouse_id,
    });
    const verdict = answer(body.statement);
    if (verdict.http) {
      return Promise.resolve(new Response(JSON.stringify(verdict.message ? { message: verdict.message } : {}), {
          status: verdict.http,
          headers: { 'content-type': 'application/json' },
        })
      );
    }
    return Promise.resolve(new Response(JSON.stringify(verdict.ok
            ? { status: { state: 'SUCCEEDED' } }
            : { status: { state: verdict.state ?? 'FAILED', error: { message: verdict.message } } }
        ),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
  });
  return calls;
}

function asUser(token?: string) {
  return {
    method: 'POST',
    headers: {
      'x-forwarded-email': USER,
      ...(token ? { 'x-forwarded-access-token': token } : {}),
    },
  } satisfies RequestInit;
}

let host: string | undefined;
let endpoint: string | undefined;
let warehouse: string | undefined;
let appName: string | undefined;

beforeEach(() => {
  genieCalls = [];
  resetLakebaseHealth();
  forgetAccessDecisions();
  forgetServingPrincipal();
  host = process.env.DATABRICKS_HOST;
  endpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
  warehouse = process.env.DATABRICKS_SQL_WAREHOUSE_ID;
  appName = process.env.DATABRICKS_APP_NAME;
  process.env.DATABRICKS_HOST = HOST;
  // The app's own warehouse, from its `sql-warehouse` app resource. This is the
  // route's only source for it now, so an unset variable is the "cannot check"
  // case rather than a detail of the harness.
  process.env.DATABRICKS_SQL_WAREHOUSE_ID = WAREHOUSE;
  // Without this the app never calls the transport at all, falls back to
  // representative data, and every case below would pass or fail for the wrong
  // reason.
  process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
  process.env.DATABRICKS_APP_NAME = 'astrolabe';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (host === undefined) delete process.env.DATABRICKS_HOST;
  else process.env.DATABRICKS_HOST = host;
  if (endpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
  else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = endpoint;
  if (warehouse === undefined) delete process.env.DATABRICKS_SQL_WAREHOUSE_ID;
  else process.env.DATABRICKS_SQL_WAREHOUSE_ID = warehouse;
  if (appName === undefined) delete process.env.DATABRICKS_APP_NAME;
  else process.env.DATABRICKS_APP_NAME = appName;
  vi.restoreAllMocks();
});

describe('POST /api/app-user-api-scopes', () => {
  it('updates this app with the forwarded user token and preserves extra scopes', async () => {
    const calls: { method: string; authorization: string; body: unknown }[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (requestedUrl(input) !== APP) return real(input, init);
      calls.push({
        method: init?.method ?? 'GET',
        authorization: authorizationOn(init),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return Promise.resolve(
        calls.length === 1
          ? new Response(JSON.stringify({ user_api_scopes: ['catalog.tables:read'] }))
          : new Response('{}'),
      );
    });
    const app = await startApp(retiredWithoutConfiguration());
    let response: Response;
    try {
      response = await fetch(app.url('/api/app-user-api-scopes'), asUser('user-token'));
    } finally {
      await app.close();
    }

    expect(response.status).toBe(200);
    expect(calls.map((call) => call.authorization)).toEqual([
      'Bearer user-token',
      'Bearer user-token',
    ]);
    expect(calls[1].body).toEqual({
      user_api_scopes: [...new Set(['catalog.tables:read', ...MANAGER_GRANT_USER_API_SCOPES])],
    });
  });

  it('requests only a supported optional scope from an untrusted body', async () => {
    const calls: unknown[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (requestedUrl(input) !== APP) return real(input, init);
      calls.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
      return Promise.resolve(calls.length === 1 ? new Response('{"user_api_scopes":[]}') : new Response('{}'));
    });
    const app = await startApp(retiredWithoutConfiguration());
    try {
      const response = await fetch(app.url('/api/app-user-api-scopes'), {
        ...asUser('user-token'),
        headers: { ...asUser('user-token').headers, 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'postgres' }),
      });
      expect(response.status).toBe(200);
    } finally {
      await app.close();
    }

    expect(calls[1]).toEqual({
      user_api_scopes: [
        'serving.serving-endpoints',
        'model-serving',
        'sql',
        'dashboards.genie',
        'postgres',
      ],
    });
  });

  it('rejects a hostile scope name before calling Databricks', async () => {
    const call = vi.spyOn(globalThis, 'fetch');
    const app = await startApp(retiredWithoutConfiguration());
    let response: Response;
    try {
      response = await fetch(app.url('/api/app-user-api-scopes'), {
        ...asUser('user-token'),
        headers: { ...asUser('user-token').headers, 'content-type': 'application/json' },
        body: JSON.stringify({ scope: '<script>alert(1)</script>' }),
      });
    } finally {
      await app.close();
    }

    expect(response.status).toBe(400);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('returns a clear refusal when the user cannot manage the app', async () => {
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
      requestedUrl(input) === APP
        ? Promise.resolve(
            new Response(JSON.stringify({ message: 'No CAN MANAGE' }), {
              status: 403,
              headers: { 'content-type': 'application/json' },
            }),
          )
        : real(input, init),
    );
    const app = await startApp(retiredWithoutConfiguration());
    let response: Response;
    let body: { message?: string };
    try {
      response = await fetch(app.url('/api/app-user-api-scopes'), asUser('user-token'));
      body = (await response.json()) as { message?: string };
    } finally {
      await app.close();
    }

    expect(response.status).toBe(403);
    expect(body.message).toContain('Ask someone who can manage this app to open it once');
  });
});

describe('POST /api/access-verification when no user token arrives', () => {
  /**
   * The state a customer is most likely to reach first, and the one that must
   * never read as a denial: `user_api_scopes` is applied when the app starts,
   * so an app that was redeployed rather than restarted forwards nothing at
   * all and every check the user asked for goes unrun.
   */
  it('calls it a deployment state, names both causes, and offers the restart', async () => {
    const app = await startApp(reportingTransport(agentReport()));
    let body: VerificationBody;
    let status: number;
    try {
      const response = await fetch(app.url('/api/access-verification'), asUser());
      status = response.status;
      body = await verificationBody(response);
    } finally {
      await app.close();
    }

    expect(status).toBe(409);
    expect(body.verified).toBe(false);
    expect(blockedOn(body).kind).toBe('no-user-token');
    expect(blockedOn(body).layer).toBe('app configuration');
    // Both indistinguishable causes, because sending the reader to one of them
    // on a coin flip is how an afternoon disappears.
    expect(blockedOn(body).summary).toMatch(/user authorization is not enabled/i);
    expect(blockedOn(body).summary).toMatch(/stopped and started/i);
    expect(remedyOn(body).statement).toContain('databricks apps stop');
    expect(remedyOn(body).statement).toContain('databricks apps start');
    // Not a permission verdict. Nothing was asked about this person.
    expect(body.verdicts).toBeUndefined();
    expect(blockedOn(body).missing).toBeUndefined();
  });

  it('blames local development rather than the deployment when nobody is signed in', async () => {
    const app = await startApp(reportingTransport(agentReport()));
    let body: VerificationBody;
    try {
      const response = await fetch(app.url('/api/access-verification'), { method: 'POST' });
      body = await verificationBody(response);
    } finally {
      await app.close();
    }

    expect(blockedOn(body).kind).toBe('no-user-token');
    expect(blockedOn(body).layer).toBe('local development');
    expect(blockedOn(body).summary).toMatch(/Nothing is wrong with the deployment/);
    // No restart to offer: there is no deployment to restart.
    expect(blockedOn(body).remedy).toBeUndefined();
  });
});

describe('POST /api/access-verification with a token', () => {
  it('runs the probes as the user, not as the app', async () => {
    const calls = stubStatements(() => ({ ok: true }));
    const app = await startApp(retiredWithoutConfiguration());
    try {
      await fetch(app.url('/api/access-verification'), asUser('user-token'));
    } finally {
      await app.close();
    }

    expect(calls.every((call) => call.authorization === 'Bearer user-token')).toBe(true);
    // The app's own warehouse, from DATABRICKS_SQL_WAREHOUSE_ID.
    expect(calls.every((call) => call.warehouseId === WAREHOUSE)).toBe(true);
    // One statement, naming nothing. Configuration named nothing to probe.
    expect(calls.map((call) => call.statement)).toEqual(['SELECT 1']);
  });

  it('admits a user who can run a statement, without implying it read anything', async () => {
    stubStatements(() => ({ ok: true }));
    const app = await startApp(retiredWithoutConfiguration());
    let body: VerificationBody;
    let status: number;
    try {
      const response = await fetch(app.url('/api/access-verification'), asUser('user-token'));
      status = response.status;
      body = await verificationBody(response);
    } finally {
      await app.close();
    }

    expect(status).toBe(200);
    expect(body.verified).toBe(true);
    expect(decisionOn(body).mode).toBe('user-verified');
    // The whole risk of a zero-table pass: it must not read as a clean bill of
    // health for data the check never touched.
    expect(decisionOn(body).detail).toContain('No table was checked');
    expect(decisionOn(body).detail).not.toMatch(/SELECT on \d+ tables?/);
    const limits = JSON.stringify(body.notChecked);
    expect(limits).toMatch(/row filter or a column mask/);
    expect(limits).toMatch(/could not learn which tables the agent reads/);
    expect(limits).toMatch(/Genie/);
  });

  /**
   * When the endpoint returns no configuration, the gate cannot invent a table
   * list. Naming that gap is the whole point of notChecked.
   */
  it('probes neither a table nor a Genie space when configuration is absent', async () => {
    const calls = stubStatements(() => ({ ok: true }));
    const app = await startApp(retiredWithoutConfiguration());
    let body: VerificationBody;
    try {
      const response = await fetch(app.url('/api/access-verification'), asUser(FULL_SCOPES));
      body = await verificationBody(response);
    } finally {
      await app.close();
    }

    expect(genieCalls).toHaveLength(0);
    expect(calls.map((call) => call.statement)).toEqual(['SELECT 1']);
    expect(body.verified).toBe(true);
    expect(body.ok).toBe(0);
    expect(body.genie ?? []).toHaveLength(0);
    const limits = JSON.stringify(body.notChecked);
    expect(limits).toMatch(/could not learn which tables the agent reads/);
    expect(limits).toMatch(/Genie/);
  });

  it('probes the declared tables and Genie spaces from served configuration', async () => {
    const calls = stubStatements(() => ({ ok: true }));
    const app = await startApp(retiredWithConfiguration());
    let body: VerificationBody;
    try {
      const response = await fetch(app.url('/api/access-verification'), asUser(FULL_SCOPES));
      body = await verificationBody(response);
    } finally {
      await app.close();
    }

    expect(calls.map((call) => call.statement)[0]).toBe('SELECT 1');
    expect(calls.length).toBe(1 + TABLES.length);
    for (const table of TABLES) {
      expect(calls.some((call) => call.statement.includes(table))).toBe(true);
    }
    expect(genieCalls.map((call) => call.spaceId).sort()).toEqual([...SPACES].sort());
    expect(body.verified).toBe(true);
    expect(body.ok).toBe(TABLES.length);
    expect(body.genie).toHaveLength(2);
    expect(genieOn(body).every((verdict) => verdict.status === 'ok')).toBe(true);
    expect(genieOn(body)[0].label).toMatch(/Player Insights/);
    expect(decisionOn(body).detail).toMatch(/SELECT on/);
    expect(JSON.stringify(body.notChecked)).not.toMatch(/could not learn which tables/);
  });

  /**
   * A token carrying `sql` and not `dashboards.genie`, which is what a
   * deployment that declared the Genie scope and was redeployed rather than
   * restarted forwards. Nothing is wrong with the reader, and the distinction
   * that costs this project the most support time is that from the gate a
   * scope the app never started with reads exactly like a permission the
   * person was refused.
   *
   * Asserted as a comparison against the full-scope token, because the claim
   * is that the absent scope changes nothing the reader is told about their
   * own access. It cannot change the Genie half either way here: the app names
   * no space to ask about, so the report says so for both tokens. What the
   * scope could still do is turn a pass into a refusal, and that is what this
   * pins down. The scope's effect on a run that does name spaces, and
   * `tokenGrantsGenie` itself, are in access-verification.test.ts.
   */
  it('does not read a token short of the Genie scope as a permission the reader lacks', async () => {
    stubStatements(() => ({ ok: true }));
    const app = await startApp(retiredWithoutConfiguration());
    let short: VerificationBody;
    let shortStatus: number;
    let full: VerificationBody;
    try {
      const refused = await fetch(app.url('/api/access-verification'), asUser(SQL_ONLY));
      shortStatus = refused.status;
      short = await verificationBody(refused);
      full = await verificationBody(
        await fetch(app.url('/api/access-verification'), asUser(FULL_SCOPES))
      );
    } finally {
      await app.close();
    }

    expect(shortStatus).toBe(200);
    expect(short.verified).toBe(true);
    expect(short.blocked).toBeUndefined();
    // Not asked, rather than asked and refused. A call the token cannot make
    // would come back as a 403 and read as a space withheld from the reader.
    expect(genieCalls).toHaveLength(0);
    expect(short.genie ?? []).toHaveLength(0);
    // The gap is still stated. A run that could not ask must not pass for one
    // that asked and liked the answer.
    expect(JSON.stringify(short.notChecked)).toMatch(/Genie/);

    // `decidedAt` is a clock reading; everything else about the two answers is
    // the reader's own access, and none of it may depend on the scope.
    const aboutTheReader = (body: VerificationBody) => ({
      verified: body.verified,
      blocked: body.blocked,
      verdicts: body.verdicts,
      genie: body.genie,
      notChecked: body.notChecked,
      summary: body.decision?.detail,
    });
    expect(aboutTheReader(short)).toEqual(aboutTheReader(full));
  });

  /**
   * The failure this whole ordering exists for. Before the warehouse stage,
   * a reader short of CAN_USE was told they lacked SELECT on every table in
   * the report: the wrong object, the wrong privilege, and a list of GRANTs
   * that would have changed nothing.
   */
  it('reports one warehouse grant rather than a denial per table', async () => {
    const calls = stubStatements(() => ({
      ok: false,
      message: `PERMISSION_DENIED: User does not have permission to use warehouse ${WAREHOUSE}. SQLSTATE: 42501`,
    }));
    const app = await startApp(reportingTransport(agentReport()));
    let body: VerificationBody;
    try {
      const response = await fetch(app.url('/api/access-verification'), asUser('user-token'));
      body = await verificationBody(response);
    } finally {
      await app.close();
    }

    expect(blockedOn(body).kind).toBe('warehouse-denied');
    expect(blockedOn(body).missing).toEqual({
      object: WAREHOUSE,
      permission: 'CAN_USE',
      objectKind: 'sql-warehouse',
    });
    expect(remedyOn(body).statement).toContain(`databricks permissions update warehouses ${WAREHOUSE}`
    );
    expect(body.verdicts).toEqual([]);
    // It stopped, rather than asking two more questions it already knew the
    // answer to and reporting them as table verdicts.
    expect(calls).toHaveLength(1);
  });

  /**
   * The same stage, given the wording that makes it hard. This refusal names a
   * table and names SELECT, and the statement that earned it named neither: it
   * is `SELECT 1` coming back refused, because the warehouse is the only thing
   * this route probes. Reading the prose and believing it would report a Unity
   * Catalog denial on a table the run never touched, and hand the reader a
   * GRANT SELECT that changes nothing about a warehouse they cannot use.
   *
   * The sibling file feeds the catalog-level variant of this fixture to
   * `classifyDenial`, where naming the object in the message IS the answer.
   * This is the same wording arriving at the one stage where it is not.
   */
  it('still reports the warehouse grant when the refusal names a table and SELECT', async () => {
    const calls = stubStatements(() => ({ ok: false, message: REAL_INSUFFICIENT }));
    const app = await startApp(reportingTransport(agentReport()));
    let body: VerificationBody;
    let status: number;
    try {
      const response = await fetch(app.url('/api/access-verification'), asUser('user-token'));
      status = response.status;
      body = await verificationBody(response);
    } finally {
      await app.close();
    }

    expect(status).toBe(403);
    expect(body.verified).toBe(false);
    expect(blockedOn(body).kind).toBe('warehouse-denied');
    expect(blockedOn(body).missing).toEqual({
      object: WAREHOUSE,
      permission: 'CAN_USE',
      objectKind: 'sql-warehouse',
    });
    // A warehouse is not a Unity Catalog securable, so the remedy is the
    // permissions API and never the GRANT the message's wording invites.
    expect(remedyOn(body).kind).toBe('cli');
    expect(remedyOn(body).statement).toContain(`databricks permissions update warehouses ${WAREHOUSE}`
    );
    // Verbatim, so the classification above can be checked rather than taken
    // on trust...
    expect(blockedOn(body).apiMessage).toBe(REAL_INSUFFICIENT);
    // ...and the table stays inside that quotation. The app's own words must
    // not repeat a claim about an object it never asked a question about.
    expect(blockedOn(body).summary).not.toContain(TABLES[1]);
    expect(JSON.stringify(blockedOn(body).remedy)).not.toContain(TABLES[1]);
    expect(body.verdicts).toEqual([]);
    expect(calls.map((call) => call.statement)).toEqual(['SELECT 1']);
  });

  it('calls a missing scope a scope problem, not a permission the reader lacks', async () => {
    stubStatements(() => ({
      ok: false,
      message: 'Provided OAuth token does not have required scopes: sql',
    }));
    const app = await startApp(reportingTransport(agentReport()));
    let body: VerificationBody;
    try {
      const response = await fetch(app.url('/api/access-verification'), asUser('user-token'));
      body = await verificationBody(response);
    } finally {
      await app.close();
    }

    expect(blockedOn(body).kind).toBe('no-sql-scope');
    expect(blockedOn(body).summary).toMatch(/not a permission you are missing/);
    expect(blockedOn(body).summary).toMatch(/no grant made to you will change it/);
    // The "a redeploy will not do it" fact is load-bearing and still stated, but
    // it is IN the statement now, as a comment above the two commands, rather
    // than in a note underneath restating them.
    expect(remedyOn(body).statement).toMatch(/A redeploy leaves it inert/);
    expect(remedyOn(body).guidance).toBe('');
    expect(body.verdicts).toEqual([]);
  });

  /**
   * The status has to agree with the body.
   */
  it.each([
    ['a token Databricks itself refused', { ok: false as const, http: 401 }, 'token-rejected', 401],
    [
      'a warehouse id that resolves to nothing',
      { ok: false as const, http: 404 },
      'warehouse-missing',
      503,
    ],
    [
      'a warehouse that did not answer',
      { ok: false as const, state: 'CANCELED', message: 'Statement was canceled.' },
      'dependency-down',
      503,
    ],
    [
      'a warehouse that refused the reader',
      {
        ok: false as const,
        message: `PERMISSION_DENIED: User does not have permission to use warehouse ${WAREHOUSE}. SQLSTATE: 42501`,
      },
      'warehouse-denied',
      403,
    ],
  ])('answers %s with the status it earned, not 403 for everything', async (_label, verdict, kind, expected) => {
    stubStatements(() => verdict);
    const app = await startApp(reportingTransport(agentReport()));
    let body: VerificationBody;
    let status: number;
    try {
      const response = await fetch(app.url('/api/access-verification'), asUser('user-token'));
      status = response.status;
      body = await verificationBody(response);
    } finally {
      await app.close();
    }

    expect(blockedOn(body).kind).toBe(kind);
    expect(status).toBe(expected);
  });

  it('distinguishes a warehouse that is down from one that refused', async () => {
    stubStatements(() => ({ ok: false, state: 'CANCELED', message: 'Statement was canceled.' }));
    const app = await startApp(reportingTransport(agentReport()));
    let body: VerificationBody;
    try {
      const response = await fetch(app.url('/api/access-verification'), asUser('user-token'));
      body = await verificationBody(response);
    } finally {
      await app.close();
    }

    expect(blockedOn(body).kind).toBe('dependency-down');
    expect(blockedOn(body).layer).toBe('SQL warehouse availability');
    expect(blockedOn(body).missing).toBeUndefined();
  });
});

describe('POST /api/access-verification when the app cannot check at all', () => {
  /**
   * This route used to derive its warehouse from the agent's dependency
   * report, so when the endpoint stopped returning one it answered 503 to
   * everybody: a permanent failure behind a button, in front of the one
   * diagnosis a locked-out user needs. Its configuration is its own now, and an
   * endpoint that cannot be reached has no bearing on whether this user can run
   * a statement.
   */
  it('verifies the user even when the agent endpoint is unreachable', async () => {
    stubStatements(() => ({ ok: true }));
    const app = await startApp(() => Promise.reject(new Error('endpoint unreachable')));
    let body: VerificationBody;
    let status: number;
    try {
      const response = await fetch(app.url('/api/access-verification'), asUser('user-token'));
      status = response.status;
      body = await verificationBody(response);
    } finally {
      await app.close();
    }

    expect(status).toBe(200);
    expect(body.verified).toBe(true);
    expect(body.blocked).toBeUndefined();
  });

  it('says so plainly when no warehouse is attached to the app', async () => {
    delete process.env.DATABRICKS_SQL_WAREHOUSE_ID;
    const app = await startApp(reportingTransport(agentReport()));
    let body: VerificationBody;
    let status: number;
    try {
      const response = await fetch(app.url('/api/access-verification'), asUser('user-token'));
      status = response.status;
      body = await verificationBody(response);
    } finally {
      await app.close();
    }

    expect(status).toBe(503);
    expect(blockedOn(body).kind).toBe('not-configured');
    expect(blockedOn(body).layer).toBe('app configuration');
    // Not a verdict about this person. The distinction the old 503 destroyed.
    expect(blockedOn(body).summary).toMatch(/says nothing about your permissions/);
    expect(blockedOn(body).missing).toBeUndefined();
    // A run that established nothing still states what it did not cover.
    expect(notCheckedOn(body).length).toBeGreaterThan(0);
  });
});
