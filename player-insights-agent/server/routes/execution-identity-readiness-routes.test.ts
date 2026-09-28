import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupInsightsRoutes, type InsightsAppKit } from './insights-routes';

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('execution-identity readiness', () => {
  it('skips the serving probe when enforcement is off', async () => {
    const servingTransport = vi.fn(() => Promise.resolve({}));
    const app = express();
    app.use(express.json());
    await setupInsightsRoutes({
      lakebase: { query: () => Promise.resolve({ rows: [] as Record<string, unknown>[] }) },
      servingTransport,
      server: { extend: (register) => register(app) },
    } satisfies InsightsAppKit);
    const server = await listen(app);
    try {
      const internal = await fetch(server.url('/internal/readiness'));
      expect(internal.status).toBe(200);
      expect(await internal.json()).toMatchObject({
        check: 'execution-identity',
        ok: true,
        reason: 'enforcement_disabled',
      });
      expect(servingTransport).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('refuses Ask before any write when OBO is not wired', async () => {
    const previousEnforce = process.env.ENFORCE_IDENTITY_READINESS;
    const previousEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    process.env.ENFORCE_IDENTITY_READINESS = 'true';
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const askWrites: string[] = [];
    const servingTransport = vi.fn(() =>
      Promise.resolve({
        custom_outputs: { type: 'unavailable', code: 'IDENTITY_MISMATCH', message: 'no invoker token' },
      })
    );
    const app = express();
    app.use(express.json());
    await setupInsightsRoutes({
      lakebase: {
        query(sql: string) {
          if (/\b(conversations|messages)\b/i.test(sql) && /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
            askWrites.push(sql);
          }
          return Promise.resolve({ rows: [] as Record<string, unknown>[] });
        },
      },
      servingTransport,
      server: { extend: (register) => register(app) },
    } satisfies InsightsAppKit);
    const server = await listen(app);
    try {
      const ask = await fetch(server.url('/api/insights/ask'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: 'conv-identity', prompt: 'Show me the answer.' }),
      });
      expect(ask.status).toBe(401);
      expect(await ask.json()).toMatchObject({ type: 'unavailable', code: 'IDENTITY_REQUIRED' });
      expect(askWrites).toEqual([]);
      expect(servingTransport).toHaveBeenCalledTimes(1);
    } finally {
      process.env.ENFORCE_IDENTITY_READINESS = previousEnforce;
      process.env.DATABRICKS_SERVING_ENDPOINT_NAME = previousEndpoint;
      await server.close();
    }
  });
});
