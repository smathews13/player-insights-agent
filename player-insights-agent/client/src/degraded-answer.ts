/**
 * Telling a caveat that changes the answer from one that decorates it.
 *
 * So a degradation is pulled out and rendered on its own, above the answer's
 * caveats rather than inside them. Nothing is dropped: a caveat that is not
 * recognised as a degradation still appears in the ordinary list, so the worst
 * a wording change downstream can do is make this less prominent, never make it
 * disappear.
 */
import { isAnswerProvenance, type AnswerProvenance } from '../../shared/answer-provenance';
import { DEGRADED_ANSWER_MARKER } from '../../shared/setup-remedies';

export { DEGRADED_ANSWER_MARKER };

export interface SplitCaveats {
  /** Caveats that say the answer itself is not what it appears to be. */
  degraded: string[];
  /** Everything else, in the order the agent gave it. */
  ordinary: string[];
}

/**
 * Whether one caveat is announcing a degradation.
 */
export function isDegradationCaveat(caveat: string): boolean {
  return caveat.trimStart().startsWith(DEGRADED_ANSWER_MARKER);
}

export function splitCaveats(caveats: string[]): SplitCaveats {
  const degraded: string[] = [];
  const ordinary: string[] = [];
  for (const caveat of caveats) {
    (isDegradationCaveat(caveat) ? degraded : ordinary).push(caveat);
  }
  return { degraded, ordinary };
}

/**
 * The two different things that stop a card being an answer to the question.
 *
 * `representative` is the stronger: the agent produced nothing usable and the
 * app filled the card with its own stored demo response, so no figure on it
 * was queried. `degraded-data` is the agent's own report that it answered, but
 * from a fallback surface.
 */
export type AnswerFallback = 'representative' | 'degraded-data';

/**
 * What the server said about where this answer's contents came from.
 *
 * Four outcomes, not three. `unstated` is an answer the server said nothing
 * about: one stored before the field existed, or served by a build that does
 * not set it. It is kept apart from `live` on purpose, because the useful
 * property of the marker is that only one route path is allowed to write it,
 * and folding silence into it would hand that assurance to every row in the
 * history table.
 *
 * `mode` is checked first and wins. It answers the coarser question, "did a run
 * happen at all", and an answer that says no cannot have contents from one.
 */
export type AnswerContentProvenance = AnswerProvenance | 'unstated';

export function answerContentProvenance(answer: {
  mode: string;
  provenance?: string;
}): AnswerContentProvenance {
  if (answer.mode !== 'live') return 'stored';
  return isAnswerProvenance(answer.provenance) ? answer.provenance : 'unstated';
}

/**
 * The headline chip: what the answer is, in the words the reader sees first.
 *
 * Keyed on provenance rather than on `mode`, because a half-live answer is
 * `mode: 'live'` and the chip read "Live agent response" over stored figures.
 * Silence still earns the live wording, for the reason given above.
 */
export function answerBadge(answer: { mode: string; provenance?: string }): {
  label: string;
  variant: 'default' | 'destructive';
} {
  const provenance = answerContentProvenance(answer);
  if (provenance === 'stored') {
    return { label: 'Representative response, not your data', variant: 'destructive' };
  }
  if (provenance === 'mixed') {
    return { label: 'Live answer, stored figures', variant: 'destructive' };
  }
  return { label: 'Live agent response', variant: 'default' };
}

/**
 * Why this answer must not be read as a live result, when it must not be.
 *
 * Keyed on what the server stated: `mode` for whether a run happened, and
 * `provenance` for whether its contents came from that run. The second exists
 * because the ask route has a path where both are true and untrue at once: the
 * endpoint answered in prose, so the narrative is the agent's and the figures
 * under it are the stored demo response, and that answer is correctly
 * `mode: 'live'`. It used to reach the browser with nothing distinguishing it
 * from a fully live one, and the card badged it "Live agent response".
 *
 * Deliberately NOT keyed on `REPRESENTATIVE_ANSWER_CAVEAT`, which reads as the
 * same claim and is not one. The server derives that caveat from the absence
 * of an MLflow trace id, so it also appears on a genuinely live answer from a
 * workspace with tracing switched off. Leading such an answer with "these are
 * not your figures" is the mistake that once put a "Synthetic demo data" badge
 * over real production data, and a warning that has been wrong is a warning
 * people learn to dismiss.
 *
 * `unstated` is treated exactly as `live` is, and that is the deliberate half of
 * failing toward disclosure rather than an omission from it. Warning on silence
 * would put a red panel over every answer in the history table written before
 * the marker existed, most of them fully live, which is the same false alarm in
 * a new costume.
 */
export function answerFallback(answer: {
  mode: string;
  caveats: string[];
  provenance?: string;
}): AnswerFallback | null {
  const provenance = answerContentProvenance(answer);
  if (provenance === 'stored') return 'representative';
  if (provenance === 'mixed') return 'degraded-data';
  // A live run can still answer off a surface it fell back to, and says so
  // itself. That is the agent's report, not the route's, and the marker above
  // does not describe it.
  return splitCaveats(answer.caveats).degraded.length > 0 ? 'degraded-data' : null;
}
