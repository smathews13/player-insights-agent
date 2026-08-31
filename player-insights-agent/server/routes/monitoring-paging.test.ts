/** The bounded keyset contract for both Monitoring question lists. */
import { describe, expect, it, vi } from 'vitest';

import {
  MONITORING_QUESTIONS_QUERY,
  QUESTION_PAGE_SIZE,
  QUESTION_READ_LIMIT,
  monitoringCursor,
  pageFrom,
  setupMonitoringRoutes,
} from './monitoring-routes';
import type { InsightsAppKit } from './insights-routes';
import type { Application, Request, Response } from 'express';

function asked(query: Record<string, string>): Request {
  return { query, headers: {}, params: {}, header: () => undefined, get: () => undefined } as unknown as Request;
}

/** The list route, over a store that answers with nothing. */
function questionsRoute(path = '/api/monitoring/questions') {
  let handler: ((req: Request, res: Response) => Promise<void>) | null = null;
  const app = {
    get: (registered: string, fn: (req: Request, res: Response) => Promise<void>) => {
      if (registered === path) handler = fn;
    },
  } as unknown as Application;

  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  setupMonitoringRoutes(
    {
      lakebase: { query: () => Promise.resolve({ rows: [] }) },
      server: { extend: (fn: (target: Application) => void) => fn(app) },
    } as unknown as InsightsAppKit,
    { isAdminRoute: () => true, probeFor: () => null }
  );
  log.mockRestore();
  return handler as unknown as (req: Request, res: Response) => Promise<void>;
}

async function answerTo(path: string, query: Record<string, string>) {
  const handler = questionsRoute(path);
  let code = 200;
  let body: Record<string, unknown> = {};
  const res = {
    json: (payload: Record<string, unknown>) => {
      body = payload;
    },
    status: (given: number) => {
      code = given;
      return res;
    },
    setHeader: () => res,
  } as unknown as Response;
  await handler(asked({ ...query, email: 'someone@example.test' }), res);
  return { code, body };
}

describe('the stable Monitoring cursor', () => {
  it('refuses an offset and points callers at the opaque cursor', () => {
    const page = pageFrom(asked({ offset: '100' }));

    expect(page.refusal).not.toBe('');
    expect(page.refusal.toLowerCase()).toContain('cursor');
  });

  it('answers the request with that sentence rather than with a page', async () => {
    const refused = await answerTo('/api/monitoring/questions', { offset: '100' });

    expect(refused.code).toBe(400);
    expect(String(refused.body.error)).toContain('cursor');
  });

  it('refuses it on the per-person list too, which reads the same statement', async () => {
    const refused = await answerTo('/api/monitoring/people/:email', { offset: '100' });

    expect(refused.code).toBe(400);
  });

  /**
   * A garbled offset is not an attempt to page. `?offset=` from a form that
   * submitted an empty field must not turn a working list into a 400.
   */
  it('reads a missing, empty or unparseable offset as no offset at all', () => {
    const queries: Record<string, string>[] = [
      {},
      { offset: '' },
      { offset: '0' },
      { offset: 'later' },
      { offset: '-5' },
    ];
    for (const query of queries) {
      expect(pageFrom(asked(query)).refusal).toBe('');
      expect(pageFrom(asked(query)).cursor).toBeNull();
    }
  });

  /**
   * And the limit still works, because a single page has nothing to skip
   * BETWEEN: the tie only decides which of two same-instant rows sits on the
   * boundary, and the response already declares itself truncated.
   */
  it('defaults to 50 and bounds caller-provided page sizes', () => {
    expect(pageFrom(asked({})).limit).toBe(QUESTION_PAGE_SIZE);
    expect(pageFrom(asked({ limit: '50' }))).toEqual({ limit: 50, cursor: null, refusal: '' });
    expect(pageFrom(asked({ limit: '999999' })).limit).toBe(QUESTION_READ_LIMIT);
  });

  it('round-trips an opaque timestamp and id cursor', () => {
    const cursor = monitoringCursor('2026-08-15T10:00:00Z', 'question-17');
    expect(pageFrom(asked({ cursor }))).toEqual({
      limit: QUESTION_PAGE_SIZE,
      cursor: { askedAt: '2026-08-15T10:00:00.000Z', id: 'question-17' },
      refusal: '',
    });
  });

  it('rejects a malformed cursor instead of silently restarting at page one', () => {
    expect(pageFrom(asked({ cursor: 'not-a-cursor' })).refusal).toContain('invalid');
  });
});

describe('the keyset order', () => {
  it('orders equal timestamps by the question id', () => {
    const pageClause = MONITORING_QUESTIONS_QUERY.slice(
      MONITORING_QUESTIONS_QUERY.indexOf('WITH page AS'),
      MONITORING_QUESTIONS_QUERY.indexOf('range_totals AS')
    );
    const order = /ORDER BY([^\n]*)/.exec(pageClause)?.[1] ?? '';
    expect(order).toContain('u.created_at DESC');
    expect(order).toContain('u.id DESC');
    expect(pageClause).toContain('(u.created_at, u.id) < ($7::timestamptz, $8)');
  });
});
