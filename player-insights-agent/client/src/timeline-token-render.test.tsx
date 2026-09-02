import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { TraceSummary } from './answer-shape';
import { TimelineTokenDetails, TraceTimeline } from './TraceTimeline';
import { buildTimeline } from './trace-timeline';
import { runTokenUsageView } from './token-usage-view';

const TIMELINE_CSS = readFileSync(new URL('./styles/timeline.css', import.meta.url), 'utf8');

function trace(cachedReadTokens?: number): TraceSummary {
  const cacheReported = cachedReadTokens !== undefined;
  return {
    id: 'tr-tokens',
    totalMs: 2_000,
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
        duration: 1_000,
        status: 'complete',
        calls: 1,
        input: '',
        output: '',
        token_usage: {
          inputTokens: 80_000,
          outputTokens: 4_576,
          totalTokens: 84_576,
          cachedReadTokens,
          cacheWriteTokens: cacheReported ? 200 : undefined,
          cacheStatus: cacheReported ? 'used' : 'unavailable',
          attempts: 2,
          totalMismatch: false,
        },
      },
      {
        id: 'step-1-1-run_sql',
        name: 'Ran SQL',
        kind: 'sql',
        start: 1_000,
        duration: 1_000,
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
      cachedReadTokens,
      cacheCoveredInputTokens: cacheReported ? 80_000 : undefined,
      cacheHitPercent: cacheReported ? ((cachedReadTokens ?? 0) / 80_000) * 100 : undefined,
    },
  };
}

describe('Run Explorer Timeline token evidence', () => {
  it('adds a run total and direct-LLM Tokens cell without putting zero on tool rows', () => {
    const markup = renderToStaticMarkup(<TraceTimeline variant="explorer" trace={trace()} />);
    expect(markup).toContain('>Tokens</th>');
    expect(markup).toContain('84,576 total tokens');
    expect(markup).toContain('trace-num trace-tokens ast-num">84,576</td>');
    expect(markup.match(/aria-label="Token usage not reported">—/g)).toHaveLength(2);
    expect(markup).not.toContain(' cached');
  });

  it('adds cached input to the summary only when the provider reported it', () => {
    const markup = renderToStaticMarkup(<TraceTimeline variant="explorer" trace={trace(20_000)} />);
    expect(markup).toContain('20,000 cached');
  });

  it('shows the complete token, cache, attempts, and coverage record in expanded LLM details', () => {
    const source = trace();
    const row = buildTimeline(source).rows.find((item) => item.id === 'step-1');
    expect(row).toBeDefined();
    const markup = renderToStaticMarkup(<TimelineTokenDetails row={row!} run={runTokenUsageView(source)} />);
    for (const text of [
      'Input tokens',
      '80,000',
      'Output tokens',
      '4,576',
      'Total tokens',
      '84,576',
      'Cache read',
      'Cache write',
      'Not reported',
      'Attempts',
      '100.0% of the run token total',
    ]) {
      expect(markup).toContain(text);
    }
  });

  it('keeps Tokens bounded while the whole table remains horizontally scrollable', () => {
    expect(TIMELINE_CSS).toMatch(/\.trace-gantt-scroll\s*\{[^}]*overflow-x:\s*auto/s);
    expect(TIMELINE_CSS).toMatch(/\.trace-gantt \.trace-tokens\s*\{[^}]*width:\s*88px[^}]*min-width:\s*78px/s);
    expect(TIMELINE_CSS).toMatch(/\.trace-gantt \.trace-duration\s*\{[^}]*white-space:\s*nowrap/s);
  });
});
