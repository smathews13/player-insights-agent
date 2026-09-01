import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SessionReport } from '../../shared/session-contract';
import { FirstOpenPanel } from './FirstOpenGate';
import type { Identity } from './app-types';
import { firstOpenReport } from './first-open';
import {
  SURFACE_TRANSITION_MS,
  ROUTE_ENTER_KEYFRAMES,
  ROUTE_ENTER_OPTIONS,
  completeLoginHandoff,
  focusAfterLogin,
  initialLoginHandoff,
  motionRuns,
  readyLoginHandoff,
  requestLoginHandoff,
  startRouteEnter,
} from './motion-transitions';

const CSS = readFileSync(new URL('./styles/app-session.css', import.meta.url), 'utf8');
const APPEARANCE = readFileSync(new URL('./styles/appearance-preferences.css', import.meta.url), 'utf8');

function session(): SessionReport {
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
  };
}

function report() {
  return firstOpenReport({
    signedInAs: 'reader@example.com',
    executionMode: 'user',
    identitySource: 'databricks-apps',
    session: session(),
  } as Identity);
}

describe('login to Ask handoff', () => {
  it('waits for a stable shell before starting its single 180ms exit', () => {
    const requested = requestLoginHandoff(initialLoginHandoff(false), {
      shellReady: false,
      animate: true,
    });
    expect(requested.stage).toBe('waiting-for-shell');

    const leaving = readyLoginHandoff(requested, true);
    expect(leaving.stage).toBe('leaving');
    expect(SURFACE_TRANSITION_MS).toBe(180);
    expect(completeLoginHandoff(leaving, leaving.generation).stage).toBe('open');
  });

  it('ignores stale completion and lets the newest generation win', () => {
    const first = requestLoginHandoff(initialLoginHandoff(false), { shellReady: true, animate: true });
    const staleGeneration = first.generation - 1;
    expect(completeLoginHandoff(first, staleGeneration)).toEqual(first);
    expect(completeLoginHandoff(first, first.generation).stage).toBe('open');
  });

  it('cuts directly to the resting state for both motion vetoes', () => {
    expect(motionRuns({ animations: 'off', reducedMotion: false })).toBe(false);
    expect(motionRuns({ animations: 'on', reducedMotion: true })).toBe(false);
    expect(motionRuns({ animations: 'on', reducedMotion: false })).toBe(true);

    const off = requestLoginHandoff(initialLoginHandoff(false), { shellReady: true, animate: false });
    expect(off.stage).toBe('open');
  });

  it('disables the fading gate before the shell can receive focus or pointer input', () => {
    const markup = renderToStaticMarkup(
      <FirstOpenPanel
        report={report()}
        leaving
        onContinue={() => undefined}
        onRefresh={() => undefined}
        onSkip={() => undefined}
      />
    );
    expect(markup).toContain('first-open on-sky is-leaving');
    expect(markup).toContain('disabled=""');
    expect(CSS).toMatch(/\.first-open\.is-leaving\s*\{[^}]*pointer-events:\s*none/s);
  });

  it('moves focus only through the registered Ask target after completion', () => {
    const focus = vi.fn();
    focusAfterLogin(null);
    focusAfterLogin(focus);
    expect(focus).toHaveBeenCalledOnce();
  });
});

describe('top-level route motion', () => {
  function target() {
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }) as unknown as Animation);
    return { cancel, animate, target: { animate } };
  }

  it('does not animate an initial deep link or any motion-vetoed change', () => {
    const fake = target();
    expect(startRouteEnter(fake.target, false)).toBeUndefined();
    expect(fake.animate).not.toHaveBeenCalled();
  });

  it('cancels a superseded click or back-forward animation before starting the winner', () => {
    const stale = target();
    const current = target();
    const cancelStale = startRouteEnter(stale.target, true);
    cancelStale?.();
    const cancelCurrent = startRouteEnter(current.target, true);

    expect(stale.cancel).toHaveBeenCalledOnce();
    expect(current.animate).toHaveBeenCalledOnce();
    expect(current.cancel).not.toHaveBeenCalled();
    cancelCurrent?.();
    expect(current.cancel).toHaveBeenCalledOnce();
  });

  it('uses opacity and a two-pixel transform for 180ms, with no layout animation', () => {
    expect(ROUTE_ENTER_OPTIONS).toEqual({ duration: 180, easing: 'ease-out' });
    expect(ROUTE_ENTER_KEYFRAMES).toEqual([
      { opacity: 0.72, transform: 'translateY(2px)' },
      { opacity: 1, transform: 'none' },
    ]);
    expect(CSS).not.toMatch(/transition:\s*all/);
  });

  it('shares the same explicit and system motion vetoes as login', () => {
    const fake = target();
    startRouteEnter(fake.target, motionRuns({ animations: 'off', reducedMotion: false }));
    startRouteEnter(fake.target, motionRuns({ animations: 'on', reducedMotion: true }));
    expect(fake.animate).not.toHaveBeenCalled();
    expect(APPEARANCE).toContain("html[data-animations='off'] *");
  });
});
