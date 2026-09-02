/**
 * What the run header derives: the id as a chip, the status pill's tone, and the
 * run summed up in one right-pinned line.
 *
 * The id, the person and the status used to be one mono sentence under the title,
 * run together with middots, which is the shape this app keeps deleting: a line
 * the reader has to parse before finding the one value they came for. The id is a
 * chip you copy, the status is the pill the run list already draws, and what is
 * left is the run's own figures.
 *
 * NOTHING IS FILLED IN. A run whose duration was never recorded, or whose trace
 * carries no call count, simply does not print that part; there is no zero
 * standing in for a measurement nobody took, and a run nobody has rated says so
 * rather than showing an empty scale.
 *
 * Here rather than in RunExplorer.tsx because vitest runs on `node`: a rule that
 * only exists inside markup can be asserted against a rendered tree and never
 * against itself.
 */
import { feedbackLabel, type FeedbackDirection } from '../../shared/feedback-direction';

/**
 * How much of an id is enough to recognise it by.
 *
 * The full id is 36 characters and is a value to compare against MLflow rather
 * than to read, so the chip shows the first twelve and the copy button puts the
 * whole thing on the clipboard. Twelve hex characters is the prefix every other
 * tool in this stack identifies a trace by.
 */
const ID_PREFIX = 12;

export function shortRunId(id: string): string {
  return id.length > ID_PREFIX ? id.slice(0, ID_PREFIX) : id;
}

/**
 * A run's status as one of the four tones the pill has, keyed on the word the
 * store recorded rather than on anything a page decides.
 *
 * The label stays the server's own word -- the pill capitalises it and nothing
 * renames it, so a status nobody here recognises still reads as itself. The tone
 * is the only thing added, and an unrecognised status gets the neutral one rather
 * than a guess.
 *
 * Shared by the run list and the run header because they are two drawings of one
 * value: a run that is amber in the list and green in the header beside it is the
 * app disagreeing with itself about the same word.
 */
export function statusTone(status: string | null | undefined) {
  const word = (status ?? '').trim().toLowerCase();
  if (word === 'complete' || word === 'completed' || word === 'succeeded') return 'tone-ok';
  if (word === 'failed' || word === 'error') return 'tone-bad';
  if (word === 'partial') return 'tone-degraded';
  return 'tone-neutral';
}

/**
 * Which of the pill's five families a status belongs to.
 *
 * Separate from `astPill` below because two things need the answer and only one of
 * them is a class name: the header ticks the family that earns a tick, and a run
 * that failed must not get a check beside the word "failed". Deriving that by
 * looking for a substring in a class list is the kind of coupling that survives
 * until somebody renames a modifier.
 */
export type PillFamily = 'pos' | 'neg' | 'warn' | 'neutral';

export function statusFamily(status: string | null | undefined): PillFamily {
  const word = (status ?? '').trim().toLowerCase();
  if (word === 'complete' || word === 'completed' || word === 'succeeded' || word === 'answered') return 'pos';
  if (word === 'failed' || word === 'error' || word === 'refused') return 'neg';
  if (word === 'partial' || word === 'truncated' || word === 'degraded') return 'warn';
  return 'neutral';
}

/**
 * The one pill recipe, as the class pair a status renders with.
 *
 * §2: "one recipe ... never colour alone". `.ast-pill` in astrolabe-tokens.css is
 * the geometry -- 1px border, tint, 4px radius, 11px/500 -- and the family
 * modifier is the hue. Nothing here can enforce the "never colour alone" half,
 * because a rule cannot see whether its element has words in it, so that belongs
 * to the tests of the surfaces that render one; what this CAN enforce is that
 * there is one mapping from a status word to a family.
 *
 * `statusTone` above is the same decision for the DuBois pill. It is still
 * exported and still mapped, because `.run-pill` is still the recipe the
 * conversation rail's own pill is written against -- see
 * `rail-run-summary.test.ts`, which holds the two together. What has changed is
 * that no Run Explorer surface renders it any more: the header, the run list and
 * every stage badge on the trace surfaces take `.ast-pill`. The DuBois pair goes
 * when the rail migrates, which is not this lane's file to move.
 *
 * Shared by all three of those, so a status cannot be amber in one and red in
 * another.
 */
export function astPill(status: string | null | undefined): string {
  return `ast-pill ast-pill--${statusFamily(status)}`;
}

export interface RunHeadline {
  durationMs?: number | null;
  /** The agent's own external-call counter for this run. */
  toolCalls?: number | null;
  feedback?: FeedbackDirection | null;
}

/**
 * The run in one line: wall time, external calls, and human feedback.
 *
 * Seconds to one decimal, as the run list and Overview tile print them, so one
 * run reads the same everywhere. Feedback is always named by direction, with an
 * explicit No feedback state where the header needs one.
 */
export function runHeadline({ durationMs, toolCalls, feedback }: RunHeadline): string {
  const parts: string[] = [];
  if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
    parts.push(`${(durationMs / 1000).toFixed(1)}s`);
  }
  if (typeof toolCalls === 'number' && Number.isFinite(toolCalls)) {
    parts.push(`${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`);
  }
  parts.push(feedbackLabel(feedback ?? null));
  return parts.join(' · ');
}
