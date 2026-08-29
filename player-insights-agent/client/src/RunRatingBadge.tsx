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
}: {
  rating: number | null | undefined;
  showUnrated?: boolean;
}) {
  const direction = runRatingDirection(rating);
  if (direction === 'none') {
    return showUnrated ? (
      <Badge variant="outline" className="run-rating-badge run-rating-badge--none">
        Not rated
      </Badge>
    ) : null;
  }

  if (direction === 'up') {
    return (
      <Badge
        variant="outline"
        className="run-rating-badge run-rating-badge--up"
        aria-label="Rated helpful"
        title="Rated helpful"
      >
        <ThumbsUp aria-hidden="true" />
        <span className="sr-only">Rated helpful</span>
      </Badge>
    );
  }

  if (direction === 'down') {
    return (
      <Badge
        variant="outline"
        className="run-rating-badge run-rating-badge--down"
        aria-label="Rated not helpful"
        title="Rated not helpful"
      >
        <ThumbsDown aria-hidden="true" />
        <span className="sr-only">Rated not helpful</span>
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="run-rating-badge run-rating-badge--unknown"
      aria-label="Rated, direction unknown"
      title="Rated, direction unknown"
    >
      <span className="run-rating-unknown-icons" aria-hidden="true">
        <ThumbsUp />
        <ThumbsDown />
      </span>
      <span className="sr-only">Rated, direction unknown</span>
    </Badge>
  );
}
