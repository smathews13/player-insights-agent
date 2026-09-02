import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Dialog } from './Dialog';
import { partial } from './styles/stylesheet';

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const withoutComments = (value: string) => value.replace(/\/\*[\s\S]*?\*\//g, ' ');
const bodyFor = (css: string, selector: string): string => {
  for (const match of withoutComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].split(',').some((candidate) => candidate.trim() === selector)) return match[2];
  }
  return '';
};
const tokenNumber = (css: string, name: string): number =>
  Number.parseInt(css.match(new RegExp(`${name}:\\s*(-?\\d+)`))?.[1] ?? 'NaN', 10);
const tokenMix = (css: string, name: string): number =>
  Number.parseFloat(
    css.match(new RegExp(`${name}:\\s*color-mix\\([^;]*?\\s([\\d.]+)%,\\s*transparent\\)`))?.[1] ?? 'NaN'
  );
const channel = (hex: string, offset: number): number => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
const relativeLuminance = (hex: string): number => {
  const linear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(channel(hex, 1)) + 0.7152 * linear(channel(hex, 3)) + 0.0722 * linear(channel(hex, 5));
};
const contrast = (foreground: string, background: string): number => {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

describe('primary surface occlusion', () => {
  const astrolabe = partial('astrolabe-tokens.css');
  const tokens = partial('tokens.css');
  const contract = partial('surface-contract.css');

  it('defines an ordered translucent glass hierarchy with AA text contrast', () => {
    const muted = tokenMix(astrolabe, '--ast-surface-muted');
    const primary = tokenMix(astrolabe, '--ast-surface-primary');
    const elevated = tokenMix(astrolabe, '--ast-surface-elevated');
    const menu = tokenMix(astrolabe, '--ast-surface-menu');
    const chrome = tokenMix(astrolabe, '--ast-surface-chrome');
    expect(muted).toBe(92);
    expect(primary).toBe(95);
    expect(elevated).toBe(97);
    expect(menu).toBe(98.5);
    expect(chrome).toBe(99);
    expect(muted).toBeLessThan(primary);
    expect(primary).toBeLessThan(elevated);
    expect(elevated).toBeLessThan(menu);
    expect(menu).toBeLessThan(chrome);
    expect(chrome).toBeLessThan(100);
    expect(astrolabe).toContain('--ast-pane: var(--ast-surface-primary)');

    const darkAstrolabe = bodyFor(astrolabe, "html[data-theme='dark']");
    for (const [name, amount] of [
      ['--ast-surface-muted', 92],
      ['--ast-surface-primary', 95],
      ['--ast-surface-elevated', 97],
      ['--ast-surface-menu', 98.5],
      ['--ast-surface-chrome', 99],
    ] as const) {
      expect(tokenMix(darkAstrolabe, name), name).toBe(amount);
    }
    expect(darkAstrolabe).toMatch(/--ast-pane:\s*var\(--ast-surface-primary\)/);

    const darkTokens = bodyFor(tokens, "html[data-theme='dark']");
    expect(darkTokens).toMatch(/--card:\s*var\(--ast-surface-primary\)/);
    expect(darkTokens).toMatch(/--popover:\s*var\(--ast-surface-menu\)/);
    expect(bodyFor(tokens, ':root')).toMatch(/--card:\s*var\(--ast-surface-primary\)/);
    expect(bodyFor(tokens, ':root')).toMatch(/--popover:\s*var\(--ast-surface-menu\)/);

    expect(contrast('#f2f6fa', '#181e23')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#161616', '#ffffff')).toBeGreaterThanOrEqual(4.5);

    for (const [selector, role] of [
      ['.ast-surface-primary', '--ast-surface-primary'],
      ['.ast-surface-elevated', '--ast-surface-elevated'],
      ['.ast-surface-menu', '--ast-surface-menu'],
      ['.ast-surface-chrome', '--ast-surface-chrome'],
      ['.ast-dialog-panel', '--ast-surface-elevated'],
    ] as const) {
      const body = bodyFor(contract, selector);
      expect(body).toContain(`background-color: var(${role})`);
      expect(body).toMatch(/backdrop-filter:\s*none/);
      expect(body).not.toMatch(/rgba|blur\(/);
    }
    const overlay = bodyFor(contract, '.ast-dialog-overlay:not(.first-open)');
    expect(overlay).toMatch(/background:\s*var\(--ast-overlay-occlusion\)/);
    expect(overlay).toMatch(/backdrop-filter:\s*none/);
  });

  it('marks Run Explorer, Monitoring, and conversation rail reading surfaces', () => {
    const runs = source('RunExplorer.tsx');
    expect(runs).toContain('className="run-list ast-surface-primary"');
    expect(runs).toContain('className="run-detail ast-surface-primary"');

    const monitoring = source('MonitoringPage.tsx');
    expect(monitoring).toContain("'monitoring-tile', 'ast-surface-primary'");
    expect(monitoring).toContain('monitoring-outcomes-tile ast-surface-primary');
    expect(monitoring).toContain('monitoring-filters ast-surface-primary');
    expect(monitoring).toContain('monitoring-list-pane ast-surface-primary');

    const home = source('HomePage.tsx');
    expect(home).toContain('conversation-rail ast-surface-primary');
    expect(home).toContain('conversation-row ast-surface-primary');
  });

  it('routes shipped reading surfaces through high-alpha semantic paint', () => {
    const selectors = [
      ['dark-runs.css', "html[data-theme='dark'] .run-explorer .run-detail", '--ast-pane'],
      ['dark-monitoring.css', "html[data-theme='dark'] .monitoring-tile", '--card'],
      ['dark-monitoring.css', "html[data-theme='dark'] .monitoring-list-pane", '--card'],
      ['dark-connections.css', "html[data-theme='dark'] .connections-page .connection-block", '--ast-pane'],
      ['dark-architecture.css', "html[data-theme='dark'] .arch-flow", '--card'],
      ['dark-ops.css', "html[data-theme='dark'] .ops-block", '--card'],
      ['dark-benchmark.css', "html[data-theme='dark'] .bench-surface", '--ast-surface-primary'],
      ['dark-settings.css', "html[data-theme='dark'] .settings-page.settings-modal", '--ast-surface-elevated'],
    ] as const;

    for (const [file, selector, token] of selectors) {
      const body = bodyFor(partial(file), selector);
      expect(body, selector).toContain(`background: var(${token})`);
      expect(body, selector).toMatch(/backdrop-filter:\s*none/);
      expect(body, selector).not.toMatch(/background:[^;]*(?:rgba|transparent)|blur\(/);
    }
  });

  it('uses stronger paint for menus, pickers, dialogs, and portaled controls', () => {
    const base = partial('base.css');
    expect(bodyFor(base, '.app-select-content')).toMatch(/background:\s*var\(--ast-surface-menu\)/);

    const rail = partial('rail.css');
    expect(bodyFor(rail, '.conversation-owner-menu')).toMatch(
      /background-color:\s*var\(--popover\)[\s\S]*backdrop-filter:\s*none/
    );

    const monitoring = partial('monitoring.css');
    expect(bodyFor(monitoring, '.monitoring-chip-menu')).toMatch(/background:\s*var\(--ast-surface-menu\)/);
    const darkMonitoring = partial('dark-monitoring.css');
    expect(bodyFor(darkMonitoring, "html[data-theme='dark'] .monitoring-chip-menu")).toMatch(
      /background:\s*var\(--ast-surface-menu\)/
    );
    expect(bodyFor(darkMonitoring, "html[data-theme='dark'] .user-profile-modal")).toMatch(
      /background:\s*var\(--ast-surface-elevated\)/
    );

    const connections = partial('connections.css');
    expect(bodyFor(connections, '.asset-picker')).toMatch(/background:\s*var\(--ast-surface-elevated\)/);

    const settings = partial('settings.css');
    expect(bodyFor(settings, '.sp-resource-menu')).toMatch(/background:\s*var\(--popover\)/);

    const account = partial('account-menu.css');
    expect(bodyFor(account, '.account-menu')).toMatch(/background:\s*var\(--ast-surface-menu\)/);

    const dark = partial('dark-mode.css');
    for (const selector of ["html[data-theme='dark'] .app-select-content", "html[data-theme='dark'] .account-menu"]) {
      expect(bodyFor(dark, selector), selector).toMatch(/background:\s*var\(--ast-surface-menu\)/);
    }
  });

  it('keeps informational token and login panels neutral while actions retain blue', () => {
    const timeline = partial('timeline.css');
    const tokenTile = bodyFor(timeline, '.trace-kind-kpis .trace-token-kpi');
    expect(tokenTile).toMatch(/border-color:\s*var\(--ast-border-input\)/);
    expect(tokenTile).toMatch(/background:\s*var\(--card\)/);
    expect(tokenTile).not.toMatch(/--(?:ast-blue|primary)|box-shadow/);

    const gate = partial('gate.css');
    const firstOpen = partial('first-open.css');
    const session = partial('app-session.css');
    for (const [css, selector] of [
      [gate, '.access-gate-panel'],
      [firstOpen, '.first-open-card'],
      [session, '.app-session-card'],
    ] as const) {
      const panel = bodyFor(css, selector);
      expect(panel, selector).toMatch(/background:\s*var\(--ast-surface-elevated\)/);
      expect(panel, selector).toMatch(/border:\s*1px solid var\(--ast-(?:border-input|hairline)\)/);
      expect(panel, selector).not.toMatch(/border-top|--(?:ast-blue|primary)/);
    }
    expect(bodyFor(gate, '.access-gate-primary')).toMatch(
      /border-color:\s*var\(--primary\)[\s\S]*background:\s*var\(--primary\)/
    );
    const sessionAction = session.match(/\.app-session-card :is\(button, a\)\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(sessionAction).toMatch(/border:\s*1px solid var\(--primary\)[\s\S]*background:\s*var\(--primary\)/);
    expect(bodyFor(partial('base.css'), ':focus-visible')).toMatch(/outline:\s*2px solid var\(--ast-blue\)/);
  });
});

describe('constellation and chrome layers', () => {
  const astrolabe = partial('astrolabe-tokens.css');
  const dark = partial('dark-mode.css');
  const motion = partial('star-motion.css');
  const shell = partial('shell.css');
  const base = partial('base.css');

  it('orders sky, page, sticky chrome, dialogs, and menus explicitly', () => {
    const sky = tokenNumber(astrolabe, '--ast-layer-sky');
    const page = tokenNumber(astrolabe, '--ast-layer-page');
    const chrome = tokenNumber(astrolabe, '--ast-layer-chrome');
    const dialog = tokenNumber(astrolabe, '--ast-layer-dialog');
    const menu = tokenNumber(astrolabe, '--ast-layer-menu');
    expect(sky).toBeLessThan(page);
    expect(page).toBeLessThan(chrome);
    expect(chrome).toBeLessThan(dialog);
    expect(dialog).toBeLessThan(menu);

    expect(bodyFor(dark, '.app-sky')).toMatch(
      /position:\s*fixed[\s\S]*z-index:\s*var\(--ast-layer-sky\)[\s\S]*pointer-events:\s*none/
    );
    expect(bodyFor(dark, "html[data-theme='dark'] .app-frame")).toMatch(
      /z-index:\s*var\(--ast-layer-page\)[\s\S]*isolation:\s*isolate/
    );
    expect(bodyFor(base, '[data-radix-popper-content-wrapper]')).toMatch(/z-index:\s*var\(--ast-layer-menu\)/);
  });

  it('practically occludes scrolled content across the header and safe-area edge', () => {
    const header = bodyFor(shell, '.app-header');
    expect(header).toMatch(/position:\s*sticky/);
    expect(header).toMatch(/inset-block-start:\s*0/);
    expect(header).toMatch(/z-index:\s*var\(--ast-layer-chrome\)/);
    expect(header).toMatch(/isolation:\s*isolate/);
    expect(header).toMatch(/width:\s*100%/);
    expect(header).toMatch(/padding:\s*var\(--app-header-safe-top\)/);
    expect(header).toMatch(/background-color:\s*var\(--ast-surface-chrome\)/);
    expect(header).toMatch(/backdrop-filter:\s*none/);
    expect(header).not.toMatch(/background[^;]*rgba|blur\(/);

    const occlusion = bodyFor(shell, '.app-header::before');
    expect(occlusion).toMatch(/inset:\s*0/);
    expect(occlusion).toMatch(/z-index:\s*-1/);
    expect(occlusion).toMatch(/background:\s*var\(--ast-surface-chrome\)/);
    expect(occlusion).toMatch(/pointer-events:\s*none/);
    expect(bodyFor(base, 'html')).toMatch(/scroll-padding-top:\s*var\(--app-header-h\)/);
    const chromeTransmission = (1 - tokenMix(astrolabe, '--ast-surface-chrome') / 100) ** 2;
    expect(chromeTransmission).toBeLessThanOrEqual(0.00011);
  });

  it('keeps exposed constellation intensity while surfaces cap covered intersections', () => {
    expect(motion).toMatch(/circle\.app-sky-glyph\s*\{[^}]*fill:\s*var\(--ast-white\)/s);
    expect(bodyFor(dark, "html[data-theme='dark'] .app-sky-line")).toMatch(/opacity:\s*0\.6/);
    expect(bodyFor(dark, "html[data-theme='dark'] .app-sky-glyph")).toMatch(
      /stroke-width:\s*1\.6[\s\S]*opacity:\s*0\.55/
    );
    expect(motion).toMatch(/@keyframes ast-tw\s*\{[\s\S]*?50%\s*\{[^}]*opacity:\s*0\.85/);
    expect(motion).toMatch(/@keyframes ast-tw2\s*\{[\s\S]*?50%\s*\{[^}]*opacity:\s*0\.55/);
    expect(motion).toMatch(/@keyframes ast-sky-draw\s*\{[\s\S]*?opacity:\s*0\.45/);
    expect(astrolabe).toMatch(/--ast-sky-spackle:[\s\S]*?rgba\(255,\s*255,\s*255,\s*0\.5\)/);

    const exposedIntersection = 1 - (1 - 0.85) ** 2;
    const coveredIntersection = exposedIntersection * (1 - tokenMix(astrolabe, '--ast-surface-primary') / 100);
    const coveredMenuIntersection = exposedIntersection * (1 - tokenMix(astrolabe, '--ast-surface-menu') / 100);
    expect(exposedIntersection).toBeGreaterThan(0.95);
    expect(coveredIntersection).toBeLessThan(0.05);
    expect(coveredMenuIntersection).toBeLessThan(0.015);

    const appearance = partial('appearance-preferences.css');
    expect(bodyFor(appearance, "html[data-background-graphics='off'] .app-sky")).toMatch(/display:\s*none !important/);
    expect(
      bodyFor(appearance, "html[data-animations='off'] .app-sky[data-star-motion-field] [data-star-motion='anchor']")
    ).toMatch(/opacity:\s*0\.7/);
    expect(
      bodyFor(appearance, "html[data-animations='off'] .app-sky[data-star-motion-field] .star-motion-faint")
    ).toMatch(/opacity:\s*0\.32/);
    expect(
      bodyFor(appearance, "html[data-animations='off'] .app-sky[data-star-motion-field] .star-motion-draw")
    ).toMatch(/opacity:\s*0\.45/);
  });

  it('gives every body-portal dialog a strong shared overlay and elevated panel', () => {
    const markup = renderToStaticMarkup(
      <Dialog overlayClassName="sample-overlay" contentClassName="sample-panel" labelledBy="dialog-title">
        <h2 id="dialog-title">Dialog</h2>
      </Dialog>
    );
    expect(markup).toContain('sample-overlay ast-dialog-overlay');
    expect(markup).toContain('data-ast-dialog-overlay=""');
    expect(markup).toContain('sample-panel ast-dialog-panel');
    expect(markup).toContain('data-ast-dialog-panel=""');
  });
});
