import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { QuestionDrawer, QuestionList } from './MonitoringPage';
import type { MonitoringDetail, MonitoringQuestion } from '../../shared/monitoring-contract';

const MONITORING_CSS = readFileSync(new URL('./styles/monitoring.css', import.meta.url), 'utf8');
const SHELL_CSS = readFileSync(new URL('./styles/shell.css', import.meta.url), 'utf8');

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

function question(totalTokens: number | null): MonitoringQuestion {
  return {
    id: 'q1',
    conversationId: 'c1',
    question: 'Compare active players by title over the last 30 days',
    askedBy: 'first.person@example.test',
    askedAt: '2026-08-15T10:00:00Z',
    outcome: 'completed',
    outcomeDetail: null,
    durationMs: 76_200,
    totalTokens,
    toolCalls: 5,
    feedback: 'up',
    tables: [],
  };
}

function detail(askedBy = 'first.person@example.test'): MonitoringDetail {
  const trace = {
    id: 'tr-1234567890abcdef1234567890abcdef',
    totalMs: 1_000,
    toolCalls: 0,
    prompt_tokens: 80_000,
    completion_tokens: 4_576,
    total_tokens: 84_576,
    stages: [
      {
        id: 'step-1',
        name: 'Chose the next step',
        kind: 'agent',
        status: 'complete',
        start: 0,
        duration: 1_000,
        calls: 1,
        input: '',
        output: '',
        token_usage: {
          inputTokens: 80_000,
          outputTokens: 4_576,
          totalTokens: 84_576,
          cacheStatus: 'unavailable',
          attempts: 1,
          totalMismatch: false,
        },
      },
    ],
  };
  return {
    id: 'q1',
    conversationId: 'c1',
    question: 'Which countries grew fastest this quarter?',
    askedBy,
    askedAt: '2026-08-15T06:40:00Z',
    outcome: 'completed',
    outcomeDetail: null,
    outcomeCode: null,
    answer: {
      type: 'answer',
      mode: 'live',
      takeaway: 'The leading title is ahead.',
      narrative: 'A narrative sentence.',
      figures: [],
      sources: [],
      caveats: [],
      sql: '',
      trace,
    },
    conditioning: null,
    trace,
    tokens: { prompt: 80_000, completion: 4_576, total: 84_576 },
    execution: null,
    feedback: null,
    comment: null,
    mlflowUrl: 'https://example.test/ml/experiments/1/traces',
    runId: 'a1',
  };
}

describe('Monitoring question token totals', () => {
  it('orders Time, Total tokens, Tools, Feedback and preserves exact evidence', () => {
    const markup = render(<QuestionList questions={[question(84_576)]} selectedId="" now={0} onOpen={() => {}} />);
    expect(markup.indexOf('>Time<')).toBeLessThan(markup.indexOf('>Total tokens<'));
    expect(markup.indexOf('>Total tokens<')).toBeLessThan(markup.indexOf('>Tools<'));
    expect(markup.indexOf('>Tools<')).toBeLessThan(markup.indexOf('>Feedback<'));
    expect(markup).toContain('>84.6K</span>');
    expect(markup).toContain('title="84,576 total tokens"');
    expect(markup).toContain('aria-label="84,576 total tokens"');
  });

  it('distinguishes explicit zero from unavailable evidence in desktop and compact cards', () => {
    const zero = render(<QuestionList questions={[question(0)]} selectedId="" now={0} onOpen={() => {}} />);
    const legacy = render(
      <QuestionList questions={[question(null)]} selectedId="" now={0} onOpen={() => {}} compact />
    );
    expect(zero).toContain('aria-label="0 total tokens">0');
    expect(legacy).toContain('Total tokens');
    expect(legacy).toContain('aria-label="Total tokens not reported">—');
    expect(legacy).not.toContain('<table');
  });

  it('bounds the new column and keeps compact values tabular', () => {
    expect(MONITORING_CSS).toMatch(/\.monitoring-col-tokens\s*\{[^}]*width:\s*94px/s);
    expect(MONITORING_CSS).toMatch(/\.monitoring-token-total\s*\{[^}]*white-space:\s*nowrap/s);
    expect(MONITORING_CSS).toContain('font-variant-numeric: tabular-nums');
  });
});

describe('Monitoring answer timeline and links', () => {
  it('uses the shared tokenized timeline without a duplicate total note', () => {
    const markup = render(<QuestionDrawer detail={detail()} onClose={() => {}} canOpenUser />);
    expect(markup).toContain('trace-timeline--monitoring');
    expect(markup).toContain('>Tokens</th>');
    expect(markup).toContain('trace-num trace-tokens ast-num">84,576</td>');
    expect(markup.split('84,576 total tokens')).toHaveLength(2);
    expect(markup).not.toContain('monitoring-drawer-tokens');
  });

  it('puts hidden trailing arrows on both trace links and the clickable user badge', () => {
    const markup = render(<QuestionDrawer detail={detail()} onClose={() => {}} canOpenUser />);
    expect(markup.match(/monitoring-link-arrow size-3\.5/g)).toHaveLength(2);
    expect(markup.match(/lucide-arrow-up-right[^>]*aria-hidden="true"/g)).toHaveLength(3);
    expect(markup).toMatch(/lucide-user-round[\s\S]*first\.person[\s\S]*identity-chip-link-arrow/);
    expect(markup).not.toContain('↗');
    expect(SHELL_CSS).toMatch(/\.identity-chip-text\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s);
    expect(SHELL_CSS).toMatch(/\.identity-chip > svg\s*\{[^}]*flex:\s*none/s);
  });

  it('does not put a user arrow on unavailable or unauthorized identities', () => {
    const unauthorized = render(<QuestionDrawer detail={detail()} onClose={() => {}} canOpenUser={false} />);
    const servicePrincipal = render(
      <QuestionDrawer detail={detail('service-principal-id')} onClose={() => {}} canOpenUser />
    );
    expect(unauthorized).not.toContain('identity-chip-link-arrow');
    expect(servicePrincipal).not.toContain('identity-chip-link-arrow');
  });
});
