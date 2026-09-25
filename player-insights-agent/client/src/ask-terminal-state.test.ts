import { describe, expect, it } from 'vitest';

import { terminalSettlementForResponse } from './ask-terminal-state';
import type { ClarificationResponse, DashboardResponse, PlanResponse, ReportResponse } from './app-types';

describe('SSE terminal response projection', () => {
  it('parks an approval response without leaving it Live', () => {
    const plan: PlanResponse = {
      type: 'plan',
      mode: 'live',
      plan: {
        id: 'plan-1',
        question: 'Compare titles',
        summary: 'Review the comparison plan.',
        steps: [],
        requires_approval: true,
        uses_conversation_context: false,
        uses_attachment_context: false,
      },
    };

    expect(terminalSettlementForResponse(plan, plan)).toEqual({ state: 'AWAITING_APPROVAL' });
  });

  it('matches a clarification to its persisted message id', () => {
    const clarification: ClarificationResponse = {
      type: 'clarification',
      mode: 'live',
      clarification: {
        id: 'clarification-1',
        question: 'Which period?',
        options: ['Last week'],
        trace: { id: 'tr-1234567890abcdef', totalMs: 42, toolCalls: 0, stages: [] },
      },
    };

    expect(terminalSettlementForResponse(clarification, clarification)).toMatchObject({
      state: 'CLARIFICATION_REQUIRED',
      terminalMessageId: 'msg-clarification-1',
      summary: { runId: 'msg-clarification-1', status: 'Partial' },
    });
  });

  it('settles a report as a complete persisted response', () => {
    const report: ReportResponse = {
      type: 'report',
      mode: 'live',
      id: 'msg-report-1',
      report: {
        schema_version: 'pia.report/1',
        title: 'Player report',
        sections: [{ body: 'A complete report.' }],
      },
    };

    expect(terminalSettlementForResponse(report, { ...report, trace: { totalMs: 214_300 } })).toMatchObject({
      state: 'SUCCEEDED',
      terminalMessageId: 'msg-report-1',
      summary: { runId: 'msg-report-1', status: 'Complete', durationMs: 214_300 },
    });
  });

  it('settles a dashboard as a complete persisted response', () => {
    const dashboard: DashboardResponse = {
      type: 'dashboard',
      mode: 'live',
      id: 'msg-dashboard-1',
      dashboard: {
        schemaVersion: 'pia.dashboard/1',
        title: 'Player dashboard',
        html: '<!DOCTYPE html><html><body>Players</body></html>',
      },
    };
    expect(
      terminalSettlementForResponse(dashboard, {
        runStored: true,
        trace: { totalMs: 324_600 },
      })
    ).toEqual({
      state: 'SUCCEEDED',
      terminalMessageId: 'msg-dashboard-1',
      summary: {
        runId: 'msg-dashboard-1',
        status: 'Complete',
        tone: 'ast-pill--pos',
        durationMs: 324_600,
        feedback: null,
        truncated: false,
      },
    });
  });

  it('keeps a document duration absent when the raw trace is missing or malformed', () => {
    const dashboard: DashboardResponse = {
      type: 'dashboard',
      mode: 'live',
      id: 'msg-dashboard-2',
      dashboard: {
        schemaVersion: 'pia.dashboard/1',
        title: 'Player dashboard',
        html: '<!DOCTYPE html><html><body>Players</body></html>',
      },
    };
    expect(terminalSettlementForResponse(dashboard, { trace: { totalMs: '324600' } }).summary?.durationMs).toBeNull();
  });

  it.each([
    ['failed', 'Failed', 'ast-pill--neg'],
    ['partial', 'Partial', 'ast-pill--warn'],
  ] as const)('keeps a %s document stage consistent with stored run verdicts', (stageStatus, label, tone) => {
    const report: ReportResponse = {
      type: 'report',
      mode: 'live',
      id: 'msg-report-stage',
      report: {
        schema_version: 'pia.report/1',
        title: 'Player report',
        sections: [{ body: 'A report whose run did not finish cleanly.' }],
      },
    };
    expect(
      terminalSettlementForResponse(report, {
        trace: {
          totalMs: 10_000,
          stages: [{ id: 'report-render', status: stageStatus }],
        },
      }).summary
    ).toMatchObject({ status: label, tone, durationMs: 10_000 });
  });
});
