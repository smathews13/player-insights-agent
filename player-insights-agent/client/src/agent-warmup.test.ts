import { describe, expect, it } from 'vitest';

import { agentWarmupFrom, readAgentWarmup } from './agent-warmup';

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
