import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LiveProgress } from './LiveProgress';
import type { TraceStage } from './answer-shape';
import { partial } from './styles/stylesheet';

/**
 * Ask-tab rails: idle Agent path stays on, both side columns share a width,
 * the answer card centres in the leftover track, and a live step row carries
 * the same kind mark the constellation draws.
 */

const RAIL = withoutComments(partial('rail.css'));
const ASK = withoutComments(partial('ask.css'));
const LIVE = withoutComments(partial('live.css'));
const TOKENS = withoutComments(partial('tokens.css'));
const ASTROLABE = withoutComments(partial('astrolabe-tokens.css'));
const HOME = readFileSync(new URL('HomePage.tsx', import.meta.url), 'utf8');
const PANEL = readFileSync(new URL('LiveProgress.tsx', import.meta.url), 'utf8');

function withoutComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function stage(overrides: Partial<TraceStage> & Pick<TraceStage, 'id'>): TraceStage {
  return {
    name: 'Queried governed data',
    kind: 'tool',
    start: 0,
    duration: 1200,
    status: 'complete',
    calls: 1,
    input: '',
    output: '',
    startMeasured: true,
    ...overrides,
  };
}

describe('idle Ask keeps the Agent path pane', () => {
  it('does not zero --trace-width or hide the inspector', () => {
    expect(RAIL).not.toMatch(/\.ask-layout\[data-inspector=['"]idle['"]\]\s*\{[^}]*--trace-width:\s*0px/);
    expect(RAIL).not.toMatch(
      /\.ask-layout\[data-inspector=['"]idle['"]\]\s+\.trace-inspector\s*\{[^}]*display:\s*none/
    );
    expect(RAIL).toMatch(/--trace-width:\s*340px/);
  });

  it('leaves idle Ask on the one app-wide topology', () => {
    expect(HOME).not.toContain("import { ConstellationField } from './ConstellationField'");
    expect(HOME).not.toContain('OPENING_CONSTELLATION');
    expect(HOME).not.toContain('className="trace-idle-sky"');
    expect(HOME).not.toContain('No run yet');
  });

  it('keeps the Agent path chrome above the page topology', () => {
    expect(RAIL).toMatch(/\.trace-inspector\s*\{[^}]*overflow-x:\s*clip/);
    expect(RAIL).toMatch(
      /\.trace-head,\s*\.trace-title,\s*\.trace-working,\s*\.trace-inspector \.ast-sky,\s*\.trace-inspector \.trace-divider,\s*\.trace-inspector \.metric-row,\s*\.trace-inspector \.trace-explore\s*\{[^}]*z-index:\s*1/
    );
    expect(RAIL).toMatch(/\.trace-inspector\s*\{[^}]*isolation:\s*isolate/);
  });

  it('restores one opaque card surface around the complete Agent path pane', () => {
    const pane = /\.trace-inspector\s*\{([^}]*)\}/.exec(RAIL)?.[1] ?? '';
    expect(pane).toMatch(/border:\s*1px solid var\(--ast-border-input\)/);
    expect(pane).toMatch(/border-radius:\s*var\(--ast-radius-card\)/);
    expect(pane).toMatch(/background:\s*var\(--ast-surface-primary\)/);
    expect(pane).toMatch(/background-image:\s*none/);
    expect(pane).toMatch(/backdrop-filter:\s*none/);
    expect(pane).toMatch(/padding:\s*20px 12px 20px 20px/);
    expect(pane).toMatch(/box-sizing:\s*border-box/);

    // The dark Ask field may expose global topology in gutters; the pane's more
    // specific rule must keep that decoration behind this card.
    expect(RAIL).toMatch(
      /html\[data-theme='dark'\] \.ask-layout > \.trace-inspector\s*\{[^}]*background:\s*var\(--ast-surface-primary\)[^}]*background-image:\s*none[^}]*backdrop-filter:\s*none/
    );
    expect(ASTROLABE).toMatch(
      /html\[data-theme='dark'\]\s*\{[^}]*--ast-surface-primary:\s*color-mix\(in srgb, var\(--ast-surface-solid\) 98\.5%, transparent\)/
    );
    expect(RAIL).not.toMatch(/\.trace-inspector::(?:before|after)/);
  });

  it('encloses the heading, local graph, summary, metrics, and action once', () => {
    expect(HOME.match(/<aside className="trace-inspector"/g)).toHaveLength(1);
    const open = HOME.indexOf('<aside className="trace-inspector"');
    const close = HOME.indexOf('</aside>', open);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const pane = HOME.slice(open, close);
    for (const content of [
      'className="trace-head"',
      'className="trace-title"',
      '<AgentPathConstellation',
      'className="metric-row"',
      'className="trace-explore w-full"',
    ]) {
      expect(pane, content).toContain(content);
    }
    expect(pane.match(/<AgentPathConstellation/g)).toHaveLength(1);
  });

  it('does not add route-local topology when a run starts', () => {
    expect(RAIL).not.toContain('.trace-idle-sky');
  });

  it('reserves the inspector scrollbar so the first overflow cannot shove the path', () => {
    // Around step 15 the path first exceeds the pane. A bar that appears then
    // shrinks the SVG and leaves tool-mark ghosts at the old seats.
    expect(RAIL).toMatch(/\.trace-inspector\s*\{[^}]*scrollbar-gutter:\s*stable/);
    expect(RAIL).toMatch(/\.trace-inspector \.ast-sky\s*\{[^}]*overflow:\s*visible/);
  });

  it('does not remount the numbered path when a step lands', () => {
    // A key on the step count remounted the whole SVG each hop, so the old
    // map and the new one were briefly both on screen.
    expect(HOME).not.toMatch(/<AgentPathConstellation[\s\S]{0,200}key=\{[^}]*railStages/);
    expect(HOME).not.toMatch(/<AgentPathConstellation[\s\S]{0,200}key=\{[^}]*stages\.length/);
    expect(RAIL).toMatch(/\.trace-inspector \.ast-sky\s*\{[^}]*flex-shrink:\s*0/);
  });
});

describe('the two rails share one width and the card sits in the middle', () => {
  it('makes the conversation rail read the same token as the Agent path', () => {
    expect(RAIL).toMatch(/--conversation-width:\s*var\(--trace-width\)/);
    expect(TOKENS).toMatch(/--conversation-width:\s*340px/);
    expect(TOKENS).toMatch(/--trace-width:\s*340px/);
  });

  it('centres the answer and working cards in the leftover track', () => {
    expect(ASK).toMatch(/\.conversation-main\s*\{[^}]*max-width:\s*none/);
    expect(ASK).toMatch(
      /\.conversation-main \.answer-card,\s*\.conversation-main \.plan-card\s*\{[^}]*max-width:\s*var\(--conversation-measure\)[^}]*margin-inline:\s*auto/
    );
  });

  it('pulls the answer and working cards a few pixels off both rails', () => {
    // 16px total, 8px a side. The composer stays on `--conversation-inset`;
    // shrinking the track would move the box a reader types in as well.
    expect(ASK).toMatch(
      /\.conversation-main \.answer-card,\s*\.conversation-main \.plan-card\s*\{[^}]*width:\s*calc\(100% - 16px\)/
    );
  });

  it('keeps the organization-marked user badge a compact one-line pill', () => {
    expect(HOME).toContain('<OrganizationUserBadge');
    expect(HOME).not.toContain('label="Asked by"');
    expect(RAIL).toMatch(/\.conversation-owner\s*\{[^}]*flex:\s*none[^}]*width:\s*auto/);
    expect(RAIL).not.toMatch(/\.conversation-owner\s*\{[^}]*width:\s*100%/);
    expect(RAIL).not.toMatch(/\.conversation-owner\s*\{[^}]*flex:\s*1/);
    expect(RAIL).not.toMatch(
      /\.conversation-rail \.conversation-owner \.identity-chip-text\s*\{[^}]*white-space:\s*normal/
    );
  });
});

describe('live step rows carry the Agent path kind mark beside the number', () => {
  it('places the map’s product or agent mark to the left of the numbered badge', () => {
    expect(PANEL).toContain('live-step-index');
    expect(PANEL).toContain('live-step-kind');
    expect(PANEL).toContain('live-step-icon step-rail-num ast-num');
    expect(PANEL).toContain("import { productForTool } from './brand-icons'");
    expect(PANEL).toContain('<BrandIcon product={product}');
    expect(PANEL).toContain('<PiaAvatar size={13} />');
    expect(PANEL).toMatch(/live-step-kind[\s\S]*live-step-icon step-rail-num ast-num/);
    expect(LIVE).toMatch(/\.live-step-index\s*\{[^}]*flex-direction:\s*row/);
    expect(LIVE).not.toMatch(/\.live-step-index\s*\{[^}]*flex-direction:\s*column/);
  });

  it('renders the SQL mark on a warehouse step and the agent mark on an LLM step', () => {
    const markup = renderToStaticMarkup(
      createElement(LiveProgress, {
        stages: [
          stage({ id: 'step-10-1-run_sql', name: 'Queried governed data', kind: 'tool' }),
          stage({ id: 'step-11', name: 'Chose the next step', kind: 'agent' }),
        ],
        openedAt: 1,
        question: 'does VLH have more users than Iron Frontier?',
      })
    );
    expect(markup).toMatch(/live-step-kind[\s\S]*brand-icon/);
    expect(markup.match(/live-step-kind/g)).toHaveLength(2);
    expect(markup).toContain('pia-mark');
  });
});
