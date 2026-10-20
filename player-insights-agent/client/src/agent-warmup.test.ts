import { describe, expect, it } from 'vitest';

import { agentWarmupFrom, readAgentWarmup, waitForAgentReady } from './agent-warmup';

describe('agent warm-up', () => {
  it.each([
    [{ state: 'waking' }, 'waking'],
    [{ state: 'warm' }, 'warm'],
    [{ state: 'asleep' }, 'unknown'],
    [{}, 'unknown'],
    [null, 'unknown'],
  ])('reads %j as %s', (payload, expected) => {
    expect(agentWarmupFrom(payload)).toBe(expected);
  });

  it('is unknown, never an error, when the request fails', async () => {
    expect(await readAgentWarmup(() => Promise.reject(new Error('offline')))).toBe('unknown');
  });

  it('posts to the arrival route and reads its answer', async () => {
    const calls: string[] = [];
    const state = await readAgentWarmup((url) => {
      calls.push(url);
      return Promise.resolve({ json: () => Promise.resolve({ state: 'waking' }) });
    });
    expect(calls).toEqual(['/api/agent-warmup']);
    expect(state).toBe('waking');
  });
});

describe('waiting for the agent before a question', () => {
  const answer = (state: string) => () => Promise.resolve({ json: () => Promise.resolve({ state }) });

  it('does not wait when the agent is awake', async () => {
    let slept = 0;
    const result = await waitForAgentReady({
      fetcher: answer('warm'),
      sleep: () => {
        slept += 1;
        return Promise.resolve();
      },
    });
    expect(result).toBe('ready');
    expect(slept).toBe(0);
  });

  it('keeps asking while it wakes, then lets the question through', async () => {
    const states = ['waking', 'waking', 'warm'];
    let woke = 0;
    const result = await waitForAgentReady({
      fetcher: () => answer(states.shift() ?? 'warm')(),
      sleep: () => Promise.resolve(),
      onWaking: () => {
        woke += 1;
      },
    });
    expect(result).toBe('ready');
    expect(woke).toBe(2);
  });

  it('sends the question anyway when the wait runs out', async () => {
    let clock = 0;
    const result = await waitForAgentReady({
      fetcher: answer('waking'),
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      giveUpMs: 20_000,
    });
    expect(result).toBe('timed-out');
  });

  it('treats an unreadable state as awake', async () => {
    expect(await waitForAgentReady({ fetcher: () => Promise.reject(new Error('offline')) })).toBe('ready');
  });
});
