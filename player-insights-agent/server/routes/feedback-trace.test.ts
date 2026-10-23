/**
 * A rating made in the app reaches the MLflow trace of the turn it rates, after
 * it is stored, and a failed copy never changes what the user was told.
 */
import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MlflowRequest } from '../lib/trace-feedback';
import { setupInsightsRoutes, type InsightsAppKit } from './insights-routes';

const TRACE = 'tr-0123456789abcdef0123456789abcdef';

function ratingStore(traceId: string | null) {
  return {
    query(sql: string) {
      if (/INSERT INTO player_insights\.feedback/i.test(sql)) return Promise.resolve({ rows: [{ id: 'fb' }] });
      if (/SELECT trace_id FROM player_insights\.messages/i.test(sql)) {
        return Promise.resolve({ rows: traceId ? [{ trace_id: traceId }] : [] });
      }
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
  };
}

async function startApp(lakebase: InsightsAppKit['lakebase'], transport: (request: MlflowRequest) => Promise<unknown>) {
  const app = express();
  app.use(express.json());
  await setupInsightsRoutes(
    {
      lakebase,
      server: { extend: (fn) => fn(app) },
      servingTransport: () => Promise.reject(new Error('not used')),
    },
    { traceFeedbackTransport: transport }
  );
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    rate: (body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${port}/api/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-email': 'analyst@example.com' },
        body: JSON.stringify(body),
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

const savedSecret = process.env.DATABRICKS_CLIENT_SECRET;
beforeEach(() => {
  process.env.DATABRICKS_CLIENT_SECRET = 'test-secret';
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.DATABRICKS_CLIENT_SECRET;
  else process.env.DATABRICKS_CLIENT_SECRET = savedSecret;
});

describe('POST /api/feedback copies the rating onto its trace', () => {
  it('writes one assessment, with no email in it, after the rating is stored', async () => {
    const requests: MlflowRequest[] = [];
    const app = await startApp(ratingStore(TRACE), (request) => {
      requests.push(request);
      return Promise.resolve({});
    });
    try {
      const response = await app.rate({ messageId: 'msg-1', sentiment: 'down', comment: 'Wrong month' });
      expect(response.status).toBe(201);
      await settle();
    } finally {
      await app.close();
    }
    const writes = requests.filter((request) => request.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(`/api/3.0/mlflow/traces/${TRACE}/assessments`);
    expect(writes[0].body).toMatchObject({ assessment: { feedback: { value: false }, rationale: 'Wrong month' } });
    expect(JSON.stringify(writes[0].body)).not.toContain('analyst');
  });

  it('still answers 201 when MLflow refuses the copy', async () => {
    const app = await startApp(ratingStore(TRACE), () => Promise.reject(new Error('PERMISSION_DENIED')));
    try {
      const response = await app.rate({ messageId: 'msg-1', sentiment: 'up' });
      expect(response.status).toBe(201);
      await settle();
    } finally {
      await app.close();
    }
  });

  it('writes nothing for a turn with no MLflow trace', async () => {
    const requests: MlflowRequest[] = [];
    const app = await startApp(ratingStore(null), (request) => {
      requests.push(request);
      return Promise.resolve({});
    });
    try {
      expect((await app.rate({ messageId: 'bench-1', sentiment: 'up' })).status).toBe(201);
      await settle();
    } finally {
      await app.close();
    }
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });
});
