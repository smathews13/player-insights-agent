import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupInsightsRoutes, type InsightsAppKit, type ServingTransport } from './insights-routes';
import { resetLakebaseHealth } from '../lib/lakebase-store';

/**
 * One label's reader must not receive another label's data, and a corporate
 * reader must not receive a label-private product they were never granted.
 *
 * WHAT THIS FILE CAN AND CANNOT ESTABLISH. Whether Unity Catalog actually denies
 * those reads is the platform's half, and it is not knowable from here: it needs
 * a workspace, two real principals and the grants themselves. Asserting it with
 * a fake would be worse than not asserting it, because the file would then read
 * as covering the thing it cannot see.
 *
 * What lives in this repo is the other half, and it is the half that has been
 * wrong: given that the platform denies, does this app STOP. It used to not. It
 * caught the denial, asked again as its own service principal, and returned an
 * answer built from tables the reader had just been refused -- so the product's
 * behaviour on a correctly-configured metastore was to route around it. Every
 * test here drives a denial in and asserts on what came out.
 *
 * The scenarios differ only in who is denied what. That is deliberate: the app
 * cannot tell a cross-label denial from any other, must not try, and the tests
 * say so by treating them identically.
 */

/** A corporate analyst with no label-private grants. */
const CORPORATE = 'corporate.analyst@example.example';
/** Two labels, neither of which may read the other's restricted products. */
const LABEL_NORTH = 'north.analyst@example.example';
const LABEL_SOUTH = 'south.analyst@example.example';

/** A label-private product, named only so the tests can prove it is not echoed. */
const PRIVATE_PRODUCT = 'north_label.restricted.player_revenue_detail';

function jwt(subject: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ sub: subject, exp: Math.floor(Date.now() / 1000) + 3600 })}.signature`;
}

function asUser(email: string) {
  return { 'x-forwarded-email': email, 'x-forwarded-access-token': jwt(email) };
}

/**
 * The denial Unity Catalog produces, as the SDK surfaces it.
 *
 * The message is verbatim in shape: it names the table and the missing
 * privilege, because that is what the platform says, and a test that used a
 * sanitised string could not show that the app declines to pass it on.
 */
function permissionDenied(asset: string) {
  return Object.assign(
    new Error(
      `PERMISSION_DENIED: User does not have SELECT on Table '${asset}'. ` +
        'Please contact the owner or your metastore administrator.'
    ),
    { statusCode: 403 }
  );
}

function answerFrom(asset: string) {
  return {
    custom_outputs: {
      answer: {
        id: 'msg-1',
        takeaway: 'Revenue per player rose 6% in the North label.',
        narrative: 'Revenue per player rose 6%.',
        figures: [{ label: 'Revenue per player', value: 6.1, display: '$6.10', comparison: 'up 6%' }],
        charts: [],
        sources: [{ name: asset, freshness: 'Read during this run' }],
        caveats: [],
        sql: `SELECT revenue FROM ${asset}`,
        trace: { id: 'tr-00000000000000000000000000000002', totalMs: 12, toolCalls: 2, stages: [] },
      },
    },
  };
}

interface Invocation {
  token: string | undefined;
  expectedUser: unknown;
}

/** Answers per caller, so one run's outcome cannot be mistaken for another's. */
function transportFor(outcome: (email: string) => Promise<unknown>) {
  const calls: Invocation[] = [];
  const transport: ServingTransport = ({ payload, userToken }) => {
    const custom = (payload as { custom_inputs?: Record<string, unknown> }).custom_inputs ?? {};
    const expectedUser = typeof custom.expected_user === 'string' ? custom.expected_user : '';
    calls.push({ token: userToken, expectedUser });
    return outcome(expectedUser);
  };
  return { calls, transport };
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
    ask(email: string, conversationId: string) {
      return fetch(`http://127.0.0.1:${port}/api/insights/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...asUser(email) },
        body: JSON.stringify({
          conversationId,
          prompt: 'What is revenue per player by label this quarter?',
        }),
      });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let nodeEnv: string | undefined;
let endpointName: string | undefined;

beforeEach(() => {
  resetLakebaseHealth();
  recorded = [];
  nodeEnv = process.env.NODE_ENV;
  endpointName = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
  process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
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
// The two denials the brief names
// ---------------------------------------------------------------------------

describe('a reader denied a data product is refused rather than routed around', () => {
  it.each([
    ['a corporate reader with no grant on a label-private product', CORPORATE],
    ["a label's reader reaching another label's restricted data", LABEL_SOUTH],
  ])('stops for %s', async (_scenario, email) => {
    const { calls, transport } = transportFor(() => Promise.reject(permissionDenied(PRIVATE_PRODUCT)));
    const app = await startApp(transport);

    try {
      const response = await app.ask(email, 'conv-denied');
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(403);
      expect(body.kind).toBe('unavailable');
      expect(body.code).toBe('USER_NOT_AUTHORIZED');
      // One call, made with this reader's own credential. A second would be the
      // retry that used to run as the app, and an entry with no token would be
      // that retry succeeding.
      expect(calls).toHaveLength(1);
      expect(calls[0].token).toBeTruthy();
      expect(calls[0].expectedUser).toBe(email);
    } finally {
      await app.close();
    }
  });

  it('tells the reader the sentence the taxonomy fixed, and nothing else', async () => {
    const { transport } = transportFor(() => Promise.reject(permissionDenied(PRIVATE_PRODUCT)));
    const app = await startApp(transport);

    try {
      const body = (await (await app.ask(CORPORATE, 'conv-denied')).json()) as Record<string, unknown>;

      expect(body.message).toBe('You do not have access to one or more data products required by this question.');
      // Which product, which privilege, and which administrator to ask are all
      // in the platform's message and none of them are in ours. A denial that
      // names the table it protects tells a reader what they have found, and
      // the existence of a label-private product is itself the label's business.
      const rendered = JSON.stringify(body);
      expect(rendered).not.toContain(PRIVATE_PRODUCT);
      expect(rendered).not.toContain('north_label');
      expect(rendered).not.toMatch(/SELECT|privilege|metastore|PERMISSION_DENIED/i);
    } finally {
      await app.close();
    }
  });

  it('keeps the platform\u2019s own sentence in the log, where it is useful', async () => {
    const logged: unknown[][] = [];
    const { transport } = transportFor(() => Promise.reject(permissionDenied(PRIVATE_PRODUCT)));
    vi.mocked(console.warn).mockImplementation((...args: unknown[]) => void logged.push(args));
    const app = await startApp(transport);

    try {
      const body = (await (await app.ask(CORPORATE, 'conv-denied')).json()) as Record<string, unknown>;
      const lines = logged.flat().join(' ');

      // The operator gets the table and the missing privilege, and gets them
      // beside the id the reader will quote. Withholding it from the reader is
      // only defensible if somebody can still find out what happened.
      expect(lines).toContain(PRIVATE_PRODUCT);
      expect(String(body.request_id)).toMatch(/^req-/);
    } finally {
      await app.close();
    }
  });

  it('carries a correlation id, so the denial can be looked up without being explained', async () => {
    const { transport } = transportFor(() => Promise.reject(permissionDenied(PRIVATE_PRODUCT)));
    const app = await startApp(transport);

    try {
      const body = (await (await app.ask(LABEL_SOUTH, 'conv-denied')).json()) as Record<string, unknown>;
      expect(String(body.request_id)).toMatch(/^req-/);
      expect(body.retryable).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('returns no evidence of the read it was refused', async () => {
    const { transport } = transportFor(() => Promise.reject(permissionDenied(PRIVATE_PRODUCT)));
    const app = await startApp(transport);

    try {
      const body = (await (await app.ask(CORPORATE, 'conv-denied')).json()) as Record<string, unknown>;
      // Not merely absent from the fields we happen to check: the terminal
      // shape has no room for them, which is the property worth asserting,
      // because a degraded answer is how this used to come back.
      for (const field of ['takeaway', 'figures', 'charts', 'sources', 'sql', 'narrative']) {
        expect(body[field]).toBeUndefined();
      }
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The denial is the reader's, not the question's
// ---------------------------------------------------------------------------

describe('one reader being granted access does not extend it to another', () => {
  it('answers the granted reader and refuses the denied one, for the same question', async () => {
    const { calls, transport } = transportFor((email) =>
      email === LABEL_NORTH
        ? Promise.resolve(answerFrom(PRIVATE_PRODUCT))
        : Promise.reject(permissionDenied(PRIVATE_PRODUCT))
    );
    const app = await startApp(transport);

    try {
      const granted = (await (await app.ask(LABEL_NORTH, 'conv-north')).json()) as Record<string, unknown>;
      const denied = (await (await app.ask(LABEL_SOUTH, 'conv-south')).json()) as Record<string, unknown>;

      expect(granted.kind).not.toBe('unavailable');
      expect(denied.kind).toBe('unavailable');
      // Both went to the endpoint under their own name. The denied reader's
      // question was not answered from the granted reader's run, which is what
      // any cache keyed on the question rather than the asker would do.
      expect(calls.map((call) => call.expectedUser)).toEqual([LABEL_NORTH, LABEL_SOUTH]);
      expect(JSON.stringify(denied)).not.toContain('6%');
      expect(JSON.stringify(denied)).not.toContain('$6.10');
    } finally {
      await app.close();
    }
  });

  it('is not affected by the order the two readers ask in', async () => {
    const { transport } = transportFor((email) =>
      email === LABEL_NORTH
        ? Promise.resolve(answerFrom(PRIVATE_PRODUCT))
        : Promise.reject(permissionDenied(PRIVATE_PRODUCT))
    );
    const app = await startApp(transport);

    try {
      // Denied first this time. A refusal that left state behind would show up
      // as the granted reader losing their answer to it.
      const denied = (await (await app.ask(LABEL_SOUTH, 'conv-south')).json()) as Record<string, unknown>;
      const granted = (await (await app.ask(LABEL_NORTH, 'conv-north')).json()) as Record<string, unknown>;

      expect(denied.kind).toBe('unavailable');
      expect(granted.kind).not.toBe('unavailable');
    } finally {
      await app.close();
    }
  });

  it('keeps the two apart when they ask at the same moment', async () => {
    const { calls, transport } = transportFor((email) =>
      email === LABEL_NORTH
        ? Promise.resolve(answerFrom(PRIVATE_PRODUCT))
        : Promise.reject(permissionDenied(PRIVATE_PRODUCT))
    );
    const app = await startApp(transport);

    try {
      const [granted, denied] = await Promise.all([
        app.ask(LABEL_NORTH, 'conv-north').then((response) => response.json()),
        app.ask(LABEL_SOUTH, 'conv-south').then((response) => response.json()),
      ]);

      expect((granted as Record<string, unknown>).kind).not.toBe('unavailable');
      expect((denied as Record<string, unknown>).kind).toBe('unavailable');
      // Two credentials, two names, in whichever order they interleaved. One
      // token appearing twice would mean a request had been executed under
      // somebody else's identity while both were in flight.
      expect(new Set(calls.map((call) => call.token)).size).toBe(2);
      expect(new Set(calls.map((call) => call.expectedUser))).toEqual(new Set([LABEL_NORTH, LABEL_SOUTH]));
    } finally {
      await app.close();
    }
  });

  it('writes no assistant turn for the denied reader, so nothing carries into their next question', async () => {
    const { transport } = transportFor(() => Promise.reject(permissionDenied(PRIVATE_PRODUCT)));
    const app = await startApp(transport);

    try {
      await app.ask(LABEL_SOUTH, 'conv-south');
      const assistantTurns = recorded.filter(
        (entry) => entry.sql.startsWith('INSERT INTO player_insights.messages') && entry.params.includes('assistant')
      );
      expect(assistantTurns).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
