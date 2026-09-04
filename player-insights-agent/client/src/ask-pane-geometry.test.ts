import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { partial } from './styles/stylesheet';

const HOME = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
const TOKENS = partial('tokens.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const RAIL = partial('rail.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const ASK = partial('ask.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const COMPOSER = partial('composer.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const LIVE = partial('live.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const CONSTELLATION = partial('constellation.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const ANSWER_BODY = partial('answer-body.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const RESPONSIVE = partial('responsive.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const RESPONSIVE_RUNS = partial('responsive-runs.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const RUNS = partial('runs.css').replace(/\/\*[\s\S]*?\*\//g, ' ');

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('Ask and Run use page-specific desktop pane geometry', () => {
  it('keeps Run Explorer on its dedicated 760–1120px reading panes', () => {
    expect(TOKENS).toMatch(
      /--workspace-pane-block-size:\s*clamp\(\s*760px,\s*calc\(100dvh - var\(--app-header-h\) \+ 160px - env\(safe-area-inset-bottom,\s*0px\)\),\s*1120px\s*\)/
    );
    expect(rule(RUNS, '.run-explorer')).toContain('--run-explorer-pane-block-size: var(--workspace-pane-block-size)');
  });

  it('keeps only the no-evidence planning center at 360–520px', () => {
    const layout = rule(RAIL, '.ask-layout');
    expect(layout).toContain('--ask-composer-block-reserve: 144px');
    expect(layout).toMatch(
      /--ask-planning-pane-block-size:\s*clamp\(\s*360px,\s*calc\(\s*100dvh - var\(--app-header-h\) - var\(--ask-composer-block-reserve\) -\s*env\(safe-area-inset-bottom,\s*0px\)\s*\),\s*520px\s*\)/
    );
    const planning = rule(ASK, ".ask-layout[data-transcript='active'][data-stage-mode='planning'] .conversation-main");
    for (const property of ['height', 'min-height', 'max-height']) {
      expect(planning).toContain(`${property}: var(--ask-planning-pane-block-size)`);
    }
    expect(planning).toContain('overflow-y: auto');
  });

  it('restores independent full-height scroll owners for Conversations and Agent path', () => {
    const sideRails = rule(RAIL, '.ask-layout > .conversation-rail,\n.trace-inspector');
    for (const property of ['height', 'min-height', 'max-height']) {
      expect(sideRails).toContain(`${property}: var(--workspace-pane-block-size)`);
    }
    expect(sideRails).not.toContain('var(--ask-planning-pane-block-size)');
    expect(RAIL).toMatch(/\n\.conversation-rail\s*\{[^}]*overflow-y:\s*auto/);
    expect(RAIL).toMatch(/\n\.trace-inspector\s*\{[^}]*overflow-y:\s*auto/);
    expect(rule(RAIL, '.ask-layout > .conversation-rail')).toMatch(/grid-column:\s*1/);
    expect(RAIL).toMatch(/\n\.trace-inspector\s*\{[^}]*grid-column:\s*3/);
  });

  it('lets real timelines and final answers grow through normal page flow', () => {
    const center = rule(ASK, '.conversation-main');
    expect(center).toContain('height: auto');
    expect(center).toContain('min-height: calc(100dvh - var(--app-header-h))');
    expect(center).toContain('max-height: none');
    expect(center).toContain('overflow-y: visible');
    expect(center).not.toContain('var(--ask-planning-pane-block-size)');
    expect(ASK).toMatch(
      /\.ask-layout\[data-transcript='active'\]:not\(\[data-stage-mode='planning'\]\)[\s\S]*?\.answer-card\s*\{[^}]*min-height:\s*calc\(100dvh - var\(--app-header-h\)\)[^}]*max-height:\s*none[^}]*overflow:\s*visible/
    );
    expect(rule(ANSWER_BODY, '.answer-card-content')).toMatch(/grid-auto-rows:\s*auto[\s\S]*overflow:\s*visible/);
  });

  it('keeps the graph intrinsic and delegates overflow to the one right-rail scroller', () => {
    expect(rule(CONSTELLATION, '.ast-sky')).toMatch(/overflow:\s*clip[\s\S]*flex:\s*none/);
    expect(rule(CONSTELLATION, '.ast-sky-canvas')).toMatch(/height:\s*auto[\s\S]*flex:\s*none/);
    expect(RAIL).toMatch(/\n\.trace-inspector\s*\{[^}]*overflow-y:\s*auto/);
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
