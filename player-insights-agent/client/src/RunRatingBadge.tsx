import { ThumbsDown, ThumbsUp } from 'lucide-react';

import { runFeedbackDirection } from './run-rating';
import { Badge } from './ui';

/**
 * The Run Explorer's compact reading of stored answer feedback.
 *
 * The same Lucide thumbs and positive/negative token families as the answer
 * feedback controls keep the direction intact. The exact meaning is also the
 * accessible name and native tooltip, so neither icon nor colour has to carry
 * the state by itself.
 */
export function RunRatingBadge({
  feedback,
  legacyUsefulness,
  showNoFeedback = false,
  display = 'compact',
}: {
  feedback: 'up' | 'down' | null | undefined;
  legacyUsefulness?: number | null;
  showNoFeedback?: boolean;
  display?: 'compact' | 'kpi';
}) {
  const direction = runFeedbackDirection(feedback, legacyUsefulness);
  const kpi = display === 'kpi';
  if (direction === 'none') {
    return showNoFeedback ? (
      <Badge
        variant="outline"
        className={`run-rating-badge run-rating-badge--none${kpi ? ' run-rating-badge--kpi' : ''}`}
        aria-label="No feedback"
        title="No feedback"
      >
        <span>No feedback</span>
      </Badge>
    ) : null;
  }

  if (direction === 'up') {
    return (
      <Badge
        variant="outline"
        className={`run-rating-badge run-rating-badge--up${kpi ? ' run-rating-badge--kpi' : ''}`}
        aria-label="Helpful"
        title="Helpful"
      >
        <ThumbsUp aria-hidden="true" />
        {kpi ? (
          <span className="run-rating-badge-label" aria-hidden="true">
            Helpful
          </span>
        ) : null}
        <span className="sr-only">Helpful</span>
      </Badge>
    );
  }

  if (direction === 'down') {
    return (
      <Badge
        variant="outline"
        className={`run-rating-badge run-rating-badge--down${kpi ? ' run-rating-badge--kpi' : ''}`}
        aria-label="Not helpful"
        title="Not helpful"
      >
        <ThumbsDown aria-hidden="true" />
        {kpi ? (
          <span className="run-rating-badge-label" aria-hidden="true">
            Not helpful
          </span>
        ) : null}
        <span className="sr-only">Not helpful</span>
      </Badge>
    );
  }
  return null;
}
