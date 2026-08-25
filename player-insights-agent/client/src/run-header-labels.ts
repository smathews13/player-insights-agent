/**
 * Admin edits of the Run Explorer header rail: which chips can change, and how
 * an override is stored and applied.
 *
 * Outcome and rating are the two closed sets an administrator can correct after
 * a run. Conversation, message and user ids are not reassigned from this rail —
 * there is no honest option list that is not "every row in the store". The run
 * number can jump to another turn in the same conversation. Tool count is a
 * measurement, not a label.
 */
import { DOWN_RATING, UP_RATING } from './stored-feedback';
import type { Run } from './app-types';

export const RAIL_OUTCOME_OPTIONS = [
  { value: 'complete', label: 'Complete' },
  { value: 'partial', label: 'Partial' },
  { value: 'failed', label: 'Failed' },
] as const;

export type RailOutcome = (typeof RAIL_OUTCOME_OPTIONS)[number]['value'];

export const RAIL_RATING_OPTIONS = [
  { value: 'unrated', label: 'Not rated' },
  { value: 'up', label: 'Helpful' },
  { value: 'down', label: 'Not helpful' },
] as const;

export type RailRating = (typeof RAIL_RATING_OPTIONS)[number]['value'];

export interface RunLabelOverride {
  status?: RailOutcome | null;
  rating?: RailRating | null;
}

export interface ConversationRunChoice {
  id: string;
  number: number;
}

/** Why a rail field is shown in the editor but cannot be chosen. */
export const RAIL_FIELD_REASONS = {
  conversation: 'The conversation id is the thread this run already belongs to, and is not reassigned from here.',
  message: 'The message id is this run’s stored answer row, and is not reassigned from here.',
  user: 'The asker is recorded on the conversation, and is not reassigned from here.',
  tools: 'The tool count is measured from the trace, and is not a label that can be chosen.',
} as const;

export function conversationRunChoices(
  runs: readonly Run[],
  selected: Run | null
): ConversationRunChoice[] {
  if (!selected?.conversation_id) return [];
  const chronological = [...runs]
    .filter((run) => run.conversation_id === selected.conversation_id)
    .reverse();
  return chronological.map((run, index) => ({ id: run.id, number: index + 1 }));
}

export function railOutcomeValue(status: string | null | undefined): RailOutcome {
  const word = (status ?? '').trim().toLowerCase();
  if (word === 'failed' || word === 'error' || word === 'refused') return 'failed';
  if (word === 'partial' || word === 'truncated' || word === 'degraded') return 'partial';
  return 'complete';
}

export function railRatingValue(rating: number | null | undefined): RailRating {
  if (typeof rating !== 'number' || !Number.isFinite(rating)) return 'unrated';
  if (rating >= 4) return 'up';
  if (rating <= 2) return 'down';
  return 'unrated';
}

export function ratingFromRail(choice: RailRating): number | null {
  if (choice === 'up') return UP_RATING;
  if (choice === 'down') return DOWN_RATING;
  return null;
}

/**
 * The run the header should draw, after an administrator’s stored choice.
 *
 * Classification is left alone: the overlay only replaces the words on the rail
 * when a row exists. Absent overlay fields keep the store’s own values.
 */
export function applyRunLabelOverride(run: Run, overlay: RunLabelOverride | null | undefined): Run {
  if (!overlay) return run;
  const status = overlay.status ?? run.status;
  const rating =
    overlay.rating === undefined || overlay.rating === null ? run.rating : ratingFromRail(overlay.rating);
  return { ...run, status, rating };
}

export async function persistRunLabels(
  runId: string,
  overlay: RunLabelOverride,
  send: typeof fetch = fetch
): Promise<RunLabelOverride> {
  const response = await send(`/api/admin/run-labels/${encodeURIComponent(runId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(overlay),
  });
  if (!response.ok) {
    throw new Error('The run labels were not saved.');
  }
  return (await response.json()) as RunLabelOverride;
}

export async function readRunLabelOverride(
  runId: string,
  send: typeof fetch = fetch
): Promise<RunLabelOverride | null> {
  const response = await send(`/api/admin/run-labels/${encodeURIComponent(runId)}`);
  if (response.status === 404) return null;
  if (!response.ok) return null;
  return (await response.json()) as RunLabelOverride;
}
