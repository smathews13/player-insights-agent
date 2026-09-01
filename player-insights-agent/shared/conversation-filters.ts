/**
 * Conversation-rail filtering is based only on persisted run evidence.
 *
 * A conversation belongs to the persona snapshot on its newest recorded run,
 * whether that run is active or completed. Current assignments are deliberately
 * never consulted, so changing a person's assignment cannot relabel their
 * earlier conversations. Missing snapshots remain in the unfiltered set and
 * never become a selectable persona.
 */
export const CONVERSATION_PERSONA_FILTER_RULE =
  'Persona is the snapshot recorded on the conversation’s newest active or completed run. ' +
  'Conversations without a recorded persona remain included when All personas is selected.';

export const MAX_CONVERSATION_FILTER_VALUES = 25;
export const MAX_OWNER_FILTER_LENGTH = 254;
export const MAX_PERSONA_FILTER_LENGTH = 80;
const PERSONA_SELECTION_PREFIX = 'id:';

export interface ConversationFilterSelection {
  owners: string[];
  personaIds: string[];
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
  // Old bookmarked requests may still carry this retired flag. Validate its
  // former shape, then ignore it so the request safely falls back to the
  // unfiltered persona set instead of reviving a client-selectable state.
  const retiredMissingPersonaValues = queryValues(query.no_persona);
  if (
    !retiredMissingPersonaValues ||
    retiredMissingPersonaValues.length > 1 ||
    !retiredMissingPersonaValues.every((value) => value === 'true')
  ) {
    return { ok: false, message: 'no_persona must be true when it is present.' };
  }
  return {
    ok: true,
    value: {
      owners: owners.values,
      personaIds: personaIds.values,
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
  if (filters.personaIds.length === 0) return true;
  if (!persona) return false;
  return filters.personaIds.includes(persona);
}

export function conversationFilterQueryString(filters: ConversationFilterSelection): string {
  const query = new URLSearchParams();
  for (const owner of filters.owners.slice(0, MAX_CONVERSATION_FILTER_VALUES)) query.append('owners', owner);
  for (const personaId of filters.personaIds.slice(0, MAX_CONVERSATION_FILTER_VALUES)) {
    query.append('personas', personaId);
  }
  return query.toString();
}
