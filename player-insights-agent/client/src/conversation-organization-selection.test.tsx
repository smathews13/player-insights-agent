import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationOrganizationOption, ConversationOrganizationSelect } from './ConversationOrganizationSelect';
import {
  CONVERSATION_ORGANIZATION_SELECTION_KEY,
  conversationMatchesOrganizations,
  normalizeOrganizationSelection,
  organizationSelectionSummary,
  railOrganizations,
  readOrganizationSelectionPreference,
  rememberOrganizationSelectionPreference,
  toggleOrganizationSelection,
} from './conversation-organization-selection';
import type { Conversation } from './app-types';

const conversations: Conversation[] = [
  { id: 't2', title: 'A', updated_at: '2026-09-01T10:00:00Z', user_email: 'producer@take2games.com' },
  { id: '2k', title: 'B', updated_at: '2026-09-01T09:00:00Z', user_email: 'artist@2k.com' },
  { id: 'db', title: 'C', updated_at: '2026-09-01T08:00:00Z', user_email: 'sam@example.com' },
];

describe('conversation organization filter', () => {
  it('renders represented organizations instead of personas', () => {
    const organizations = railOrganizations(conversations);
    const markup = renderToStaticMarkup(
      <ConversationOrganizationSelect
        organizations={organizations}
        total={conversations.length}
        selected={[]}
        onChange={() => undefined}
      />
    );
    expect(markup).toContain('>All organizations<');
    expect(organizations.map((organization) => organization.name)).toEqual([
      'Contoso',
      'Databricks',
      'Acme Interactive',
    ]);
    expect(markup).not.toContain('All personas');
  });

  it('filters by the canonical organization derived from the conversation owner', () => {
    expect(conversationMatchesOrganizations(conversations[0], ['acme-interactive'])).toBe(true);
    expect(conversationMatchesOrganizations(conversations[1], ['acme-interactive'])).toBe(false);
    const organizations = railOrganizations(conversations);
    expect(organizationSelectionSummary([], organizations)).toBe('All organizations');
    expect(toggleOrganizationSelection([], '2k')).toEqual(['2k']);
    expect(toggleOrganizationSelection(['2k'], '2k')).toEqual([]);
    expect(
      normalizeOrganizationSelection(
        ['missing', '2k'],
        organizations.map((item) => item.id)
      )
    ).toEqual(['2k']);
  });

  it('renders the Databricks and Acme organization artwork in menu rows', () => {
    const organizations = railOrganizations(conversations);
    const databricks = organizations.find((organization) => organization.id === 'databricks');
    const customer = organizations.find((organization) => organization.id === 'acme-interactive');
    if (!databricks || !customer) throw new Error('expected canonical organizations');

    const markup = renderToStaticMarkup(
      <>
        <ConversationOrganizationOption organization={databricks} />
        <ConversationOrganizationOption organization={customer} />
      </>
    );
    expect(markup).toContain('data-organization-id="databricks"');
    expect(markup).toContain('data-organization-id="acme-interactive"');
    expect(markup).toContain('roster-organization-mark--acme');
  });
});

describe('conversation organization preference isolation', () => {
  const values = new Map<string, string>();

  afterEach(() => {
    values.clear();
    vi.unstubAllGlobals();
  });

  it('restores only the same admin and represented organizations', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    rememberOrganizationSelectionPreference('alice@example.com', ['2k', 'missing']);
    expect(readOrganizationSelectionPreference('alice@example.com', ['2k'])).toEqual(['2k']);
    expect(readOrganizationSelectionPreference('bob@example.com', ['2k'])).toEqual([]);
    expect(JSON.parse(values.get(CONVERSATION_ORGANIZATION_SELECTION_KEY) ?? '{}')).toMatchObject({
      subject: 'alice@example.com',
    });
  });
});
