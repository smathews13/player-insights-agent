import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAccountFeedbackTargets, resetAccountFeedbackTargetsForTests } from './account-feedback-targets';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('account feedback target loading', () => {
  beforeEach(resetAccountFeedbackTargetsForTests);
  afterEach(() => vi.unstubAllGlobals());

  it('passes an abort signal, validates the response, and caches the safe result', async () => {
    const direct = `slack://user?team=T${'1'.repeat(8)}&id=U${'4'.repeat(8)}`;
    const search = `https://app.slack.com/client/T${'2'.repeat(8)}/search?q=Customer%20Admin`;
    const fetch = vi.fn().mockResolvedValue(
      json({
        github: { label: 'Untrusted label', url: 'https://example.com/not-used' },
        slack: { label: 'Message Maintainer in Slack', url: direct },
        escalation: { label: 'Find Customer Admin in Slack', url: search },
      })
    );
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();

    const first = await readAccountFeedbackTargets(controller.signal);
    const second = await readAccountFeedbackTargets();

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('/api/account/feedback-targets', {
      credentials: 'same-origin',
      signal: controller.signal,
    });
    expect(first).toBe(second);
    expect(first.github).toEqual({
      label: 'GitHub issue',
      url: 'https://github.com/smathews13/player-insights-agent/issues/new',
    });
    expect(first.slack).toEqual({ label: 'Message Maintainer in Slack', url: direct });
    expect(first.escalation).toEqual({ label: 'Find Customer Admin in Slack', url: search });
  });

  it('falls back to GitHub only when the endpoint returns an unsafe URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ slack: { label: 'Message somebody else', url: 'javascript:alert(1)' } }))
    );
    const targets = await readAccountFeedbackTargets();
    expect(targets.slack).toBeNull();
    expect(targets.escalation).toBeNull();
  });

  it('does not cache an aborted request', async () => {
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(aborted)
      .mockResolvedValueOnce(json({ slack: null }));
    vi.stubGlobal('fetch', fetch);

    await expect(readAccountFeedbackTargets(new AbortController().signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(readAccountFeedbackTargets()).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
