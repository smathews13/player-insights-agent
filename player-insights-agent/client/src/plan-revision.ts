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
 * question again, written out of the plan the reader edited plus whatever they
 * typed, and asked with no approval attached so nothing runs and a fresh plan
 * comes back.
 */
import type { AnalysisPlan } from './app-types';

export interface RevisedStep {
  id: string;
  title: string;
  description: string;
}

/** The editor's contents: the plan's steps as text, and the reader's note. */
export interface PlanRevision {
  note: string;
  steps: RevisedStep[];
}

export type PlanRevisionAction =
  | { type: 'open'; plan: AnalysisPlan }
  | { type: 'cancel' }
  | { type: 'note'; note: string }
  | { type: 'step'; id: string; field: 'title' | 'description'; value: string }
  | { type: 'remove'; id: string };

/** The editor as it opens: every step of the plan, editable, and an empty note. */
export function revisionFromPlan(plan: AnalysisPlan): PlanRevision {
  return {
    note: '',
    steps: plan.steps.map((step) => ({ id: step.id, title: step.title, description: step.description })),
  };
}

/**
 * `null` is the card in its ordinary state and a revision is the card with the
 * editor open, so opening and cancelling are the same reducer as typing.
 *
 * Cancel discards rather than remembers. A draft kept behind a closed editor is
 * a second, invisible version of the plan on screen, and the next reader of
 * this card -- including the same one a minute later -- would have no way to
 * tell that the steps they are looking at are not the ones that would be sent.
 */
export function planRevisionReducer(revision: PlanRevision | null, action: PlanRevisionAction): PlanRevision | null {
  if (action.type === 'open') return revisionFromPlan(action.plan);
  if (action.type === 'cancel') return null;
  if (!revision) return revision;
  if (action.type === 'note') return { ...revision, note: action.note };
  if (action.type === 'step') {
    return {
      ...revision,
      steps: revision.steps.map((step) => (step.id === action.id ? { ...step, [action.field]: action.value } : step)),
    };
  }
  // Dropping the last step would leave a revision that asks for a plan with no
  // steps in it, which is a request the agent cannot honour and the reader did
  // not mean. The note is where "start over" is said.
  if (revision.steps.length < 2) return revision;
  return { ...revision, steps: revision.steps.filter((step) => step.id !== action.id) };
}

/** Whether the steps on screen still say what the plan said. */
export function stepsEdited(plan: AnalysisPlan, revision: PlanRevision): boolean {
  if (revision.steps.length !== plan.steps.length) return true;
  return revision.steps.some((step, index) => {
    const original = plan.steps[index];
    return !original || original.id !== step.id || original.title !== step.title || original.description !== step.description;
  });
}

/**
 * A revision has to say something. An untouched editor sent back would ask the
 * agent to reconsider a plan while quoting that plan verbatim, and the honest
 * result of that is the same plan again -- a second round trip that looks to
 * the reader like the button did nothing, which is what this whole change is
 * about.
 */
export function canSubmitRevision(plan: AnalysisPlan, revision: PlanRevision): boolean {
  return revision.note.trim().length > 0 || stepsEdited(plan, revision);
}

/**
 * The revised request, as a question.
 *
 * The original question is restated because the plan's steps are not a question
 * -- an agent handed only "1. Read table X" has lost what the analysis is for --
 * and the note is quoted as the reader wrote it. The last line is the consent
 * gate saying itself again: a revision proposes, it does not run.
 */
export function revisedRequest(plan: AnalysisPlan, revision: PlanRevision): string {
  const note = revision.note.trim();
  const steps = revision.steps
    .map((step) => ({ title: step.title.trim(), description: step.description.trim() }))
    .filter((step) => step.title.length > 0 || step.description.length > 0);
  const lines = [`Revise the proposed analysis plan for this question: ${plan.question}`];
  if (note) lines.push('', `What to change: ${note}`);
  if (stepsEdited(plan, revision) && steps.length > 0) {
    lines.push('', 'Use these steps instead:');
    steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step.description ? `${step.title} — ${step.description}` : step.title}`);
    });
  }
  lines.push('', 'Propose an updated plan for approval. Do not run the analysis yet.');
  return lines.join('\n');
}
