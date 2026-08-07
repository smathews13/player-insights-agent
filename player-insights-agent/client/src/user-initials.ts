/**
 * A short mark for whoever asked, so their messages are not told apart from the
 * agent's by colour alone.
 *
 * The agent signs its answers with an avatar and a badge. A user's message had
 * neither, which left the dark bubble as the only signal, and a signal carried
 * by colour is no signal in a screenshot, in high contrast, or to a reader who
 * cannot separate the two hues.
 *
 * Everything here derives from `signedInAs`, the value the header chip and the
 * identity panel already show. There is no second source of truth for who is
 * signed in, and this must not become one.
 *
 * The awkward inputs are the point. A service principal has no name, a
 * `x-forwarded-email` header can be missing entirely, and the header is a
 * placeholder for the first paint of every page load. Each of those has to
 * produce something a person can read rather than an empty circle.
 */

import { isOpaqueId, principalLabel } from './execution-identity';

/**
 * What `useIdentity` shows before `/api/identity` has answered, and after it
 * has failed. Exported so this module and the hook cannot drift: these are
 * prose, not names, and initialling them yields "RS" and "SU".
 */
export const IDENTITY_RESOLVING = 'Resolving signed-in user\u2026';
export const IDENTITY_UNAVAILABLE = 'Signed-in user unavailable';

export interface UserMark {
  /**
   * One or two characters for the avatar. Never empty, so the circle always
   * holds something.
   */
  initials: string;
  /**
   * What the mark stands for, spelled out. Goes on `title` and to a screen
   * reader, which is where the whole identity belongs; the circle only has room
   * for the abbreviation.
   */
  label: string;
}

/** Everything a name or a local part can be divided on. */
const SEPARATORS = /[\s._-]+/;

/**
 * The mark for a signed-in identity.
 *
 * Never throws and never returns an empty string. An identity this cannot read
 * is still an identity, and saying so beats rendering a blank.
 */
export function userInitials(signedInAs: string | null | undefined): UserMark {
  const value = signedInAs?.trim() ?? '';

  if (!value || value === IDENTITY_UNAVAILABLE) {
    return { initials: '?', label: 'Signed-in user unknown' };
  }
  if (value === IDENTITY_RESOLVING) {
    return { initials: '\u2026', label: 'Resolving the signed-in user' };
  }
  // A client id has no initials to take. Two letters that say what kind of
  // principal it is carry more than the first two hex digits of its uuid would,
  // and the full id is on the label.
  //
  // Tested against the local part rather than the whole value, so that a
  // hex-looking domain cannot turn a person into a service principal. A service
  // principal id has no `@`, so the local part is the whole of it.
  const local = localPart(value);
  if (isOpaqueId(local)) {
    return { initials: 'SP', label: `Service principal ${principalLabel(value)}` };
  }

  const initials = initialsOf(local);
  // Reachable: a local part of nothing but separators, or of characters this
  // takes no letter from. Rare, but a blank circle beside a message would read
  // as a rendering fault rather than as an unusual address.
  return { initials: initials || '?', label: value };
}

/**
 * The part of an address that names a person, or the whole value if it is
 * already a name.
 *
 * Sub-addressing is dropped: `jane+benchmarks@…` is Jane, and treating the tag
 * as a second name gives "JB".
 */
function localPart(value: string): string {
  const at = value.indexOf('@');
  const local = at === -1 ? value : value.slice(0, at);
  const plus = local.indexOf('+');
  return plus === -1 ? local : local.slice(0, plus);
}

/**
 * First and last, and two letters from a name that has no last.
 *
 * This is the rule the conversation rail has always used, kept because the rail
 * and a message bubble can show the same person on the same screen and two
 * conventions would read as two people.
 *
 * Split by code point rather than by index, because a name can begin with a
 * character JavaScript stores in two units and half of one is a broken glyph.
 */
function initialsOf(name: string): string {
  const tokens = name.split(SEPARATORS).filter((token) => token.length > 0);
  if (tokens.length === 0) return '';
  if (tokens.length === 1) return firstGlyphs(tokens[0], 2);
  return `${firstGlyphs(tokens[0], 1)}${firstGlyphs(tokens[tokens.length - 1], 1)}`;
}

function firstGlyphs(token: string, count: number): string {
  return Array.from(token).slice(0, count).join('').toLocaleUpperCase();
}
