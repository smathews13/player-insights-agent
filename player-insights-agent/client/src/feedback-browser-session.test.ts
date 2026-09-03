import { describe, expect, it, vi } from 'vitest';

import { listenForFeedbackChanges, notifyFeedbackChanged, type FeedbackEventTarget } from './feedback-events';
import { feedbackBrowserRequestId, feedbackBrowserUrl } from './feedback-browser-session';

const request = {
  scope: 'admin@example.com|admin',
  from: '2026-09-01T00:00:00.000Z',
  to: '2026-09-03T00:00:00.000Z',
  filters: {
    search: ' missing detail ',
    feedback: 'down' as const,
    user: 'Coach@Example.com',
    role: 'consumer',
    persona: 'coach',
    organization: 'example.com',
  },
  cursor: 'opaque-page-two',
  pageSize: 25,
};

describe('feedback browser session requests', () => {
  it('keys the session cache by identity, period, every filter, and cursor', () => {
    const id = feedbackBrowserRequestId(request);
    expect(id).toContain('admin@example.com|admin');
    expect(id).toContain('missing detail');
    expect(id).toContain('coach@example.com');
    expect(id).toContain('opaque-page-two');
    expect(feedbackBrowserRequestId({ ...request, cursor: '' })).not.toBe(id);
    expect(feedbackBrowserRequestId({ ...request, filters: { ...request.filters, persona: 'analyst' } })).not.toBe(id);
  });

  it('sends only bounded feedback browse parameters and no cost coordinates', () => {
    const url = feedbackBrowserUrl(request);
    expect(url).toContain('/api/monitoring/feedback?');
    for (const key of [
      'from=',
      'to=',
      'limit=25',
      'cursor=',
      'q=',
      'feedback=down',
      'user=',
      'role=',
      'persona=',
      'organization=',
    ]) {
      expect(url).toContain(key);
    }
    expect(url).not.toMatch(/cost|spend|billing|unit=/i);
  });
});

describe('feedback cache invalidation event', () => {
  it('notifies this session after a successful feedback write', () => {
    const target: FeedbackEventTarget = Object.assign(new EventTarget(), {
      localStorage: { setItem: vi.fn() },
    });
    const listener = vi.fn();
    const stop = listenForFeedbackChanges(listener, target);
    notifyFeedbackChanged(target);
    stop();
    notifyFeedbackChanged(target);
    expect(listener).toHaveBeenCalledOnce();
  });
});
