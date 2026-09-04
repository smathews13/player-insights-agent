import { identityName } from './user-identity';

const PROFILE_NAME_UNAVAILABLE = /^(?:unknown|user|system|service(?:[-\s_]principal)?|not\s+recorded)$/iu;

/**
 * Personalize the activity heading without trusting punctuation or casing in
 * identity data. A canonical display name wins when supplied; otherwise the
 * first Unicode word in the email local part is used.
 */
export function profileAskedHeading(displayName: string | null | undefined, email: string | null | undefined): string {
  const supplied = displayName?.normalize('NFKC').trim() ?? '';
  const local = identityName(email).normalize('NFKC').trim();
  const candidate = supplied || local;
  const words = candidate.replace(/[._-]+/gu, ' ').match(/\p{L}[\p{L}\p{M}'’]*/gu);
  const rawFirst = words?.[0]?.trim() ?? '';
  if (!rawFirst || PROFILE_NAME_UNAVAILABLE.test(rawFirst)) return 'WHAT THIS USER ASKED';
  const titleNormalized = rawFirst.toLocaleLowerCase().replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase());
  return `WHAT ${titleNormalized.toLocaleUpperCase()} ASKED`;
}
