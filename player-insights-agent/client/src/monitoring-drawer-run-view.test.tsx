import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { AnswerCard } from './AnswerCard';
import { QuestionDrawer } from './MonitoringPage';
import type { Answer, FeedbackEntry } from './app-types';
import type { TraceStage } from './answer-shape';
import type { MonitoringDetail } from '../../shared/monitoring-contract';

/**
 * The Monitoring drawer draws the run view once.
 *
 * It drew it twice. The drawer composes `AnswerCard`, which carries its own run
 * process panel, and then rendered a second `TraceTimeline` under its own "What
 * ran" heading -- so opening a run from Monitoring gave two Step timelines,
 * one above the other, listing the same steps. Neither was wrong; there were
 * simply two of them, and a reader comparing them had no way to know that.
 *
 * The drawer's own section is the one that survives, because it is the one the
 * surrounding disclosure is written for: the "What ran" heading above it and
 * the token count and trace links below it all belong to the drawer, and read
 * as captions on the timeline between them.
 *
 * WHY THIS IS PINNED BY A COUNT RATHER THAN BY A PRESENCE CHECK. Every
 * assertion the drawer already had passed while the duplicate was on screen,
 * because `toContain` is satisfied by the first of two. A duplicate is cheap to
 * reintroduce -- one more caller composing `AnswerCard` with its run process
 * left on -- and nothing else in the suite would notice.
 */

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
 * trace carries stages. The drawer's older fixtures pass `stages: []`, which
 * draws "this run recorded no steps" and would have hidden the duplication.
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

/** The stored answer, which carries a second copy of the same trace. */
function answerWith(stageTrace: typeof trace) {
  return {
    type: 'answer',
    mode: 'live',
    takeaway: 'The leading title is ahead on daily active players.',
    narrative: 'A narrative sentence.',
    figures: [],
    sources: [{ name: 'a_catalog.a_schema.a_table', freshness: 'today' }],
    caveats: [],
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
    rating: 'up',
    usefulness: 4,
    comment: 'Exactly what I needed.',
    mlflowUrl: 'https://example.test/ml/experiments/1/traces',
    runId: 'a1',
    ...overrides,
  };
}

function drawer(overrides: Partial<MonitoringDetail> = {}): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <QuestionDrawer detail={detail(overrides)} onClose={() => {}} onOpenPerson={() => {}} />
    </MemoryRouter>
  );
}

describe('the Monitoring drawer renders one run view, not two', () => {
  it('draws a single Step timeline for a run that recorded steps', () => {
    expect(occurrences(text(drawer()), 'Step timeline')).toBe(1);
  });

  it('lists each recorded step once', () => {
    const rendered = text(drawer());

    // Every row, not just the first: a duplicate panel repeats all of them, so
    // checking one step would pass on a drawer that doubled the other two.
    expect(occurrences(rendered, 'Checked field definitions')).toBe(1);
    expect(occurrences(rendered, 'Queried governed data')).toBe(1);
    expect(occurrences(rendered, 'Wrote the answer')).toBe(1);
  });

  it('keeps the drawer’s own framing around the timeline it kept', () => {
    const rendered = text(drawer());

    // The heading above and the two captions below. These are what identify
    // the surviving view as the drawer's rather than the answer card's.
    expect(rendered).toContain('What ran');
    expect(rendered).toContain('1,200 tokens recorded on this run.');
    expect(rendered).toContain('Open the MLflow trace');
    expect(rendered).toContain('Open in Run Explorer');
    expect(rendered).toContain('See this person');
  });

  it('still reaches the advanced trace details the answer card owns', () => {
    // Removing the answer card's run process panel from this surface must not
    // take the switch beside it with it: it was reported broken once already,
    // and the fix was to put it where its effect is.
    const rendered = text(drawer());

    expect(rendered).toContain('Advanced trace details');
    expect(occurrences(rendered, 'Advanced trace details')).toBe(1);
  });

  it('says so plainly, once, when the run recorded no steps at all', () => {
    // The empty case still belongs to one panel. Both traces are emptied, not
    // just the drawer's: leaving steps on the answer's copy would make this
    // pass on a duplicating drawer, because the two panels would then be
    // saying different things and neither sentence would appear twice.
    const empty = { ...trace, id: 'tr-2', totalMs: 0, toolCalls: 0, stages: [] };
    const bare = text(drawer({ trace: empty, answer: answerWith(empty) }));

    expect(occurrences(bare, 'This run recorded no steps')).toBe(1);
  });
});

describe('the answer card still draws the run view where it is the only one', () => {
  const READ_ONLY: FeedbackEntry = {
    open: false,
    comment: '',
    saved: false,
    saving: false,
    error: null,
    usefulness: null,
  };

  /**
   * The other half of the fix, and the half a careless repair breaks: the panel
   * is switched off by the drawer, not deleted. Ask PIA's transcript passes no
   * `showRunProcess` at all, so this is the default rather than an opt-in, and a
   * default flipped the wrong way would take the timeline off every answer.
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
