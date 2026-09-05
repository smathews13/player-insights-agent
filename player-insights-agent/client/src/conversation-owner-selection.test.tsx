import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationOwnerSelect } from './ConversationOwnerSelect';
import type { RailOwner } from './conversation-rail';
import {
  CONVERSATION_OWNER_SELECTION_KEY,
  MAX_OWNER_SELECTIONS,
  clearOwnerSelectionPreference,
  moveOwnerFocus,
  normalizeOwnerSelection,
  ownerSelectionSummary,
  readOwnerSelectionPreference,
  rememberOwnerSelectionPreference,
  toggleOwnerSelection,
} from './conversation-owner-selection';

const COMPONENT = readFileSync(new URL('ConversationOwnerSelect.tsx', import.meta.url), 'utf8');
const MULTISELECT = [
  readFileSync(new URL('AppMultiSelect.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('AppMultiSelectMenu.tsx', import.meta.url), 'utf8'),
].join('\n');
const HOME = readFileSync(new URL('HomePage.tsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('styles/rail.css', import.meta.url), 'utf8');
const BASE = readFileSync(new URL('styles/base.css', import.meta.url), 'utf8');
const RESPONSIVE = readFileSync(new URL('styles/responsive.css', import.meta.url), 'utf8');
const UI = readFileSync(new URL('ui.ts', import.meta.url), 'utf8');
const ME = '<your-username>@example.com';
const owners: RailOwner[] = [
  { key: ME, email: ME, count: 2, you: true },
  { key: 'jay@example.com', email: 'jay@example.com', count: 1, you: false },
  { key: 'manish@example.com', email: 'manish@example.com', count: 4, you: false },
];

describe('owner selection semantics', () => {
  it('makes All mutually exclusive with explicit owners', () => {
    expect(toggleOwnerSelection([], owners[0].key)).toEqual([ME]);
    expect(toggleOwnerSelection([ME], ME)).toEqual([]);
    expect(toggleOwnerSelection([ME], owners[1].key)).toEqual([ME, owners[1].key]);
  });

  it('normalizes, deduplicates, drops stale owners, and caps forged state', () => {
    const repeated = Array.from({ length: MAX_OWNER_SELECTIONS + 5 }, (_, index) => `person-${index}@example.com`);
    const available = [ME, ...repeated];
    expect(normalizeOwnerSelection([' <your-username>@EXAMPLE.COM ', ME, 'gone@example.com'], available)).toEqual([ME]);
    expect(normalizeOwnerSelection(repeated, available)).toHaveLength(MAX_OWNER_SELECTIONS);
    expect(toggleOwnerSelection(repeated.slice(0, MAX_OWNER_SELECTIONS), 'one-more@example.com')).toHaveLength(
      MAX_OWNER_SELECTIONS
    );
  });

  it('keeps summaries compact at rail width', () => {
    expect(ownerSelectionSummary([], owners)).toBe('All users');
    expect(ownerSelectionSummary([ME], owners)).toBe('You');
    expect(ownerSelectionSummary([owners[1].key], owners)).toBe('jay');
    expect(ownerSelectionSummary([ME, owners[1].key], owners)).toBe('2 users');
  });

  it('wraps arrow navigation and handles Home and End', () => {
    expect(moveOwnerFocus(0, 'ArrowUp', 4)).toBe(3);
    expect(moveOwnerFocus(3, 'ArrowDown', 4)).toBe(0);
    expect(moveOwnerFocus(2, 'Home', 4)).toBe(0);
    expect(moveOwnerFocus(1, 'End', 4)).toBe(3);
  });
});

describe('owner selection persistence', () => {
  const values = new Map<string, string>();

  afterEach(() => {
    values.clear();
    vi.unstubAllGlobals();
  });

  function installStorage() {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
  }

  it('restores only owners still present in the current data scope', () => {
    installStorage();
    values.set(CONVERSATION_OWNER_SELECTION_KEY, JSON.stringify({ subject: ME, selected: [ME, 'gone@example.com'] }));
    expect(
      readOwnerSelectionPreference(
        ME,
        owners.map((owner) => owner.key)
      )
    ).toEqual([ME]);
    expect(
      readOwnerSelectionPreference(
        'someone-else@example.com',
        owners.map((owner) => owner.key)
      )
    ).toEqual([]);
  });

  it('saves admin selections and clears legacy state for consumers', () => {
    installStorage();
    rememberOwnerSelectionPreference(ME, [ME, owners[1].key]);
    expect(JSON.parse(values.get(CONVERSATION_OWNER_SELECTION_KEY) ?? '{}')).toEqual({
      subject: ME,
      selected: [ME, owners[1].key],
    });
    clearOwnerSelectionPreference();
    expect(values.has(CONVERSATION_OWNER_SELECTION_KEY)).toBe(false);
  });
});

describe('the admin owner dropdown', () => {
  it('renders one compact labelled trigger, not a row of owner chips', () => {
    const markup = renderToStaticMarkup(
      <ConversationOwnerSelect owners={owners} total={7} selected={[]} onChange={() => undefined} />
    );
    expect(markup).toContain('aria-label="Filter conversations by owner: All users"');
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('conversation-filter-chip');
  });

  it('implements multiselect ARIA, keyboard focus, Escape, and outside click closing', () => {
    expect(COMPONENT).toContain('<AppMultiSelect');
    expect(MULTISELECT).toContain('role="listbox"');
    expect(MULTISELECT).toContain('aria-multiselectable="true"');
    expect(MULTISELECT).toContain('role="option"');
    expect(MULTISELECT).toContain('aria-selected=');
    expect(MULTISELECT).toContain("event.key === 'Escape'");
    expect(MULTISELECT).toContain("'ArrowDown', 'ArrowUp', 'Home', 'End'");
    expect(MULTISELECT).toContain('<Popover');
    expect(MULTISELECT).toContain('onOpenChange=');
    expect(MULTISELECT).toContain('<PopoverContent');
    expect(UI).toContain('PopoverContent,');
    expect(MULTISELECT).toContain('triggerRef.current?.focus()');
  });

  it('renders a concise trigger and maps every owner into the shared menu', () => {
    const markup = renderToStaticMarkup(
      <ConversationOwnerSelect owners={owners} total={7} selected={[owners[1].key]} onChange={() => undefined} />
    );
    expect(markup).toContain('>jay<');
    expect(markup).not.toContain('User ·');
    expect(COMPONENT).toContain('count: owner.count');
    expect(COMPONENT).toContain('title: owner.email');
  });

  it('is admin-only and clears a consumer’s legacy preference', () => {
    expect(HOME).toContain("identity.role === 'admin' || identity.role === 'super_admin'");
    expect(HOME).toContain("if (identity.role === 'consumer')");
    expect(HOME).toContain('clearOwnerSelectionPreference()');
    expect(HOME).toMatch(/adminSharedRail && rail\.owners\.length > 0/);
    expect(HOME).toContain('{owner ? (');
    expect(HOME).toContain('<OrganizationUserBadge');
    expect(HOME).toContain('canOpen={adminSharedRail}');
  });

  it('cannot widen or push the narrow rail', () => {
    expect(CSS).toMatch(/\.conversation-owner-select \{[^}]*width:\s*100%[^}]*min-width:\s*0/s);
    expect(BASE).toMatch(/\.app-multiselect-trigger \{[^}]*width:\s*100%/s);
    expect(BASE).toMatch(/\.app-select-value \{[^}]*text-overflow:\s*ellipsis/s);
    expect(BASE).toMatch(
      /\.app-select-content \{[^}]*width:\s*min\(max\(var\(--radix-popover-trigger-width\), 18rem\), 24rem, calc\(100vw - 24px\)\)[^}]*min-width:\s*min\(var\(--radix-popover-trigger-width\), calc\(100vw - 24px\)\)/s
    );
  });

  it('resolves the menu surface to the opaque shared menu role in both themes', () => {
    expect(BASE).toMatch(/\.app-menu-content \{[^}]*isolation:\s*isolate[^}]*border:\s*1px solid/s);
    expect(BASE).toMatch(
      /\.app-menu-content \{[^}]*background:\s*var\(--ast-surface-menu\)[^}]*background-image:\s*none[^}]*opacity:\s*1[^}]*backdrop-filter:\s*none/s
    );
  });

  it('escapes every clipping ancestor and stays above cards, sky, composer, and the mobile sheet', () => {
    expect(CSS).toMatch(/\.conversation-rail \{[^}]*overflow:\s*hidden/s);
    expect(CSS).toMatch(/\.conversation-list \{[^}]*overflow-y:\s*auto/s);
    expect(CSS).toMatch(/\.rail-sheet \{[^}]*overflow:\s*hidden/s);
    expect(CSS).toMatch(/\.conversation-rail\.is-sheet \{[^}]*overflow:\s*hidden/s);
    expect(MULTISELECT).toContain('<PopoverContent');
    expect(HOME).toContain('<SheetContent side="left" className="rail-sheet">');
    expect(HOME).toContain('<div className="conversation-rail is-sheet ast-surface-primary">');
    expect(RESPONSIVE).toMatch(/\.conversation-rail\s*\{\s*display:\s*none/);
    expect(BASE).toMatch(/\[data-radix-popper-content-wrapper\] \{[^}]*z-index:\s*var\(--ast-layer-menu\)/s);
  });

  it('uses portal collision geometry and a bounded internal scroller at the rail bottom', () => {
    expect(MULTISELECT).toContain('side="bottom"');
    expect(MULTISELECT).toContain('sideOffset={4}');
    expect(MULTISELECT).toContain('avoidCollisions');
    expect(MULTISELECT).toContain('collisionPadding={8}');
    expect(MULTISELECT).toContain('sticky="always"');
    expect(MULTISELECT).toContain('hideWhenDetached');
    expect(MULTISELECT).toContain('updatePositionStrategy="always"');
    expect(BASE).toMatch(
      /\.app-select-content \{[^}]*max-height:\s*min\(320px,\s*var\(--radix-popover-content-available-height\)\)[^}]*overflow-y:\s*auto[^}]*overflow-x:\s*hidden[^}]*overscroll-behavior:\s*contain[^}]*scrollbar-gutter:\s*stable/s
    );
  });
});
