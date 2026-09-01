import { useEffect, useRef, useState } from 'react';

/** Fast startup work completes without ever painting a loader. */
export const STARTUP_LOADER_DELAY_MS = 160;

/** Once visible, the loader stays long enough to be perceived as one frame. */
export const STARTUP_LOADER_MINIMUM_MS = 240;

interface StartupLoaderClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof globalThis.setTimeout>;
  clearTimeout(timer: ReturnType<typeof globalThis.setTimeout>): void;
}

const browserClock: StartupLoaderClock = {
  now: Date.now,
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
};

export interface StartupLoaderPolicy {
  setPending(pending: boolean): void;
  dispose(): void;
}

/**
 * One visibility clock for the complete startup chain.
 *
 * `setPending(true)` may be repeated as native auth hands off to app-session
 * bootstrap and then identity/access resolution. Those adjacent states never
 * reset the reveal timer or remount the loader. Readiness is recorded by the
 * caller immediately; this policy governs only which surface owns the viewport.
 */
export function createStartupLoaderPolicy(
  onVisibleChange: (visible: boolean) => void,
  clock: StartupLoaderClock = browserClock
): StartupLoaderPolicy {
  let pending = false;
  let visible = false;
  let visibleAt = 0;
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const clearTimer = () => {
    if (timer === null) return;
    clock.clearTimeout(timer);
    timer = null;
  };

  const hide = () => {
    timer = null;
    if (pending || !visible) return;
    visible = false;
    visibleAt = 0;
    onVisibleChange(false);
  };

  return {
    setPending(nextPending) {
      if (nextPending === pending) return;
      pending = nextPending;
      clearTimer();

      if (pending) {
        if (visible) return;
        timer = clock.setTimeout(() => {
          timer = null;
          if (!pending || visible) return;
          visible = true;
          visibleAt = clock.now();
          onVisibleChange(true);
        }, STARTUP_LOADER_DELAY_MS);
        return;
      }

      if (!visible) return;
      const remaining = Math.max(0, STARTUP_LOADER_MINIMUM_MS - (clock.now() - visibleAt));
      if (remaining === 0) hide();
      else timer = clock.setTimeout(hide, remaining);
    },
    dispose() {
      pending = false;
      clearTimer();
    },
  };
}

export function useStartupLoaderPolicy(pending: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const policy = useRef<StartupLoaderPolicy | null>(null);

  useEffect(() => {
    const next = createStartupLoaderPolicy(setVisible);
    policy.current = next;
    return () => {
      next.dispose();
      if (policy.current === next) policy.current = null;
    };
  }, []);

  useEffect(() => {
    policy.current?.setPending(pending);
  }, [pending]);

  return visible;
}
