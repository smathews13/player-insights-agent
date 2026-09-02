import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RunListItem } from './RunExplorer';
import { RunRatingBadge } from './RunRatingBadge';
import type { Run } from './app-types';

function run(feedback: 'up' | 'down' | null): Run {
  return {
    id: 'msg-feedback',
    prompt: 'Which titles gained active players?',
    stakeholder: 'reader@example.com',
    status: 'complete',
    duration_ms: 1200,
    tool_calls: 2,
    feedback,
    created_at: '2026-08-28T12:00:00Z',
  };
}

describe('Run Explorer feedback direction', () => {
  it('shows Helpful and Not helpful with accessible thumbs', () => {
    const up = renderToStaticMarkup(<RunListItem run={run('up')} active={false} onSelect={() => undefined} />);
    const down = renderToStaticMarkup(<RunRatingBadge feedback="down" />);
    expect(up).toContain('lucide-thumbs-up');
    expect(up).toContain('aria-label="Helpful"');
    expect(down).toContain('lucide-thumbs-down');
    expect(down).toContain('aria-label="Not helpful"');
  });

  it('omits absent compact feedback and names explicit empty state', () => {
    expect(renderToStaticMarkup(<RunRatingBadge feedback={null} />)).toBe('');
    expect(renderToStaticMarkup(<RunRatingBadge feedback={null} showNoFeedback />)).toContain('No feedback');
  });

  it('contains no numeric or star metaphor', () => {
    const markup = ['up', 'down', null].map((value) =>
      renderToStaticMarkup(<RunRatingBadge feedback={value as 'up' | 'down' | null} showNoFeedback />)
    );
    const visible = markup.join('').replace(/<[^>]+>/g, ' ');
    expect(visible).not.toMatch(/★|⭐|\/5|of 5|Rated/i);
  });
});
