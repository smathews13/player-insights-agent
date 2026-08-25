/**
 * The two reads Ask PIA makes when it opens: the conversation list the rail is
 * built from, and the run list the rail's status pills come from.
 *
 * ONE EFFECT, TWO REQUESTS, BOTH IN FLIGHT AT ONCE. They used to be two separate
 * `useEffect`s in the page, which is not the same thing even though it looks it:
 * two effects run back-to-back so the requests did overlap, but nothing in the
 * page said they had to, and the arrangement is one edit away from becoming a
 * waterfall -- add an `await` to the first, or make the second depend on
 * something the first sets, and the rail suddenly loads in two round trips
 * instead of one. Stating the concurrency here makes it a property of the code
 * rather than an accident of effect ordering.
 *
 * WHY IT IS A MODULE. This suite has no jsdom, so a fetch written inside an
 * effect is unobservable: effects never run. "Each route is asked for exactly
 * once per load" is then the kind of claim that fails silently -- a duplicate
 * request breaks nothing visible, it just doubles the cost of opening the page,
 * so nobody finds out. Here it is a function a test can call with a stubbed
 * `fetch` and count.
 *
 * NEITHER FAILURE IS FATAL, AND THEY FAIL DIFFERENTLY. A rail with no status
 * pills is a rail; a rail with no conversations is an outage the reader has to
 * be told about. So the runs read fails silently to an empty map, and the
 * conversations read reports itself as unavailable. That difference is why this
 * returns one record describing both outcomes rather than throwing.
 */
import type { Conversation, Run } from './app-types';
import { listAvailability, listUnreachable, type ListAvailability } from './list-availability';
import { railRunSummaries, type RailRunSummary } from './rail-run-summary';
import {
  applyRememberedRunLabelOverrides,
  applyRememberedRunLabelOverridesToConversations,
} from './run-header-labels';

export interface InitialRail {
  /**
   * The latest answered turn per conversation, for the rail's pills.
   *
   * Empty where `/api/runs` could not be read, which is the same as empty where
   * nothing has been asked yet -- and deliberately so. The pills are a
   * decoration on a list of conversations, and a rail that announced an outage
   * of its decorations would be claiming its titles and dates were in doubt
   * when they are not.
   */
  runSummaries: Map<string, RailRunSummary>;
  /**
   * The conversations, or null where the list could not be read.
   *
   * Null rather than an empty array, because the two say opposite things: an
   * empty array is a store that answered and holds nothing, and this app has
   * been careful for a long time not to draw "no conversations yet" over an
   * outage. `availability` carries the same distinction for the surfaces that
   * render it as a sentence.
   */
  conversations: Conversation[] | null;
  availability: ListAvailability;
}

/**
 * The run summaries on their own, for the re-read after a question is answered.
 *
 * The page asks for these again once a turn completes, so the new answer's
 * status and rating appear on its row. That is a refresh of one thing rather
 * than of the whole rail, which is why it is exported separately.
 */
export async function readRunSummaries(): Promise<Map<string, RailRunSummary>> {
  try {
    const response = await fetch('/api/runs');
    if (!response.ok) return new Map();
    const rows = (await response.json()) as Run[];
    // Overlays saved in Run Explorer while Ask was unmounted. Without this the
    // first `/api/runs` map can still be Partial after the pencil wrote Complete.
    return applyRememberedRunLabelOverrides(railRunSummaries(rows));
  } catch {
    // No pills, and no stand-in ones.
    return new Map();
  }
}

export type ConversationList = Pick<InitialRail, 'conversations' | 'availability'>;

/**
 * The canonical list of conversations in Lakebase.
 *
 * Ask draws these rows directly and Run Explorer uses the same rows for its
 * conversation filter. Runs can describe a conversation, but they no longer
 * decide whether that conversation exists.
 */
export async function readConversationList(): Promise<ConversationList> {
  try {
    const response = await fetch('/api/conversations');
    if (!response.ok) throw new Error('Conversations unavailable');
    const items = (await response.json()) as Conversation[];
    return {
      conversations: applyRememberedRunLabelOverridesToConversations(items),
      // From the headers rather than from the row count: an unreadable store
      // answers with an empty array too, and only the header tells them apart.
      availability: listAvailability({ headers: response.headers, rowCount: items.length }),
    };
  } catch {
    return { conversations: null, availability: listUnreachable() };
  }
}

/** The two reads in flight, each awaitable on its own. */
export interface InitialRailReads {
  runSummaries: Promise<Map<string, RailRunSummary>>;
  conversations: Promise<ConversationList>;
}

/**
 * Both reads, started together and awaited SEPARATELY.
 *
 * The two `fetch` calls are issued here, before either is awaited, which is the
 * concurrency this module exists to state. What the caller gets back is two
 * promises rather than one, and that is the point: the page has a gate --
 * `conversationLoading` -- that hides the welcome screen and DISABLES THE
 * COMPOSER, and it must be cleared by the conversation list alone.
 *
 * Handing back one combined promise made that impossible, and it cost something
 * a reader feels. The run list is the heavier read and it feeds nothing but the
 * status pills on the rail, so waiting for both meant a decoration on the rail
 * could hold the text box shut on the page nearly every visit lands on.
 *
 * Neither promise rejects: each read handles its own failure, because both
 * callers are render paths with nowhere to put an exception.
 */
export function startInitialRail(): InitialRailReads {
  return { runSummaries: readRunSummaries(), conversations: readConversationList() };
}

/**
 * Both reads, resolved together, for a caller that genuinely wants the pair.
 *
 * NOT FOR A PAGE THAT GATES ANYTHING ON IT -- see `startInitialRail`, and the
 * `initial-rail.test.ts` case that pins Ask PIA off this function. `Promise.all`
 * over two promises that each already handle their own failure, so this never
 * rejects either: one route being down must not cost the caller the other
 * route's answer.
 */
export async function loadInitialRail(): Promise<InitialRail> {
  const reads = startInitialRail();
  const [runSummaries, list] = await Promise.all([reads.runSummaries, reads.conversations]);
  return { runSummaries, ...list };
}
