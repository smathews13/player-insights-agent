/**
 * What a rail entry is called, and whose it is.
 *
 * Both of those used to be decided inside HomePage, at the point each was drawn,
 * and both were decided late. A conversation was named when its ANSWER arrived,
 * so the rail read "New conversation" for the forty seconds a reader was sitting
 * there watching the question run; and the row the browser inserted for it
 * carried no address at all, so it drew without a watermark and was skipped by
 * the counts on the owner chips. Five questions asked by one person showed as
 * "All 5 / You 3", which reads as two colleagues sharing a rail.
 *
 * The second of those is the reason this is one module rather than two helpers.
 * The watermark on a row and the number on a chip are the same claim about the
 * same row, and they were computed by separate passes over the list: one skipped
 * rows with no `user_email` and the other counted every row regardless. Any
 * disagreement between them is unreadable from the outside, because the reader
 * cannot see which rows the count was taken over. `railOwnership` does both in
 * one pass and hands back the rows already labelled, so a row that is counted
 * under somebody is a row that is watermarked with them.
 *
 * NOTHING HERE INVENTS AN OWNER. A conversation this session started before
 * `/api/identity` answered has no address to stamp, and the honest rendering of
 * that is a row with no watermark that no chip counts -- not the signed-in
 * user's initials on a row we cannot attribute, and not a silent extra on
 * somebody else's tally.
 */

import { conversationTitle, PLACEHOLDER_CONVERSATION_TITLE } from '../../shared/conversation-title';
import type { Conversation } from './app-types';
import { IDENTITY_RESOLVING, IDENTITY_UNAVAILABLE } from './user-initials';

/**
 * The signed-in address, or nothing when the app does not yet know one.
 *
 * `useIdentity` reports two states as prose in the same field it reports an
 * address in: it starts at "Resolving signed-in user…" and falls back to
 * "Signed-in user unavailable". Stamping either of those onto a conversation
 * would put a sentence in a column of addresses, give the rail a chip labelled
 * with it, and -- because the comparison below is by string -- quietly agree
 * that every row asked while the identity was resolving belongs to the same
 * imaginary person.
 */
export function signedInOwner(signedInAs: string | null | undefined): string | undefined {
  const value = signedInAs?.trim() ?? '';
  if (!value || value === IDENTITY_RESOLVING || value === IDENTITY_UNAVAILABLE) return undefined;
  return value;
}

/**
 * The value two addresses are compared and grouped on.
 *
 * Case-folded and trimmed, because an address is not case-sensitive in its
 * domain and is treated as case-insensitive in its local part by every mail
 * system this app will meet. `Example User@…` and `<your-username>@…` arriving from
 * two different headers would otherwise be two people in the rail, each with
 * their own chip and their own share of the count.
 *
 * This normalises the READING only. What the server stores is whatever the
 * proxy put in `x-forwarded-email`, untouched, because the stored value is also
 * the ownership predicate on every query and rewriting it would orphan history.
 */
export function ownerKey(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

/**
 * What an empty rail is allowed to claim, which depends on what it was asked
 * for.
 *
 * A SHARED rail read every conversation in the store, so no rows really does
 * mean the store holds none. A PER-USER rail read the reader's own and knows
 * nothing whatever about anybody else's, so "No saved conversations yet" is a
 * claim it cannot support -- and it made exactly that claim, wrongly, the day a
 * Deploy-from-Git narrowed a shared deployment's rail back to per-user. The
 * store was full, Run Explorer and Monitoring both still listed it, and the rail
 * told the reader nothing had ever been saved. The sentence now says whose
 * conversations were counted, so an empty rail beside a populated Explorer reads
 * as a scope rather than as lost history.
 *
 * `undefined` is the identity payload before it arrives, and it is treated as
 * per-user for the same reason the server's scope fails closed: claiming the
 * whole store is empty is the one sentence that cannot be walked back.
 */
export function railEmptyNotice(_shared: boolean | undefined): string {
  return 'No conversations yet.';
}

/** One rail row, with the ownership question already answered for it. */
export interface RailEntry {
  conversation: Conversation;
  /**
   * The address to watermark this row with, or null when it has none. Null is
   * a fact about the row, not a failure: see the module note above.
   */
  owner: string | null;
  /** What the counts group this row under. Null exactly when `owner` is. */
  ownerKey: string | null;
  /** Whether this row belongs to the signed-in user. */
  you: boolean;
}

/** One owner chip: who, how many, and whether that is the reader. */
export interface RailOwner {
  key: string;
  /** As first spelled in the data, because the chip's title shows it. */
  email: string;
  count: number;
  you: boolean;
}

export interface RailOwnership {
  entries: RailEntry[];
  /** Heaviest first, which is the one a reviewer of a shared rail wants. */
  owners: RailOwner[];
}

/**
 * Label every row with its owner and count the owners off those same labels.
 */
export function railOwnership(
  conversations: readonly Conversation[],
  signedInAs: string | null | undefined
): RailOwnership {
  const signedIn = signedInOwner(signedInAs);
  const mine = ownerKey(signedIn);
  const entries: RailEntry[] = conversations.map((conversation) => {
    const owner = (conversation.user_email ?? '').trim();
    const key = ownerKey(owner);
    return {
      conversation,
      owner: key ? owner : null,
      ownerKey: key ? key : null,
      // `mine` is empty while the identity is unknown, and an unowned row's key
      // is empty too. Without the first test those two emptinesses would match
      // and every unattributed row would be claimed as the reader's own.
      you: key !== '' && key === mine,
    };
  });

  const owners = new Map<string, RailOwner>();
  for (const entry of entries) {
    if (entry.ownerKey === null || entry.owner === null) continue;
    const existing = owners.get(entry.ownerKey);
    if (existing) {
      existing.count += 1;
      continue;
    }
    owners.set(entry.ownerKey, { key: entry.ownerKey, email: entry.owner, count: 1, you: entry.you });
  }
  // An administrator filtering a shared rail must always be able to choose
  // themselves, including before they have asked their first question.
  if (mine && signedIn && !owners.has(mine)) {
    owners.set(mine, { key: mine, email: signedIn, count: 0, you: true });
  }

  return {
    entries,
    // The signed-in reader always has the first explicit option. Everyone else
    // is ordered by useful weight, then a case-folded address so equal counts
    // never jump around between fetches or database row orderings.
    owners: [...owners.values()].sort(
      (a, b) =>
        Number(b.you) - Number(a.you) ||
        b.count - a.count ||
        a.key.localeCompare(b.key) ||
        a.email.localeCompare(b.email)
    ),
  };
}

/**
 * The rail row for a conversation that exists but has not been asked anything.
 *
 * Attaching a document creates one, and so does pressing New conversation. It is
 * stamped with the reader's address for the same reason a row created by asking
 * is: it is theirs, the chips count it, and a row of their own with no watermark
 * beside rows that have one reads as somebody else's.
 */
export function unaskedConversation(row: { id: string; owner?: string | undefined; updatedAt: string }): Conversation {
  return {
    id: row.id,
    title: PLACEHOLDER_CONVERSATION_TITLE,
    updated_at: row.updatedAt,
    user_email: row.owner,
  };
}

/**
 * Name a conversation after the question just submitted, and move it to the top.
 *
 * Called when the question is SENT rather than when its answer lands, which is
 * the whole of the first fix: a run takes tens of seconds and the rail spent all
 * of them saying "New conversation" about the question on screen beside it.
 *
 * The claim is conditional in exactly the way the server's upsert is -- a title
 * is taken only while it is still the placeholder -- so the second question in a
 * conversation does not rename it, and so calling this again when the answer
 * arrives cannot change a label the reader has already read. Two rules that have
 * to agree, expressed once each, against the same shared derivation: if this
 * said `slice(0, 80)` and the server said something else, the label would change
 * under the reader on the next page load and look like a different conversation.
 */
export function claimConversationTitle(
  items: readonly Conversation[],
  claim: { id: string; prompt: string; owner?: string | undefined; updatedAt: string }
): Conversation[] {
  const existing = items.find((item) => item.id === claim.id);
  return [
    {
      id: claim.id,
      title:
        existing && existing.title !== PLACEHOLDER_CONVERSATION_TITLE
          ? existing.title
          : conversationTitle(claim.prompt),
      updated_at: claim.updatedAt,
      // An address already on the row wins, so a stored row reloaded from the
      // server keeps the owner the server recorded even if this browser thinks
      // somebody else is signed in. The fallback covers the row this session
      // invented, which has nobody on it yet.
      user_email: existing?.user_email ?? claim.owner,
    },
    ...items.filter((item) => item.id !== claim.id),
  ];
}
