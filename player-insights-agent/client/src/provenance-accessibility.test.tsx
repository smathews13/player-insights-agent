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

describe('figure accessibility', () => {
  it('renders the comparison beside its KPI value', () => {
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
    expect(markup).toContain(comparison);
    expect(markup).toContain('answer-kpi-comparison');
    expect(markup).not.toContain('answer-stat');
    expect(markup).toContain('Key figures');
  });

  it('removes figure-card-only CSS without removing shared focus styling', () => {
    const css = readFileSync(new URL('./styles/answer-body.css', import.meta.url), 'utf8');
    expect(css).not.toContain('.answer-stat-context');
    expect(css).toMatch(/\.provenance-detail:focus-visible\s*\{[^}]*outline:\s*2px solid/s);
  });

  it('fits KPI context badges to their tile and uses the report information blue', () => {
    const css = readFileSync(new URL('./styles/answer-body.css', import.meta.url), 'utf8');
    const badge = css.match(/\.answer-kpi-comparison\s*\{([^}]*)\}/s)?.[1] ?? '';

    expect(badge).toMatch(/box-sizing:\s*border-box/);
    expect(badge).toMatch(/width:\s*100%/);
    expect(badge).toMatch(/color:\s*var\(--ast-info-text\)/);
    expect(badge).toMatch(/background:\s*var\(--ast-info-fill\)/);
    expect(badge).not.toContain('--ast-pos-');
  });
});
