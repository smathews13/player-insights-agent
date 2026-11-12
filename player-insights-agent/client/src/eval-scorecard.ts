/**
 * The published held-out evaluation scorecard.
 *
 * WHERE THE FILE BESIDE THIS ONE COMES FROM. `scripts/run-held-out-eval.ts`
 * writes `eval-scorecard.generated.json` by running the twelve labelled cases
 * through `startBenchmarkRun` -- the Benchmark Lab's own runner, unmodified --
 * with the operator's OAuth token forwarded to the serving endpoint. It is
 * committed rather than fetched, so the pane can state the date, the commit and
 * the model version the figures were produced against.
 *
 * WHY IT IS NOT PRODUCED BY THE OFFLINE HARNESS, which is what this module used
 * to say was coming. `agent/eval/run_eval.py` reaches the agent in-process with
 * no forwarded user token. The agent reads governed data as the person who
 * asked and has no service-principal fallback -- three of them were deliberately
 * closed -- so every turn of an offline run is refused at the identity gate
 * before a tool is built. That is the governance property working, and the fix
 * was emphatically not to give the harness a way through: it was to run the
 * evaluation on the one path that has a caller.
 *
 * THE GUARD THAT MATTERS IS IN THE WRITER, NOT HERE. The script refuses to write
 * a scorecard when every case ended at the identity gate, so a file that exists
 * is a file whose cases actually ran. This module's job is only to say which of
 * the two states the app is in.
 */
import type { Scorecard, ScorecardState } from '../../shared/scorecard-contract';
import generated from './eval-scorecard.generated.json';

/**
 * Why no evaluation would be published, in the words a reader on the page needs.
 *
 * Retained even though a scorecard exists today, because the pane must have
 * something to say if the generated file is ever emptied or a run is reverted.
 * Deliberately says what would have to change: "not available" on its own reads
 * as a promise that somebody is working on it.
 */
export const NOT_PUBLISHED_REASON =
  'No held-out evaluation has been published yet. The scorers and the labelled set are in the repository and ' +
  'tested, but an evaluation has to run somewhere the agent can read governed data as a real signed-in caller. ' +
  'It has no service-principal fallback to run under instead -- that is deliberate, and it is the property the ' +
  'governed-access scorers exist to check. Run scripts/run-held-out-eval.ts as a signed-in user to publish one.';

/**
 * A published scorecard, or a stated absence.
 *
 * The shape check is deliberately narrow: it establishes that the committed file
 * is a scorecard rather than a placeholder, and does not attempt to validate
 * every field. A malformed file is a repository defect that a test catches, not
 * a runtime condition this pane should try to render around.
 */
export function evalScorecard(): ScorecardState {
  const scorecard = generated as unknown as Scorecard;
  if (
    !scorecard?.provenance?.evaluatedAt ||
    !Array.isArray(scorecard.aggregates) ||
    scorecard.aggregates.length === 0
  ) {
    return { published: false, reason: NOT_PUBLISHED_REASON };
  }
  return { published: true, scorecard };
}
