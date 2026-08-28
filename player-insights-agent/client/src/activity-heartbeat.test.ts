import { describe, expect, it, vi } from 'vitest';

import { ACTIVITY_HEARTBEAT_INTERVAL_MS, ACTIVITY_HEARTBEAT_PATH, startActivityHeartbeat } from './activity-heartbeat';

function visibleDocument(initial: DocumentVisibilityState = 'visible') {
  let visibilityState = initial;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  return {
    document: {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (_name: string, listener: EventListenerOrEventListenerObject) => listeners.add(listener),
      removeEventListener: (_name: string, listener: EventListenerOrEventListenerObject) => listeners.delete(listener),
    } as Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>,
    setVisibility(next: DocumentVisibilityState) {
      visibilityState = next;
      for (const listener of listeners) {
        if (typeof listener === 'function') listener(new Event('visibilitychange'));
        else listener.handleEvent(new Event('visibilitychange'));
      }
    },
    listeners,
  };
}

describe('visible app activity heartbeat', () => {
  it('sends no identity or content and stops while the document is hidden', async () => {
    vi.useFakeTimers();
    const page = visibleDocument();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    const stop = startActivityHeartbeat(page.document, fetchImpl as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith(ACTIVITY_HEARTBEAT_PATH, {
      method: 'POST',
      keepalive: true,
    });
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('body');

    page.setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(ACTIVITY_HEARTBEAT_INTERVAL_MS * 2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    page.setVisibility('visible');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    stop();
    expect(page.listeners.size).toBe(0);
    vi.useRealTimers();
  });
});
