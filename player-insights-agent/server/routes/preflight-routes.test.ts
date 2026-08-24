import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  setupInsightsRoutes,
  type InsightsAppKit,
  type ServingTransport,
} from './insights-routes';
import { resetLakebaseHealth } from '../lib/lakebase-store';

/**
 * A Lakebase stand-in that really stores rows.
 *
 * Same principle as `memoryLakebase` in insights-routes.test.ts: a fake that
 * answers everything with zero rows makes a delete route untestable, because
 * "deleted nothing" and "deleted everything" look identical. This one is local
 * so the two files can be edited independently, and narrower: it only knows
 * the attachment lifecycle these tests exercise.
 */
function attachmentStore(seed: { conversation_id: string; user_email: string; filename: string }[] = []) {
  const rows = seed.map((row, index) => ({ id: `att-${index}`, extracted_text: `text of ${row.filename}`, ...row }));
  return {
    rows,
    failing: false,
    query(text: string, params: unknown[] = []) {
      if (this.failing) return Promise.reject(new Error('connection terminated unexpectedly'));
      const sql = text.replace(/\s+/g, ' ').trim();

      // Both delete routes now report what they actually removed, so they are told
      // apart by their predicate rather than by one of them lacking `RETURNING`.
      if (sql.startsWith('DELETE FROM player_insights.attachments')) {
        const doomed = sql.includes('WHERE id = $1')
          ? rows.filter((row) =>
                row.id === params[0] &&
                row.conversation_id === params[1] &&
                row.user_email === params[2]
            )
          : rows.filter((row) => row.conversation_id === params[0] && row.user_email === params[1]);
        for (const row of doomed) rows.splice(rows.indexOf(row), 1);
        return Promise.resolve({ rows: doomed.map((row) => ({ id: row.id })) });
      }

      if (sql.includes('FROM player_insights.attachments') && sql.includes('extracted_text')) {
        return Promise.resolve({
          rows: rows
            .filter((row) => row.conversation_id === params[0] && row.user_email === params[1])
            .map(({ filename, extracted_text }) => ({ filename, extracted_text })),
        });
      }

      if (sql.includes('FROM player_insights.attachments')) {
        return Promise.resolve({
          rows: rows.filter((row) => row.conversation_id === params[0] && row.user_email === params[1]),
        });
      }

      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
  };
}

async function startApp(
  transport: ServingTransport,
  lakebase: InsightsAppKit['lakebase'],
  servingEndpointReader: NonNullable<InsightsAppKit['servingEndpointReader']> = () =>
    Promise.resolve({ state: { ready: 'READY' } })
) {
  const app = express();
  app.use(express.json());
  await setupInsightsRoutes({
    lakebase,
    server: { extend: (fn) => fn(app) },
    servingTransport: transport,
    servingEndpointReader,
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

const AGENT_REPORT = {
  checked_at: '2026-08-04T18:00:00+00:00',
  status: 'failed',
  principal: '7f3c1a20-0000-4000-8000-abcdefabcdef',
  principal_resolved: true,
  table_source: 'declared',
  checks: [
    {
      id: 'identity',
      kind: 'identity',
      name: '7f3c1a20-0000-4000-8000-abcdefabcdef',
      label: 'Serving principal',
      status: 'ok',
      detail: 'Every check below ran as the serving principal.',
      checked_with: 'current_user.me()',
      duration_ms: 42,
      error: '',
      remedy: null,
    },
    {
      id: 'table-cat.sch.silver_gameplay_activity',
      kind: 'table',
      name: 'cat.sch.silver_gameplay_activity',
      label: 'Table · cat.sch.silver_gameplay_activity',
      status: 'failed',
      detail: 'The table is not visible to the serving principal.',
      checked_with: 'tables.get()',
      duration_ms: 310,
      error: 'PermissionDenied: does not have SELECT',
      remedy: {
        kind: 'sql',
        statement: 'GRANT SELECT ON TABLE `cat`.`sch`.`silver_gameplay_activity` TO `sp`;',
        note: 'Unity Catalog hides what it cannot traverse.',
      },
    },
  ],
  assumptions: ['Tables enumerated from the DatabricksTable resources declared at model-log time.'],
  counts: { ok: 1, failed: 1, unverified: 0 },
};

function reportingTransport(report: unknown, captured: Record<string, unknown>[] = []): ServingTransport {
  return ({ payload }) => {
    captured.push(JSON.parse(JSON.stringify(payload)) as Record<string, unknown>);
    return Promise.resolve({ custom_outputs: { type: 'preflight', preflight: report } });
  };
}

const noLakebase: InsightsAppKit['lakebase'] = { query: () => Promise.resolve({ rows: [] }) };

describe('GET /api/preflight', () => {
  // Lakebase health is process-wide, as it is in the running app. Resetting it
  // keeps each case describing one state rather than inheriting the last one's.
  beforeEach(() => resetLakebaseHealth());

  it('reads endpoint metadata without invoking the agent', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const captured: Record<string, unknown>[] = [];
    const app = await startApp(reportingTransport(AGENT_REPORT, captured), noLakebase);

    try {
      await fetch(app.url('/api/preflight'));
    } finally {
      await app.close();
    }

    expect(captured).toHaveLength(0);
  });

  it('reports endpoint visibility without claiming query permission', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startApp(reportingTransport(AGENT_REPORT), noLakebase);

    let body: Record<string, unknown>;
    let status: number;
    try {
      const response = await fetch(app.url('/api/preflight'));
      status = response.status;
      body = (await response.json()) as Record<string, unknown>;
    } finally {
      await app.close();
    }

    expect(status).toBe(200);
    expect(body.source).toBe('app');
    expect(body.principal).toBe('');
    expect(body.error).toBe('preflight_metadata_only');

    const checks = body.checks as { id: string; status: string; remedy: unknown; detail: string; checked_with: string }[];
    expect(checks[0]?.id).toBe('agent-endpoint');
    expect(checks[0]?.status).toBe('ok');
    expect(checks[0]?.checked_with).toContain('GET');
    expect(checks[0]?.detail).toContain('does not prove');
    expect(checks[0]?.remedy).toBeNull();
    expect(checks[1]?.id).toBe('lakebase-storage');
    expect(checks).toHaveLength(2);
    expect(body.counts).toEqual({ ok: 1, failed: 0, unverified: 1 });
    expect(body.status).toBe('unverified');
  });

  it('reports unverified, not ok, when the agent could not check something', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startApp(reportingTransport(AGENT_REPORT), noLakebase);

    let body: Record<string, unknown>;
    try {
      body = (await (await fetch(app.url('/api/preflight'))).json()) as Record<string, unknown>;
    } finally {
      await app.close();
    }

    expect(body.status).toBe('unverified');
    expect(body.counts).toEqual({ ok: 1, failed: 0, unverified: 1 });
  });

  it('answers an unreachable endpoint with 503 and the grant that would fix it', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    process.env.DATABRICKS_CLIENT_ID = '<app-service-principal-client-id>';
    const app = await startApp(
      () => Promise.resolve({}),
      noLakebase,
      () => Promise.reject(new Error('403 permission denied'))
    );

    let status: number;
    let body: Record<string, unknown>;
    try {
      const response = await fetch(app.url('/api/preflight'));
      status = response.status;
      body = (await response.json()) as Record<string, unknown>;
    } finally {
      await app.close();
    }

    expect(status).toBe(503);
    expect(body.error).toBe('preflight_unavailable');
    // Crucially not 'ok': one failed check and nothing claimed about the rest.
    expect(body.status).toBe('failed');
    // The storage check rides along even when the agent never answered, so the
    // page never omits Lakebase on precisely the reports where things are worst.
    expect(body.counts).toEqual({ ok: 0, failed: 1, unverified: 1 });
    const [check] = body.checks as { remedy: unknown }[];
    expect(check.remedy).toBeNull();
    expect(String(body.assumptions)).toContain('CAN_VIEW and CAN_QUERY');
  });

  it('does not tell an operator to re-log the model when the endpoint has retired the checks', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    // The endpoint now answers this request without a report, on every version.
    // The old branch read that as a model version predating preflight and told
    // the operator to log and deploy again, advice that cannot work, because
    // the newest version is the one that retired the report. An operator who
    // follows it re-logs, sees no change, and re-logs again.
    const app = await startApp(() => Promise.resolve({ output: [{ content: 'Here is your analysis.' }] }),
      noLakebase
    );

    let body: Record<string, unknown>;
    try {
      body = (await (await fetch(app.url('/api/preflight'))).json()) as Record<string, unknown>;
    } finally {
      await app.close();
    }

    expect(body.error).toBe('preflight_metadata_only');

    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('log_model.py');
    expect(serialised).not.toContain('deploy_agent.py');
    expect(serialised).not.toContain('predates preflight');
    // No remedy at all: there is nothing for anyone to go and fix.
    expect((body.checks as { remedy?: unknown }[]).some((check) => check.remedy)).toBe(false);
  });
});

// A named signed-in user, sent as the header Databricks Apps sets, rather than
// whoever the app would pick if the header were missing. These rows are owned by
// an identity, and the request has to present it to touch them. Shared by both
// delete routes below, which differ in scope but not in who may call them.
const owner = 'analyst@example.example';
const asOwner = { 'x-forwarded-email': owner };
const seed = [
  { conversation_id: 'conv-a', user_email: owner, filename: 'one.md' },
  { conversation_id: 'conv-a', user_email: owner, filename: 'two.pdf' },
  { conversation_id: 'conv-b', user_email: owner, filename: 'other.md' },
];

describe('DELETE /api/conversations/:id/attachments', () => {
  it('clears every attachment on the conversation and reports how many', async () => {
    const lakebase = attachmentStore(seed);
    const app = await startApp(() => Promise.resolve({}), lakebase);

    let body: Record<string, unknown>;
    try {
      const response = await fetch(app.url('/api/conversations/conv-a/attachments'), {
        method: 'DELETE',
        headers: asOwner,
      });
      body = (await response.json()) as Record<string, unknown>;
    } finally {
      await app.close();
    }

    expect(body).toEqual({ conversationId: 'conv-a', deleted: 2 });
    // Another conversation's documents are untouched.
    expect(lakebase.rows.map((row) => row.filename)).toEqual(['other.md']);
  });

  it('leaves the conversation itself alone, so clearing docs is not starting over', async () => {
    const lakebase = attachmentStore(seed);
    const captured: Record<string, unknown>[] = [];
    const app = await startApp(reportingTransport({}, captured), lakebase);

    try {
      await fetch(app.url('/api/conversations/conv-a/attachments'), { method: 'DELETE', headers: asOwner });
      await fetch(app.url('/api/insights/ask'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...asOwner },
        body: JSON.stringify({ conversationId: 'conv-a', prompt: 'And now without the report?' }),
      });
    } finally {
      await app.close();
    }

    const last = captured[captured.length - 1] ?? {};
    const customInputs = last.custom_inputs as Record<string, unknown>;
    // The conversation still asks; it just no longer carries the documents.
    expect(customInputs.conversation_id).toBe('conv-a');
    expect(customInputs.attachment_text).toBeUndefined();
  });

  it('reports a storage failure instead of a cheerful zero', async () => {
    const lakebase = attachmentStore(seed);
    lakebase.failing = true;
    const app = await startApp(() => Promise.resolve({}), lakebase);

    let status: number;
    let body: Record<string, unknown>;
    try {
      const response = await fetch(app.url('/api/conversations/conv-a/attachments'), {
        method: 'DELETE',
        headers: asOwner,
      });
      status = response.status;
      body = (await response.json()) as Record<string, unknown>;
    } finally {
      await app.close();
    }

    expect(status).toBe(503);
    expect(body.error).toBe('attachment_clear_failed');
    // The documents are still there, and the caller was told so.
    expect(lakebase.rows).toHaveLength(3);
  });

  it('does not shadow the single-attachment delete', async () => {
    const lakebase = attachmentStore(seed);
    const app = await startApp(() => Promise.resolve({}), lakebase);

    let status: number;
    try {
      const response = await fetch(app.url('/api/conversations/conv-a/attachments/att-0'), {
        method: 'DELETE',
        headers: asOwner,
      });
      status = response.status;
    } finally {
      await app.close();
    }

    expect(status).toBe(204);
    expect(lakebase.rows.map((row) => row.id)).not.toContain('att-0');
  });
});

/**
 * The bulk-clear route above already refused to answer an outage with a cheerful
 * zero. Its single-attachment sibling answered 204 to everything (deleted, never
 * there, someone else's, or Lakebase unreachable), while the client removes the
 * chip optimistically. During an outage the document left the screen and kept
 * reaching the agent on every following question.
 */
describe('DELETE /api/conversations/:id/attachments/:attachmentId', () => {
  it('reports an id it did not remove as missing rather than as success', async () => {
    const lakebase = attachmentStore(seed);
    const app = await startApp(() => Promise.resolve({}), lakebase);

    let status: number;
    let body: Record<string, unknown>;
    try {
      const response = await fetch(app.url('/api/conversations/conv-a/attachments/att-nope'), {
        method: 'DELETE',
        headers: asOwner,
      });
      status = response.status;
      body = (await response.json()) as Record<string, unknown>;
    } finally {
      await app.close();
    }

    expect(status).toBe(404);
    expect(body.error).toBe('attachment_not_found');
  });

  it("will not delete, or acknowledge, another user's attachment", async () => {
    const lakebase = attachmentStore(seed);
    const app = await startApp(() => Promise.resolve({}), lakebase);

    let status: number;
    try {
      const response = await fetch(app.url('/api/conversations/conv-a/attachments/att-0'), {
        method: 'DELETE',
        headers: { 'x-forwarded-email': 'someone.else@example.example' },
      });
      status = response.status;
    } finally {
      await app.close();
    }

    // 404, not 403: which of "no such id" and "not yours" it is stays private.
    expect(status).toBe(404);
    expect(lakebase.rows.map((row) => row.id)).toContain('att-0');
  });

  it('reports an outage instead of pretending the document is gone', async () => {
    const lakebase = attachmentStore(seed);
    lakebase.failing = true;
    const app = await startApp(() => Promise.resolve({}), lakebase);

    let status: number;
    let body: Record<string, unknown>;
    try {
      const response = await fetch(app.url('/api/conversations/conv-a/attachments/att-0'), {
        method: 'DELETE',
        headers: asOwner,
      });
      status = response.status;
      body = (await response.json()) as Record<string, unknown>;
    } finally {
      await app.close();
    }

    expect(status).toBe(503);
    expect(body.error).toBe('attachment_delete_failed');
    // Still attached, and the message says so rather than leaving the caller to
    // find out on their next question.
    expect(String(body.message)).toContain('still reach the agent');
    expect(lakebase.rows.map((row) => row.id)).toContain('att-0');
  });
});
