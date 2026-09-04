/* eslint-disable react-refresh/only-export-components -- startup state, policy, and blocking boundary are one contract */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ACCESS_GATE_ENABLED } from '../../shared/access-gate';
import { AccessGate, gateIdentityFromResponse, requiresAccessDecision, type GateIdentity } from './AccessGate';
import { PiaLoader } from './PiaLoader';
import { useFirstOpen, type FirstOpenStage } from './FirstOpenGate';
import {
  bootstrapAppSession,
  startExplicitUserActivity,
  useAppSessionState,
  type AppSessionState,
} from './app-session';
import {
  IDENTITY_DEADLINE_MS,
  identityAfterDeadline,
  identityFromResponse,
  identityRequest,
  rememberResolvedIdentity,
} from './app-state';
import type { Identity } from './app-types';
import { PIA_LOADER_HALF_SECONDS, PIA_LOADER_STEP_SECONDS } from './pia-loader';
import { StartupReadinessProvider } from './startup-readiness';
import { focusAfterLogin } from './motion-transitions';

const AppSessionRecovery = lazy(() =>
  import('./AppSessionRecovery').then(({ AppSessionRecovery: recovery }) => ({ default: recovery }))
);

export type StartupPhase =
  | 'native-auth-pending'
  | 'app-session-bootstrap'
  | 'access-bootstrap'
  | 'application-bootstrap'
  | 'login-dwell'
  | 'access-decision'
  | 'first-open'
  | 'application-ready'
  | 'timed-out'
  | 'unavailable';

export interface StartupSnapshot {
  nativeAuthReturned: boolean;
  appSession: AppSessionState;
  identityResolved: boolean;
  accessDecisionRequired: boolean;
  applicationReady: boolean;
  loginDwellComplete: boolean;
  firstOpen: FirstOpenStage;
}

/**
 * The single ordered startup state machine.
 *
 * Native Apps authentication happens before this document is returned. Its
 * handoff is still represented so the empty index shell and the first React
 * commit are part of the same sequence rather than an implicit extra loader.
 */
export function startupPhase(snapshot: StartupSnapshot): StartupPhase {
  if (snapshot.appSession === 'timed-out') return 'timed-out';
  if (snapshot.appSession === 'unavailable') return 'unavailable';
  if (!snapshot.nativeAuthReturned) return 'native-auth-pending';
  if (snapshot.appSession !== 'ready') return 'app-session-bootstrap';
  if (!snapshot.identityResolved) return 'access-bootstrap';
  if (snapshot.accessDecisionRequired) return 'access-decision';
  if (!snapshot.applicationReady) return 'application-bootstrap';
  if (snapshot.firstOpen !== 'open' && !snapshot.loginDwellComplete) return 'login-dwell';
  if (snapshot.firstOpen !== 'open') return 'first-open';
  return 'application-ready';
}

export function startupIsPending(phase: StartupPhase): boolean {
  return (
    phase === 'native-auth-pending' ||
    phase === 'app-session-bootstrap' ||
    phase === 'access-bootstrap' ||
    phase === 'application-bootstrap' ||
    phase === 'login-dwell'
  );
}

/** Protected route code may mount only after session and identity authorization. */
export function startupCanMountApplication(snapshot: StartupSnapshot): boolean {
  return snapshot.appSession === 'ready' && snapshot.identityResolved && !snapshot.accessDecisionRequired;
}

export type StartupSurfaceOwner =
  | 'loader'
  | 'session-timeout'
  | 'session-error'
  | 'access-modal'
  | 'first-open-modal'
  | 'application';

export function startupSurfaceOwner(phase: StartupPhase): StartupSurfaceOwner {
  if (startupIsPending(phase)) return 'loader';
  if (phase === 'timed-out') return 'session-timeout';
  if (phase === 'unavailable') return 'session-error';
  if (phase === 'access-decision') return 'access-modal';
  if (phase === 'first-open') return 'first-open-modal';
  return 'application';
}

const resolvingIdentity: Identity = {
  signedInAs: 'Resolving signed-in user…',
  executionMode: 'service-principal',
};

export function StartupLoadingSurface({ phase }: { phase: StartupPhase }) {
  const label =
    phase === 'access-bootstrap'
      ? 'Checking access'
      : phase === 'application-bootstrap'
        ? 'Preparing Ask'
        : 'Starting secure app session';
  return (
    <main
      className="startup-surface"
      data-startup-phase={phase}
      data-startup-loader="pia-primary"
      aria-busy="true"
      aria-label={label}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {label}
      </p>
      <div className="startup-loader">
        <strong>Player Insights Agent</strong>
        <PiaLoader variant="panel" tone="dark" label={label} announce={false} />
      </div>
    </main>
  );
}

export function startStartupActivity(
  appSession: AppSessionState,
  start: () => () => void = startExplicitUserActivity
): (() => void) | undefined {
  return appSession === 'ready' ? start() : undefined;
}

/**
 * The previous coherent loader window was one 3.2s D-pad/cluster phase. Extend
 * it by at least two seconds and finish on the next 0.8s glyph beat, so the
 * login panel cannot cut through the visible swap.
 */
export const STARTUP_LOGIN_PREVIOUS_MINIMUM_MS = PIA_LOADER_HALF_SECONDS * 1_000;
export const STARTUP_LOGIN_REQUESTED_EXTENSION_MS = 2_000;
export const STARTUP_LOGIN_BEAT_MS = PIA_LOADER_STEP_SECONDS * 1_000;
export const STARTUP_LOGIN_MINIMUM_MS =
  Math.ceil((STARTUP_LOGIN_PREVIOUS_MINIMUM_MS + STARTUP_LOGIN_REQUESTED_EXTENSION_MS) / STARTUP_LOGIN_BEAT_MS) *
  STARTUP_LOGIN_BEAT_MS;

interface StartupLoginDwellClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof globalThis.setTimeout>;
  clearTimeout(timer: ReturnType<typeof globalThis.setTimeout>): void;
}

const startupLoginDwellClock: StartupLoginDwellClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
};

export interface StartupLoginDwell {
  start(): void;
  dispose(): void;
}

/**
 * One cancel-safe visual clock for the loader-to-login handoff.
 *
 * The caller starts session, identity, route, and readiness work independently;
 * this clock owns no initialization. Repeated starts (including StrictMode
 * effect replay) cannot create duplicate completion timers.
 */
export function createStartupLoginDwell(
  visibleAt: number,
  onComplete: () => void,
  clock: StartupLoginDwellClock = startupLoginDwellClock
): StartupLoginDwell {
  let started = false;
  let disposed = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const complete = () => {
    timer = null;
    if (disposed) return;
    onComplete();
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      const remaining = Math.max(0, STARTUP_LOGIN_MINIMUM_MS - (clock.now() - visibleAt));
      if (remaining === 0) complete();
      else timer = clock.setTimeout(complete, remaining);
    },
    dispose() {
      disposed = true;
      if (timer === null) return;
      clock.clearTimeout(timer);
      timer = null;
    },
  };
}

export function StartupBoundary({ children }: { children: ReactNode }) {
  const appSession = useAppSessionState();
  const [identity, setIdentity] = useState<Identity>(resolvingIdentity);
  const [identityResolved, setIdentityResolved] = useState(false);
  const [gateIdentity, setGateIdentity] = useState<GateIdentity | null>(null);
  const [applicationReady, setApplicationReady] = useState(false);
  const focusTarget = useRef<(() => void) | null>(null);
  const focusedAfterLogin = useRef(false);
  const readiness = useMemo(
    () => ({
      markReady: () => setApplicationReady(true),
      registerFocusTarget: (target: (() => void) | null) => {
        focusTarget.current = target;
      },
    }),
    []
  );
  const firstOpen = useFirstOpen(identity, applicationReady);
  const [loaderVisibleAt] = useState(() => Date.now());
  const loginDwellRequired = firstOpen.stage !== 'open';
  const loginPathActive = loginDwellRequired && appSession !== 'timed-out' && appSession !== 'unavailable';
  const [loginDwellComplete, setLoginDwellComplete] = useState(!loginDwellRequired);

  useEffect(() => {
    void bootstrapAppSession();
  }, []);

  useEffect(() => startStartupActivity(appSession), [appSession]);

  useEffect(() => {
    if (!loginPathActive) return;
    if (loginDwellComplete) return;
    const dwell = createStartupLoginDwell(loaderVisibleAt, () => setLoginDwellComplete(true));
    dwell.start();
    return () => dwell.dispose();
  }, [loaderVisibleAt, loginDwellComplete, loginPathActive]);

  useEffect(() => {
    if (appSession !== 'ready') return;
    let active = true;
    const timer = globalThis.setTimeout(() => {
      if (!active) return;
      setIdentity((current) => rememberResolvedIdentity(identityAfterDeadline(current)));
      setIdentityResolved(true);
    }, IDENTITY_DEADLINE_MS);

    void identityRequest().then(
      (response) => {
        if (!active) return;
        globalThis.clearTimeout(timer);
        setIdentity(rememberResolvedIdentity(identityFromResponse(response)));
        try {
          setGateIdentity(gateIdentityFromResponse(response));
        } catch {
          setGateIdentity(null);
        }
        setIdentityResolved(true);
      },
      () => {
        if (!active) return;
        globalThis.clearTimeout(timer);
        setIdentity(rememberResolvedIdentity(identityFromResponse(null)));
        setGateIdentity(null);
        setIdentityResolved(true);
      }
    );

    return () => {
      active = false;
      globalThis.clearTimeout(timer);
    };
  }, [appSession]);

  const accessDecisionRequired = requiresAccessDecision(gateIdentity);
  const snapshot: StartupSnapshot = {
    // If this module is executing, the native Apps authorization redirect has
    // already returned the document. The preceding blank index shell represents
    // the external pending state without mounting a competing symbol.
    nativeAuthReturned: true,
    appSession,
    identityResolved,
    accessDecisionRequired,
    applicationReady,
    loginDwellComplete,
    firstOpen: firstOpen.stage,
  };
  const phase = startupPhase(snapshot);
  const owner = startupSurfaceOwner(phase);
  const applicationMounted = startupCanMountApplication(snapshot);
  const applicationCovered = !applicationReady || firstOpen.stage !== 'open';
  const applicationEntering = firstOpen.stage === 'leaving';
  const applicationFirstReveal = applicationReady && firstOpen.stage === 'open' && !firstOpen.focusOnOpen;
  const applicationBlockedByLoader = owner === 'loader';

  useEffect(() => {
    if (firstOpen.stage !== 'open' || !firstOpen.focusOnOpen || focusedAfterLogin.current) return;
    focusedAfterLogin.current = true;
    const frame = window.requestAnimationFrame(() => focusAfterLogin(focusTarget.current));
    return () => window.cancelAnimationFrame(frame);
  }, [firstOpen.focusOnOpen, firstOpen.stage]);

  if (owner === 'session-timeout' || owner === 'session-error') {
    return (
      <Suspense
        fallback={
          <main className="startup-surface" aria-busy="true" aria-label="Loading session recovery">
            <PiaLoader variant="panel" tone="dark" label="Loading session recovery" announce={false} />
          </main>
        }
      >
        <AppSessionRecovery state={owner === 'session-timeout' ? 'timed-out' : 'unavailable'} />
      </Suspense>
    );
  }

  return (
    <StartupReadinessProvider value={readiness}>
      <div
        className={`startup-app-shell${applicationCovered ? ' is-covered' : ''}${
          applicationEntering ? ' is-entering' : ''
        }${applicationFirstReveal ? ' is-first-reveal' : ''}`}
        aria-hidden={applicationBlockedByLoader || undefined}
        inert={applicationBlockedByLoader || undefined}
      >
        {applicationMounted ? children : null}
      </div>
      {owner === 'loader' ? <StartupLoadingSurface phase={phase} /> : null}
      {owner === 'access-modal' && ACCESS_GATE_ENABLED ? (
        <AccessGate enabled preloadedIdentity={gateIdentity} onIdentityChange={setGateIdentity}>
          {null}
        </AccessGate>
      ) : null}
      {owner === 'first-open-modal' ? firstOpen.gate : null}
    </StartupReadinessProvider>
  );
}
