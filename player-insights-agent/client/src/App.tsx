import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { createBrowserRouter, RouterProvider, Navigate, useLocation } from 'react-router';
import { AccessGate } from './AccessGate';
import { ConnectionsPage } from './ConnectionsPage';
import { RouteError } from './RouteError';
import { AdminOnly } from './GatePanel';
import { HomePage } from './HomePage';
import { Layout } from './Layout';
import { BenchmarkingVisibility } from './BenchmarkingVisibility';
import { kickWarehouseWarmup } from './warehouse-warmup';
import { applyColorScheme, DEFAULT_COLOR_SCHEME } from './color-scheme';
import { useRuntimeEntityStyles } from './runtime-entity-styles';

/**
 * The five pages that are fetched when somebody opens them, not when the app
 * opens.
 *
 * ASK PIA IS DELIBERATELY NOT ONE OF THEM. It is the page nearly every visit
 * lands on, so splitting it would put a network round trip in front of the one
 * route that must be instant. Connections and Settings stay eager for the same
 * reason at a smaller scale: the storage banner links to Connections from every
 * page in the app, and the gear is one click from anywhere.
 *
 * These five are the opposite case. Monitoring and Ops are behind `AdminOnly`,
 * which renders nothing for a consumer -- so the import below is never even
 * requested for most readers -- and Run Explorer, Architecture and the Benchmark
 * Lab are each a page somebody opens on purpose, having already waited for the
 * app to load once.
 *
 * Named exports, hence the `.then`: `lazy` wants a module whose `default` is the
 * component, and nothing in this client uses default exports for pages.
 *
 * BenchmarkLab is referenced here BY PATH ONLY and its contents are somebody
 * else's work in flight; this file must not be the reason that file changes.
 */
const ArchitecturePage = lazy(() => import('./ArchitecturePage').then((loaded) => ({ default: loaded.ArchitecturePage })));
const BenchmarkLab = lazy(() => import('./BenchmarkLab').then((loaded) => ({ default: loaded.BenchmarkLab })));
const MonitoringPage = lazy(() => import('./MonitoringPage').then((loaded) => ({ default: loaded.MonitoringPage })));
const OpsPage = lazy(() => import('./OpsPage').then((loaded) => ({ default: loaded.OpsPage })));
const RunExplorer = lazy(() => import('./RunExplorer').then((loaded) => ({ default: loaded.RunExplorer })));

/**
 * What is on screen for the few milliseconds a page's own chunk is in flight.
 *
 * AN EMPTY PAGE SHELL AND NOTHING ELSE, on purpose. Every page this wraps has
 * just been built to a design, and a fallback with a heading, a spinner or a
 * skeleton grid would draw a DIFFERENT layout and then replace it -- which reads
 * as the page loading twice and is worse than the third of a second it saves.
 * `.page-shell` is the same grid container each of these pages opens with, so
 * the only thing that happens when the real page arrives is that content
 * appears inside a box that was already the right shape.
 *
 * `aria-busy` rather than a live region: a screen reader is told the region is
 * working, without an announcement that would be superseded before it finished
 * being read.
 */
function RouteFallback() {
  return <div className="page-shell" data-testid="route-loading" aria-busy="true" />;
}

/**
 * One Suspense boundary per route rather than one around the router.
 *
 * A single boundary higher up would suspend the LAYOUT -- header, navigation,
 * the first-open gate and the storage banner -- every time somebody clicked a
 * tab, so the whole frame would blink on navigation. Boundaries here are inside
 * `Layout`'s outlet, so the frame is painted once and only the body waits.
 *
 * For the two admin pages this sits INSIDE `AdminOnly`, which is what keeps the
 * import from being requested at all for a reader who is not an administrator.
 */
function LazyRoute({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

// AppKit flips its palette under `@media (prefers-color-scheme: dark)` via
// `:root:not(.light)`. That is not this app's theme: `.light` stays on so OS
// Dark Mode cannot repaint AppKit, and `data-theme` is what we paint from.
applyColorScheme(DEFAULT_COLOR_SCHEME);

/**
 * A moved page, without losing what the URL was asking for.
 *
 * `<Navigate to="/somewhere">` drops the search string, which for `/sources` is
 * the whole point of the link: `?entity=<table>` is what tells the destination
 * which row to scroll to and highlight.
 */
function RedirectKeepingQuery({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={`${to}${search}${hash}`} replace />;
}

/**
 * Every route carries its own error element.
 *
 * Without one, React Router falls back to its built-in development page (the one
 * addressed to "Hey developer", printing a stack trace), and it does so for the
 * whole route. The app's own `ErrorBoundary` in main.tsx never got the chance,
 * because the router's per-route boundary catches first.
 */
const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { path: '/', element: <HomePage />, errorElement: <RouteError /> },
      // Wrapped rather than branched here, so a pasted `/benchmarks` link reads
      // the same live setting the tab does and is sent to Ask while Benchmarking
      // is off. Components and server routes stay in the tree either way.
      {
        path: '/benchmarks',
        element: <BenchmarkingVisibility><LazyRoute><BenchmarkLab /></LazyRoute></BenchmarkingVisibility>,
        errorElement: <RouteError />,
      },
      { path: '/runs', element: <LazyRoute><RunExplorer /></LazyRoute>, errorElement: <RouteError /> },
      // THE THREE ADMIN ROUTES, and the wrapper is the whole of what makes them
      // different from the routes above.
      //
      // Registered for everybody, because hiding a navigation entry and breaking
      // a URL are different decisions and only the first was asked for. The
      // permission is not here either way: every /api/monitoring, /api/ops and
      // /api/admins route answers a consumer with 403, and that refusal is the
      // permission model.
      //
      // What `AdminOnly` adds is the sentence. A consumer who follows a link an
      // administrator sent them used to get the whole page frame and then
      // whatever each block makes of a 403 -- on Ops, three "could not be read"
      // panels over a retry button that could never work. Now they get the panel
      // section 3 of the plan specifies. Wrapped HERE rather than inside each
      // page so there is one decision for all three, and so the wrapper reads
      // the page's name from the same record that decides which paths are admin
      // paths.
      { path: '/monitoring', element: <AdminOnly><LazyRoute><MonitoringPage /></LazyRoute></AdminOnly>, errorElement: <RouteError /> },
      { path: '/ops', element: <AdminOnly><LazyRoute><OpsPage /></LazyRoute></AdminOnly>, errorElement: <RouteError /> },
      { path: '/settings', element: <AdminOnly><HomePage /></AdminOnly>, errorElement: <RouteError /> },
      { path: '/connections', element: <ConnectionsPage />, errorElement: <RouteError /> },
      // The same connections as a diagram. Registered before the nav advertises
      // it, for the reason /benchmarks is: a URL that works is not contingent on
      // a header entry existing.
      // Its Refresh results survive leaving the tab and coming back, and being
      // code-split does not change that: the results live in the session store
      // `session-checks.ts` holds, outside any component, so this route's chunk
      // arriving late means the page mounts late -- not that it mounts empty.
      { path: '/architecture', element: <LazyRoute><ArchitecturePage /></LazyRoute>, errorElement: <RouteError /> },
      // Sources & Capabilities was merged into Connections: it reported the same
      // preflight the settings route already runs, and the two pages were
      // indistinguishable to the people they were for. The redirect carries the
      // query string because every entity link an answer has ever rendered
      // points at `/sources?entity=<table>`, and dropping it would land a reader
      // on the right page with nothing highlighted.
      { path: '/sources', element: <RedirectKeepingQuery to="/connections" /> },
      // First-run setup was removed. A bookmark lands on the page that still
      // shows this deployment's configuration rather than on an error.
      { path: '/setup', element: <Navigate to="/connections" replace /> },
    ],
  },
]);

export default function App() {
  // Adopt the saved Appearance settings at the shell, not only after an answer
  // mounts an entity link. This preserves the dark first paint while allowing a
  // saved Light choice to take over on every route.
  useRuntimeEntityStyles();

  // After the first paint, while the opening concepts and login gate occupy the
  // screen, ask the server to start the SQL warehouse. This is independent of
  // the Ask page's preflight/readiness request: that page may not mount until
  // after a gate decision, and its agent-side dependency report is retired.
  // `kickWarehouseWarmup` returns void and swallows the request failure, so this
  // can neither delay nor refuse login.
  useEffect(() => {
    kickWarehouseWarmup();
  }, []);

  // Outside the router on purpose: the choice is about the session rather than
  // about a page, and asking again on every navigation would train people to
  // dismiss it without reading, which is the opposite of what it is for.
  return (<AccessGate>
      <RouterProvider router={router} />
    </AccessGate>
  );
}
