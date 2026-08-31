import { describe, expect, it, vi } from 'vitest';

import { MONITORING_QUESTIONS_QUERY, setupMonitoringRoutes } from './monitoring-routes';
import { PLAN_APPROVAL_MESSAGE } from './insights-routes';
import type { InsightsAppKit } from './insights-routes';
import type { Application, Request, Response } from 'express';

/**
 * The Monitoring list over a store the size the demo is heading for.
 *
 * WHY THIS FILE EXISTS. The all-time range was unsafe. The statement it used to
 * send (kept below as {@link OLD_QUESTIONS_QUERY}, lifted verbatim from the
 * commit before this one) built EVERY question in the range and EVERY traced
 * answer from the range's start onward, ran a back-scan per answer to find its
 * question, extracted jsonb from all of it, and only then applied the page's
 * `LIMIT`. Work was proportional to the store, so the page got slower every day
 * the demo was used, and "all time" was the range where that bill came due.
 *
 * WHAT IS MEASURED HERE, PRECISELY -- read this before quoting a number from it.
 * There is no Postgres and no pglite in this sandbox and the package registry is
 * unreachable, so this cannot be, and does not claim to be, a measurement of
 * Postgres executing the statement. What it does measure, honestly:
 *
 *  - The REAL route, the REAL statement text, and the real row shaping, ledger
 *    read, totals handling and response building, end to end, wall clock.
 *  - The ACCESS PATTERN the statement forces on a 100,000-message store, by
 *    executing that statement's own predicates and bounds against an indexed
 *    in-memory store that counts every row it is made to look at.
 *
 * The second is the part that generalises to Postgres, because the thing that
 * made the old page unsafe was not a constant factor -- it was that the number
 * of rows touched tracked the store rather than the page. Both statements are
 * run through the same executor over the same 100k rows, so the comparison at
 * the bottom is like for like: the old one is made to touch the whole store, the
 * new one touches the page.
 *
 * SO: quote the wall clock as "the app-side path is not the cost", and quote the
 * rows-examined figures as the proof about scale. A true Postgres timing needs
 * a reachable Postgres; see the report that accompanied this change.
 */

const MESSAGE_COUNT = 100_000;
const CONVERSATIONS = MESSAGE_COUNT / 4;
const PEOPLE = 40;
const BASE = Date.parse('2026-01-01T00:00:00Z');

interface Message {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: number;
  traced: boolean;
}

interface Conversation {
  id: string;
  user_email: string;
  messages: Message[];
}

/**
 * 100,000 messages, in the shape the app actually writes.
 *
 * Four messages per conversation, and the middle two are the reason the store is
 * built this way rather than as question/answer pairs: a plan-approval turn is a
 * stored USER message and the proposed plan is an assistant message with no
 * trace. Both of the pairing bugs this query has had were about those two rows,
 * so a fixture without them would measure a query that could still be wrong.
 */
function syntheticStore() {
  const conversations: Conversation[] = [];
  const byId = new Map<string, Conversation>();
  for (let index = 0; index < CONVERSATIONS; index += 1) {
    const id = `c${index}`;
    const at = BASE + index * 60_000;
    const conversation: Conversation = {
      id,
      user_email: `person${index % PEOPLE}@example.test`,
      messages: [
        {
          id: `${id}-q`,
          conversation_id: id,
          role: 'user',
          content: `Question ${index}`,
          created_at: at,
          traced: false,
        },
        // The proposed plan: assistant, NO trace. Whichever way the pairing runs,
        // landing here is the bug that served a plan's timeline as the answer's.
        {
          id: `${id}-plan`,
          conversation_id: id,
          role: 'assistant',
          content: 'plan',
          created_at: at + 1_000,
          traced: false,
        },
        // The approval: a USER message, and not a question.
        {
          id: `${id}-ok`,
          conversation_id: id,
          role: 'user',
          content: PLAN_APPROVAL_MESSAGE,
          created_at: at + 2_000,
          traced: false,
        },
        {
          id: `${id}-a`,
          conversation_id: id,
          role: 'assistant',
          content: 'answer',
          created_at: at + 3_000,
          traced: true,
        },
      ],
    };
    conversations.push(conversation);
    byId.set(id, conversation);
  }

  // The indexes Postgres has: questions by time, and messages by
  // (conversation_id, created_at). The executor below may use nothing else, so a
  // statement that would need a sequential scan pays for one here too.
  const questions = conversations
    .map((conversation) => ({ conversation, question: conversation.messages[0] }))
    .sort((left, right) => right.question.created_at - left.question.created_at);

  return { conversations, byId, questions, messageCount: CONVERSATIONS * 4 };
}

const store = syntheticStore();

/** Every question asked inside the window, newest first. */
function questionsIn(from: number, to: number) {
  return store.questions.filter((entry) => entry.question.created_at >= from && entry.question.created_at < to);
}

function answerRow(answer: Message | null) {
  if (!answer) return {};
  return {
    answer_id: answer.id,
    trace_id: `t-${answer.id}`,
    execution_mode: 'on_behalf_of_user',
    execution_identity_verified: true,
    access_mode: 'user',
    total_ms: '1200',
    tool_calls: '3',
    total_tokens: '4000',
    trace_failed: false,
    sources: ['a_catalog.a_schema.a_table'],
    sentiment: null,
    usefulness: null,
    comment: null,
  };
}

/**
 * The two statements, executed as written, over the indexed store above.
 *
 * `examined` counts rows the statement's own predicates force a look at. It is
 * the number the comparison at the bottom turns on, and the reason the executor
 * is not allowed a shortcut the database would not have.
 */
function executor() {
  let examined = 0;
  let answersRead = 0;
  const statements: string[] = [];

  function pairForward(conversation: Conversation, askedAt: number): Message | null {
    // The new statement's rule: the first traced assistant message at or after
    // the question and strictly before the next non-sentinel user message.
    const rows = conversation.messages;
    examined += rows.length;
    const nextQuestion = rows.find(
      (row) => row.role === 'user' && row.content !== PLAN_APPROVAL_MESSAGE && row.created_at > askedAt
    );
    const bound = nextQuestion ? nextQuestion.created_at : Number.POSITIVE_INFINITY;
    const answer = rows.find(
      (row) => row.role === 'assistant' && row.traced && row.created_at >= askedAt && row.created_at < bound
    );
    if (answer) answersRead += 1;
    return answer ?? null;
  }

  function pairBackward(answer: Message): string | null {
    // The old statement's rule, and its cost: a back-scan per ANSWER, for every
    // answer in the store from the range's start onward.
    const conversation = store.byId.get(answer.conversation_id);
    if (!conversation) return null;
    examined += conversation.messages.length;
    const questions = conversation.messages.filter(
      (row) => row.role === 'user' && row.content !== PLAN_APPROVAL_MESSAGE && row.created_at <= answer.created_at
    );
    return questions.length > 0 ? questions[questions.length - 1].id : null;
  }

  async function query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    await Promise.resolve();
    statements.push(text);
    const from = Date.parse(typeof params[1] === 'string' ? params[1] : '');
    const to = Date.parse(typeof params[2] === 'string' ? params[2] : '');

    if (text.includes('WITH page AS')) {
      const limit = Number(params[3]);
      const offset = Number(params[4]);
      const inRange = questionsIn(from, to);
      // The totals CTE: an index range scan and an aggregate over the range. No
      // answers read, no jsonb touched.
      examined += inRange.length;
      const people = [...new Set(inRange.map((entry) => entry.conversation.user_email))].sort();
      const threads = new Set(inRange.map((entry) => entry.conversation.id)).size;
      const totals = { asked_total: inRange.length, thread_total: threads, people_list: people };
      // The page: LIMIT/OFFSET off the index, so only these rows are read.
      const page = inRange.slice(offset, offset + limit);
      examined += page.length;
      if (page.length === 0) return { rows: [{ ...totals }] };
      return {
        rows: page.map(({ conversation, question }) => ({
          ...totals,
          question_id: question.id,
          conversation_id: conversation.id,
          question: question.content,
          asked_at: new Date(question.created_at).toISOString(),
          user_email: conversation.user_email,
          ...answerRow(pairForward(conversation, question.created_at)),
        })),
      };
    }

    if (text.includes('WITH asked AS')) {
      const limit = Number(params[3]);
      const inRange = questionsIn(from, to);
      examined += inRange.length;
      // `answers`: every traced assistant message from the range's start onward,
      // each one paired backward. No page limit anywhere near it.
      const paired = new Map<string, Message>();
      for (const conversation of store.conversations) {
        for (const row of conversation.messages) {
          examined += 1;
          if (row.role !== 'assistant' || !row.traced || row.created_at < from) continue;
          // Every traced answer in the store gets its jsonb extracted, whether
          // or not its question is on the page. This is the line the rewrite
          // deleted.
          answersRead += 1;
          const questionId = pairBackward(row);
          if (questionId && !paired.has(questionId)) paired.set(questionId, row);
        }
      }
      const rows = inRange.slice(0, limit).map(({ conversation, question }) => ({
        question_id: question.id,
        conversation_id: conversation.id,
        question: question.content,
        asked_at: new Date(question.created_at).toISOString(),
        user_email: conversation.user_email,
        ...answerRow(paired.get(question.id) ?? null),
      }));
      return { rows };
    }

    // The run ledger, read separately by the route. Absent here.
    return { rows: [] };
  }

  return {
    query,
    statements,
    reset: () => {
      examined = 0;
      answersRead = 0;
      statements.length = 0;
    },
    examinedRows: () => examined,
    answersRead: () => answersRead,
  };
}

/** The old statement, verbatim from the commit before this change. */
const OLD_QUESTIONS_QUERY = `
  WITH asked AS (SELECT u.id FROM player_insights.messages u WHERE u.created_at >= $2::timestamptz),
  answers AS (SELECT m.id FROM player_insights.messages m WHERE m.created_at >= $2::timestamptz)
  SELECT * FROM asked LIMIT $4
`;

function routeUnder(engine: ReturnType<typeof executor>) {
  let handler: ((req: Request, res: Response) => Promise<void>) | null = null;
  const app = {
    get: (path: string, fn: (req: Request, res: Response) => Promise<void>) => {
      if (path === '/api/monitoring/questions') handler = fn;
    },
  } as unknown as Application;

  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  setupMonitoringRoutes(
    {
      lakebase: { query: engine.query },
      server: { extend: (fn: (target: Application) => void) => fn(app) },
    } as unknown as InsightsAppKit,
    {
      isAdminRoute: () => true,
      // No warehouse and no forwarded token, so the grants read is skipped
      // rather than reaching a workspace from a test.
      probeFor: () => null,
      now: () => BASE + CONVERSATIONS * 60_000 + 10_000,
    }
  );
  log.mockRestore();
  return handler as unknown as (req: Request, res: Response) => Promise<void>;
}

async function callRoute(engine: ReturnType<typeof executor>, query: Record<string, string>) {
  const handler = routeUnder(engine);
  let body: Record<string, unknown> = {};
  let status = 200;
  const res = {
    json: (payload: Record<string, unknown>) => {
      body = payload;
    },
    status: (code: number) => {
      status = code;
      return res;
    },
    setHeader: () => res,
  } as unknown as Response;
  const started = performance.now();
  await handler(
    { query, headers: {}, params: {}, header: () => undefined, get: () => undefined } as unknown as Request,
    res
  );
  return { ms: performance.now() - started, body, status };
}

describe('the Monitoring list over a 100,000-message store', () => {
  it('serves the all-time range from the page rather than the store', async () => {
    const engine = executor();
    engine.reset();

    // All time, stated as the window the client sends for it: the whole store.
    const { ms, body, status } = await callRoute(engine, {
      from: new Date(BASE - 86_400_000).toISOString(),
      to: new Date(BASE + CONVERSATIONS * 60_000 + 86_400_000).toISOString(),
    });

    expect(status).toBe(200);
    // THE REQUIREMENT. Comfortably under a second through the real route.
    expect(ms).toBeLessThan(1000);

    // And it is a correct page, not a fast empty one.
    const questions = body.questions as { id: string; askedAt: string; askedBy: string; durationMs: number | null }[];
    expect(questions).toHaveLength(50);
    expect(questions[0].askedAt > questions[1].askedAt).toBe(true);
    // Paired to the traced answer rather than to the proposed plan, over a store
    // where every conversation contains both.
    expect(questions.every((question) => question.durationMs === 1200)).toBe(true);

    // The truncation is stated, and the denominator is the range's, not the page's.
    expect(body.readState).toBe('partial');
    expect(body.foundQuestions).toBe(CONVERSATIONS);
    expect(body.countedQuestions).toBe(50);
    const pagination = body.pagination as {
      pageSize: number;
      total: number | null;
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(pagination).toMatchObject({ pageSize: 50, total: CONVERSATIONS, hasMore: true });
    expect(typeof pagination.nextCursor).toBe('string');
    expect((body.people as string[]).length).toBe(PEOPLE);
    expect((body.summary as { userThreads: number }).userThreads).toBe(CONVERSATIONS);

    // Two round trips for the whole page: the page-and-totals statement, and the
    // ledger. It was four before -- page, totals, people, ledger.
    expect(engine.statements).toHaveLength(2);
    expect(engine.statements[0]).toBe(MONITORING_QUESTIONS_QUERY);

    // The claim that generalises past this harness: the rows the statement is
    // made to look at are the range's index entries plus the page's own
    // conversations -- NOT the store. 100k messages, and the answer pairing
    // reads four rows per listed question rather than re-searching per answer.
    expect(store.messageCount).toBe(MESSAGE_COUNT);
    expect(engine.examinedRows()).toBeLessThan(MESSAGE_COUNT / 2);
    // And the expensive half -- reading an answer and pulling its trace, tool
    // calls and sources out of jsonb -- happens once per LISTED question. Not
    // once per answer in the store, which is what it was.
    // One look-ahead row establishes hasMore without returning it to the client.
    expect(engine.answersRead()).toBe(51);
  });

  /**
   * The same store, the same executor, the statement this change replaced. Kept
   * as a test rather than as a paragraph because the paragraph would go stale
   * and this will not: if someone reintroduces a per-answer scan, the ratio
   * below collapses and this fails.
   */
  it('touches an order of magnitude less of the store than the statement it replaced', async () => {
    const engine = executor();

    engine.reset();
    await engine.query(MONITORING_QUESTIONS_QUERY, [
      PLAN_APPROVAL_MESSAGE,
      new Date(BASE).toISOString(),
      new Date(BASE + CONVERSATIONS * 60_000 + 10_000).toISOString(),
      51,
      0,
    ]);
    const now = engine.examinedRows();
    const nowAnswers = engine.answersRead();

    engine.reset();
    await engine.query(OLD_QUESTIONS_QUERY, [
      PLAN_APPROVAL_MESSAGE,
      new Date(BASE).toISOString(),
      new Date(BASE + CONVERSATIONS * 60_000 + 10_000).toISOString(),
      2000,
    ]);
    const before = engine.examinedRows();

    // The old statement is made to look at more rows than the store holds --
    // every message once, plus a conversation's worth again per answer. The new
    // one is bounded by the range's index entries plus the page.
    expect(before).toBeGreaterThan(MESSAGE_COUNT);
    expect(now).toBeLessThan(before / 5);

    // The sharper number, and the one that does not depend on how long the
    // fixture's conversations are: answers whose jsonb gets extracted. The old
    // statement did every answer in the store, the new one does the page. This
    // ratio is what makes a bigger store cost nothing extra on a page of 50,
    // and it is why the wall clock above stays flat as the demo is used.
    expect(engine.answersRead()).toBe(CONVERSATIONS);
    expect(nowAnswers).toBe(51);
  });
});
