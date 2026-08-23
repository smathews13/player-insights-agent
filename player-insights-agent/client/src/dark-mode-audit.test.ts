import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { partial, stylesheet } from './styles/stylesheet';

const DARK = partial('dark-mode.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const ALL_CSS = stylesheet().replace(/\/\*[\s\S]*?\*\//g, ' ');
const TOKENS = partial('tokens.css');
const ASTROLABE = partial('astrolabe-tokens.css');
const SETTINGS = partial('settings.css');
const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

/** One selector's declaration block, including when it shares a grouped rule. */
function bodyFor(css: string, selector: string): string {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].split(',').some((candidate) => candidate.trim() === selector)) return match[2];
  }
  return '';
}

describe('dark mode covers the shipped surfaces', () => {
  it('names the real shell, data, overlay, and gate selectors', () => {
    for (const selector of [
      '.app-header',
      '.conversation-rail',
      '.composer',
      '.trace-inspector',
      '.trace-empty-mark',
      '.ask-layout',
      '.ast-sky',
      '.answer-card',
      '.monitoring-tile',
      '.monitoring-list-pane',
      '.ops-block',
      '.monitoring-drawer',
      '.trace-timeline',
      '.trace-gantt',
      '.trace-dag.map .dag-detail',
      '.arch-flow',
      '.arch-node',
      '.account-menu',
      '.settings-page.settings-modal',
      '.settings-rail button.active',
      '.appearance-grid',
      '.access-gate-panel',
      '.live-steps',
      '.live-step',
      "[data-slot='card']",
      "[data-slot='sheet-content']",
    ]) {
      expect(DARK, `${selector} has no dark treatment`).toContain(selector);
    }
    expect(source('ArchitecturePage.tsx')).toContain('className="arch-node"');
    expect(source('MonitoringPage.tsx')).toContain('className="monitoring-drawer"');
    expect(source('AccountMenu.tsx')).toContain('className="account-menu"');
    expect(source('App.tsx')).toContain('useRuntimeEntityStyles();');
    expect(source('AppSky.tsx')).toContain("glyph: 'circle'");
    expect(SETTINGS).toMatch(/\.settings-modal-body\s*\{[^}]*grid-template-columns:\s*140px minmax\(0,\s*1fr\)/);
  });

  it('keeps the spec paints centralized and exact', () => {
    expect(TOKENS).toMatch(/html\[data-theme='dark'\][\s\S]*--background:\s*var\(--ast-navy\)/);
    expect(TOKENS).toMatch(/html\[data-theme='dark'\][\s\S]*--card:\s*rgba\(255,\s*255,\s*255,\s*0\.05\)/);
    expect(ASTROLABE).toMatch(/html\[data-theme='dark'\][\s\S]*--ast-text-secondary:\s*rgba\(232,\s*237,\s*242,\s*0\.68\)/);
    expect(ASTROLABE).toMatch(/html\[data-theme='dark'\][\s\S]*--ast-caption:\s*rgba\(232,\s*237,\s*242,\s*0\.8\)/);
    expect(DARK).toContain('background: rgba(255, 255, 255, 0.03)');
    expect(DARK).toContain('background: rgba(255, 255, 255, 0.06)');
    expect(DARK).toContain('backdrop-filter: blur(8px)');
  });

  it('matches the interaction, chart, and constellation treatments', () => {
    expect(DARK).toMatch(/:focus-visible\s*\{[^}]*outline:\s*1px solid var\(--ast-ice-accent\)/);
    expect(DARK).toMatch(/\.app-sky-line\s*\{[^}]*opacity:\s*0\.6/);
    expect(DARK).toMatch(/\.app-sky-glyph\s*\{[^}]*stroke-width:\s*1\.6[^}]*opacity:\s*0\.55/);
    expect(DARK).toMatch(/\.ops-lat-bar-track\s*\{[^}]*rgba\(255,\s*255,\s*255,\s*0\.08\)/);
    expect(DARK).toMatch(/\.ops-lat-bar-fill\s*\{[^}]*rgba\(143,\s*193,\s*232,\s*0\.75\)/);
    expect(DARK).toMatch(/\.arch-edge\s*\{[^}]*--ast-ice-accent[^}]*opacity:\s*0\.8/);
    expect(DARK).toMatch(/\.trace-empty-mark\s*\{[^}]*rgba\(255,\s*255,\s*255,\s*0\.06\)[^}]*--ast-white/);
    expect(DARK).toMatch(/\.settings-rail button\.active\s*\{[^}]*rgba\(255,\s*255,\s*255,\s*0\.07\)/);
  });

  it('ships both accessibility fallbacks', () => {
    expect(DARK).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(DARK).toContain('--card: var(--ast-surface-solid)');
    expect(DARK).toContain('backdrop-filter: none');
    expect(DARK).toContain('@media (prefers-reduced-motion: reduce)');
    expect(DARK).toContain('transition: none');
  });

  it('keeps the sky behind the frame without re-layering every child', () => {
    /*
     * THIS IS THE REGRESSION GUARD FOR FOUR OVERLAYS AND THE ACCOUNT MENU.
     * `position: relative; z-index: 1` on `.app-frame > :not(.app-sky)` looked
     * like a harmless way to put content above the sky. It also matched every
     * fixed child of the frame, replaced its `position: fixed`, and made the
     * header a stacking context that trapped its menu. The sky owns the negative
     * layer now; no foreground child has to surrender its own positioning.
     */
    expect(DARK).not.toMatch(/\.app-frame\s*>\s*:not\(\.app-sky\)/);
    expect(DARK).toMatch(/\.app-sky\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*-1/);
    expect(DARK).toMatch(/html\[data-theme='dark'\] \.app-frame\s*\{[^}]*isolation:\s*isolate/);
  });

  it('makes the dark login backdrop opaque rather than using translucent Ice', () => {
    /*
     * `--ast-ice` is three percent white in dark mode. On a full-viewport login
     * backdrop that is effectively transparent, so the shell the gate is meant
     * to withhold shows through it. The on-sky opening keeps its constellation;
     * the ordinary gate gets the solid sky fill.
     */
    expect(DARK).toMatch(
      /html\[data-theme='dark'\] \.first-open:not\(\.on-sky\)\s*\{[^}]*background:\s*var\(--ast-sky-fill\)/
    );
    expect(DARK).not.toMatch(
      /html\[data-theme='dark'\] \.first-open:not\(\.on-sky\)\s*\{[^}]*background:\s*var\(--ast-ice\)/
    );
  });

  it('corrects every selector that uses deep ink as text', () => {
    /*
     * `--db-ink-deep` remains intentionally near-black in dark mode because it
     * also paints scrims and shadows. That means every use as `color:` is a
     * separate contrast obligation. Discover the call sites from the assembled
     * stylesheet, pin the complete set so a new one cannot arrive unnoticed, and
     * require the selector-specific dark correction that can beat the light rule.
     */
    const callSites = [...ALL_CSS.matchAll(/([^{}]+)\{([^{}]*color:\s*var\(--db-ink-deep\)[^{}]*)\}/g)]
      .flatMap((match) => match[1].split(','))
      .map((selector) => selector.trim())
      .filter((selector) => !selector.startsWith('@'))
      .sort();
    const corrections: Record<string, string> = {
      '.access-gate-actions button:not(.refresh-button)': '.access-gate-actions button:not(.refresh-button)',
      ".conversation-filter-chip[aria-pressed='true']": ".conversation-filter-chip[aria-pressed='true']",
      ".conversation-filter-chip:not(.is-all)[aria-pressed='true'] > .identity-chip":
        ".conversation-filter-chip:not(.is-all)[aria-pressed='true'] > .identity-chip",
      '.identity-chip': '.identity-chip',
      ".time-range-segment:hover:not([aria-checked='true'])": ".time-range-segment:hover:not([aria-checked='true'])",
      ".time-range-segment[aria-checked='true']": ".time-range-segment[aria-checked='true']",
    };
    expect(callSites).toEqual(Object.keys(corrections).sort());
    for (const [lightSelector, darkSelector] of Object.entries(corrections)) {
      const correction = bodyFor(DARK, `html[data-theme='dark'] ${darkSelector}`);
      expect(correction, `${lightSelector} has no dark text correction`).not.toEqual('');
      expect(correction).toMatch(/color:\s*var\(--foreground\)/);
    }
  });

  it('frosts the monitoring list and Ops blocks with a solid fallback', () => {
    /*
     * These two large blocks used to leave the constellation visible between
     * rows and figures while the cards around them were frosted. They belong to
     * the same selector recipe in the normal theme and must become solid in the
     * reduced-transparency path; adding either to only one list is a layout that
     * changes when an accessibility preference is enabled.
     */
    const reducedAt = DARK.indexOf('@media (prefers-reduced-transparency: reduce)');
    const normal = DARK.slice(0, reducedAt);
    const reduced = DARK.slice(reducedAt, DARK.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const selector of ['.monitoring-list-pane', '.ops-block']) {
      expect(normal, `${selector} is not frosted in dark`).toContain(`html[data-theme='dark'] ${selector}`);
      expect(reduced, `${selector} has no reduced-transparency fallback`).toContain(
        `html[data-theme='dark'] ${selector}`
      );
      expect(bodyFor(normal, `html[data-theme='dark'] ${selector}`)).toMatch(
        /background:\s*var\(--card\)[\s\S]*backdrop-filter:\s*blur\(2px\)/
      );
      expect(bodyFor(reduced, `html[data-theme='dark'] ${selector}`)).toMatch(
        /backdrop-filter:\s*none[\s\S]*background:\s*var\(--ast-surface-solid\)/
      );
    }
  });
});
