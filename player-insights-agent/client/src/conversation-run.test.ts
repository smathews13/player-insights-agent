import { describe, expect, it, vi } from 'vitest';
import { isWorkingConversationRun, readConversationRun, replayedStages } from './conversation-run';

describe('durable conversation run status', () => {
  it.each(['RECEIVED', 'PLANNING', 'RUNNING', 'SYNTHESIZING'])(
    'keeps a reopened conversation working while its run is %s',
    (state) => {
      expect(
        isWorkingConversationRun({
          run_id: 'run-1',
          state,
          created_at: '2026-08-19T12:00:00Z',
          updated_at: '2026-08-19T12:00:01Z',
          terminal_code: null,
        })
      ).toBe(true);
    }
  );

  it('does not call a plan waiting for approval active work', () => {
    expect(
      isWorkingConversationRun({
        run_id: 'run-1',
        state: 'AWAITING_APPROVAL',
        created_at: '2026-08-19T12:00:00Z',
        updated_at: '2026-08-19T12:00:01Z',
        terminal_code: null,
      })
    ).toBe(false);
  });

  it('reads status without attaching a cancellation signal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          run_id: 'run-1',
          state: 'RUNNING',
          created_at: '2026-08-19T12:00:00Z',
          updated_at: '2026-08-19T12:00:01Z',
          terminal_code: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(readConversationRun('conv/a', fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({
      state: 'RUNNING',
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/conversations/conv%2Fa/run');
  });
});

/**
 * The steps a reconnect carries, which is the half the status alone could not
 * report. Without them a reopened working conversation showed the question, a
 * composer shut because a run was in flight, and an empty agent path.
 */
describe('the steps a durable run reports', () => {
  const working = {
    run_id: 'run-1',
    state: 'RUNNING',
    created_at: '2026-08-19T12:00:00Z',
    updated_at: '2026-08-19T12:00:09Z',
    terminal_code: null,
  };

  it('brings the run’s own steps up to the shape the rail draws', () => {
    const stages = replayedStages({
      ...working,
      stages: [
        {
          id: 'step-1',
          name: 'Chose the next step',
          kind: 'agent',
          status: 'complete',
          start: 0,
          duration: 1_829,
          calls: 1,
        },
        {
          id: 'inventory',
          name: 'Listed available tables',
          kind: 'discovery',
          status: 'complete',
          start: 1_829,
          duration: 1,
          calls: 1,
          tables: ['<your_catalog>.<your_schema>.gold_title_daily'],
        },
      ],
    });

    expect(stages.map((stage) => stage.id)).toEqual(['step-1', 'inventory']);
    expect(stages[1].status).toBe('complete');
    expect(stages[1].tables).toEqual(['<your_catalog>.<your_schema>.gold_title_daily']);
    // Normalized through the same function the stream uses, so a replayed step
    // and a streamed one are the same object to every surface below.
    expect(stages[0].startMeasured).toBe(true);
    expect(stages[0].output).toBe('Prepared assessed findings from governed sources.');
  });

  it('reports no steps rather than failing when the run carries none', () => {
    // Three real cases and all three are "nothing to draw": a run polled before
    // its first step, a turn that answers with a plan, and a run older than the
    // narration being stored at all.
    expect(replayedStages(working)).toEqual([]);
    expect(replayedStages({ ...working, stages: null })).toEqual([]);
    expect(replayedStages(null)).toEqual([]);
  });
});
