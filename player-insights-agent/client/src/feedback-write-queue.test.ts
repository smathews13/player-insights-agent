import { describe, expect, it, vi } from 'vitest';

import { FeedbackWriteQueue } from './feedback-write-queue';

describe('feedback write concurrency', () => {
  it('preserves latest-click order for one answer', async () => {
    const queue = new FeedbackWriteQueue();
    const events: string[] = [];
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const down = queue.enqueue('answer-1', async () => {
      events.push('down:start');
      await firstGate;
      events.push('down:end');
    });
    const up = queue.enqueue('answer-1', () => {
      events.push('up:start');
      events.push('up:end');
      return Promise.resolve();
    });

    await vi.waitFor(() => expect(events).toEqual(['down:start']));
    releaseFirst();
    await Promise.all([down, up]);
    expect(events).toEqual(['down:start', 'down:end', 'up:start', 'up:end']);
  });

  it('continues to the latest replacement after an earlier failure', async () => {
    const queue = new FeedbackWriteQueue();
    const saved: string[] = [];
    const failed = queue.enqueue('answer-1', () => Promise.reject(new Error('store unavailable')));
    const replacement = queue.enqueue('answer-1', () => {
      saved.push('up');
      return Promise.resolve();
    });

    await expect(failed).rejects.toThrow('store unavailable');
    await expect(replacement).resolves.toBeUndefined();
    expect(saved).toEqual(['up']);
  });

  it('does not block feedback for another answer', async () => {
    const queue = new FeedbackWriteQueue();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = queue.enqueue('answer-1', () => gate);
    const other = vi.fn(() => Promise.resolve());

    await queue.enqueue('answer-2', other);
    expect(other).toHaveBeenCalledOnce();
    release();
    await slow;
  });
});
