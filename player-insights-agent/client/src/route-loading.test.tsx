import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RouteSkeleton } from './RouteFallback';
import { ROUTE_SKELETON_DELAY_MS, scheduleRouteSkeleton } from './route-fallback-delay';

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

afterEach(() => {
  vi.useRealTimers();
});

describe('lazy route loading', () => {
  it('delays the visual skeleton to avoid flashing on fast chunk loads', () => {
    vi.useFakeTimers();
    const show = vi.fn();

    scheduleRouteSkeleton(show);
    vi.advanceTimersByTime(ROUTE_SKELETON_DELAY_MS - 1);
    expect(show).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledOnce();
  });

  it('announces loading immediately without presenting fake data', () => {
    const waiting = renderToStaticMarkup(<RouteSkeleton visible={false} />);
    const visible = renderToStaticMarkup(<RouteSkeleton visible />);

    expect(waiting).toContain('class="page-shell route-skeleton-shell"');
    expect(waiting).toContain('aria-busy="true"');
    expect(waiting).toContain('aria-label="Loading view"');
    expect(waiting).toContain('role="status"');
    expect(waiting).not.toContain('route-skeleton-heading');
    expect(visible).toContain('aria-hidden="true"');
    expect(visible).not.toMatch(/player|run count|revenue|sample/i);
  });

  it('reserves the route canvas and disables its only transition for reduced motion', () => {
    const css = source('styles/page-shell.css');

    expect(css).toMatch(/\.route-skeleton-shell\s*\{[^}]*min-height:\s*calc\(100vh - var\(--app-header-h\)\)/s);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.route-skeleton\s*\{\s*transition:\s*none;/s
    );
  });

  it('keeps app-owned error UI on every lazy route', () => {
    const app = source('App.tsx');
    for (const path of ['/benchmarks', '/runs', '/monitoring', '/ops', '/connections', '/architecture']) {
      const route = app.slice(app.indexOf(`path: '${path}'`));
      expect(route.slice(0, route.indexOf('},') + 2), path).toContain('errorElement: <RouteError />');
    }
  });

  it('prefetches only on hover or focus through public module imports', () => {
    const layout = source('Layout.tsx');
    const loaders = source('lazy-routes.ts');

    expect(layout).toContain('onMouseEnter={() => prefetchLazyRoute(entry.to)}');
    expect(layout).toContain('onFocus={() => prefetchLazyRoute(entry.to)}');
    expect(loaders).toContain("loadRunExplorer = () => import('./RunExplorer')");
    expect(layout).not.toMatch(/router\.(?:routes|manifest)/);
    expect(layout).not.toMatch(/_payload|_result|preload\(/);
  });
});
