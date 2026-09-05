import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IDENTITY_RESOLVING, IDENTITY_UNAVAILABLE, userInitials } from './user-initials';

/**
 * The ordinary cases are two lines of this file. The rest is the awkward ones,
 * which is the ratio the bug had: an avatar is trivial for `jane.doe@…` and is
 * an empty circle, or a crash, for everything else an identity can be.
 */

describe('initials for an address', () => {
  it('takes first and last from a dotted local part', () => {
    expect(userInitials('jane.doe@example.example').initials).toBe('JD');
  });

  it('reads underscores and hyphens as name separators too', () => {
    expect(userInitials('jane_doe@example.example').initials).toBe('JD');
    expect(userInitials('local-development@app.invalid').initials).toBe('LD');
  });

  it('drops a sub-address tag rather than reading it as a surname', () => {
    expect(userInitials('jane+benchmarks@example.example').initials).toBe('JA');
  });

  it('ignores the domain, which is the company and not the person', () => {
    expect(userInitials('jane.doe@example.example').label).toBe('jane.doe@example.example');
    expect(userInitials('jane.doe@doe.example').initials).toBe('JD');
  });

  /**
   * The rule the conversation rail has always used. Both surfaces read from
   * this module now, so a person cannot appear as "AN" in the rail and "A" on
   * their own message.
   */
  it('gives a single-word local part two letters, as the rail does', () => {
    expect(userInitials('analyst@example.example').initials).toBe('AN');
  });

  it('skips the middle of a longer name', () => {
    expect(userInitials('jane.ann.doe@example.example').initials).toBe('JD');
  });
});

describe('initials for a display name', () => {
  it('handles a name with no address at all', () => {
    expect(userInitials('Jane Doe').initials).toBe('JD');
  });

  it('fills the circle for a single-word name rather than leaving one letter', () => {
    expect(userInitials('Cher').initials).toBe('CH');
  });

  it('takes what there is when a name is one character long', () => {
    expect(userInitials('j@example.example').initials).toBe('J');
  });

  it('upper-cases whatever it was given', () => {
    expect(userInitials('jane doe').initials).toBe('JD');
  });

  it('counts a code point, not a UTF-16 unit', () => {
    // Would be half a surrogate pair, and render as a replacement glyph.
    expect(userInitials('\u{1D4D9}ane Doe').initials).toBe('\u{1D4D9}D');
  });
});

describe('identities with no name in them', () => {
  it('marks a service principal as one and keeps its id on the label', () => {
    // The RFC 9562 nil UUID, which is well formed and cannot name anything. The
    // previous fixture was a plausible-looking id, and the mirror leak check
    // reported it as a service principal on the way out, correctly: a scanner
    // cannot tell an invented id from a live one by looking at it.
    const mark = userInitials('00000000-0000-0000-0000-000000000000');
    expect(mark.initials).toBe('SP');
    expect(mark.label).toContain('Service principal');
    expect(mark.label).toContain('00000000');
  });

  it('does not mistake a person for a principal over a hex-looking domain', () => {
    expect(userInitials('jane.doe@deadbeef.example').initials).toBe('JD');
  });

  it('says the user is unknown rather than rendering an empty circle', () => {
    for (const missing of [undefined, null, '', '   ']) {
      const mark = userInitials(missing);
      expect(mark.initials).toBe('?');
      expect(mark.label).toBe('Signed-in user unknown');
    }
  });

  it('never returns an empty mark, whatever it is handed', () => {
    for (const odd of ['@example.example', '...', '+tag@example.example', '-']) {
      expect(userInitials(odd).initials.length).toBeGreaterThan(0);
    }
  });
});

/**
 * `useIdentity` seeds and fails to these two strings, so they arrive here as
 * `signedInAs` like any other value. They are sentences, and initialling a
 * sentence puts "RS" on the avatar of every first paint.
 */
describe('the placeholders the identity hook shows', () => {
  it('does not initial the sentence shown while identity is loading', () => {
    const mark = userInitials(IDENTITY_RESOLVING);
    expect(mark.initials).toBe('\u2026');
    expect(mark.label).toBe('Resolving the signed-in user');
  });

  it('does not initial the sentence shown when identity could not be read', () => {
    expect(userInitials(IDENTITY_UNAVAILABLE).initials).toBe('?');
  });

  /**
   * The hook holds the only other copy of these two strings. If it stops using
   * the constants, the placeholders drift and every first paint is initialled.
   */
  it('are the same strings the identity hook actually shows', () => {
    expect(IDENTITY_HOOK_SOURCE).toContain('signedInAs: IDENTITY_RESOLVING');
    expect(IDENTITY_HOOK_SOURCE).toContain('signedInAs: IDENTITY_UNAVAILABLE');
  });
});

/** The hook itself, which App.tsx held until the pages were split out of it. */
const IDENTITY_HOOK_SOURCE = readFileSync(new URL('./app-state.ts', import.meta.url), 'utf8');

/** The transcript and the rail, which App.tsx held until the pages were split out. */
const TRANSCRIPT_SOURCE = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');

/**
 * Read from the source, because the transcript cannot be rendered without a DOM
 * and these are the two things whose absence puts the bug back: a message with
 * no mark on it, and a second copy of the rule.
 */
describe('where the mark is used', () => {
  it('signs the user’s own messages with the shared identity chip', () => {
    expect(TRANSCRIPT_SOURCE).toContain('<QuestionAttributionBubble');
    expect(TRANSCRIPT_SOURCE).not.toContain('{asker.initials}');
  });

  it('pairs the visible user handle with the organization identity mark', () => {
    expect(readFileSync(new URL('./QuestionAttributionBubble.tsx', import.meta.url), 'utf8')).toContain(
      '<OrganizationUserBadge'
    );
  });

  it('leaves no initials implementation in the transcript or rail', () => {
    expect(TRANSCRIPT_SOURCE).not.toContain('userInitials(');
    expect(TRANSCRIPT_SOURCE).not.toContain('localPart.slice(0, 2)');
  });
});
