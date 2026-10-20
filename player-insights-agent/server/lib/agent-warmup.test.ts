import { describe, expect, it, vi } from 'vitest';

import { AGENT_WAKE_COOLDOWN_MS, AGENT_WAKE_PAYLOAD, agentWarmState, createAgentWarmup } from './agent-warmup';

const endpoint = (message: string) => ({
  config: { served_entities: [{ state: { deployment: 'DEPLOYMENT_READY', deployment_state_message: message } }] },
});

describe('agentWarmState', () => {
  it.each([
    ['Scaled to zero', 'asleep'],
    ['Scaling from zero', 'waking'],
    ['', 'warm'],
  ])('reads %j as %s', (message, expected) => {
    expect(agentWarmState(endpoint(message))).toBe(expected);
  });

  it('is unknown when the endpoint says nothing about its entities', () => {
    expect(agentWarmState({})).toBe('unknown');
    expect(agentWarmState(null)).toBe('unknown');
    expect(agentWarmState({ config: { served_entities: [{}] } })).toBe('unknown');
  });
});

describe('createAgentWarmup', () => {
  it('sends one empty conversation to a sleeping endpoint and reports it waking', async () => {
    const wake = vi.fn(() => Promise.resolve({}));
    const warmup = createAgentWarmup({ readMetadata: () => Promise.resolve(endpoint('Scaled to zero')), wake });

    expect(await warmup.arrive('user-token')).toBe('waking');
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith('user-token');
    // The wake-up asks nothing, so no model is ever called for it.
    expect(AGENT_WAKE_PAYLOAD).toEqual({ input: [] });
  });

  it('does not send another within the cooldown, and does again after it', async () => {
    let clock = 0;
    const wake = vi.fn(() => Promise.resolve({}));
    const warmup = createAgentWarmup({
      readMetadata: () => Promise.resolve(endpoint('Scaled to zero')),
      wake,
      now: () => clock,
    });

    await warmup.arrive('t');
    clock += AGENT_WAKE_COOLDOWN_MS - 1;
    await warmup.arrive('t');
    expect(wake).toHaveBeenCalledTimes(1);
    clock += 1;
    await warmup.arrive('t');
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it('only reports an endpoint that is already coming up, without poking it', async () => {
    const wake = vi.fn(() => Promise.resolve({}));
    const warmup = createAgentWarmup({ readMetadata: () => Promise.resolve(endpoint('Scaling from zero')), wake });
    expect(await warmup.arrive('t')).toBe('waking');
    expect(wake).not.toHaveBeenCalled();
  });

  it('leaves a warm endpoint alone', async () => {
    const wake = vi.fn(() => Promise.resolve({}));
    const warmup = createAgentWarmup({ readMetadata: () => Promise.resolve(endpoint('')), wake });
    expect(await warmup.arrive('t')).toBe('warm');
    expect(wake).not.toHaveBeenCalled();
  });

  it('cannot be made to fail: an unreadable endpoint is unknown, a refused wake-up is ignored', async () => {
    const unreadable = createAgentWarmup({
      readMetadata: () => Promise.reject(new Error('403')),
      wake: () => Promise.resolve({}),
    });
    expect(await unreadable.arrive('t')).toBe('unknown');

    const refused = createAgentWarmup({
      readMetadata: () => Promise.resolve(endpoint('Scaled to zero')),
      wake: () => Promise.reject(new Error('A user question is required.')),
    });
    expect(await refused.arrive('t')).toBe('waking');
  });

  it('does not wake a sleeping endpoint it has no user credential for', async () => {
    const wake = vi.fn(() => Promise.resolve({}));
    const warmup = createAgentWarmup({ readMetadata: () => Promise.resolve(endpoint('Scaled to zero')), wake });
    expect(await warmup.arrive(undefined)).toBe('waking');
    expect(wake).not.toHaveBeenCalled();
  });
});
