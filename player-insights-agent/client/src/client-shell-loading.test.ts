import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

/**
 * The first-paint import graph, held at its doors.
 *
 * Source assertions fit this contract better than rendered markup: a component
 * looks identical whether its module arrived in the entry chunk or on click,
 * while an eager import is the regression these tests must catch.
 */
describe('the client shell import graph', () => {
  it('keeps Ask eager and loads Connections inside its route boundary', () => {
    const app = source('App.tsx');
    expect(app).toContain("import { HomePage } from './HomePage'");
    expect(app).not.toContain("import { ConnectionsPage } from './ConnectionsPage'");
    expect(app).toMatch(/const ConnectionsPage = lazy\(\(\) => loadConnectionsPage\(\)/);
    expect(source('lazy-routes.ts')).toContain("loadConnectionsPage = () => import('./ConnectionsPage')");
    const route = app.slice(app.indexOf("path: '/connections'"), app.indexOf("path: '/architecture'"));
    expect(route).toContain('<LazyRoute>');
    expect(route).toContain('<ConnectionsPage />');
  });

  it('loads the Settings body only after the gear or deep link asks for it', () => {
    const layout = source('Layout.tsx');
    expect(layout).not.toContain("import { SettingsPage } from './SettingsPage'");
    expect(layout).toMatch(/const SettingsPage = lazy\(\(\) => import\('\.\/SettingsPage'\)/);
    expect(layout).toContain('<Suspense fallback={<SettingsFallback />}>');
    expect(layout).toContain('data-testid="settings-loading"');
  });

  /*
   * THE STYLESHEET IS ONE CASCADE AND IT IS DECLARED IN ONE FILE.
   *
   * These five partials were moved out of index.css into side-effect imports
   * inside the lazy page modules, to keep them out of Ask's entry chunk. It
   * shipped two faults, and this test is what would have caught both.
   *
   * timeline.css is not a route stylesheet. `TraceTimeline` is drawn by the
   * answer card on Ask and by the drawer on Monitoring, and neither imported
   * it, so the step timeline rendered with no rules at all on both surfaces
   * while Run Explorer -- the one route that did import it -- looked right.
   *
   * The rest changed cascade position. Vite appends a lazy chunk's CSS after
   * the entry stylesheet, so monitoring.css and ops.css landed AFTER
   * responsive.css and dark-mode.css instead of before them, and every tie
   * those two files settle by coming last was inverted.
   *
   * A page's stylesheet may only be split out again with a component-level
   * argument for why nothing outside that route can render its markup. Bundle
   * size is not that argument.
   */
  it('declares every partial in the entry cascade rather than behind a route', () => {
    const entry = source('index.css');
    const pageStyles = [
      'connections.css',
      'time-range.css',
      'monitoring.css',
      'ops.css',
      'architecture.css',
      'benchmark.css',
      'runs.css',
      'timeline.css',
    ];

    expect(entry).toContain("@import './styles/dark-mode.css'");
    for (const style of pageStyles) {
      expect(entry, `${style} is imported by index.css`).toContain(`@import './styles/${style}'`);
    }
  });

  /*
   * And the two that may not ALSO be imported by a module.
   *
   * A sheet imported by the entry and by a lazy chunk is one module either way,
   * so the duplicate is harmless and the remaining ones are left where the pages
   * that own them can tidy them up. These two are the ones that caused the fault
   * above: `timeline.css` because `TraceTimeline` is drawn on surfaces that are
   * not its route, and `monitoring.css` because the drawer's own rules have to
   * stay ahead of responsive.css.
   */
  it('keeps the two shared partials out of the page modules entirely', () => {
    expect(source('RunExplorer.tsx')).not.toContain('./styles/timeline.css');
    expect(source('BenchmarkLab.tsx')).not.toContain('./styles/timeline.css');
    expect(source('MonitoringPage.tsx')).not.toContain('./styles/monitoring.css');
  });

  /*
   * The two page partials that can be reached from outside their own route, in
   * the order the sheets that override them expect. `timeline.css` before
   * `dark-mode.css` is what lets the dark theme de-stack the timeline's panes
   * inside the answer card; `monitoring.css` before `responsive.css` is what
   * lets the narrow-window blocks reshape the page.
   */
  it('orders the shared page partials before the sheets written to override them', () => {
    const entry = source('index.css');
    const at = (name: string) => entry.indexOf(`@import './styles/${name}'`);
    expect(at('timeline.css')).toBeGreaterThan(-1);
    expect(at('timeline.css')).toBeLessThan(at('dark-mode.css'));
    expect(at('monitoring.css')).toBeLessThan(at('responsive.css'));
    expect(at('ops.css')).toBeLessThan(at('responsive.css'));
  });

  it('does not make every AppKit export reachable through the app barrel', () => {
    const ui = source('ui.ts');
    expect(ui).not.toMatch(/export\s+\*\s+from '@databricks\/appkit-ui\/react'/);
    for (const shellComponent of ['Alert', 'Button', 'Sheet', 'SheetContent']) {
      expect(ui).toMatch(new RegExp(`\\b${shellComponent},?`));
    }
  });

  it('keeps AppKit in a stable vendor chunk rather than app code', () => {
    const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    expect(vite).toContain("id.includes('/node_modules/@databricks/appkit-ui/')");
    expect(vite).toContain("return 'appkit-ui'");
  });
});
