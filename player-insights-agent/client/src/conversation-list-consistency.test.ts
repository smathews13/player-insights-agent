/**
 * That Ask's rail and the Run Explorer's filter list the SAME conversations.
 *
 * The reported defect: the rail showed three conversations while the Explorer's
 * filter offered six, off one Lakebase store. Two separate causes, both here.
 *
 * The rail collapsed rows that shared a title, keeping the newest of each. That
 * was written for a development store that repeated one conversation many times,
 * and on real history it hides conversations a reader asked and can no longer
 * reach: three questions about the same subject are three conversations.
 *
 * The Explorer derived its filter from `/api/runs`, so a conversation existed
 * for it only once a turn inside it had stored a trace. The two surfaces were
 * answering "which conversations are there" from different data. Both now read
 * `/api/conversations`, and the runs only decide what a conversation is CALLED.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Conversation, Run } from './app-types';
import { railEmptyNotice, railOwnership } from './conversation-rail';
import { readConversationList } from './initial-rail';
import { conversationFilterOptions } from './run-explorer-state';

const ASK = readFileSync(new URL('HomePage.tsx', import.meta.url), 'utf8');
const EXPLORER = readFileSync(new URL('RunExplorer.tsx', import.meta.url), 'utf8');

const conversations: Conversation[] = Array.from({ length: 6 }, (_, index) => ({
  id: `conv-${index + 1}`,
  title: ['Hoops spike', 'Compare active players', 'VLH 5'][index % 3],
  updated_at: `2026-08-20T17:4${index}:00Z`,
  user_email: '<your-username>',
}));

const runs: Run[] = conversations.map((conversation, index) => ({
  id: `run-${index + 1}`,
  kind: 'conversation',
  conversation_id: conversation.id,
  prompt: conversation.title,
  stakeholder: conversation.user_email ?? null,
  status: index === 0 ? 'complete' : 'partial',
  duration_ms: 1_000,
  rating: null,
  created_at: conversation.updated_at,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Ask and Run Explorer use one conversation set', () => {
  it('wires both surfaces directly to the canonical Lakebase conversation list', () => {
    expect(ASK).toContain('railOwnership(conversations, identity.signedInAs)');
    expect(ASK).not.toContain('dedupeByTitle');
    expect(EXPLORER).toContain('readConversationList()');
    expect(EXPLORER).toContain('conversationFilterOptions(conversations, runs)');
  });

  it('keeps every stored id even when titles repeat and one run is complete', () => {
    const askIds = railOwnership(conversations, '<your-username>').entries.map(
      ({ conversation }) => conversation.id
    );
    const explorerIds = conversationFilterOptions(conversations, runs).map(({ id }) => id);

    expect(askIds).toEqual(explorerIds);
    expect(askIds).toHaveLength(6);
    expect(explorerIds).toContain(runs.find((run) => run.status === 'complete')?.conversation_id);
  });

  it('adds the owner chips up to the All chip, which is the Explorer’s total', () => {
    // All is every row, You is the reader's share of it. The chips stay, and
    // what they may not do is disagree with the Explorer about how many
    // conversations exist.
    const shared: Conversation[] = [
      ...conversations,
      { id: 'conv-7', title: 'VLH 5', updated_at: '2026-08-20T17:50:00Z', user_email: 'colleague@example.com' },
    ];
    const rail = railOwnership(shared, '<your-username>');
    const explorerTotal = conversationFilterOptions(shared, runs).length;

    expect(rail.entries).toHaveLength(explorerTotal);
    expect(rail.owners.reduce((total, owner) => total + owner.count, 0)).toBe(explorerTotal);
    const you = rail.owners.find((owner) => owner.you);
    expect(you?.count).toBe(6);
    expect(you?.count).toBeLessThan(explorerTotal);
  });

  it('keeps a conversation the Explorer has no run for, rather than dropping it', () => {
    // A conversation created but not yet asked in, and one whose only turn
    // failed to store a trace, both exist in Lakebase. The filter used to be
    // built from runs alone, so neither was offered.
    const unasked: Conversation = {
      id: 'conv-unasked',
      title: 'New conversation',
      updated_at: '2026-08-20T17:55:00Z',
      user_email: '<your-username>',
    };
    const options = conversationFilterOptions([...conversations, unasked], runs);

    expect(options.map((option) => option.id)).toContain('conv-unasked');
    // Named by the stored title, because there is no run to take a prompt from.
    expect(options.at(-1)).toEqual({ id: 'conv-unasked', label: 'New conversation' });
  });

  it('does not turn an unreadable Lakebase list into a shorter in-memory list', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('Lakebase unavailable')));

    await expect(readConversationList()).resolves.toEqual({
      conversations: null,
      matchingConversationIds: null,
      personaFilterRule: null,
      availability: { origin: 'unavailable', reason: 'storage_unavailable' },
    });
  });

  it('says the list could not be read on both surfaces, rather than showing a short one', () => {
    // Ask checks the outage BEFORE the empty state, so a reader is never told
    // they have no conversations during one. The Explorer's filter says the same
    // thing in its own words, and neither borrows the other's shorter list.
    expect(ASK).toMatch(/railAvailability\?\.origin ===\s*'unavailable'/);
    expect(EXPLORER).toContain("'Conversations could not be read'");
    // And an unreadable filter does not take the runs down with it: the rows
    // below answer to their own read. Whitespace-tolerant because this asserts
    // a condition, not a line break: the formatter has wrapped it once already
    // and a red test for a reflow is a test that gets deleted.
    expect(EXPLORER).toMatch(/runsAvailability\?\.origin ===\s*'unavailable'/);
  });

  it('does not tell a per-user rail\u2019s reader that the whole store is empty', () => {
    // The Git-deploy defect. A per-user rail with no rows has read the reader's
    // own conversations and nothing else, so it cannot speak for the store --
    // and Run Explorer and Monitoring were both still listing that store's
    // history while the rail said none of it had ever been saved.
    expect(railEmptyNotice(false)).toBe('No conversations yet.');
    // Unknown scope is treated as the narrow one: the identity payload has not
    // arrived, and "the store is empty" is the sentence that cannot be walked
    // back.
    expect(railEmptyNotice(undefined)).toBe(railEmptyNotice(false));
    // A shared rail did read every row, so here the plain sentence is true.
    expect(railEmptyNotice(true)).toBe('No conversations yet.');
    expect(ASK).toContain('railEmptyNotice(identity.sharedConversationRail)');
  });
});
