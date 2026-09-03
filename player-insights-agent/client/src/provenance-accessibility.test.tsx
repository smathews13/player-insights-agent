import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnswerCard } from './AnswerCard';
import { SourcesModule } from './SourcesModule';
import { normalizeAnswer, type WireAnswer } from './answer-shape';
import type { Answer, FeedbackEntry } from './app-types';

const feedback: FeedbackEntry = {
  open: false,
  comment: '',
  saved: false,
  saving: false,
  error: null,
  usefulness: null,
};

describe('source freshness provenance', () => {
  it('renders freshness as visible, focusable text instead of tooltip-only content', () => {
    const freshness = 'Updated daily after the 06:00 UTC pipeline';
    const markup = renderToStaticMarkup(
      <SourcesModule sources={[{ name: 'main.analytics.player_daily', freshness, role: 'reading' }]} caveats={[]} />
    );

    expect(markup).toContain(freshness);
    expect(markup).toContain('class="source-list-freshness provenance-detail"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain(`aria-label="Freshness: ${freshness}`);
    expect(markup).not.toContain(`title="main.analytics.player_daily · ${freshness}"`);
    expect(readFileSync(new URL('./SourcesModule.tsx', import.meta.url), 'utf8')).toContain('workspaceLink(row.name)');
  });
});

describe('legacy figure compatibility', () => {
  it('keeps figure comparison data without rendering the retired KPI rail', () => {
    const comparison = '+12% against the previous 28-day retained-player baseline';
    const raw = {
      id: 'answer-1',
      mode: 'live',
      provenance: 'live',
      takeaway: 'Retention improved.',
      narrative: 'The current cohort retained more players.',
      figures: [{ label: 'Retention', value: 0.62, display: '62%', comparison }],
      sources: [],
      caveats: [],
      sql: 'SELECT 1',
    } as WireAnswer;
    const markup = renderToStaticMarkup(
      <AnswerCard
        answer={normalizeAnswer(raw) as Answer}
        feedback={feedback}
        onFeedbackChange={() => {}}
        saveFeedback={async () => {}}
        showFeedback={false}
        showRunProcess={false}
      />
    );

    expect(normalizeAnswer(raw).figures[0]?.comparison).toBe(comparison);
    expect(markup).not.toContain(comparison);
    expect(markup).not.toContain('answer-stat');
    expect(markup).not.toContain('Key figures');
  });

  it('removes figure-card-only CSS without removing shared focus styling', () => {
    const css = readFileSync(new URL('./styles/answer-body.css', import.meta.url), 'utf8');
    expect(css).not.toContain('.answer-stat-context');
    expect(css).toMatch(/\.provenance-detail:focus-visible\s*\{[^}]*outline:\s*2px solid/s);
  });
});
