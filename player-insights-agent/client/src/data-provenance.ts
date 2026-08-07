/**
 * Whether the app can say that the data behind an answer is synthetic.
 *
 * The app is deployed against whatever catalog the operator configures, so it
 * cannot infer this. It may only repeat an explicit statement carried by the
 * answer itself: either the answer is the app's own stored demo response, or one
 * of its caveats states that the records are synthetic. Anything else is
 * `'unknown'`, and an unknown provenance must be rendered as no claim at all,
 * a missing badge is harmless, a badge reading "synthetic" over a customer's
 * production tables is not.
 */
import { REPRESENTATIVE_ANSWER_CAVEAT } from '../../shared/representative-answer';

export type DataProvenance = 'synthetic' | 'unknown';

/**
 * An affirmative claim, not a keyword search.
 *
 * The caveat that exposed this asserted the opposite ("No synthetic data was
 * used; all figures are drawn directly from the queried data package"), and any
 * test that merely looks for the word matches it. Requiring the copula
 * immediately before the adjective also rejects "is not synthetic".
 */
const AFFIRMS_SYNTHETIC = /\b(?:is|are|was|were)\s+synthetic\b/i;

/** Rejects "None of these records are synthetic", which clears the test above. */
const NEGATED = /\b(?:no|not|none|never|neither|nothing|without)\b/i;

function clauseAffirmsSynthetic(clause: string): boolean {
  const claim = clause.search(AFFIRMS_SYNTHETIC);
  if (claim < 0) return false;
  return !NEGATED.test(clause.slice(0, claim));
}

/** Split on sentence and clause boundaries so a negation cannot reach across one. */
export function caveatAffirmsSynthetic(caveat: string): boolean {
  return caveat.split(/[.;!?]+/).some(clauseAffirmsSynthetic);
}

/**
 * `REPRESENTATIVE_ANSWER_CAVEAT` is the marker for the app's own canned answer.
 * The server derives it from the absence of a real MLflow trace id rather than
 * from a flag a caller sets, so a canned answer cannot reach here without it.
 */
export function dataProvenance(answer: { caveats: string[] }): DataProvenance {
  if (answer.caveats.includes(REPRESENTATIVE_ANSWER_CAVEAT)) return 'synthetic';
  return answer.caveats.some(caveatAffirmsSynthetic) ? 'synthetic' : 'unknown';
}
