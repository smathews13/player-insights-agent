/**
 * The header lockup is a home control: Ask, empty landing, no conversation id.
 *
 * There is no jsdom click driver in this repo. What this file can pin is the
 * href a reader would follow, that following it forgets the open thread, and
 * that a mounted Ask page is told to show the starter — the three facts a
 * dead image would fail.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { ASK_HOME_HREF, goToAskHome, subscribeAskHome } from './ask-home-control';
import { HeaderBrand } from './Layout';
import { CONVERSATION_PARAM } from './conversation-links';
import {
  readSelectedConversation,
  rememberSelectedConversation,
  resetSelectedConversationForTests,
} from './selected-conversation';
import { partial } from './styles/stylesheet';

const LAYOUT = readFileSync(new URL('Layout.tsx', import.meta.url), 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
const HOME = readFileSync(new URL('HomePage.tsx', import.meta.url), 'utf8');
const SHELL = partial('shell.css');

afterEach(() => {
  resetSelectedConversationForTests();
});

function brandMarkup(initialEntry = '/runs'): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[initialEntry]}>
      <HeaderBrand />
    </MemoryRouter>
  );
}

function homeHref(markup: string): string | null {
  return markup.match(/<a[^>]*\bhref="([^"]*)"[^>]*>[\s\S]*?Player Insights/)?.[1] ?? null;
}

describe('the header lockup is a home control', () => {
  it('is a link to Ask with no conversation id, from every tab', () => {
    for (const here of ['/runs', '/monitoring', '/ops', '/connections', '/architecture', '/?c=conv-open']) {
      const href = homeHref(brandMarkup(here));
      expect(href, `from ${here}`).toBe(ASK_HOME_HREF);
      expect(new URL(href ?? '', 'https://player-insights.example').searchParams.has(CONVERSATION_PARAM)).toBe(false);
    }
  });

  it('is a control a keyboard can reach, not a dead image', () => {
    const markup = brandMarkup();
    const href = homeHref(markup);
    expect(href).toBe(ASK_HOME_HREF);
    expect(markup).toMatch(/<a\b[^>]*href="\/"/);
    expect(markup).not.toMatch(/<img\b/);
  });

  it('wraps the existing lockup and does not replace it', () => {
    expect(LAYOUT).toContain(`to={ASK_HOME_HREF}`);
    expect(LAYOUT).toContain('className="brand-home"');
    expect(LAYOUT).toMatch(/<Link[\s\S]*?<PiaLockup as="h1" seat="header"/);
    expect(LAYOUT).toContain('goToAskHome()');
  });

  it('forgets the open thread so returning to Ask cannot restore it', () => {
    rememberSelectedConversation('conv-open');
    let askedHome = 0;
    const stop = subscribeAskHome(() => {
      askedHome += 1;
    });

    goToAskHome();

    expect(readSelectedConversation()).toBeNull();
    expect(askedHome).toBe(1);
    stop();
  });

  it('tells a mounted Ask page to show the starter', () => {
    expect(HOME).toContain("import { subscribeAskHome } from './ask-home-control'");
    expect(HOME).toMatch(/subscribeAskHome\(\(\) => startNewConversation\(\)\)/);
  });

  it('strips link chrome without painting the mark', () => {
    expect(SHELL).toMatch(/\.brand-home\s*\{[^}]*text-decoration:\s*none[^}]*\}/);
    expect(SHELL).toMatch(/\.brand-home\s*\{[^}]*color:\s*inherit/);
    expect(SHELL).not.toMatch(/\.brand-home[^{]*\{[^}]*background:/);
  });
});
