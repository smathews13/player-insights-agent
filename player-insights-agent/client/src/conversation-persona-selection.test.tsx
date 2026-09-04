import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationPersonaSelect } from './ConversationPersonaSelect';
import {
  CONVERSATION_PERSONA_SELECTION_KEY,
  normalizePersonaSelection,
  personaSelectionSummary,
  railPersonas,
  readPersonaSelectionPreference,
  rememberPersonaSelectionPreference,
  togglePersonaSelection,
} from './conversation-persona-selection';
import { moveOwnerFocus } from './conversation-owner-selection';
import { CONVERSATION_PERSONA_FILTER_RULE } from '../../shared/conversation-filters';
import type { Conversation } from './app-types';

const COMPONENT = readFileSync(new URL('ConversationPersonaSelect.tsx', import.meta.url), 'utf8');
const MULTISELECT = [
  readFileSync(new URL('AppMultiSelect.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('AppMultiSelectMenu.tsx', import.meta.url), 'utf8'),
].join('\n');
const HOME = readFileSync(new URL('HomePage.tsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('styles/rail.css', import.meta.url), 'utf8');

const conversations: Conversation[] = [
  {
    id: 'finance-a',
    title: 'A',
    updated_at: '2026-08-31T10:00:00Z',
    user_email: 'alice@example.com',
    persona_id: 'finance',
    persona_name: 'Finance analyst',
    persona_recorded_at: '2026-08-31T09:00:00Z',
  },
  {
    id: 'finance-b',
    title: 'B',
    updated_at: '2026-08-31T09:00:00Z',
    user_email: 'bob@example.com',
    persona_id: 'finance',
    persona_name: 'Renamed finance analyst',
    persona_recorded_at: '2026-08-31T08:00:00Z',
  },
  {
    id: 'none',
    title: 'Old conversation',
    updated_at: '2026-08-30T09:00:00Z',
    user_email: 'alice@example.com',
    persona_id: null,
    persona_name: null,
  },
];

describe('persisted persona facets', () => {
  it('shows only named values in mixed history while All counts every conversation', () => {
    const personas = railPersonas(conversations);
    expect(personas.map(({ key, name, count }) => ({ key, name, count }))).toEqual([
      { key: 'id:finance', name: 'Finance analyst', count: 2 },
    ]);
    const markup = renderToStaticMarkup(
      <ConversationPersonaSelect
        personas={personas}
        total={conversations.length}
        selected={[]}
        onChange={() => undefined}
      />
    );
    expect(markup).toContain('>All personas<');
    expect(COMPONENT).toContain('count: persona.count');
    expect(COMPONENT).toContain('persona.count} conversation');
  });

  it('shows only All personas for missing-only history with no empty second row', () => {
    const personas = railPersonas([conversations[2]]);
    expect(personas).toEqual([]);
    const markup = renderToStaticMarkup(
      <ConversationPersonaSelect personas={personas} total={1} selected={[]} onChange={() => undefined} />
    );
    expect(markup.match(/role="combobox"/g)).toHaveLength(1);
    expect(markup).toContain('>All personas<');
  });

  it('counts named-only history without adding placeholder choices', () => {
    expect(railPersonas(conversations.slice(0, 2))).toMatchObject([
      { key: 'id:finance', name: 'Finance analyst', count: 2 },
    ]);
    expect(
      railPersonas([
        {
          id: 'blank-name',
          title: 'Blank',
          updated_at: '2026-08-31T10:00:00Z',
          persona_id: 'opaque-id',
          persona_name: ' ',
        },
        {
          id: 'blank-id',
          title: 'Blank',
          updated_at: '2026-08-31T10:00:00Z',
          persona_id: null,
          persona_name: 'Unassigned',
        },
      ])
    ).toEqual([]);
  });

  it('keeps All mutually exclusive and drops stale persona ids', () => {
    expect(togglePersonaSelection([], 'id:finance')).toEqual(['id:finance']);
    expect(togglePersonaSelection(['id:finance'], 'id:finance')).toEqual([]);
    expect(normalizePersonaSelection(['id:deleted', 'id:finance'], ['id:finance'])).toEqual(['id:finance']);
    expect(personaSelectionSummary([], railPersonas(conversations))).toBe('All personas');
  });

  it('does not synthesize a visible name from an opaque persona id', () => {
    expect(
      railPersonas([
        {
          id: 'opaque',
          title: 'Opaque',
          updated_at: '2026-08-29T09:00:00Z',
          persona_id: 'internal-persona-id',
          persona_name: null,
        },
      ])
    ).toEqual([]);
  });
});

describe('persona preference isolation', () => {
  const values = new Map<string, string>();

  afterEach(() => {
    values.clear();
    vi.unstubAllGlobals();
  });

  it('restores only the same admin and only personas still in their authorized rail', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    rememberPersonaSelectionPreference('alice@example.com', ['id:finance', 'id:deleted']);
    expect(readPersonaSelectionPreference('alice@example.com', ['id:finance'])).toEqual(['id:finance']);
    expect(readPersonaSelectionPreference('bob@example.com', ['id:finance'])).toEqual([]);
    const stored = JSON.parse(values.get(CONVERSATION_PERSONA_SELECTION_KEY) ?? '{}') as {
      subject?: unknown;
    };
    expect(stored.subject).toBe('alice@example.com');
  });

  it('purges the retired persisted token and falls back to All personas', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    values.set(
      CONVERSATION_PERSONA_SELECTION_KEY,
      JSON.stringify({ subject: 'alice@example.com', selected: ['none', 'id:finance'] })
    );
    expect(readPersonaSelectionPreference('alice@example.com', ['id:finance'])).toEqual([]);
    expect(values.has(CONVERSATION_PERSONA_SELECTION_KEY)).toBe(false);
    expect(normalizePersonaSelection(['none'], ['id:finance'])).toEqual([]);
  });
});

describe('admin persona control', () => {
  const personas = railPersonas(conversations);

  it('renders All and named options with stable counts and no banned rail text', () => {
    const markup = renderToStaticMarkup(
      <ConversationPersonaSelect personas={personas} total={3} selected={['id:finance']} onChange={() => undefined} />
    );
    expect(markup).toContain('>Finance analyst<');
    expect(markup).not.toContain('Persona ·');
    expect(COMPONENT).toContain('count: persona.count');
    expect(COMPONENT).toContain('allLabel="All personas"');
    expect(markup.toLowerCase()).not.toMatch(/no persona|unassigned|placeholder/);
  });

  it('exposes the exact historical rule as tooltip and accessible description', () => {
    const markup = renderToStaticMarkup(
      <ConversationPersonaSelect personas={personas} total={3} selected={[]} onChange={() => undefined} />
    );
    expect(markup).toContain('aria-label="Filter conversations by persona: All personas"');
    expect(markup).toContain(`title="All personas — ${CONVERSATION_PERSONA_FILTER_RULE.replaceAll('’', '’')}"`);
    expect(markup).toContain(CONVERSATION_PERSONA_FILTER_RULE);
    expect(markup.toLowerCase()).not.toMatch(/no persona|unassigned|placeholder/);
  });

  it('keeps keyboard navigation valid when All personas is the only option', () => {
    expect(moveOwnerFocus(0, 'ArrowDown', 1)).toBe(0);
    expect(moveOwnerFocus(0, 'ArrowUp', 1)).toBe(0);
    expect(moveOwnerFocus(0, 'Home', 1)).toBe(0);
    expect(moveOwnerFocus(0, 'End', 1)).toBe(0);
    expect(MULTISELECT).toContain('role="listbox"');
    expect(MULTISELECT).toContain('aria-multiselectable="true"');
    expect(MULTISELECT).toContain("event.key === 'Escape'");
    expect(MULTISELECT).toContain("'ArrowDown', 'ArrowUp', 'Home', 'End'");
    expect(MULTISELECT).toContain('onOpenChange=');
    expect(MULTISELECT).toContain('avoidCollisions');
    expect(MULTISELECT).toContain('collisionPadding={8}');
  });

  it('keeps Owner and Persona at equal usable widths and stacks only below the control minimum', () => {
    expect(HOME).toContain('<div className="conversation-filter-row">');
    expect(CSS).toMatch(
      /\.conversation-filter-row \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*1fr\)[^}]*gap:\s*8px/s
    );
    expect(CSS).toMatch(
      /@container conversation-rail \(max-width:\s*210px\)[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/
    );
    expect(MULTISELECT).toContain('<span className="app-select-value">{summary}</span>');
  });
});
