import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { AnswerCard } from './AnswerCard';
import type { TraceSummary } from './answer-shape';
import type { Answer, FeedbackEntry } from './app-types';

const CSS = readFileSync(new URL('./styles/answer-body.css', import.meta.url), 'utf8');
const CARD = readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8');

const TRACE: TraceSummary = {
  id: 'tr-deadbeef',
  totalMs: 32_280,
  toolCalls: 1,
  prompt_tokens: 80_000,
  completion_tokens: 4_576,
  total_tokens: 84_576,
  stages: [
    {
      id: 'step-1',
      name: 'Chose the next step',
      kind: 'agent',
      start: 0,
      startMeasured: true,
      duration: 1_000,
      status: 'complete',
      calls: 1,
      input: '',
      output: '',
      token_usage: {
        inputTokens: 80_000,
        outputTokens: 4_576,
        totalTokens: 84_576,
        cachedReadTokens: 20_000,
        cacheWriteTokens: 200,
        cacheStatus: 'used',
        attempts: 2,
        totalMismatch: false,
      },
    },
    {
      id: 'step-1-1-run_sql',
      name: 'Ran SQL',
      kind: 'tool',
      start: 1_000,
      startMeasured: true,
      duration: 800,
      status: 'complete',
      calls: 1,
      input: '',
      output: '',
    },
  ],
  token_reconciliation: {
    attributedTokens: 84_576,
    attributedCalls: 2,
    overviewTokens: 84_576,
    coveragePercent: 100,
    nestedAggregateTokens: 0,
    mismatchCount: 0,
    cachedReadTokens: 20_000,
    cacheCoveredInputTokens: 80_000,
    cacheHitPercent: 25,
  },
};

const ANSWER = {
  type: 'answer',
  mode: 'live',
  provenance: 'live',
  takeaway: 'The answer stays primary.',
  narrative: 'The process remains supporting evidence.',
  figures: [],
  sources: [],
  caveats: [],
  document_snippets: [],
  sql: '',
  trace: TRACE,
} as unknown as Answer;

const EMPTY_FEEDBACK: FeedbackEntry = {
  open: false,
  comment: '',
  saved: false,
  saving: false,
  error: null,
  sentiment: null,
};

function render(
  feedback: FeedbackEntry = EMPTY_FEEDBACK,
  trace: TraceSummary = TRACE,
  defaultRunProcessOpen = true
): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AnswerCard
        answer={{ ...ANSWER, trace }}
        question="What happened?"
        feedback={feedback}
        onFeedbackChange={() => {}}
        saveFeedback={async () => {}}
        showFeedback
        defaultRunProcessOpen={defaultRunProcessOpen}
      />
    </MemoryRouter>
  );
}

describe('AnswerCard Run process shared KPIs', () => {
  it('renders the exact five shared measurements and token-aware timeline', () => {
    const markup = render({ ...EMPTY_FEEDBACK, saved: true, sentiment: 'up' });

    for (const label of ['Wall time', 'Tool-stage time', 'Agent tool calls', 'LLM tokens', 'User feedback']) {
      expect(markup).toContain(`>${label}<`);
    }
    expect(markup).toContain('>32.28s<');
    expect(markup).toContain('Question to final answer');
    expect(markup).toContain('>0.8s<');
    expect(markup).toContain('Time spent in agent and tool stages');
    expect(markup).toContain('1 call across 1 tool');
    expect(markup).toContain('>84,576<');
    expect(markup).toContain('80,000 in / 4,576 out · 20,000 cached (25.0% of covered input)');
    expect(markup).toContain('>Helpful</span>');
    expect(markup).toContain('Submitted by the asker');
    expect(markup).toContain('>Tokens</th>');
    expect(markup).toContain('trace-num trace-tokens ast-num">84,576</td>');
    expect(markup).not.toContain('trace-token-rollup');
    expect(markup).not.toContain('Give feedback');
    expect(CARD).toContain('<RunOverviewKpis');
    expect(CARD).toContain('toolStageDurationMs(processTrace.stages, processDurationMs)');
    expect(CARD).toContain('tokenReconciliation={processTrace.token_reconciliation}');
    expect(CARD).toContain('tokenized');
    expect(CARD).toContain('showTokenRollup={false}');
  });

  it('keeps missing evidence absent and explicit recorded zeroes visible', () => {
    const missing = render(EMPTY_FEEDBACK, {
      ...TRACE,
      totalMs: undefined as unknown as number,
      toolCalls: undefined as unknown as number,
      total_tokens: undefined,
      prompt_tokens: undefined,
      completion_tokens: undefined,
      token_reconciliation: undefined,
      stages: [],
    });
    expect(missing.match(/>Not recorded</g)).toHaveLength(4);
    expect(missing).toContain('No feedback');

    const zero = render(EMPTY_FEEDBACK, {
      ...TRACE,
      totalMs: 0,
      toolCalls: 0,
      total_tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      token_reconciliation: undefined,
      stages: [{ ...TRACE.stages[1], duration: 0, calls: 0 }],
    });
    expect(zero).toContain('>0.00ms<');
    expect(zero).toContain('>0.0s<');
    expect(zero).toContain('0 in / 0 out');
    expect(zero).not.toContain('Token usage not recorded');
  });

  it('uses legacy feedback only as fallback and reflects canonical live updates', () => {
    const legacy = render({ ...EMPTY_FEEDBACK, usefulness: 4 });
    expect(legacy).toContain('>Helpful</span>');

    const before = render(EMPTY_FEEDBACK);
    const after = render({ ...EMPTY_FEEDBACK, saved: true, sentiment: 'down' });
    expect(before).toContain('>No feedback</span>');
    expect(after).toContain('>Not helpful</span>');
    expect(after).not.toContain('>Helpful</span>');
  });

  it('keeps collapsed process content out of the rendered and focusable tree', () => {
    const markup = render(EMPTY_FEEDBACK, TRACE, false);
    expect(markup).toContain('View process');
    expect(markup).not.toContain('Wall time');
    expect(markup).not.toContain('Step timeline');
    expect(markup).not.toContain('trace-gantt-row');
  });

  it('uses a 3/2/1 compact grid without adding a nested scroll owner', () => {
    expect(CSS).toMatch(/\.run-process \.run-kpi-grid--compact\s*\{[^}]*repeat\(3, minmax\(0, 1fr\)\)/s);
    expect(CSS).toMatch(/@container run-process \(max-width: 680px\)[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(CSS).toMatch(/@container run-process \(max-width: 420px\)[\s\S]*grid-template-columns: 1fr/);
    const body = CSS.match(/\.run-process-body\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(body).toContain('overflow: visible');
    expect(body).not.toMatch(/overflow-[xy]:\s*(auto|scroll)|max-height/);
  });
});
