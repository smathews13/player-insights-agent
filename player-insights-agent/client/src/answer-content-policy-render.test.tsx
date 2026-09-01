import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AnswerCard } from './AnswerCard';
import { FinalAnswer } from './FinalAnswer';
import StoredAnswerRenderer from './StoredAnswerRenderer';
import { answerHasGeneratedSql } from './answer-sql';
import { normalizeAnswer } from './answer-shape';
import type { Answer, FeedbackEntry } from './app-types';

const feedback: FeedbackEntry = {
  open: false,
  comment: '',
  saved: false,
  saving: false,
  error: null,
  usefulness: null,
};

const processCaveats = [
  'No governed table was read for this answer, so it is not grounded in queried data.',
  'Review the generated SQL and source details before using this result.',
];

describe('answer content cleanup at render boundaries', () => {
  it('offers Generated SQL only when a statement exists', () => {
    expect(answerHasGeneratedSql('')).toBe(false);
    expect(answerHasGeneratedSql('  \n')).toBe(false);
    expect(answerHasGeneratedSql('SELECT 1')).toBe(true);
  });

  it('removes an empty Keep in mind section from a current structured answer', () => {
    const answer = normalizeAnswer({
      id: 'msg-live',
      mode: 'live',
      provenance: 'live',
      takeaway: 'Twelve tables are available.',
      narrative: 'Use `data_dictionary` for field definitions.',
      caveats: processCaveats,
      sql: '',
      sources: [],
    });
    const markup = renderToStaticMarkup(
      <AnswerCard
        answer={answer as Answer}
        feedback={feedback}
        onFeedbackChange={() => {}}
        saveFeedback={async () => {}}
        showFeedback={false}
      />
    );
    expect(markup).not.toContain('Keep in mind');
    expect(markup).not.toMatch(/no governed table|not grounded|generated SQL|source details/i);
  });

  it('normalizes an unparsed historical answer without altering quoted content', () => {
    const markup = renderToStaticMarkup(
      <StoredAnswerRenderer
        rawContent={[
          'Twelve tables are available.',
          'No governed table was read for this answer, so it is not grounded in queried data.',
          '> "No SQL was generated or executed."',
        ].join('\n')}
        feedback={feedback}
        onFeedbackChange={() => {}}
        saveFeedback={async () => {}}
        showFeedback={false}
      />
    );
    expect(markup).toContain('Twelve tables are available.');
    expect(markup).not.toContain('No governed table was read');
    expect(markup).toContain('No SQL was generated or executed.');
  });

  it('applies the same evidence-aware policy in Run Explorer', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <FinalAnswer
          takeaway="Twelve tables are available."
          narrative="Use the dictionary for field definitions."
          sources={[]}
          caveats={processCaveats}
        />
      </MemoryRouter>
    );
    expect(markup).not.toContain('Keep in mind');
    expect(markup).not.toMatch(/no governed table|not grounded|generated SQL|source details/i);
  });
});
