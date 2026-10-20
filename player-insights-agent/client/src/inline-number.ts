/**
 * The one pattern that finds a real figure in prose (a count, percent, amount or
 * date) so it can be styled as a number.
 *
 * It is guarded on both sides so a digit inside an identifier (`game2k30`,
 * `title7`, `rdr2`, `bio_inf1`) is never pulled out and badged, which broke the
 * name across lines. Plan text and answer text both use this one copy; they had
 * two, and only one was fixed the first time.
 */
export const INLINE_NUMBER =
  /(?<![A-Za-z0-9_])(?:\d{4}-\d{1,2}-\d{1,2}|[-+\u2212]?(?:[$€£]\s*)?\d[\d,]*(?:\.\d+)?%?)(?![A-Za-z0-9_])/g;
