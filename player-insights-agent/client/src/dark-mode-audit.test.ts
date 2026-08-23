import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { partial } from './styles/stylesheet';

const DARK = partial('dark-mode.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const TOKENS = partial('tokens.css');
const ASTROLABE = partial('astrolabe-tokens.css');
const SETTINGS = partial('settings.css');
const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

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
      '.prompt-grid button',
      '.answer-card',
      '.monitoring-tile',
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
});
