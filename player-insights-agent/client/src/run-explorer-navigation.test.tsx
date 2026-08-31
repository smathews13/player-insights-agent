import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { visibleRunTraceState } from './app-state';
import type { Run } from './app-types';
import { RunDetailSkeleton } from './RunExplorer';
import { resolveRunSelection, runDetailMode, searchWithRun, validRunId } from './run-explorer-state';

const EXPLORER = readFileSync(new URL('./RunExplorer.tsx', import.meta.url), 'utf8');

const RUNS: Run[] = [
  {
    id: 'run_new',
    conversation_id: 'conv-b',
    prompt: 'Newest',
    stakeholder: 'reader@example.com',
    status: 'complete',
    duration_ms: 0,
    rating: null,
    created_at: '2026-08-31T12:00:00Z',
  },
  {
    id: 'run_deep',
    conversation_id: 'conv-a',
    prompt: 'Deep linked',
    stakeholder: 'reader@example.com',
    status: 'complete',
    duration_ms: 10,
    rating: null,
    created_at: '2026-08-30T12:00:00Z',
  },
];

describe('Run Explorer loading states', () => {
  it('skeletons the whole detail surface without painting ready-state absence copy', () => {
    const markup = renderToStaticMarkup(<RunDetailSkeleton />);
    expect(markup).toContain('Loading run details');
    expect(markup).toContain('run-detail-skeleton-head');
    expect(markup).toContain('run-detail-skeleton-tabs');
    expect(markup.match(/run-kpi-card/g)).toHaveLength(5);
    expect(markup).toContain('run-detail-skeleton-answer');
    expect(markup).not.toMatch(/Not recorded|No rating|Select a run/);
  });

  it('classifies loading, empty, invalid, deleted, error, and ready separately', () => {
    expect(runDetailMode({ listLoading: true, listOrigin: null, selection: 'empty', trace: 'idle' })).toBe('loading');
    expect(runDetailMode({ listLoading: false, listOrigin: 'empty', selection: 'empty', trace: 'idle' })).toBe('empty');
    expect(runDetailMode({ listLoading: false, listOrigin: 'stored', selection: 'invalid', trace: 'idle' })).toBe(
      'invalid'
    );
    expect(runDetailMode({ listLoading: false, listOrigin: 'stored', selection: 'selected', trace: 'missing' })).toBe(
      'missing'
    );
    expect(runDetailMode({ listLoading: false, listOrigin: 'unavailable', selection: 'empty', trace: 'idle' })).toBe(
      'error'
    );
    expect(runDetailMode({ listLoading: false, listOrigin: 'stored', selection: 'selected', trace: 'error' })).toBe(
      'error'
    );
    expect(runDetailMode({ listLoading: false, listOrigin: 'stored', selection: 'selected', trace: 'ready' })).toBe(
      'ready'
    );
  });

  it('offers retry actions for both the run list and selected detail', () => {
    expect(EXPLORER.match(/onRetry=\{retryRunList\}/g)).toHaveLength(2);
    expect(EXPLORER).toContain('onRetry={() => setTraceReloadToken((token) => token + 1)}');
  });
});

describe('Run Explorer URL selection', () => {
  it('opens a valid deep link without substituting the newest run', () => {
    expect(resolveRunSelection(RUNS, 'run_deep', null)).toEqual({
      state: 'selected',
      run: RUNS[1],
      automaticRunId: null,
    });
  });

  it('rejects malformed and missing ids instead of fetching or defaulting them', () => {
    expect(validRunId('../run_deep')).toBe(false);
    expect(resolveRunSelection(RUNS, '../run_deep', null).state).toBe('invalid');
    expect(resolveRunSelection(RUNS, 'run_deleted', null).state).toBe('invalid');
  });

  it('chooses the conversation run automatically and marks it for replace navigation', () => {
    expect(resolveRunSelection(RUNS, null, 'conv-a')).toEqual({
      state: 'selected',
      run: RUNS[1],
      automaticRunId: 'run_deep',
    });
  });

  it('preserves filters and deep-link context when a user pushes another run', () => {
    const current = new URLSearchParams('conversation=conv-a&who=reader%40example.com&range=7d&run=run_deep');
    expect(searchWithRun(current, 'run_new').toString()).toBe(
      'conversation=conv-a&who=reader%40example.com&range=7d&run=run_new'
    );
    expect(EXPLORER).toContain('searchWithRun(current, automaticRunId), { replace: true }');
    expect(EXPLORER).toContain('searchWithRun(current, run.id));');
  });

  it('restores selection when history moves backward and forward', () => {
    const history = ['run_deep', 'run_new'];
    expect(resolveRunSelection(RUNS, history[0], null).run?.id).toBe('run_deep');
    expect(resolveRunSelection(RUNS, history[1], null).run?.id).toBe('run_new');
    expect(resolveRunSelection(RUNS, history[0], null).run?.id).toBe('run_deep');
  });

  it('keeps a late response for the previous run off the newly selected detail', () => {
    const late = { runId: 'run_deep', state: { status: 'ready' as const, data: {} as never } };
    expect(visibleRunTraceState('run_new', late)).toEqual({ status: 'loading' });
    expect(visibleRunTraceState('run_deep', late)).toBe(late.state);
  });
});
