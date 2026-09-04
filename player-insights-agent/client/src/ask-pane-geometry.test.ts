import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { partial } from './styles/stylesheet';

const HOME = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
const TOKENS = partial('tokens.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const RAIL = partial('rail.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const ASK = partial('ask.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const COMPOSER = partial('composer.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const LIVE = partial('live.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const RESPONSIVE = partial('responsive.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const RESPONSIVE_RUNS = partial('responsive-runs.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const RUNS = partial('runs.css').replace(/\/\*[\s\S]*?\*\//g, ' ');

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('Ask and Run share taller desktop pane geometry', () => {
  it('uses one viewport-aware 760–1120px token with 160px more preferred room', () => {
    expect(TOKENS).toMatch(
      /--workspace-pane-block-size:\s*clamp\(\s*760px,\s*calc\(100dvh - var\(--app-header-h\) \+ 160px - env\(safe-area-inset-bottom,\s*0px\)\),\s*1120px\s*\)/
    );
    expect(rule(RUNS, '.run-explorer')).toContain('--run-explorer-pane-block-size: var(--workspace-pane-block-size)');
  });

  it('gives short and tall Ask content the exact same rail and center-pane height', () => {
    const rail = rule(RAIL, '.ask-layout > .conversation-rail,\n.trace-inspector');
    const center = rule(ASK, '.conversation-main');
    for (const property of ['height', 'min-height', 'max-height']) {
      expect(rail).toContain(`${property}: var(--workspace-pane-block-size)`);
      expect(center).toContain(`${property}: var(--workspace-pane-block-size)`);
    }
    expect(ASK).toMatch(
      /\.ask-layout\[data-transcript='active'\] \.conversation-main > \.answer-card,[\s\S]*?min-height:\s*calc\(var\(--workspace-pane-block-size\) - 88px\)/
    );
    expect(ASK).not.toMatch(
      /\.ask-layout\[data-transcript='active'\][^{]*\.answer-card\s*\{[^}]*(?:max-height|overflow-y)/
    );
    expect(rule(RAIL, '.ask-layout > .conversation-rail')).toMatch(/grid-column:\s*1/);
    expect(RAIL).toMatch(/\n\.trace-inspector\s*\{[^}]*grid-column:\s*3/);
  });

  it('makes only the two top-level panes vertical scroll owners with stable gutters', () => {
    expect(RAIL).toMatch(/\n\.conversation-rail\s*\{[^}]*overflow-y:\s*auto/);
    const center = rule(ASK, '.conversation-main');
    expect(center).toMatch(/overflow-y:\s*auto/);
    expect(center).toMatch(/scrollbar-gutter:\s*stable/);
    const live = rule(LIVE, '.live-steps');
    expect(live).toMatch(/overflow:\s*visible/);
    expect(live).not.toMatch(/overflow-y:\s*(?:auto|scroll)|max-height/);
  });

  it('returns Ask and Run panes to auto-height page flow on narrow screens', () => {
    expect(RESPONSIVE).toMatch(
      /@media \(max-width: 800px\)[\s\S]*?\.conversation-main\s*\{[^}]*height:\s*auto[^}]*max-height:\s*none[^}]*overflow:\s*visible/
    );
    expect(RESPONSIVE).toMatch(
      /@media \(max-width: 800px\)[\s\S]*?\.ask-layout\[data-transcript='active'\][^{]*\.answer-card\s*\{[^}]*min-height:\s*280px/
    );
    expect(RESPONSIVE_RUNS).toMatch(
      /@media \(max-width: 960px\)[\s\S]*?\.run-list\s*\{[^}]*height:\s*auto[^}]*overflow:\s*visible/
    );
    expect(RESPONSIVE_RUNS).toMatch(
      /@media \(max-width: 960px\)[\s\S]*?\.run-detail\s*\{[^}]*height:\s*auto[^}]*overflow:\s*visible/
    );
  });
});

describe('the Ask composer follows the answer pane in normal flow', () => {
  it('renders the scroll pane before the composer as sibling grid rows', () => {
    const column = HOME.slice(
      HOME.indexOf('className="conversation-column"'),
      HOME.indexOf('className="trace-inspector"')
    );
    expect(column).toMatch(/<section[\s\S]*?className=\{`conversation-main[\s\S]*?<\/section>\s*<form/);
    expect(column.indexOf('className={`conversation-main')).toBeLessThan(column.indexOf('className="composer"'));
    expect(rule(RAIL, '.conversation-column')).toMatch(/grid-template-rows:\s*auto auto/);
  });

  it('keeps a deliberate positive gap and no second dead-space reserve', () => {
    expect(rule(RAIL, '.conversation-column')).toMatch(/gap:\s*20px/);
    expect(ASK).not.toContain('--composer-reserve');
    expect(COMPOSER).not.toContain('--composer-reserve');
  });

  it('cannot overlay short answers, tall answers, or an active timeline', () => {
    const composer = rule(COMPOSER, '.composer');
    expect(composer).toMatch(/position:\s*static/);
    expect(composer).not.toMatch(/\b(?:top|right|bottom|left|z-index|transform):/);
    expect(composer).not.toMatch(/margin-(?:top|block-start):\s*-/);
    expect(HOME).toContain('{loading ? (\n                stopping ? (');
    expect(HOME).toContain("'Stop'");
  });
});
