import { ratedThumb } from './stored-feedback';

export type RunRatingDirection = 'up' | 'down' | 'unknown' | 'none';

/**
 * A stored five-point value as the feedback control that produced it.
 *
 * Five and two are the values written by the answer card's two thumbs. Three is
 * valid legacy data, but it was not produced by either control, so it stays
 * unknown rather than being rounded into praise or criticism.
 */
export function runRatingDirection(rating: number | null | undefined): RunRatingDirection {
  if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 1 || rating > 5) return 'none';
  return ratedThumb(rating) ?? 'unknown';
}
