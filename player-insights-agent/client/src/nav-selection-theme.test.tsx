import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { NavLinks } from './Layout';
import { NO_EXPERIMENTS } from './experimental-features';
import type { RoleResolution } from './role';
import { partial } from './styles/stylesheet';

const SHELL = partial('shell.css');
const RAIL = partial('rail.css');
const RUNS = partial('runs.css');
const SETTINGS = partial('settings.css');
const DARK = partial('dark-mode.css');
const DARK_SETTINGS = partial('dark-settings.css');
const TOKENS = partial('tokens.css');

const ADMIN: RoleResolution = { state: 'admin', addedAdminsReadable: true };
const TABS = [
  ['/', 'Ask'],
  ['/runs', 'Run Explorer'],
  ['/monitoring', 'Monitoring'],
  ['/ops', 'Ops'],
  ['/connections', 'Connections'],
  ['/architecture', 'Architecture'],
  ['/benchmarks', 'Benchmarking'],
] as const;

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

function renderNav(route: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[route]}>
      <NavLinks linkClass={() => 'app-nav-tab'} role={ADMIN} features={{ ...NO_EXPERIMENTS, benchmarkLab: true }} />
    </MemoryRouter>
  );
}

describe('global navigation selection', () => {
  it('renders every primary destination with one selected icon and label', () => {
    for (const [route, label] of TABS) {
      const markup = renderNav(route);
      expect(markup.match(/class="app-nav-tab"/g)).toHaveLength(TABS.length);
      expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
      const selected = markup.match(/<a[^>]*aria-current="page"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? '';
      expect(selected).toContain('<svg');
      expect(selected).toContain(label);
    }
  });

  it('uses the selected Ask rail border token for label, icon, and underline', () => {
    const railSelected = rule(RAIL, '.conversation-row.active');
    const navSelected = rule(SHELL, ".app-nav-tab[aria-current='page']");
    expect(railSelected).toContain('border-color: var(--primary)');
    expect(navSelected).toContain('border-bottom-color: var(--primary)');
    expect(navSelected).toContain('color: var(--primary)');
    expect(rule(SHELL, '.app-nav-tab svg')).toMatch(/color:\s*inherit[\s\S]*stroke:\s*currentColor/);
  });

  it('keeps hover neutral and square-free while focus remains a separate ring', () => {
    const hover = rule(SHELL, '.app-nav-tab:hover');
    const focus = rule(SHELL, '.app-nav-tab:focus-visible');
    expect(hover).toContain('color: var(--foreground)');
    expect(hover).toContain('background: transparent');
    expect(hover).not.toMatch(/border-radius|box-shadow|outline/);
    expect(focus).toContain('outline: 2px solid var(--ring)');
    expect(focus).toContain('border-bottom-color: transparent');
    expect(focus).toContain('color: var(--foreground)');
    expect(focus).not.toContain('color: var(--primary)');
  });

  it('inherits accessible light and dark blue without theme-specific active overrides', () => {
    expect(TOKENS).toMatch(/--primary:\s*var\(--db-blue-600\)/);
    expect(TOKENS).toMatch(/html\[data-theme='dark'\][\s\S]*--primary:\s*var\(--ast-ice-accent\)/);
    expect(DARK).not.toMatch(/app-nav-tab(?:\.active|\[aria-current)/);
    expect(DARK_SETTINGS).not.toMatch(/environment-tabs button\.active/);
  });

  it('maps selection and keyboard focus to distinct system-color shapes in high contrast', () => {
    const forced = SHELL.slice(SHELL.indexOf('@media (forced-colors: active)'));
    expect(forced).toMatch(
      /\.app-nav-tab\[aria-current='page'\][\s\S]*border-bottom-color:\s*Highlight;[\s\S]*color:\s*Highlight/
    );
    expect(forced).toMatch(
      /\.app-nav-tab:focus-visible\s*\{[^}]*outline-color:\s*Highlight;[^}]*border-bottom-color:\s*transparent/
    );
  });
});

describe('equivalent primary tab strips', () => {
  it('shares the selected rail token without introducing selected backgrounds', () => {
    const runSelected = rule(RUNS, ".run-detail [data-slot='tabs-trigger'][data-state='active']");
    const environmentSelected = rule(SETTINGS, '.environment-tabs button.active');
    const environmentUnderline = rule(SETTINGS, '.environment-tabs button.active::after');
    for (const selected of [runSelected, environmentSelected]) {
      expect(selected).toContain('color: var(--primary)');
      for (const match of selected.matchAll(/background:\s*([^;]+)/g)) expect(match[1].trim()).toBe('transparent');
    }
    expect(runSelected).toContain('border-bottom-color: var(--primary)');
    expect(environmentUnderline).toContain('background: var(--primary)');
  });
});
