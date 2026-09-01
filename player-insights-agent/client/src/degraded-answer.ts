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
import { type AnswerEvidenceSections } from '../../shared/prose-only-answer';
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
 * The three different things that stop a card being an answer to the question.
 *
 * `representative` is the stronger: the agent produced nothing usable and the
 * app filled the card with its own stored demo response, so no figure on it
 * was queried. `degraded-data` is the agent's own report that it answered, but
 * from a fallback surface.
 *
 * `no-evidence` is the third and it is not a weaker `degraded-data`. It means
 * the card carries prose and nothing else: no figures, no sources, no SQL and
 * no stages. Saying "built on fallback data" over it names data that is not on
 * the screen, and the app would be describing a fallback it did not make. This
 * is what the ask route now serves when the endpoint replies in prose, which
 * used to arrive as the agent's words over the demo response's numbers.
 */
export type AnswerFallback = 'representative' | 'degraded-data' | 'no-evidence' | 'failed-after-steps';

/**
 * What the badge and the red panel say, per fallback.
 *
 * Here rather than in the card's JSX so it can be read and tested as copy. The
 * headline is the app's own sentence; the answer's degraded caveats are
 * rendered under it and say the specifics.
 */
export const ANSWER_FALLBACK_NOTICES: Record<AnswerFallback, { badge: string; headline: string }> = {
  representative: {
    badge: 'Validation required',
    // NAMED A STORED DEMO RESPONSE, and there is no longer one to name.
    //
    // The sentence was true while `shared/demo-content.ts` existed and this
    // headline sat over its numbers. That file is deleted and the server only ever
    // sends `mode: 'live'`, but `normalizeAnswer` maps anything that is not exactly
    // 'live' to this notice, on purpose: an answer whose provenance did not survive
    // the wire must not be badged as a live run. So the remaining way to reach this
    // is a stored row that was truncated or written before the removal -- a REAL
    // answer, over which the old sentence told the reader their figures were
    // fabricated. That is the failure this file exists to prevent, pointing the
    // wrong way.
    //
    // What is true in every remaining case is only that the app cannot confirm
    // where the answer came from, so that is all this says now.
    headline: 'Validate these figures against current source data before operational use.',
  },
  'degraded-data': {
    badge: 'Degraded, fallback data',
    headline: 'This answer was built on fallback data.',
  },
  'no-evidence': {
    badge: 'Answer incomplete',
    headline: 'The response format was incomplete. Retry the question before using this result.',
  },
  'failed-after-steps': {
    badge: 'Answer incomplete',
    headline: 'The response ended before the answer was complete. Retry the question before using this result.',
  },
};

/**
 * The notice a card should lead with, when it should lead with one.
 *
 * Empty-stage runs get the no-result wording even if a leftover caveat still
 * talks about "prose": that sentence was written for a reply that had words and
 * no contract, and it is the wrong diagnosis when nothing ran.
 */
export function answerFallbackNotice(
  answer: AnswerEvidenceSections & {
    mode: string;
    caveats: string[];
    provenance?: string;
  }
): { badge: string; headline: string; kind: AnswerFallback; tone: 'stored' | 'mixed' | 'failed' } | null {
  const kind = answerFallback(answer);
  if (!kind) return null;
  if (kind === 'failed-after-steps') {
    return {
      kind,
      badge: ANSWER_FALLBACK_NOTICES[kind].badge,
      headline: ANSWER_FALLBACK_NOTICES[kind].headline,
      tone: 'failed',
    };
  }
  const notice = ANSWER_FALLBACK_NOTICES[kind];
  return {
    kind,
    ...notice,
    tone: kind === 'representative' ? 'stored' : kind === 'degraded-data' ? 'mixed' : 'failed',
  };
}

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

export function answerContentProvenance(answer: { mode: string; provenance?: string }): AnswerContentProvenance {
  if (answer.mode !== 'live') return 'stored';
  return isAnswerProvenance(answer.provenance) ? answer.provenance : 'unstated';
}

/**
 * The headline chip: what the answer is, in the words the reader sees first.
 *
 * Keyed on provenance rather than on `mode`, because a half-live answer is
 * `mode: 'live'` and the chip read "Live agent response" over stored figures.
 * Silence still earns the live wording, for the reason given above.
 *
 * THREE TONES, WHERE THERE WERE TWO, and the third is the one that was doing
 * damage. `variant` is AppKit's and has no rung between "fine" and "failure",
 * so a mixed answer -- live narrative, stored figures -- wore the same chip as
 * a wholly stored one. Those are different amounts of wrong: the first is an
 * answer to your question whose numbers are not yours, the second is not an
 * answer to your question at all. The design reference draws them as two
 * families, warning and negative, and `tone` is what lets the stylesheet do
 * that. `variant` stays because it is what colours the component's own
 * fallbacks, and both are derived here from one decision rather than chosen
 * twice.
 */
export function answerBadge(answer: { mode: string; provenance?: string }): {
  label: string;
  variant: 'default' | 'destructive' | 'outline';
  tone: 'live' | 'mixed' | 'stored';
} {
  const provenance = answerContentProvenance(answer);
  if (provenance === 'stored') {
    return { label: 'Representative response, not your data', variant: 'destructive', tone: 'stored' };
  }
  if (provenance === 'mixed') {
    return { label: 'Live answer, stored figures', variant: 'destructive', tone: 'mixed' };
  }
  return { label: 'Live agent response', variant: 'outline', tone: 'live' };
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
export function answerFallback(
  answer: AnswerEvidenceSections & {
    mode: string;
    caveats: string[];
    provenance?: string;
  }
): AnswerFallback | null {
  const provenance = answerContentProvenance(answer);
  if (provenance === 'stored') return 'representative';
  if (provenance === 'mixed') return 'degraded-data';
  // A live run can still answer off a surface it fell back to, and says so
  // itself. That is the agent's report, not the route's, and the marker above
  // does not describe it.
  if (splitCaveats(answer.caveats).degraded.length === 0) return null;
  // A structured result on a live payload is still live evidence. Its Partial
  // verdict and Keep in mind lines explain which calls did not finish; calling
  // those successful figures "fallback data" contradicts their sources and SQL.
  if (!statesItsEvidence(answer)) return 'degraded-data';
  if (hasStructuredResult(answer)) return null;
  // Stages without figures are a run that worked and then failed to answer,
  // not "nothing ran". The empty-run Failed badge is only for a truly empty
  // trace. Counting stages as evidence here used to paint "Degraded, fallback
  // data" over a card that had no data, or "No result recorded" after the
  // stored trace had been wiped.
  return stageCount(answer.trace) > 0 ? 'failed-after-steps' : 'no-evidence';
}

function hasStructuredResult(answer: AnswerEvidenceSections): boolean {
  return (
    (answer.figures?.length ?? 0) > 0 ||
    (answer.sources?.length ?? 0) > 0 ||
    Boolean(answer.sql?.trim()) ||
    /\|.+\|/.test([answer.narrative, answer.content].filter(Boolean).join('\n'))
  );
}

function stageCount(trace: unknown): number {
  if (!trace || typeof trace !== 'object') return 0;
  const stages = (trace as { stages?: unknown }).stages;
  return Array.isArray(stages) ? stages.length : 0;
}

/**
 * Whether the payload said anything about its evidence sections at all.
 *
 * An absent section is not an empty one. A row stored before a key existed, or
 * a caller that passes only the fields it cares about, states nothing, and
 * reading that silence as emptiness would put "there are no figures under this
 * answer" over a card showing five of them. Silence keeps the older, weaker
 * claim, which is wrong in the direction that does not make a false statement
 * about the screen.
 */
function statesItsEvidence(answer: AnswerEvidenceSections): boolean {
  return (
    answer.figures !== undefined ||
    answer.sources !== undefined ||
    answer.sql !== undefined ||
    answer.trace !== undefined
  );
}
