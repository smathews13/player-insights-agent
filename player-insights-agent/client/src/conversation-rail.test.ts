import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PLACEHOLDER_CONVERSATION_TITLE } from '../../shared/conversation-title';
import type { Conversation } from './app-types';
import {
  claimConversationTitle,
  ownerKey,
  railOwnership,
  signedInOwner,
  unaskedConversation,
} from './conversation-rail';
import { IDENTITY_RESOLVING, IDENTITY_UNAVAILABLE } from './user-initials';

/**
 * The two things the conversation rail was getting wrong about a question the
 * reader had just asked: what it was called, and whose it was.
 *
 * Both were reported from the same screen. Five questions asked by one person
 * showed as "All 5 · You 3" with two rows carrying no watermark, and the row for
 * the question then running said "New conversation" for as long as it ran. They
 * turned out to be one defect seen twice -- the row the browser inserts for a
 * question in flight was built by hand as `{ id, title, updated_at }` -- so they
 * are fixed and guarded together.
 *
 * The timing half is asserted against the page's source rather than a rendered
 * tree, because the claim is about WHERE the rename happens in `ask()`: before
 * the request is sent, not in the branch that handles the reply. A test of the
 * helper alone passes just as happily with the call left where it was.
 */

const HOME_PAGE = readFileSync(new URL('HomePage.tsx', import.meta.url), 'utf8');

const ME = 'first.last@example.com';
const QUESTION = 'Compare active players by title over the last 30 days.';

function stored(id: string, title: string, email: string | undefined, updatedAt = '2026-08-16T01:00:00.000Z'): Conversation {
  return { id, title, updated_at: updatedAt, user_email: email };
}

describe('a conversation is named by the question, the moment it is asked', () => {
  it('replaces the placeholder rather than waiting for an answer to do it', () => {
    // The row already in the rail is the one New conversation put there. The
    // rename is the same call, so nothing has to arrive for it to happen.
    const before = [unaskedConversation({ id: 'conv-1', owner: ME, updatedAt: '2026-08-16T01:00:00.000Z' })];
    const after = claimConversationTitle(before, {
      id: 'conv-1',
      prompt: QUESTION,
      owner: ME,
      updatedAt: '2026-08-16T01:00:05.000Z',
    });
    expect(after[0].title).toBe(QUESTION);
    expect(after[0].title).not.toBe(PLACEHOLDER_CONVERSATION_TITLE);
  });

  it('names a conversation the rail has never heard of, which is the common case', () => {
    // Asking without pressing New conversation first: the id exists only in this
    // browser, so there is no row to update and one has to be inserted named.
    const after = claimConversationTitle([stored('conv-old', 'An older question', ME)], {
      id: 'conv-new',
      prompt: QUESTION,
      owner: ME,
      updatedAt: '2026-08-16T01:00:05.000Z',
    });
    expect(after[0]).toMatchObject({ id: 'conv-new', title: QUESTION, user_email: ME });
    expect(after).toHaveLength(2);
  });

  it('says the same thing when the answer lands as it said while the run went', () => {
    // `ask()` claims twice: once on submission and once when the reply arrives,
    // the second only to carry the store's "just now" onto the row. A label that
    // moved between those two would be the original defect wearing a hat -- the
    // reader would watch the rail rewrite a title they had already read.
    const submitted = claimConversationTitle([], {
      id: 'conv-1',
      prompt: QUESTION,
      owner: ME,
      updatedAt: '2026-08-16T01:00:05.000Z',
    });
    const answered = claimConversationTitle(submitted, {
      id: 'conv-1',
      prompt: QUESTION,
      owner: ME,
      updatedAt: '2026-08-16T01:00:47.000Z',
    });
    expect(answered[0].title).toBe(submitted[0].title);
    expect(answered[0].updated_at).toBe('2026-08-16T01:00:47.000Z');
  });

  it('does not rename a conversation when its second question is asked', () => {
    // The server claims a stored title only while it is still the placeholder.
    // An unconditional client-side rename would show the newest question in the
    // rail until the page was reloaded and the first question came back.
    const after = claimConversationTitle([stored('conv-1', QUESTION, ME)], {
      id: 'conv-1',
      prompt: 'And how does that compare with last quarter?',
      owner: ME,
      updatedAt: '2026-08-16T01:10:00.000Z',
    });
    expect(after[0].title).toBe(QUESTION);
  });

  it('derives the label the way the stored one is derived, whitespace included', () => {
    // Both sides call `conversationTitle`. If this file ever asserts a rule of
    // its own here, that is the rail changing its label on the next page load.
    const after = claimConversationTitle([], {
      id: 'conv-1',
      prompt: '  Compare active\n\nplayers   by title.  ',
      owner: ME,
      updatedAt: '2026-08-16T01:00:05.000Z',
    });
    expect(after[0].title).toBe('Compare active players by title.');
  });

  it('moves the conversation to the top of the rail without duplicating it', () => {
    const before = [stored('conv-a', 'Older', ME), stored('conv-1', PLACEHOLDER_CONVERSATION_TITLE, ME)];
    const after = claimConversationTitle(before, {
      id: 'conv-1',
      prompt: QUESTION,
      owner: ME,
      updatedAt: '2026-08-16T01:00:05.000Z',
    });
    expect(after.map((item) => item.id)).toEqual(['conv-1', 'conv-a']);
  });
});

describe('the rename happens where the question is sent, not where the reply is read', () => {
  /** `ask()` from its signature to the `catch` that reports a failed run. */
  const askBody = HOME_PAGE.slice(HOME_PAGE.indexOf('async function ask('),
    HOME_PAGE.indexOf('} catch (askError) {')
  );

  it('claims the title before the request goes out', () => {
    // The failure this guards is a 40-second run with a rail beside it still
    // reading "New conversation": the rename used to sit in the block that
    // appends the answer. Position in the source is the whole assertion.
    const claimed = askBody.indexOf('claimConversationTitle');
    const sent = askBody.indexOf('await askStreaming(');
    expect(claimed).toBeGreaterThan(-1);
    expect(sent).toBeGreaterThan(-1);
    expect(claimed).toBeLessThan(sent);
  });

  it('leaves no second derivation of the label on the page', () => {
    // HomePage used to build the title itself. One call site for the rule means
    // the rail cannot disagree with the row the server stored.
    expect(HOME_PAGE).not.toMatch(/title:\s*conversationTitle\(/);
    expect(HOME_PAGE).not.toMatch(/\.slice\(0,\s*80\)/);
  });

  it('stamps the reader onto every row this session invents', () => {
    // Both places the browser creates a conversation: pressing New conversation,
    // and asking in one that has never been stored.
    expect(HOME_PAGE).toMatch(/unaskedConversation\(\{ id, owner: signedInAddress/);
    expect(askBody).toMatch(/owner: signedInAddress/);
  });
});

describe('who a rail row belongs to is decided once, for the count and the watermark both', () => {
  it('counts a row this session created towards You', () => {
    // The reported defect. The optimistic row carried no address, so it drew
    // without a watermark AND was missing from the tally: one person's five
    // questions read as "All 5 · You 3".
    const rail = railOwnership([
        claimConversationTitle([], {
          id: 'conv-live',
          prompt: QUESTION,
          owner: ME,
          updatedAt: '2026-08-16T01:27:00.000Z',
        })[0],
        stored('conv-a', 'An older question', ME),
      ],
      ME
    );
    expect(rail.owners).toHaveLength(1);
    expect(rail.owners[0]).toMatchObject({ email: ME, count: 2, you: true });
    expect(rail.entries.every((entry) => entry.you)).toBe(true);
  });

  it('gives every counted row a watermark, and counts every watermarked row', () => {
    // The two derivations in one assertion, which is the only way this stays
    // fixed: a row drawn with initials that no chip counted is exactly what the
    // reader saw, and it is invisible from either side on its own.
    const rail = railOwnership([
        stored('conv-a', 'One', ME),
        stored('conv-b', 'Two', 'colleague@example.com'),
        stored('conv-c', 'Three', ME),
        stored('conv-d', 'Four', undefined),
      ],
      ME
    );
    const watermarked = rail.entries.filter((entry) => entry.owner !== null);
    expect(rail.owners.reduce((total, owner) => total + owner.count, 0)).toBe(watermarked.length);
    for (const owner of rail.owners) {
      expect(watermarked.filter((entry) => entry.ownerKey === owner.key)).toHaveLength(owner.count);
    }
    // Heaviest first, so the chip a reviewer of a shared rail wants is leftmost.
    expect(rail.owners.map((owner) => owner.count)).toEqual([2, 1]);
  });

  it('treats one address in two capitalisations as one person', () => {
    // Not what the deployment stores today -- every row on example carries the same
    // spelling -- but the comparison used to be `===` against the signed-in
    // string, so a proxy that changed one letter's case would have split the
    // reader into two people, one of whom was "not you".
    const rail = railOwnership([stored('conv-a', 'One', 'First.Last@Example.com'), stored('conv-b', 'Two', ME)],
      ME
    );
    expect(rail.owners).toHaveLength(1);
    expect(rail.owners[0]).toMatchObject({ count: 2, you: true });
  });

  it('claims nothing for a row it cannot attribute', () => {
    // A conversation started before /api/identity answered. It has no owner, and
    // the honest rendering of that is no watermark and no chip -- not the
    // reader's initials on a row nothing recorded them against, and not a silent
    // extra on somebody else's count.
    const rail = railOwnership([stored('conv-a', 'One', undefined), stored('conv-b', 'Two', ME)], ME);
    expect(rail.entries[0]).toMatchObject({ owner: null, ownerKey: null, you: false });
    expect(rail.owners).toHaveLength(1);
    expect(rail.owners[0].count).toBe(1);
    // "All" is every row, including the one nobody is claiming. The counts add
    // up to less than it, which is true, rather than to it by invention.
    expect(rail.entries).toHaveLength(2);
  });

  it('does not turn an unknown reader into the owner of the unattributed rows', () => {
    // Both sides are empty while the identity is resolving, and empty equals
    // empty. Without the explicit test for it, every anonymous row would be
    // "You" and the chip would be labelled with a blank address.
    const rail = railOwnership([stored('conv-a', 'One', undefined)], IDENTITY_RESOLVING);
    expect(rail.entries[0].you).toBe(false);
    expect(rail.owners).toHaveLength(0);
  });
});

describe('the signed-in address is an address, or it is nothing', () => {
  it('refuses the two sentences useIdentity reports in the same field', () => {
    // "Resolving signed-in user…" and "Signed-in user unavailable" are prose.
    // Stamped onto a row they would appear in the rail as an owner, get a chip,
    // and collect every conversation asked during a page load.
    expect(signedInOwner(IDENTITY_RESOLVING)).toBeUndefined();
    expect(signedInOwner(IDENTITY_UNAVAILABLE)).toBeUndefined();
    expect(signedInOwner('   ')).toBeUndefined();
    expect(signedInOwner(null)).toBeUndefined();
  });

  it('passes a real address through untouched, spelling included', () => {
    // The stored value is the ownership predicate on every server query. Only
    // the comparison is normalised; what is written keeps the proxy's spelling.
    expect(signedInOwner(` ${ME} `)).toBe(ME);
    expect(ownerKey(' FIRST.Last@Example.com ')).toBe(ME);
    expect(ownerKey(undefined)).toBe('');
  });

  it('gives a new conversation the reader and the placeholder, in that order', () => {
    const row = unaskedConversation({ id: 'conv-1', owner: ME, updatedAt: '2026-08-16T01:00:00.000Z' });
    expect(row).toEqual({
      id: 'conv-1',
      title: PLACEHOLDER_CONVERSATION_TITLE,
      updated_at: '2026-08-16T01:00:00.000Z',
      user_email: ME,
    });
  });
});

describe('the rail draws one answer to "whose is this", not two', () => {
  it('watermarks the row from the entry the counts were taken off', () => {
    // Reading `conversation.user_email` again inside the row is how the rail and
    // its chips came to disagree in the first place.
    expect(HOME_PAGE).toMatch(/visibleEntries\.map\(\(\{ conversation, owner \}\)/);
    expect(HOME_PAGE).toContain('<UserIdentityChip identity={owner} label="Asked by"');
    expect(HOME_PAGE).not.toMatch(/\{conversation\.user_email && \(/);
  });

  it('counts All off the same list the rows are drawn from', () => {
    // `railConversations.length` and a separately-filtered set of rows was the
    // arrangement that produced "All 5" over four visible watermarks.
    expect(HOME_PAGE).toMatch(/className="conversation-filter-count">\{rail\.entries\.length\}/);
    expect(HOME_PAGE).toMatch(/railOwnership\(railConversations, identity\.signedInAs\)/);
  });

  it('filters on the normalised key, so a selection survives a change of case', () => {
    expect(HOME_PAGE).toMatch(/toggleOwnerFilter\(key\)/);
    expect(HOME_PAGE).toMatch(/activeOwnerFilters\.includes\(key\)/);
  });
});
