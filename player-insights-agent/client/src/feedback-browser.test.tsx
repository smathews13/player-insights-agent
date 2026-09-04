import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { MonitoringQuestionsPayload } from '../../shared/monitoring-contract';
import type { MonitoringFeedbackPayload } from '../../shared/monitoring-feedback-contract';
import { FeedbackBrowserPanel } from './FeedbackBrowserPanel';
import { SummaryStrip } from './MonitoringPage';

const CSS = readFileSync(new URL('./styles/monitoring.css', import.meta.url), 'utf8');
const DIALOG = readFileSync(new URL('./Dialog.tsx', import.meta.url), 'utf8');

const monitoring: MonitoringQuestionsPayload = {
  readState: 'ok',
  readAt: '2026-09-03T12:00:00Z',
  summary: {
    questionsAsked: 23,
    userThreads: 12,
    completed: 20,
    partial: 2,
    refused: 1,
    failed: 0,
    helpful: 9,
    feedbackTotal: 9,
    medianMs: 36_500,
    timedCount: 22,
  },
  questions: [],
  people: [],
  tables: [],
  grantsResolution: 'ok',
  pagination: { pageSize: 50, total: 23, hasMore: false, nextCursor: null },
};

const payload: MonitoringFeedbackPayload = {
  schemaRevision: 1,
  readAt: '2026-09-03T12:00:00Z',
  dataRevision: 'feedback-rev',
  identityRevision: 'identity-rev',
  summary: { total: 2, helpful: 1, notHelpful: 1 },
  rows: [
    {
      id: 'feedback-2',
      questionId: 'question-2',
      conversationId: 'conversation-2',
      runId: 'answer-2',
      question: 'Which players improved?',
      askedAt: '2026-09-03T10:59:00Z',
      userEmail: 'coach@example.com',
      role: 'consumer',
      persona: { id: 'coach', name: 'Coach' },
      organization: { domain: 'example.com', name: 'Example' },
      feedback: 'down',
      comment: 'The comparison was missing.',
      submittedAt: '2026-09-03T11:00:00Z',
    },
    {
      id: 'feedback-1',
      questionId: 'question-1',
      conversationId: 'conversation-1',
      runId: 'answer-1',
      question: 'Show the latest lineup.',
      askedAt: '2026-09-03T09:59:00Z',
      userEmail: 'owner@example.com',
      role: 'super_admin',
      persona: null,
      organization: { domain: 'example.com', name: 'Example' },
      feedback: 'up',
      comment: null,
      submittedAt: '2026-09-03T10:00:00Z',
    },
  ],
  filters: {
    users: [{ value: 'coach@example.com', label: 'coach@example.com', count: 1 }],
    roles: [{ value: 'consumer', label: 'Consumer', count: 1 }],
    personas: [{ value: 'coach', label: 'Coach', count: 1 }],
    organizations: [{ value: 'example.com', label: 'Example', count: 2 }],
  },
  pagination: { pageSize: 25, total: 2, hasMore: false, nextCursor: null },
};

const filters = {
  search: '',
  feedback: '' as const,
  user: '',
  role: '',
  persona: '',
  organization: '',
};

function panel(
  state: Parameters<typeof FeedbackBrowserPanel>[0]['state'],
  activeFilters: Parameters<typeof FeedbackBrowserPanel>[0]['filters'] = filters
) {
  return renderToStaticMarkup(
    <FeedbackBrowserPanel
      state={state}
      filters={activeFilters}
      range="7d"
      rangeLabel="7 days"
      page={0}
      onClose={() => undefined}
      onFilters={() => undefined}
      onRange={() => undefined}
      onClear={() => undefined}
      onOpenQuestion={() => undefined}
      onPrevious={() => undefined}
      onNext={() => undefined}
      onRetry={() => undefined}
    />
  );
}

describe('Monitoring feedback entry card', () => {
  it('is a semantic button with an affordance only for an authorized reader', () => {
    const admin = renderToStaticMarkup(
      <SummaryStrip payload={monitoring} periodLabel="7 days" onOpenFeedback={() => undefined} />
    );
    const consumer = renderToStaticMarkup(<SummaryStrip payload={monitoring} periodLabel="7 days" />);

    expect(admin).toContain('<button');
    expect(admin).toContain('Open feedback');
    expect(admin).toContain('Feedback, 7 days');
    expect(consumer).not.toContain('Open feedback');
    expect(consumer).toContain('role="group"');
  });

  it('has visible pointer, hover, and keyboard focus treatment', () => {
    expect(CSS).toMatch(/\.monitoring-tile-action\s*\{[^}]*cursor:\s*pointer/s);
    expect(CSS).toContain('.monitoring-tile-action:hover');
    expect(CSS).toContain('.monitoring-tile-action:focus-visible');
  });
});

describe('feedback corpus modal', () => {
  it('renders first-class rows, exact comments, thumbs, separate user links, and one-line headers', () => {
    const markup = panel({ status: 'ready', key: 'feedback', requestId: 1, data: payload, error: null });

    expect(markup).toContain('2 total · 1 helpful · 1 not helpful');
    for (const header of ['Question', 'User', 'Feedback', 'Comment', 'Submitted']) {
      expect(markup).toContain(`>${header}</th>`);
    }
    expect(markup).toContain('The comparison was missing.');
    expect(markup).toContain('>—</span>');
    expect(markup).toContain('lucide-thumbs-up');
    expect(markup).toContain('lucide-thumbs-down');
    expect(markup).toContain('Open user overview for coach');
    expect(markup).toContain('aria-label="Open question details: Which players improved?"');
    expect(markup).toContain('data-role-state="consumer"');
    expect(markup).toContain('data-role-state="super_admin"');
    expect(markup).not.toContain('aria-live=');
    expect(markup).not.toMatch(/star|spend|cost/i);
  });

  it('offers period, feedback, user, role, persona, organization, and search controls', () => {
    const markup = panel({ status: 'ready', key: 'feedback', requestId: 1, data: payload, error: null });
    expect(markup).toContain('Time range for Feedback');
    expect(markup).toContain('Search feedback by question, user, or comment');
    for (const label of ['feedback', 'user', 'role', 'persona', 'organization']) {
      expect(markup).toContain(`Filter feedback by ${label}`);
    }
    const roleFiltered = panel(
      { status: 'ready', key: 'feedback-role', requestId: 2, data: payload, error: null },
      { ...filters, role: 'consumer' }
    );
    expect(roleFiltered).toContain('aria-label="Filter feedback by role: Consumer (1)"');
    expect(roleFiltered).toContain('data-role-state="consumer"');
  });

  it('renders branded skeleton loading, concise error/retry, and the exact empty state', () => {
    const loading = panel({ status: 'loading', key: 'feedback', requestId: 1, data: null, error: null });
    const error = panel({
      status: 'error',
      key: 'feedback',
      requestId: 1,
      data: null,
      error: 'Feedback could not be loaded.',
    });
    const empty = panel({
      status: 'ready',
      key: 'feedback',
      requestId: 1,
      data: { ...payload, rows: [], summary: { total: 0, helpful: 0, notHelpful: 0 } },
      error: null,
    });
    expect(loading).toContain('pia-loader-mark');
    expect(loading).toContain('Loading feedback');
    expect(loading).toContain('data-slot="skeleton"');
    expect(error).toContain('role="alert"');
    expect(error).toContain('Retry');
    expect(empty).toContain('No feedback matches these filters');
  });

  it('uses the shared body portal/focus trap and compensates for scrollbar removal', () => {
    expect(DIALOG).toContain('createPortal(overlay, document.body)');
    expect(DIALOG).toContain('document.body.style.paddingRight');
    expect(DIALOG).toContain('dialogTabTarget');
    expect(CSS).toMatch(/\.monitoring-feedback-modal\s*\{[^}]*width:/s);
  });
});
