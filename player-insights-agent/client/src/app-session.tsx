/* eslint-disable react-refresh/only-export-components -- session state and its blocking boundary must share one latch */
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { LogIn, RotateCcw } from 'lucide-react';
import { forgetIdentityRequest } from './app-state';
import { clearActiveConversationRuns } from './active-conversation-runs';
import { abortActiveAsksForSessionEnd } from './ask-cancellation';
import { forgetChecks } from './check-session';
import { resetEgressPolicy } from './egress-policy';
import { browserAcknowledgementStore, signOutOfAstrolabe, type AcknowledgementStore } from './first-open';
import { resetLiveAsks } from './live-ask';
import { forgetMonitoringSession } from './monitoring-session';
import { forgetOpsSession } from './ops-session';
import { forgetRunLabelOverrides } from './run-header-labels';
import { forgetLiveRuntimeSettings } from './runtime-settings-live';
import { clearSelectedConversation } from './selected-conversation';
import { resetSessionChecks } from './session-checks';

export const NATIVE_APP_SIGN_OUT_PATH = '/.auth/sign_out';
export const APP_SESSION_BOOTSTRAP_PATH = '/api/app-session/bootstrap';
export const APP_SESSION_ACTIVITY_PATH = '/api/app-session/activity';
export const APP_SESSION_END_PATH = '/api/app-session/end';
export const APP_IDLE_TIMEOUT_CODE = 'APP_IDLE_TIMEOUT';
export const APP_SESSION_TIMEOUT_KEY = 'astrolabe.app-session.timed-out';
export const USER_ACTIVITY_THROTTLE_MS = 45_000;
export const SIGN_OUT_END_WAIT_MS = 1_500;
const EXPLICIT_USER_ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;

export type AppSessionState = 'booting' | 'ready' | 'timed-out' | 'unavailable';
type Listener = () => void;
export type AppSessionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const TIMED_OUT = 'true';

export function appSessionStateFromStore(
  store: AcknowledgementStore | null = browserAcknowledgementStore()
): AppSessionState {
  try {
    return store?.getItem(APP_SESSION_TIMEOUT_KEY) === TIMED_OUT ? 'timed-out' : 'booting';
  } catch {
    return 'booting';
  }
}

let state: AppSessionState = appSessionStateFromStore();
let bootstrapPromise: Promise<void> | null = null;
let fetchInstalled = false;
let explicitActivityRegistration: { owners: number; remove: () => void } | null = null;
const listeners = new Set<Listener>();

function announce(): void {
  for (const listener of [...listeners]) listener();
}

function setState(next: AppSessionState): void {
  if (next === state) return;
  state = next;
  announce();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function currentState(): AppSessionState {
  return state;
}

/**
 * Remove every module-level cache that can hold user data. React state and all
 * poll timers disappear when the session boundary unmounts the app shell; these
 * are the stores that otherwise survive that unmount.
 */
export function clearSensitiveClientState(store = browserAcknowledgementStore()): void {
  signOutOfAstrolabe(store);
  clearSelectedConversation();
  abortActiveAsksForSessionEnd();
  clearActiveConversationRuns();
  resetLiveAsks();
  forgetIdentityRequest();
  forgetChecks();
  resetSessionChecks();
  forgetMonitoringSession();
  forgetOpsSession();
  forgetLiveRuntimeSettings();
  forgetRunLabelOverrides();
  resetEgressPolicy();
}

export function markAppSessionTimedOut(store = browserAcknowledgementStore()): void {
  if (state === 'timed-out') return;
  clearSensitiveClientState(store);
  try {
    store?.setItem(APP_SESSION_TIMEOUT_KEY, TIMED_OUT);
  } catch {
    // The in-memory latch still blocks this loaded page when storage is unavailable.
  }
  setState('timed-out');
}

function requestPath(input: RequestInfo | URL): string {
  try {
    if (input instanceof Request) return new URL(input.url).pathname;
    return new URL(String(input), window.location.origin).pathname;
  } catch {
    return '';
  }
}

function allowedAfterTimeout(path: string): boolean {
  return path === APP_SESSION_END_PATH || path === '/api/storage';
}

async function timeoutCode(response: Response): Promise<string> {
  if (response.status !== 401) return '';
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return '';
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : '';
  } catch {
    return '';
  }
}

/**
 * One guard for every existing fetch call. A timeout response is observed before
 * its body reaches feature code, and once observed no later protected response
 * can repopulate a cache while the shell is being unmounted.
 */
export function installAppSessionFetchGuard(target: typeof globalThis = globalThis): void {
  if (fetchInstalled || typeof target.fetch !== 'function') return;
  const nativeFetch = target.fetch.bind(target);
  target.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (state === 'timed-out' && path.startsWith('/api/') && !allowedAfterTimeout(path)) {
      return new Response(JSON.stringify({ error: APP_IDLE_TIMEOUT_CODE }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    const response = await nativeFetch(input, init);
    if ((await timeoutCode(response)) === APP_IDLE_TIMEOUT_CODE) markAppSessionTimedOut();
    if (state === 'timed-out' && path.startsWith('/api/') && !allowedAfterTimeout(path)) {
      return new Response(JSON.stringify({ error: APP_IDLE_TIMEOUT_CODE }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    return response;
  }) as typeof fetch;
  fetchInstalled = true;
}

export function bootstrapAppSession(fetchImpl: AppSessionFetch = fetch): Promise<void> {
  if (state === 'timed-out') return Promise.resolve();
  if (bootstrapPromise) return bootstrapPromise;
  setState('booting');
  bootstrapPromise = fetchImpl(APP_SESSION_BOOTSTRAP_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-astrolabe-session-action': 'bootstrap',
    },
    body: '{}',
  })
    .then(async (response) => {
      if (!response.ok) {
        if ((await timeoutCode(response)) === APP_IDLE_TIMEOUT_CODE) {
          markAppSessionTimedOut();
          return;
        }
        throw new Error(`App-session bootstrap answered ${response.status}.`);
      }
      setState('ready');
    })
    .catch(() => {
      if (state !== 'timed-out') setState('unavailable');
      bootstrapPromise = null;
    });
  return bootstrapPromise;
}

export function retryAppSessionBootstrap(): void {
  if (state === 'timed-out') return;
  bootstrapPromise = null;
  void bootstrapAppSession();
}

interface ActivityDocument {
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListener, options?: EventListenerOptions): void;
}

/**
 * Only a trusted physical interaction refreshes last_active_at. Visibility
 * changes, timers, storage polling, run polling, ordinary reads, and
 * script-dispatched events never call this.
 */
export function startExplicitUserActivity(
  documentRef: ActivityDocument = document,
  fetchImpl: AppSessionFetch = fetch,
  now: () => number = Date.now
): () => void {
  if (explicitActivityRegistration) {
    explicitActivityRegistration.owners += 1;
    const registration = explicitActivityRegistration;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      registration.owners -= 1;
      if (registration.owners > 0 || explicitActivityRegistration !== registration) return;
      registration.remove();
      explicitActivityRegistration = null;
    };
  }

  let lastSentAt = 0;
  const onActivity: EventListener = (event) => {
    if (!event.isTrusted) return;
    if (state !== 'ready') return;
    const at = now();
    if (lastSentAt && at - lastSentAt < USER_ACTIVITY_THROTTLE_MS) return;
    lastSentAt = at;
    void fetchImpl(APP_SESSION_ACTIVITY_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: {
        'content-type': 'application/json',
        'x-astrolabe-session-action': 'activity',
      },
      body: '{}',
    }).catch(() => {
      // A protected request still performs the authoritative timeout check. A
      // transient activity-write failure must not invent a timeout client-side.
    });
  };
  for (const event of EXPLICIT_USER_ACTIVITY_EVENTS) {
    documentRef.addEventListener(event, onActivity, { passive: true });
  }
  const registration = {
    owners: 1,
    remove: () => {
      for (const event of EXPLICIT_USER_ACTIVITY_EVENTS) {
        documentRef.removeEventListener(event, onActivity);
      }
    },
  };
  explicitActivityRegistration = registration;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    registration.owners -= 1;
    if (registration.owners > 0 || explicitActivityRegistration !== registration) return;
    registration.remove();
    explicitActivityRegistration = null;
  };
}

export async function signOutAndEndAppSession(
  options: {
    fetchImpl?: AppSessionFetch;
    navigate?: (path: string) => void;
    store?: AcknowledgementStore | null;
  } = {}
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const navigate = options.navigate ?? ((path: string) => window.location.assign(path));
  clearSensitiveClientState(options.store === undefined ? browserAcknowledgementStore() : options.store);
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SIGN_OUT_END_WAIT_MS);
      void fetchImpl(APP_SESSION_END_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: {
          'content-type': 'application/json',
          'x-astrolabe-session-action': 'end',
        },
        body: '{}',
      }).then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        }
      );
    });
  } finally {
    // Relative and same-origin by construction. Databricks clears its native app
    // cookie here; no workspace host is guessed or embedded.
    navigate(NATIVE_APP_SIGN_OUT_PATH);
  }
}

export function returnToSignIn(
  options: {
    navigate?: (path: string) => void;
    store?: AcknowledgementStore | null;
  } = {}
): void {
  const navigate = options.navigate ?? ((path: string) => window.location.assign(path));
  const store = options.store === undefined ? browserAcknowledgementStore() : options.store;
  clearSensitiveClientState(store);
  try {
    store?.removeItem?.(APP_SESSION_TIMEOUT_KEY);
  } catch {
    // Navigation still ends the current native app auth when storage is unavailable.
  }
  // This same-origin native Apps endpoint resets native app auth. An active
  // upstream workspace/IdP session may authenticate the person again.
  navigate(NATIVE_APP_SIGN_OUT_PATH);
}

export function SessionTimedOut() {
  return (
    <main className="app-session-block" role="alert" aria-labelledby="app-session-timeout-title">
      <section className="app-session-card">
        <h1 id="app-session-timeout-title">Session timed out</h1>
        <p>Your Astrolabe session ended after inactivity. Return to sign in to continue.</p>
        <a
          href={NATIVE_APP_SIGN_OUT_PATH}
          onClick={(event) => {
            event.preventDefault();
            returnToSignIn();
          }}
        >
          <LogIn aria-hidden="true" />
          Return to sign in
        </a>
      </section>
    </main>
  );
}

export function SessionUnavailable() {
  return (
    <main className="app-session-block" role="alert" aria-labelledby="app-session-unavailable-title">
      <section className="app-session-card">
        <h1 id="app-session-unavailable-title">Session unavailable</h1>
        <p>Astrolabe could not verify its server-side session, so no protected data was loaded.</p>
        <button type="button" onClick={retryAppSessionBootstrap}>
          <RotateCcw aria-hidden="true" />
          Try again
        </button>
      </section>
    </main>
  );
}

export function AppSessionBoundary({ children }: { children: ReactNode }) {
  const current = useAppSessionState();
  useEffect(() => {
    void bootstrapAppSession();
  }, []);
  useEffect(() => (current === 'ready' ? startExplicitUserActivity() : undefined), [current]);
  if (current === 'timed-out') return <SessionTimedOut />;
  if (current === 'unavailable') return <SessionUnavailable />;
  if (current !== 'ready') {
    return (
      <main className="app-session-block" aria-busy="true" aria-label="Starting secure app session">
        <section className="app-session-card">
          <p>Starting secure app session…</p>
        </section>
      </main>
    );
  }
  return children;
}

/** The startup coordinator reads the same module latch as timeout handling. */
export function useAppSessionState(): AppSessionState {
  return useSyncExternalStore(subscribe, currentState, currentState);
}

/** Test isolation for the module-level fetch/session latch. */
export function resetAppSessionForTests(next: AppSessionState = 'booting'): void {
  explicitActivityRegistration?.remove();
  explicitActivityRegistration = null;
  state = next;
  bootstrapPromise = null;
  fetchInstalled = false;
  listeners.clear();
}
