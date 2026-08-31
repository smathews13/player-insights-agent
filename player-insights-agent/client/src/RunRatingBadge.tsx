import { ThumbsDown, ThumbsUp } from 'lucide-react';

import { runRatingDirection } from './run-rating';
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
  rating,
  showUnrated = false,
  display = 'compact',
}: {
  rating: number | null | undefined;
  showUnrated?: boolean;
  display?: 'compact' | 'kpi';
}) {
  const direction = runRatingDirection(rating);
  const kpi = display === 'kpi';
  if (direction === 'none') {
    return showUnrated ? (
      <Badge
        variant="outline"
        className={`run-rating-badge run-rating-badge--none${kpi ? ' run-rating-badge--kpi' : ''}`}
        aria-label={kpi ? 'User feedback: Not rated' : 'Not rated'}
        title="No user feedback submitted"
      >
        <span aria-hidden={kpi || undefined}>Not rated</span>
        {kpi ? <span className="sr-only">User feedback: Not rated</span> : null}
      </Badge>
    ) : null;
  }

  if (direction === 'up') {
    return (
      <Badge
        variant="outline"
        className={`run-rating-badge run-rating-badge--up${kpi ? ' run-rating-badge--kpi' : ''}`}
        aria-label={kpi ? 'User feedback: Positive' : 'Rated helpful'}
        title={kpi ? 'Positive user feedback' : 'Rated helpful'}
      >
        <ThumbsUp aria-hidden="true" />
        {kpi ? (
          <span className="run-rating-badge-label" aria-hidden="true">
            Positive
          </span>
        ) : null}
        <span className="sr-only">{kpi ? 'User feedback: Positive' : 'Rated helpful'}</span>
      </Badge>
    );
  }

  if (direction === 'down') {
    return (
      <Badge
        variant="outline"
        className={`run-rating-badge run-rating-badge--down${kpi ? ' run-rating-badge--kpi' : ''}`}
        aria-label={kpi ? 'User feedback: Negative' : 'Rated not helpful'}
        title={kpi ? 'Negative user feedback' : 'Rated not helpful'}
      >
        <ThumbsDown aria-hidden="true" />
        {kpi ? (
          <span className="run-rating-badge-label" aria-hidden="true">
            Negative
          </span>
        ) : null}
        <span className="sr-only">{kpi ? 'User feedback: Negative' : 'Rated not helpful'}</span>
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className={`run-rating-badge run-rating-badge--unknown${kpi ? ' run-rating-badge--kpi' : ''}`}
      aria-label={kpi ? 'User feedback: Direction unknown' : 'Rated, direction unknown'}
      title={kpi ? 'User feedback direction is unknown' : 'Rated, direction unknown'}
    >
      <span className="run-rating-unknown-icons" aria-hidden="true">
        <ThumbsUp />
        <ThumbsDown />
      </span>
      {kpi ? (
        <span className="run-rating-badge-label" aria-hidden="true">
          Direction unknown
        </span>
      ) : null}
      <span className="sr-only">{kpi ? 'User feedback: Direction unknown' : 'Rated, direction unknown'}</span>
    </Badge>
  );
}
