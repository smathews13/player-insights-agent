import { CustomJudgeSchema, customJudgeAssessmentName, type CustomJudge } from '../../shared/eval-dataset';

export const MAX_CUSTOM_JUDGES = 12;

export type CustomJudgeDraft = {
  name: string;
  guidelines: string;
  prompt: string;
};

export type CustomJudgeDraftIssue =
  | 'name_required'
  | 'guidelines_required'
  | 'duplicate_name'
  | 'limit_reached'
  | 'invalid';

export type CustomJudgeDraftValidation =
  | { ok: true; judge: CustomJudge }
  | { ok: false; issue: CustomJudgeDraftIssue; message: string };

function invalidJudgeMessage(draft: CustomJudgeDraft): string {
  if (draft.name.trim().length > 80) return 'Custom judge names must be 80 characters or fewer.';
  if (draft.guidelines.trim().length > 4_000) return 'Custom judge guidelines must be 4,000 characters or fewer.';
  if (draft.prompt.trim().length > 8_000) return 'Custom judge prompts must be 8,000 characters or fewer.';
  return 'This custom judge is not valid.';
}

/**
 * Validate the Settings composer before it stages a judge.
 *
 * The backend schema remains the final security boundary. Settings is
 * deliberately stricter about requiring the yes/no guideline the form labels
 * as required; the free-form prompt remains optional.
 */
export function validateCustomJudgeDraft(
  draft: CustomJudgeDraft,
  stagedJudges: readonly CustomJudge[]
): CustomJudgeDraftValidation {
  const name = draft.name.trim();
  const guidelines = draft.guidelines.trim();
  const prompt = draft.prompt.trim();

  if (!name) {
    return {
      ok: false,
      issue: 'name_required',
      message: guidelines ? 'Enter a custom judge name.' : 'Enter a name and yes/no guideline.',
    };
  }
  if (!guidelines) {
    return {
      ok: false,
      issue: 'guidelines_required',
      message: 'Enter the yes/no guideline this judge should score.',
    };
  }
  if (stagedJudges.length >= MAX_CUSTOM_JUDGES) {
    return {
      ok: false,
      issue: 'limit_reached',
      message: `Remove a custom judge before adding another. The limit is ${MAX_CUSTOM_JUDGES}.`,
    };
  }

  const parsed = CustomJudgeSchema.safeParse({ name, guidelines, prompt });
  if (!parsed.success) {
    return { ok: false, issue: 'invalid', message: invalidJudgeMessage(draft) };
  }

  const key = customJudgeAssessmentName(parsed.data.name);
  if (stagedJudges.some((judge) => customJudgeAssessmentName(judge.name) === key)) {
    return {
      ok: false,
      issue: 'duplicate_name',
      message: `A custom judge named “${parsed.data.name}” already exists.`,
    };
  }
  return { ok: true, judge: parsed.data };
}

export type StageCustomJudgeResult =
  | { ok: true; judges: CustomJudge[]; judge: CustomJudge }
  | { ok: false; judges: readonly CustomJudge[]; issue: CustomJudgeDraftIssue; message: string };

/** The Add button's complete state transition, kept atomic for double-clicks. */
export function stageCustomJudge(
  stagedJudges: readonly CustomJudge[],
  draft: CustomJudgeDraft
): StageCustomJudgeResult {
  const validation = validateCustomJudgeDraft(draft, stagedJudges);
  if (validation.ok === false) {
    return {
      ok: false,
      judges: stagedJudges,
      issue: validation.issue,
      message: validation.message,
    };
  }
  return {
    ok: true,
    judges: [...stagedJudges, validation.judge],
    judge: validation.judge,
  };
}
