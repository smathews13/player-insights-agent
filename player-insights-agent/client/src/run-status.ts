/**
 * What the run pill says, as one function.
 *
 * The word and the tone were derived in one chain inside the page, which was
 * already better than the Badge variants they replaced -- those had `secondary`
 * standing for "Ready" and for "Complete" both, the two ends of a run painted
 * identically. It is out here now because two of its branches are claims that can
 * be wrong: "Ready" asserts something about a serving endpoint, and `alive`
 * asserts that the dot beside the word is entitled to move. Both are worth being
 * able to test at every combination rather than only through the page.
 *
 * `alive` is the third field for exactly that reason. It is not a colour and not
 * a synonym for a tone: `is-ready` is worn by "Complete" as well, and a finished
 * run whose dot went on breathing would be claiming the harness was doing
 * something. It means "this state is happening now and continuously" -- a run in
 * flight, or an endpoint that answered and is waiting -- and it is the only thing
 * rail.css animates.
 */
import { stepNumber } from './agent-map';
import type { AgentReadiness } from './agent-readiness';

export type RunTone = 'is-ready' | 'is-live' | 'is-failed' | 'is-waiting';

/**
 * Which of `.ast-pill`'s families each tone wears.
 *
 * §2 allows the app one status recipe, so this pill seats the shared one and
 * rail.css keeps only what a dot, a check and a breathing animation need on top
 * of it. The tones stay named for the STATE rather than for the family, because
 * two of them are not a colour: `is-ready` is worn by "Complete" as well, and
 * `is-live` is the one state with no family at all.
 *
 * LIVE IS DELIBERATELY EMPTY, and it is the spec's exception rather than a gap.
 * §4 gives this pill as "Ready (green) or Live (solid blue #2272B4)" -- a filled
 * mass, not a tint with a hairline -- and none of the five families is a solid.
 * `.run-status.is-live` in rail.css is that one rule, and it overrides the
 * recipe's border and fill rather than sitting beside a family that would fight
 * it.
 */
export const RUN_TONE_FAMILY: Record<RunTone, string> = {
  'is-ready': 'ast-pill--pos',
  'is-live': '',
  'is-failed': 'ast-pill--neg',
  // Outlined rather than filled: the inspector's head is already a tinted band,
  // and a grey fill on it reads as a rendering fault rather than as a chip.
  'is-waiting': 'ast-pill--neutral-outline',
};

export interface RunStatus {
  label: string;
  tone: RunTone;
  /** Whether the dot may move. See the note above; it is not a restatement of the tone. */
  alive: boolean;
  /**
   * Whether the run reached its end, which is what earns the check.
   *
   * A fourth field for the same reason `alive` is a third one: it is not a
   * synonym for a tone. `is-ready` is worn by "Complete" and by "Ready" both, and
   * a check beside "Ready" would be claiming a run had finished when none has
   * started. The design asks for a check on the finished badge and a dot on every
   * other, and nothing about the tone can tell those two apart.
   */
  finished: boolean;
}

/**
 * The idle screen, in the endpoint's own terms.
 *
 * Three of the four are some kind of "not ready", and they are kept apart because
 * a reader does something different about each: wait, go and look at Connections,
 * or reload. The two unhappy words are the vocabulary the app already uses for
 * these readings -- `PREFLIGHT_STATUS_LABEL` calls an unverified check "Not
 * checked" -- rather than a second set invented here for the same facts.
 */
const IDLE: Record<AgentReadiness, RunStatus> = {
  checking: { label: 'Checking agent', tone: 'is-waiting', alive: false, finished: false },
  ready: { label: 'Ready', tone: 'is-ready', alive: true, finished: false },
  unreachable: { label: 'Agent unreachable', tone: 'is-failed', alive: false, finished: false },
  unchecked: { label: 'Agent not checked', tone: 'is-waiting', alive: false, finished: false },
};

export function runStatusFor({
  loading,
  liveSteps,
  runningStep = 0,
  runStopped,
  awaitingApproval,
  asked,
  answered,
  readiness,
}: {
  loading: boolean;
  liveSteps: number;
  /**
   * Which step is in progress, one-based, or 0 when the run has not said.
   *
   * Zero for every run against a model version that reports a step only once it
   * has finished, and zero between a step finishing and the next being announced.
   * The two failure labels below turn on it, so it must not be defaulted to
   * anything else: a 1 standing in for "not stated" would name step 01 as the
   * step a run was inside every time it died in a gap.
   */
  runningStep?: number;
  runStopped: boolean;
  awaitingApproval: boolean;
  asked: boolean;
  answered: boolean;
  readiness: AgentReadiness;
}): RunStatus {
  // A description of the rail below rather than of the request: it fills in as
  // the run goes, so "Live" is what it is doing. The number is two digits, out of
  // the same `stepNumber` the cards use, so the badge and the card it is counting
  // are written the same way -- "Live · step 07" over a card numbered 07.
  //
  // The FURTHEST of the two readings, because they are no longer the same row.
  // The announced row used to be the last row in the list, so "the step in
  // progress" and "the newest step reported" were one number; a run that
  // announces `orchestrator` before any step of it starts and reports it only at
  // the end broke that, and preferring the step in progress pinned this badge to
  // "Live · step 01". Taking the later of the two names the newest step in both
  // directions: the announcement while it is open, the completion in the gap
  // before the next announcement, and the frontier against a model that
  // announces nothing at all.
  if (loading) {
    const step = Math.max(runningStep, liveSteps);
    return {
      label: step > 0 ? `Live · step ${stepNumber(step)}` : 'Live',
      tone: 'is-live',
      alive: true,
      finished: false,
    };
  }
  // "AT" when the run named the step it was inside, "AFTER" when it did not, and
  // the difference is not cosmetic. The endpoint announces a step when it starts
  // as well as when it finishes, so the step a failure interrupted is usually
  // known by name and number and the design's "Failed at step NN" is finally
  // true. It is not always known: a run can die in the gap between one step
  // finishing and the next being announced, and a model version that reports only
  // completions never announces at all. In both of those, NN would be naming the
  // last step that WORKED, so what is said instead is how far the run got.
  if (runStopped) {
    if (runningStep > 0) {
      return {
        label: `Failed at step ${stepNumber(runningStep)}`,
        tone: 'is-failed',
        alive: false,
        finished: false,
      };
    }
    return {
      label: liveSteps > 0 ? `Stopped after step ${stepNumber(liveSteps)}` : 'Stopped',
      tone: 'is-failed',
      alive: false,
      finished: false,
    };
  }
  if (awaitingApproval) return { label: 'Approval needed', tone: 'is-waiting', alive: false, finished: false };
  if (asked) return { label: 'Question asked', tone: 'is-waiting', alive: false, finished: false };
  // Complete is a fact about the run that just finished and is not re-derived
  // from the endpoint: the run itself is the evidence the endpoint answered, and
  // a stale readiness reading must not be able to contradict a run that landed.
  if (answered) return { label: 'Complete', tone: 'is-ready', alive: false, finished: true };
  return IDLE[readiness];
}
