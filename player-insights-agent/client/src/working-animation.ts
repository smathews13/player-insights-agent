/**
 * Which seating the working loader takes, and the words around it.
 *
 * Apart from the components so that WorkingConstellation.tsx exports a component
 * and nothing else, which is what lets a fast refresh replace it in place.
 */
import { PLANNING_STAGE_LABEL } from './current-stage-view';

/** The two panels `loading-suite.md` gives the working state (`#5ar`, `#5br`). */
export type WorkingSeat = 'splash' | 'card';

/**
 * The label the elapsed count follows.
 *
 * What the design also asks for, and this deliberately does not carry, is a
 * "Still going; complex questions take this long" clause past twenty seconds.
 * That sentence was in the app once and was cut: the count already says the wait
 * is long and that nothing has hung, and saying it again in words is the
 * reassuring register the rest of the app no longer uses.
 */
export const WORKING_LABEL = PLANNING_STAGE_LABEL;

/** The Agent path repeats the exact pre-stage label until stage one lands. */
export const INLINE_WORKING_LABEL = PLANNING_STAGE_LABEL;

/**
 * Every question gets the full splash, the first and every follow-up.
 *
 * It used to shrink to a strip once an answer was on screen, so a follow-up
 * looked like a different, lesser wait than the first question's. The argument
 * is kept so callers do not change, and the strip seating stays in the type for
 * narrow surfaces that ask for it directly.
 */
export function seatForTranscript(_messages: { role: string }[]): WorkingSeat {
  return 'splash';
}

/**
 * The seconds so far, or null while there are not enough of them to say.
 *
 * REAL, AND NEVER A PERCENTAGE (`loading-suite.md`). Below two seconds it is
 * null rather than "0s" or "1s": a counter that appears at zero and immediately
 * corrects itself reads as a stutter, and the label alone already says the run
 * is in flight.
 */
export function elapsedSeconds(startedAt: number | null, now: number): string | null {
  if (!startedAt) return null;
  const elapsed = Math.floor((now - startedAt) / 1000);
  return elapsed < 2 ? null : `${elapsed}s`;
}
