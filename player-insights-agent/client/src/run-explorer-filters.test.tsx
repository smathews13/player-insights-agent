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
const APP_SELECT = readFileSync(new URL('./AppSelect.tsx', import.meta.url), 'utf8');
const EXPLORER = readFileSync(new URL('./RunExplorer.tsx', import.meta.url), 'utf8');

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
    expect(rule(BASE, '.app-select-value')).toContain('text-overflow: ellipsis');
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
    expect(APP_SELECT).toContain('<PopoverContent');
    expect(APP_SELECT).toContain('avoidCollisions');
    expect(rule(BASE, '[data-radix-popper-content-wrapper]')).toContain('z-index: var(--ast-layer-menu)');
    expect(rule(BASE, '[data-radix-popper-content-wrapper]')).toContain('max-width: calc(100vw - 24px)');
    const menu = rule(BASE, '.app-select-content');
    expect(menu).toContain('max(var(--radix-popover-trigger-width), 18rem)');
    expect(menu).toContain('max-width: min(24rem, calc(100vw - 24px))');
    expect(menu).toContain('var(--radix-popover-content-available-height)');
  });

  it('gives both scoped triggers the shared hover, open, focus, and disabled states', () => {
    const markup = filters('All conversations', 'All users');
    expect(markup.match(/run-filter-trigger/g)).toHaveLength(2);

    const interactive = [
      rule(BASE, ".app-select-trigger:hover:not(:disabled),\n.app-select-trigger[data-state='open']:not(:disabled)"),
      rule(BASE, '.app-select-trigger:focus-visible'),
    ];
    expect(interactive[0]).toContain('border-color: var(--primary)');
    expect(interactive[0]).toContain('background: color-mix(in srgb, var(--background) 94%, var(--primary))');
    expect(BASE).toMatch(
      /\.app-select-trigger\[data-state='open'\]:not\(:disabled\)\s*\{\s*background:\s*color-mix\(in srgb, var\(--background\) 88%, var\(--primary\)\)/
    );
    expect(interactive[1]).toContain('box-shadow: 0 0 0 2px');
    for (const state of interactive) expect(state).not.toMatch(/(?:padding|margin|width|height|font-weight):/);

    const disabled = rule(BASE, '.app-select-trigger:disabled,\n.app-select-trigger[data-disabled]');
    expect(disabled).toContain('cursor: not-allowed');
    expect(disabled).toContain('opacity: 1');
  });

  it('gives the opaque shared menu distinct hover, selected, and disabled options', () => {
    expect(rule(BASE, '.app-menu-content')).toContain('background: var(--ast-surface-menu)');
    expect(rule(BASE, '.app-menu-option:is(:hover, :focus-visible),\n.app-menu-option[data-highlighted]')).toContain(
      'background: var(--db-hover-tint)'
    );
    expect(rule(BASE, ".app-menu-option[data-state='checked']")).toContain('background: var(--db-selected-tint)');
    expect(rule(BASE, '.app-menu-option:disabled')).toContain('cursor: not-allowed');
  });

  it('reserves the list scrollbar without changing the two-pane columns', () => {
    expect(rule(RUNS, '.run-list,\n.run-detail')).toContain('scrollbar-gutter: stable');
    expect(rule(RUNS, '.explorer-layout')).toContain('grid-template-columns: 340px minmax(0, 1fr)');
  });

  it('stacks both full-width filters with the tablet Run Explorer layout', () => {
    const narrow = RESPONSIVE.slice(RESPONSIVE.indexOf('@media (max-width: 960px)'));
    expect(narrow).toMatch(/\.run-list-filters\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(narrow).toMatch(/\.run-filter-field,[\s\S]*?width:\s*100%/);
    expect(RESPONSIVE).not.toMatch(/@media \(max-width: (?!1365|1180|960|480)\d+px\)/);
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

describe('Run Explorer tab interaction states', () => {
  it('keeps the four tabs scoped to the Run Explorer detail pane', () => {
    expect(EXPLORER).toMatch(
      /className="run-detail-tabs"[\s\S]*value="overview"[\s\S]*value="map"[\s\S]*value="timeline"[\s\S]*value="details"/
    );
    expect(rule(RUNS, ".run-detail [data-slot='tabs-trigger']")).toContain('cursor: pointer');
    expect(rule(RUNS, ".run-detail [data-slot='tabs-list']")).toContain('overflow: visible');
  });

  it('previews inactive tabs without moving them and preserves the active treatment', () => {
    const hover = rule(
      RUNS,
      ".run-detail [data-slot='tabs-trigger'][data-state='inactive']:hover:not(:disabled):not([data-disabled])"
    );
    expect(hover).toContain('border-bottom-color: var(--ast-border-input)');
    expect(hover).toContain('background: transparent');
    expect(hover).toContain('color: var(--ast-text)');

    const activeHover = rule(RUNS, ".run-detail [data-slot='tabs-trigger'][data-state='active']:hover");
    expect(activeHover).toContain('border-bottom-color: var(--primary)');
    expect(activeHover).toContain('color: var(--primary)');
    for (const state of [hover, activeHover]) {
      expect(state).not.toMatch(/(?:padding|margin|width|height|font-size|font-weight|border-width):/);
    }
  });

  it('shows unclipped keyboard focus and leaves disabled tabs muted', () => {
    const focus = rule(RUNS, ".run-detail [data-slot='tabs-trigger']:focus-visible");
    expect(focus).toContain('outline: 2px solid var(--ring)');
    expect(focus).toContain('border-bottom-color: transparent');
    expect(focus).toContain('background: transparent');
    const disabled = rule(RUNS, ".run-detail [data-slot='tabs-trigger']:is(:disabled, [data-disabled])");
    expect(disabled).toContain('cursor: not-allowed');
    expect(disabled).toContain('opacity: 0.55');
    expect(RUNS).toContain('@media (forced-colors: active)');
  });
});
