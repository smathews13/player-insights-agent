import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_IDLE_TIMEOUT_CODE,
  APP_SESSION_ACTIVITY_PATH,
  APP_SESSION_END_PATH,
  AppSessionBoundary,
  NATIVE_APP_SIGN_OUT_PATH,
  type AppSessionFetch,
  clearSensitiveClientState,
  installAppSessionFetchGuard,
  resetAppSessionForTests,
  signOutAndEndAppSession,
  startExplicitUserActivity,
} from './app-session';
import { FIRST_OPEN_KEY, FIRST_OPEN_OUTCOME_KEY, type AcknowledgementStore } from './first-open';

afterEach(() => {
  resetAppSessionForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function requestText(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

describe('explicit user activity', () => {
  it('refreshes only on throttled physical interactions, not timers or visibility', () => {
    const listeners = new Map<string, EventListener>();
    const documentRef = {
      addEventListener(type: string, listener: EventListener) {
        listeners.set(type, listener);
      },
      removeEventListener(type: string) {
        listeners.delete(type);
      },
    };
    const requests: { path: string; init?: RequestInit }[] = [];
    const fetchImpl: AppSessionFetch = (path, init) => {
      requests.push({ path: requestText(path), init });
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    let now = 1_000;
    resetAppSessionForTests('ready');
    const stop = startExplicitUserActivity(documentRef, fetchImpl, () => now);

    expect([...listeners.keys()].sort()).toEqual(['keydown', 'pointerdown', 'touchstart']);
    expect(listeners.has('visibilitychange')).toBe(false);
    expect(requests).toEqual([]);
    listeners.get('pointerdown')?.(new Event('pointerdown'));
    now += 1_000;
    listeners.get('keydown')?.(new Event('keydown'));
    now += 60_000;
    listeners.get('keydown')?.(new Event('keydown'));

    expect(requests).toHaveLength(2);
    expect(requests[0]?.path).toBe(APP_SESSION_ACTIVITY_PATH);
    expect(new Headers(requests[0]?.init?.headers).get('x-astrolabe-session-action')).toBe('activity');
    stop();
    expect(listeners.size).toBe(0);
  });
});

describe('timeout boundary', () => {
  it('observes the stable 401 code, unmounts protected content, and shows honest copy', async () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://astrolabe.example.test' },
      sessionStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: APP_IDLE_TIMEOUT_CODE }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          })
        )
      )
    );
    resetAppSessionForTests('ready');
    installAppSessionFetchGuard();
    await fetch('/api/conversations');
    const markup = renderToStaticMarkup(
      <AppSessionBoundary>
        <div>private conversation</div>
      </AppSessionBoundary>
    );

    expect(markup).toContain('Session timed out');
    expect(markup).not.toContain('private conversation');
    expect(markup).toContain('cannot detect or invalidate a separate Databricks workspace session');
    expect(markup).toContain('may authenticate you again without prompting');
    expect(markup).toContain('Sign out of Astrolabe');
    expect(markup).not.toMatch(/workspace (?:was|is) signed out|federated logout (?:works|completed)/i);
  });

  it('clears tab-scoped state and cache reset hooks', () => {
    const removed: string[] = [];
    const store: AcknowledgementStore = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: (key) => removed.push(key),
    };
    clearSensitiveClientState(store);
    expect(removed).toEqual([FIRST_OPEN_OUTCOME_KEY, FIRST_OPEN_KEY]);

    const source = readFileSync(new URL('./app-session.tsx', import.meta.url), 'utf8');
    for (const reset of [
      'abortActiveAsksForSessionEnd()',
      'clearActiveConversationRuns()',
      'resetLiveAsks()',
      'forgetIdentityRequest()',
      'forgetChecks()',
      'forgetMonitoringSession()',
      'forgetOpsSession()',
    ]) {
      expect(source).toContain(reset);
    }
  });
});

describe('coordinated app sign-out', () => {
  it('ends the custom session and then uses the relative native app sign-out path', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn((path: RequestInfo | URL, _init?: RequestInit) => {
      calls.push(requestText(path));
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const navigate = vi.fn((path: string) => calls.push(path));
    const store: AcknowledgementStore = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };

    await signOutAndEndAppSession({ fetchImpl: fetchMock, navigate, store });

    expect(calls).toEqual([APP_SESSION_END_PATH, NATIVE_APP_SIGN_OUT_PATH]);
    expect(NATIVE_APP_SIGN_OUT_PATH).toBe('/.auth/sign_out');
    expect(NATIVE_APP_SIGN_OUT_PATH).not.toMatch(/^https?:/);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).get('x-astrolabe-session-action')).toBe('end');
  });
});
