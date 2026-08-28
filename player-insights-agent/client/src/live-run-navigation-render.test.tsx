import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  settleActiveConversationRun,
  trackActiveConversationRun,
  type ActiveConversationRuns,
} from './active-conversation-runs';
import { AnswerCard } from './AnswerCard';
import { normalizeAnswer, type TraceStage, type WireAnswer } from './answer-shape';
import { ConversationRailRunStatus } from './ConversationRailRunStatus';
import { LiveProgress } from './LiveProgress';
import { PayloadView, TraceTimeline } from './TraceTimeline';
import type { ConversationRunStatus } from './conversation-run';
import type { Answer } from './app-types';
import { EMPTY_FEEDBACK } from './stored-feedback';

const TABLE = '<your_catalog>.<your_schema>.gold_title_daily_summary';

function stage(number: number, status: TraceStage['status'] = 'complete'): TraceStage {
  return {
    id: number === 11 ? 'step-11-1-describe_table' : `step-${number}`,
    name: number === 11 ? `Read the columns of ${TABLE}` : `Step ${number}`,
    kind: number === 11 ? 'tool' : 'agent',
    start: number * 100,
    duration: status === 'running' ? 0 : 100,
    status,
    calls: 1,
    input: number === 11 ? JSON.stringify({ full_name: TABLE }) : '',
    output: number === 11 ? `Columns returned for ${TABLE}; request_id was omitted.` : '',
    startMeasured: true,
  };
}

function running(stages: TraceStage[]): ConversationRunStatus {
  return {
    run_id: 'run-live',
    state: 'RUNNING',
    created_at: '2026-08-27T20:00:00Z',
    updated_at: '2026-08-27T20:00:11Z',
    terminal_code: null,
    stages,
  };
}

function rail(runs: ActiveConversationRuns, stages: TraceStage[]): string {
  return renderToStaticMarkup(
    <ConversationRailRunStatus
      run={runs.get('conversation-live') ?? null}
      stages={stages}
      streamed={false}
      fallback={{
        runId: 'old-answer',
        status: 'Failed',
        tone: 'ast-pill--neg',
        durationMs: 100,
        rating: null,
        truncated: false,
      }}
    />
  );
}

describe('a live rail card across navigation and stale background reads', () => {
  it('holds Live at step 11 until the exact terminal ledger answer settles it once', () => {
    const throughEleven = Array.from({ length: 11 }, (_, index) =>
      stage(index + 1, index === 10 ? 'running' : 'complete')
    );
    let runs = trackActiveConversationRun(new Map(), 'conversation-live', running(throughEleven));

    const beforeNavigation = rail(runs, throughEleven);
    expect(beforeNavigation).toContain('Live · step 11');
    expect(beforeNavigation).not.toContain('Failed');

    // Another conversation/surface is now selected. A missing read and a rejected
    // read perform no mutation; a stale replay with only five steps is folded in
    // without taking the frontier backwards.
    const afterMissingRead = runs;
    const afterFailedRead = afterMissingRead;
    runs = trackActiveConversationRun(afterFailedRead, 'conversation-live', {
      ...running(throughEleven.slice(0, 5)),
      updated_at: '2026-08-27T20:00:05Z',
    });
    const retainedStages = (runs.get('conversation-live')?.status.stages ?? []) as TraceStage[];
    expect(retainedStages).toHaveLength(11);
    expect(rail(runs, retainedStages)).toContain('Live · step 11');

    const terminal = {
      ...running(throughEleven.map((entry) => ({ ...entry, status: 'complete' as const }))),
      state: 'SUCCEEDED',
      updated_at: '2026-08-27T20:01:00Z',
      terminal_message_id: 'answer-live',
    };
    // Terminal state with a missing or stale summary is deliberately not enough.
    expect(settleActiveConversationRun(runs, 'conversation-live', terminal, null)).toBe(runs);
    expect(
      settleActiveConversationRun(runs, 'conversation-live', terminal, {
        runId: 'old-answer',
        status: 'Failed',
        tone: 'ast-pill--neg',
        durationMs: 100,
        rating: null,
        truncated: false,
      })
    ).toBe(runs);
    expect(rail(runs, retainedStages)).toContain('Live · step 11');

    const settled = settleActiveConversationRun(runs, 'conversation-live', terminal, {
      runId: 'answer-live',
      status: 'Complete',
      tone: 'ast-pill--pos',
      durationMs: 60_000,
      rating: null,
      truncated: false,
    });
    expect(rail(settled, retainedStages)).toContain('Complete');
    expect(rail(settled, retainedStages)).not.toContain('Live');
    // A duplicate poll cannot announce or apply the terminal transition again.
    expect(
      settleActiveConversationRun(settled, 'conversation-live', terminal, settled.get('conversation-live')?.summary)
    ).toBe(settled);
  });

  it.each([
    { state: 'AWAITING_APPROVAL', terminal_message_id: null, summary: null, label: 'Approval needed' },
    {
      state: 'SUCCEEDED',
      terminal_message_id: 'answer-live',
      summary: {
        runId: 'answer-live',
        status: 'Partial',
        tone: 'ast-pill--warn' as const,
        durationMs: 60_000,
        rating: null,
        truncated: true,
      },
      label: 'Partial',
    },
    { state: 'FAILED', terminal_message_id: null, summary: null, label: 'Failed' },
    { state: 'CANCELLED', terminal_message_id: null, summary: null, label: 'Stopped' },
  ])('renders $label only after its durable $state state', ({ state, terminal_message_id, summary, label }) => {
    const stages = [stage(11, 'running')];
    const live = trackActiveConversationRun(new Map(), 'conversation-live', running(stages));
    const terminal = {
      ...running([{ ...stages[0], status: 'complete' as const }]),
      state,
      terminal_message_id,
      updated_at: '2026-08-27T20:01:00Z',
    };

    expect(rail(live, stages)).toContain('Live');
    const settled = settleActiveConversationRun(live, 'conversation-live', terminal, summary);
    expect(rail(settled, stages)).toContain(label);
    expect(rail(settled, stages)).not.toContain('Live');
    expect(settleActiveConversationRun(settled, 'conversation-live', terminal, summary)).toBe(settled);
  });

  it('returns a parked plan to Live when approval resumes the same run', () => {
    const stages = [stage(3, 'complete')];
    const live = trackActiveConversationRun(new Map(), 'conversation-live', running(stages));
    const waiting = {
      ...running(stages),
      state: 'AWAITING_APPROVAL',
      updated_at: '2026-08-27T20:00:10Z',
    };
    const parked = settleActiveConversationRun(live, 'conversation-live', waiting, null);
    expect(rail(parked, stages)).toContain('Approval needed');

    const resumed = trackActiveConversationRun(parked, 'conversation-live', {
      ...running(stages),
      updated_at: '2026-08-27T20:00:20Z',
    });
    expect(rail(resumed, stages)).toContain('Live · step 01');
    expect(rail(resumed, stages)).not.toContain('Approval needed');
  });
});

describe('table pills in every rendered live-run seating', () => {
  const described = stage(11, 'running');
  const inventory: TraceStage = {
    ...stage(3),
    id: 'inventory',
    name: 'Listed available tables',
    kind: 'discovery',
    input: '{}',
    output: `Declared tables:\n  - ${TABLE}  [franchise: Contoso]`,
    tables: [TABLE],
  };

  function expectTablePill(markup: string) {
    expect(markup).toContain('entity-table-mark');
    expect(markup).toContain('data-entity-part="catalog"');
    expect(markup).toContain('data-entity-part="schema"');
    expect(markup).toContain('data-entity-part="table"');
    expect(markup).not.toMatch(/entity-(?:table-mark|token)[^>]*>request_id/);
  }

  it('renders the streaming HomePage progress description with shared entity parts', () => {
    expectTablePill(
      renderToStaticMarkup(<LiveProgress stages={[described]} openedAt={1} question="Inspect the table" />)
    );
  });

  it('renders every discovered table during the live run instead of the empty argument object', () => {
    const markup = renderToStaticMarkup(
      <LiveProgress stages={[inventory]} openedAt={1} question="What data is available?" />
    );
    expectTablePill(markup);
    expect(markup).toContain('1</span> table assessed');
    expect(markup).toContain('gold_title_daily_summary');
    expect(markup).not.toContain('{}');
  });

  it('renders an explicit no-table result when discovery returned none', () => {
    const markup = renderToStaticMarkup(
      <LiveProgress
        stages={[{ ...inventory, output: '(no tables were declared with this model)', tables: [] }]}
        openedAt={1}
        question="What data is available?"
      />
    );
    expect(markup).toContain('No tables were returned by this discovery step.');
    expect(markup).not.toContain('{}');
  });

  it('renders the live TraceTimeline event through the same entity renderer', () => {
    expectTablePill(
      renderToStaticMarkup(<TraceTimeline trace={{ id: 'tr-live', totalMs: 100, stages: [described] }} />)
    );
  });

  it('renders a timeline tool-detail line without styling a non-table identifier', () => {
    const markup = renderToStaticMarkup(
      <PayloadView text={`Read the columns of ${TABLE}; request_id was omitted.`} tables={[TABLE]} />
    );
    expectTablePill(markup);
    expect(markup).toContain('request_id');
    expect(markup).not.toMatch(/entity-(?:table-mark|token)[^>]*>request_id/);
  });

  it('keeps the same live-stage treatment when the process is seated in AnswerCard', () => {
    const answer = normalizeAnswer({
      id: 'answer-live',
      mode: 'live',
      takeaway: 'The table was inspected.',
      narrative: 'The requested metadata was returned.',
      figures: [],
      sources: [{ name: TABLE, freshness: 'live' }],
      caveats: [],
      sql: '',
      trace: { id: 'tr-deadbeef', totalMs: 100, toolCalls: 1, stages: [described] },
    } as WireAnswer) as Answer;
    const markup = renderToStaticMarkup(
      <AnswerCard
        answer={answer}
        feedback={EMPTY_FEEDBACK}
        onFeedbackChange={() => {}}
        saveFeedback={async () => {}}
        showFeedback={false}
      />
    );
    expect(markup).toContain('Run process');
    expectTablePill(markup);
  });
});
