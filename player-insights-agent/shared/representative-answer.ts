/**
 * The one sentence that keeps an untraced answer from reading as a live result.
 *
 * WHAT USED TO BE HERE AND WHY IT IS GONE. This file also held the app's stored
 * demo answer: its figures, narrative, SQL, sources and six reference stages,
 * plus the seeded conversation and run rows that displayed them. All of it is
 * removed. It was shown when the store was unreadable or empty on a deployment
 * that set an env var, and a labelled fixture is still a screen of invented
 * numbers once a reader has scrolled past the label.
 *
 * THIS CONSTANT IS NOT PART OF THAT and must not be removed with it. It is not
 * about the demo answer; it is the disclosure applied to ANY answer that came
 * back without an MLflow trace id, which a live run can also produce.
 * Older app builds added it in `discloseAnswerProvenance`. Current builds keep
 * the constant only to recognize historical records: trace availability belongs
 * to the process inspector, so the answer-content policy removes this sentence
 * at read time without rewriting the stored `response_json`.
 *
 * IT IS NOT READ FOR ANYTHING ELSE. The browser used to key a "Synthetic data"
 * chip off the caveats beside a cited table, and this constant was one of the
 * inputs; both the chip and the module that decided it are gone. Nothing on the
 * surface should infer a claim about the data from the absence of a trace id.
 */
/**
 * THE SENTENCE NO LONGER NAMES A DEMO RESPONSE, because there is not one.
 *
 * It said the figures "come from a stored demo response rather than a live agent
 * query", which was true while this file held that response. With the response
 * gone, the only remaining way to get this caveat is a live run whose trace id is
 * missing -- a workspace with MLflow tracing switched off, or an endpoint that
 * answered without a span. So the old sentence told those readers their real
 * figures were fabricated, which is the exact failure this file's own history
 * warns about, and worse than saying nothing.
 *
 * What is true in every remaining case is narrow, and this now says only that:
 * nothing recorded the run, so it cannot be opened in MLflow. The card no longer
 * draws a process view for that case, so this sentence does not talk about
 * timings that are not on the screen. It makes no claim about whether the data
 * is real. `SYNTHETIC_DATA_CAVEAT` in `agent/agent.py` is where that claim
 * belongs, and only a deployment that declared it gets it.
 */
export const REPRESENTATIVE_ANSWER_CAVEAT =
  'No MLflow trace was recorded for this answer, so it cannot be opened in MLflow.';
