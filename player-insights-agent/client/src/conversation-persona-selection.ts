import type { Conversation } from './app-types';
import { MAX_CONVERSATION_FILTER_VALUES, personaSelectionKey } from '../../shared/conversation-filters';

export const CONVERSATION_PERSONA_SELECTION_KEY = 'astrolabe.ask.conversation-personas.v1';
const RETIRED_NO_PERSONA_SELECTION = 'none';

export interface RailPersona {
  key: string;
  id: string;
  name: string;
  count: number;
}

/** Counts each conversation once under its newest recorded run snapshot. */
export function railPersonas(conversations: readonly Conversation[]): RailPersona[] {
  const named = new Map<
    string,
    { key: string; id: string; name: string | null; count: number; newestNameAt: number }
  >();

  for (const conversation of conversations) {
    const id = conversation.persona_id?.trim() ?? '';
    if (!id) continue;
    const recordedAt = Date.parse(conversation.persona_recorded_at ?? '') || 0;
    const name = conversation.persona_name?.trim() || null;
    const existing = named.get(id);
    if (existing) {
      existing.count += 1;
      if (name && (existing.name === null || recordedAt > existing.newestNameAt)) {
        existing.name = name;
        existing.newestNameAt = recordedAt;
      }
    } else {
      named.set(id, {
        key: personaSelectionKey(id),
        id,
        name,
        count: 1,
        newestNameAt: name ? recordedAt : 0,
      });
    }
  }

  return [...named.values()]
    .filter((persona): persona is typeof persona & { name: string } => persona.name !== null)
    .map(({ newestNameAt: _newestNameAt, ...persona }) => persona)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Empty is the only representation of All personas. */
export function normalizePersonaSelection(selected: readonly string[], available: readonly string[]): string[] {
  if (selected.some((value) => value.trim() === RETIRED_NO_PERSONA_SELECTION)) return [];
  const allowed = new Set(available);
  return [...new Set(selected.map((value) => value.trim()).filter((value) => allowed.has(value)))].slice(
    0,
    MAX_CONVERSATION_FILTER_VALUES
  );
}

export function togglePersonaSelection(selected: readonly string[], persona: string): string[] {
  if (!persona) return [];
  if (selected.includes(persona)) return selected.filter((value) => value !== persona);
  return selected.length >= MAX_CONVERSATION_FILTER_VALUES ? [...selected] : [...selected, persona];
}

export function personaSelectionSummary(selected: readonly string[], personas: readonly RailPersona[]): string {
  if (selected.length === 0) return 'All personas';
  const chosen = personas.filter((persona) => selected.includes(persona.key));
  if (chosen.length === 1) return chosen[0].name;
  return `${chosen.length} personas`;
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function clearPersonaSelectionPreference(): void {
  try {
    browserStorage()?.removeItem(CONVERSATION_PERSONA_SELECTION_KEY);
  } catch {
    // Mounted state is still cleared by the caller.
  }
}

export function readPersonaSelectionPreference(subject: string, available: readonly string[]): string[] {
  try {
    const raw = browserStorage()?.getItem(CONVERSATION_PERSONA_SELECTION_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [];
    const stored = parsed as { subject?: unknown; selected?: unknown };
    if (stored.subject !== subject.trim().toLowerCase() || !Array.isArray(stored.selected)) return [];
    const selected = stored.selected.filter((value): value is string => typeof value === 'string');
    if (selected.some((value) => value.trim() === RETIRED_NO_PERSONA_SELECTION)) {
      browserStorage()?.removeItem(CONVERSATION_PERSONA_SELECTION_KEY);
      return [];
    }
    return normalizePersonaSelection(selected, available);
  } catch {
    return [];
  }
}

export function rememberPersonaSelectionPreference(subject: string, selected: readonly string[]): void {
  try {
    if (selected.some((value) => value.trim() === RETIRED_NO_PERSONA_SELECTION)) {
      browserStorage()?.removeItem(CONVERSATION_PERSONA_SELECTION_KEY);
      return;
    }
    browserStorage()?.setItem(
      CONVERSATION_PERSONA_SELECTION_KEY,
      JSON.stringify({
        subject: subject.trim().toLowerCase(),
        selected: selected.slice(0, MAX_CONVERSATION_FILTER_VALUES),
      })
    );
  } catch {
    // A blocked preference store must not block the rail.
  }
}
