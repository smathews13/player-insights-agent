import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import type { ComponentProps } from 'react';
import { describe, expect, it } from 'vitest';

import type { TraceStage } from './answer-shape';
import { agentToolCallSubtitle } from './run-overview-kpis';
import { RunOverviewKpis } from './RunOverviewKpis';

const EXPLORER = readFileSync(new URL('./RunExplorer.tsx', import.meta.url), 'utf8');
const KPI_SOURCE = readFileSync(new URL('./RunOverviewKpis.tsx', import.meta.url), 'utf8');
const ANSWER = readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8');
const MONITORING = readFileSync(new URL('./MonitoringPage.tsx', import.meta.url), 'utf8');

function stage(id: string): TraceStage {
  return {
    id,
    name: id,
    kind: 'tool',
    start: 0,
    duration: 100,
    status: 'complete',
    calls: 1,
    input: '',
    output: '',
  };
}

const STAGES = [stage('step-1-1-data_genie'), stage('step-2-1-data_genie'), stage('step-3-1-run_sql'), stage('plot')];

function render(feedback: 'up' | 'down' | null, overrides: Partial<ComponentProps<typeof RunOverviewKpis>> = {}) {
  return renderToStaticMarkup(
    <RunOverviewKpis
      durationMs={15_670}
      toolStageMs={10_700}
      agentToolCalls={7}
      stages={STAGES}
      totalTokens={10_273}
      promptTokens={9633}
      completionTokens={640}
      feedback={feedback}
      {...overrides}
    />
  );
}

describe('Run Explorer Overview KPIs', () => {
  it('renders positive feedback as a large directional value with accessible text', () => {
    const markup = render('up');
    expect(markup).toContain('run-rating-badge--up run-rating-badge--kpi');
    expect(markup).toContain('lucide-thumbs-up');
    expect(markup).toContain('aria-label="Helpful"');
    expect(markup).toContain('title="Helpful"');
    expect(markup).toContain('>Helpful</span>');
    expect(markup).toContain('Submitted by the asker');
  });

  it('renders negative feedback without losing its direction or colour family', () => {
    const markup = render('down');
    expect(markup).toContain('run-rating-badge--down run-rating-badge--kpi');
    expect(markup).toContain('lucide-thumbs-down');
    expect(markup).toContain('aria-label="Not helpful"');
    expect(markup).toContain('title="Not helpful"');
    expect(markup).toContain('>Not helpful</span>');
    expect(markup).toContain('Submitted by the asker');
  });

  it('keeps an unrated read-only host neutral without offering a broken action', () => {
    const markup = render(null);
    expect(markup).toContain('run-rating-badge--none run-rating-badge--kpi');
    expect(markup).toContain('aria-label="No feedback"');
    expect(markup).toContain('title="No feedback"');
    expect(markup).toContain('No feedback');
    expect(markup).not.toContain('Give feedback');
    expect(markup).not.toContain('Submitted by the asker');
    expect(markup).not.toContain('lucide-thumbs-up');
  });

  it('renders compact canonical thumbs without duplicating the no-feedback subtitle', () => {
    const markup = render(null, {
      feedbackControls: {
        saving: false,
        saved: false,
        open: false,
        comment: '',
        error: null,
        onDirection: () => undefined,
        onCommentChange: () => undefined,
        onSaveComment: () => undefined,
      },
      feedbackAttribution: 'you',
    });
    expect(markup).toContain('aria-label="Mark answer helpful"');
    expect(markup).toContain('aria-label="Mark answer not helpful"');
    expect(markup).toContain('aria-label="Rate this answer"');
    expect(markup).not.toContain('Give feedback');
    expect(markup).not.toContain('run-kpi-subtitle">No feedback');
  });

  it('keeps a negative comment editable with saving and retry evidence', () => {
    const markup = render('down', {
      feedbackControls: {
        saving: false,
        saved: false,
        open: true,
        comment: 'Missing comparison.',
        error: 'Feedback was not recorded.',
        onDirection: () => undefined,
        onCommentChange: () => undefined,
        onSaveComment: () => undefined,
      },
      feedbackAttribution: 'you',
    });
    expect(markup).toContain('value="Missing comparison."');
    expect(markup).toContain('placeholder="What could be better?"');
    expect(markup).toContain('Save feedback');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Feedback was not recorded.');
    expect(KPI_SOURCE).toContain('feedbackInputRef.current?.focus()');
  });

  it('disables both choices while the canonical write is pending', () => {
    const markup = render(null, {
      feedbackControls: {
        saving: true,
        saved: false,
        open: false,
        comment: '',
        error: null,
        onDirection: () => undefined,
        onCommentChange: () => undefined,
        onSaveComment: () => undefined,
      },
    });
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).toContain('pia-loader-mark--inline');
    expect(markup).toContain('Saving feedback');
  });

  it('keeps existing feedback read-only and attributes Run Explorer feedback to this viewer', () => {
    const existing = render('up', {
      feedbackControls: {
        saving: false,
        saved: false,
        open: false,
        comment: '',
        error: null,
        onDirection: () => undefined,
        onCommentChange: () => undefined,
        onSaveComment: () => undefined,
      },
      feedbackAttribution: 'you',
    });
    expect(existing).toContain('Submitted by you');
    expect(existing).not.toContain('Mark answer helpful');
    expect(EXPLORER).toContain('const feedbackTarget = selected && validRunId(selected.id) ? selected.id : null');
    expect(EXPLORER).toContain('feedbackAttribution="you"');
    expect(EXPLORER).toContain('run.id === targetId ? { ...run, feedback: direction } : run');
    expect(ANSWER).not.toContain('feedbackControls=');
    expect(MONITORING).not.toContain('feedbackControls=');
  });

  it('uses only recorded tool identities for the dynamic call breakdown', () => {
    expect(agentToolCallSubtitle(4, STAGES)).toBe('4 calls across 3 tools');
    expect(agentToolCallSubtitle(1, [stage('step-1-1-run_sql')])).toBe('1 call across 1 tool');
    expect(agentToolCallSubtitle(7, STAGES)).toBe('Governed tool invocations');
    expect(agentToolCallSubtitle(7, [])).toBe('Governed tool invocations');
    expect(agentToolCallSubtitle(null, STAGES)).toBe('Governed tool invocations');
    expect(render('up', { agentToolCalls: 4 })).toContain('4 calls across 3 tools');
  });

  it('keeps the metered token split as the subtitle', () => {
    const markup = render('up');
    expect(markup).toContain('10,273');
    expect(markup).toContain('9,633 in / 640 out');
    expect(markup).toContain('run-kpi-subtitle tile-mono ast-num');
  });

  it('adds a cache summary only when direct calls reported cache evidence', () => {
    const markup = render('up', {
      tokenReconciliation: {
        attributedTokens: 5_000,
        attributedCalls: 2,
        overviewTokens: 10_273,
        coveragePercent: 48.7,
        unattributedTokens: 5_273,
        nestedAggregateTokens: 5_000,
        mismatchCount: 0,
        cachedReadTokens: 3_100,
        cacheCoveredInputTokens: 6_200,
        cacheHitPercent: 50,
      },
    });
    expect(markup).toContain('3,100 cached (50.0% of covered input)');
    expect(render('up')).not.toContain('cached');
  });

  it('labels missing measurements as absent and still describes every card', () => {
    const markup = render(null, {
      durationMs: null,
      toolStageMs: null,
      agentToolCalls: null,
      stages: [],
      totalTokens: null,
      promptTokens: null,
      completionTokens: null,
    });
    expect(markup.match(/>Not recorded</g)).toHaveLength(4);
    expect(markup).toContain('Question to final answer');
    expect(markup).toContain('Time spent in agent and tool stages');
    expect(markup).toContain('Governed tool invocations');
    expect(markup).toContain('Token usage not recorded');
    expect(markup).toContain('No feedback');
    expect(markup.match(/run-kpi-subtitle/g)).toHaveLength(4);
  });

  it('keeps recorded zeroes instead of turning them into missing evidence', () => {
    const markup = render('up', {
      durationMs: 0,
      toolStageMs: 0,
      agentToolCalls: 0,
      stages: [],
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(markup).toContain('>0.00ms<');
    expect(markup).toContain('>0.0s<');
    expect(markup.match(/>0</g)).toHaveLength(2);
    expect(markup).toContain('0 in / 0 out');
    expect(markup).not.toContain('Not recorded');
  });
});
