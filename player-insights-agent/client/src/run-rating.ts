import { feedbackDirection } from '../../shared/feedback-direction';

export type RunFeedbackDirection = 'up' | 'down' | 'none';

/** Canonical direction used by every Run Explorer feedback surface. */
export function runFeedbackDirection(sentiment: unknown, legacyUsefulness?: unknown): RunFeedbackDirection {
  return feedbackDirection(sentiment, legacyUsefulness) ?? 'none';
}
