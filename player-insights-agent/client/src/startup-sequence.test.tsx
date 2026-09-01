import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionReport } from '../../shared/session-contract';
import { AccessGate, type GateIdentity } from './AccessGate';
import { FirstOpenGate } from './FirstOpenGate';
import { StartupLoadingSurface, startupPhase, startupSurfaceOwner, type StartupSnapshot } from './StartupBoundary';
import type { Identity } from './app-types';
import { bootstrapAppSession, resetAppSessionForTests } from './app-session';
import { forgetIdentityRequest, identityRequest } from './app-state';
import { forgetFirstOpen } from './first-open';
import { STARTUP_LOADER_DELAY_MS, STARTUP_LOADER_MINIMUM_MS, createStartupLoaderPolicy } from './startup-loader-policy';

const startupSource = readFileSync(new URL('./StartupBoundary.tsx', import.meta.url), 'utf8');
const indexShell = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const base: StartupSnapshot = {
  nativeAuthReturned: false,
  appSession: 'booting',
  identityResolved: false,
  accessDecisionRequired: false,
  firstOpen: 'pending',
};

function session(over: Partial<SessionReport> = {}): SessionReport {
  return {
    state: 'current',
    signedIn: true,
    tokenScopes: ['serving.serving-endpoints', 'model-serving', 'sql', 'dashboards.genie'],
    declaredScopes: ['serving.serving-endpoints', 'model-serving', 'sql', 'dashboards.genie'],
    missingScopes: [],
    cause: 'session-current',
    evidence: 'current',
    explanation: 'current',
    remedy: null,
    ...over,
  };
}

function identity(over: Partial<Identity> = {}): Identity {
  return {
    signedInAs: 'reader@example.com',
    executionIdentity: 'reader@example.com',
    executionMode: 'user',
    identitySource: 'databricks-apps',
    session: session(),
    ...over,
  } as Identity;
}

function gateIdentity(over: Partial<GateIdentity> = {}): GateIdentity {
  return {
    signedInAs: 'reader@example.com',
    identitySource: 'databricks-apps',
    executionIdentity: 'reader@example.com',
    executionMode: 'user-verified',
    accessDecision: null,
    servingPrincipal: null,
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetAppSessionForTests();
  forgetIdentityRequest();
  forgetFirstOpen();
});

describe('authoritative startup sequence', () => {
  it('orders native return, session bootstrap, access resolution, first-open, and readiness', () => {
    const frames: StartupSnapshot[] = [
      base,
      { ...base, nativeAuthReturned: true },
      { ...base, nativeAuthReturned: true, appSession: 'ready' },
      { ...base, nativeAuthReturned: true, appSession: 'ready', identityResolved: true, firstOpen: 'gate' },
      { ...base, nativeAuthReturned: true, appSession: 'ready', identityResolved: true, firstOpen: 'open' },
    ];

    expect(frames.map(startupPhase)).toEqual([
      'native-auth-pending',
      'app-session-bootstrap',
      'access-bootstrap',
      'first-open',
      'application-ready',
    ]);
  });

  it('inserts an access decision before FirstOpen when authorization is required', () => {
    expect(
      startupPhase({
        ...base,
        nativeAuthReturned: true,
        appSession: 'ready',
        identityResolved: true,
        accessDecisionRequired: true,
        firstOpen: 'gate',
      })
    ).toBe('access-decision');
  });

  it('records bootstrap failures immediately and returns retry to the same loader state', () => {
    expect(startupPhase({ ...base, nativeAuthReturned: true, appSession: 'unavailable' })).toBe('unavailable');
    expect(startupPhase({ ...base, nativeAuthReturned: true, appSession: 'booting' })).toBe('app-session-bootstrap');
  });

  it('keeps every phase under exactly one viewport owner', () => {
    const owners = [
      startupSurfaceOwner('native-auth-pending', false),
      startupSurfaceOwner('app-session-bootstrap', true),
      startupSurfaceOwner('access-bootstrap', true),
      startupSurfaceOwner('access-decision', false),
      startupSurfaceOwner('first-open', false),
      startupSurfaceOwner('application-ready', false),
    ];
    expect(owners).toEqual(['loader', 'loader', 'loader', 'access-modal', 'first-open-modal', 'application']);
  });
});

describe('startup loader timing', () => {
  it('never paints for a fast boundary', () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const policy = createStartupLoaderPolicy((visible) => changes.push(visible));

    policy.setPending(true);
    vi.advanceTimersByTime(STARTUP_LOADER_DELAY_MS - 1);
    policy.setPending(false);
    vi.runAllTimers();

    expect(changes).toEqual([]);
  });

  it('uses one reveal clock across adjacent pending states and one minimum hold after painting', () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const policy = createStartupLoaderPolicy((visible) => changes.push(visible));

    policy.setPending(true);
    vi.advanceTimersByTime(STARTUP_LOADER_DELAY_MS);
    expect(changes).toEqual([true]);

    // Native auth -> app session -> identity remains one pending episode.
    policy.setPending(true);
    vi.advanceTimersByTime(STARTUP_LOADER_MINIMUM_MS);
    policy.setPending(false);
    vi.runAllTimers();
    expect(changes).toEqual([true, false]);
  });

  it('holds a freshly painted loader only for the remainder of the minimum', () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const policy = createStartupLoaderPolicy((visible) => changes.push(visible));

    policy.setPending(true);
    vi.advanceTimersByTime(STARTUP_LOADER_DELAY_MS);
    policy.setPending(false);
    vi.advanceTimersByTime(STARTUP_LOADER_MINIMUM_MS - 1);
    expect(changes).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([true, false]);
  });
});

describe('frame ownership', () => {
  it('mounts at most one Astrolabe symbol in every loader frame', () => {
    for (const phase of ['native-auth-pending', 'app-session-bootstrap', 'access-bootstrap'] as const) {
      const hidden = renderToStaticMarkup(<StartupLoadingSurface visible={false} phase={phase} />);
      const visible = renderToStaticMarkup(<StartupLoadingSurface visible phase={phase} />);
      expect(hidden.match(/data-startup-symbol/g) ?? []).toHaveLength(0);
      expect(visible.match(/data-startup-symbol/g) ?? []).toHaveLength(1);
    }
  });

  it('renders no protected child or route loader behind the access modal', () => {
    const markup = renderToStaticMarkup(
      <AccessGate enabled preloadedIdentity={gateIdentity()}>
        <div data-testid="route-loading">protected</div>
      </AccessGate>
    );
    expect(markup).toContain('Access check');
    expect(markup).not.toContain('route-loading');
    expect(markup).not.toContain('data-startup-symbol');
  });

  it('renders FirstOpen directly, with no startup or route loader behind it', () => {
    const markup = renderToStaticMarkup(<FirstOpenGate identity={identity()} />);
    expect(markup).toContain('role="dialog"');
    expect(markup).not.toContain('route-loading');
    expect(markup).not.toContain('data-startup-symbol');
    expect(markup).not.toContain('ast-opening');
  });

  it('renders access-denied and unread authorization as stable modal states', () => {
    const missing = renderToStaticMarkup(
      <FirstOpenGate
        identity={identity({ session: session({ state: 'stale', missingScopes: ['dashboards.genie'] }) })}
      />
    );
    const unread = renderToStaticMarkup(
      <FirstOpenGate identity={identity({ session: session({ state: 'undetermined', tokenScopes: null }) })} />
    );
    for (const markup of [missing, unread]) {
      expect(markup).toContain('role="dialog"');
      expect(markup).not.toContain('data-startup-symbol');
      expect(markup.match(/role="dialog"/g)).toHaveLength(1);
    }
  });

  it('keeps the index shell blank and color-stable across native authorization redirects', () => {
    expect(indexShell).toContain('<div id="root"></div>');
    expect(indexShell).not.toContain('data-startup-symbol');
    expect(indexShell).toContain("html[data-theme='dark'] body");
  });

  it('does not mount protected children anywhere except the application owner', () => {
    expect(startupSource).toMatch(/if \(owner === 'first-open-modal'\) return firstOpen\.gate;\s*return children;/);
  });
});

describe('StrictMode replay', () => {
  it('deduplicates app-session bootstrap and identity reads', async () => {
    const bootstrapFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const first = bootstrapAppSession(bootstrapFetch);
    const second = bootstrapAppSession(bootstrapFetch);
    await Promise.all([first, second]);
    expect(bootstrapFetch).toHaveBeenCalledTimes(1);

    const identityFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ signedInAs: 'reader@example.com' }),
    });
    vi.stubGlobal('fetch', identityFetch);
    await Promise.all([identityRequest(), identityRequest()]);
    expect(identityFetch).toHaveBeenCalledTimes(1);
  });

  it('uses static startup and modal surfaces under reduced motion and Animations Off', () => {
    const loader = renderToStaticMarkup(<StartupLoadingSurface visible phase="app-session-bootstrap" />);
    const firstOpen = renderToStaticMarkup(<FirstOpenGate identity={identity()} />);
    expect(loader).not.toContain('ast-anim-');
    expect(firstOpen).not.toContain('ast-anim-');
    expect(startupSource).not.toContain('OpeningSequence');
    expect(startupSource).not.toContain('ConceptFlicker');
  });
});
