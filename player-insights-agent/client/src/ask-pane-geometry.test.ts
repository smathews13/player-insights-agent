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
  it('gives Run Explorer taller viewport-fit reading panes without changing Ask', () => {
    expect(rule(RUNS, '.run-explorer')).toMatch(
      /--run-explorer-pane-block-size:\s*clamp\(\s*760px,\s*calc\(100dvh - var\(--app-header-h\) \+ 320px - env\(safe-area-inset-bottom,\s*0px\)\),\s*1400px\s*\)/
    );
    expect(TOKENS).toContain('--workspace-pane-block-size: clamp(');
    expect(rule(RUNS, '.run-explorer')).not.toContain('var(--workspace-pane-block-size)');
  });

  it('keeps active-loading cards in page flow with the compact minimum', () => {
    const layout = rule(RAIL, '.ask-layout');
    expect(layout).toContain('--ask-active-card-min-block-size: min(360px, 60dvh)');
    expect(layout).toContain('--ask-active-card-max-block-size: min(520px, 60dvh)');
    const working = rule(ASK, ".ask-layout[data-center-state='working'] .conversation-main > .answer-card");
    expect(working).toContain('height: auto');
    expect(working).toContain('min-height: var(--ask-active-card-min-block-size)');
    expect(working).toContain('max-height: none');
    expect(working).toContain('overflow: visible');
    expect(rule(ASK, ".ask-layout[data-center-state='working'] .conversation-main")).toContain('min-height: 0');
    expect(HOME).toContain("data-center-state={loading ? 'working'");
  });

  it('keeps the left rail viewport-tall with one scrolling list and visible controls', () => {
    const left = rule(RAIL, '.ask-layout > .conversation-rail');
    for (const property of ['height', 'min-height', 'max-height']) {
      expect(left).toContain(`${property}: var(--ask-rail-block-size)`);
    }
    expect(left).toContain('position: sticky');
    expect(left).toContain('overflow: hidden');
    expect(left).toContain('border-bottom: 1px solid var(--db-line)');
    expect(RAIL).toMatch(/\n\.conversation-rail\s*\{[^}]*overflow:\s*hidden/);
    const list = rule(RAIL, '.conversation-list');
    expect(list).toContain('min-height: 0');
    expect(list).toContain('overflow-y: auto');
    expect(list).toContain('scrollbar-gutter: stable');
    expect(HOME).toMatch(
      /className="conversation-rail-content"[\s\S]*?className="section-label"[\s\S]*?className="conversation-list"/
    );
  });

  it('puts each open-pane collapse control in line with that pane heading', () => {
    expect(HOME).toMatch(
      /className=\{scope === 'rail' \? 'rail-primary-actions'[\s\S]*?<Button[\s\S]*?New conversation[\s\S]*?className="rail-collapse-toggle"/
    );
    expect(HOME).not.toContain('rail-collapse-head');
    expect(HOME).toMatch(
      /className="trace-title-row"[\s\S]*?className="inspector-collapse-toggle"[\s\S]*?<h3 className="trace-title">Agent path/
    );
    expect(rule(RAIL, '.rail-primary-actions')).toMatch(/display:\s*flex[\s\S]*align-items:\s*center/);
    expect(rule(RAIL, '.rail-new-conversation')).toMatch(/flex:\s*1 1 auto[\s\S]*min-width:\s*0/);
    expect(rule(RAIL, '.trace-title-row')).toMatch(/display:\s*flex[\s\S]*align-items:\s*center/);
  });

  it('keeps Agent path sticky while the page owns scrolling', () => {
    const right = rule(RAIL, '.trace-inspector');
    expect(right).toContain('position: sticky');
    expect(right).toContain('top: var(--app-header-h)');
    expect(right).toContain('height: auto');
    expect(right).toContain('min-height: var(--workspace-pane-block-size)');
    expect(right).toContain('max-height: none');
    expect(right).not.toContain('var(--ask-active-card');
    expect(RAIL).toMatch(/\n\.trace-inspector\s*\{[^}]*overflow-y:\s*visible/);
    expect(rule(RAIL, '.ask-layout > .conversation-rail')).toMatch(/grid-column:\s*1/);
    expect(RAIL).toMatch(/\n\.trace-inspector\s*\{[^}]*grid-column:\s*3/);
  });

  it('shrink-wraps a final answer to its content so the composer pins beneath it', () => {
    // The base column keeps a viewport-tall floor for the loading and idle passes,
    // but the finished turn drops it: a completed answer is exactly as tall as what
    // it holds, with no ceiling, so opening Advanced trace details grows it in place
    // and the composer sitting in the next grid row follows the last line down
    // instead of waiting a screen away at the bottom of the window.
    const center = rule(ASK, '.conversation-main');
    expect(center).toContain('height: auto');
    expect(center).toContain('min-height: calc(100dvh - var(--app-header-h))');
    expect(center).toContain('max-height: none');
    expect(center).toContain('overflow-y: visible');
    expect(center).not.toContain('var(--ask-active-card');
    // The finished turn drops the column's viewport floor so it shrink-wraps.
    expect(rule(ASK, ".ask-layout[data-center-state='final'] .conversation-main")).toContain('min-height: 0');
    // The final answer card no longer forces a viewport-tall min-height; it keeps
    // the answer card's own 280px floor (answer.css) and grows past it, uncapped.
    const finalCard =
      ASK.match(
        /\.ask-layout\[data-center-state='final'\]\s+\.conversation-message[\s\S]*?\.answer-card\s*\{([^}]*)\}/
      )?.[1] ?? '';
    expect(finalCard).toContain('max-height: none');
    expect(finalCard).toContain('overflow: visible');
    expect(finalCard).not.toMatch(/min-height:\s*calc\(100dvh/);
    expect(rule(ANSWER_BODY, '.answer-card-content')).toMatch(/grid-auto-rows:\s*auto[\s\S]*overflow:\s*visible/);
  });

  it('keeps the graph intrinsic and the live step list in page flow', () => {
    expect(rule(CONSTELLATION, '.ast-sky')).toMatch(/overflow:\s*clip[\s\S]*flex:\s*none/);
    expect(rule(CONSTELLATION, '.ast-sky-canvas')).toMatch(/height:\s*auto[\s\S]*flex:\s*none/);
    expect(RAIL).toMatch(/\n\.trace-inspector\s*\{[^}]*overflow-y:\s*visible/);
    const live = rule(LIVE, '.live-steps');
    expect(live).toMatch(/overflow:\s*visible/);
    expect(live).toMatch(/max-height:\s*none/);
  });

  it('returns Ask and Run panes to auto-height page flow on narrow screens', () => {
    expect(RESPONSIVE).toMatch(
      /@media \(max-width: 800px\)[\s\S]*?\.conversation-main\s*\{[^}]*height:\s*auto[^}]*max-height:\s*none[^}]*overflow:\s*visible/
    );
    expect(RESPONSIVE).toMatch(
      /@media \(max-width: 800px\)[\s\S]*?\.ask-layout\[data-transcript='active'\][^{]*\.answer-card\s*\{[^}]*min-height:\s*280px/
    );
    expect(RESPONSIVE).toMatch(
      /@media \(max-width: 800px\)[\s\S]*?\.ask-layout\[data-center-state='working'\] \.conversation-main > \.answer-card\s*\{[^}]*max-height:\s*none[^}]*overflow:\s*visible/
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

  it('keeps a 12px gap and no second dead-space reserve', () => {
    expect(rule(RAIL, '.conversation-column')).toMatch(/gap:\s*12px/);
    expect(rule(ASK, ".ask-layout[data-transcript='active'] .conversation-main")).toContain('padding-bottom: 0');
    expect(rule(ASK, ".ask-layout[data-center-state='working'] .conversation-main > .answer-card")).toContain(
      'margin-bottom: 0'
    );
    expect(ASK).toMatch(/\.ask-layout\[data-center-state='final'\][\s\S]*?\.answer-card\s*\{[^}]*margin-bottom:\s*0/);
    expect(ASK).not.toContain('--composer-reserve');
    expect(COMPOSER).not.toContain('--composer-reserve');
  });

  it('cannot overlay short answers, tall answers, or an active timeline', () => {
    const composer = rule(COMPOSER, '.composer');
    expect(composer).toMatch(/position:\s*static/);
    expect(composer).not.toMatch(/\b(?:top|right|bottom|left|z-index|transform):/);
    expect(composer).not.toMatch(/margin-(?:top|block-start):\s*-/);
    expect(HOME).toMatch(/\) : loading \? \(\s*stopping \? \(/);
    expect(HOME).toContain("'Stop'");
  });
});
