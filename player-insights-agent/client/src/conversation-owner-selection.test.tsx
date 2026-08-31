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
const HOME = readFileSync(new URL('HomePage.tsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('styles/rail.css', import.meta.url), 'utf8');
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
    values.set(CONVERSATION_OWNER_SELECTION_KEY, JSON.stringify([ME, 'gone@example.com']));
    expect(readOwnerSelectionPreference(owners.map((owner) => owner.key))).toEqual([ME]);
  });

  it('saves admin selections and clears legacy state for consumers', () => {
    installStorage();
    rememberOwnerSelectionPreference([ME, owners[1].key]);
    expect(JSON.parse(values.get(CONVERSATION_OWNER_SELECTION_KEY) ?? '[]')).toEqual([ME, owners[1].key]);
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
    expect(COMPONENT).toContain('role="listbox"');
    expect(COMPONENT).toContain('aria-multiselectable="true"');
    expect(COMPONENT).toContain('role="option"');
    expect(COMPONENT).toContain('aria-selected=');
    expect(COMPONENT).toContain("event.key === 'Escape'");
    expect(COMPONENT).toContain("'ArrowDown', 'ArrowUp', 'Home', 'End'");
    expect(COMPONENT).toContain("document.addEventListener('pointerdown', closeOutside)");
    expect(COMPONENT).toContain('triggerRef.current?.focus()');
  });

  it('is admin-only and clears a consumer’s legacy preference', () => {
    expect(HOME).toContain("identity.role === 'admin' || identity.role === 'super_admin'");
    expect(HOME).toContain("if (identity.role === 'consumer')");
    expect(HOME).toContain('clearOwnerSelectionPreference()');
    expect(HOME).toMatch(/adminSharedRail && rail\.owners\.length > 0/);
    expect(HOME).toContain('{adminSharedRail && owner && (');
  });

  it('cannot widen or clip the narrow rail', () => {
    expect(CSS).toMatch(/\.conversation-owner-select \{[^}]*width:\s*100%[^}]*min-width:\s*0/s);
    expect(CSS).toMatch(/\.conversation-owner-trigger \{[^}]*width:\s*100%[^}]*min-width:\s*0/s);
    expect(CSS).toMatch(/\.conversation-owner-summary \{[^}]*text-overflow:\s*ellipsis/s);
    expect(CSS).toMatch(/\.conversation-owner-menu \{[^}]*position:\s*absolute[^}]*width:\s*100%/s);
  });

  it('raises the open owner menu on an isolated, fully opaque themed surface', () => {
    expect(COMPONENT).toContain("data-open={open ? 'true' : undefined}");
    expect(CSS).toMatch(/\.conversation-owner-select \{[^}]*isolation:\s*isolate/s);
    expect(CSS).toMatch(/\.conversation-owner-select\[data-open='true'\] \{[^}]*z-index:\s*60/s);
    expect(CSS).toMatch(
      /\.conversation-owner-menu \{[^}]*z-index:\s*1[^}]*isolation:\s*isolate[^}]*border:\s*1px solid var\(--db-line-strong\)/s
    );
    expect(CSS).toMatch(
      /\.conversation-owner-menu \{[^}]*background-color:\s*var\(--popover\)[^}]*background-image:\s*none[^}]*opacity:\s*1[^}]*backdrop-filter:\s*none/s
    );
    expect(CSS).not.toMatch(/\.conversation-owner-menu \{[^}]*background:\s*var\(--card\)/s);
  });

  it('contains a long owner list in its own bounded scroller', () => {
    expect(CSS).toMatch(
      /\.conversation-owner-menu \{[^}]*max-height:\s*min\(280px,\s*50vh\)[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain[^}]*scrollbar-gutter:\s*stable/s
    );
  });
});
