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
import { feedbackDirection } from '../../shared/feedback-direction';

/** The state of an answer nobody has rated. */
export const EMPTY_FEEDBACK: FeedbackEntry = {
  open: false,
  comment: '',
  saved: false,
  saving: false,
  error: null,
  sentiment: null,
};

/**
 * Every stored feedback direction in a reopened conversation, keyed by message.
 *
 * The server resolves legacy usefulness before this boundary and exposes only
 * `feedback_sentiment`. A mixed-version server may still omit that field; an
 * omitted direction remains No feedback rather than reviving a numeric scale in
 * the browser.
 */
export function feedbackFromStored(messages: ConversationMessage[]): Record<string, FeedbackEntry> {
  const entries: Record<string, FeedbackEntry> = {};
  for (const message of messages) {
    const sentiment = feedbackDirection(message.feedback_sentiment, message.usefulness);
    if (sentiment === null) continue;
    entries[message.id] = {
      ...EMPTY_FEEDBACK,
      saved: true,
      sentiment,
      comment: sentiment === 'down' && typeof message.feedback_comment === 'string' ? message.feedback_comment : '',
    };
  }
  return entries;
}
