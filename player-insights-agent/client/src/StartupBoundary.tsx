/* eslint-disable react-refresh/only-export-components -- startup state, policy, and blocking boundary are one contract */
import { useEffect, useState, type ReactNode } from 'react';
import { ACCESS_GATE_ENABLED } from '../../shared/access-gate';
import { AccessGate, gateIdentityFromResponse, requiresAccessDecision, type GateIdentity } from './AccessGate';
import { AstrolabeMark } from './AstrolabeMark';
import { useFirstOpen, type FirstOpenStage } from './FirstOpenGate';
import {
  SessionTimedOut,
  SessionUnavailable,
  bootstrapAppSession,
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
import { useStartupLoaderPolicy } from './startup-loader-policy';

export type StartupPhase =
  | 'native-auth-pending'
  | 'app-session-bootstrap'
  | 'access-bootstrap'
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
  if (snapshot.firstOpen !== 'open') return 'first-open';
  return 'application-ready';
}

export function startupIsPending(phase: StartupPhase): boolean {
  return phase === 'native-auth-pending' || phase === 'app-session-bootstrap' || phase === 'access-bootstrap';
}

export type StartupSurfaceOwner =
  | 'loader'
  | 'session-timeout'
  | 'session-error'
  | 'access-modal'
  | 'first-open-modal'
  | 'application';

export function startupSurfaceOwner(phase: StartupPhase, loaderVisible: boolean): StartupSurfaceOwner {
  if (startupIsPending(phase) || loaderVisible) return 'loader';
  if (phase === 'timed-out') return 'session-timeout';
  if (phase === 'unavailable') return 'session-error';
  if (phase === 'access-decision') return 'access-modal';
  if (phase === 'first-open') return 'first-open-modal';
  return 'application';
}

const resolvingIdentity: Identity = {
  signedInAs: 'Resolving signed-in user…',
  executionIdentity: 'Astrolabe service principal',
  executionMode: 'service-principal',
};

export function StartupLoadingSurface({ visible, phase }: { visible: boolean; phase: StartupPhase }) {
  const label = phase === 'access-bootstrap' ? 'Verifying access' : 'Starting secure app session';
  return (
    <main
      className={`startup-surface${visible ? ' is-visible' : ''}`}
      data-startup-phase={phase}
      aria-busy="true"
      aria-label={label}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {label}
      </p>
      {visible ? (
        <div className="startup-loader" aria-hidden="true">
          <span data-startup-symbol>
            <AstrolabeMark size={64} ink="dark" />
          </span>
          <span>{label}</span>
        </div>
      ) : null}
    </main>
  );
}

export function StartupBoundary({ children }: { children: ReactNode }) {
  const appSession = useAppSessionState();
  const [identity, setIdentity] = useState<Identity>(resolvingIdentity);
  const [identityResolved, setIdentityResolved] = useState(false);
  const [gateIdentity, setGateIdentity] = useState<GateIdentity | null>(null);
  const firstOpen = useFirstOpen(identity);

  useEffect(() => {
    void bootstrapAppSession();
  }, []);

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
  const phase = startupPhase({
    // If this module is executing, the native Apps authorization redirect has
    // already returned the document. The preceding blank index shell represents
    // the external pending state without mounting a competing symbol.
    nativeAuthReturned: true,
    appSession,
    identityResolved,
    accessDecisionRequired,
    firstOpen: firstOpen.stage,
  });
  const pending = startupIsPending(phase);
  const loaderVisible = useStartupLoaderPolicy(pending);
  const owner = startupSurfaceOwner(phase, loaderVisible);

  // If a delayed loader has appeared, it keeps the viewport through its minimum
  // display window. The authoritative phase above still advances immediately.
  if (owner === 'loader') return <StartupLoadingSurface visible={loaderVisible} phase={phase} />;
  if (owner === 'session-timeout') return <SessionTimedOut />;
  if (owner === 'session-error') return <SessionUnavailable />;
  if (owner === 'access-modal' && ACCESS_GATE_ENABLED) {
    return (
      <AccessGate enabled preloadedIdentity={gateIdentity} onIdentityChange={setGateIdentity}>
        {null}
      </AccessGate>
    );
  }
  if (owner === 'first-open-modal') return firstOpen.gate;
  return children;
}
