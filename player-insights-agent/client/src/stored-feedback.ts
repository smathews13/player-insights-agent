/**
 * The ratings a reopened conversation already has, read off its rows.
 *
 * The defect this exists for, as reported: a reader rates an answer, is told
 * "Feedback saved", navigates away, comes back, and the rating is gone. The write
 * was never the problem. `POST /api/feedback` inserts the row and answers 503
 * when the store refuses it, the browser reports that refusal rather than
 * claiming success, and Run Explorer reads those same rows and shows the score.
 * What was missing is this direction: the conversation route returned the message
 * and its identity columns and said nothing about the rating, and the browser
 * held ratings in session state that started empty on every load. So the answer
 * came back unrated because nothing had ever told it otherwise.
 *
 * Exactly the shape of the identity defect fixed earlier: stored correctly, not
 * returned when the conversation is reloaded, and invisible to anything that only
 * watched one session. See reloaded-answer-identity.test.ts.
 *
 * A module of its own rather than a closure inside the page, so the read-back can
 * be tested as what it is -- rows in, state out -- without rendering anything.
 */

import type { ConversationMessage, FeedbackEntry } from './app-types';

/** The state of an answer nobody has rated. */
export const EMPTY_FEEDBACK: FeedbackEntry = {
  open: false,
  comment: '',
  saved: false,
  saving: false,
  error: null,
  usefulness: null,
};

/**
 * The rating a row carries, or null.
 *
 * Postgres hands an integer column back as a number and a `NUMERIC` as a string,
 * and this column has been both; parsed rather than cast for that reason. Out of
 * range is treated as absent, because the write path constrains it to 1-5 and a
 * value outside that is not a rating this app produced.
 */
export function storedRating(row: Pick<ConversationMessage, 'usefulness'>): number | null {
  const value = typeof row.usefulness === 'string' ? Number(row.usefulness) : row.usefulness;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value >= 1 && value <= 5 ? value : null;
}

/**
 * What each thumb writes, named where the reading of it lives.
 *
 * The card used to spell 5 and 2 at three call sites -- both icons and the
 * comment box's Save -- against a `ratedThumb` in this file that decides what
 * those numbers light. Naming them here means the control and the reading of it
 * cannot drift apart into a rating that is stored but lights nothing.
 */
export const UP_RATING = 5;
export const DOWN_RATING = 2;

/**
 * Which way a rating reads as a thumb.
 *
 * The two controls write `UP_RATING` and `DOWN_RATING`, which is what the thumbs
 * mean here rather than an inference about them. Anything in between is a rating
 * that says neither, and it lights neither control rather than being rounded
 * into one.
 */
export function ratedThumb(usefulness: number | null): 'up' | 'down' | null {
  if (usefulness === null) return null;
  if (usefulness >= 4) return 'up';
  return usefulness <= 2 ? 'down' : null;
}

/**
 * Every stored rating in a reopened conversation, keyed by the message it is on.
 *
 * `saved` is true for these, because they are saved: it is the same green
 * confirmation the reader was shown when they gave the rating, and it is now true
 * of the store rather than of one render. Rows with no rating are left out
 * entirely, so an unrated answer stays untouched rather than being given an
 * entry that says it was rated nothing.
 */
export function feedbackFromStored(messages: ConversationMessage[]): Record<string, FeedbackEntry> {
  const entries: Record<string, FeedbackEntry> = {};
  for (const message of messages) {
    const usefulness = storedRating(message);
    if (usefulness === null) continue;
    entries[message.id] = {
      ...EMPTY_FEEDBACK,
      saved: true,
      usefulness,
      comment: typeof message.feedback_comment === 'string' ? message.feedback_comment : '',
    };
  }
  return entries;
}
