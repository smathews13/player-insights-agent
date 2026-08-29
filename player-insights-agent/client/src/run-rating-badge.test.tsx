import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RunHeader } from './RunHeader';
import { RunListItem } from './RunExplorer';
import { RunRatingBadge } from './RunRatingBadge';
import { runRatingDirection } from './run-rating';
import type { Run } from './app-types';

function run(rating: number | null): Run {
  return {
    id: 'msg-rating',
    prompt: 'Which titles gained active players?',
    stakeholder: 'reader@example.com',
    status: 'complete',
    duration_ms: 1200,
    tool_calls: 2,
    rating,
    created_at: '2026-08-28T12:00:00Z',
  };
}

function list(rating: number | null): string {
  return renderToStaticMarkup(<RunListItem run={run(rating)} active={false} onSelect={() => undefined} />);
}

function header(rating: number | null): string {
  return renderToStaticMarkup(<RunHeader run={run(rating)} toolCalls={2} reference={false} groundedness={null} />);
}

describe('Run Explorer stored feedback direction', () => {
  it('shows the answer control’s positive thumb and accessible name', () => {
    const markup = list(5);
    expect(runRatingDirection(5)).toBe('up');
    expect(markup).toContain('lucide-thumbs-up');
    expect(markup).toContain('aria-label="Rated helpful"');
    expect(markup).toContain('title="Rated helpful"');
    expect(markup).toContain('run-rating-badge--up');
  });

  it('shows the answer control’s negative thumb and accessible name', () => {
    const markup = header(2);
    expect(runRatingDirection(2)).toBe('down');
    expect(markup).toContain('lucide-thumbs-down');
    expect(markup).toContain('aria-label="Rated not helpful"');
    expect(markup).toContain('title="Rated not helpful"');
    expect(markup).toContain('run-rating-badge--down');
  });

  it('omits an unrated list badge and keeps the useful header state', () => {
    expect(list(null)).not.toContain('run-rating-badge');
    expect(header(null)).toContain('Not rated');
    expect(runRatingDirection(null)).toBe('none');
  });

  it('keeps a valid legacy midpoint neutral instead of guessing a direction', () => {
    const markup = renderToStaticMarkup(<RunRatingBadge rating={3} />);
    expect(runRatingDirection(3)).toBe('unknown');
    expect(markup).toContain('lucide-thumbs-up');
    expect(markup).toContain('lucide-thumbs-down');
    expect(markup).toContain('aria-label="Rated, direction unknown"');
    expect(markup).toContain('run-rating-badge--unknown');
  });

  it('contains no generic Rated badge in cards or header metadata', () => {
    for (const markup of [list(5), list(2), header(5), header(2), header(3)]) {
      expect(markup).not.toMatch(/>Rated<\/span>/);
      expect(markup).not.toMatch(/>Rated<\/div>/);
      expect(markup).not.toMatch(/>Rated</);
    }
  });
});
