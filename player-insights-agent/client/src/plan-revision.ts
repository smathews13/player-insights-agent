/**
 * The other answer to a proposed plan: what "Revise request" edits, and what
 * the agent is asked once the edits are done.
 *
 * Kept out of PlanCard.tsx because the card may not compose strings -- see
 * plan-entities.test.ts, which holds that file to rendering -- and because the
 * three transitions the button drives (open, cancel, send) are the whole
 * interaction and are worth testing without a browser, which this repo has
 * none of.
 *
 * A revision is not a new response type on the wire. The agent takes a
 * question and proposes a plan for it; a revised request is therefore a
 * question again, written from the source the reader picked plus whatever they
 * typed, and asked with no approval attached so nothing runs and a fresh plan
 * comes back.
 *
 * The backend discards a pasted step list. Only the "What to change" note
 * reaches it, so a picker that mutates titles would look like it did something
 * and then do nothing. Selection is therefore translated into that note.
 */
import type { AnalysisPlan } from './app-types';

const RECOMMENDED_TITLE_SUFFIX = /\s*\(recommended\)\s*$/i;
const PLAN_REVISION_PREFIX = 'Revise the proposed analysis plan for this question:';

/** Whether a user turn is the one allowed plan-revision request. */
export function isPlanRevisionRequest(content: string): boolean {
  return content.trimStart().startsWith(PLAN_REVISION_PREFIX);
}

/** Whether this step is the one the agent marked as its pick. */
export function isRecommendedSourceTitle(title: string): boolean {
  return RECOMMENDED_TITLE_SUFFIX.test(title);
}

/**
 * The table name as it should render: the agent's `(recommended)` marker is a
 * badge on the card, not part of the identifier.
 */
export function displaySourceTitle(title: string): string {
  const stripped = title.replace(RECOMMENDED_TITLE_SUFFIX, '').trim();
  return stripped.length > 0 ? stripped : title.trim();
}

/** The step the picker starts on: the recommended source, else the first. */
export function recommendedSourceId(plan: AnalysisPlan): string {
  const marked = plan.steps.find((step) => isRecommendedSourceTitle(step.title));
  return marked?.id ?? plan.steps[0]?.id ?? '';
}

/** The editor's contents: which source is selected, and the reader's note. */
export interface PlanRevision {
  note: string;
  selectedStepId: string;
}

export type PlanRevisionAction =
  | { type: 'open'; plan: AnalysisPlan }
  | { type: 'cancel' }
  | { type: 'note'; note: string }
  | { type: 'select'; id: string };

/** The picker as it opens: the recommended source chosen, and an empty note. */
export function revisionFromPlan(plan: AnalysisPlan): PlanRevision {
  return {
    note: '',
    selectedStepId: recommendedSourceId(plan),
  };
}

/**
 * `null` is the card in its ordinary state and a revision is the card with the
 * picker open, so opening and cancelling are the same reducer as typing.
 *
 * Cancel discards rather than remembers. A draft kept behind a closed editor is
 * a second, invisible version of the plan on screen, and the next reader of
 * this card -- including the same one a minute later -- would have no way to
 * tell that the source they are looking at is not the one that would be sent.
 */
export function planRevisionReducer(revision: PlanRevision | null, action: PlanRevisionAction): PlanRevision | null {
  if (action.type === 'open') return revisionFromPlan(action.plan);
  if (action.type === 'cancel') return null;
  if (!revision) return revision;
  if (action.type === 'note') return { ...revision, note: action.note };
  return { ...revision, selectedStepId: action.id };
}

/** Whether the picker is pointing at a source other than the recommended one. */
export function sourceChanged(plan: AnalysisPlan, revision: PlanRevision): boolean {
  const selected = revision.selectedStepId;
  if (!selected) return false;
  return selected !== recommendedSourceId(plan);
}

/**
 * The sentence the picker writes into the note, when the reader did not keep
 * the recommended source.
 */
export function sourceChoiceNote(plan: AnalysisPlan, revision: PlanRevision): string {
  if (!sourceChanged(plan, revision)) return '';
  const selected = plan.steps.find((step) => step.id === revision.selectedStepId);
  const recommended = plan.steps.find((step) => step.id === recommendedSourceId(plan));
  if (!selected || !recommended) return '';
  return `Use ${displaySourceTitle(selected.title)} instead of ${displaySourceTitle(recommended.title)}.`;
}

/**
 * A revision has to say something. An untouched picker sent back would ask the
 * agent to reconsider a plan while quoting that plan verbatim, and the honest
 * result of that is the same plan again -- a second round trip that looks to
 * the reader like the button did nothing.
 */
export function canSubmitRevision(plan: AnalysisPlan, revision: PlanRevision): boolean {
  return revision.note.trim().length > 0 || sourceChanged(plan, revision);
}

/**
 * The revised request, as a question.
 *
 * The original question is restated because a source name is not a question --
 * an agent handed only a table has lost what the analysis is for -- and the
 * note is quoted as the reader wrote it, with the picker choice folded in.
 * The last line is the consent gate saying itself again: a revision proposes,
 * it does not run.
 */
export function revisedRequest(plan: AnalysisPlan, revision: PlanRevision): string {
  const typed = revision.note.trim();
  const choice = sourceChoiceNote(plan, revision);
  const change = [choice, typed].filter((part) => part.length > 0).join(' ');
  const lines = [`Revise the proposed analysis plan for this question: ${plan.question}`];
  if (change) lines.push('', `What to change: ${change}`);
  lines.push('', 'Propose an updated plan for approval. Do not run the analysis yet.');
  return lines.join('\n');
}
