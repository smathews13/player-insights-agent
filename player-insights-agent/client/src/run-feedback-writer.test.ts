import { describe, expect, it, vi } from 'vitest';

import { postRunFeedback, RunFeedbackWriter } from './run-feedback-writer';

function response(ok = true, status = 201): Response {
  return { ok, status } as Response;
}

describe('Run Explorer caller feedback writes', () => {
  it('writes only the canonical message id and sentiment for a helpful answer', async () => {
    let body: BodyInit | null | undefined;
    const send = vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = init?.body;
      return Promise.resolve(response());
    });
    await postRunFeedback({ messageId: 'msg-answer-1', sentiment: 'up' }, send as unknown as typeof fetch);

    expect(send).toHaveBeenCalledWith('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: 'msg-answer-1', sentiment: 'up' }),
    });
    expect(typeof body).toBe('string');
    if (typeof body !== 'string') throw new Error('Feedback body was not JSON text');
    expect(body).not.toContain('usefulness');
  });

  it('trims and writes the optional down comment without a numeric score', async () => {
    let body: BodyInit | null | undefined;
    const send = vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = init?.body;
      return Promise.resolve(response());
    });
    await postRunFeedback(
      { messageId: 'benchmark-run-2', sentiment: 'down', comment: '  Missing comparison.  ' },
      send as unknown as typeof fetch
    );
    expect(typeof body).toBe('string');
    if (typeof body !== 'string') throw new Error('Feedback body was not JSON text');
    expect(JSON.parse(body)).toEqual({
      messageId: 'benchmark-run-2',
      sentiment: 'down',
      comment: 'Missing comparison.',
    });
  });

  it('serializes rapid replacements and ignores stale completion callbacks', async () => {
    const writer = new RunFeedbackWriter();
    let releaseFirst = () => {};
    const first = new Promise<Response>((resolve) => {
      releaseFirst = () => resolve(response());
    });
    const calls: string[] = [];
    const send = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => Promise.resolve(response()));

    const down = writer.save(
      { messageId: 'msg-1', sentiment: 'down' },
      {
        pending: () => calls.push('down:pending'),
        saved: () => calls.push('down:saved'),
        failed: () => calls.push('down:failed'),
      },
      send as unknown as typeof fetch
    );
    const up = writer.save(
      { messageId: 'msg-1', sentiment: 'up' },
      {
        pending: () => calls.push('up:pending'),
        saved: () => calls.push('up:saved'),
        failed: () => calls.push('up:failed'),
      },
      send as unknown as typeof fetch
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([down, up]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['down:pending', 'up:pending', 'up:saved']);
  });

  it('reports a retryable failure only for the latest requested direction', async () => {
    const writer = new RunFeedbackWriter();
    const events: string[] = [];
    await writer.save(
      { messageId: 'msg-1', sentiment: 'down', comment: 'Keep this text.' },
      {
        pending: () => events.push('pending'),
        saved: () => events.push('saved'),
        failed: (error) => events.push(error.message),
      },
      vi.fn(() => Promise.resolve(response(false, 503))) as unknown as typeof fetch
    );
    expect(events).toEqual(['pending', 'Feedback was not recorded (HTTP 503).']);
  });

  it('retains the last committed direction when a rapid replacement fails', async () => {
    const writer = new RunFeedbackWriter();
    let confirmed: 'down' | null = null;
    let rollback: 'down' | null = null;
    const send = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response(false, 503));

    const first = writer.save(
      { messageId: 'msg-1', sentiment: 'down' },
      {
        pending: () => undefined,
        committed: () => {
          confirmed = 'down';
        },
        saved: () => undefined,
        failed: () => undefined,
      },
      send as unknown as typeof fetch
    );
    const second = writer.save(
      { messageId: 'msg-1', sentiment: 'up' },
      {
        pending: () => undefined,
        saved: () => undefined,
        failed: () => {
          rollback = confirmed;
        },
      },
      send as unknown as typeof fetch
    );

    await Promise.all([first, second]);
    expect(confirmed).toBe('down');
    expect(rollback).toBe('down');
  });
});
