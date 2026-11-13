import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupInsightsRoutes, type InsightsAppKit, type ServingTransport } from './insights-routes';
import { announceSeedAdmins } from '../lib/admin-roles';
import { resetLakebaseHealth } from '../lib/lakebase-store';
import { answerContentIn } from '../../shared/terminal-response';
import { FAILURE_TAXONOMY, NEVER_REROUTE_LAYERS } from '../../shared/failure-taxonomy';

/**
 * The signed-in user is the authorization boundary, asserted from outside the
 * app.
 *
 * ONE PROPERTY MATTERS MORE THAN THE REST and most of this file is about it: no
 * analytical request is ever executed under the app's own service principal. The
 * route used to catch a 401 or a 403 from the forwarded token and invoke the
 * endpoint again with no token at all, which the transport resolves as the app.
 * The answer came back, was stored, and carried a caveat, so the product could
 * report that a user's access had been checked while the warehouse had executed
 * for somebody else.
 *
 * The tests are therefore mostly about what did NOT happen: how many times the
 * endpoint was called, what credential each call carried, and whether anything
 * was written. An assertion that a refusal has the right code is worth much less
 * than one that the refusal was the end of it.
 *
 * NOT COVERED HERE, because neither can be established without a live workspace:
 * whether Unity Catalog actually denies one label's reader the other label's
 * tables, and whether Model Serving parks the invoker's downscoped token. Those
 * are properties of the platform's enforcement. What is covered is that when the
 * platform denies, this app stops, which is the half that lives in this repo.
 * The agent's side of the boundary is in agent/tests/test_execution_identity.py.
 */

const ALICE = 'alice@example.example';
const GRACE = 'grace@example.example';

/** A JWT with the given claims. Unsigned: nothing here verifies a signature. */
function jwt(claims: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`;
}

function inAnHour(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}

interface Invocation {
  token: string | undefined;
  customInputs: Record<string, unknown>;
}

/**
 * A transport that records every invocation and answers however the test says.
 *
 * The recorded token is the whole point: a call with `undefined` there is a call
 * that ran as the application.
 */
function recordingTransport(respond: (call: number) => Promise<unknown>) {
  const calls: Invocation[] = [];
  const transport: ServingTransport = ({ payload, userToken }) => {
    calls.push({
      token: userToken,
      customInputs: (payload as { custom_inputs?: Record<string, unknown> }).custom_inputs ?? {},
    });
    return respond(calls.length);
  };
  return { calls, transport };
}

/** An error shaped like the SDK's, which puts the status on `statusCode`. */
function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

/** An answer the route will accept, so a test can reach the success path. */
function structuredAnswer() {
  return {
    custom_outputs: {
      answer: {
        id: 'msg-1',
        takeaway: 'Active players rose 4%.',
        narrative: 'Active players rose 4% over the period.',
        figures: [],
        charts: [],
        sources: [{ name: 'gold.daily_summary', freshness: 'Read during this run' }],
        caveats: [],
        sql: 'SELECT 1',
        trace: { id: 'tr-00000000000000000000000000000001', totalMs: 10, toolCalls: 1, stages: [] },
      },
    },
  };
}

function statements(): { sql: string; params: unknown[] }[] {
  return recorded;
}

let recorded: { sql: string; params: unknown[] }[];

function store() {
  return {
    query(sql: string, params: unknown[] = []) {
      recorded.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
  };
}

async function startApp(transport: InsightsAppKit['servingTransport']) {
  const app = express();
  app.use(express.json());
  // Benchmark Lab's endpoints are admin-only, and ALICE is the signed-in caller
  // throughout this file. Without the role she is refused with 403 before a route
  // handler runs, and the identity-binding refusals this file exists to pin would
  // never be reached. Which is itself correct: a consumer presenting a mismatched
  // token is told they are not an administrator and nothing more. What is asserted
  // below is the refusal an ADMIN gets, which is the one that has to name the kind
  // of failure without naming either identity.
  announceSeedAdmins(ALICE);
  await setupInsightsRoutes({
    lakebase: store(),
    server: { extend: (fn) => fn(app) },
    servingTransport: transport,
  });
  // Loopback rather than the wildcard, or this binds a port another process holds
  // on 127.0.0.1 and the fetch below reaches that process. See shared-rail.test.ts.
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    ask(headers: Record<string, string>, body: Record<string, unknown> = {}) {
      return fetch(`http://127.0.0.1:${port}/api/insights/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          conversationId: 'conv-1',
          prompt: 'Compare active players by label.',
          ...body,
        }),
      });
    },
    identity(headers: Record<string, string>) {
      return fetch(`http://127.0.0.1:${port}/api/identity`, { headers });
    },
    benchmark(headers: Record<string, string>) {
      return fetch(`http://127.0.0.1:${port}/api/benchmarks/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ suiteId: 'poc-benchmark' }),
      });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function asUser(email: string, token: string) {
  return { 'x-forwarded-email': email, 'x-forwarded-access-token': token };
}

let nodeEnv: string | undefined;
let endpointName: string | undefined;

beforeEach(() => {
  resetLakebaseHealth();
  recorded = [];
  nodeEnv = process.env.NODE_ENV;
  endpointName = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
  // Without one, `invokeServing` throws before the transport is reached and
  // every assertion about what the endpoint was told passes vacuously.
  process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
  // The deployed app is the subject. Every rule here is relaxed on a laptop,
  // where there is no proxy to forward a token and no user to be.
  process.env.NODE_ENV = 'production';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  if (endpointName === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
  else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = endpointName;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The deleted branch
// ---------------------------------------------------------------------------

describe('a request the endpoint refuses is not asked again as the application', () => {
  it.each([
    [401, 'USER_AUTH_REJECTED'],
    [403, 'USER_NOT_AUTHORIZED'],
  ])('stops on HTTP %i, having called the endpoint exactly once', async (status, code) => {
    const { calls, transport } = recordingTransport(() =>
      Promise.reject(httpError(status, 'PERMISSION_DENIED: user does not have SELECT'))
    );
    const app = await startApp(transport);
    const token = jwt({ sub: ALICE, exp: inAnHour() });

    try {
      const response = await app.ask(asUser(ALICE, token));
      const body = (await response.json()) as Record<string, unknown>;

      // One call, and it carried the user's own credential. A second entry here
      // would be the retry, and an entry with no token would be the retry that
      // ran as the app.
      expect(calls).toHaveLength(1);
      expect(calls[0].token).toBe(token);
      expect(body.kind).toBe('unavailable');
      expect(body.code).toBe(code);
      expect(body.retryable).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('asks an older model again on the direct route when it has no AI Gateway service', async () => {
    const { calls, transport } = recordingTransport((call) =>
      Promise.resolve(
        call === 1
          ? { custom_outputs: { type: 'unavailable', code: 'AI_GATEWAY_UNAVAILABLE', layer: 'ai-gateway' } }
          : structuredAnswer()
      )
    );
    const app = await startApp(transport);
    const token = jwt({ sub: ALICE, exp: inAnHour() });

    try {
      const response = await app.ask(asUser(ALICE, token));

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(2);
      expect(calls[0].customInputs.llm_route).toBe('ai_gateway');
      expect(calls[1].customInputs.llm_route).toBe('direct');
      expect(calls[1].customInputs.llm_gateway_optional).toBeUndefined();
      expect(calls[1].token).toBe(token);
    } finally {
      await app.close();
    }
  });

  it('does not ask again when the Gateway itself fails', async () => {
    const { calls, transport } = recordingTransport(() =>
      Promise.resolve({ custom_outputs: { type: 'unavailable', code: 'AI_GATEWAY_ERROR', layer: 'ai-gateway' } })
    );
    const app = await startApp(transport);
    const token = jwt({ sub: ALICE, exp: inAnHour() });

    try {
      await app.ask(asUser(ALICE, token));
      expect(calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('reports an AI Gateway rate limit as a wait, once, and not as an outage', async () => {
    const { calls, transport } = recordingTransport(() =>
      Promise.reject(httpError(429, 'REQUEST_LIMIT_EXCEEDED: rate limit exceeded for user'))
    );
    const app = await startApp(transport);
    const token = jwt({ sub: ALICE, exp: inAnHour() });

    try {
      const response = await app.ask(asUser(ALICE, token));
      const body = (await response.json()) as Record<string, unknown>;

      expect(calls).toHaveLength(1);
      expect(response.status).toBe(429);
      expect(body.code).toBe('MODEL_RATE_LIMITED');
      expect(body.retryable).toBe(true);
      expect(String(body.message)).toContain('Wait a minute');
    } finally {
      await app.close();
    }
  });

  it('distinguishes a rejected credential from a permitted user reaching data they cannot read', async () => {
    // The distinction the two codes exist for. Both were one event, because
    // both led to the same retry, and only the second is about grants.
    for (const [status, layer] of [
      [401, 'identity'],
      [403, 'authorization'],
    ] as const) {
      const { transport } = recordingTransport(() => Promise.reject(httpError(status, 'denied')));
      const app = await startApp(transport);
      try {
        const body = (await (await app.ask(asUser(ALICE, 'opaque-token'))).json()) as {
          layer: string;
        };
        expect(body.layer).toBe(layer);
      } finally {
        await app.close();
      }
    }
  });

  it('says the same thing when the rejection arrives as prose rather than a status', async () => {
    // A streamed invocation that fails mid-body carries no status field at all.
    // Reading the message is a guess, and it guesses in the direction that stops
    // a request rather than the one that lets it through.
    const { calls, transport } = recordingTransport(() => Promise.reject(new Error('Invalid access token.')));
    const app = await startApp(transport);

    try {
      const body = (await (await app.ask(asUser(ALICE, 'opaque-token'))).json()) as {
        kind: string;
        code: string;
      };

      expect(calls).toHaveLength(1);
      expect(body.kind).toBe('unavailable');
      expect(body.code).toBe('USER_AUTH_REJECTED');
    } finally {
      await app.close();
    }
  });

  it('stores no assistant turn for a question that was never answered', async () => {
    // The user's own turn is written before the endpoint is called and stays:
    // they did ask, and a conversation that silently drops the question reads
    // as though they never did. What must not exist is a reply. A stored
    // assistant row would appear in the rail as an answer and would be carried
    // into the next turn as context.
    const { transport } = recordingTransport(() => Promise.reject(httpError(403, 'denied')));
    const app = await startApp(transport);

    try {
      await app.ask(asUser(ALICE, 'opaque-token'));

      const assistantRows = statements().filter(
        (entry) => entry.sql.startsWith('INSERT INTO player_insights.messages') && entry.params.includes('assistant')
      );
      expect(assistantRows).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('shows a denied reader no figures, no sources and no SQL', async () => {
    // The most expensive version of the bug: the demo dataset rendered as an
    // answer at the exact moment the system decided this reader may see none.
    const { transport } = recordingTransport(() => Promise.reject(httpError(403, 'denied')));
    const app = await startApp(transport);

    try {
      const body = await (await app.ask(asUser(ALICE, 'opaque-token'))).json();

      expect(answerContentIn(body)).toEqual([]);
      expect(JSON.stringify(body)).not.toContain('Active players');
    } finally {
      await app.close();
    }
  });

  it('gives the reader a correlation id and no internal detail in the sentence', async () => {
    const { transport } = recordingTransport(() => Promise.reject(httpError(403, 'denied')));
    const app = await startApp(transport);

    try {
      const body = (await (await app.ask(asUser(ALICE, 'opaque-token'))).json()) as {
        request_id: string;
        message: string;
      };

      expect(body.request_id).toMatch(/^req-/);
      expect(body.message).toBe('You do not have access to one or more data products required by this question.');
      // Which table, which grant and which principal are the operator's to read
      // in `detail` and in the log, not the denied reader's.
      expect(body.message).not.toContain('SELECT');
      expect(body.message).not.toContain(ALICE);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Identity that never reaches the endpoint at all
// ---------------------------------------------------------------------------

describe('an identity that cannot be established never invokes the endpoint', () => {
  const expired = jwt({ sub: ALICE, exp: Math.floor(Date.now() / 1000) - 7200 });
  const somebodyElse = jwt({ sub: GRACE, exp: inAnHour() });

  it.each([
    ['missing', { 'x-forwarded-email': ALICE }, 'IDENTITY_REQUIRED'],
    ['expired', asUser(ALICE, expired), 'USER_AUTH_REJECTED'],
    ['mismatched', asUser(ALICE, somebodyElse), 'IDENTITY_MISMATCH'],
  ])('refuses a %s identity without calling serving or writing a row', async (_name, headers, code) => {
    const { calls, transport } = recordingTransport(() => Promise.resolve(structuredAnswer()));
    const app = await startApp(transport);

    try {
      const response = await app.ask(headers);
      const body = (await response.json()) as Record<string, unknown>;

      expect(calls).toEqual([]);
      expect(body.kind).toBe('unavailable');
      expect(body.code).toBe(code);
      expect(body.persistence_status).toBe('not_stored');
      // Nothing about this conversation, including the upsert: a refused
      // question must not move `updated_at` on a conversation it never joined,
      // and must not leave a user turn nothing will ever answer. The schema
      // seed's own INSERT is excluded by naming the two tables that matter.
      expect(
        statements().filter((entry) => /^INSERT INTO player_insights\.(conversations|messages)/.test(entry.sql))
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });

  /**
   * The same refusal, one route across, where it was left behind.
   *
   * `POST /api/insights/ask` was changed to send `disclosableRefusal(identity)`
   * rather than `identity.detail`, because that field names the subject resolved
   * from the token beside the signed-in user and its own declaration in
   * `lib/identity-binding.ts` says so: telling somebody which subject we
   * resolved tells them what to present next. `POST /api/benchmarks/run` refuses
   * on the identical branch and kept sending the raw one.
   *
   * Both are asserted here rather than only the benchmark, so the pair cannot
   * drift apart again by one of them being edited alone.
   */
  it.each([
    ['ask', (app: Awaited<ReturnType<typeof startApp>>, headers: Record<string, string>) => app.ask(headers)],
    [
      'benchmark',
      (app: Awaited<ReturnType<typeof startApp>>, headers: Record<string, string>) => app.benchmark(headers),
    ],
  ])('refuses on %s without naming either identity in the body', async (_route, call) => {
    const { transport } = recordingTransport(() => Promise.resolve(structuredAnswer()));
    const app = await startApp(transport);

    try {
      const response = await call(app, asUser(ALICE, jwt({ sub: GRACE, exp: inAnHour() })));
      const body = await response.text();

      // The code still travels, because a caller is owed the kind of failure.
      expect((JSON.parse(body) as { code: string }).code).toBe('IDENTITY_MISMATCH');
      // Neither the address the proxy asserted nor the subject the token
      // carried. The second is the one that matters: it is the half the caller
      // did not already know, and it is what a prober would iterate on.
      expect(body).not.toContain(GRACE);
      expect(body).not.toContain(ALICE);
    } finally {
      await app.close();
    }
  });

  it('names no run, because there is no run to name', async () => {
    // A correlation id that finds nothing when quoted is worse than none: the
    // reader spends their goodwill on support and support finds an empty table.
    const { transport } = recordingTransport(() => Promise.resolve(structuredAnswer()));
    const app = await startApp(transport);

    try {
      const body = (await (await app.ask({ 'x-forwarded-email': ALICE })).json()) as {
        run_id: string | null;
        request_id: string;
      };

      expect(body.run_id).toBeNull();
      expect(body.request_id).toMatch(/^req-/);
    } finally {
      await app.close();
    }
  });

  it('reports the identity as unverified rather than omitting the claim', async () => {
    const { transport } = recordingTransport(() => Promise.resolve(structuredAnswer()));
    const app = await startApp(transport);

    try {
      const body = (await (await app.ask(asUser(ALICE, somebodyElse))).json()) as {
        execution_identity: { mode: string; verified: boolean };
      };

      expect(body.execution_identity).toEqual({ mode: 'signed_in_user', verified: false });
    } finally {
      await app.close();
    }
  });

  it('lets a token that states no subject through, because opaque is not wrong', async () => {
    // A personal access token is an opaque string. Refusing it would take down
    // every deployment whose tokens are not JWTs, on a rule that has never
    // fired correctly. It proceeds as the user, unverified, and the endpoint
    // holds its own invoker against the user this request names.
    const { calls, transport } = recordingTransport(() => Promise.resolve(structuredAnswer()));
    const app = await startApp(transport);

    try {
      const response = await app.ask(asUser(ALICE, 'dapi-opaque-token'));
      const body = (await response.json()) as {
        type: string;
        execution_identity: { mode: string; verified: boolean };
      };

      expect(calls).toHaveLength(1);
      expect(calls[0].token).toBe('dapi-opaque-token');
      expect(body.type).toBe('answer');
      expect(body.execution_identity).toEqual({ mode: 'signed_in_user', verified: false });
    } finally {
      await app.close();
    }
  });

  it('records a verified identity as verified when the token proves it', async () => {
    const token = jwt({ sub: ALICE, exp: inAnHour() });
    const { transport } = recordingTransport(() => Promise.resolve(structuredAnswer()));
    const app = await startApp(transport);

    try {
      const body = (await (await app.ask(asUser(ALICE, token))).json()) as {
        execution_identity: { mode: string; verified: boolean };
      };

      expect(body.execution_identity).toEqual({ mode: 'signed_in_user', verified: true });
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// What the endpoint is told
// ---------------------------------------------------------------------------

describe('what the app tells the endpoint about who is asking', () => {
  it('names the user the endpoint must find itself executing as', async () => {
    const { calls, transport } = recordingTransport(() => Promise.resolve(structuredAnswer()));
    const app = await startApp(transport);

    try {
      await app.ask(asUser(ALICE, jwt({ sub: ALICE, exp: inAnHour() })));

      expect(calls[0].customInputs.identity_mode).toBe('signed_in_user');
      expect(calls[0].customInputs.expected_user).toBe(ALICE);
    } finally {
      await app.close();
    }
  });

  it('sends a correlation id and an absolute deadline', async () => {
    const { calls, transport } = recordingTransport(() => Promise.resolve(structuredAnswer()));
    const app = await startApp(transport);

    try {
      await app.ask(asUser(ALICE, 'opaque-token'));
      const { request_id, run_id, deadline_at } = calls[0].customInputs as Record<string, string>;

      expect(request_id).toMatch(/^req-/);
      expect(run_id).toBe(request_id);
      // Absolute rather than a duration, so a queue between here and the
      // endpoint cannot restart the clock by holding the request.
      expect(Date.parse(deadline_at)).toBeGreaterThan(Date.now());
    } finally {
      await app.close();
    }
  });

  it('never puts the bearer token in the request body', async () => {
    // It travels as the credential on the call and nowhere else. A copy in
    // `custom_inputs` would be logged by the endpoint, kept in the trace, and
    // read back by anybody who can open the run.
    const token = jwt({ sub: ALICE, exp: inAnHour() });
    const { calls, transport } = recordingTransport(() => Promise.resolve(structuredAnswer()));
    const app = await startApp(transport);

    try {
      await app.ask(asUser(ALICE, token));

      expect(JSON.stringify(calls[0].customInputs)).not.toContain(token);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Two users at once
// ---------------------------------------------------------------------------

describe('concurrent requests from two users', () => {
  it('gives each invocation its own credential and its own named user', async () => {
    // One container, two callers. A client, a token or an identity cached
    // anywhere between the header and the transport shows up here as two calls
    // carrying the same credential.
    const { calls, transport } = recordingTransport(
      () => new Promise((resolve) => setTimeout(() => resolve(structuredAnswer()), 5))
    );
    const app = await startApp(transport);

    try {
      await Promise.all([
        app.ask(asUser(ALICE, jwt({ sub: ALICE, exp: inAnHour() }))),
        app.ask(asUser(GRACE, jwt({ sub: GRACE, exp: inAnHour() }))),
      ]);

      const named = calls.map((call) => call.customInputs.expected_user).sort();
      expect(named).toEqual([ALICE, GRACE]);
      expect(new Set(calls.map((call) => call.token)).size).toBe(2);
      // And two different requests, so neither can be found under the other's id.
      expect(new Set(calls.map((call) => call.customInputs.request_id)).size).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("does not let one user's denial stop the other user's answer", async () => {
    // The failure this guards against is a denial handled by something shared:
    // a module-level flag, a cached client marked bad. Alice is refused and
    // Grace is answered, in the same process, at the same time.
    const { transport } = recordingTransport((call) =>
      call === 1 ? Promise.reject(httpError(403, 'denied')) : Promise.resolve(structuredAnswer())
    );
    const app = await startApp(transport);

    try {
      const [denied, answered] = await Promise.all([
        app.ask(asUser(ALICE, 'alice-token')).then((r) => r.json()),
        // Sequenced by the transport's call counter, so the second request is
        // the one that succeeds regardless of scheduling.
        new Promise((resolve) => setTimeout(resolve, 20)).then(() =>
          app.ask(asUser(GRACE, 'grace-token')).then((r) => r.json())
        ),
      ]);

      expect((denied as { kind: string }).kind).toBe('unavailable');
      expect((answered as { type: string }).type).toBe('answer');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

describe('the fallback cannot be restored by configuration', () => {
  it('is absent from the source rather than switched off in it', async () => {
    // The behavioural tests above prove the fallback does not fire. This one is
    // about how it does not fire. A flag would put the old behaviour one
    // environment variable away from a deployment that is trying to recover
    // from something else at the time, and the value of removing an escalation
    // path is that it is not reachable by a decision made under pressure.
    const source = await readFile(new URL('./insights-routes.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('invokeServingForUser');
    // The forbidden shape: invoking with no credential from inside a handler
    // for a refusal. `invokeServing` without a token is still reachable, and
    // must only be reachable on the branch `decideIdentity` reserves for a
    // laptop, which cannot be entered when NODE_ENV is production.
    const catchBlocks = source.split(/catch\s*\(/).slice(1);
    for (const block of catchBlocks) {
      const body = block.slice(0, 1200);
      expect(body).not.toMatch(/invokeServing\(appkit,\s*payload/);
    }
  });

  it('files every identity outcome under a layer that forbids re-identifying', () => {
    for (const code of [
      'IDENTITY_REQUIRED',
      'IDENTITY_MISMATCH',
      'USER_AUTH_REJECTED',
      'USER_NOT_AUTHORIZED',
    ] as const) {
      expect(FAILURE_TAXONOMY[code].mayRerouteOrReidentify).toBe(false);
      expect(NEVER_REROUTE_LAYERS).toContain(FAILURE_TAXONOMY[code].layer);
    }
  });
});

// ---------------------------------------------------------------------------
// What the run records
// ---------------------------------------------------------------------------

describe('the stored run agrees with the response about who it ran as', () => {
  it('writes the effective mode and whether it was verified', async () => {
    const { transport } = recordingTransport(() => Promise.resolve(structuredAnswer()));
    const app = await startApp(transport);

    try {
      const body = (await (await app.ask(asUser(ALICE, jwt({ sub: ALICE, exp: inAnHour() })))).json()) as {
        execution_identity: { mode: string; verified: boolean };
      };

      const insert = statements().find(
        (entry) => entry.sql.startsWith('INSERT INTO player_insights.messages') && entry.sql.includes('execution_mode')
      );
      expect(insert).toBeDefined();
      // The last two parameters are the two identity columns, and they say the
      // same thing the response does. A record that disagreed with the answer
      // it belongs to would make the audit trail worth nothing.
      expect(insert?.params.slice(-2)).toEqual([body.execution_identity.mode, body.execution_identity.verified]);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// What the permissions page is told
// ---------------------------------------------------------------------------

/**
 * The panel that page renders exists to answer "could an answer here have been
 * computed with grants its reader does not have". It used to answer yes for
 * everyone, in a sentence, because that was true. The field asserted here is how
 * it stops being a sentence somebody has to remember to update.
 */
describe('the identity payload reports which principal a question would run as', () => {
  it('reports the signed-in user, and marks a bound token as verified', async () => {
    const app = await startApp(recordingTransport(() => Promise.resolve(structuredAnswer())).transport);

    try {
      const body = (await (await app.identity(asUser(ALICE, jwt({ sub: ALICE, exp: inAnHour() })))).json()) as {
        analyticalExecution: { mode: string; verified: boolean };
      };
      expect(body.analyticalExecution).toEqual({ mode: 'signed_in_user', verified: true });
    } finally {
      await app.close();
    }
  });

  it('does not report the application, which would mean the boundary was off', async () => {
    const app = await startApp(recordingTransport(() => Promise.resolve(structuredAnswer())).transport);

    try {
      const body = (await (await app.identity(asUser(ALICE, jwt({ sub: 'opaque-subject' })))).json()) as {
        analyticalExecution: { mode: string; verified: boolean };
      };
      // An opaque subject cannot be bound here, so the claim is honest about
      // that, and it is still the user who executes. The mode is the assertion
      // that matters: `app_service_principal` from a deployed server would mean
      // the fallback had come back.
      expect(body.analyticalExecution).toEqual({ mode: 'signed_in_user', verified: false });
    } finally {
      await app.close();
    }
  });

  it('collapses a refusal to unverified rather than naming the reason', async () => {
    const app = await startApp(recordingTransport(() => Promise.resolve(structuredAnswer())).transport);

    try {
      const response = await app.identity(asUser(ALICE, jwt({ sub: GRACE, exp: inAnHour() })));
      const body = (await response.json()) as Record<string, unknown>;

      // The page still loads: a mismatch is a fact about the next question, not
      // a reason to withhold a deployment's principals from whoever is trying
      // to diagnose it.
      expect(response.status).toBe(200);
      expect(body.analyticalExecution).toEqual({ mode: 'signed_in_user', verified: false });
      // Nothing about WHICH identities failed to line up. This endpoint takes no
      // question and is loadable by anyone signed in, so a subject named here
      // tells a caller what to present next.
      expect(JSON.stringify(body)).not.toContain(GRACE);
      expect(JSON.stringify(body)).not.toContain('IDENTITY_MISMATCH');
    } finally {
      await app.close();
    }
  });

  it('never carries the forwarded token', async () => {
    const app = await startApp(recordingTransport(() => Promise.resolve(structuredAnswer())).transport);
    const token = jwt({ sub: ALICE, exp: inAnHour() });

    try {
      const body = await (await app.identity(asUser(ALICE, token))).text();
      expect(body).not.toContain(token);
      expect(body).not.toContain(token.split('.')[1]);
    } finally {
      await app.close();
    }
  });
});
