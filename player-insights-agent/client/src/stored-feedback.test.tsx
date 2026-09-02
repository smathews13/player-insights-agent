import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { feedbackDirection } from '../../shared/feedback-direction';
import { AnswerCard } from './AnswerCard';
import { normalizeAnswer, type WireAnswer } from './answer-shape';
import type { Answer, ConversationMessage } from './app-types';
import { EMPTY_FEEDBACK, feedbackFromStored } from './stored-feedback';

function reopened(columns: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'Active players rose 4%.',
    ...columns,
  };
}

function answer(): Answer {
  return normalizeAnswer({
    id: 'msg-1',
    mode: 'live',
    takeaway: 'Active players rose 4%.',
    narrative: 'Active players rose 4% over the period.',
    figures: [],
    sources: [],
    caveats: [],
    sql: 'SELECT 1',
    trace: { id: 'tr-1', totalMs: 10, toolCalls: 1, stages: [] },
  } as WireAnswer) as Answer;
}

function markup(feedback = EMPTY_FEEDBACK): string {
  return renderToStaticMarkup(
    <AnswerCard
      answer={answer()}
      feedback={feedback}
      onFeedbackChange={() => undefined}
      saveFeedback={() => Promise.resolve()}
      showFeedback
    />
  );
}

describe('stored canonical feedback', () => {
  it('prefers explicit sentiment and restores only a down comment', () => {
    const state = feedbackFromStored([
      reopened({ feedback_sentiment: 'down', usefulness: 5, feedback_comment: 'Wrong time window.' }),
      reopened({ id: 'msg-2', feedback_sentiment: 'up', feedback_comment: 'Obsolete negative note.' }),
    ]);
    expect(state['msg-1']).toMatchObject({
      saved: true,
      sentiment: 'down',
      comment: 'Wrong time window.',
    });
    expect(state['msg-2']).toMatchObject({ saved: true, sentiment: 'up', comment: '' });
  });

  it('maps legacy rows without turning neutral feedback into a direction', () => {
    expect(feedbackDirection(null, 5)).toBe('up');
    expect(feedbackDirection(null, 4)).toBe('up');
    expect(feedbackDirection(null, 2)).toBe('down');
    expect(feedbackDirection(null, 1)).toBe('down');
    expect(feedbackDirection(null, 3)).toBeNull();
    expect(feedbackDirection('down', 5)).toBe('down');
  });

  it('restores mixed-version legacy rows but emits canonical state', () => {
    const state = feedbackFromStored([reopened({ usefulness: '4' })]);
    expect(state['msg-1'].sentiment).toBe('up');
    expect(state['msg-1'].usefulness).toBeUndefined();
  });

  it('renders pressed accessible thumbs and no star scale', () => {
    const up = markup({ ...EMPTY_FEEDBACK, saved: true, sentiment: 'up' });
    const down = markup({
      ...EMPTY_FEEDBACK,
      saved: true,
      sentiment: 'down',
      open: true,
      comment: 'Missing comparison.',
    });
    expect(up).toMatch(/aria-label="Mark answer helpful"[^>]*aria-pressed="true"/);
    expect(down).toMatch(/aria-label="Mark answer not helpful"[^>]*aria-pressed="true"/);
    expect(down).toContain('aria-label="Tell us what could be better"');
    const feedbackMarkup = [up, down]
      .map((value) => value.slice(value.indexOf('<div class="feedback">'), value.indexOf('<p class="ai-note"')))
      .join('');
    expect(feedbackMarkup.replace(/<[^>]+>/g, ' ')).not.toMatch(/★|⭐|\/5|of 5/i);
  });
});
