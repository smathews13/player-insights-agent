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

  it('fills idle Ask with the still constellation silhouette', () => {
    expect(HOME).toContain("import { ConstellationField } from './ConstellationField'");
    expect(HOME).toContain('OPENING_CONSTELLATION');
    expect(HOME).toContain('className="trace-idle-sky"');
    expect(HOME).not.toContain('No run yet');
    expect(RAIL).toMatch(/\.trace-idle-sky\s*\{[^}]*z-index:\s*0/);
    expect(RAIL).toMatch(/\.trace-idle-sky \[class\*='ast-anim-'\]\s*\{[^}]*animation:\s*none/);
  });

  it('keeps the constellation layer behind the Agent path chrome', () => {
    expect(RAIL).toMatch(/\.trace-idle-sky\s*\{[^}]*z-index:\s*0[^}]*pointer-events:\s*none/);
    expect(RAIL).toMatch(
      /\.trace-head,\s*\.trace-title,\s*\.trace-working,\s*\.trace-inspector \.ast-sky\s*\{[^}]*z-index:\s*1/
    );
    expect(RAIL).toMatch(/\.trace-inspector\s*\{[^}]*isolation:\s*isolate/);
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

  it('keeps the Asked by chip a compact pill, not a full-width slab', () => {
    expect(RAIL).toMatch(/\.conversation-owner\s*\{[^}]*flex:\s*none[^}]*width:\s*auto/);
    expect(RAIL).not.toMatch(/\.conversation-owner\s*\{[^}]*width:\s*100%/);
    expect(RAIL).not.toMatch(/\.conversation-owner\s*\{[^}]*flex:\s*1/);
    expect(RAIL).not.toMatch(
      /\.conversation-rail \.conversation-owner \.identity-chip-text\s*\{[^}]*white-space:\s*normal/
    );
  });
});

describe('live step rows carry the Agent path kind mark under the number', () => {
  it('stacks the map’s product or agent mark under the numbered badge', () => {
    expect(PANEL).toContain('live-step-index');
    expect(PANEL).toContain('live-step-kind');
    expect(PANEL).toContain('live-step-icon step-rail-num ast-num');
    expect(PANEL).toContain("import { productForTool } from './brand-icons'");
    expect(PANEL).toContain('<BrandIcon product={product}');
    expect(PANEL).toContain('<AstrolabeMark size={13} />');
    expect(LIVE).toMatch(/\.live-step-index\s*\{[^}]*flex-direction:\s*column/);
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
    expect(markup).toContain('ast-mark');
  });
});
