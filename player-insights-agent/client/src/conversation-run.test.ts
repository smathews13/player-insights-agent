import { describe, expect, it, vi } from 'vitest';
import { isWorkingConversationRun, readConversationRun } from './conversation-run';

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
