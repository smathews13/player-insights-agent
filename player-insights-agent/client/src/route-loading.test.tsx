import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RouteFallback, RouteSkeleton } from './RouteFallback';

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

describe('lazy route loading', () => {
  it('renders stable placeholder geometry immediately instead of a blank frame', () => {
    const markup = renderToStaticMarkup(<RouteFallback />);
    expect(markup).toContain('route-skeleton-shell is-visible');
    expect(markup).toContain('route-skeleton-heading');
    expect(markup).toContain('route-skeleton-panel');
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

  it('reserves the route canvas and never animates skeletons independently', () => {
    const css = source('styles/page-shell.css');

    expect(css).toMatch(/\.route-skeleton-shell\s*\{[^}]*min-height:\s*calc\(100vh - var\(--app-header-h\)\)/s);
    expect(css.match(/\.route-skeleton\s*\{[^}]*\}/s)?.[0]).not.toMatch(/animation|transition/);
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
