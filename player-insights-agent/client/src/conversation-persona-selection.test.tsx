import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationPersonaOptions, ConversationPersonaSelect } from './ConversationPersonaSelect';
import {
  CONVERSATION_PERSONA_SELECTION_KEY,
  normalizePersonaSelection,
  personaSelectionSummary,
  railPersonas,
  readPersonaSelectionPreference,
  rememberPersonaSelectionPreference,
  togglePersonaSelection,
} from './conversation-persona-selection';
import { CONVERSATION_PERSONA_FILTER_RULE, NO_PERSONA_SELECTION } from '../../shared/conversation-filters';
import type { Conversation } from './app-types';

const COMPONENT = readFileSync(new URL('ConversationPersonaSelect.tsx', import.meta.url), 'utf8');
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
  it('counts each conversation once and uses the newest stored name snapshot', () => {
    const personas = railPersonas(conversations);
    expect(personas.map(({ key, name, count }) => ({ key, name, count }))).toEqual([
      { key: 'id:finance', name: 'Finance analyst', count: 2 },
      { key: NO_PERSONA_SELECTION, name: 'No persona', count: 1 },
    ]);
  });

  it('keeps All mutually exclusive and drops stale deleted persona ids', () => {
    expect(togglePersonaSelection([], 'id:finance')).toEqual(['id:finance']);
    expect(togglePersonaSelection(['id:finance'], 'id:finance')).toEqual([]);
    expect(normalizePersonaSelection(['id:deleted', 'id:finance'], ['id:finance'])).toEqual(['id:finance']);
    expect(personaSelectionSummary([], railPersonas(conversations))).toBe('All personas');
  });

  it('omits a deleted definition even when an old run still records its snapshot', () => {
    const historicalDeleted: Conversation = {
      id: 'deleted',
      title: 'Deleted persona history',
      updated_at: '2026-08-29T09:00:00Z',
      persona_id: 'deleted-persona',
      persona_name: 'Deleted persona',
    };
    const personas = railPersonas(
      [...conversations, historicalDeleted],
      [{ id: 'finance', name: 'Current finance name' }]
    );
    expect(personas.map((persona) => persona.key)).toEqual(['id:finance', NO_PERSONA_SELECTION]);
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
});

describe('admin persona control', () => {
  const personas = railPersonas(conversations);

  it('renders All, named, and No persona with stable counts', () => {
    const markup = renderToStaticMarkup(
      <div role="listbox" aria-multiselectable="true">
        <ConversationPersonaOptions
          personas={personas}
          total={3}
          selected={['id:finance']}
          onChange={() => undefined}
          onFocus={() => undefined}
          onOptionRef={() => undefined}
        />
      </div>
    );
    expect(markup).toContain('>All personas<');
    expect(markup).toContain('>Finance analyst<');
    expect(markup).toContain('>No persona<');
    expect(markup).toContain('aria-selected="true"');
  });

  it('exposes the exact historical rule as tooltip and accessible description', () => {
    const markup = renderToStaticMarkup(
      <ConversationPersonaSelect personas={personas} total={3} selected={[]} onChange={() => undefined} />
    );
    expect(markup).toContain('aria-label="Filter conversations by persona: All personas"');
    expect(markup).toContain(`title="${CONVERSATION_PERSONA_FILTER_RULE.replaceAll('’', '’')}"`);
    expect(markup).toContain(CONVERSATION_PERSONA_FILTER_RULE);
  });

  it('uses the same keyboard, Escape, outside-click, opaque portal contract as Owner', () => {
    expect(COMPONENT).toContain('role="listbox"');
    expect(COMPONENT).toContain('aria-multiselectable="true"');
    expect(COMPONENT).toContain("event.key === 'Escape'");
    expect(COMPONENT).toContain("'ArrowDown', 'ArrowUp', 'Home', 'End'");
    expect(COMPONENT).toContain('onOpenChange=');
    expect(COMPONENT).toContain('avoidCollisions');
    expect(COMPONENT).toContain('collisionPadding={8}');
    expect(CSS).toMatch(/\.conversation-owner-menu \{[^}]*z-index:\s*90/s);
    expect(CSS).toMatch(/\.conversation-owner-menu \{[^}]*background-color:\s*var\(--popover\)/s);
  });

  it('keeps Owner and Persona at equal usable widths and stacks only below the control minimum', () => {
    expect(HOME).toContain('<div className="conversation-filter-row">');
    expect(CSS).toMatch(
      /\.conversation-filter-row \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*1fr\)[^}]*gap:\s*8px/s
    );
    expect(CSS).toMatch(
      /@container conversation-rail \(max-width:\s*210px\)[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/
    );
    expect(CSS).toMatch(/\.conversation-owner-summary \{[^}]*text-overflow:\s*ellipsis/s);
  });
});
