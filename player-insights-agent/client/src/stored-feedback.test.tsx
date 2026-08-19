import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AnswerCard } from './AnswerCard';
import { normalizeAnswer, type WireAnswer } from './answer-shape';
import { EMPTY_FEEDBACK, feedbackFromStored, ratedThumb, storedRating } from './stored-feedback';
import type { Answer, ConversationMessage } from './app-types';

/**
 * Whether a rating survives a reload, which is the only sense in which it is saved.
 *
 * Reported from the live app: the reader rates an answer, sees "Feedback saved",
 * navigates away, comes back, and both thumbs are blank. Two things could have
 * caused that and they need opposite fixes, so the first job was to find out
 * which. The write lands. `POST /api/feedback` inserts the row and answers 503 if
 * the store refuses it, HomePage throws on anything but a 2xx and shows the
 * failure instead of the confirmation, and Run Explorer reads those same rows and
 * renders the score -- which is why a run from the same evening shows a rating at
 * all. The read was missing: the conversation route returned the message and its
 * identity columns and nothing about the rating, and the browser kept ratings in
 * session state that begins empty on every load.
 *
 * So this file is about the second direction only, and it is written as a reload:
 * rows in, state out, and then the markup a reader is actually shown. Clicking
 * twice in one session was what made this look fixed for as long as it did.
 */

const CARD = readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8');
const PAGE = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
const ROUTES = readFileSync(new URL('../../server/routes/insights-routes.ts', import.meta.url), 'utf8');

/** A stored assistant turn, as `GET /api/conversations/:id/messages` returns one. */
function reopened(columns: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'Active players rose 4%.',
    response_json: { id: 'msg-1', takeaway: 'Active players rose 4%.' },
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

/** The text of the card's footer, tags removed, as a reader reads it. */
function cardText(feedback: Parameters<typeof AnswerCard>[0]['feedback']): string {
  return renderToStaticMarkup(
    <AnswerCard
      answer={answer()}
      feedback={feedback}
      onFeedbackChange={() => {}}
      saveFeedback={async () => {}}
      showFeedback
    />
  )
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The rendered markup of that card, for the state on the controls themselves. */
function cardMarkup(feedback: Parameters<typeof AnswerCard>[0]['feedback']): string {
  return renderToStaticMarkup(
    <AnswerCard
      answer={answer()}
      feedback={feedback}
      onFeedbackChange={() => {}}
      saveFeedback={async () => {}}
      showFeedback
    />
  );
}

describe('a rating read back out of the store', () => {
  it('comes back saved, with the rating it was given', () => {
    const state = feedbackFromStored([reopened({ usefulness: 5 })]);

    expect(state['msg-1'].saved).toBe(true);
    expect(state['msg-1'].usefulness).toBe(5);
  });

  it('brings the comment back with it, so the box holds what was said', () => {
    const state = feedbackFromStored([reopened({ usefulness: 2, feedback_comment: 'The window is wrong.' })]);

    expect(state['msg-1'].comment).toBe('The window is wrong.');
  });

  it('reads a rating the driver handed back as a string', () => {
    // Postgres returns an integer as a number and a numeric as a string, and this
    // column has been both. A string was previously not a rating at all.
    expect(storedRating({ usefulness: '4' })).toBe(4);
    expect(storedRating({ usefulness: 4 })).toBe(4);
  });

  it('gives an unrated answer no entry at all, rather than a rating of nothing', () => {
    // An entry with `saved: false` would be indistinguishable from one the reader
    // is part-way through, and an entry saying the answer was rated null is a
    // claim nobody made.
    expect(feedbackFromStored([reopened(), reopened({ id: 'msg-2', usefulness: null })])).toEqual({});
  });

  it('ignores a value outside the range the write path allows', () => {
    for (const value of [0, 6, -1, 'nonsense', {}, undefined]) {
      expect(storedRating({ usefulness: value })).toBe(null);
    }
  });

  it('keeps every answer’s rating on its own answer', () => {
    const state = feedbackFromStored([
      reopened({ id: 'msg-1', usefulness: 5 }),
      reopened({ id: 'msg-2', usefulness: 2 }),
      reopened({ id: 'msg-3' }),
    ]);

    expect(Object.keys(state)).toEqual(['msg-1', 'msg-2']);
    expect(state['msg-1'].usefulness).toBe(5);
    expect(state['msg-2'].usefulness).toBe(2);
  });
});

describe('what the reader is shown for a rating that was saved', () => {
  it('marks the thumb they pressed, rather than only saying something was saved', () => {
    const markup = cardMarkup({ ...EMPTY_FEEDBACK, saved: true, usefulness: 5 });

    // The pressed state is on the control, not only in a colour: two blank thumbs
    // and a green tick beside them is what a reader reads as "it did not stick".
    expect(markup).toMatch(/aria-label="Thumbs up"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="Thumbs up"/);
    expect(markup).toContain('feedback-chosen');
    expect(cardText({ ...EMPTY_FEEDBACK, saved: true, usefulness: 5 })).toContain('Feedback saved');
  });

  it('marks the other thumb for a rating that went the other way', () => {
    const markup = cardMarkup({ ...EMPTY_FEEDBACK, saved: true, usefulness: 2 });

    expect(markup).toMatch(/aria-label="Thumbs down"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="Thumbs down"/);
  });

  it('says nothing was saved when nothing was', () => {
    const text = cardText(EMPTY_FEEDBACK);

    expect(text).toContain('Was this answer useful?');
    expect(text).not.toContain('Feedback saved');
    expect(cardMarkup(EMPTY_FEEDBACK)).not.toContain('feedback-chosen');
  });

  it('reports a write that failed, and marks no thumb for it', () => {
    // The confirmation must not be able to appear over a rating that did not
    // reach the table, and neither must a pressed thumb: both say it landed.
    const failed = { ...EMPTY_FEEDBACK, error: 'The rating was not recorded (HTTP 503).' };

    expect(cardText(failed)).toContain('The rating was not recorded (HTTP 503).');
    expect(cardText(failed)).not.toContain('Feedback saved');
    expect(cardMarkup(failed)).not.toContain('feedback-chosen');
  });

  it('lights neither control for a rating that means neither', () => {
    expect(ratedThumb(3)).toBe(null);
    expect(ratedThumb(null)).toBe(null);
    expect(ratedThumb(5)).toBe('up');
    expect(ratedThumb(2)).toBe('down');
  });
});

describe('the two places the rating had to travel through', () => {
  it('is selected by the route that serves a reopened conversation', () => {
    // The projection is where it stopped. Asserted on the query rather than
    // through a live database, in the pattern the identity columns are pinned in:
    // what has to be true is that this SELECT names the column at all.
    const query = ROUTES.slice(ROUTES.indexOf('function conversationMessagesQuery'));
    const select = query.slice(0, query.indexOf('return sharedRail.shared'));
    // The route must follow APP_SCHEMA in every deployment; pin both the
    // interpolation and the absence of the old hardcoded default.
    expect(select).toContain('${APP_SCHEMA}.feedback');
    expect(select).not.toContain('player_insights.feedback');
    expect(select).toContain('AS usefulness');
    expect(select).toContain('AS feedback_comment');
    // Scoped to the caller. `feedback.message_id` has no foreign key and the
    // feedback route accepts any id, so without this a reopened answer would show
    // whichever score somebody else gave it.
    expect(select).toContain('f.user_email = $2');
  });

  it('passes the caller on both branches of that query, shared rail included', () => {
    const query = ROUTES.slice(ROUTES.indexOf('function conversationMessagesQuery'));
    const branches = query.slice(query.indexOf('return sharedRail.shared'), query.indexOf('\n}'));
    // Two `params` arrays, and the shared one used to carry the conversation id
    // alone. A rating is one reader's opinion and is not shared with the thread.
    expect(branches.match(/params: \[conversationId, email\]/g)?.length).toBe(2);
  });

  it('seeds the page’s feedback state from those rows on load', () => {
    // `setFeedback({})` on its own is what a reopened conversation used to get.
    const load = PAGE.slice(PAGE.indexOf('const selectConversation'), PAGE.indexOf('async function uploadAttachments'));
    expect(load).toContain('feedbackFromStored(stored)');
  });

  it('shows the controls on an older answer that carries a rating', () => {
    // They were drawn on the last answer only, so a rating given earlier in a
    // thread came back with nowhere to appear.
    //
    // Two assertions rather than one because the transcript row became a
    // memoized component: the row is handed one entry rather than the whole
    // record, so the lookup and the decision are now two lines instead of one
    // expression. Both halves still have to be true, and they are the halves
    // that broke -- the lookup keyed by the ANSWER's id (not the message's, they
    // are not always the same value), and a saved entry forcing the controls on
    // whatever its position in the thread.
    expect(CARD).toContain('aria-pressed={rated ===');
    expect(PAGE).toContain('feedback[response.id]');
    expect(PAGE).toContain('|| Boolean(entry.saved)');
  });
});
