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
  'Optional tail was clipped at the DSF handoff bound, so some metadata fields may be incomplete.',
  'Validation: Review the sources before using this result.',
  'All 12 tables are declared but read access depends on the caller’s Unity Catalog grants — a declared table is not a guarantee of row-level access.',
  'All 12 tables are untagged by franchise in the current catalog listing; franchise-scoped filtering is not available from metadata alone.',
];

describe('answer content cleanup at render boundaries', () => {
  it('offers Generated SQL only when a statement exists', () => {
    expect(answerHasGeneratedSql('')).toBe(false);
    expect(answerHasGeneratedSql('  \n')).toBe(false);
    expect(answerHasGeneratedSql('SELECT 1')).toBe(true);
  });

  it('removes an empty Caveats section from a current structured answer', () => {
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
    expect(markup).not.toContain('Caveats');
    expect(markup).not.toMatch(/Partial evidence|optional tail|Validation:|declared table is not|untagged/i);
    expect(markup).not.toContain('show more');
  });

  it('normalizes an unparsed historical answer without altering quoted content', () => {
    const markup = renderToStaticMarkup(
      <StoredAnswerRenderer
        rawContent={[
          'Twelve tables are available.',
          'Optional tail was clipped at the DSF handoff bound, so some metadata fields may be incomplete.',
          'Validation: Review the sources before using this result.',
          '> "No SQL was generated or executed."',
        ].join('\n')}
        feedback={feedback}
        onFeedbackChange={() => {}}
        saveFeedback={async () => {}}
        showFeedback={false}
      />
    );
    expect(markup).toContain('Twelve tables are available.');
    expect(markup).not.toContain('Optional tail was clipped');
    expect(markup).not.toContain('Validation: Review');
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
    expect(markup).not.toContain('Caveats');
    expect(markup).not.toMatch(/Partial evidence|optional tail|Validation:|declared table is not|untagged/i);
  });

  it('keeps an actual permission failure in Caveats without an inline answer banner', () => {
    const answer = normalizeAnswer({
      id: 'msg-denied',
      mode: 'live',
      provenance: 'live',
      takeaway: 'Eleven tables were listed.',
      narrative: 'The requested catalog inventory completed for the readable tables.',
      caveats: ['Permission denied while reading main.private.players; request SELECT or omit that table.'],
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
    expect(markup).toContain('Caveats');
    expect(markup).not.toContain('Keep in mind');
    expect(markup).toContain('Permission denied');
    expect(markup).not.toContain('Partial evidence');
    expect(markup).not.toContain('data-variant="destructive"');
  });
});
