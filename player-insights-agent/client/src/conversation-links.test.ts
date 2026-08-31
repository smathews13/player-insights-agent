import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANSWER_PARAM, CONVERSATION_PARAM, answerRowId, conversationHref } from './conversation-links';

/**
 * The loop from a trace back to the conversation it came from.
 *
 * "Open full response" on a run's final-answer card pointed at
 * `/?conversation=<id>`. Ask PIA reads `?c=`. Both halves were written from a
 * plausible reading of the other page and neither was wrong on its own, so
 * nothing about the code looked broken: the route matched, the page mounted, and
 * the effect that opens a conversation found no parameter it recognised, opened
 * none, and left the reader on a fresh empty thread with no indication that the
 * link had failed to do anything. A link that silently lands somewhere plausible
 * is worse than one that errors, because the reader concludes the conversation
 * is gone rather than that the link is broken.
 *
 * `conversation` is a real parameter in the OTHER direction -- Ask PIA to Run
 * Explorer, built in Layout.tsx and read in RunExplorer.tsx -- which is why the
 * wrong spelling read as the right one to anyone comparing the two files. Both
 * directions are asserted here so a future edit cannot fix one by breaking the
 * other, which is the specific way this pair has failed before.
 *
 * The destination is checked by reading the built link back through
 * `URLSearchParams`, which is what the router hands the page, rather than by
 * matching the string: the assertion worth making is that the page's own getter
 * finds the conversation, not that the query string is spelled a particular way.
 * There is no jsdom in this repo, so what a real click does to real scroll
 * position is not asserted anywhere and is recorded as unverified.
 */

const HOME_PAGE = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
const RUN_EXPLORER = readFileSync(new URL('./RunExplorer.tsx', import.meta.url), 'utf8');
const RUN_EXPLORER_STATE = readFileSync(new URL('./run-explorer-state.ts', import.meta.url), 'utf8');
const FINAL_ANSWER = readFileSync(new URL('./FinalAnswer.tsx', import.meta.url), 'utf8');
const LAYOUT = readFileSync(new URL('./Layout.tsx', import.meta.url), 'utf8');

const CONVERSATION = 'conv-example-conversation';
const ANSWER = 'msg-example-answer';

/** What the router gives the page: the link's query, parsed. */
function queryOf(href: string): URLSearchParams {
  return new URL(href, 'https://player-insights.example').searchParams;
}

describe('the link from a run back to its conversation', () => {
  it('names the conversation under the parameter the Ask PIA screen reads', () => {
    expect(queryOf(conversationHref(CONVERSATION)).get(CONVERSATION_PARAM)).toBe(CONVERSATION);
  });

  it('lands on that conversation rather than on a fresh one', () => {
    // The front door this bug produced, stated as the thing that must not
    // happen: with no `c` in the query, HomePage mints `conv-<uuid>` and the
    // reader gets an empty thread. The old href is a link with no `c` in it.
    expect(queryOf('/?conversation=' + CONVERSATION).get(CONVERSATION_PARAM)).toBeNull();
    expect(queryOf(conversationHref(CONVERSATION)).get(CONVERSATION_PARAM)).not.toBeNull();
  });

  it('carries the answer when the run knows which one, and nothing extra when it does not', () => {
    expect(queryOf(conversationHref(CONVERSATION, ANSWER)).get(ANSWER_PARAM)).toBe(ANSWER);
    expect(queryOf(conversationHref(CONVERSATION, null)).get(ANSWER_PARAM)).toBeNull();
    // A run row whose id is absent must not put an empty anchor in the URL,
    // which would send the page looking for `answer-` and find nothing.
    expect(queryOf(conversationHref(CONVERSATION, '   ')).get(ANSWER_PARAM)).toBeNull();
  });

  it('keeps the conversation reachable even when the answer anchor is stale', () => {
    // The two halves are independent on purpose: an answer deleted since the
    // link was made must still open its thread.
    const query = queryOf(conversationHref(CONVERSATION, 'msg-gone'));
    expect(query.get(CONVERSATION_PARAM)).toBe(CONVERSATION);
  });

  it('spells one answer the same way from either side of the jump', () => {
    // The Run Explorer writes this id into the URL and the transcript writes it
    // onto the row. They are the same function or the jump silently misses.
    expect(answerRowId(ANSWER)).toBe(answerRowId(` ${ANSWER} `));
    expect(answerRowId(ANSWER)).toContain(ANSWER);
  });

  it('does not fold the case of a message id the way a table name is folded', () => {
    // `entityRowId` lower-cases, because callers spell a table name differently.
    // A message id has one spelling, and folding it would break the match.
    expect(answerRowId('MSG-ABC')).not.toBe(answerRowId('msg-abc'));
  });
});

describe('the pages at each end of that link', () => {
  it('builds the run explorer’s two links through the shared helper', () => {
    // Both the final answer's "Open full response" and the rating path. The
    // second had the identical defect and would have been left behind by a fix
    // that only touched the one in the bug report.
    expect(RUN_EXPLORER).toContain("import { conversationHref } from './conversation-links'");
    expect(FINAL_ANSWER).toContain("import { conversationHref } from './conversation-links'");
    expect(FINAL_ANSWER).toContain('to={conversationHref(conversationId, runId)}');
    expect(RUN_EXPLORER).toContain('conversationHref(selected.conversation_id, selected.id)');
  });

  it('leaves no hand-built link to Ask PIA in the run explorer', () => {
    // The whole defect, as a string. `/?conversation=` is the spelling Ask PIA
    // has never read.
    expect(RUN_EXPLORER).not.toContain('/?conversation=');
    expect(FINAL_ANSWER).not.toContain('/?conversation=');
  });

  it('uses the router rather than an anchor, so the jump keeps the app mounted', () => {
    // A raw `href` would reload the client, refetch every list and discard the
    // state the reader came from.
    expect(FINAL_ANSWER).toMatch(/<Link\s+className="final-answer-open"/);
    expect(RUN_EXPLORER).not.toMatch(/href=\{?["`]?\/\?/);
    expect(FINAL_ANSWER).not.toMatch(/href=\{?["`]?\/\?/);
  });

  it('reads both halves of the link on the Ask PIA side from the same definitions', () => {
    expect(HOME_PAGE).toContain("import { ANSWER_PARAM, CONVERSATION_PARAM, answerRowId } from './conversation-links'");
    expect(HOME_PAGE).toContain('searchParams.get(CONVERSATION_PARAM)');
    expect(HOME_PAGE).toContain('searchParams.get(ANSWER_PARAM)');
  });

  it('puts the answer’s id on the transcript row so the anchor has something to find', () => {
    // React's `key` never reaches the document. Before this the rows were keyed
    // by message id and carried no id at all, so no answer was addressable.
    expect(HOME_PAGE).toContain('id={answerRowId(message.id)}');
    expect(HOME_PAGE).toContain('document.getElementById(answerRowId(requestedAnswer))');
  });

  it('brings the requested answer into view instead of the end of the thread', () => {
    // The transcript scrolls to its end on every load. An answer halfway up a
    // long conversation is exactly the case this link exists for, so the
    // end-scroll has to stand down when an answer was named.
    const effect = /const requestedAnswer[\s\S]*?requestedAnswer\]\);/.exec(HOME_PAGE)?.[0] ?? '';
    expect(effect, 'the scroll effect reads the requested answer').not.toBe('');
    expect(effect).toContain("scrollIntoView({ block: 'center' })");
    // Honoured once, so asking a new question in a deep-linked conversation
    // still scrolls to the new answer rather than back to the linked one.
    expect(effect).toContain('scrolledToAnswerRef.current !== requestedAnswer');
  });
});

/**
 * The direction that was fixed deliberately and must not be undone.
 *
 * Clicking Run Explorer while a conversation was open used to drop the
 * conversation and open whoever's run was newest. It now carries `?conversation=`,
 * which is a DIFFERENT parameter from the `?c=` above, on purpose: `c` means a
 * conversation to open, `conversation` means a conversation to find a run for.
 */
describe('the way back into the Run Explorer', () => {
  it('carries the open conversation from Ask PIA into the run list', () => {
    expect(LAYOUT).toContain("searchParams.get('c')");
    expect(LAYOUT).toMatch(/\/runs\?conversation=\$\{encodeURIComponent\(openConversation\)\}/);
  });

  it('only reads that conversation while Ask PIA is the page on screen', () => {
    // Other pages have their own query strings and none of them mean this.
    expect(LAYOUT).toContain("location.pathname === '/' ? searchParams.get('c') : null");
  });

  it('opens the run belonging to that conversation rather than the newest one', () => {
    expect(RUN_EXPLORER).toContain("searchParams.get('conversation')");
    expect(RUN_EXPLORER).toContain('resolveRunSelection(runs, requestedId, requestedConversation)');
    expect(RUN_EXPLORER_STATE).toMatch(
      /requestedConversationId[\s\S]*?runs\.find\(\(run\) => run\.conversation_id === requestedConversationId\)[\s\S]*?\?\?\s*runs\[0\]/
    );
  });

  /**
   * Carrying the conversation over decides which run OPENS. It must not decide
   * which runs are LISTED.
   *
   * The filter used to start at the carried-over id, so arriving from a
   * question you had just asked showed a run list with one row in it. Nothing
   * announced that a filter was on -- the dropdown reads as a label, not as
   * state somebody set -- so the honest reading of that screen was "this
   * deployment has answered one question", and the reader had no reason to open
   * the dropdown to find out otherwise.
   */
  it('does not pin the run list to the conversation it arrived with', () => {
    const filterState = /const \[conversationFilter, setConversationFilter\] = useState\(([^)]*)\);/.exec(RUN_EXPLORER);
    expect(filterState, 'the conversation filter is held in state on the Run Explorer').not.toBeNull();
    // Empty string: every conversation, which is what "All conversations" in
    // the dropdown is the label for.
    expect(filterState?.[1].trim()).toBe("''");
    expect(filterState?.[0]).not.toContain('searchParams');
  });
});
