import { describe, expect, it } from 'vitest';
import {
  canonicalRequestHash,
  idempotencyKeyHash,
  isUsableIdempotencyKey,
  type CanonicalRequest,
} from './run-request-hash';

/**
 * Two failure directions, and they are not equally bad.
 *
 * A hash that separates requests it should have joined costs a duplicate run:
 * money and a confusing audit trail. A hash that joins requests it should have
 * separated answers one question with another question's answer, which is the
 * failure this app has spent its whole history removing. So the cases below
 * lean on the second: most of them establish that some difference a reader
 * would notice does change the hash.
 */

const base: CanonicalRequest = {
  userEmail: 'reader@example.com',
  conversationId: 'conv-1',
  prompt: 'How many players were active last month?',
  history: [
    { role: 'user', content: 'How many players were active last week?' },
    { role: 'assistant', content: 'Roughly four million.' },
  ],
  attachments: [{ filename: 'q3.pdf', text: 'quarterly figures' }],
};

function hash(overrides: Partial<CanonicalRequest> = {}): string {
  return canonicalRequestHash({ ...base, ...overrides });
}

describe('the same ask asked twice', () => {
  it('hashes the same', () => {
    expect(hash()).toBe(hash());
  });

  it('is a sha256, so the column width and the index are decided', () => {
    expect(hash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores whitespace a human would not see', () => {
    expect(hash({ prompt: '  How many players   were active last month? \n' })).toBe(hash());
  });

  it('ignores the case and padding of the address, which arrives differently by route', () => {
    expect(hash({ userEmail: ' Reader@Example.com ' })).toBe(hash());
  });

  it('does not depend on the transport the caller asked for', () => {
    // The property the whole workstream rests on. The truncated-stream retry
    // asks the identical question again without streaming, and it must attach
    // to the run it already has rather than start a second one, so the
    // canonical request has no field for the transport to occupy.
    expect(Object.keys(base)).not.toContain('stream');
  });
});

describe('asks that differ in a way the reader would notice', () => {
  it('separates a different question', () => {
    expect(hash({ prompt: 'How many players were active last year?' })).not.toBe(hash());
  });

  it('separates a different reader asking the identical question', () => {
    // Cross-user isolation belongs in the hash and not only in the WHERE
    // clause. With the address inside, a query that forgot to scope by user
    // still fails to match rather than matching somebody else's run.
    expect(hash({ userEmail: 'someone.else@example.com' })).not.toBe(hash());
  });

  it('separates the same question in a different conversation', () => {
    expect(hash({ conversationId: 'conv-2' })).not.toBe(hash());
  });

  it('separates the same question asked later in the same conversation', () => {
    // The case a body-only hash gets wrong. "And last month?" is the same
    // three words on turn two and turn twelve and means something different
    // each time, because the history it resolves against has changed.
    expect(hash({ history: [...base.history, { role: 'user', content: 'And by title?' }] })).not.toBe(hash());
  });

  it('separates a history whose turns arrived in a different order', () => {
    expect(hash({ history: [...base.history].reverse() })).not.toBe(hash());
  });

  it('separates a history whose speakers are swapped', () => {
    expect(
      hash({
        history: base.history.map((turn) => ({
          ...turn,
          role: turn.role === 'user' ? 'assistant' : 'user',
        })),
      })
    ).not.toBe(hash());
  });

  it('separates a different attachment behind the same filename', () => {
    // Replacing a PDF with a different PDF of the same name is the case a
    // name-only hash answers with the previous document's run.
    expect(hash({ attachments: [{ filename: 'q3.pdf', text: 'different figures' }] })).not.toBe(hash());
  });

  it('separates an attachment that was removed', () => {
    expect(hash({ attachments: [] })).not.toBe(hash());
  });

  it('separates an approved plan from the unapproved question', () => {
    expect(hash({ approvedPlanId: 'plan-7' })).not.toBe(hash());
  });

  it('separates two different approvals', () => {
    expect(hash({ approvedPlanId: 'plan-7' })).not.toBe(hash({ approvedPlanId: 'plan-8' }));
  });

  it('separates an execute instruction from a plan-only turn', () => {
    expect(hash({ approvedPlanId: 'plan-7', executePlan: true })).not.toBe(hash({ approvedPlanId: 'plan-7' }));
  });
});

describe('fields that could be made to collide', () => {
  /**
   * Every string in the canonical form is length-prefixed for these. Without
   * it, a user who controls two adjacent fields can move the boundary between
   * them and hash a different request identically, which for this hash means
   * being served a run that answered something else.
   */
  it('does not let a prompt absorb the field after it', () => {
    expect(hash({ prompt: 'a', approvedPlanId: 'bc' })).not.toBe(hash({ prompt: 'abc', approvedPlanId: '' }));
  });

  it('does not let one history turn be split into two', () => {
    expect(hash({ history: [{ role: 'user', content: 'one two' }] })).not.toBe(
      hash({
        history: [
          { role: 'user', content: 'one' },
          { role: 'user', content: 'two' },
        ],
      })
    );
  });

  it('does not let a filename run into its content', () => {
    expect(hash({ attachments: [{ filename: 'a', text: 'b' }] })).not.toBe(
      hash({ attachments: [{ filename: 'ab', text: '' }] })
    );
  });

  it('does not confuse an empty history with an empty attachment list', () => {
    expect(hash({ history: [], attachments: [{ filename: 'q3.pdf', text: 'quarterly figures' }] })).not.toBe(
      hash({ history: [{ role: 'user', content: '' }], attachments: [] })
    );
  });
});

describe('the stored form of an idempotency key', () => {
  it('is a sha256 and never the key itself', () => {
    const stored = idempotencyKeyHash('reader@example.com', 'client-key-0001');
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain('client-key-0001');
  });

  it('is stable for one reader and one key', () => {
    expect(idempotencyKeyHash('reader@example.com', 'client-key-0001')).toBe(
      idempotencyKeyHash(' Reader@Example.COM ', 'client-key-0001')
    );
  });

  it('does not collide across readers, so one user cannot reach another user run', () => {
    expect(idempotencyKeyHash('a@example.com', 'shared-key-0001')).not.toBe(
      idempotencyKeyHash('b@example.com', 'shared-key-0001')
    );
  });

  it('does not let the address and the key be traded off against each other', () => {
    expect(idempotencyKeyHash('ab@example.com', 'key-00000001')).not.toBe(
      idempotencyKeyHash('a@example.com', 'bkey-00000001')
    );
  });
});

describe('which keys the app will accept', () => {
  it('accepts what clients actually send', () => {
    expect(isUsableIdempotencyKey('01HZY2QK8N4W9V0J7B3C5D6E7F')).toBe(true);
    expect(isUsableIdempotencyKey('abcdefab-0000-4000-8000-000000000000')).toBe(true);
  });

  it('refuses a key too short to be unique by accident', () => {
    expect(isUsableIdempotencyKey('abc')).toBe(false);
  });

  it('refuses an unbounded key, because it is stored', () => {
    expect(isUsableIdempotencyKey('k'.repeat(201))).toBe(false);
  });

  it('refuses characters that would not survive a header or a log line', () => {
    expect(isUsableIdempotencyKey('key with spaces')).toBe(false);
    expect(isUsableIdempotencyKey('key\nwith-newline')).toBe(false);
    expect(isUsableIdempotencyKey('key/with/slashes')).toBe(false);
  });
});
