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

  it('keeps route-only Architecture data behind its boundary without dropping shell motion', () => {
    const refresh = source('refresh-state.ts');
    const layout = source('Layout.tsx');

    expect(refresh).not.toContain("from './architecture'");
    expect(refresh).toContain('export function checkedAgo');
    expect(source('lazy-routes.ts')).toContain("loadArchitecturePage = () => import('./ArchitecturePage')");
    for (const eager of ['HomePage.tsx', 'AgentConstellation.tsx']) {
      expect(source(eager), `${eager} imports only the tiny benchmark formatters`).not.toContain(
        "from './benchmark-summary'"
      );
      expect(source(eager)).toContain("from './benchmark-format'");
    }
    expect(source('run-header.ts')).not.toContain("from './benchmark-summary'");

    expect(layout).toContain('startRouteEnter(page.current, browserMotionRuns())');
    expect(layout).toContain('className="route-transition-page"');
  });

  it('keeps shared primitives global and route-owned CSS behind lazy modules', () => {
    const entry = source('index.css');
    const routeStyles = [
      'connections.css',
      'monitoring.css',
      'ops.css',
      'architecture.css',
      'benchmark.css',
      'runs.css',
      'settings.css',
      'egress.css',
    ];

    expect(entry).toContain("@import './styles/dark-mode.css'");
    for (const style of routeStyles) {
      expect(entry, `${style} stays out of Ask's entry cascade`).not.toContain(`@import './styles/${style}'`);
    }
    for (const shared of ['timeline.css', 'trace.css', 'page-shell.css', 'summary-grid.css']) {
      expect(entry, `${shared} remains globally available`).toContain(`@import './styles/${shared}'`);
    }
    for (const answerOnly of ['answer-body.css', 'answer-charts.css']) {
      expect(entry, `${answerOnly} stays behind the lazy answer boundary`).not.toContain(
        `@import './styles/${answerOnly}'`
      );
      expect(source('AnswerCard.tsx')).toContain(`import './styles/${answerOnly}'`);
    }

    const owners = {
      'ArchitecturePage.tsx': 'architecture',
      'BenchmarkLab.tsx': 'benchmark',
      'ConnectionsPage.tsx': 'connections',
      'MonitoringPage.tsx': 'monitoring',
      'OpsPage.tsx': 'ops',
      'RunExplorer.tsx': 'runs',
      'SettingsPage.tsx': 'settings',
    };
    for (const [owner, route] of Object.entries(owners)) {
      expect(source(owner), `${owner} imports its CSS entry`).toContain(`./styles/routes/${route}.css`);
    }
    expect(source('TimeRangeControl.tsx')).toContain('./styles/routes/time-range.css');
  });

  it('preserves each route cascade as base, responsive, then dark', () => {
    const entry = source('index.css');
    const at = (name: string) => entry.indexOf(`@import './styles/${name}'`);
    expect(at('timeline.css')).toBeGreaterThan(-1);
    expect(at('timeline.css')).toBeLessThan(at('dark-mode.css'));

    for (const route of ['architecture', 'benchmark', 'connections', 'monitoring', 'ops', 'runs', 'settings']) {
      const css = readFileSync(new URL(`./styles/routes/${route}.css`, import.meta.url), 'utf8');
      const imports = [...css.matchAll(/@import '\.\.\/([^']+)'/g)].map((match) => match[1]);
      expect(imports[0]).toMatch(new RegExp(`^(?:${route}|${route === 'runs' ? 'runs' : route})\\.css$`));
      expect(imports.findIndex((name) => name.startsWith('responsive-'))).toBeLessThan(
        imports.findIndex((name) => name.startsWith('dark-'))
      );
    }
  });

  it('styles the Settings loading seat before its lazy CSS resolves', () => {
    const layout = source('Layout.tsx');
    expect(layout).toContain('settings-overlay fixed inset-0 z-50 grid place-items-center');
    expect(layout).toContain('rounded-lg border bg-background');
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
    expect(vite).toContain('manifest: true');
    expect(vite).toContain("id.includes('/node_modules/@databricks/appkit-ui/')");
    expect(vite).toContain("return 'appkit-ui'");
  });
});
