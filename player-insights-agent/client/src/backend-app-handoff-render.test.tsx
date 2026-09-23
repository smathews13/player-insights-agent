import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { AnalysisPlan, Answer, FeedbackEntry } from './app-types';
import { normalizeAnswer, normalizeTrace, type WireAnswer } from './answer-shape';
import { AnswerCard } from './AnswerCard';
import { PlanCard } from './PlanCard';
import planResponseFixture from '../../server/routes/__fixtures__/backend-app-handoff/example-plan-response.json';
import answerResponseFixture from '../../server/routes/__fixtures__/backend-app-handoff/example-answer-response.json';

const EMPTY_FEEDBACK: FeedbackEntry = {
  open: false,
  comment: '',
  saved: false,
  saving: false,
  error: null,
  usefulness: null,
};

function readable(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function planFromFixture(): AnalysisPlan {
  const event = planResponseFixture.events[0] as { custom_outputs: { plan: AnalysisPlan } };
  return event.custom_outputs.plan;
}

function answerFromFixture(overrides: Partial<WireAnswer> = {}): Answer {
  const event = answerResponseFixture.events.at(-1) as { custom_outputs: { answer: WireAnswer } };
  return normalizeAnswer({
    ...event.custom_outputs.answer,
    type: 'answer',
    mode: 'live',
    provenance: 'live',
    ...overrides,
  }) as Answer;
}

function renderAnswer(answer: Answer): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AnswerCard
        answer={answer}
        question="How many players are in all three groups?"
        feedback={EMPTY_FEEDBACK}
        onFeedbackChange={() => undefined}
        saveFeedback={() => Promise.resolve()}
        showFeedback={false}
        showRunProcess={false}
      />
    </MemoryRouter>
  );
}

describe('offline frontend handoff examples', () => {
  it('renders the real plan shape as an actionable approval card', () => {
    const plan = planFromFixture();
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PlanCard
          plan={plan}
          loading={false}
          resolved={false}
          approved={false}
          approvalExecuted={false}
          approvalPending={false}
          canRevise
          onApprove={() => undefined}
          onRevise={() => undefined}
        />
      </MemoryRouter>
    );
    const text = readable(markup);
    expect(text).toContain('Review needed');
    expect(text).toContain('Approve and run');
    expect(text).toContain('Membership X');
    expect(markup.match(/data-entity-part="table"/g) ?? []).toHaveLength(3);
    expect(markup.match(/>In scope<\/span>/g) ?? []).toHaveLength(3);
    expect(markup).not.toContain('type="radio"');
    expect(plan.candidates).toHaveLength(3);
  });

  it('renders the complete answer even when narrative and content are intentionally empty', () => {
    const answer = answerFromFixture();
    const markup = renderAnswer(answer);
    const text = readable(markup);
    expect(answer.narrative).toBe('');
    expect(answer.content).toBe('');
    expect(text).toContain('120 players');
    expect(text).toContain('Key figures');
    expect(text).toContain('Membership X ever-members');
    expect(text).toContain('Caveats');
    expect(markup.match(/data-entity-part="table"/g) ?? []).toHaveLength(4);
    expect(markup).toContain('example_catalog');
    expect(answer.sql).toContain('WITH members AS');
  });

  it('keeps figures and provenance when the takeaway setting sends an empty string', () => {
    const markup = renderAnswer(answerFromFixture({ takeaway: '' }));
    const text = readable(markup);
    expect(text).toContain('Key figures');
    expect(text).toContain('Membership X ever-members');
    expect(text).toContain('Sources');
    expect(markup).not.toContain('representative-answer-notice');
  });

  it('preserves the trace resource fields the backend contract publishes', () => {
    const raw = answerResponseFixture.events.at(-1) as {
      custom_outputs: { answer: { trace: Record<string, unknown> } };
    };
    const trace = normalizeTrace({
      ...raw.custom_outputs.answer.trace,
      genie_spaces: [{ id: 'space-1', title: 'Player data' }],
      resource_calls: [{ kind: 'genie-space', id: 'space-1', tool: 'data_genie', calls: 2 }],
    });
    expect(trace.genie_spaces).toEqual([{ id: 'space-1', title: 'Player data' }]);
    expect(trace.resource_calls).toEqual([{ kind: 'genie-space', id: 'space-1', tool: 'data_genie', calls: 2 }]);
  });

  it('preserves the core answer version through client normalization', () => {
    expect(answerFromFixture({ schema_version: 'pia.answer/1' }).schema_version).toBe('pia.answer/1');
  });
});
