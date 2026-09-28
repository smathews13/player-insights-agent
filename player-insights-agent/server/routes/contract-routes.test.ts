import { describe, expect, it, vi } from 'vitest';
import type { Application, Response } from 'express';

import { isAdminRoute } from '../lib/admin-roles';
import type { InsightsAppKit } from './insights-routes';
import { buildContractComparison, CONTRACT_ROUTES, setupContractRoutes } from './contract-routes';

describe('contract observatory', () => {
  it('keeps every route under the admin guard', () => {
    expect(CONTRACT_ROUTES.filter((path) => !isAdminRoute(path))).toEqual([]);
  });

  it('compares the backend reference with schemas from the running frontend', () => {
    const payload = buildContractComparison([], '2026-09-24T20:00:00.000Z');
    expect(payload.generatedAt).toBe('2026-09-24T20:00:00.000Z');
    expect(payload.backend.revision).toBe('07f6ad75');
    expect(payload.backend.sections.find((section) => section.id === 'answer')?.fields).toContain('trace');
    expect(payload.frontend.sections.find((section) => section.id === 'answer')?.fields).toContain('schema_version');
    expect(payload.differences).toContainEqual({
      sectionId: 'answer',
      sectionLabel: 'Answer',
      field: 'schema_version',
      kind: 'frontend-only',
    });
    expect(payload.observedBackend.sections).toEqual([]);
    expect(payload.observedDifferences).toEqual([]);
  });

  it('lists schema refusals and undeclared fields without exposing answer contents', () => {
    const payload = buildContractComparison([
      {
        run_id: 'run-rejected',
        conversation_id: 'conv-1',
        trace_id: null,
        terminal_code: 'OUTPUT_SCHEMA_VIOLATION',
        created_at: '2026-09-24T19:00:00.000Z',
      },
      {
        run_id: 'run-drift',
        conversation_id: 'conv-2',
        trace_id: 'tr-1',
        terminal_code: null,
        message_id: 'msg-1',
        created_at: '2026-09-24T19:05:00.000Z',
        response_json: {
          takeaway: 'not returned by this API',
          trace: { id: 'tr-1', stages: [{ id: 'stage-1', future_stage_field: true }] },
          future_answer_field: true,
        },
      },
    ]);
    expect(payload.failures).toHaveLength(2);
    expect(payload.failures[0]).toMatchObject({
      runId: 'run-rejected',
      kind: 'schema-violation',
      fields: ['$payload'],
    });
    expect(payload.failures[1]).toMatchObject({
      runId: 'run-drift',
      kind: 'undeclared-fields',
      fields: ['future_answer_field', 'trace.stages[0].future_stage_field'],
    });
    expect(JSON.stringify(payload.failures)).not.toContain('not returned by this API');
    expect(payload.observedBackend.sections.find((section) => section.id === 'answer')?.fields).toContain(
      'future_answer_field'
    );
  });

  it('distinguishes persistence and readback failures without returning document content', () => {
    const payload = buildContractComparison([
      {
        run_id: 'run-missing-message',
        conversation_id: 'conv-1',
        terminal_message_id: 'msg-gone',
        message_id: null,
        created_at: '2026-09-24T18:00:00.000Z',
      },
      {
        run_id: 'run-missing-trace',
        conversation_id: 'conv-2',
        terminal_message_id: 'msg-dashboard',
        message_id: 'msg-dashboard',
        response_json: {
          type: 'dashboard',
          dashboard: { schema_version: 'pia.dashboard/1', title: 'Private title', html: '<html>private</html>' },
        },
      },
      {
        run_id: 'run-invalid-report',
        conversation_id: 'conv-3',
        terminal_message_id: 'msg-report',
        message_id: 'msg-report',
        response_json: {
          type: 'report',
          report: { schema_version: 'pia.report/1', title: '', sections: [] },
          trace: { id: 'tr-1', stages: [] },
        },
      },
      {
        run_id: 'run-unmeasured',
        conversation_id: 'conv-4',
        terminal_message_id: 'msg-unmeasured',
        message_id: 'msg-unmeasured',
        response_json: {
          type: 'report',
          report: { schema_version: 'pia.report/1', title: 'Private report', sections: [{ body: 'private' }] },
          trace: { id: 'tr-2', totalMs: 10, toolCalls: 1, stages: [{ id: 'orchestrator', status: 'complete' }] },
        },
      },
    ]);
    expect(payload.failures.map((failure) => failure.kind)).toEqual([
      'terminal-message-mismatch',
      'missing-stored-trace',
      'unreadable-stored-document',
      'token-evidence-missing',
    ]);
    expect(JSON.stringify(payload)).not.toContain('Private title');
    expect(JSON.stringify(payload)).not.toContain('<html>private</html>');
    expect(JSON.stringify(payload)).not.toContain('Private report');
  });

  it('registers only when the guard covers the route and returns a readable payload', async () => {
    let handler: ((req: unknown, res: Response) => Promise<void>) | undefined;
    const appkit = {
      lakebase: { query: vi.fn().mockResolvedValue({ rows: [] }) },
      server: {
        extend(register: (app: Application) => void) {
          register({
            get: (path: string, candidate: typeof handler) => {
              if (path === '/api/admin/contract') handler = candidate;
            },
          } as unknown as Application);
        },
      },
    } as unknown as InsightsAppKit;

    setupContractRoutes(appkit, { isAdminRoute });
    expect(handler).toBeTypeOf('function');
    let body: unknown;
    await handler?.({}, { json: (value: unknown) => (body = value) } as Response);
    expect(body).toMatchObject({ failureReadState: 'ready', failures: [] });
  });
});
