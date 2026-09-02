import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunHeader } from './RunHeader';
import {
  applyRunLabelOverride,
  applyRunLabelOverrideToConversations,
  applyRunLabelOverrideToList,
  applyRunLabelOverrideToSummaries,
  forgetRunLabelOverrides,
  persistRunLabels,
  railFeedbackValue,
  railOutcomeValue,
  rememberRunLabelOverride,
  RUN_LABELS_NOT_SAVED,
} from './run-header-labels';
import { readRunSummaries } from './initial-rail';
import { RunListItem } from './RunExplorer';
import { railRunSummaries } from './rail-run-summary';
import { partial } from './styles/stylesheet';
import type { Conversation, Run } from './app-types';

const RUNS_CSS = partial('runs.css');
const SOURCE = readFileSync(new URL('./RunHeader.tsx', import.meta.url), 'utf8');
const HOME = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
const EXPLORER = readFileSync(new URL('./RunExplorer.tsx', import.meta.url), 'utf8');

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
    feedback: null,
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
  it('grows outcome, tools and feedback to the identity chips rather than shrinking them', () => {
    const shared = rule(
      '.run-detail-ident .run-context-badge,\n.run-detail-ident .run-id-chip,\n.run-detail-ident .identity-chip,\n.run-detail-ident .ast-pill'
    );
    expect(shared).toContain('min-height: 24px');
    expect(shared).toContain('font-size: var(--text-sm)');
    expect(RUNS_CSS).toMatch(/\.run-detail-ident \.ast-pill \{\n {2}padding: 3px 8px;\n\}/);
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

  it('opens dropdowns only for outcome and feedback', () => {
    const markup = header({
      canEdit: true,
      editing: true,
    });
    expect(markup).toContain('data-testid="run-header-label-editor"');
    expect(markup).toContain('aria-label="Outcome: Partial"');
    expect(markup).toContain('aria-label="Feedback: No feedback"');
    expect(markup).toContain('app-select-trigger');
    expect(markup).toContain('role="combobox"');
    expect(markup).not.toContain('run-header-label-select');
    expect(markup).not.toMatch(/aria-label="Conversation"/);
    expect(markup).not.toMatch(/aria-label="Run"/);
    expect(markup).not.toMatch(/aria-label="Message"/);
    expect(markup).not.toMatch(/aria-label="User"/);
    expect(markup).not.toMatch(/aria-label="Tools"/);
    const editor = readFileSync(new URL('./RunHeaderLabelEditor.tsx', import.meta.url), 'utf8');
    expect(editor).toContain('<AppSelect');
    expect(editor).toContain('RAIL_OUTCOME_OPTIONS');
    expect(editor).toContain('RAIL_FEEDBACK_OPTIONS');
  });

  it('puts Outcome and Feedback on the chip row, after the pencil', () => {
    const markup = header({ canEdit: true, editing: true });
    const pencil = markup.indexOf('aria-label="Edit run labels"');
    const editor = markup.indexOf('data-testid="run-header-label-editor"');
    expect(pencil).toBeGreaterThan(-1);
    expect(editor).toBeGreaterThan(pencil);
    expect(markup).not.toContain('run-header-label-field');
    expect(rule('.run-detail-ident .run-header-label-editor')).toContain('display: inline-flex');
    expect(rule('.run-detail-ident .run-header-label-editor')).toContain('margin-top: 0');
  });
});

describe('an administrator’s rail choice is what a later open draws', () => {
  afterEach(() => {
    forgetRunLabelOverrides();
    vi.unstubAllGlobals();
  });

  it('applies a stored outcome and feedback without changing the classified row when nothing was saved', () => {
    const stored = run({ status: 'partial', feedback: null });
    expect(applyRunLabelOverride(stored, null).status).toBe('partial');
    const overlaid = applyRunLabelOverride(stored, { status: 'complete', feedback: 'up' });
    expect(overlaid.status).toBe('complete');
    expect(overlaid.feedback).toBe('up');
    expect(applyRunLabelOverride(stored, { feedback: 'down' }).feedback).toBe('down');
    expect(railOutcomeValue('partial')).toBe('partial');
    expect(railFeedbackValue(null)).toBe('none');
  });

  it('persists outcome and feedback on the admin overlay route', async () => {
    const send = vi.fn((_url: string, init?: RequestInit) => {
      expect(_url).toBe(`/api/admin/run-labels/${FULL_ID}`);
      expect(init?.method).toBe('PUT');
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as {
        status: string;
        feedback: string;
      };
      expect(body).toEqual({ status: 'complete', feedback: 'up' });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    });
    await persistRunLabels(FULL_ID, { status: 'complete', feedback: 'up' }, send as unknown as typeof fetch);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('puts Complete on the recent-runs row, Ask rail, and a later reload of the same list', () => {
    const stored = run({ status: 'partial', feedback: null });
    const listed = applyRunLabelOverrideToList([stored], FULL_ID, { status: 'complete', feedback: 'up' });
    expect(listed[0].status).toBe('complete');
    expect(listed[0].feedback).toBe('up');
    const markup = renderToStaticMarkup(<RunListItem run={listed[0]} active={true} onSelect={() => undefined} />);
    expect(markup).toMatch(/>complete</i);
    expect(markup).not.toMatch(/>partial</i);
    expect(railRunSummaries(listed).get('conv-9abcdef')?.status).toBe('complete');
  });

  it('refreshes the Ask rail cache when the pencil writes Complete', async () => {
    const summaries = railRunSummaries([run({ status: 'partial', feedback: null })]);
    expect(summaries.get('conv-9abcdef')?.status).toBe('partial');
    const next = applyRunLabelOverrideToSummaries(summaries, 'conv-9abcdef', {
      status: 'complete',
      feedback: 'up',
    });
    expect(next.get('conv-9abcdef')).toMatchObject({ status: 'complete', feedback: 'up' });
    expect(next.get('conv-9abcdef')?.tone).toBe('ast-pill--pos');
    const conversations: Conversation[] = [
      { id: 'conv-9abcdef', title: 'tables', updated_at: '2026-08-25T10:00:00Z', status: 'partial' },
    ];
    expect(applyRunLabelOverrideToConversations(conversations, 'conv-9abcdef', { status: 'complete' })[0].status).toBe(
      'complete'
    );

    rememberRunLabelOverride('conv-9abcdef', { status: 'complete', feedback: 'up' });
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([run({ status: 'partial', feedback: null })]),
      } as Response)
    );
    const reread = await readRunSummaries();
    expect(reread.get('conv-9abcdef')?.status).toBe('complete');
    expect(reread.get('conv-9abcdef')?.feedback).toBe('up');
    expect(HOME).toContain('subscribeRunLabelOverrides');
    expect(HOME).toContain('applyRunLabelOverrideToSummaries');
    expect(EXPLORER).toContain('rememberRunLabelOverride');
  });
});

describe('a failed label save is visible', () => {
  afterEach(() => {
    forgetRunLabelOverrides();
    vi.unstubAllGlobals();
  });

  it('refuses to swallow a persist failure, and names it on the rail', async () => {
    const send = vi.fn(() => Promise.resolve({ ok: false, status: 503 } as Response));
    await expect(persistRunLabels(FULL_ID, { status: 'complete' }, send as unknown as typeof fetch)).rejects.toThrow(
      RUN_LABELS_NOT_SAVED
    );
    expect(SOURCE).not.toMatch(/\.catch\(\(\) => undefined\)/);
    expect(SOURCE).toContain('setLabelError(RUN_LABELS_NOT_SAVED)');
    const markup = header({
      canEdit: true,
      editing: true,
      labelError: RUN_LABELS_NOT_SAVED,
    });
    expect(markup).toContain('run-header-label-error');
    expect(markup).toContain(RUN_LABELS_NOT_SAVED);
    expect(markup).toContain('role="alert"');
    expect(rule('.run-header-label-error')).toContain('color: var(--destructive)');
  });
});
