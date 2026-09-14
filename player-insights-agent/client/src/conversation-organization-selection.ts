import type { Conversation } from './app-types';
import type { OrganizationFilterOption, OrganizationMapping } from '../../shared/organization-contract';
import { organizationForEmail, organizationsForEmails } from '../../shared/organization-mapping';
import { MAX_CONVERSATION_FILTER_VALUES } from '../../shared/conversation-filters';

export const CONVERSATION_ORGANIZATION_SELECTION_KEY = 'astrolabe.ask.conversation-organizations.v1';
export const CONVERSATION_ORGANIZATION_FILTER_RULE =
  'Organization is derived from each conversation owner’s recorded email domain.';

export type RailOrganization = OrganizationFilterOption;

export function railOrganizations(
  conversations: readonly Conversation[],
  mappings: readonly OrganizationMapping[] = []
): RailOrganization[] {
  return organizationsForEmails(
    conversations
      .map((conversation) => conversation.user_email?.trim() ?? '')
      .filter((email): email is string => Boolean(email)),
    mappings
  );
}

export function normalizeOrganizationSelection(selected: readonly string[], available: readonly string[]): string[] {
  const allowed = new Set(available);
  return [...new Set(selected.map((value) => value.trim()).filter((value) => allowed.has(value)))].slice(
    0,
    MAX_CONVERSATION_FILTER_VALUES
  );
}

export function toggleOrganizationSelection(selected: readonly string[], organization: string): string[] {
  if (!organization) return [];
  if (selected.includes(organization)) return selected.filter((value) => value !== organization);
  return selected.length >= MAX_CONVERSATION_FILTER_VALUES ? [...selected] : [...selected, organization];
}

export function organizationSelectionSummary(
  selected: readonly string[],
  organizations: readonly RailOrganization[]
): string {
  if (selected.length === 0) return 'All organizations';
  const chosen = organizations.filter((organization) => selected.includes(organization.id));
  if (chosen.length === 1) return chosen[0].name;
  return `${chosen.length} organizations`;
}

export function conversationMatchesOrganizations(
  conversation: Conversation,
  selected: readonly string[],
  mappings: readonly OrganizationMapping[] = []
): boolean {
  if (selected.length === 0) return true;
  const email = conversation.user_email?.trim() ?? '';
  return Boolean(email) && selected.includes(organizationForEmail(email, mappings).id);
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function clearOrganizationSelectionPreference(): void {
  try {
    browserStorage()?.removeItem(CONVERSATION_ORGANIZATION_SELECTION_KEY);
  } catch {
    // Mounted state is still cleared by the caller.
  }
}

export function readOrganizationSelectionPreference(subject: string, available: readonly string[]): string[] {
  try {
    const raw = browserStorage()?.getItem(CONVERSATION_ORGANIZATION_SELECTION_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [];
    const stored = parsed as { subject?: unknown; selected?: unknown };
    if (stored.subject !== subject.trim().toLowerCase() || !Array.isArray(stored.selected)) return [];
    return normalizeOrganizationSelection(
      stored.selected.filter((value): value is string => typeof value === 'string'),
      available
    );
  } catch {
    return [];
  }
}

export function rememberOrganizationSelectionPreference(subject: string, selected: readonly string[]): void {
  try {
    browserStorage()?.setItem(
      CONVERSATION_ORGANIZATION_SELECTION_KEY,
      JSON.stringify({ subject: subject.trim().toLowerCase(), selected: [...selected] })
    );
  } catch {
    // The in-memory selection still works when storage is unavailable.
  }
}
