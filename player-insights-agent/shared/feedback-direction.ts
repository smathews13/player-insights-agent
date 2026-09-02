/** Canonical human answer feedback stored and exposed by the app. */
export type FeedbackDirection = 'up' | 'down';

/**
 * Resolve feedback with explicit sentiment as the authority and legacy
 * usefulness as a read-only fallback.
 *
 * Historical 4/5 rows mean Helpful and 1/2 rows mean Not helpful. A neutral 3,
 * an invalid value, and an absent value remain No feedback.
 */
export function feedbackDirection(sentiment: unknown, legacyUsefulness?: unknown): FeedbackDirection | null {
  const word = typeof sentiment === 'string' ? sentiment.trim().toLowerCase() : '';
  if (word === 'up' || word === 'down') return word;

  const usefulness =
    typeof legacyUsefulness === 'string'
      ? Number(legacyUsefulness)
      : typeof legacyUsefulness === 'number'
        ? legacyUsefulness
        : Number.NaN;
  if (!Number.isFinite(usefulness)) return null;
  if (usefulness >= 4 && usefulness <= 5) return 'up';
  if (usefulness >= 1 && usefulness <= 2) return 'down';
  return null;
}

export function feedbackLabel(direction: FeedbackDirection | null): string {
  if (direction === 'up') return 'Helpful';
  if (direction === 'down') return 'Not helpful';
  return 'No feedback';
}
