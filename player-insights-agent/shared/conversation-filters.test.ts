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
      no_persona: 'true',
    });
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.value.owners).toHaveLength(MAX_CONVERSATION_FILTER_VALUES);
    expect(parsed.value.owners[0]).toBe('user-0@example.com');
    expect(parsed.value.personaIds).toHaveLength(MAX_CONVERSATION_FILTER_VALUES);
    expect(parsed.value.includeNoPersona).toBe(true);
  });

  it('rejects malformed and oversized values', () => {
    expect(parseConversationFilterQuery({ owners: { forged: 'someone@example.com' } }).ok).toBe(false);
    expect(parseConversationFilterQuery({ personas: 'x'.repeat(81) }).ok).toBe(false);
    expect(parseConversationFilterQuery({ no_persona: 'yes' }).ok).toBe(false);
  });
});

describe('owner and persisted-persona AND semantics', () => {
  const filters = {
    owners: ['alice@example.com'],
    personaIds: ['finance'],
    includeNoPersona: false,
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

  it('matches No persona only when historical evidence is absent', () => {
    const noPersona = { owners: [], personaIds: [], includeNoPersona: true };
    expect(conversationMatchesFilters({ id: 'old', user_email: 'alice@example.com' }, noPersona)).toBe(true);
    expect(
      conversationMatchesFilters({ id: 'recorded', user_email: 'alice@example.com', persona_id: 'finance' }, noPersona)
    ).toBe(false);
  });
});
