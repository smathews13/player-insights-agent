import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BENCHMARK_RUN_INSERT,
  BENCHMARK_RUN_UPDATE,
  BENCHMARK_RUNNING_QUERY,
  BENCHMARK_SUITE_QUERY,
  buildRetrievalContext,
  countOutcomes,
  decideOutcome,
  deriveStatus,
  evaluateStructuralChecks,
  parseServedModel,
  startBenchmarkRun,
  sweepStaleRuns,
  requestBenchmarkCancel,
  summariseJudge,
  type AgentTurn,
  type BenchmarkAnswer,
  type BenchmarkRunnerDeps,
} from './benchmark-runner';
import { BUDGET_TRUNCATION_CODE, SUITE_CANCELLED_CODE, type BenchmarkRunMetrics } from '../../shared/benchmark-contract';
import { GROUNDEDNESS_FEEDBACK_NAME } from './mlflow-judges';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface StoredRun {
  suite_id: string;
  user_email: string;
  status: string;
  metrics_json: string;
  created_at: string;
}

class FakeStore {
  runs = new Map<string, StoredRun>();
  calls: { text: string; params: unknown[] }[] = [];
  suiteRows: Record<string, unknown>[] = [
    { id: 'poc-benchmark', name: 'POC benchmark suite', description: 'd', cases_json: JSON.stringify([{ id: 'player-count' }, { id: 'access-boundary' }]) },
  ];
  failSuiteRead = false;
  failInsert = false;
  failUpdateAfter: number | null = null;
  private updates = 0;

  query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ text, params });
    if (text.includes('INSERT INTO player_insights.benchmark_runs')) {
      if (this.failInsert) return Promise.reject(new Error('insert refused'));
      const [id, suiteId, email, status, metrics] = params as string[];
      this.runs.set(id, {
        suite_id: suiteId,
        user_email: email,
        status,
        metrics_json: metrics,
        created_at: new Date().toISOString(),
      });
      return Promise.resolve({ rows: [] });
    }
    if (text.includes('UPDATE player_insights.benchmark_runs')) {
      this.updates += 1;
      if (this.failUpdateAfter !== null && this.updates > this.failUpdateAfter) {
        return Promise.reject(new Error('update refused'));
      }
      const [id, status, metrics] = params as string[];
      const existing = this.runs.get(id);
      if (existing) this.runs.set(id, { ...existing, status, metrics_json: metrics });
      return Promise.resolve({ rows: [] });
    }
    if (text.includes('FROM player_insights.benchmark_suites')) {
      if (this.failSuiteRead) return Promise.reject(new Error('suite read refused'));
      const ids = (params[0] as string[]) ?? [];
      return Promise.resolve({ rows: this.suiteRows.filter((row) => ids.includes(String(row.id))) });
    }
    if (text.includes('FROM player_insights.benchmark_runs')) {
      if (text.includes('WHERE id =')) {
        const run = this.runs.get(String(params[0]));
        return Promise.resolve({
          rows: run ? [{ metrics_json: run.metrics_json, status: run.status }] : [],
        });
      }
      const email = params[0];
      const rows = [...this.runs.entries()]
        .filter(([, run]) => run.user_email === email && run.status === 'running')
        .map(([id, run]) => ({ id, suite_id: run.suite_id, metrics_json: run.metrics_json, created_at: run.created_at }));
      return Promise.resolve({ rows });
    }
    throw new Error(`unexpected query: ${text}`);
  }

  metrics(id: string): BenchmarkRunMetrics {
    const run = this.runs.get(id);
    if (!run) throw new Error(`no run ${id}`);
    return JSON.parse(run.metrics_json) as BenchmarkRunMetrics;
  }

  raw(id: string): string {
    return this.runs.get(id)?.metrics_json ?? '';
  }
}

function makeAnswer(overrides: Partial<BenchmarkAnswer> = {}): BenchmarkAnswer {
  return {
    id: 'answer-1',
    takeaway: 'Engagement is up.',
    narrative: 'Across the three titles, session counts rose.',
    sql: 'SELECT 1',
    figures: [{ label: 'Active players', display: '12', comparison: 'up' }],
    charts: [{ id: 'c1', title: 'Players by title' }],
    sources: [{ name: 'catalog.schema.table', freshness: 'fresh' }],
    caveats: [],
    trace: {
      id: 'tr-1',
      totalMs: 1234.6,
      toolCalls: 2,
      stages: [{ id: 's1', name: 'Data', kind: 'sql', status: 'complete', input: 'q', output: 'rows: 3' }],
      ...(overrides.trace ?? {}),
    },
    ...overrides,
  };
}

function judgeReply(result: 'yes' | 'no') {
  return {
    choices: [{ message: { content: JSON.stringify({ rationale: "Let's think step by step. Because.", result }) } }],
  };
}

function makeClock(startIso = '2026-08-05T07:00:00.000Z', stepMs = 1_000) {
  let value = Date.parse(startIso);
  return () => {
    value += stepMs;
    return value;
  };
}

function makeDeps(store: FakeStore, overrides: Partial<BenchmarkRunnerDeps> = {}): BenchmarkRunnerDeps {
  let sequence = 0;
  return {
    store,
    identity: {
      email: 'sam@example.com',
      mode: 'signed_in_user',
      verified: true,
      // No declared expiry by default, which is the opaque-token case and the
      // one where the runner has to rely on the endpoint rather than on a
      // check of its own. Overridden by the tests that are about the clock.
      lifetime: { expiresAtMs: null, unknownReason: 'the token is opaque rather than a JWT' },
    },
    requestedSuiteId: 'poc-benchmark',
    askAgent: () => Promise.resolve<AgentTurn>({ type: 'answer', answer: makeAnswer() }),
    judge: { invoke: () => Promise.resolve(judgeReply('yes')), judgeEndpoint: 'databricks-claude-sonnet-4-5' },
    now: makeClock(),
    newId: () => `run-${(sequence += 1)}`,
    describeServedModel: () =>
      Promise.resolve({
        endpoint: 'player-insights-agent',
        entityName: '<your_catalog>-<your_schema>-player_insights_agent',
        version: '9',
        determinate: true,
        routes: [{ name: '<your_catalog>-<your_schema>-player_insights_agent_9', trafficPercentage: 100 }],
        note: 'All traffic on one route.',
      }),
    ...overrides,
  };
}

async function run(deps: BenchmarkRunnerDeps) {
  const started = await startBenchmarkRun(deps);
  if (started.status !== 202) throw new Error(`expected 202, got ${started.status}: ${JSON.stringify(started.body)}`);
  await started.completed;
  return started;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// The defect this module exists to remove
// ---------------------------------------------------------------------------

describe('what a run must not invent', () => {
  it('writes no rating, because a rating is human input', async () => {
    const store = new FakeStore();
    const started = await run(makeDeps(store));
    const metrics = store.metrics(started.body.id);
    // `RUNS_QUERY` reads `metrics_json->>'rating'`, so the absence of this key
    // is what makes Run Explorer show no stars instead of the five nobody gave.
    expect('rating' in (metrics as unknown as Record<string, unknown>)).toBe(false);
    expect(store.raw(started.body.id)).not.toContain('"rating"');
  });

  it('stores the snake_case keys /api/runs reads back out of metrics_json', async () => {
    const store = new FakeStore();
    const started = await run(makeDeps(store));
    const metrics = store.metrics(started.body.id) as unknown as Record<string, unknown>;

    // `RUNS_QUERY` selects `metrics_json->>'prompt'` and
    // `(metrics_json->>'duration_ms')::int` by those exact names. This assertion
    // moved here from the route's own tests, where it pinned the constants of the
    // function that used to fabricate this row: the read path it protects is
    // still real, so it now guards the writer that replaced it.
    expect(metrics.prompt).toContain('POC benchmark suite');
    expect(metrics.duration_ms).toBe(metrics.durationMs);
    expect(typeof metrics.duration_ms).toBe('number');
  });

  it('records none of the constants the old route returned', async () => {
    const store = new FakeStore();
    const started = await run(makeDeps(store));
    const raw = store.raw(started.body.id);
    for (const fabrication of ['0.92', '0.89', '7340', '"passed":8', '"total":10']) {
      expect(raw, `stored metrics still contain the fabricated value ${fabrication}`).not.toContain(fabrication);
    }
  });

  it('records which model version answered, and says so when it cannot', async () => {
    const store = new FakeStore();
    const started = await run(makeDeps(store));
    expect(store.metrics(started.body.id).servedModel).toMatchObject({ version: '9', determinate: true });

    const blind = new FakeStore();
    const secondRun = await run(makeDeps(blind, { describeServedModel: undefined }));
    const servedModel = blind.metrics(secondRun.body.id).servedModel;
    expect(servedModel.determinate).toBe(false);
    expect(servedModel.version).toBeNull();
    expect(servedModel.note).toContain('unknown');
  });

  it('never claims to be the managed Databricks judge, and says which model scored it', async () => {
    const store = new FakeStore();
    const started = await run(makeDeps(store));
    const metrics = store.metrics(started.body.id);

    // The only place the phrase may appear is inside a denial of it.
    expect(metrics.judge.disclosure).toContain('not the Databricks managed judge');
    const everywhereElse = JSON.stringify({ ...metrics, judge: { ...metrics.judge, disclosure: '' } }).toLowerCase();
    expect(everywhereElse).not.toContain('managed');

    // And every individual score carries the model that produced it, so a
    // rationale copied out of the data still says what scored it.
    expect(metrics.judge.promptVersion).toBe('mlflow-3.14.0');
    expect(metrics.judge.badge).toContain('databricks-claude-sonnet-4-5');
    for (const judgement of metrics.cases.flatMap((entry) => entry.judgements)) {
      expect(judgement.provenance).toContain('databricks:/databricks-claude-sonnet-4-5');
      expect(judgement.promptVersion).toBe('mlflow-3.14.0');
    }
  });
});

// ---------------------------------------------------------------------------
// Which model version answered
// ---------------------------------------------------------------------------

describe('reading the served model version', () => {
  /** The live endpoint's actual reply shape: REST snake_case, not the SDK's camelCase types. */
  const liveShape = {
    config: {
      traffic_config: {
        routes: [
          { served_model_name: '<your_catalog>-<your_schema>-player_insights_agent_9', traffic_percentage: 100 },
          { served_model_name: '<your_catalog>-<your_schema>-player_insights_agent_8', traffic_percentage: 0 },
        ],
      },
      served_entities: [
        { name: '<your_catalog>-<your_schema>-player_insights_agent_9', entity_name: '<your_catalog>.<your_schema>.player_insights_agent', entity_version: '9' },
        { name: '<your_catalog>-<your_schema>-player_insights_agent_8', entity_name: '<your_catalog>.<your_schema>.player_insights_agent', entity_version: '8' },
      ],
    },
  };

  it('reads the snake_case body the SDK actually returns', () => {
    // The experimental SDK's types promise camelCase and the runtime hands back
    // the REST body's snake_case. A camelCase-only reader finds nothing and
    // reports the version as unknown, which is how the first live run of this
    // runner recorded "not determinate" against an endpoint sitting at 100% on
    // one version.
    const parsed = parseServedModel('player-insights-agent', liveShape);
    expect(parsed).toMatchObject({ version: '9', determinate: true, entityName: '<your_catalog>.<your_schema>.player_insights_agent' });
    expect(parsed.routes).toHaveLength(2);
    expect(parsed.note).toContain('version 9');
  });

  it('reads camelCase too, so an SDK upgrade does not silently lose the version', () => {
    const parsed = parseServedModel('ep', {
      config: {
        trafficConfig: { routes: [{ servedModelName: 'm_3', trafficPercentage: 100 }] },
        servedEntities: [{ name: 'm_3', entityName: 'cat.sch.m', entityVersion: '3' }],
      },
    });
    expect(parsed).toMatchObject({ version: '3', determinate: true });
  });

  it('refuses to attribute a split endpoint to one version', () => {
    const parsed = parseServedModel('ep', {
      config: {
        traffic_config: { routes: [{ served_model_name: 'm_9', traffic_percentage: 70 }, { served_model_name: 'm_8', traffic_percentage: 30 }] },
        served_entities: [{ name: 'm_9', entity_version: '9' }, { name: 'm_8', entity_version: '8' }],
      },
    });
    // Naming the majority route would be a guess presented as a measurement,
    // and a version 10 release is staging beside this one.
    expect(parsed.determinate).toBe(false);
    expect(parsed.version).toBeNull();
    expect(parsed.routes).toHaveLength(2);
    expect(parsed.note).toContain('split');
  });

  it('says so when there is no traffic configuration at all', () => {
    const parsed = parseServedModel('ep', {});
    expect(parsed).toMatchObject({ determinate: false, version: null, routes: [] });
    expect(parsed.note).toContain('unknown');
  });
});

// ---------------------------------------------------------------------------
// Honest counting
// ---------------------------------------------------------------------------

describe('counting and denominators', () => {
  it('counts a suite out of the cases it started with, not the ones that worked', () => {
    const counts = countOutcomes([
        { outcome: 'passed' } as never,
        { outcome: 'errored' } as never,
        { outcome: 'clarified' } as never,
        { outcome: 'unresolved' } as never,
      ],
      4
    );
    expect(counts).toMatchObject({ total: 4, attempted: 3, passed: 1, errored: 1, clarified: 1, unresolved: 1 });
  });

  it('calls a suite complete only when every case in it passed', () => {
    expect(deriveStatus({ total: 6, attempted: 6, passed: 6, failed: 0, errored: 0, clarified: 0, unresolved: 0 })).toBe('complete');
    // Five of six is partial. Scoring it out of five would be the substitution
    // this module exists to remove.
    expect(deriveStatus({ total: 6, attempted: 5, passed: 5, failed: 0, errored: 1, clarified: 0, unresolved: 0 })).toBe('partial');
    expect(deriveStatus({ total: 6, attempted: 6, passed: 0, failed: 6, errored: 0, clarified: 0, unresolved: 0 })).toBe('failed');
    expect(deriveStatus({ total: 0, attempted: 0, passed: 0, failed: 0, errored: 0, clarified: 0, unresolved: 0 })).toBe('failed');
  });

  it('excludes not-applicable and errored judgements from a rate’s denominator', () => {
    const summary = summariseJudge([
        { name: 'groundedness', state: 'scored', value: 'yes' } as never,
        { name: 'groundedness', state: 'scored', value: 'no' } as never,
        { name: 'groundedness', state: 'not-applicable', value: null } as never,
        { name: 'groundedness', state: 'errored', value: null } as never,
        { name: 'guidelines', state: 'scored', value: 'yes' } as never,
      ],
      GROUNDEDNESS_FEEDBACK_NAME
    );
    // One of two, not one of four: a rubric that did not apply and a judge that
    // could not be reached are absences of evidence, not failures.
    expect(summary).toMatchObject({ rate: 0.5, scored: 2, yes: 1, no: 1, notApplicable: 1, errored: 1 });
  });

  it('reports no rate at all rather than zero when nothing was scored', () => {
    const summary = summariseJudge([{ name: 'groundedness', state: 'errored', value: null } as never], GROUNDEDNESS_FEEDBACK_NAME);
    // Zero would read as "the agent failed every check". Null renders as absent.
    expect(summary.rate).toBeNull();
    expect(summary.scored).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Per-case verdicts
// ---------------------------------------------------------------------------

describe('deciding a case', () => {
  const scored = (value: 'yes' | 'no', name = 'groundedness') => ({ name, state: 'scored' as const, value, rationale: 'r' }) as never;
  const errored = (name = 'groundedness') => ({ name, state: 'errored' as const, value: null, reason: 'unreachable' }) as never;
  const check = (passed: boolean) => ({ id: 'has-charts', label: 'Returned at least one chart', passed, detail: 'd' });

  it('passes only when every check held and every verdict was yes', () => {
    expect(decideOutcome([check(true)], [scored('yes'), scored('yes', 'guidelines')]).outcome).toBe('passed');
  });

  it('fails on a no, and says which judge said it', () => {
    const decided = decideOutcome([check(true)], [scored('no')]);
    expect(decided.outcome).toBe('failed');
    expect(decided.note).toContain('groundedness judge said no');
  });

  it('fails on a structural check without asking a judge’s opinion of a fact', () => {
    const decided = decideOutcome([check(false)], [scored('yes')]);
    expect(decided.outcome).toBe('failed');
    expect(decided.note).toContain('Returned at least one chart failed');
  });

  it('will not claim a pass when a judge could not be reached', () => {
    const decided = decideOutcome([check(true)], [scored('yes'), errored('guidelines')]);
    // Not `failed` (nothing was observed to be wrong. Not `passed`), the case
    // is not fully scored. `errored` at the judge stage is the honest third
    // answer, and it keeps the case out of the pass count.
    expect(decided.outcome).toBe('errored');
    expect(decided.errorStage).toBe('judge');
    expect(decided.note).toContain('not claimed as a pass');
  });

  it('will not pass a case on an empty set of evidence', () => {
    const decided = decideOutcome([check(true)], []);
    expect(decided.outcome).toBe('errored');
    expect(decided.note).toContain('no rubric applied');
  });
});

// ---------------------------------------------------------------------------
// Retrieval context and structural checks
// ---------------------------------------------------------------------------

describe('the document handed to the groundedness judge', () => {
  it('is built from what the agent retrieved, not from source names alone', () => {
    const context = buildRetrievalContext(makeAnswer());
    expect(context.text).toContain('rows: 3');
    expect(context.text).toContain('SELECT 1');
    expect(context.text).toContain('Active players');
    expect(context.truncated).toBe(false);
  });

  it('is empty when the agent retrieved nothing, so the rubric can be skipped', () => {
    const bare = makeAnswer({ sql: '', figures: [], sources: [], trace: { id: 't', totalMs: 1, toolCalls: 0, stages: [] } });
    expect(buildRetrievalContext(bare).text).toBe('');
  });

  it('reports truncation rather than silently shortening the document', () => {
    const huge = makeAnswer({
      trace: { id: 't', totalMs: 1, toolCalls: 0, stages: [{ id: 's', name: 'Data', kind: 'sql', status: 'complete', input: '', output: 'x'.repeat(20_000) }] },
    });
    expect(buildRetrievalContext(huge).truncated).toBe(true);
  });

  it('evaluates structural checks as facts', () => {
    const checks = evaluateStructuralChecks(['has-charts', 'has-figures'], makeAnswer({ charts: [] }));
    expect(checks[0]).toMatchObject({ id: 'has-charts', passed: false });
    expect(checks[1]).toMatchObject({ id: 'has-figures', passed: true });
  });
});

// ---------------------------------------------------------------------------
// A whole run
// ---------------------------------------------------------------------------

describe('running a suite', () => {
  it('records real per-case results, keeping app-measured and agent-reported latency apart', async () => {
    const store = new FakeStore();
    const started = await run(makeDeps(store));
    const metrics = store.metrics(started.body.id);
    expect(metrics.cases).toHaveLength(2);
    const first = metrics.cases[0];
    expect(first.caseId).toBe('player-count');
    expect(first.question).toBe('How many active players did each title have in the last 30 days?');
    expect(first.questionSource).toBe('catalog');
    expect(first.durationMs).toBeGreaterThan(0);
    // Two different measurements of two different things, neither correcting
    // the other.
    expect(first.agentTotalMs).toBe(1235);
    expect(first.mlflowTraceId).toBe('tr-1');
    expect(metrics.medianCaseMs).toBeGreaterThan(0);
  });

  it('reports a run in progress before it has results, so a four-minute suite can be watched', async () => {
    const store = new FakeStore();
    const deps = makeDeps(store);
    const started = await startBenchmarkRun(deps);
    if (started.status !== 202) throw new Error('expected 202');
    // The row exists, says running, and names the case in flight: all before
    // the suite finishes, which is what makes polling possible.
    const inFlight = store.metrics(started.body.id);
    expect(inFlight.status).toBe('running');
    expect(inFlight.progress).toMatchObject({ completed: 0, total: 2, currentCaseId: 'player-count' });
    expect(started.body.poll).toBe(`/api/runs/${started.body.id}/trace`);
    await started.completed;
    expect(store.metrics(started.body.id).status).not.toBe('running');
    expect(store.metrics(started.body.id).finishedAt).not.toBeNull();
  });

  it('passes the governance refusal on the guidelines judge alone, with the other two rubrics marked not applicable', async () => {
    const store = new FakeStore();
    const started = await run(makeDeps(store, {
        // A refusal: prose, no data, no figures, no chart.
        askAgent: () =>
          Promise.resolve<AgentTurn>({
            type: 'answer',
            answer: makeAnswer({
              takeaway: 'I cannot share competitor-level player data.',
              narrative: 'That data is restricted under the governance policy.',
              sql: '',
              figures: [],
              charts: [],
              sources: [],
              trace: { id: 'tr-2', totalMs: 900, toolCalls: 0, stages: [] },
            }),
          }),
      })
    );
    const refusal = store.metrics(started.body.id).cases.find((entry) => entry.caseId === 'access-boundary');
    expect(refusal?.outcome).toBe('passed');
    const groundedness = refusal?.judgements.find((entry) => entry.name === 'groundedness');
    const relevance = refusal?.judgements.find((entry) => entry.name === 'relevance_to_context');
    const guidelines = refusal?.judgements.find((entry) => entry.name === 'guidelines');
    // The distinction that lets a correct refusal pass: two rubrics did not
    // apply, and neither is renderable as a judge that failed.
    expect(groundedness?.state).toBe('not-applicable');
    expect(groundedness?.value).toBeNull();
    expect(groundedness?.reason).toContain('refusal');
    expect(relevance?.state).toBe('not-applicable');
    expect(relevance?.reason).toBeTruthy();
    expect(guidelines?.state).toBe('scored');
    expect(guidelines?.value).toBe('yes');
  });

  it('keeps a not-applicable judgement out of every rate it touches', async () => {
    const store = new FakeStore();
    store.suiteRows[0].cases_json = JSON.stringify([{ id: 'access-boundary' }]);
    const started = await run(makeDeps(store));
    const metrics = store.metrics(started.body.id);
    expect(metrics.groundedness).toBeNull();
    expect(metrics.judgeRates.groundedness).toMatchObject({ scored: 0, yes: 0, no: 0, notApplicable: 1 });
    expect(metrics.guidelines).toBe(1);
  });

  it('approves a plan and executes it, rather than measuring the planner', async () => {
    const store = new FakeStore();
    const seen: unknown[] = [];
    const started = await run(makeDeps(store, {
        askAgent: (request) => {
          seen.push(request);
          if (!request.approvedPlanId) return Promise.resolve<AgentTurn>({ type: 'plan', planId: 'plan-9' });
          return Promise.resolve<AgentTurn>({ type: 'answer', answer: makeAnswer() });
        },
      })
    );
    expect(seen).toHaveLength(4);
    expect(seen[1]).toMatchObject({ approvedPlanId: 'plan-9', executePlan: true });
    expect(store.metrics(started.body.id).cases[0].turns).toBe(2);
  });

  it('gives each case its own conversation, so no case is answered with the previous one’s history', async () => {
    const store = new FakeStore();
    const conversations: string[] = [];
    await run(makeDeps(store, { askAgent: (request) => { conversations.push(request.conversationId); return Promise.resolve<AgentTurn>({ type: 'answer', answer: makeAnswer() }); } }));
    expect(new Set(conversations).size).toBe(2);
    expect(conversations[0]).toContain('player-count');
  });

  it('reports a clarification as its own outcome rather than as a failure', async () => {
    const store = new FakeStore();
    const started = await run(makeDeps(store, {
        askAgent: () => Promise.resolve<AgentTurn>({ type: 'clarification', question: 'Which titles?', traceId: 'tr-c' }),
      })
    );
    const metrics = store.metrics(started.body.id);
    expect(metrics.cases[0].outcome).toBe('clarified');
    expect(metrics.cases[0].note).toContain('asked a question back');
    expect(metrics.counts).toMatchObject({ clarified: 2, passed: 0, failed: 0 });
    expect(metrics.status).toBe('failed');
  });

  it('keeps going after one case errors, and reports the error rather than hiding it', async () => {
    const store = new FakeStore();
    let call = 0;
    const started = await run(makeDeps(store, {
        askAgent: () => {
          call += 1;
          if (call === 1) return Promise.reject(new Error('endpoint returned 500'));
          return Promise.resolve<AgentTurn>({ type: 'answer', answer: makeAnswer() });
        },
      })
    );
    const metrics = store.metrics(started.body.id);
    expect(metrics.cases[0]).toMatchObject({ outcome: 'errored', errorStage: 'agent' });
    expect(metrics.cases[0].error).toContain('endpoint returned 500');
    expect(metrics.counts).toMatchObject({ total: 2, attempted: 2, passed: 1, errored: 1 });
    // One of two, reported as partial. Not "1 of 1 passed".
    expect(metrics.status).toBe('partial');
    expect(metrics.passed).toBe(1);
    expect(metrics.total).toBe(2);
  });

  it('counts a case the suite named but nothing could resolve', async () => {
    const store = new FakeStore();
    store.suiteRows[0].cases_json = JSON.stringify([{ id: 'player-count' }, { id: 'ghost' }]);
    const started = await run(makeDeps(store));
    const metrics = store.metrics(started.body.id);
    expect(metrics.counts).toMatchObject({ total: 2, attempted: 1, passed: 1, unresolved: 1 });
    expect(metrics.status).toBe('partial');
    expect(metrics.cases[1].note).toContain('no question was found');
  });

  it('runs the catalog and records the substitution when the suite row cannot be read', async () => {
    const store = new FakeStore();
    store.failSuiteRead = true;
    const started = await run(makeDeps(store));
    const metrics = store.metrics(started.body.id) as BenchmarkRunMetrics & { caseListSource?: string };
    expect(metrics.counts.total).toBe(6);
    // A benchmark that quietly ran a different case list from the one asked for
    // would be the same defect as the constants it replaces.
    expect(metrics.caseListSource).toBe('catalog-fallback');
  });

  it('stores the suite under one id however it was asked for', async () => {
    const store = new FakeStore();
    const started = await run(makeDeps(store, { requestedSuiteId: 'executive-poc' }));
    expect(started.body.suiteId).toBe('poc-benchmark');
    const metrics = store.metrics(started.body.id);
    expect(metrics.suiteId).toBe('poc-benchmark');
    expect(metrics.requestedSuiteId).toBe('executive-poc');
    expect(metrics.prompt).toBe('Benchmark suite: POC benchmark suite');
    expect(store.runs.get(started.body.id)?.suite_id).toBe('poc-benchmark');
  });

  it('refuses an unknown suite id instead of running something', async () => {
    const store = new FakeStore();
    const result = await startBenchmarkRun(makeDeps(store, { requestedSuiteId: 'nope' }));
    expect(result.status).toBe(400);
    expect(store.runs.size).toBe(0);
  });

  it('counts a persistence failure rather than losing it silently', async () => {
    const store = new FakeStore();
    store.failUpdateAfter = 1;
    const started = await run(makeDeps(store));
    // The final write failed, so the row is stale, which is exactly why the
    // failure is logged with the payload for recovery.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('could not be updated'));
    expect(store.runs.get(started.body.id)?.status).toBe('running');
  });

  it('will not start a suite it has nowhere to record', async () => {
    const store = new FakeStore();
    store.failInsert = true;
    const askAgent = vi.fn();
    const result = await startBenchmarkRun(makeDeps(store, { askAgent }));
    expect(result.status).toBe(503);
    // Several minutes of agent time on results nobody could read is worse than
    // saying no.
    expect(askAgent).not.toHaveBeenCalled();
  });

  it('abandons remaining cases when the suite runs out of time, and says so', async () => {
    const store = new FakeStore();
    const started = await run(makeDeps(store, { suiteBudgetMs: 1, now: makeClock('2026-08-05T07:00:00.000Z', 60_000) }));
    const metrics = store.metrics(started.body.id);
    expect(metrics.cases.every((entry) => entry.outcome === 'errored')).toBe(true);
    expect(metrics.cases[0].errorStage).toBe('budget');
    expect(metrics.cases[0].error).toContain('budget');
  });

  it('records running out of time as a truncation, not only in the abandoned cases', async () => {
    // `truncation` is what the Benchmark Lab reads to tell a reader the rates above
    // cover fewer cases than the total. Only the identity refusal used to set it, so
    // a suite that ran out of time after two of ten cases could show a perfect rate
    // over those two and say nothing about having stopped — the numbers all true and
    // the denominator a lie, which is the exact shape this module exists to remove.
    const store = new FakeStore();
    const started = await run(makeDeps(store, { suiteBudgetMs: 1, now: makeClock('2026-08-05T07:00:00.000Z', 60_000) }));
    const metrics = store.metrics(started.body.id);

    expect(metrics.truncation?.code).toBe(BUDGET_TRUNCATION_CODE);
    expect(metrics.truncation?.unattempted).toBe(metrics.counts.total);
    expect(metrics.truncation?.detail).toContain('budget');
    // And a run that got to the end of its list carries no truncation at all,
    // however badly it scored: a warning on every run is a warning nobody reads,
    // and this one has to be believed on the run where it is real.
    const wholeStore = new FakeStore();
    const whole = await run(makeDeps(wholeStore));
    expect(wholeStore.metrics(whole.body.id).truncation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Whose run this is
//
// A benchmark executes as the person who started it. These are the tests that
// stop that quietly becoming untrue again: every one of them is about a state
// where running as the app would be easier and would produce a nicer-looking
// row.
// ---------------------------------------------------------------------------

describe('a suite that outlives the credential it started with', () => {
  const startedAt = '2026-08-05T07:00:00.000Z';

  /** A lifetime that ends `ms` after the clock's first tick. */
  function expiringAfter(ms: number) {
    return { expiresAtMs: Date.parse(startedAt) + ms, unknownReason: '' };
  }

  function identity(lifetime: { expiresAtMs: number | null; unknownReason: string }) {
    return { email: 'sam@example.com', mode: 'signed_in_user', verified: true, lifetime };
  }

  it('refuses to start a suite its credential cannot cover, before anything is written', async () => {
    const store = new FakeStore();
    const askAgent = vi.fn();
    const result = await startBenchmarkRun(makeDeps(store, {
        identity: identity(expiringAfter(60_000)),
        suiteBudgetMs: 20 * 60_000,
        now: makeClock(startedAt, 0),
        askAgent,
      })
    );

    expect(result.status).toBe(401);
    if (result.status === 202) throw new Error('expected a refusal');
    expect(result.refusal?.code).toBe('IDENTITY_REQUIRED');
    // Actionable, and honest about why: the alternative is four minutes of
    // agent time spent on a run that stops halfway.
    expect(result.body.message).toContain('Sign in again');
    expect(askAgent).not.toHaveBeenCalled();
    expect(store.runs.size).toBe(0);
  });

  it('starts a suite whose credential outlasts the budget', async () => {
    const store = new FakeStore();
    const started = await run(makeDeps(store, {
        identity: identity(expiringAfter(60 * 60_000)),
        suiteBudgetMs: 20 * 60_000,
      })
    );
    expect(store.metrics(started.body.id).counts.attempted).toBe(2);
  });

  it('does not refuse a credential that declares no expiry, because most of them do not', async () => {
    const store = new FakeStore();
    // An opaque personal access token states no `exp`. Refusing on that would
    // take the page down in any workspace that issues them, on a check that
    // would have fired correctly zero times.
    const started = await run(makeDeps(store, {
        identity: identity({ expiresAtMs: null, unknownReason: 'the token is opaque rather than a JWT' }),
      })
    );
    const metrics = store.metrics(started.body.id);
    expect(metrics.counts.attempted).toBe(2);
    // Recorded as unknown rather than as covered, so a run that stops later is
    // explicable from the row alone.
    expect(metrics.executedAs?.credentialExpiresAt).toBeNull();
  });

  it('stops mid-suite when the endpoint stops accepting the credential, rather than finishing as the application', async () => {
    const store = new FakeStore();
    let call = 0;
    const started = await run(makeDeps(store, {
        identity: identity({ expiresAtMs: null, unknownReason: 'the token is opaque rather than a JWT' }),
        askAgent: () => {
          call += 1;
          if (call === 1) return Promise.resolve<AgentTurn>({ type: 'answer', answer: makeAnswer() });
          // An opaque token cannot be checked ahead of time, so a suite that
          // outlives one finds out here. This is the path that actually carries
          // the guarantee, which is why it is the one with a test.
          return Promise.resolve<AgentTurn>({
            type: 'refused',
            code: 'USER_AUTH_REJECTED',
            message: 'The request could not be executed with your permissions.',
            detail: 'the endpoint rejected the forwarded credential',
          });
        },
      })
    );

    const metrics = store.metrics(started.body.id);
    expect(metrics.truncation).toMatchObject({ code: 'USER_AUTH_REJECTED' });
    // The completed portion is attributed honestly and the rest is counted.
    // It is emphatically not reported as one shorter suite that passed.
    expect(metrics.counts).toMatchObject({ total: 2, passed: 1, errored: 1 });
    expect(metrics.status).toBe('partial');
    expect(metrics.interrupted).toBe(true);
  });

  it('records whose grants produced the scores', async () => {
    const store = new FakeStore();
    const started = await run(makeDeps(store, { identity: identity(expiringAfter(60 * 60_000)) }));
    expect(store.metrics(started.body.id).executedAs).toMatchObject({
      mode: 'signed_in_user',
      email: 'sam@example.com',
      verified: true,
    });
  });
});

describe('a run the endpoint refuses', () => {
  function refusal(code: 'IDENTITY_REQUIRED' | 'USER_NOT_AUTHORIZED'): AgentTurn {
    return { type: 'refused', code, message: 'The request could not be executed with your permissions.', detail: `refused with ${code}` };
  }

  it('stops the whole suite when the refusal is about the run’s identity', async () => {
    const store = new FakeStore();
    const askAgent = vi.fn().mockResolvedValue(refusal('IDENTITY_REQUIRED'));
    const started = await run(makeDeps(store, { askAgent }));

    const metrics = store.metrics(started.body.id);
    // Asked once. Every later case would have been refused identically, so
    // grinding through them spends minutes to learn nothing.
    expect(askAgent).toHaveBeenCalledTimes(1);
    expect(metrics.truncation).toMatchObject({ code: 'IDENTITY_REQUIRED', fromCaseIndex: 1, unattempted: 1 });
    expect(metrics.cases[0]).toMatchObject({ outcome: 'errored', errorStage: 'identity', error: 'IDENTITY_REQUIRED' });
    expect(metrics.status).not.toBe('complete');
  });

  it('keeps going when the refusal is about the data one question needed', async () => {
    const store = new FakeStore();
    let call = 0;
    const started = await run(makeDeps(store, {
        askAgent: () => {
          call += 1;
          // A reader who cannot see one of the tables the suite touches is an
          // ordinary and expected outcome of a benchmark that runs as a person.
          if (call === 1) return Promise.resolve(refusal('USER_NOT_AUTHORIZED'));
          return Promise.resolve<AgentTurn>({ type: 'answer', answer: makeAnswer() });
        },
      })
    );
    const metrics = store.metrics(started.body.id);
    expect(metrics.truncation).toBeUndefined();
    expect(metrics.counts).toMatchObject({ total: 2, attempted: 2, errored: 1, passed: 1 });
    expect(metrics.cases[0].errorStage).toBe('identity');
  });

  it('never counts a refusal as a pass or as a failure of the agent', async () => {
    const store = new FakeStore();
    const started = await run(makeDeps(store, { askAgent: () => Promise.resolve(refusal('USER_NOT_AUTHORIZED')) }));
    const metrics = store.metrics(started.body.id);
    expect(metrics.counts.passed).toBe(0);
    // `failed` means the agent answered and was measurably wrong. A refusal is
    // not that, and folding it in would make a suite run by somebody without
    // the grants read as an agent that gets things wrong.
    expect(metrics.counts.failed).toBe(0);
    expect(metrics.counts.errored).toBe(2);
    expect(metrics.groundedness).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Concurrency and abandoned runs
// ---------------------------------------------------------------------------

describe('runs that overlap or were cut off', () => {
  it('refuses a second run of the same suite while one is in flight', async () => {
    const store = new FakeStore();
    const first = await startBenchmarkRun(makeDeps(store));
    if (first.status !== 202) throw new Error('expected 202');
    const second = await startBenchmarkRun(makeDeps(store, { newId: () => 'run-2' }));
    expect(second.status).toBe(409);
    // Two suites at once would compete at the endpoint and both sets of latency
    // figures would be measuring the queue.
    expect(second.body).toMatchObject({ error: 'benchmark_already_running', runId: first.body.id });
    await first.completed;
  });

  it('lets a second run start once the first has finished', async () => {
    const store = new FakeStore();
    await run(makeDeps(store));
    const second = await startBenchmarkRun(makeDeps(store, { newId: () => 'run-2' }));
    expect(second.status).toBe(202);
    if (second.status === 202) await second.completed;
  });

  it('closes out a run a dead process left running, and marks it interrupted rather than deleting it', async () => {
    const store = new FakeStore();
    store.runs.set('orphan', {
      suite_id: 'poc-benchmark',
      user_email: 'sam@example.com',
      status: 'running',
      metrics_json: JSON.stringify({ status: 'running', heartbeatAt: '2026-08-05T06:00:00.000Z', cases: [] }),
      created_at: '2026-08-05T06:00:00.000Z',
    });
    const swept = await sweepStaleRuns({ store, userEmail: 'sam@example.com', now: makeClock() });
    expect(swept.swept).toEqual(['orphan']);
    const orphan = store.runs.get('orphan');
    expect(orphan?.status).toBe('failed');
    // The run happened. The record of it is worth more than a tidy list.
    expect(JSON.parse(orphan?.metrics_json ?? '{}')).toMatchObject({ interrupted: true, status: 'failed' });
  });

  it('leaves a slow run alone', async () => {
    const store = new FakeStore();
    store.runs.set('slow', {
      suite_id: 'poc-benchmark',
      user_email: 'sam@example.com',
      status: 'running',
      metrics_json: JSON.stringify({ heartbeatAt: '2026-08-05T06:59:00.000Z', cases: [] }),
      created_at: '2026-08-05T06:59:00.000Z',
    });
    const swept = await sweepStaleRuns({ store, userEmail: 'sam@example.com', now: makeClock() });
    expect(swept.swept).toEqual([]);
    expect(swept.stillRunning).toEqual([{ id: 'slow', suiteId: 'poc-benchmark' }]);
  });

  it('does not touch another user’s runs', async () => {
    const store = new FakeStore();
    store.runs.set('theirs', {
      suite_id: 'poc-benchmark',
      user_email: 'someone@example.com',
      status: 'running',
      metrics_json: JSON.stringify({ heartbeatAt: '2026-08-05T05:00:00.000Z' }),
      created_at: '2026-08-05T05:00:00.000Z',
    });
    const swept = await sweepStaleRuns({ store, userEmail: 'sam@example.com', now: makeClock() });
    expect(swept.swept).toEqual([]);
    expect(store.runs.get('theirs')?.status).toBe('running');
  });
});

describe('cancel and retry', () => {
  it('stops after the current case when cancel is requested, and keeps partial results', async () => {
    const store = new FakeStore();
    let startedId = '';
    const started = await startBenchmarkRun(
      makeDeps(store, {
        askAgent: async () => {
          if (!startedId) {
            startedId = [...store.runs.keys()][0] ?? '';
            await requestBenchmarkCancel({ store, runId: startedId, userEmail: 'sam@example.com' });
          }
          return { type: 'answer', answer: makeAnswer() };
        },
      })
    );
    expect(started.status).toBe(202);
    if (started.status !== 202) return;
    await started.completed;
    const metrics = store.metrics(started.body.id);
    expect(metrics.truncation?.code).toBe(SUITE_CANCELLED_CODE);
    expect(metrics.cases.some((entry) => entry.outcome === 'passed')).toBe(true);
    expect(metrics.cases.some((entry) => entry.errorStage === 'cancel')).toBe(true);
  });

  it('retries only the named case ids', async () => {
    const store = new FakeStore();
    const started = await run(makeDeps(store, { caseIds: ['player-count'] }));
    const metrics = store.metrics(started.body.id);
    expect(metrics.counts.total).toBe(1);
    expect(metrics.cases.map((entry) => entry.caseId)).toEqual(['player-count']);
  });
});

// ---------------------------------------------------------------------------
// The transport guard
// ---------------------------------------------------------------------------

describe('the transport this runner is allowed to use', () => {
  const sources = ['./benchmark-runner.ts', './mlflow-judges.ts', './benchmark-suite.ts'].map((file) => ({
    file,
    text: readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'),
  }));

  it('builds no HTTP client of its own', () => {
    // The agent endpoint and the judge endpoint are reached through injected
    // closures bound to the same transport `POST /api/insights/ask` uses. A
    // second client here would be able to reintroduce the defect the repo's
    // eslint rules and serving-transport guards exist to prevent: the SDK's
    // `servingEndpoints.query()` and AppKit's `serving()` plugin both rebuild
    // the body from an allowlist with no `custom_inputs`, which silently
    // disables plan approval while every request still returns 200.
    for (const { file, text } of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const forbidden of [
        'WorkspaceClient',
        'servingEndpoints',
        'apiClient',
        "from 'node:https'",
        "from 'undici'",
        '@databricks/sdk',
        '@databricks/appkit',
        'fetch(',
        'axios',
      ]) {
        expect(code, `${file} must not reach the network itself, but mentions ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('keeps its SQL where a schema check can find it', () => {
    for (const statement of [BENCHMARK_SUITE_QUERY, BENCHMARK_RUN_INSERT, BENCHMARK_RUN_UPDATE, BENCHMARK_RUNNING_QUERY]) {
      expect(statement).toContain('player_insights.');
    }
    // Only `benchmark_runs` is written. The two `benchmark_suites` rows survived
    // the store being cleared and are read, never modified.
    expect(BENCHMARK_RUN_INSERT).toContain('benchmark_runs');
    for (const statement of [BENCHMARK_RUN_INSERT, BENCHMARK_RUN_UPDATE]) {
      expect(statement).not.toContain('benchmark_suites');
    }
    expect(BENCHMARK_SUITE_QUERY.trim().startsWith('SELECT')).toBe(true);
  });
});
