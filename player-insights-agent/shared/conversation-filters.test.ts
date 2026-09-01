import { describe, expect, it } from 'vitest';
import {
  MAX_CONVERSATION_FILTER_VALUES,
  conversationMatchesFilters,
  parseConversationFilterQuery,
} from './conversation-filters';

describe('conversation filter query contract', () => {
  it('normalizes owners, deduplicates opaque persona ids, and caps both lists', () => {
    const owners = Array.from(
      { length: MAX_CONVERSATION_FILTER_VALUES + 5 },
      (_, index) => ` User-${index}@Example.com `
    );
    const personas = Array.from({ length: MAX_CONVERSATION_FILTER_VALUES + 5 }, (_, index) => `persona-${index}`);
    const parsed = parseConversationFilterQuery({
      owners: [owners[0], owners[0].toLowerCase(), ...owners.slice(1)],
      personas: [personas[0], personas[0], ...personas.slice(1)],
    });
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.value.owners).toHaveLength(MAX_CONVERSATION_FILTER_VALUES);
    expect(parsed.value.owners[0]).toBe('user-0@example.com');
    expect(parsed.value.personaIds).toHaveLength(MAX_CONVERSATION_FILTER_VALUES);
  });

  it('rejects malformed and oversized values', () => {
    expect(parseConversationFilterQuery({ owners: { forged: 'someone@example.com' } }).ok).toBe(false);
    expect(parseConversationFilterQuery({ personas: 'x'.repeat(81) }).ok).toBe(false);
    expect(parseConversationFilterQuery({ no_persona: 'yes' }).ok).toBe(false);
  });

  it('retires a stale missing-persona URL filter to the unfiltered persona set', () => {
    const parsed = parseConversationFilterQuery({ no_persona: 'true' });
    expect(parsed).toEqual({ ok: true, value: { owners: [], personaIds: [] } });
    if (!parsed.ok) return;
    expect(conversationMatchesFilters({ id: 'missing', persona_id: null }, parsed.value)).toBe(true);
    expect(conversationMatchesFilters({ id: 'named', persona_id: 'finance' }, parsed.value)).toBe(true);
  });
});

describe('owner and persisted-persona AND semantics', () => {
  const filters = {
    owners: ['alice@example.com'],
    personaIds: ['finance'],
  };

  it('requires both filters while OR-ing selected persona values', () => {
    expect(
      conversationMatchesFilters({ id: 'match', user_email: 'Alice@Example.com', persona_id: 'finance' }, filters)
    ).toBe(true);
    expect(
      conversationMatchesFilters({ id: 'wrong-owner', user_email: 'bob@example.com', persona_id: 'finance' }, filters)
    ).toBe(false);
    expect(
      conversationMatchesFilters({ id: 'wrong-persona', user_email: 'alice@example.com', persona_id: 'sales' }, filters)
    ).toBe(false);
  });

  it('keeps missing evidence under All and excludes it from named filters', () => {
    const allPersonas = { owners: [], personaIds: [] };
    expect(conversationMatchesFilters({ id: 'old', user_email: 'alice@example.com' }, allPersonas)).toBe(true);
    expect(
      conversationMatchesFilters(
        { id: 'old', user_email: 'alice@example.com' },
        { owners: [], personaIds: ['finance'] }
      )
    ).toBe(false);
  });
});
