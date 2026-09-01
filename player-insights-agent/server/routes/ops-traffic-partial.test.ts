/**
 * What the Traffic block says when one of its three reads did not answer.
 *
 * THE FAULT THIS FILE EXISTS FOR. Traffic is three independent reads drawn as
 * three charts. They are settled rather than awaited together, deliberately, so
 * that a deployment without the run ledger still gets its questions chart. But
 * the block only reported a reason when ALL THREE rejected, so one read timing
 * out drew an empty chart under a heading that names a population: a page
 * asserting nobody asked anything, in a deployment where the store simply could
 * not be reached in time. A thirty-second statement limit landed on these reads
 * this week, which turns that from theoretical into the ordinary way a busy
 * deployment fails.
 *
 * Zero and "we could not establish it" have to be different on screen. So:
 *
 *  - Every read answering, with nothing in the range, is a genuine zero and
 *    says nothing extra.
 *  - One or two failing keeps the charts that answered and names the ones that
 *    did not, in `unread`.
 *  - All three failing is still the whole block's failure, in `reason`, which is
 *    the field the page substitutes the block for.
 *
 * `unread` and `reason` are therefore not two spellings of one thing:
 * `reason` REPLACES the charts and `unread` stands beside them.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  DISTINCT_ASKERS_PER_DAY_QUERY,
  QUESTIONS_PER_DAY_QUERY,
  RUN_OUTCOMES_QUERY,
  setupOpsRoutes,
} from './ops-routes';
import { ACTIVE_MINUTES_PER_DAY_QUERY } from '../lib/app-activity';
import { LEGACY_TRAFFIC_BREAKDOWNS_QUERY, RAW_TRAFFIC_BREAKDOWNS_QUERY } from '../lib/ops-traffic';
import type { OpsTrafficPayload } from '../../shared/ops-contract';
import type { InsightsAppKit } from './insights-routes';
import type { Application, Request, Response } from 'express';

/** Which independent reads answer, and which reject. */
type Answers = {
  questions: boolean;
  outcomes: boolean;
  tools: boolean;
  askers?: boolean;
  activeMinutes?: boolean;
};

const REFUSAL = 'canceling statement due to statement timeout';

const ROWS: Record<string, Record<string, unknown>[]> = {
  [QUESTIONS_PER_DAY_QUERY]: [{ day: '2026-08-14', count: 12 }],
  [DISTINCT_ASKERS_PER_DAY_QUERY]: [{ day: '2026-08-14', count: 4 }],
  [ACTIVE_MINUTES_PER_DAY_QUERY]: [{ day: '2026-08-14', count: 80 }],
  [RUN_OUTCOMES_QUERY]: [
    { kind: 'population', key: '', count: 2 },
    { kind: 'failure', key: 'WAREHOUSE_UNAVAILABLE', count: 2 },
    { kind: 'tool', key: 'genie', count: 30 },
  ],
};

/** The traffic handler, over three reads that answer or reject as asked. */
function trafficRoute(answers: Answers, rows: Record<string, Record<string, unknown>[]> = ROWS) {
  let handler: ((req: Request, res: Response) => Promise<void>) | null = null;
  const app = {
    get: (path: string, fn: (req: Request, res: Response) => Promise<void>) => {
      if (path === '/api/ops/traffic') handler = fn;
    },
  } as unknown as Application;

  const answering: Record<string, boolean> = {
    [QUESTIONS_PER_DAY_QUERY]: answers.questions,
    [DISTINCT_ASKERS_PER_DAY_QUERY]: answers.askers ?? true,
    [ACTIVE_MINUTES_PER_DAY_QUERY]: answers.activeMinutes ?? true,
  };

  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  setupOpsRoutes(
    {
      lakebase: {
        query: (text: string) => {
          if (
            text === RUN_OUTCOMES_QUERY ||
            text === RAW_TRAFFIC_BREAKDOWNS_QUERY ||
            text === LEGACY_TRAFFIC_BREAKDOWNS_QUERY
          ) {
            return answers.outcomes && answers.tools
              ? Promise.resolve({ rows: rows[RUN_OUTCOMES_QUERY] ?? [] })
              : Promise.reject(new Error(REFUSAL));
          }
          return answering[text] ? Promise.resolve({ rows: rows[text] ?? [] }) : Promise.reject(new Error(REFUSAL));
        },
      },
      server: { extend: (fn: (target: Application) => void) => fn(app) },
    } as unknown as InsightsAppKit,
    { isAdminRoute: () => true }
  );
  log.mockRestore();
  return handler as unknown as (req: Request, res: Response) => Promise<void>;
}

async function trafficPayload(answers: Answers, rows?: Record<string, Record<string, unknown>[]>) {
  const handler = trafficRoute(answers, rows);
  let body = {} as OpsTrafficPayload;
  const res = {
    json: (payload: OpsTrafficPayload) => {
      body = payload;
    },
    status: () => res,
    setHeader: () => res,
  } as unknown as Response;
  await handler({ query: {}, headers: {}, params: {} } as unknown as Request, res);
  return body;
}

const ALL = { questions: true, askers: true, activeMinutes: true, outcomes: true, tools: true };

describe('the Traffic block when a read is cut off', () => {
  /**
   * THE CLAIM, and the reason the file is here. One read gone must not leave
   * the page drawing a population of nobody.
   */
  it('says which chart could not be read rather than drawing it empty', async () => {
    const payload = await trafficPayload({ ...ALL, questions: false });

    expect(payload.unread).not.toBe('');
    expect(payload.unread.toLowerCase()).toContain('questions per day');
    // And the store's own words, so an operator can tell a timeout from a
    // missing table without opening a log.
    expect(payload.unread).toContain(REFUSAL);
  });

  /**
   * The two that answered are still on the page. Discarding them would trade
   * one false chart for three absent ones, which is the trade the previous
   * behaviour was defending against and it was right to.
   */
  it('keeps the charts that did answer', async () => {
    const payload = await trafficPayload({ ...ALL, questions: false });

    expect(payload.reason).toBe('');
    expect(payload.questionsPerDay).toEqual([]);
    expect(payload.failuresByCause).toHaveLength(1);
    expect(payload.toolCalls).toHaveLength(1);
    expect(payload.runsInRange).toBe(2);
  });

  /** Two gone names both, in one line rather than two sentences. */
  it('names both when questions and the consolidated breakdown are cut off', async () => {
    const payload = await trafficPayload({ questions: false, outcomes: false, tools: true });

    const said = payload.unread.toLowerCase();
    expect(said).toContain('questions per day');
    expect(said).toContain('failures, refusals and tool calls');
    expect(payload.reason).toBe('');
    expect(payload.toolCalls).toEqual([]);
  });

  it('keeps question and run charts when recorded active minutes cannot be read', async () => {
    const payload = await trafficPayload({ ...ALL, activeMinutes: false });

    expect(payload.reason).toBe('');
    expect(payload.unread).toContain('Recorded active app minutes per day');
    expect(payload.questionsPerDay).toHaveLength(1);
    expect(payload.distinctAskersPerDay).toHaveLength(1);
    expect(payload.activeMinutesPerDay).toEqual([]);
  });

  /**
   * The run ledger carries the denominator as well as the two cause charts, so
   * losing it must not leave a run count standing that nothing counted.
   */
  it('claims no run count when the ledger is the read that failed', async () => {
    const payload = await trafficPayload({ ...ALL, outcomes: false });

    expect(payload.runsInRange).toBe(0);
    expect(payload.unread.toLowerCase()).toContain('failures, refusals and tool calls');
  });

  /**
   * All three gone is the whole block, and it stays in `reason`, which is the
   * field the page substitutes the block for. Reporting it in `unread` would
   * draw three empty charts above a line explaining them.
   */
  it('still fails the whole block when nothing answered', async () => {
    const payload = await trafficPayload({
      questions: false,
      askers: false,
      activeMinutes: false,
      outcomes: false,
      tools: false,
    });

    expect(payload.reason).toContain('Nothing about traffic could be read');
    expect(payload.unread).toBe('');
  });
});

describe('the Traffic block over a range that genuinely holds nothing', () => {
  /**
   * The other half of the claim, and the one a fix for the above breaks first.
   * Three reads that answered with no rows is a measured zero, and it must not
   * acquire a line hinting that something went wrong.
   */
  it('says nothing extra, because zero is an answer', async () => {
    const payload = await trafficPayload(ALL, {
      [QUESTIONS_PER_DAY_QUERY]: [],
      [DISTINCT_ASKERS_PER_DAY_QUERY]: [],
      [ACTIVE_MINUTES_PER_DAY_QUERY]: [],
      [RUN_OUTCOMES_QUERY]: [{ kind: 'population', key: '', count: 0 }],
    });

    expect(payload.unread).toBe('');
    expect(payload.reason).toBe('');
    expect(payload.questionsPerDay).toEqual([]);
    expect(payload.distinctAskersPerDay).toEqual([]);
    expect(payload.activeMinutesPerDay).toEqual([]);
    expect(payload.runsInRange).toBe(0);
  });
});
