/**
 * Admin edits of the Run Explorer header rail: which chips can change, and how
 * an override is stored and applied.
 *
 * Outcome and rating are the two closed sets an administrator can correct after
 * a run. Conversation, message, user and tool-count stay as chips; they are not
 * reassigned from this rail.
 */
import type { Conversation, Run } from './app-types';
import { railStatusTone, type RailRunSummary } from './rail-run-summary';
import { DOWN_RATING, UP_RATING } from './stored-feedback';

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

/**
 * The same overlay, on every row of a list. The header used to apply it
 * alone, so Recent runs / Ask / Monitoring kept the classified Partial.
 */
export function applyRunLabelOverrideToList(
  runs: readonly Run[],
  runId: string,
  overlay: RunLabelOverride | null | undefined
): Run[] {
  if (!overlay) return [...runs];
  return runs.map((run) => (run.id === runId ? applyRunLabelOverride(run, overlay) : run));
}

export const RUN_LABELS_NOT_SAVED = 'The run labels were not saved.';

/**
 * The Ask rail's scoped run-summaries map, after an administrator's choice.
 *
 * Ask prefers that map over the conversation list, and it used to keep the
 * first `/api/runs` Partial after Run Explorer had already been told Complete.
 * Same overlay rule as the recent-runs list: absent fields stay as they were.
 */
export function applyRunLabelOverrideToSummaries(
  summaries: Map<string, RailRunSummary>,
  conversationId: string,
  overlay: RunLabelOverride | null | undefined
): Map<string, RailRunSummary> {
  const id = conversationId.trim();
  if (!overlay || !id) return summaries;
  const held = summaries.get(id);
  if (!held) return summaries;
  const status = overlay.status ?? held.status;
  const rating =
    overlay.rating === undefined || overlay.rating === null ? held.rating : ratingFromRail(overlay.rating);
  const next = new Map(summaries);
  next.set(id, {
    ...held,
    status,
    tone: railStatusTone(status),
    rating,
  });
  return next;
}

/**
 * The conversation-list fallback, when `/api/runs` never described the row.
 *
 * Rating stays off this list: it is one reader's opinion and that route does
 * not know whose it is.
 */
export function applyRunLabelOverrideToConversations(
  conversations: readonly Conversation[],
  conversationId: string,
  overlay: RunLabelOverride | null | undefined
): Conversation[] {
  const id = conversationId.trim();
  if (!overlay?.status || !id) return [...conversations];
  return conversations.map((row) => (row.id === id ? { ...row, status: overlay.status } : row));
}

const rememberedOverlays = new Map<string, RunLabelOverride>();
const overlayListeners = new Set<(conversationId: string, overlay: RunLabelOverride) => void>();

/**
 * Remember a saved overlay so Ask can apply it without waiting for a new turn.
 *
 * HomePage unmounts when Run Explorer opens, so a `useState` map there cannot
 * hear the save. This is the cache that can: keyed by conversation, merged so
 * a later rating edit does not forget the outcome just written.
 */
export function rememberRunLabelOverride(
  conversationId: string,
  overlay: RunLabelOverride
): RunLabelOverride {
  const id = conversationId.trim();
  const next = { ...(rememberedOverlays.get(id) ?? {}), ...overlay };
  if (!id) return next;
  rememberedOverlays.set(id, next);
  for (const listener of overlayListeners) listener(id, next);
  return next;
}

/** Ask subscribes so a save on Run Explorer can rewrite the rail it already drew. */
export function subscribeRunLabelOverrides(
  listener: (conversationId: string, overlay: RunLabelOverride) => void
): () => void {
  overlayListeners.add(listener);
  return () => overlayListeners.delete(listener);
}

export function applyRememberedRunLabelOverrides(
  summaries: Map<string, RailRunSummary>
): Map<string, RailRunSummary> {
  let next = summaries;
  for (const [id, overlay] of rememberedOverlays) {
    next = applyRunLabelOverrideToSummaries(next, id, overlay);
  }
  return next;
}

export function applyRememberedRunLabelOverridesToConversations(
  conversations: readonly Conversation[]
): Conversation[] {
  let next = [...conversations];
  for (const [id, overlay] of rememberedOverlays) {
    next = applyRunLabelOverrideToConversations(next, id, overlay);
  }
  return next;
}

/** Test isolation. Live use never forgets a save the administrator just made. */
export function forgetRunLabelOverrides(): void {
  rememberedOverlays.clear();
  overlayListeners.clear();
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
    throw new Error(RUN_LABELS_NOT_SAVED);
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
