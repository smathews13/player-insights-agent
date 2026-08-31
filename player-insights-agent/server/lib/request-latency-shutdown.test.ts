import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RequestLatencyShutdown } from './request-latency-shutdown';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('request latency shutdown', () => {
  it('flushes exactly once across both signals and server close', async () => {
    const signals = new EventEmitter();
    const flush = vi.fn().mockResolvedValue(undefined);
    const shutdown = new RequestLatencyShutdown(100);
    shutdown.bind({ flush });
    shutdown.listen(signals);

    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    await Promise.all([shutdown.flushOnce(), shutdown.flushOnce()]);

    expect(flush).toHaveBeenCalledOnce();
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('stops waiting at the bounded timeout without a process-holding timer', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const flush = vi.fn(() => new Promise<void>(() => undefined));
    const shutdown = new RequestLatencyShutdown(25);
    shutdown.bind({ flush });

    const draining = shutdown.flushOnce();
    await vi.advanceTimersByTimeAsync(25);
    await draining;

    expect(flush).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('25ms'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timeout when the recorder finishes normally', async () => {
    vi.useFakeTimers();
    const shutdown = new RequestLatencyShutdown(25);
    shutdown.bind({ flush: vi.fn().mockResolvedValue(undefined) });

    await shutdown.flushOnce();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not reject shutdown when the recorder flush fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const shutdown = new RequestLatencyShutdown(25);
    shutdown.bind({ flush: vi.fn().mockRejectedValue(new Error('pool closed')) });

    await expect(shutdown.flushOnce()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pool closed'));
  });
});
