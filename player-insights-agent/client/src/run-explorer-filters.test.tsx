import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RunExplorerFilters } from './RunExplorer';
import { matchingRuns } from './run-explorer-state';
import { partial } from './styles/stylesheet';
import type { Run } from './app-types';

const RUNS = partial('runs.css');
const RESPONSIVE = partial('responsive-runs.css');
const BASE = partial('base.css');
const UI = readFileSync(new URL('./ui.ts', import.meta.url), 'utf8');

function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} exists`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

function filters(conversation: string, username: string): string {
  return renderToStaticMarkup(
    <RunExplorerFilters
      conversationFilter="conv-long"
      usernameFilter="long.user@example.com"
      conversationOptions={[{ id: 'conv-long', label: conversation }]}
      usernameOptions={[{ value: 'long.user@example.com', label: username }]}
      onConversationChange={() => undefined}
      onUsernameChange={() => undefined}
    />
  );
}

describe('Run Explorer filter geometry', () => {
  it('keeps long values inside two zero-minimum bounded tracks', () => {
    const layout = rule(RUNS, '.run-list-filters');
    expect(layout).toContain('grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr)');
    expect(layout).toContain('min-width: 0');
    expect(rule(RUNS, '.run-filter-field')).toContain('max-width: 100%');
    expect(rule(RUNS, '.run-conversation-filter,\n.run-username-filter')).toContain('max-width: 100%');
    expect(rule(RUNS, '.run-filter-label')).toContain('text-overflow: ellipsis');
  });

  it('keeps full selected values in accessible names and tooltips', () => {
    const conversation = 'Compare every active player cohort across all supported franchises and regions';
    const username = 'a.very.long.user.address.for.layout.testing@example.com';
    const markup = filters(conversation, username);
    expect(markup).toContain(`title="${conversation}"`);
    expect(markup).toContain(`Filter runs by conversation: ${conversation}`);
    expect(markup).toContain(`title="${username}"`);
    expect(markup).toContain(`Filter runs by username: ${username}`);
  });

  it('portals popper menus above panels and caps them to the viewport', () => {
    expect(UI).toContain("createElement(AppKitSelectContent, { position: 'popper', ...props })");
    expect(rule(BASE, '[data-radix-popper-content-wrapper]')).toContain('z-index: 90');
    expect(rule(BASE, '[data-radix-popper-content-wrapper]')).toContain('max-width: calc(100vw - 24px)');
    const menu = rule(RUNS, '.run-filter-menu');
    expect(menu).toContain('max-width: min(30rem, calc(100vw - 24px))');
    expect(menu).toContain('var(--radix-select-content-available-height)');
  });

  it('reserves the list scrollbar without changing the two-pane columns', () => {
    expect(rule(RUNS, '.run-list')).toContain('scrollbar-gutter: stable');
    expect(rule(RUNS, '.explorer-layout')).toContain('grid-template-columns: 340px minmax(0, 1fr)');
  });

  it('stacks both full-width filters at the shared 800px breakpoint', () => {
    const narrow = RESPONSIVE.slice(RESPONSIVE.indexOf('@media (max-width: 800px)'));
    expect(narrow).toMatch(/\.run-list-filters\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(narrow).toMatch(/\.run-filter-field,[\s\S]*?width:\s*100%/);
    expect(RESPONSIVE).not.toMatch(/@media \(max-width: (?!1365|1180|800|480)\d+px\)/);
  });

  it('clearing one filter leaves the other filter and search in force', () => {
    const rows: Run[] = [
      {
        id: 'one',
        conversation_id: 'conv-one',
        prompt: 'alpha players',
        stakeholder: 'reader@example.com',
        status: 'complete',
        duration_ms: 1,
        rating: null,
        created_at: '2026-08-28T00:00:00Z',
      },
      {
        id: 'two',
        conversation_id: 'conv-two',
        prompt: 'beta players',
        stakeholder: 'other@example.com',
        status: 'complete',
        duration_ms: 1,
        rating: null,
        created_at: '2026-08-28T00:00:00Z',
      },
    ];
    expect(matchingRuns(rows, { conversationId: '', username: 'reader', search: 'alpha' })).toEqual([rows[0]]);
  });
});
