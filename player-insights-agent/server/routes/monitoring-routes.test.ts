import { describe, expect, it, vi } from 'vitest';

import {
  MONITORING_DETAIL_QUERY,
  MONITORING_QUESTIONS_QUERY,
  MONITORING_ROUTES,
  questionFromRow,
  rangeFrom,
  setupMonitoringRoutes,
  summarize,
  tokenCost,
  QUESTION_READ_LIMIT,
} from './monitoring-routes';
// The guard's own predicate, not a copy of it. A test against a restatement of
// the prefix list would pass while the list and the routes disagreed.
import { isAdminRoute } from '../lib/admin-roles';
// Run Explorer's own query, which reads this data correctly and is the reference
// the answer join is held against.
import { RUNS_QUERY, PLAN_APPROVAL_MESSAGE } from './insights-routes';
import type { InsightsAppKit } from './insights-routes';
import type { Request } from 'express';

/**
 * What the read routes make of the rows the stores hand them.
 *
 * The claim these tests exist for, above all the shaping: these routes will not
 * register without an admin guard. They serve every person's questions and
 * answers, and a guard with a default is a guard somebody eventually forgets to
 * pass, at which point the failure is silent.
 */

const ledger = (entries: [string, { state: string; code: string | null }][] = []) => new Map(entries);

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question_id: 'q1',
    conversation_id: 'c1',
    question: 'A question.',
    asked_at: '2026-08-15T10:00:00Z',
    user_email: 'first.person@example.test',
    answer_id: 'a1',
    total_ms: '76200',
    tool_calls: '5',
    trace_failed: false,
    sources: ['a_catalog.a_schema.a_table'],
    // What a rated answer actually looks like in the table. The thumbs in
    // AnswerCard.tsx write `usefulness` 5 and 2 and leave `sentiment` null, so a
    // fixture that set `sentiment: 'up'` was asserting against a column no code
    // path writes. Every rating test passed while the rated-helpful tile read
    // nothing but nulls in production.
    sentiment: null,
    usefulness: 5,
    ...overrides,
  };
}

describe('the routes will not register unless the admin guard covers them', () => {
  function fakeAppkit() {
    const extend = vi.fn();
    return { appkit: { lakebase: { query: vi.fn() }, server: { extend } } as unknown as InsightsAppKit, extend };
  }

  /**
   * THE FAILURE THIS GUARDS AGAINST. The guard is one `app.use` that decides
   * whether to refuse by testing the path against a prefix list in another file.
   * A route added under a path that list does not name is served to everybody, and
   * nothing anywhere fails.
   */
  it('registers every route it declares, and the real prefix list covers each', () => {
    expect(MONITORING_ROUTES.length).toBeGreaterThan(0);
    for (const path of MONITORING_ROUTES) {
      expect(isAdminRoute(path), path).toBe(true);
    }
  });

  it('registers nothing when the predicate is missing', () => {
    const { appkit, extend } = fakeAppkit();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    setupMonitoringRoutes(appkit, {} as never);

    expect(extend).not.toHaveBeenCalled();
    // Loud. A 404 on Monitoring is reported in a minute; an unguarded one is a
    // disclosure nobody notices.
    expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT REGISTERED'));
    error.mockRestore();
  });

  it('registers nothing when one path is outside the guard, and names it', () => {
    const { appkit, extend } = fakeAppkit();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    setupMonitoringRoutes(appkit, { isAdminRoute: (path) => !path.includes('people') });

    expect(extend).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('/api/monitoring/people/:email'));
    error.mockRestore();
  });

  it('registers once every path is covered', () => {
    const { appkit, extend } = fakeAppkit();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    setupMonitoringRoutes(appkit, { isAdminRoute });

    expect(extend).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});

describe('the query reads questions rather than answers', () => {
  it('bounds the range, drops the plan sentinel, and caps the read', () => {
    expect(MONITORING_QUESTIONS_QUERY).toContain("u.role = 'user'");
    expect(MONITORING_QUESTIONS_QUERY).toContain('u.content <> $1');
    expect(MONITORING_QUESTIONS_QUERY).toContain('u.created_at >= $2::timestamptz');
    expect(MONITORING_QUESTIONS_QUERY).toContain('LIMIT $4');
    expect(QUESTION_READ_LIMIT).toBeGreaterThan(0);
  });

  /**
   * The feedback route accepts any message id, so without the email predicate this
   * would show whatever score anybody else submitted against the same answer.
   */
  it('scopes the rating to the person who asked', () => {
    expect(MONITORING_QUESTIONS_QUERY).toContain('fb.user_email = q.user_email');
  });

  /**
   * The ledger is read separately. Its table can be legitimately absent on a
   * database where the app's role does not own the schema, and joining it here
   * would make an absent ledger take the whole page down.
   */
  it('does not join the run ledger', () => {
    expect(MONITORING_QUESTIONS_QUERY).not.toContain('player_insights.runs');
  });

  /**
   * The bug this file exists to keep out.
   *
   * A conversation that went through plan approval stores the proposed plan as an
   * assistant message with no trace, then the answer. Walking forward to the
   * first assistant message landed on the plan, so a run with a recorded
   * duration, seven tool calls and a five-star rating reported none of the three.
   * Asserted against `RUNS_QUERY` rather than against a restatement of it,
   * because a copy of the rule can pass here while the two surfaces disagree.
   */
  it('counts only an assistant message that carries a trace as the answer', () => {
    const traceIsAnObject = "jsonb_typeof(m.response_json->'trace') = 'object'";

    expect(RUNS_QUERY).toContain(traceIsAnObject);
    expect(MONITORING_QUESTIONS_QUERY).toContain(traceIsAnObject);
    expect(MONITORING_DETAIL_QUERY).toContain(traceIsAnObject);
    expect(MONITORING_QUESTIONS_QUERY).toContain('AS answer_landed');
    expect(MONITORING_DETAIL_QUERY).toContain('AS answer_landed');
    expect(MONITORING_QUESTIONS_QUERY).toContain('AS synthesis_incomplete');
    expect(MONITORING_DETAIL_QUERY).toContain('AS synthesis_incomplete');
    expect(MONITORING_QUESTIONS_QUERY).toContain('AS overlay_status');
    expect(MONITORING_DETAIL_QUERY).toContain('AS overlay_status');
    expect(MONITORING_QUESTIONS_QUERY).toContain('declared tables');
  });

  /**
   * The approval turn is a stored user message, so the last user message before
   * an answer is the approval unless the sentinel is skipped. Pairing backward
   * also stops an unanswered question from adopting the next question's answer.
   */
  it('pairs an answer to its question backward, skipping the approval turn', () => {
    expect(MONITORING_DETAIL_QUERY).toContain("u.role = 'user'");
    expect(MONITORING_DETAIL_QUERY).toContain('ORDER BY u.created_at DESC LIMIT 1');

    // The list states the same rule from the question's side, because it now
    // reads the newest questions first and looks each answer up rather than
    // walking back from every answer in the range. Stated forward, "the last
    // non-sentinel user message at or before the answer" is "the first traced
    // assistant message after the question and before the NEXT non-sentinel user
    // message" -- so the boundary below IS the backward pairing, and an
    // unanswered question cannot adopt the next question's answer without it.
    expect(MONITORING_QUESTIONS_QUERY).toContain("u.role = 'user'");
    expect(MONITORING_QUESTIONS_QUERY).toContain('u.content <> $1');
    expect(MONITORING_QUESTIONS_QUERY).toContain('u.created_at > q.asked_at');
    expect(MONITORING_QUESTIONS_QUERY).toContain("'infinity'::timestamptz");
  });

  /**
   * One literal, from the module that writes it. A second copy that drifted would
   * start counting approvals as questions and pairing answers to the approval.
   */
  it('skips the same approval sentinel the ask route writes', () => {
    expect(PLAN_APPROVAL_MESSAGE).toBe('Approved the proposed analysis plan.');
  });

  /**
   * An answer can land after the range ends for a question asked just inside it,
   * and it is still that question's answer.
   */
  it('does not bound the answer scan by the end of the range', () => {
    // The lower bound is now the question's own time, which is per question and
    // tighter than the range's start. What matters is what is still missing: no
    // upper bound at the range's end, so an answer that landed after the window
    // closed is still found for a question asked just inside it.
    expect(MONITORING_QUESTIONS_QUERY).toContain('m.created_at >= q.asked_at');
    expect(MONITORING_QUESTIONS_QUERY).not.toContain('m.created_at < $3::timestamptz');
  });
});

describe('a range is bounded rather than trusted', () => {
  const now = Date.parse('2026-08-15T12:00:00Z');
  const request = (query: Record<string, string>) => ({ query }) as unknown as Request;

  it('uses the window the caller asked for', () => {
    const range = rangeFrom(request({ from: '2026-08-01T00:00:00Z', to: '2026-08-08T00:00:00Z' }), now);

    expect(range.from).toBe('2026-08-01T00:00:00.000Z');
    expect(range.to).toBe('2026-08-08T00:00:00.000Z');
  });

  /**
   * These values reach a timestamp cast, and an unparseable bound left open would
   * make this query read every message ever stored.
   */
  it('falls back to seven days rather than to an open interval', () => {
    for (const query of [{}, { from: 'yesterday', to: 'today' }, { from: '2026-08-08T00:00:00Z' }]) {
      expect(rangeFrom(request(query as Record<string, string>), now).from).toBe('2026-08-08T12:00:00.000Z');
    }
  });

  it('refuses a range that ends before it starts', () => {
    const range = rangeFrom(request({ from: '2026-08-08T00:00:00Z', to: '2026-08-01T00:00:00Z' }), now);

    expect(range.from).toBe('2026-08-08T12:00:00.000Z');
  });
});

describe('one row, from what the stores recorded', () => {
  it('prefers the ledger verdict and carries the taxonomy sentence', () => {
    const question = questionFromRow(row(), ledger([['a1', { state: 'REFUSED', code: 'USER_NOT_AUTHORIZED' }]]));

    expect(question.outcome).toBe('refused');
    expect(question.outcomeDetail).toBe(
      'You do not have access to one or more data products required by this question.'
    );
  });

  it('falls back to the trace when there is no ledger row', () => {
    expect(questionFromRow(row(), ledger()).outcome).toBe('completed');
    expect(questionFromRow(row({ trace_partial: true }), ledger()).outcome).toBe('partial');
    expect(questionFromRow(row({ trace_failed: true }), ledger()).outcome).toBe('failed');
    expect(
      questionFromRow(row({ trace_failed: true, answer_landed: true }), ledger()).outcome
    ).toBe('completed');
    expect(
      questionFromRow(row({ synthesis_incomplete: true, answer_landed: true }), ledger()).outcome
    ).toBe('partial');
  });

  it('calls a finished catalog listing Completed even when a step was stored partial', () => {
    const catalog = questionFromRow(
      row({
        question_id: 'tables',
        answer_id: 'msg-tables',
        trace_partial: true,
        answer_landed: true,
        synthesis_incomplete: false,
      }),
      ledger()
    );
    expect(catalog.outcome).toBe('completed');
  });

  it('shows an administrator’s Complete on the Monitoring row and in the KPI count', () => {
    const overlaid = questionFromRow(
      row({
        question_id: 'tables',
        answer_id: 'msg-tables',
        trace_partial: true,
        overlay_status: 'complete',
      }),
      ledger()
    );
    const leftover = questionFromRow(row({ question_id: 'q2', answer_id: 'a2', trace_partial: true }), ledger());
    expect(overlaid.outcome).toBe('completed');
    expect(leftover.outcome).toBe('partial');
    const summary = summarize([overlaid, leftover], 1);
    expect(summary.completed).toBe(1);
    expect(summary.partial).toBe(1);
  });

  it('records a question with no terminal answer as partial', () => {
    expect(questionFromRow(row({ answer_id: null }), ledger()).outcome).toBe('partial');
  });

  /**
   * No sentence at all where no code was recorded. A generic one would be this
   * build describing a refusal it has no definition of.
   */
  it('offers no sentence for a failure nobody named', () => {
    expect(questionFromRow(row(), ledger([['a1', { state: 'FAILED', code: null }]])).outcomeDetail).toBeNull();
  });

  it('reports an unrecorded duration as null rather than as zero', () => {
    const question = questionFromRow(row({ total_ms: null, tool_calls: null }), ledger());

    expect(question.durationMs).toBeNull();
    expect(question.toolCalls).toBeNull();
  });

  /**
   * A bare table name is the tail of an object rather than an object. It cannot be
   * probed for a grant and it cannot be linked, so counting one would put a row on
   * the grants table that no GRANT statement could clear.
   */
  it('keeps only fully-qualified table names', () => {
    const question = questionFromRow(
      row({ sources: ['a_catalog.a_schema.a_table', 'bare_name', 'a_catalog.a_schema', ''] }),
      ledger()
    );

    expect(question.tables).toEqual(['a_catalog.a_schema.a_table']);
  });

  /**
   * The thumbs are stored as a score. AnswerCard.tsx calls `saveFeedback(5)` for
   * thumbs up and `saveFeedback(2)` for thumbs down, and the ask route writes
   * that number to `usefulness` with `sentiment` left null. Reading `sentiment`
   * alone meant every rating read as absent, and the tile said "no answers were
   * rated in this range" over a range holding ratings.
   */
  it('reads the thumb from the score the app actually writes', () => {
    expect(questionFromRow(row({ sentiment: null, usefulness: 5 }), ledger()).rating).toBe('up');
    expect(questionFromRow(row({ sentiment: null, usefulness: 2 }), ledger()).rating).toBe('down');
  });

  it('prefers a recorded sentiment over the score', () => {
    expect(questionFromRow(row({ sentiment: 'down', usefulness: 5 }), ledger()).rating).toBe('down');
    expect(questionFromRow(row({ sentiment: 'maybe', usefulness: 2 }), ledger()).rating).toBe('down');
  });

  /**
   * A 3 is a score with no direction, so it counts in neither half of the
   * rated-helpful tile rather than counting against the answer.
   */
  it('reports no thumb for an unrated answer or a score with no direction', () => {
    expect(questionFromRow(row({ sentiment: null, usefulness: null }), ledger()).rating).toBeNull();
    expect(questionFromRow(row({ sentiment: null, usefulness: 3 }), ledger()).rating).toBeNull();
  });
});

describe('the summary counts what it read', () => {
  it('counts the four outcomes separately and never their sum', () => {
    const summary = summarize(
      [
        questionFromRow(row({ question_id: '1', answer_id: 'a' }), ledger([['a', { state: 'SUCCEEDED', code: null }]])),
        questionFromRow(
          row({ question_id: '2', answer_id: 'b' }),
          ledger([['b', { state: 'REFUSED', code: 'USER_NOT_AUTHORIZED' }]])
        ),
        questionFromRow(
          row({ question_id: '3', answer_id: 'c' }),
          ledger([['c', { state: 'FAILED', code: 'DEPENDENCY_UNAVAILABLE' }]])
        ),
      ],
      3
    );

    expect(summary.completed).toBe(1);
    expect(summary.partial).toBe(0);
    expect(summary.refused).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.questionsAsked).toBe(3);
    // There is no field holding refused plus failed, which is the only reliable
    // way to stop one appearing on screen.
    expect(Object.keys(summary)).not.toContain('unsuccessful');
  });

  it('counts only rated answers into the rated population', () => {
    const summary = summarize(
      [
        questionFromRow(row({ question_id: '1', usefulness: 5 }), ledger()),
        questionFromRow(row({ question_id: '2', usefulness: 2 }), ledger()),
        // Unrated, so absent from both halves rather than counted as unhelpful.
        questionFromRow(row({ question_id: '3', usefulness: null }), ledger()),
      ],
      1
    );

    expect(summary.ratedUp).toBe(1);
    expect(summary.ratedTotal).toBe(2);
  });

  it('reports a median only over the runs that recorded a time', () => {
    const summary = summarize(
      [
        questionFromRow(row({ question_id: '1', total_ms: '1000' }), ledger()),
        questionFromRow(row({ question_id: '2', total_ms: '3000' }), ledger()),
        questionFromRow(row({ question_id: '3', total_ms: null }), ledger()),
      ],
      1
    );

    expect(summary.medianMs).toBe(1000);
    expect(summary.timedCount).toBe(2);
    expect(summary.questionsAsked).toBe(3);
  });

  it('reports no median at all when nothing recorded a time', () => {
    expect(summarize([questionFromRow(row({ total_ms: null }), ledger())], 1).medianMs).toBeNull();
  });
});

describe('a cost is null until a price is configured', () => {
  const VARIABLE = 'PLAYER_INSIGHTS_TOKEN_PRICE_PER_MILLION_USD';

  it('answers null rather than zero when no price is set', () => {
    const previous = process.env[VARIABLE];
    delete process.env[VARIABLE];

    expect(tokenCost(412_000)).toBeNull();

    if (previous !== undefined) process.env[VARIABLE] = previous;
  });

  it('computes from the configured price', () => {
    const previous = process.env[VARIABLE];
    process.env[VARIABLE] = '10';

    expect(tokenCost(412_000)).toBeCloseTo(4.12, 5);

    if (previous === undefined) delete process.env[VARIABLE];
    else process.env[VARIABLE] = previous;
  });

  it('answers null for a price that is not a number', () => {
    const previous = process.env[VARIABLE];
    process.env[VARIABLE] = 'ask finance';

    expect(tokenCost(412_000)).toBeNull();

    if (previous === undefined) delete process.env[VARIABLE];
    else process.env[VARIABLE] = previous;
  });
});
