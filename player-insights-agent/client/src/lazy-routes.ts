/**
 * The shared public import functions for lazy rendering and intent prefetch.
 *
 * Calling the same dynamic import on hover/focus lets the browser's module
 * cache satisfy React.lazy on navigation. No React or router internals are
 * inspected, and no route is fetched merely because the shell rendered.
 */
export const loadArchitecturePage = () => import('./ArchitecturePage');
export const loadBenchmarkLab = () => import('./BenchmarkLab');
export const loadConnectionsPage = () => import('./ConnectionsPage');
export const loadMonitoringPage = () => import('./MonitoringPage');
export const loadOpsPage = () => import('./OpsPage');
export const loadRunExplorer = () => import('./RunExplorer');

const ROUTE_LOADERS: Readonly<Record<string, () => Promise<unknown>>> = {
  '/architecture': loadArchitecturePage,
  '/benchmarks': loadBenchmarkLab,
  '/connections': loadConnectionsPage,
  '/monitoring': loadMonitoringPage,
  '/ops': loadOpsPage,
  '/runs': loadRunExplorer,
};

const pendingPrefetches = new Map<string, Promise<void>>();

export function prefetchLazyRoute(path: string): void {
  const loader = ROUTE_LOADERS[path];
  if (!loader || pendingPrefetches.has(path)) return;

  const request = loader().then(() => undefined);
  pendingPrefetches.set(path, request);
  void request.catch(() => {
    pendingPrefetches.delete(path);
  });
}
