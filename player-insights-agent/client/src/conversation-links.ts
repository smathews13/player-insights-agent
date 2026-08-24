/**
 * Where a link into Ask PIA points, and how one answer inside a thread is named.
 *
 * This module exists because the two halves of that link were written in two
 * places and disagreed. The Run Explorer's "Open full response" pointed at
 * `/?conversation=<id>`; Ask PIA has only ever read `?c=`. Nothing failed
 * loudly -- the router matched `/`, the page mounted, and the effect that opens
 * a conversation found no parameter it recognised and opened none. A reader
 * clicking through from a trace landed on a fresh, empty conversation and was
 * given no reason to think they had missed anything, which is the worst shape
 * this defect could take: the link looked like it worked.
 *
 * The parameter name is now stated once, and both the page that writes the link
 * and the page that reads it import it from here. `conversation` remains a real
 * parameter in the other direction -- Ask PIA to Run Explorer, see Layout.tsx --
 * so the two spellings genuinely coexist, and a reader comparing the two files
 * had every reason to assume the one they were looking at was the shared one.
 *
 * `?a=` addresses a single answer. It is optional, and a link without it still
 * opens the right thread, because the conversation is the part the reader asked
 * for and the scroll position is the refinement.
 */

/** Ask landing: the tab root, with no conversation in the address. */
export const ASK_HOME_HREF = '/';

/** Search parameter the Ask PIA screen reads to open one conversation. */
export const CONVERSATION_PARAM = 'c';

/** Search parameter Ask PIA reads to bring one answer in that thread into view. */
export const ANSWER_PARAM = 'a';

/**
 * DOM id of the transcript row holding one answer.
 *
 * The id is the assistant message's own, which is also the run id: a
 * conversation run in `RUNS_QUERY` is derived from the message that carries the
 * trace and inherits its primary key. That equality is what lets the Run
 * Explorer address an answer at all -- it holds a run, not a message -- and it
 * is why this takes the id verbatim rather than lower-casing it the way
 * `entityRowId` does. A table name is spelled differently by different callers;
 * a message id has exactly one spelling and folding its case would break the
 * match against the transcript.
 */
export function answerRowId(messageId: string): string {
  return `answer-${messageId.trim()}`;
}

/**
 * Where a link to one conversation points, optionally naming one answer in it.
 *
 * Built with `encodeURIComponent` rather than `URLSearchParams`, which spells a
 * space `+`: these ids are `conv-<uuid>` and `msg-<uuid>` today and neither
 * form has a character to escape, so the choice is about what happens when that
 * stops being true rather than about anything visible now.
 */
export function conversationHref(conversationId: string, answerId?: string | null): string {
  const conversation = conversationId.trim();
  const answer = (answerId ?? '').trim();
  const target = `/?${CONVERSATION_PARAM}=${encodeURIComponent(conversation)}`;
  return answer ? `${target}&${ANSWER_PARAM}=${encodeURIComponent(answer)}` : target;
}
