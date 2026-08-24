/**
 * That leaving Ask and returning restores the selected thread.
 *
 * Top-level route changes unmount `HomePage`; component state therefore cannot
 * carry a selection through Run Explorer, Monitoring, or any other tab. The
 * browser-session record is the bridge, while `?c=` remains authoritative for
 * deep links and Back/Forward.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SELECTED_CONVERSATION_KEY,
  clearSelectedConversation,
  readSelectedConversation,
  rememberSelectedConversation,
  resetSelectedConversationForTests,
} from './selected-conversation';

const HOME = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');

function browserSession() {
  const values = new Map<string, string>();
  return {
    values,
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetSelectedConversationForTests();
});

describe('Ask selection persistence', () => {
  it('keeps the selected id for the next Ask mount and a full-page reload', () => {
    const browser = browserSession();
    vi.stubGlobal('window', { sessionStorage: browser.sessionStorage });

    rememberSelectedConversation('conv-14');

    expect(readSelectedConversation()).toBe('conv-14');
    expect(browser.values.get(SELECTED_CONVERSATION_KEY)).toBe('conv-14');
  });

  it('uses an in-memory fallback when browser storage is blocked', () => {
    vi.stubGlobal('window', {
      get sessionStorage() {
        throw new Error('blocked');
      },
    });

    rememberSelectedConversation('conv-active');

    expect(readSelectedConversation()).toBe('conv-active');
  });

  it('clears the remembered thread so the starter is not overwritten on return', () => {
    const browser = browserSession();
    vi.stubGlobal('window', { sessionStorage: browser.sessionStorage });
    rememberSelectedConversation('conv-old');

    clearSelectedConversation();

    expect(readSelectedConversation()).toBeNull();
    expect(browser.values.has(SELECTED_CONVERSATION_KEY)).toBe(false);
  });

  it('restores from the URL first, then the browser session, and rewrites the URL', () => {
    expect(HOME).toContain(
      'searchParams.get(CONVERSATION_PARAM) ?? readSelectedConversation() ?? `conv-${crypto.randomUUID()}`'
    );
    expect(HOME).toContain('const target = requested ?? readSelectedConversation()');
    expect(HOME).toContain(
      'if (!requested) setSearchParams({ [CONVERSATION_PARAM]: target }, { replace: true })'
    );
  });

  it('records row clicks and active asks before navigation can unmount the page', () => {
    expect(HOME).toContain('rememberSelectedConversation(conversation.id)');
    expect(HOME).toContain('rememberSelectedConversation(runConversationId)');
    expect(HOME).toContain('rememberSelectedConversation(id)');
  });

  it('makes New conversation one route back to the starter', () => {
    const action = /function startNewConversation\(\) \{[\s\S]*?setSearchParams\(\{\}, \{ replace: true \}\);/.exec(
      HOME
    )?.[0];
    expect(action).toContain('clearSelectedConversation()');
    expect(action).toContain('setMessages([])');
  });
});
