import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeAskHasHealthyStream,
  CancelRunRefused,
  forgetActiveAsk,
  markActiveAskStreamActivity,
  markActiveAskStreamOpen,
  readActiveAsk,
  registerActiveAsk,
  resetActiveAsks,
  stopActiveAsk,
} from './ask-cancellation';

beforeEach(resetActiveAsks);

describe('the browser Stop controller', () => {
  it('records durable cancellation before aborting the local stream', async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      order.push('post');
      const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      expect(href).toBe('/api/runs/req-a%2Fb/cancel');
      expect(controller.signal.aborted).toBe(false);
      order.push('durable');
      return Promise.resolve(
        new Response(JSON.stringify({ targeted: 1, cancelled: 1, runIds: ['run-1'], failures: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }) as unknown as typeof fetch;
    controller.signal.addEventListener('abort', () => order.push('abort'));

    await stopActiveAsk({ correlationId: 'req-a/b', controller }, fetchImpl);

    expect(order).toEqual(['post', 'durable', 'abort']);
    expect(controller.signal.aborted).toBe(true);
  });

  it('does not turn a refused Stop into an ordinary disconnect', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'That run is no longer active.' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch;

    await expect(stopActiveAsk({ correlationId: 'req-1', controller }, fetchImpl)).rejects.toBeInstanceOf(
      CancelRunRefused
    );
    expect(controller.signal.aborted).toBe(false);
  });

  it('keeps cancellation handles scoped to their originating conversations', () => {
    const first = {
      conversationId: 'conversation-a',
      correlationId: 'run-a',
      controller: new AbortController(),
      stopRequested: false,
    };
    const second = {
      conversationId: 'conversation-b',
      correlationId: 'run-b',
      controller: new AbortController(),
      stopRequested: false,
    };
    registerActiveAsk(first);
    registerActiveAsk(second);

    expect(readActiveAsk('conversation-a')).toBe(first);
    expect(readActiveAsk('conversation-b')).toBe(second);

    forgetActiveAsk('conversation-a', first);
    expect(readActiveAsk('conversation-a')).toBeNull();
    expect(readActiveAsk('conversation-b')).toBe(second);
  });

  it('does not abort or forget a run when the view navigates away', () => {
    const active = {
      conversationId: 'conversation-a',
      correlationId: 'run-a',
      controller: new AbortController(),
      stopRequested: false,
    };
    registerActiveAsk(active);

    // Navigation only reads a different key. There is deliberately no global
    // cleanup API for the page to call on unmount.
    expect(readActiveAsk('conversation-b')).toBeNull();
    expect(readActiveAsk('conversation-a')).toBe(active);
    expect(active.controller.signal.aborted).toBe(false);
  });

  it('matches a healthy SSE stream to its exact run and expires it after missed heartbeats', () => {
    const active = {
      conversationId: 'conversation-a',
      correlationId: 'run-a',
      controller: new AbortController(),
      stopRequested: false,
      stream: {
        state: 'connecting' as const,
        openedAt: null,
        lastActivityAt: null,
      },
    };
    registerActiveAsk(active);
    expect(activeAskHasHealthyStream('conversation-a', 'run-a', 10_000)).toBe(false);

    markActiveAskStreamOpen(active, 10_000);
    expect(activeAskHasHealthyStream('conversation-a', 'run-a', 10_001)).toBe(true);
    expect(activeAskHasHealthyStream('conversation-a', 'different-run', 10_001)).toBe(false);

    markActiveAskStreamActivity(active, 25_000);
    expect(activeAskHasHealthyStream('conversation-a', 'run-a', 69_999)).toBe(true);
    expect(activeAskHasHealthyStream('conversation-a', 'run-a', 70_001)).toBe(false);
  });
});
