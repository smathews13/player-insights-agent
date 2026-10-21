import { describe, expect, it, vi } from 'vitest';

import { isStaleBuildError, reloadOnceForStaleBuild, STALE_BUILD_RELOAD_WINDOW_MS } from './stale-build';

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe('isStaleBuildError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://app/assets/export-actions-abc.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
  ])('recognises %s', (message) => {
    expect(isStaleBuildError(new Error(message))).toBe(true);
  });

  it('does not take any other failure for a stale page', () => {
    expect(isStaleBuildError(new Error('Plotly rejected the spec'))).toBe(false);
    expect(isStaleBuildError(null)).toBe(false);
  });
});

describe('reloadOnceForStaleBuild', () => {
  it('reloads the first time and not again inside the window', () => {
    const reload = vi.fn();
    const store = memoryStore();
    expect(reloadOnceForStaleBuild({ store, reload, now: () => 1_000 })).toBe(true);
    expect(reloadOnceForStaleBuild({ store, reload, now: () => 1_000 + STALE_BUILD_RELOAD_WINDOW_MS - 1 })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('may reload again once the window has passed', () => {
    const reload = vi.fn();
    const store = memoryStore();
    reloadOnceForStaleBuild({ store, reload, now: () => 1_000 });
    expect(reloadOnceForStaleBuild({ store, reload, now: () => 1_000 + STALE_BUILD_RELOAD_WINDOW_MS })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('never loops when it cannot remember that it reloaded', () => {
    const reload = vi.fn();
    expect(reloadOnceForStaleBuild({ store: null, reload })).toBe(false);
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(reloadOnceForStaleBuild({ store: broken, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
