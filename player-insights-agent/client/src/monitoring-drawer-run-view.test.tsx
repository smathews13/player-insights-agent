import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { AnswerCard } from './AnswerCard';
import { QuestionDrawer } from './MonitoringPage';
import type { Answer, FeedbackEntry } from './app-types';
import type { TraceStage } from './answer-shape';
import type { MonitoringDetail } from '../../shared/monitoring-contract';

/**
 * Opening a Monitoring question is a centered modal whose body is Ask PIA's
 * own `AnswerCard`.
 *
 * It used to be a right-hand drawer that composed the card with its run process
 * switched off, then drew a second `TraceTimeline` under a "What ran" heading.
 * The second panel had no CSS of its own on this route, so its KPI tiles and
 * Gantt ticks painted on top of the answer prose. That stack is gone: one card,
 * one timeline, under the prose, the same way Ask draws it.
 */

const MONITORING = readFileSync(new URL('./MonitoringPage.tsx', import.meta.url), 'utf8');
const CARD = readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8');
const DIALOG = readFileSync(new URL('./Dialog.tsx', import.meta.url), 'utf8');

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&middot;/g, '\u00b7')
    .replace(/\s+/g, ' ')
    .trim();
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Stage ids are `step-{n}-{index}-{tool}`. The shape matters: the timeline
 * reads the tool name out of the id, and rows only render at all once the
 * trace carries stages.
 */
const stage = (id: string, name: string, kind: string, start: number): TraceStage => ({
  id,
  name,
  kind,
  start,
  duration: 100,
  status: 'complete',
  calls: 1,
  input: '',
  output: '',
});

const trace = {
  id: 'tr-1',
  totalMs: 400,
  toolCalls: 3,
  stages: [
    stage('step-1-0-dictionary_genie', 'Checked field definitions', 'tool', 0),
    stage('step-2-0-data_genie', 'Queried governed data', 'tool', 100),
    stage('step-3-0-completion', 'Wrote the answer', 'agent', 200),
  ],
};

function answerWith(stageTrace: typeof trace) {
  return {
    type: 'answer',
    mode: 'live',
    takeaway: 'The leading title is ahead on daily active players.',
    narrative: 'A narrative sentence.',
    figures: [],
    sources: [{ name: 'a_catalog.a_schema.a_table', freshness: 'today' }],
    caveats: [],
    document_snippets: [],
    sql: 'SELECT 1',
    trace: stageTrace,
  };
}

function detail(overrides: Partial<MonitoringDetail> = {}): MonitoringDetail {
  return {
    id: 'q1',
    conversationId: 'c1',
    question: 'Which countries grew fastest this quarter?',
    askedBy: 'first.person@example.test',
    askedAt: '2026-08-15T06:40:00Z',
    outcome: 'completed',
    outcomeDetail: null,
    outcomeCode: null,
    answer: answerWith(trace),
    conditioning: null,
    trace,
    tokens: { prompt: 900, completion: 300, total: 1200 },
    execution: { mode: 'signed_in_user', verified: true },
    feedback: 'down',
    comment: 'Exactly what I needed.',
    mlflowUrl: 'https://example.test/ml/experiments/1/traces',
    runId: 'a1',
    ...overrides,
  };
}

function drawer(overrides: Partial<MonitoringDetail> = {}): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <QuestionDrawer detail={detail(overrides)} onClose={() => {}} canOpenUser />
    </MemoryRouter>
  );
}

describe('a Monitoring question opens as a centered modal over the list', () => {
  it('renders a dialog on a dimmed overlay', () => {
    const markup = drawer();

    expect(markup).toContain('data-testid="monitoring-question-overlay"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('class="monitoring-question-modal ast-dialog-panel"');
    expect(markup).not.toMatch(/class="[^"]*monitoring-drawer"/);
  });

  it('closes on Escape and on a click of the overlay, not of the dialog', () => {
    expect(MONITORING).toContain("import { Dialog } from './Dialog'");
    expect(DIALOG).toContain("onDismiss?.('escape')");
    expect(DIALOG).toContain('if (event.target !== event.currentTarget) return');
    expect(DIALOG).toContain("onDismiss?.('backdrop')");
    expect(MONITORING).not.toContain("window.addEventListener('keydown'");
  });

  it('mounts the same AnswerCard Ask uses, with the run process left on', () => {
    const markup = drawer();

    expect(markup).toContain('class="answer-card');
    expect(MONITORING).toContain('<AnswerCard');
    expect(CARD).toContain('className="answer-card"');
    expect(MONITORING).not.toContain('showRunProcess={false}');
    expect(MONITORING).not.toContain('<TraceTimeline');
  });

  it('seats Asked-by as a compact chip in the answer corner, not a banner above it', () => {
    const markup = drawer();
    const rendered = text(markup);
    const cardAt = markup.indexOf('class="answer-card');
    const chipAt = markup.indexOf('identity-chip-label');
    expect(cardAt).toBeGreaterThan(-1);
    expect(chipAt).toBeGreaterThan(cardAt);
    expect(rendered).toContain('Asked by first.person');
    expect(rendered.indexOf('Live agent response')).toBeLessThan(rendered.indexOf('Asked by first.person'));
    expect(rendered.indexOf('Asked by first.person')).toBeLessThan(
      rendered.indexOf('The leading title is ahead on daily active players.')
    );
    expect(MONITORING).toContain('headerExtra=');
    expect(CARD).toContain('headerExtra');
  });

  it('does not keep the Monitoring-only What ran stack over the prose', () => {
    const markup = drawer();
    const rendered = text(markup);

    expect(rendered).not.toContain('What ran');
    expect(rendered).not.toMatch(/WHAT RAN/i);
    expect(MONITORING).not.toContain('whatRanHeading');
    expect(markup).not.toContain('monitoring-eyebrow">{whatRanHeading');
  });
});

describe("the modal draws one run view, the card's own", () => {
  it('draws a single Step timeline for a run that recorded steps', () => {
    expect(occurrences(text(drawer()), 'Step timeline')).toBe(1);
  });

  it('uses Run Explorer event labels and lists each recorded step once', () => {
    const rendered = text(drawer());

    expect(occurrences(rendered, 'dictionary_genie')).toBe(1);
    expect(occurrences(rendered, 'data_genie')).toBe(1);
    expect(occurrences(rendered, 'completion')).toBe(1);
    expect(rendered).not.toContain('Checked field definitions');
    expect(rendered).not.toContain('Queried governed data');
  });

  it('keeps the modal chrome around the shared card', () => {
    const markup = drawer();
    const rendered = text(markup);

    expect(rendered).toContain('Run process');
    expect(rendered).toContain('1,200 tokens recorded on this run.');
    expect(rendered).toContain('Open the MLflow trace');
    expect(rendered).toContain('Open in Run Explorer');
    expect(markup).toContain('aria-label="Open user overview for first.person"');
    expect(rendered.indexOf('Open the MLflow trace')).toBeLessThan(rendered.indexOf('Run process'));
    expect(rendered.indexOf('A narrative sentence.')).toBeLessThan(rendered.indexOf('Run process'));
    expect(markup).toMatch(
      /<a href="https:\/\/example\.test\/ml\/experiments\/1\/traces"[^>]*><span class="brand-icon wordmark"[^>]*>/
    );
    expect(markup).toContain('fill="var(--foreground)"');
  });

  it('stacks the token line inside the card, after the tables and before Sources', () => {
    /*
     * THE SCREENSHOT. The token line was a flex sibling after a shrinking
     * answer card, so "49,923 tokens recorded" sat on the last table row,
     * Sources flooded the table pane, and Caveats tucked under Run
     * process. It is now a grid sibling of those sections, in this order.
     *
     * The reading table now carries Open in Databricks on its header, so
     * leftover Sources only names what the table did not. A reference
     * dictionary is that leftover; without it the Sources heading is gone
     * and this order assertion has nothing to look at.
     */
    const markup = drawer({
      answer: {
        ...answerWith(trace),
        caveats: ['Coverage ends last Tuesday.'],
        figures: [{ label: 'Legacy KPI', value: 10, display: '10', comparison: 'retained in payload' }],
        content: ['| Franchise | Players |', '| --- | ---: |', '| VLH | 10 |'].join('\n'),
        sources: [
          { name: 'a_catalog.a_schema.a_table', freshness: 'today', role: 'reading' },
          { name: 'a_catalog.a_schema.data_dictionary', freshness: 'today', role: 'reference' },
        ],
      },
    });
    const rendered = text(markup);

    expect(rendered.indexOf('A narrative sentence.')).toBeLessThan(
      rendered.indexOf('1,200 tokens recorded on this run.')
    );
    expect(rendered.indexOf('1,200 tokens recorded on this run.')).toBeLessThan(rendered.indexOf('Sources'));
    expect(rendered.indexOf('Sources')).toBeLessThan(rendered.indexOf('Caveats'));
    expect(rendered.indexOf('Caveats')).toBeLessThan(rendered.indexOf('Run process'));
    expect(markup).toContain('aria-label="Caveats"');
    expect(rendered).not.toContain('Keep in mind');
    expect(rendered).not.toContain('What to keep in mind');
    expect(markup).not.toContain('answer-stat');
    expect(markup).not.toContain('Key figures');
    expect(markup).not.toContain('Legacy KPI');

    const evidence = markup.indexOf('answer-evidence');
    const origin = markup.indexOf('answer-table-origin');
    const tokens = markup.indexOf('monitoring-drawer-tokens');
    const sources = markup.indexOf('sources-module');
    const keep = markup.indexOf('keep-in-mind');
    const process = markup.indexOf('run-process');
    expect(evidence).toBeGreaterThan(-1);
    expect(origin).toBeGreaterThan(evidence);
    expect(origin).toBeLessThan(markup.indexOf('<table'));
    expect(tokens).toBeGreaterThan(origin);
    expect(sources).toBeGreaterThan(tokens);
    expect(keep).toBeGreaterThan(sources);
    expect(process).toBeGreaterThan(keep);

    expect(MONITORING).toContain('afterEvidence={');
    expect(MONITORING).toContain('tokensNote(detail.tokens)');
    expect(MONITORING).toContain('{!answer ? tokensNote(detail.tokens) : null}');
    expect(CARD).toContain('{afterEvidence}');
  });

  it('still reaches the advanced trace details the answer card owns', () => {
    const rendered = text(drawer());

    expect(rendered).toContain('Advanced trace details');
    expect(occurrences(rendered, 'Advanced trace details')).toBe(1);
  });

  it("shows the asker's feedback as a read-only KPI without admin voting controls", () => {
    const markup = drawer({ feedback: 'down', usefulness: 5 });
    const rendered = text(markup);

    expect(rendered).toMatch(/User feedback (?:Not helpful ){1,2}Submitted by the asker/);
    expect(rendered).not.toContain('Was this answer useful?');
    expect(MONITORING).toContain('feedback={readOnlyFeedback(detail)}');
    expect(MONITORING).toContain('showFeedback={false}');
  });

  it('does not add process-omission copy when the timeline is empty', () => {
    const empty = { ...trace, id: 'tr-2', totalMs: 0, toolCalls: 0, stages: [] };
    const bare = text(drawer({ trace: empty, answer: answerWith(empty) }));

    expect(bare).not.toContain('No steps recorded.');
  });
});

describe('the answer card still draws the run view where it is the only one', () => {
  const READ_ONLY: FeedbackEntry = {
    open: false,
    comment: '',
    saved: false,
    saving: false,
    error: null,
    sentiment: null,
  };

  /**
   * Ask PIA's transcript passes no `showRunProcess` at all, so this is the
   * default. A default flipped the wrong way would take the timeline off every
   * answer on Ask as well as in this modal.
   */
  it('draws its own timeline when nothing opts out', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <AnswerCard
          answer={answerWith(trace) as unknown as Answer}
          question="Which countries grew fastest this quarter?"
          feedback={READ_ONLY}
          onFeedbackChange={() => {}}
          saveFeedback={async () => {}}
          showFeedback={false}
        />
      </MemoryRouter>
    );

    expect(occurrences(text(markup), 'Step timeline')).toBe(1);
  });
});
