/**
 * Conversation-rail filtering is based only on persisted run evidence.
 *
 * A conversation belongs to the persona snapshot on its newest recorded run,
 * whether that run is active or completed. A null/missing snapshot is
 * "No persona". Current assignments are deliberately never consulted, so
 * changing a person's assignment cannot relabel their earlier conversations.
 */
export const CONVERSATION_PERSONA_FILTER_RULE =
  'Persona is the snapshot recorded on the conversation’s newest active or completed run. ' +
  'If that run recorded no persona, the conversation is classified as No persona.';

export const MAX_CONVERSATION_FILTER_VALUES = 25;
export const MAX_OWNER_FILTER_LENGTH = 254;
export const MAX_PERSONA_FILTER_LENGTH = 80;
export const NO_PERSONA_SELECTION = 'none';
const PERSONA_SELECTION_PREFIX = 'id:';

export interface ConversationFilterSelection {
  owners: string[];
  personaIds: string[];
  includeNoPersona: boolean;
}

export interface ConversationAvailablePersona {
  id: string;
  name: string;
}

export interface ConversationPersonaEvidence {
  id?: unknown;
  user_email?: unknown;
  persona_id?: unknown;
}

export function personaSelectionKey(personaId: string): string {
  return `${PERSONA_SELECTION_PREFIX}${personaId}`;
}

export function personaIdFromSelection(key: string): string | null {
  return key.startsWith(PERSONA_SELECTION_PREFIX) ? key.slice(PERSONA_SELECTION_PREFIX.length) : null;
}

function queryValues(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value;
  return null;
}

function normalizedValues(
  raw: unknown,
  normalize: (value: string) => string,
  maxLength: number
): { ok: true; values: string[] } | { ok: false } {
  const values = queryValues(raw);
  if (!values) return { ok: false };
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const value = normalize(entry);
    if (!value || value.length > maxLength) return { ok: false };
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
    if (normalized.length === MAX_CONVERSATION_FILTER_VALUES) break;
  }
  return { ok: true, values: normalized };
}

/**
 * Validate the GET query without trusting it for authorization.
 *
 * Authorization decides the row set first. These values may only narrow that
 * already-authorized set.
 */
export function parseConversationFilterQuery(
  query: Record<string, unknown>
): { ok: true; value: ConversationFilterSelection } | { ok: false; message: string } {
  const owners = normalizedValues(query.owners, (value) => value.trim().toLowerCase(), MAX_OWNER_FILTER_LENGTH);
  const personaIds = normalizedValues(query.personas, (value) => value.trim(), MAX_PERSONA_FILTER_LENGTH);
  if (!owners.ok || !personaIds.ok) {
    return { ok: false, message: 'Conversation filters contain an invalid owner or persona.' };
  }
  const noPersonaValues = queryValues(query.no_persona);
  if (!noPersonaValues || noPersonaValues.length > 1 || !noPersonaValues.every((value) => value === 'true')) {
    return { ok: false, message: 'no_persona must be true when it is present.' };
  }
  return {
    ok: true,
    value: {
      owners: owners.values,
      personaIds: personaIds.values,
      includeNoPersona: noPersonaValues.length === 1,
    },
  };
}

export function conversationMatchesFilters(
  conversation: ConversationPersonaEvidence,
  filters: ConversationFilterSelection
): boolean {
  const owner = typeof conversation.user_email === 'string' ? conversation.user_email.trim().toLowerCase() : '';
  if (filters.owners.length > 0 && !filters.owners.includes(owner)) return false;

  const persona = typeof conversation.persona_id === 'string' ? conversation.persona_id.trim() : '';
  const personaFilterActive = filters.personaIds.length > 0 || filters.includeNoPersona;
  if (!personaFilterActive) return true;
  if (!persona) return filters.includeNoPersona;
  return filters.personaIds.includes(persona);
}

export function conversationFilterQueryString(filters: ConversationFilterSelection): string {
  const query = new URLSearchParams();
  for (const owner of filters.owners.slice(0, MAX_CONVERSATION_FILTER_VALUES)) query.append('owners', owner);
  for (const personaId of filters.personaIds.slice(0, MAX_CONVERSATION_FILTER_VALUES)) {
    query.append('personas', personaId);
  }
  if (filters.includeNoPersona) query.set('no_persona', 'true');
  return query.toString();
}
