import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { abbreviatedConversationId } from './display-id';
import { RunHeader } from './RunHeader';
import { partial } from './styles/stylesheet';
import type { Run } from './app-types';

const HOME = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
const LIVE_PROGRESS = readFileSync(new URL('./LiveProgress.tsx', import.meta.url), 'utf8');
const RAIL = partial('rail.css');
const ASK = partial('ask.css');
const ASTROLABE = partial('astrolabe-tokens.css');
const TOKENS = partial('tokens.css');
const TRACE = partial('trace.css');
const RUNS = partial('runs.css');

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} exists`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

const RUN: Run = {
  id: 'msg-d78ca105',
  conversation_id: 'conv-551bcd7f-75d5-420a-877d-9ec1a8f6a3d1',
  prompt: 'Compare daily engagement by title.',
  stakeholder: 'sam@example.com',
  status: 'complete',
  duration_ms: 1,
  rating: null,
  created_at: '2026-08-21T00:00:00Z',
};

describe('Sam’s second feedback wave', () => {
  it('continues the navy sky beneath the Ask transcript but not the conversation rail', () => {
    // `--ast-sky-fill` rather than `--ast-navy`, and the two are different jobs
    // rather than two names for one colour: navy is the ink (the wordmark, the live
    // chip, the entity tag) and the sky is the dark SURFACE. Sam asked for the
    // surfaces to be a dark blue rather than a near-black, and pointing them at
    // their own token is what let the ink stay where the design put it.
    expect(rule(RAIL, '.ask-layout')).toContain('background-color: var(--ast-sky-fill)');
    // The star field, which is `:root`'s recipe rather than four dots written out
    // here: the agent map's band needs the same sky and is not a descendant of this
    // grid, so an inherited property on the page could not have reached it.
    expect(rule(RAIL, '.ask-layout')).toContain('background-image: var(--ast-sky-spackle)');
    expect(ASTROLABE).toMatch(/--ast-sky-spackle:[\s\S]*?radial-gradient/);
    expect(ASTROLABE).toMatch(/--ast-sky-fill:\s*#16202e/);
    // Six layers, because one dot per tile at one tile size is a visible lattice.
    expect(ASTROLABE.match(/--ast-sky-spackle:([\s\S]*?);/)?.[1].match(/radial-gradient/g)).toHaveLength(6);
    expect(rule(ASK, '.conversation-main')).toContain('background: transparent');
    expect(rule(ASK, '.ask-hero h2')).toContain('color: var(--ast-white)');
    // The rail is chrome, on the header's own surface. It was navy with white ink
    // and read as a near-black column beside a white header. `--ast-white` is the
    // one light surface the bubble and the answer card now share with it.
    const rail = rule(RAIL, '.conversation-rail');
    expect(rail).toContain('background: var(--card)');
    expect(rail).toContain('color: var(--foreground)');
    expect(rail).not.toContain('--ast-navy');
  });

  it('widens result surfaces without removing horizontal overflow', () => {
    // 1280, up from 1120: the card carries its figures in a right-hand rail
    // again, and the cap is the one lever that widens it without taking its
    // frame or the transcript's gutters off.
    expect(TOKENS).toContain('--conversation-measure: 1280px');
    expect(TOKENS).toContain('--conversation-inset: clamp(16px, 1.25vw, 24px)');
    expect(rule(TRACE, '.trace-dag.map .dag-grid')).toContain('overflow-x: auto');
    expect(rule(TRACE, '.trace-dag.map .dag-grid table')).toContain('min-width: 100%');
    expect(rule(TRACE, '.trace-dag.map .dag-result-table')).toContain('overflow-x: auto');
    expect(rule(RUNS, '.run-explorer')).toContain('max-width: 1760px');
  });

  it('abbreviates conversation ids for display while retaining the full value', () => {
    const full = RUN.conversation_id!;
    expect(abbreviatedConversationId(full)).toBe('conv-5');
    expect(abbreviatedConversationId('c1')).toBe('c1');

    const markup = renderToStaticMarkup(
      <RunHeader
        run={RUN}
        conversationId={full}
        conversationRun={1}
        toolCalls={21}
        reference={false}
        groundedness={null}
      />
    );
    // The chip is the id and nothing else. "Conversation" in front of `conv-5`
    // spent a third of the chip repeating what the value already says.
    expect(markup).toContain('<span class="ast-num">conv-5</span>');
    expect(markup).not.toContain('Conversation <span');
    expect(markup).toContain('conversation-context-badge ast-pill ast-pill--pos');
    expect(markup).toContain('Run <span class="ast-num">1</span>');
    expect(markup).toContain(`title="${full}"`);
    expect(markup).toContain(`aria-label="Copy full conversation id ${full}"`);
    expect(LIVE_PROGRESS).not.toContain('writeText(abbreviatedConversationId');
  });

  it('removes the new-conversation narrative and duplicate step narration', () => {
    expect(HOME).not.toContain(
      'Ask in plain language. The agent finds governed data, checks definitions, and explains the answer.'
    );
    expect(LIVE_PROGRESS).not.toContain('live-progress-detail');
    expect(LIVE_PROGRESS).not.toContain('{run.detail');
  });
});
