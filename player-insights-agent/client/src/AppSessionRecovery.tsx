/* eslint-disable react-refresh/only-export-components -- recovery surfaces share the session boundary contract */
import { useEffect, type ReactNode } from 'react';
import { LogIn, RotateCcw } from 'lucide-react';
import {
  NATIVE_APP_SIGN_OUT_PATH,
  APP_SESSION_TIMEOUT_KEY,
  bootstrapAppSession,
  clearSensitiveClientState,
  retryAppSessionBootstrap,
  startExplicitUserActivity,
  useAppSessionState,
} from './app-session';
import { browserAcknowledgementStore, type AcknowledgementStore } from './first-open';

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
      <section className="app-session-card ast-login-panel">
        <h1 id="app-session-timeout-title">Session timed out</h1>
        <p>Your Player Insights Agent session ended after inactivity. Return to sign in to continue.</p>
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
      <section className="app-session-card ast-login-panel">
        <h1 id="app-session-unavailable-title">Session unavailable</h1>
        <p>Player Insights Agent could not verify its server-side session, so no protected data was loaded.</p>
        <button type="button" onClick={retryAppSessionBootstrap}>
          <RotateCcw aria-hidden="true" />
          Try again
        </button>
      </section>
    </main>
  );
}

export function AppSessionRecovery({ state }: { state: 'timed-out' | 'unavailable' }) {
  return state === 'timed-out' ? <SessionTimedOut /> : <SessionUnavailable />;
}

/**
 * Compatibility boundary for focused session tests and embedders. Production
 * loads these recovery controls only after the startup coordinator needs one.
 */
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
        <section className="app-session-card ast-login-panel" aria-busy="true">
          <p>Starting secure app session…</p>
        </section>
      </main>
    );
  }
  return children;
}
