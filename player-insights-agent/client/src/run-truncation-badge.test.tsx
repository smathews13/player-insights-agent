import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { RunListItem } from './RunExplorer';
import { RunHeader } from './RunHeader';
import type { Run } from './app-types';

/**
 * Whether a run that stopped early says so in the list.
 *
 * The badge was specified, the styles for it existed, and it could not have
 * drawn on any run in any deployment: `/api/runs` did not carry the fact, so the
 * condition behind it was reading a field the row never had. A badge that is
 * silently always absent is worse than no badge, because the list then reads as
 * a positive statement that nothing was cut short.
 *
 * Both directions are asserted for that reason. A test that only checks the
 * truncated case passes just as well against a badge rendered unconditionally,
 * which is the same defect facing the other way: every run marked as incomplete
 * teaches the reader to ignore the mark.
 */

const RUN: Run = {
  id: 'run-9d1c',
  kind: 'benchmark',
  conversation_id: null,
  prompt: 'How did the launch week compare with the previous one?',
  stakeholder: 'analyst@example.com',
  status: 'complete',
  duration_ms: 43_740,
  tool_calls: 7,
  feedback: null,
  created_at: '2026-08-14T09:12:00.000Z',
};

function rowMarkup(run: Run): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <RunListItem run={run} active={false} onSelect={() => {}} />
    </MemoryRouter>
  );
}

describe('the status on a truncated run', () => {
  it('keeps the stored Complete badge when a deadline note is also on the row', () => {
    const markup = rowMarkup({ ...RUN, truncated: true });
    expect(markup).toContain('complete');
    expect(markup).not.toContain('partial');
    expect(markup).not.toContain('Truncated');
  });

  it('leaves a run that ran to the end unmarked', () => {
    expect(rowMarkup({ ...RUN, truncated: false })).not.toContain('Truncated');
  });

  it('leaves a run unmarked when the server did not report the fact at all', () => {
    // A stored run from before this column existed, and a client talking to an
    // older server. Neither ran to the end as far as anyone here knows, and
    // "not reported" has to draw as nothing rather than as a claim either way.
    expect(rowMarkup(RUN)).not.toContain('Truncated');
    expect(rowMarkup({ ...RUN, truncated: null })).not.toContain('Truncated');
  });

  it('does not paint a stored Complete run as Partial because it also recorded a deadline', () => {
    const markup = rowMarkup({ ...RUN, truncated: true });
    expect(markup).toContain('complete');
    expect(markup).not.toContain('partial');
  });

  it('keeps the tool-call count and rating state in the same badge row', () => {
    const markup = rowMarkup(RUN);
    expect(markup).toMatch(/run-item-pills[\s\S]*tool-calls-label[\s\S]*>Tools<[\s\S]*ast-num">7<\/span>/);
    expect(markup).not.toContain('run-rating-badge');
    expect(rowMarkup({ ...RUN, feedback: 'up' })).toMatch(/run-item-pills[\s\S]*aria-label="Helpful"/);
  });
});

function headerMarkup(run: Run, toolCalls: number | null = run.tool_calls ?? null): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <RunHeader run={run} toolCalls={toolCalls} reference={false} groundedness={null} />
    </MemoryRouter>
  );
}

describe('the same status on the run the reader opened', () => {
  it('carries the stored Complete status through from the row to the header it opens', () => {
    const markup = headerMarkup({ ...RUN, truncated: true });
    expect(markup).toContain('complete');
    expect(markup).not.toContain('partial');
    expect(markup).not.toContain('Truncated');
  });

  it('leaves a run that ran to the end, or never said, unmarked', () => {
    expect(headerMarkup({ ...RUN, truncated: false })).not.toContain('Truncated');
    expect(headerMarkup(RUN)).not.toContain('Truncated');
    expect(headerMarkup({ ...RUN, truncated: null })).not.toContain('Truncated');
  });

  it('does not paint the opened header Partial over a stored Complete run', () => {
    const markup = headerMarkup({ ...RUN, truncated: true });
    expect(markup).toContain('complete');
    expect(markup).not.toContain('partial');
  });

  it('keeps the tool-call count and rating state beside the id, user, and status', () => {
    const markup = headerMarkup(RUN);
    expect(markup).toMatch(/run-detail-ident[\s\S]*tool-calls-label[\s\S]*>Tools<[\s\S]*ast-num">7<\/span>/);
    expect(markup).toMatch(/run-detail-ident[\s\S]*No feedback/);
    expect(headerMarkup({ ...RUN, feedback: 'up' })).toMatch(/run-detail-ident[\s\S]*Helpful/);
  });
});
