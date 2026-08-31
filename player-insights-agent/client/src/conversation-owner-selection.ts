import type { RailOwner } from './conversation-rail';

export const CONVERSATION_OWNER_SELECTION_KEY = 'astrolabe.ask.conversation-owners';
export const MAX_OWNER_SELECTIONS = 25;

/** Empty is the single canonical representation of “All users”. */
export function normalizeOwnerSelection(selected: readonly string[], available: readonly string[]): string[] {
  const allowed = new Set(available);
  return [...new Set(selected.map((value) => value.trim().toLowerCase()).filter((value) => allowed.has(value)))].slice(
    0,
    MAX_OWNER_SELECTIONS
  );
}

export function toggleOwnerSelection(selected: readonly string[], owner: string): string[] {
  const key = owner.trim().toLowerCase();
  if (!key) return [];
  if (selected.includes(key)) return selected.filter((value) => value !== key);
  return selected.length >= MAX_OWNER_SELECTIONS ? [...selected] : [...selected, key];
}

export function ownerSelectionSummary(selected: readonly string[], owners: readonly RailOwner[]): string {
  if (selected.length === 0) return 'All users';
  const chosen = owners.filter((owner) => selected.includes(owner.key));
  if (chosen.length === 1) return chosen[0].you ? 'You' : chosen[0].email.split('@')[0] || chosen[0].email;
  return `${chosen.length} users`;
}

export function moveOwnerFocus(current: number, key: string, optionCount: number): number {
  if (optionCount <= 0) return 0;
  if (key === 'Home') return 0;
  if (key === 'End') return optionCount - 1;
  if (key === 'ArrowDown') return (current + 1) % optionCount;
  if (key === 'ArrowUp') return (current - 1 + optionCount) % optionCount;
  return current;
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function clearOwnerSelectionPreference(): void {
  try {
    browserStorage()?.removeItem(CONVERSATION_OWNER_SELECTION_KEY);
  } catch {
    // State in this mounted page is still cleared by the caller.
  }
}

export function readOwnerSelectionPreference(available: readonly string[]): string[] {
  try {
    const raw = browserStorage()?.getItem(CONVERSATION_OWNER_SELECTION_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeOwnerSelection(
      parsed.filter((value): value is string => typeof value === 'string'),
      available
    );
  } catch {
    return [];
  }
}

export function rememberOwnerSelectionPreference(selected: readonly string[]): void {
  try {
    browserStorage()?.setItem(
      CONVERSATION_OWNER_SELECTION_KEY,
      JSON.stringify(selected.slice(0, MAX_OWNER_SELECTIONS))
    );
  } catch {
    // A blocked preference store must not block the rail.
  }
}
