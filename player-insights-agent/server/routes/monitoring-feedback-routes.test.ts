import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { MONITORING_FEEDBACK_PAGE_SIZE } from '../../shared/monitoring-feedback-contract';
import { isAdminRoute } from '../lib/admin-roles';
import { LATER_MIGRATIONS } from '../lib/migrations';
import {
  MONITORING_FEEDBACK_PAGE_MAX,
  MONITORING_FEEDBACK_QUERY,
  MONITORING_FEEDBACK_ROUTE,
  MONITORING_FEEDBACK_SEARCH_MAX,
  monitoringFeedbackCursor,
  monitoringFeedbackRequest,
  monitoringFeedbackRow,
  setupMonitoringFeedbackRoutes,
} from './monitoring-feedback-routes';

function request(query: Record<string, string> = {}): Pick<Request, 'query'> {
  return { query };
}

describe('Monitoring feedback request bounds', () => {
  it('uses feedback time, a stable tuple cursor, and a bounded page', () => {
    const cursor = monitoringFeedbackCursor('2026-09-02T10:00:00Z', 'feedback-9');
    const parsed = monitoringFeedbackRequest(
      request({
        from: '2026-09-01T00:00:00Z',
        to: '2026-09-03T00:00:00Z',
        limit: '900',
        cursor,
      })
    );

    expect(parsed.from).toBe('2026-09-01T00:00:00.000Z');
    expect(parsed.to).toBe('2026-09-03T00:00:00.000Z');
    expect(parsed.limit).toBe(MONITORING_FEEDBACK_PAGE_MAX);
    expect(parsed.cursor).toEqual({ feedbackAt: '2026-09-02T10:00:00.000Z', id: 'feedback-9' });
  });

  it('defaults every feedback page to five rows', () => {
    expect(MONITORING_FEEDBACK_PAGE_SIZE).toBe(5);
    expect(monitoringFeedbackRequest(request()).limit).toBe(MONITORING_FEEDBACK_PAGE_SIZE);
  });

  it('refuses offsets, invalid cursors, unknown filters, and overlong search', () => {
    expect(monitoringFeedbackRequest(request({ offset: '2' })).error).toContain('opaque cursor');
    expect(monitoringFeedbackRequest(request({ cursor: 'not-a-cursor' })).error).toContain('invalid');
    expect(monitoringFeedbackRequest(request({ feedback: 'stars' })).error).toContain('up or down');
    expect(monitoringFeedbackRequest(request({ role: 'owner' })).error).toContain('Role must');
    expect(monitoringFeedbackRequest(request({ q: 'x'.repeat(MONITORING_FEEDBACK_SEARCH_MAX + 1) })).error).toContain(
      `${MONITORING_FEEDBACK_SEARCH_MAX}`
    );
  });
});

describe('Monitoring feedback SQL truth', () => {
  it('ships the matching feedback submission keyset index', () => {
    const migration = LATER_MIGRATIONS.find((entry) => entry.version === 37);
    expect(migration?.name).toBe('feedback corpus keyset index');
    expect(migration?.statements.join('\n')).toContain('(created_at DESC, id DESC)');
  });

  it('filters and pages on submission time with parameterized predicates', () => {
    expect(MONITORING_FEEDBACK_QUERY).toContain('f.created_at >= $1::timestamptz');
    expect(MONITORING_FEEDBACK_QUERY).toContain('f.created_at < $2::timestamptz');
    expect(MONITORING_FEEDBACK_QUERY).toContain('(feedback_at, feedback_id) < ($4::timestamptz, $5)');
    expect(MONITORING_FEEDBACK_QUERY).toContain('ORDER BY feedback_at DESC, feedback_id DESC');
    expect(MONITORING_FEEDBACK_QUERY).toContain('LIMIT $3');
    expect(MONITORING_FEEDBACK_QUERY).not.toMatch(/OFFSET|billing|cost/i);
  });

  it('pairs the answer to a real question and returns only submitted thumbs', () => {
    expect(MONITORING_FEEDBACK_QUERY).toContain("answer.role = 'assistant'");
    expect(MONITORING_FEEDBACK_QUERY).toContain("q.role = 'user'");
    expect(MONITORING_FEEDBACK_QUERY).toContain('q.content <> $12');
    expect(MONITORING_FEEDBACK_QUERY).toContain("direction IN ('up', 'down')");
  });

  it('combines question, user, comment, direction, role, persona, and organization filters', () => {
    for (const parameter of ['$6', '$7', '$8', '$9', '$10', '$11']) {
      expect(MONITORING_FEEDBACK_QUERY).toContain(parameter);
    }
    expect(MONITORING_FEEDBACK_QUERY).toContain("CASE WHEN direction = 'down' THEN COALESCE(comment, '')");
    expect(MONITORING_FEEDBACK_QUERY).toContain('COUNT(*) FILTER');
    expect(MONITORING_FEEDBACK_QUERY).toMatch(
      /COUNT\(\*\) FILTER \(\s*WHERE direction = 'down' AND comment IS NOT NULL AND btrim\(comment\) <> ''\s*\)/
    );
    expect(MONITORING_FEEDBACK_QUERY).toContain('FROM filtered');
  });

  it('joins role and persona evidence without starting from the account roster', () => {
    expect(MONITORING_FEEDBACK_QUERY).toContain('player_insights.feedback f');
    expect(MONITORING_FEEDBACK_QUERY).toContain('LEFT JOIN player_insights.admin_emails roster');
    expect(MONITORING_FEEDBACK_QUERY).toContain('LEFT JOIN player_insights.sp_assignments assignment');
    expect(MONITORING_FEEDBACK_QUERY.indexOf('player_insights.feedback f')).toBeLessThan(
      MONITORING_FEEDBACK_QUERY.indexOf('player_insights.admin_emails roster')
    );
  });
});

describe('Monitoring feedback row shaping', () => {
  const base = {
    feedback_id: 'feedback-1',
    answer_id: 'answer-1',
    feedback_user: 'PERSON@EXAMPLE.COM',
    feedback_at: '2026-09-02T10:00:00Z',
    direction: 'down',
    comment: '<b>Exact words stay text.</b>',
    conversation_id: 'conversation-1',
    question_id: 'question-1',
    question: 'What changed?',
    asked_at: '2026-09-01T09:00:00Z',
    user_role: 'admin',
    persona_id: 'finance',
    persona_name: 'Finance',
  };

  it('preserves written down-feedback exactly and safely as a string', () => {
    expect(monitoringFeedbackRow(base)).toMatchObject({
      id: 'feedback-1',
      questionId: 'question-1',
      userEmail: 'person@example.com',
      feedback: 'down',
      comment: '<b>Exact words stay text.</b>',
      submittedAt: '2026-09-02T10:00:00.000Z',
    });
  });

  it('never exposes a stale comment on helpful feedback', () => {
    expect(monitoringFeedbackRow({ ...base, direction: 'up', comment: 'old negative reason' })?.comment).toBeNull();
    expect(monitoringFeedbackRow({ ...base, direction: null })).toBeNull();
  });
});

describe('Monitoring feedback route', () => {
  it('is covered by the existing Admin, Owner, and Super Admin server boundary', () => {
    expect(MONITORING_FEEDBACK_ROUTE).toBe('/api/monitoring/feedback');
    expect(isAdminRoute(MONITORING_FEEDBACK_ROUTE)).toBe(true);
  });

  it('binds every filter and returns counts from the same filtered corpus', async () => {
    let handler: ((req: Request, res: Response) => Promise<void>) | undefined;
    const query = vi.fn((_sql: string, _params?: unknown[]) =>
      Promise.resolve({
        rows: [
          {
            total_feedback: 1,
            helpful_feedback: 0,
            not_helpful_feedback: 1,
            comments_captured: 1,
            data_revision: 'rev-1',
            identity_revision: 'identity-1',
            user_options: [],
            role_options: [],
            persona_options: [],
            organization_options: [],
            feedback_id: 'feedback-1',
            answer_id: 'answer-1',
            feedback_user: 'person@example.com',
            feedback_at: '2026-09-02T10:00:00Z',
            direction: 'down',
            comment: 'Missing detail.',
            conversation_id: 'conversation-1',
            question_id: 'question-1',
            question: 'Question?',
            asked_at: '2026-09-02T09:59:00Z',
            user_role: 'consumer',
          },
        ],
      })
    );
    const appkit = {
      lakebase: { query },
      server: {
        extend(register: (app: { get(path: string, route: typeof handler): void }) => void) {
          register({
            get(path, route) {
              expect(path).toBe(MONITORING_FEEDBACK_ROUTE);
              handler = route;
            },
          });
        },
      },
    } as never;
    setupMonitoringFeedbackRoutes(appkit, { isAdminRoute, now: () => Date.parse('2026-09-03T00:00:00Z') });
    let responseBody: unknown;
    const body = vi.fn((value: unknown) => {
      responseBody = value;
    });
    const status = vi.fn(() => ({ json: body }));
    const res = {
      headersSent: false,
      once: vi.fn(),
      off: vi.fn(),
      setHeader: vi.fn(),
      json: body,
      status,
    } as never;
    const req = {
      query: {
        from: '2026-09-01T00:00:00Z',
        to: '2026-09-03T00:00:00Z',
        q: 'detail',
        feedback: 'down',
        user: 'person@example.com',
        role: 'consumer',
        persona: 'finance',
        organization: 'example.com',
      },
      once: vi.fn(),
      off: vi.fn(),
    } as never;

    await handler?.(req, res);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([
      '2026-09-01T00:00:00.000Z',
      '2026-09-03T00:00:00.000Z',
      MONITORING_FEEDBACK_PAGE_SIZE + 1,
      '',
      '',
      'detail',
      'down',
      'person@example.com',
      'consumer',
      'finance',
      'example.com',
      'Approved the proposed analysis plan.',
    ]);
    expect(responseBody).toMatchObject({
      summary: { total: 1, helpful: 0, notHelpful: 1, comments: 1 },
      pagination: { total: 1 },
    });
  });
});
