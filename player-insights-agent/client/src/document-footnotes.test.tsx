import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnswerCard } from './AnswerCard';
import { normalizeAnswer, type WireAnswer } from './answer-shape';
import type { Answer, FeedbackEntry } from './app-types';

const feedback: FeedbackEntry = {
  open: false,
  comment: '',
  saved: false,
  saving: false,
  error: null,
  usefulness: null,
};

function render(document_snippets: unknown): string {
  const answer = normalizeAnswer({
    id: 'msg-1',
    mode: 'live',
    takeaway: 'The attached report supports the finding.',
    narrative: 'The report identifies the priority cohort.',
    figures: [],
    sources: [],
    document_snippets,
    caveats: [],
    sql: '',
    trace: {
      id: 'trace-1',
      totalMs: 100,
      toolCalls: 1,
      stages: [{ id: 'attachment', name: 'Included conversation attachment', status: 'complete' }],
    },
  } as WireAnswer) as Answer;
  return renderToStaticMarkup(
    <AnswerCard
      answer={answer}
      feedback={feedback}
      onFeedbackChange={() => {}}
      saveFeedback={async () => {}}
      showFeedback={false}
    />
  );
}

describe('attached document footnotes', () => {
  it('renders the quoted snippet and its filename', () => {
    const markup = render([
      {
        filename: 'briefing.pdf',
        quote: 'Prioritize returning players in the launch window.',
        supports: 'the recommended audience',
      },
    ]);

    expect(markup).toContain('Document footnotes');
    expect(markup).toContain('briefing.pdf');
    expect(markup).toContain('Prioritize returning players');
    expect(markup).not.toContain('includes no document footnotes');
  });

  it('warns when an attachment was used without a snippet', () => {
    expect(render([])).toContain('includes no document footnotes or quoted snippets');
  });
});
