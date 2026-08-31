import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { composerClearance, observeComposerClearance, type ComposerClearanceEnvironment } from './composer-clearance';

function elements(rect: { height: number; bottom: number }) {
  const values = new Map<string, string>();
  const scope = {
    style: {
      setProperty: (name: string, value: string) => values.set(name, value),
      removeProperty: (name: string) => values.delete(name),
    },
  } as unknown as HTMLElement;
  const composer = {
    getBoundingClientRect: () => rect,
  } as unknown as HTMLElement;
  return { composer, scope, values };
}

describe('composer clearance geometry', () => {
  it('prefers ResizeObserver and retains a mutation fallback for growing attachments', () => {
    const source = readFileSync(new URL('./composer-clearance.ts', import.meta.url), 'utf8');
    expect(source).toContain("typeof ResizeObserver === 'function'");
    expect(source).toContain('new ResizeObserver(listener)');
    expect(source).toContain("typeof MutationObserver === 'function'");
    expect(source).toContain('new MutationObserver(listener)');
  });

  it('includes the measured height, viewport inset, and reading gap', () => {
    expect(composerClearance({ height: 180, bottom: 760 }, 800)).toBe(236);
  });

  it('updates when attachments change the observed composer height', () => {
    const rect = { height: 104, bottom: 780 };
    const { composer, scope, values } = elements(rect);
    let observed: (() => void) | undefined;
    let stopped = false;
    const environment: ComposerClearanceEnvironment = {
      viewportHeight: () => 800,
      listenViewport: () => () => {},
      observeElement: (_element, listener) => {
        observed = listener;
        return () => {
          stopped = true;
        };
      },
    };

    const cleanup = observeComposerClearance(scope, composer, environment);
    expect(values.get('--composer-reserve')).toBe('140px');

    rect.height = 236;
    observed?.();
    expect(values.get('--composer-reserve')).toBe('272px');

    cleanup();
    expect(stopped).toBe(true);
    expect(values.has('--composer-reserve')).toBe(false);
  });

  it('remeasures from the viewport listener when element observers are unavailable', () => {
    const rect = { height: 104, bottom: 780 };
    const { composer, scope, values } = elements(rect);
    let viewportHeight = 800;
    let resized: (() => void) | undefined;
    let stopped = false;
    const environment: ComposerClearanceEnvironment = {
      viewportHeight: () => viewportHeight,
      listenViewport: (listener) => {
        resized = listener;
        return () => {
          stopped = true;
        };
      },
    };

    const cleanup = observeComposerClearance(scope, composer, environment);
    viewportHeight = 860;
    resized?.();

    expect(values.get('--composer-reserve')).toBe('200px');
    cleanup();
    expect(stopped).toBe(true);
  });
});
