import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { RunHeader } from './RunHeader';
import {
  applyRunLabelOverride,
  applyRunLabelOverrideToList,
  persistRunLabels,
  railOutcomeValue,
  railRatingValue,
} from './run-header-labels';
import { RunListItem } from './RunExplorer';
import { railRunSummaries } from './rail-run-summary';
import { UP_RATING, DOWN_RATING } from './stored-feedback';
import { partial } from './styles/stylesheet';
import type { Run } from './app-types';

const RUNS_CSS = partial('runs.css');
const SOURCE = readFileSync(new URL('./RunHeader.tsx', import.meta.url), 'utf8');

function rule(selector: string): string {
  const start = RUNS_CSS.indexOf(`\n${selector} {`);
  expect(start, `${selector} exists`).toBeGreaterThan(-1);
  return RUNS_CSS.slice(start, RUNS_CSS.indexOf('}', start));
}

const FULL_ID = 'msg-197e8211cafe';

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: FULL_ID,
    prompt: 'tell me what tables you have access to',
    stakeholder: '<your-username>@example.com',
    status: 'partial',
    duration_ms: 12000,
    rating: null,
    created_at: '2026-08-25T10:00:00Z',
    conversation_id: 'conv-9abcdef',
    ...overrides,
  };
}

function header(props: Partial<Parameters<typeof RunHeader>[0]> = {}): string {
  return renderToStaticMarkup(
    <RunHeader
      run={run()}
      conversationId="conv-9abcdef"
      conversationRun={1}
      toolCalls={4}
      reference={false}
      groundedness={null}
      {...props}
    />
  );
}

describe('the run header rail chips are one height', () => {
  it('grows outcome, tools and rating to the identity chips rather than shrinking them', () => {
    const shared = rule(
      '.run-detail-ident .run-context-badge,\n.run-detail-ident .run-id-chip,\n.run-detail-ident .identity-chip,\n.run-detail-ident .ast-pill'
    );
    expect(shared).toContain('min-height: 24px');
    expect(shared).toContain('font-size: var(--text-sm)');
    expect(RUNS_CSS).toMatch(/\.run-detail-ident \.ast-pill \{\n  padding: 3px 8px;\n\}/);
    expect(rule('.run-context-badge')).toContain('padding: 3px 8px');
    expect(rule('.run-context-badge')).toContain('font-size: var(--text-sm)');
  });
});

describe('only an administrator can edit the rail labels', () => {
  it('hides the pencil from a consumer', () => {
    const markup = header({ canEdit: false });
    expect(markup).not.toContain('run-header-edit');
    expect(markup).not.toContain('Edit run labels');
    expect(markup).not.toContain('run-header-label-editor');
  });

  it('shows a muted pencil for an administrator, not a neon one', () => {
    const markup = header({ canEdit: true });
    expect(markup).toContain('aria-label="Edit run labels"');
    expect(markup).toContain('class="run-header-edit"');
    expect(rule('.run-header-edit')).toContain('color: var(--db-slate-icon)');
    expect(rule('.run-header-edit')).not.toContain('--ast-blue');
    expect(SOURCE).toContain('<Pencil');
  });

  it('opens dropdowns only for outcome and rating', () => {
    const markup = header({
      canEdit: true,
      editing: true,
    });
    expect(markup).toContain('data-testid="run-header-label-editor"');
    expect(markup.match(/<select/g)?.length).toBe(2);
    expect(markup).toMatch(/<select[^>]*aria-label="Outcome"[^>]*>[\s\S]*Complete[\s\S]*Partial[\s\S]*Failed/);
    expect(markup).toMatch(/<select[^>]*aria-label="Rating"[^>]*>[\s\S]*Not rated[\s\S]*Helpful[\s\S]*Not helpful/);
    expect(markup).not.toMatch(/aria-label="Conversation"/);
    expect(markup).not.toMatch(/aria-label="Run"/);
    expect(markup).not.toMatch(/aria-label="Message"/);
    expect(markup).not.toMatch(/aria-label="User"/);
    expect(markup).not.toMatch(/aria-label="Tools"/);
  });
});

describe('an administrator’s rail choice is what a later open draws', () => {
  it('applies a stored outcome and rating without changing the classified row when nothing was saved', () => {
    const stored = run({ status: 'partial', rating: null });
    expect(applyRunLabelOverride(stored, null).status).toBe('partial');
    const overlaid = applyRunLabelOverride(stored, { status: 'complete', rating: 'up' });
    expect(overlaid.status).toBe('complete');
    expect(overlaid.rating).toBe(UP_RATING);
    expect(applyRunLabelOverride(stored, { rating: 'down' }).rating).toBe(DOWN_RATING);
    expect(railOutcomeValue('partial')).toBe('partial');
    expect(railRatingValue(null)).toBe('unrated');
  });

  it('persists outcome and rating on the admin overlay route', async () => {
    const send = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(_url).toBe(`/api/admin/run-labels/${FULL_ID}`);
      expect(init?.method).toBe('PUT');
      const body = JSON.parse(String(init?.body)) as { status: string; rating: string };
      expect(body).toEqual({ status: 'complete', rating: 'up' });
      return { ok: true, json: async () => body } as Response;
    });
    await persistRunLabels(FULL_ID, { status: 'complete', rating: 'up' }, send as unknown as typeof fetch);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('puts Complete on the recent-runs row, Ask rail, and a later reload of the same list', () => {
    const stored = run({ status: 'partial', rating: null });
    const listed = applyRunLabelOverrideToList([stored], FULL_ID, { status: 'complete', rating: 'up' });
    expect(listed[0].status).toBe('complete');
    expect(listed[0].rating).toBe(UP_RATING);
    const markup = renderToStaticMarkup(
      <RunListItem run={listed[0]} active={true} onSelect={() => undefined} />
    );
    expect(markup).toMatch(/>complete</i);
    expect(markup).not.toMatch(/>partial</i);
    expect(railRunSummaries(listed).get('conv-9abcdef')?.status).toBe('complete');
  });
});
