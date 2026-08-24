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
    expect(app).toMatch(/const ConnectionsPage = lazy\(\(\) => import\('\.\/ConnectionsPage'\)/);
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
