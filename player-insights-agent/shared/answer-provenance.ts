/**
 * Where the parts of an answer came from, stated by the server rather than
 * inferred by the browser.
 *
 * `mode` cannot carry this. It answers "did a run happen", and the ask route has
 * one path where a run happened and produced only prose: the narrative is the
 * agent's, and the figures, charts, sources, SQL and stages under it are the
 * app's stored demo response. That answer is `mode: 'live'` and correctly so,
 * and every number on it was invented. Until this existed the only way to tell
 * was to notice that its caveats mentioned a missing trace id, which is reading
 * the server's prose for a fact the server already had.
 */
export const ANSWER_PROVENANCE_VALUES = ['live', 'mixed', 'stored'] as const;

/**
 * - `live`: every reader-facing part came from this run.
 * - `mixed`: some did and some are the stored demo response. Which parts is said
 *   in the caveats, because a reader needs the sentence and a renderer needs the
 *   value, and the two want different things.
 * - `stored`: none of it came from a run.
 */
export type AnswerProvenance = (typeof ANSWER_PROVENANCE_VALUES)[number];

/**
 * Whether a wire value is one of the three.
 *
 * Anything else (an absent field on a row stored before this shipped, a value
 * from a newer server this build has not caught up with) is deliberately not
 * coerced to `live`. An answer whose provenance is unknown must not be able to
 * borrow the assurance of one that stated it.
 */
export function isAnswerProvenance(value: unknown): value is AnswerProvenance {
  return (ANSWER_PROVENANCE_VALUES as readonly unknown[]).includes(value);
}
