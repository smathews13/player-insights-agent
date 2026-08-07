import http from 'node:http';
import express, { type Request } from 'express';
import { serving as sdkServing } from '@databricks/sdk-experimental';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAskServingBody,
  buildServingHistory,
  createServingTransport,
  DEVELOPMENT_IDENTITY,
  discloseAnswerProvenance,
  extractAnalysisPlan,
  extractAttachmentText,
  extractClarification,
  extractLiveText,
  extractStructuredAnswer,
  identityPayload,
  invokeServing,
  mlflowReference,
  PLAN_APPROVAL_MESSAGE,
  PREFLIGHT_TIMEOUT_MS,
  REPRESENTATIVE_ANSWER_CAVEAT,
  representativeAnswer,
  RUN_TRACE_BENCHMARK_QUERY,
  RUN_TRACE_MESSAGE_QUERY,
  RUNS_QUERY,
  SERVING_INVOKE_TIMEOUT_MS,
  SERVICE_PRINCIPAL_FALLBACK_CAVEAT,
  servingInvocationPath,
  setupInsightsRoutes,
  SHARED_RUN_OWNER,
  type InsightsAppKit,
  type ServingTransport,
} from './insights-routes';
import servingResponses from './__fixtures__/serving-responses.json';
import { DEGRADED_ANSWER_MARKER } from '../../shared/setup-remedies';
import { STORED_FIGURES_CAVEAT } from '../../shared/representative-answer';
import {
  forgetAccessDecisions,
  forgetServingPrincipal,
  recordVerifiedAccess,
  rememberServingPrincipal,
} from './execution-identity';

// Captured verbatim from the deployed `player-insights-agent` endpoint so the app
// contract is tested against what Model Serving actually returns.
const { liveAnswerResponse, livePlanResponse } = servingResponses;

function request(headers: Record<string, string> = {}) {
  return { header: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}

describe('representativeAnswer', () => {
  it('returns a complete, deterministic demo contract', () => {
    const answer = representativeAnswer('Compare active players by title over the last 30 days');

    expect(answer.takeaway).toContain('VLH Online');
    expect(answer.figures).toHaveLength(5);
    expect(answer.sources[0]?.name).toContain('silver_gameplay_activity');
    expect(answer.sql).toMatch(/^(SELECT|WITH)/);
    expect(answer.trace.stages.map((stage) => stage.id)).toEqual([
      'plan',
      'discover',
      'dictionary',
      'query',
      'quality',
      'synthesis',
    ]);
  });

  it('surfaces a partial-data caveat for quality questions', () => {
    const answer = representativeAnswer('Check null ratios and data quality');

    expect(answer.takeaway).toContain('expected nulls');
    expect(answer.trace.stages.find((stage) => stage.id === 'query')?.status).toBe('partial');
    expect(answer.caveats.join(' ')).toContain('synthetic quality');
  });
});

describe('extractLiveText', () => {
  it('reads ResponsesAgent output text', () => {
    expect(extractLiveText({
        output: [{ content: [{ type: 'output_text', text: 'Grounded answer' }] }],
      })
    ).toBe('Grounded answer');
  });

  it('does not treat endpoint errors as live answers', () => {
    expect(extractLiveText({
        error_code: 'ENDPOINT_NOT_FOUND',
        message: 'The configured endpoint does not exist.',
      })
    ).toBeNull();
  });
});

describe('extractStructuredAnswer', () => {
  it('reads the ResponsesAgent custom output contract', () => {
    const expected = representativeAnswer('Compare active players by title');
    const result = extractStructuredAnswer({
      custom_outputs: { answer: expected },
    });

    expect(result?.takeaway).toBe(expected.takeaway);
    expect(result?.trace.stages).toHaveLength(6);
  });

  it('reads an AppKit-wrapped ResponsesAgent response', () => {
    const expected = representativeAnswer('Compare active players by title');
    const result = extractStructuredAnswer({
      data: { custom_outputs: { answer: expected } },
    });

    expect(result?.takeaway).toBe(expected.takeaway);
  });

  it('rejects incomplete custom output', () => {
    expect(extractStructuredAnswer({ custom_outputs: { answer: { takeaway: 'Missing fields' } } })).toBeNull();
  });

  it('round-trips a real response from the deployed serving endpoint', () => {
    const result = extractStructuredAnswer(liveAnswerResponse);

    expect(result).not.toBeNull();
    expect(result?.takeaway).toBe(liveAnswerResponse.custom_outputs.answer.takeaway);
    expect(result?.sql).toMatch(/^(SELECT|WITH)/);
    expect(result?.sources[0]?.name).toContain('<your_catalog>.<your_schema>');
    const figure = result?.figures[0];
    expect(typeof figure?.label).toBe('string');
    expect(typeof figure?.value).toBe('number');
    expect(typeof figure?.display).toBe('string');
    expect(typeof figure?.comparison).toBe('string');
    expect(result?.trace.totalMs).toBeGreaterThan(0);
    expect(result?.trace.stages.map((stage) => stage.id)).toEqual(['plan', 'discover', 'synthesis']);
  });

  it('surfaces the friendly stage names and timings used by the trace panel', () => {
    const stages = extractStructuredAnswer(liveAnswerResponse)?.trace.stages ?? [];

    expect(stages.map((stage) => stage.name)).toEqual([
      'Interpreted the question',
      'Found and analyzed governed data',
      'Prepared the answer',
    ]);
    for (const stage of stages) {
      expect(stage.duration).toBeGreaterThanOrEqual(0);
      expect(stage.start).toBeGreaterThanOrEqual(0);
      expect(['complete', 'running', 'partial', 'failed']).toContain(stage.status);
    }
  });

  it('reads the plain-text output of a real serving response', () => {
    expect(extractLiveText(liveAnswerResponse)).toContain(liveAnswerResponse.custom_outputs.answer.takeaway.slice(0, 40)
    );
  });
});

/**
 * The agent's third response type: a question back instead of an answer.
 *
 * Built from the captured answer's trace rather than added to
 * `serving-responses.json`, because that file holds responses recorded verbatim
 * from the deployed endpoint and no deployed version returns this yet: the model
 * version carrying the tool-calling loop is not logged. The SHAPE is the contract
 * `agent/contracts.py::Clarification` emits; what is unproven against the live
 * endpoint is noted rather than dressed up as a capture.
 */
function clarificationResponse(clarification: Record<string, unknown> = {}) {
  return {
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: 'Which table did you mean?' }],
      },
    ],
    custom_outputs: {
      type: 'clarification',
      clarification: {
        id: 'clarify-8f21c0a4b19d',
        question:
          'Which table did you mean? Give the full catalog.schema.table for the master table.',
        reason: 'The question named "the master table", which is not a table this agent can resolve.',
        options: [
          '<your_catalog>.<your_schema>.silver_player_profiles',
          '<your_catalog>.<your_schema>.gold_player_180d_summary',
        ],
        trace: liveAnswerResponse.custom_outputs.answer.trace,
        ...clarification,
      },
    },
  };
}

describe('extractClarification', () => {
  it('reads the third custom_outputs type', () => {
    const result = extractClarification(clarificationResponse());

    expect(result?.question).toContain('catalog.schema.table');
    expect(result?.options).toHaveLength(2);
    expect(result?.trace.stages.length).toBeGreaterThan(0);
  });

  it('defaults the parts a clarification may legitimately omit', () => {
    const result = extractClarification(clarificationResponse({ reason: undefined, options: undefined })
    );

    expect(result?.reason).toBe('');
    expect(result?.options).toEqual([]);
    expect(result?.question).toBeTruthy();
  });

  it('reads one wrapped by AppKit, as the other extractors do', () => {
    expect(extractClarification({ data: clarificationResponse() })?.id).toBe('clarify-8f21c0a4b19d');
  });

  it('is null for an answer, a plan, and an endpoint error', () => {
    expect(extractClarification(liveAnswerResponse)).toBeNull();
    expect(extractClarification(livePlanResponse)).toBeNull();
    expect(extractClarification({
        error_code: 'ENDPOINT_NOT_FOUND',
        custom_outputs: { type: 'clarification', clarification: { question: 'x' } },
      })
    ).toBeNull();
  });

  it('refuses one with no question rather than showing an empty prompt', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(extractClarification(clarificationResponse({ question: '' }))).toBeNull();
      expect(warn.mock.calls.flat().join(' ')).toContain('shape the app cannot read');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('plan and conversation contracts', () => {
  it('reads a wrapped analysis plan', () => {
    const result = extractAnalysisPlan({
      data: {
        custom_outputs: {
          type: 'plan',
          plan: {
            id: 'plan-1',
            question: 'Compare active players by title',
            summary: 'Confirm definitions, analyze governed data, then summarize.',
            steps: [
              {
                id: 'data',
                title: 'Analyze governed data',
                description: 'Run an approved aggregate query.',
                kind: 'data',
              },
            ],
            requires_approval: true,
            uses_conversation_context: false,
            uses_attachment_context: true,
          },
        },
      },
    });

    expect(result?.id).toBe('plan-1');
    expect(result?.uses_attachment_context).toBe(true);
  });

  /**
   * A plan is the worst shape to drop a field from: the screen exists to show
   * someone what will run before it runs, so anything stripped here is
   * redacted from the thing they are consenting to.
   */
  function planResponse(plan: Record<string, unknown>) {
    return { custom_outputs: { type: 'plan', plan } };
  }

  const wholePlan = {
    id: 'plan-1',
    question: 'Compare active players by title',
    summary: 'Confirm definitions, then analyze.',
    steps: [{ id: 'data', title: 'Analyze', description: 'Run an approved aggregate.', kind: 'data' }],
    requires_approval: true,
    uses_conversation_context: false,
    uses_attachment_context: false,
  };

  it('forwards a plan field the app does not declare instead of stripping it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = extractAnalysisPlan(planResponse({ ...wholePlan, estimated_cost_usd: 0.42, data_scope: 'gold only' })
      );

      expect(result).toMatchObject({ estimated_cost_usd: 0.42, data_scope: 'gold only' });
      expect(warn.mock.calls.flat().join(' ')).toContain('estimated_cost_usd');
    } finally {
      warn.mockRestore();
    }
  });

  it('forwards an undeclared field on a step, and names the step it came from', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = extractAnalysisPlan(planResponse({
          ...wholePlan,
          steps: [{ ...wholePlan.steps[0], tables: ['silver_gameplay_activity'] }],
        })
      );

      expect(result?.steps[0]).toMatchObject({ tables: ['silver_gameplay_activity'] });
      const said = warn.mock.calls.flat().join(' ');
      expect(said).toContain('steps[0].tables');
    } finally {
      warn.mockRestore();
    }
  });

  it('says nothing when a plan declares only what the app reads', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(extractAnalysisPlan(planResponse(wholePlan))?.id).toBe('plan-1');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['requires_approval', 'uses_conversation_context', 'uses_attachment_context'])('still reads a plan from a model version logged before %s existed',
    (field) => {
      const older = { ...wholePlan } as Record<string, unknown>;
      delete older[field];

      // Required in Zod, these held only because model_dump() always emits
      // them. One absent field failed the parse, returned null, and sent the
      // ask path to a representative answer: a plan-approval feature that
      // quietly stops proposing plans.
      expect(extractAnalysisPlan(planResponse(older))?.id).toBe('plan-1');
    }
  );

  it('assumes a plan needs approving when the model did not say', () => {
    const older = { ...wholePlan } as Record<string, unknown>;
    delete older.requires_approval;

    // Mirrors the Python default, and errs toward asking rather than running.
    expect(extractAnalysisPlan(planResponse(older))?.requires_approval).toBe(true);
    expect(extractAnalysisPlan(planResponse(older))?.uses_conversation_context).toBe(false);
  });

  it('still refuses a plan that is missing something it cannot work without', () => {
    const noSteps = { ...wholePlan } as Record<string, unknown>;
    delete noSteps.steps;

    // Loose and defaulted is not the same as accepting anything: a plan with no
    // steps has nothing to show, and pretending otherwise would put an empty
    // approval screen in front of the user.
    expect(extractAnalysisPlan(planResponse(noSteps))).toBeNull();
  });

  it('builds a bounded multi-turn serving history', () => {
    const rows = Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index}`,
      response_json:
        index === 13
          ? {
              type: 'plan',
              plan: { id: 'plan-1', summary: 'Review this plan.' },
            }
          : null,
    }));

    const history = buildServingHistory(rows);
    expect(history).toHaveLength(12);
    expect(history[0]?.content).toBe('message-2');
    expect(history[history.length - 1]?.content).toContain('Plan ID: plan-1');
  });

  it('reads a real analysis plan from the deployed serving endpoint', () => {
    const plan = extractAnalysisPlan(livePlanResponse);

    expect(plan).not.toBeNull();
    expect(plan?.id).toMatch(/^plan-/);
    expect(plan?.requires_approval).toBe(true);
    expect(plan?.steps.map((step) => step.kind)).toContain('data');
    expect(plan?.steps.map((step) => step.kind)).toContain('synthesis');
  });

  it('does not mistake a plan response for a finished answer', () => {
    expect(extractStructuredAnswer(livePlanResponse)).toBeNull();
  });

  it('replays a stored assistant answer as takeaway plus narrative', () => {
    const stored = representativeAnswer('Compare active players by title');
    const history = buildServingHistory([
      { role: 'user', content: 'Compare active players by title' },
      { role: 'assistant', content: stored.narrative, response_json: stored },
    ]);

    expect(history[1]?.content).toBe(`${stored.takeaway}\n\n${stored.narrative}`);
  });

  it('parses assistant history that Lakebase returned as a JSON string', () => {
    const stored = representativeAnswer('Compare active players by title');
    const history = buildServingHistory([
      { role: 'assistant', content: stored.narrative, response_json: JSON.stringify(stored) },
    ]);

    expect(history[0]?.content).toContain(stored.takeaway);
  });

  it('drops rows that are not usable conversation turns', () => {
    const history = buildServingHistory([
      { role: 'system', content: 'ignored' },
      { role: 'user', content: 42 },
      { role: 'user', content: 'kept' },
    ]);

    expect(history).toEqual([{ role: 'user', content: 'kept' }]);
  });
});

describe('attachments', () => {
  it.each([
    ['notes.txt', 'plain text'],
    ['notes.md', '# heading'],
    ['rows.csv', 'a,b\n1,2'],
    ['payload.json', '{"a":1}'],
  ])('extracts text from %s', async (filename, body) => {
    await expect(extractAttachmentText(filename, Buffer.from(body, 'utf8'))).resolves.toBe(body);
  });

  // PDF is handled by server/lib/pdf-text.ts and covered in attachments-routes.test.ts.
  it('rejects unsupported formats that would need a heavy parser', async () => {
    for (const filename of ['deck.pptx', 'notes.docx', 'archive.zip', 'noextension']) {
      await expect(extractAttachmentText(filename, Buffer.from('x'))).rejects.toThrow(/PDF, TXT, Markdown, CSV, or JSON/
      );
    }
  });

  it('rejects a binary file renamed to a supported extension', async () => {
    const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x00]);
    await expect(extractAttachmentText('renamed.csv', binary)).rejects.toThrow(/looks binary/);
  });

  it('caps extracted text so a large report cannot blow up the prompt', async () => {
    const text = await extractAttachmentText('big.txt', Buffer.from('a'.repeat(120_000), 'utf8'));
    expect(text).toHaveLength(50_000);
  });
});

const NONTRIVIAL_QUESTION =
  'Compare active players by title and label over the last 30 days and explain the drivers.';

interface CapturedInvocation {
  path: string;
  payload: Record<string, unknown>;
}

interface AskResponse {
  type?: string;
  mode?: string;
  plan?: { id?: string };
  takeaway?: string;
  narrative?: string;
  sql?: string;
  caveats?: unknown[];
  figures?: unknown[];
  sources?: unknown[];
  trace?: { id?: string; totalMs?: number; toolCalls?: number; stages?: unknown[] };
  [key: string]: unknown;
}

interface StoredMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  response_json: unknown;
  created_at: string;
}

/** `response_json` reaches the fake as the JSON string the route hands to Lakebase. */
function storedTrace(message: StoredMessage) {
  if (typeof message.response_json !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.response_json);
  } catch {
    return null;
  }
  const trace = (parsed as { trace?: unknown } | null)?.trace;
  if (!trace || typeof trace !== 'object') return null;
  return trace as { totalMs?: number; stages?: { status?: string }[] };
}

interface RunRow {
  id: string;
  kind: string;
  conversation_id: string | null;
  prompt: string | null;
  stakeholder: string | null;
  status: string | null;
  duration_ms: number | null;
  rating: number | null;
  created_at: string;
}

interface StoredAttachment {
  conversation_id: string;
  filename: string;
  extracted_text: string;
}

interface StoredBenchmarkRun {
  id: string;
  suite_id: string;
  user_email: string;
  status: string;
  metrics_json: unknown;
  created_at: string;
}

/** What `GET /api/runs/:id/trace` returns, from the browser's point of view. */
interface RunTraceResponse {
  runId?: string;
  kind?: string;
  state?: string;
  mode?: string | null;
  conversationId?: string | null;
  prompt?: string | null;
  stakeholder?: string | null;
  takeaway?: string;
  narrative?: string;
  sql?: string;
  sources?: { name?: string }[];
  trace?: { id?: string; totalMs?: number; toolCalls?: number; stages?: Record<string, unknown>[] } | null;
  toolStages?: { id?: string; name?: string; durationMs?: number; arguments?: string; result?: string }[];
  mlflow?: { traceId?: string; experimentId?: string | null; url?: string | null } | null;
  benchmark?: Record<string, unknown> | null;
  note?: string;
  undeclaredKeys?: string[];
  error?: string;
  [key: string]: unknown;
}

/**
 * An in-memory stand-in for Lakebase that actually stores and returns rows.
 *
 * The previous stub answered every query with `{ rows: [] }`, which meant the route
 * always saw an empty conversation and no attachments. Conversation history and
 * attachment text could therefore never appear on the wire in any route test, so
 * the two features most affected by the dropped-`custom_inputs` defect had no
 * route-level coverage at all.
 */
function memoryLakebase(attachments: StoredAttachment[] = [],
  /** Rows of `deployment_settings`, for the values the app resolves per request. */
  settings: Record<string, unknown>[] = []
) {
  const messages: StoredMessage[] = [];
  const benchmarkRuns: StoredBenchmarkRun[] = [];
  /**
   * Conversation id to owning address. Modelled because ownership is the only
   * thing standing between one user's history and another's: `messages` has no
   * address of its own, so every tenancy predicate in the routes resolves through
   * this table. A fake that ignored it could not fail when a route stopped
   * filtering, which is how three unscoped reads survived review.
   */
  const conversations = new Map<string, string>();

  /** The question a stored answer belongs to, skipping the plan-approval turn. */
  function questionBefore(index: number, conversationId: string, approvalMessage: string) {
    const questions = messages
      .slice(0, index)
      .filter((earlier) =>
          earlier.conversation_id === conversationId && earlier.role === 'user' && earlier.content !== approvalMessage
      );
    return questions.length > 0 ? questions[questions.length - 1].content : null;
  }

  return {
    messages,
    benchmarkRuns,
    conversations,
    query(text: string, params: unknown[] = []) {
      const sql = text.replace(/\s+/g, ' ').trim();

      // `ON CONFLICT DO UPDATE SET updated_at` touches the timestamp only, so an
      // existing conversation keeps the owner it was created with.
      if (sql.startsWith('INSERT INTO player_insights.conversations')) {
        const id = String(params[0]);
        if (!conversations.has(id)) conversations.set(id, String(params[1]));
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      }

      if (sql.startsWith('SELECT user_email FROM player_insights.conversations WHERE id = $1')) {
        const owner = conversations.get(String(params[0]));
        return Promise.resolve({ rows: owner === undefined ? [] : [{ user_email: owner }] });
      }

      if (sql.startsWith('SELECT resource_id')) {
        return Promise.resolve({ rows: settings });
      }

      if (sql.startsWith('INSERT INTO player_insights.benchmark_runs')) {
        benchmarkRuns.push({
          id: String(params[0]),
          suite_id: String(params[1]),
          user_email: String(params[2]),
          status: String(params[3]),
          metrics_json: params[4] ?? null,
          created_at: new Date().toISOString(),
        });
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      }

      if (sql.startsWith('INSERT INTO player_insights.messages')) {
        messages.push({
          id: String(params[0]),
          conversation_id: String(params[1]),
          role: String(params[2]),
          content: String(params[3]),
          response_json: params[4] ?? null,
          created_at: new Date(Date.now() + messages.length).toISOString(),
        });
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      }

      // Mirrors what RUNS_QUERY derives in Postgres: one run per answered turn,
      // labelled with the question that preceded it, newest first.
      if (sql.includes("'conversation' AS kind")) {
        const approvalMessage = String(params[0]);
        const caller = String(params[1]);
        const rows = messages
          .map((message, index) => ({ message, index, trace: storedTrace(message) }))
          .filter((entry) => entry.message.role === 'assistant' && entry.trace !== null)
          // The caller's own conversations only, as `c.user_email = $2` does.
          .filter((entry) => conversations.get(entry.message.conversation_id) === caller)
          .map(({ message, index, trace }) => {
            const stages = trace?.stages ?? [];
            const hasStage = (status: string) => stages.some((stage) => stage.status === status);
            return {
              id: message.id,
              kind: 'conversation',
              conversation_id: message.conversation_id,
              prompt: questionBefore(index, message.conversation_id, approvalMessage),
              stakeholder: caller,
              status: hasStage('failed') ? 'failed' : hasStage('partial') ? 'partial' : 'complete',
              duration_ms: Math.round(Number(trace?.totalMs ?? 0)),
              rating: null,
              created_at: message.created_at,
            };
          })
          .reverse();
        return Promise.resolve({ rows });
      }

      // GET /api/runs/:id/trace resolving a conversation run to its message row.
      // Matched on the id predicate, which RUNS_QUERY does not have: both read
      // `messages m JOIN conversations c`.
      if (sql.includes('WHERE m.id = $1')) {
        const caller = String(params[2]);
        const index = messages.findIndex((message) => message.id === params[0]);
        if (index < 0) return Promise.resolve({ rows: [] as Record<string, unknown>[] });
        const message = messages[index];
        // `c.user_email = $3`: a run id is a message id, and a message is only the
        // caller's if the conversation behind it is.
        if (conversations.get(message.conversation_id) !== caller) {
          return Promise.resolve({ rows: [] as Record<string, unknown>[] });
        }
        return Promise.resolve({
          rows: [
            {
              id: message.id,
              conversation_id: message.conversation_id,
              created_at: message.created_at,
              response_json: message.response_json,
              trace_id: null,
              stakeholder: caller,
              prompt: questionBefore(index, message.conversation_id, String(params[1])),
            },
          ],
        });
      }

      // The same route resolving a benchmark run, once the message lookup misses.
      // Shared across users, with the owner's address withheld unless it is the
      // caller's own run.
      if (sql.includes('FROM player_insights.benchmark_runs b WHERE b.id = $1')) {
        return Promise.resolve({
          rows: benchmarkRuns
            .filter((run) => run.id === params[0])
            .map((run) => ({
              ...run,
              user_email: run.user_email === params[1] ? run.user_email : SHARED_RUN_OWNER,
            })),
        });
      }

      // Matched on the outer projection rather than the join, which the run-trace
      // and stored-messages reads share.
      if (sql.startsWith('SELECT role, content, response_json FROM (')) {
        // Mirrors the route's `ORDER BY created_at DESC LIMIT 12` then re-ascend,
        // and its join: history belongs to the owner of the conversation.
        if (conversations.get(String(params[0])) !== String(params[1])) {
          return Promise.resolve({ rows: [] as Record<string, unknown>[] });
        }
        const rows = messages
          .filter((message) => message.conversation_id === params[0])
          .slice(-12)
          .map(({ role, content, response_json }) => ({ role, content, response_json }));
        return Promise.resolve({ rows });
      }

      if (sql.includes('FROM player_insights.attachments')) {
        const rows = attachments
          .filter((attachment) => attachment.conversation_id === params[0])
          .map(({ filename, extracted_text }) => ({ filename, extracted_text }));
        return Promise.resolve({ rows });
      }

      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
  };
}

/**
 * Stands in for Model Serving at the real contract boundary.
 *
 * The payload is JSON round-tripped first, so anything that would not survive an
 * HTTP POST is already gone before the approval decision. It then applies the same
 * rule the deployed agent applies in `agent.py::_is_approved`, execute when
 * `custom_inputs.approved_plan_id` or `custom_inputs.execute_plan` is present,
 * otherwise return a plan. A request that loses `custom_inputs` on the way to the
 * endpoint therefore gets a plan back, which is exactly how production failed.
 */
function agentContractTransport(captured: CapturedInvocation[]): ServingTransport {
  return ({ path, payload }) => {
    const wire = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    captured.push({ path, payload: wire });
    const customInputs = (wire.custom_inputs ?? {}) as Record<string, unknown>;
    const approved =
      Boolean(customInputs.approved_plan_id) || customInputs.execute_plan === true;
    return Promise.resolve(approved ? servingResponses.liveAnswerResponse : servingResponses.livePlanResponse
    );
  };
}

/**
 * One listener for the whole file, with the app under test mounted behind it.
 *
 * Every test here builds its own express app, because each needs its own store
 * and its own serving transport, and that is worth keeping. What is not worth
 * keeping is a TCP listener each: the file has over a hundred tests, so the old
 * shape opened over a hundred ephemeral ports and a couple of hundred loopback
 * connections per run, and threw them away again in under a second.
 *
 * That churn was the flake. When any one of those round trips is disturbed (an
 * ephemeral port recycled onto a socket the kernel still has in TIME_WAIT, or a
 * sandbox network policy that allow-lists ports and answers an unrecognised one
 * with a plain-text 403) the harness surfaces it as `TypeError: fetch failed`
 * or as `SyntaxError: Unexpected end of JSON input` from `response.json()`,
 * attributed to whichever test happened to be holding the socket. It looked
 * like a race in the test that reported it, and it never was: the same failure
 * reproduces with a bare `http.createServer` containing no application code,
 * and the ask route itself answers six hundred requests in a quiet process
 * without a single bad body.
 *
 * So the fix is not a retry or a longer timeout, it is one port and one pooled
 * connection for the file instead of hundreds. Mounted apps are addressed by a
 * header rather than by "the current one", so a request that outlives its test
 * gets a 410 it can be debugged from instead of being answered by the next
 * test's routes.
 */
const MOUNT_HEADER = 'x-harness-app';
const mountedApps = new Map<string, express.Express>();
let harness: http.Server | undefined;
let nextMountId = 0;

async function harnessPort(): Promise<number> {
  if (!harness) {
    harness = http.createServer((req, res) => {
      const app = mountedApps.get(String(req.headers[MOUNT_HEADER] ?? ''));
      if (!app) {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'harness_app_closed' }));
        return;
      }
      app(req, res);
    });
    const server = harness;
    await new Promise((resolve) => server.listen(0, () => resolve(undefined)));
  }
  const address = harness.address();
  return typeof address === 'object' && address ? address.port : 0;
}

afterAll(async () => {
  if (!harness) return;
  const server = harness;
  harness = undefined;
  // Idle keep-alive sockets are what make a `close` callback wait, and the
  // client has one open by design here.
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve(undefined)));
});

async function startInsightsApp(transport: ServingTransport,
  lakebase: InsightsAppKit['lakebase'] = { query: () => Promise.resolve({ rows: [] }) }
) {
  const app = express();
  app.use(express.json());
  const appkit: InsightsAppKit = {
    lakebase,
    server: { extend: (fn) => fn(app) },
    servingTransport: transport,
  };
  await setupInsightsRoutes(appkit);

  const port = await harnessPort();
  const mountId = String((nextMountId += 1));
  mountedApps.set(mountId, app);
  /** Every request carries the mount id, so it can only reach its own app. */
  const headers = (extra: Record<string, string> = {}) => ({ [MOUNT_HEADER]: mountId, ...extra });

  return {
    /**
     * `userToken` defaults to present because that is the ordinary request now:
     * Databricks Apps forwards the signed-in user's token, the route invokes the
     * endpoint with it, and the answer runs under that person's grants. Pass
     * null to exercise the fallback, which is a different answer. It carries a
     * caveat saying the application ran it instead.
     */
    async ask(body: Record<string, unknown>,
      userToken: string | null = 'forwarded-user-token'
    ): Promise<AskResponse> {
      const response = await fetch(`http://127.0.0.1:${port}/api/insights/ask`, {
        method: 'POST',
        headers: headers({
          'Content-Type': 'application/json',
          ...(userToken ? { 'x-forwarded-access-token': userToken } : {}),
        }),
        body: JSON.stringify(body),
      });
      return (await response.json()) as AskResponse;
    },
    /** As `ask`, but keeps the status, for the paths that refuse rather than answer. */
    async askRaw(body: Record<string, unknown>): Promise<{ status: number; body: AskResponse }> {
      const response = await fetch(`http://127.0.0.1:${port}/api/insights/ask`, {
        method: 'POST',
        headers: headers({
          'Content-Type': 'application/json',
          'x-forwarded-access-token': 'forwarded-user-token',
        }),
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as AskResponse };
    },
    async runs(): Promise<RunRow[]> {
      const response = await fetch(`http://127.0.0.1:${port}/api/runs`, { headers: headers() });
      return (await response.json()) as RunRow[];
    },
    async runTrace(id: string): Promise<{ status: number; body: RunTraceResponse }> {
      const response = await fetch(`http://127.0.0.1:${port}/api/runs/${encodeURIComponent(id)}/trace`, {
        headers: headers(),
      });
      return { status: response.status, body: (await response.json()) as RunTraceResponse };
    },
    /**
     * Starting a run. Returns the status alongside the body because this route
     * now has more than one honest answer: 202 with a `running` row when there
     * is an endpoint to benchmark, 503 when there is not. It used to have one,
     * 201, with the same six constants every time.
     */
    async benchmark(suiteId: string) {
      const response = await fetch(`http://127.0.0.1:${port}/api/benchmarks/run`, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ suiteId }),
      });
      return {
        status: response.status,
        body: (await response.json()) as { id?: string; error?: string; passed?: number },
      };
    },
    /**
     * Unmounts this test's app. The listener stays up for the next test, which
     * is the point; what closes here is the only thing that was ever per-test,
     * which is the app's reachability.
     */
    close() {
      mountedApps.delete(mountId);
      return Promise.resolve();
    },
  };
}

describe('plan approval round trip through POST /api/insights/ask', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  it('answers an approved plan instead of handing back another plan', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const captured: CapturedInvocation[] = [];
    const app = await startInsightsApp(agentContractTransport(captured));

    try {
      const planned = await app.ask({
        conversationId: 'conv-approval',
        prompt: NONTRIVIAL_QUESTION,
      });
      expect(planned.type).toBe('plan');
      expect(planned.plan?.id).toMatch(/^plan-/);

      const answered = await app.ask({
        conversationId: 'conv-approval',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: planned.plan?.id,
        executePlan: true,
      });

      expect(answered.type).toBe('answer');
      expect(answered.plan).toBeUndefined();
      expect(answered.mode).toBe('live');
      expect(answered.takeaway).toBeTruthy();
      expect(answered.sql).toMatch(/^(SELECT|WITH)/);
      expect(answered.figures?.length).toBeGreaterThan(0);
      expect(answered.sources?.length).toBeGreaterThan(0);
      expect(answered.trace?.stages?.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  /**
   * A transport that answers with a plan whatever it is sent, standing in for the
   * agent refusing an approval it cannot match. `planId` decides which refusal:
   * a new id is a re-issue, the same id is the agent ignoring the approval.
   */
  function alwaysPlans(planId: string): ServingTransport {
    return () => {
      const base = servingResponses.livePlanResponse;
      return Promise.resolve({
        ...base,
        custom_outputs: {
          ...base.custom_outputs,
          plan: { ...base.custom_outputs.plan, id: planId },
        },
      });
    };
  }

  /**
   * The agent now binds an approval to the plan that issued it, and re-issues on a
   * mismatch: a stale id, or one belonging to a different question.
   */
  it('re-renders a plan the agent re-issued instead of answering with canned figures', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(alwaysPlans('plan-freshly-issued'));

    try {
      const { status, body } = await app.askRaw({
        conversationId: 'conv-reissue',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: 'plan-stale-and-wrong',
        executePlan: true,
      });

      expect(status).toBe(200);
      expect(body.type).toBe('plan');
      expect(body.plan?.id).toBe('plan-freshly-issued');
      // The approval that was refused, on the record and in `response_json`.
      expect(body.supersededApprovalId).toBe('plan-stale-and-wrong');
      // The failure this replaces: an answer, with figures, that nothing produced.
      expect(body.figures).toBeUndefined();
      expect(body.takeaway).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('stores the re-issued plan as a plan turn, so the conversation is not silent about it', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const lakebase = memoryLakebase();
    const app = await startInsightsApp(alwaysPlans('plan-freshly-issued'), lakebase);

    try {
      await app.askRaw({
        conversationId: 'conv-reissue-stored',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: 'plan-stale-and-wrong',
        executePlan: true,
      });
    } finally {
      await app.close();
    }

    const assistant = lakebase.messages.find((message) => message.role === 'assistant');
    expect(String(assistant?.response_json)).toContain('"type":"plan"');
    expect(String(assistant?.response_json)).toContain('plan-stale-and-wrong');
  });

  /**
   * The one case the old warning was right to worry about, and the only reason it
   * fell through at all: the agent hands back the very plan just approved. Sending
   * that to the client would loop, approve, receive the same plan, approve.
   * Answering with representative figures is the other bad option. So neither.
   */
  it('refuses outright when the agent re-proposes the plan it was told to run', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(alwaysPlans('plan-approved-and-ignored'));

    try {
      const { status, body } = await app.askRaw({
        conversationId: 'conv-loop',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: 'plan-approved-and-ignored',
        executePlan: true,
      });

      expect(status).toBe(502);
      expect(body.error).toBe('plan_not_executed');
      // Not a plan, so the client cannot approve it again, and not an answer, so
      // there are no figures to mistake for a result.
      expect(body.type).toBeUndefined();
      expect(body.figures).toBeUndefined();
      expect(String(body.message)).toContain('not an answer');
    } finally {
      await app.close();
    }
  });

  it('leaves the ordinary unapproved proposal exactly as it was', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(alwaysPlans('plan-first-proposal'));

    try {
      const { status, body } = await app.askRaw({
        conversationId: 'conv-first',
        prompt: NONTRIVIAL_QUESTION,
      });

      expect(status).toBe(200);
      expect(body.type).toBe('plan');
      // No approval was sent, so nothing was superseded.
      expect(body.supersededApprovalId).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('puts the approval on the wire as snake_case custom_inputs', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const captured: CapturedInvocation[] = [];
    const app = await startInsightsApp(agentContractTransport(captured));

    try {
      await app.ask({ conversationId: 'conv-wire', prompt: NONTRIVIAL_QUESTION });
      await app.ask({
        conversationId: 'conv-wire',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: 'plan-under-test',
        executePlan: true,
      });
    } finally {
      await app.close();
    }

    expect(captured).toHaveLength(2);
    expect(captured[1]?.path).toBe('/serving-endpoints/player-insights-agent/invocations');
    expect(captured[1]?.payload.custom_inputs).toMatchObject({
      approved_plan_id: 'plan-under-test',
      execute_plan: true,
    });
    // The first, unapproved ask must not look approved.
    expect(captured[0]?.payload.custom_inputs).not.toHaveProperty('approved_plan_id');
  });
});

describe('serving request body', () => {
  it('omits approval keys until the user actually approves', () => {
    const body = buildAskServingBody({
      history: [{ role: 'user', content: NONTRIVIAL_QUESTION }],
      prompt: NONTRIVIAL_QUESTION,
      conversationId: 'conv-1',
      attachmentText: '',
    });

    expect(body.custom_inputs).toEqual({ conversation_id: 'conv-1' });
  });

  it('keeps the question when conversation history is unavailable', () => {
    const body = buildAskServingBody({
      history: [],
      prompt: NONTRIVIAL_QUESTION,
      conversationId: 'conv-1',
      approvedPlanId: 'plan-1',
      executePlan: true,
      attachmentText: 'report text',
    });

    expect(body.input).toEqual([{ role: 'user', content: NONTRIVIAL_QUESTION }]);
    expect(body.custom_inputs).toEqual({
      conversation_id: 'conv-1',
      approved_plan_id: 'plan-1',
      execute_plan: true,
      attachment_text: 'report text',
    });
  });

  it('builds the endpoint path the workspace client posts to', () => {
    expect(servingInvocationPath('player-insights-agent')).toBe('/serving-endpoints/player-insights-agent/invocations'
    );
  });

  it('cannot be sent through the SDK typed query, which drops custom_inputs', async () => {
    const body = buildAskServingBody({
      history: [{ role: 'user', content: NONTRIVIAL_QUESTION }],
      prompt: NONTRIVIAL_QUESTION,
      conversationId: 'conv-1',
      approvedPlanId: 'plan-1',
      executePlan: true,
      attachmentText: '',
    });

    const sent: Record<string, unknown>[] = [];
    const stubClient = {
      request: (options: { payload?: Record<string, unknown> }) => {
        sent.push(options.payload ?? {});
        return Promise.resolve({});
      },
    };
    type ServiceClient = ConstructorParameters<typeof sdkServing.ServingEndpointsService>[0];
    type QueryInput = Parameters<sdkServing.ServingEndpointsService['query']>[0];
    const service = new sdkServing.ServingEndpointsService(stubClient as unknown as ServiceClient);
    await service.query({ name: 'player-insights-agent', ...body } as unknown as QueryInput);

    // `servingEndpoints.query()` rebuilds the body from a fixed allowlist, so the
    // approval never reaches the agent. This is why the route posts to
    // /invocations directly; if a future SDK keeps custom_inputs, revisit that.
    expect(sent[0]).toHaveProperty('input');
    expect(sent[0]).not.toHaveProperty('custom_inputs');
  });
});

describe('the production serving transport', () => {
  interface SeenRequest {
    path: string;
    method: string;
    payload: Record<string, unknown>;
    headers: Headers;
  }

  function stubTransport(seen: SeenRequest[]) {
    return createServingTransport(() =>
      Promise.resolve({
        request: (options: SeenRequest) => {
          seen.push(options);
          return Promise.resolve(servingResponses.liveAnswerResponse);
        },
      })
    );
  }

  /**
   * The counterpart to 'cannot be sent through the SDK typed query'. That test proves
   * the old path drops `custom_inputs`; this one runs the real replacement and proves
   * it does not. Without it, nothing executes the transport and a regression back to
   * `servingEndpoints.query()` would leave every test green.
   */
  it('hands the body to the API client without rebuilding it', async () => {
    const seen: SeenRequest[] = [];
    const payload = buildAskServingBody({
      history: [{ role: 'user', content: NONTRIVIAL_QUESTION }],
      prompt: NONTRIVIAL_QUESTION,
      conversationId: 'conv-transport',
      approvedPlanId: 'plan-transport',
      executePlan: true,
      attachmentText: '## notes.txt\nHALCYON planning constraint.',
    });

    await stubTransport(seen)({
      path: servingInvocationPath('player-insights-agent'),
      payload,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.path).toBe('/serving-endpoints/player-insights-agent/invocations');
    // Identity, not deep equality: an allowlist rebuild would produce a new object.
    expect(seen[0]?.payload).toBe(payload);
    expect(seen[0]?.payload.custom_inputs).toEqual({
      conversation_id: 'conv-transport',
      approved_plan_id: 'plan-transport',
      execute_plan: true,
      attachment_text: '## notes.txt\nHALCYON planning constraint.',
    });
  });

  it('posts JSON so custom_inputs is carried in the request body', async () => {
    const seen: SeenRequest[] = [];
    await stubTransport(seen)({ path: '/serving-endpoints/x/invocations', payload: { a: 1 } });

    expect(seen[0]?.headers.get('Content-Type')).toBe('application/json');
  });
});

describe('what the route actually puts on the wire', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  it('sends stored attachment text, which no route test could previously observe', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const captured: CapturedInvocation[] = [];
    const lakebase = memoryLakebase([
      {
        conversation_id: 'conv-attach',
        filename: 'halcyon-memo.txt',
        extracted_text: 'Project HALCYON-7742 retires Iron Frontier Online on 2026-11-15.',
      },
    ]);
    const app = await startInsightsApp(agentContractTransport(captured), lakebase);

    try {
      await app.ask({
        conversationId: 'conv-attach',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: 'plan-attach',
        executePlan: true,
      });
    } finally {
      await app.close();
    }

    const customInputs = captured[0]?.payload.custom_inputs as Record<string, unknown>;
    // The agent keys off `attachment_text`; the heading is how it attributes a source.
    expect(customInputs.attachment_text).toBe('## halcyon-memo.txt\nProject HALCYON-7742 retires Iron Frontier Online on 2026-11-15.'
    );
  });

  it('concatenates every attachment in the conversation', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const captured: CapturedInvocation[] = [];
    const lakebase = memoryLakebase([
      { conversation_id: 'conv-two', filename: 'a.txt', extracted_text: 'first report' },
      { conversation_id: 'conv-two', filename: 'b.pdf', extracted_text: 'second report' },
      { conversation_id: 'other', filename: 'c.txt', extracted_text: 'must not leak' },
    ]);
    const app = await startInsightsApp(agentContractTransport(captured), lakebase);

    try {
      await app.ask({ conversationId: 'conv-two', prompt: NONTRIVIAL_QUESTION });
    } finally {
      await app.close();
    }

    const customInputs = captured[0]?.payload.custom_inputs as Record<string, unknown>;
    expect(customInputs.attachment_text).toBe('## a.txt\nfirst report\n\n## b.pdf\nsecond report'
    );
    expect(String(customInputs.attachment_text)).not.toContain('must not leak');
  });

  it('omits attachment_text entirely when the conversation has no attachments', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const captured: CapturedInvocation[] = [];
    const app = await startInsightsApp(agentContractTransport(captured), memoryLakebase());

    try {
      await app.ask({ conversationId: 'conv-none', prompt: NONTRIVIAL_QUESTION });
    } finally {
      await app.close();
    }

    expect(captured[0]?.payload.custom_inputs).not.toHaveProperty('attachment_text');
  });

  it('sends the last twelve stored turns as the conversation history', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const captured: CapturedInvocation[] = [];
    const lakebase = memoryLakebase();
    // Seven trivial asks store a user and an assistant row each, so the eighth ask
    // has more turns behind it than the route is allowed to forward.
    const app = await startInsightsApp(agentContractTransport(captured), lakebase);

    try {
      for (let index = 0; index < 7; index += 1) {
        await app.ask({ conversationId: 'conv-history', prompt: `seed question ${index}` });
      }
      await app.ask({
        conversationId: 'conv-history',
        prompt: 'And what about the same metric by title?',
        approvedPlanId: 'plan-history',
        executePlan: true,
      });
    } finally {
      await app.close();
    }

    const input = captured[captured.length - 1]?.payload.input as {
      role: string;
      content: string;
    }[];
    // Seven plan replies plus the answered question leave sixteen stored turns. The
    // window was taken at fifteen, so it opens mid-pair on an assistant turn and
    // always closes on the live question.
    expect(lakebase.messages).toHaveLength(16);
    expect(input).toHaveLength(12);
    expect(input.map((turn) => turn.role)).toEqual([
      ...Array.from({ length: 5 }, () => ['assistant', 'user']).flat(),
      'assistant',
      'user',
    ]);
    expect(JSON.stringify(input)).not.toContain('seed question 0');
    expect(JSON.stringify(input)).not.toContain('seed question 1');
    expect(JSON.stringify(input)).toContain('seed question 6');
    expect(input[input.length - 1]).toEqual({
      role: 'user',
      content: 'And what about the same metric by title?',
    });
  });

  it('replays a stored plan turn with its id so the agent can match the approval', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const captured: CapturedInvocation[] = [];
    const lakebase = memoryLakebase();
    const app = await startInsightsApp(agentContractTransport(captured), lakebase);

    try {
      const planned = await app.ask({
        conversationId: 'conv-replay',
        prompt: NONTRIVIAL_QUESTION,
      });
      await app.ask({
        conversationId: 'conv-replay',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: planned.plan?.id,
        executePlan: true,
      });
    } finally {
      await app.close();
    }

    const input = captured[1]?.payload.input as { role: string; content: string }[];
    const assistantTurn = input.find((turn) => turn.role === 'assistant');
    expect(assistantTurn?.content).toContain('Plan ID: ');
    // The route stores 'Approved the proposed analysis plan.' but must send the question.
    expect(input[input.length - 1]?.content).toBe(NONTRIVIAL_QUESTION);
  });
});

describe('the answer contract survives the round trip into the HTTP response', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  it('forwards every field of custom_outputs.answer unchanged', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    let answered: AskResponse;
    try {
      answered = await app.ask({
        conversationId: 'conv-contract',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: 'plan-contract',
        executePlan: true,
      });
    } finally {
      await app.close();
    }

    const endpointAnswer = servingResponses.liveAnswerResponse.custom_outputs.answer as Record<
      string,
      unknown
    >;

    // Comparing key-by-key means a widened agent contract fails here rather than
    // disappearing silently on the way to the browser.
    for (const [key, value] of Object.entries(endpointAnswer)) {
      // The trace is compared below. It is the one field the app fills in rather
      // than forwards verbatim: `depth` and `parent_id` are defaulted onto stages
      // from a model version that predates them.
      if (key === 'trace') continue;
      expect(answered[key], `custom_outputs.answer.${key} did not reach the response`).toEqual(value
      );
    }
    const trace = endpointAnswer.trace as { stages: Record<string, unknown>[] };
    expect(answered.trace).toEqual({
      ...trace,
      stages: trace.stages.map((stage) => ({ depth: 0, parent_id: '', ...stage })),
    });
    expect(answered.type).toBe('answer');
    expect(answered.mode).toBe('live');
  });

  /**
   * The mirror image of the custom_inputs defect. A zod object strips undeclared
   * keys by default, so a v8 agent returning a new field would have it deleted
   * between the endpoint and the browser with nothing logged. Strict parsing
   * would reject the whole answer and fall back to representative content, which
   * is a worse outcome, so the contract is loose and the gap is reported.
   */
  it('forwards fields a newer agent adds, and says so', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });

    const base = servingResponses.liveAnswerResponse.custom_outputs.answer as Record<
      string,
      unknown
    >;
    const widened = {
      ...servingResponses.liveAnswerResponse,
      custom_outputs: {
        ...servingResponses.liveAnswerResponse.custom_outputs,
        answer: {
          ...base,
          confidence: 0.82,
          trace: { ...(base.trace as Record<string, unknown>), modelVersion: 8 },
        },
      },
    };

    const app = await startInsightsApp(() => Promise.resolve(widened), memoryLakebase());
    let answered: AskResponse;
    try {
      answered = await app.ask({
        conversationId: 'conv-widened',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
    } finally {
      await app.close();
      warn.mockRestore();
    }

    expect(answered.confidence).toBe(0.82);
    expect((answered.trace as Record<string, unknown>).modelVersion).toBe(8);
    expect(warnings.join('\n')).toContain('confidence');
    expect(warnings.join('\n')).toContain('trace.modelVersion');
  });

  it('returns a clarification as itself, not as an answer to a question nobody asked', async () => {
    // The failure this prevents: a clarification carries no `takeaway`, so the
    // answer parse fails, and the route's fallback served the representative
    // answer (figures, SQL and all), for a question the agent had just said it
    // could not answer. HTTP 200, nothing logged, wrong numbers on screen.
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const lakebase = memoryLakebase();
    const app = await startInsightsApp(() => Promise.resolve(clarificationResponse()), lakebase);

    let answered: AskResponse;
    try {
      answered = await app.ask({
        conversationId: 'conv-clarify',
        prompt: 'How many rows are in the master table?',
        executePlan: true,
      });
    } finally {
      await app.close();
    }

    expect(answered.type).toBe('clarification');
    expect(answered.mode).toBe('live');
    const clarification = answered.clarification as Record<string, unknown>;
    expect(clarification.question).toContain('catalog.schema.table');
    expect(clarification.options).toHaveLength(2);
    // None of the representative answer leaked in alongside it.
    expect(answered.figures).toBeUndefined();
    expect(answered.takeaway).toBeUndefined();
    expect(answered.sql).toBeUndefined();
  });

  it('stores the question it asked, so the conversation reads as a conversation', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const lakebase = memoryLakebase();
    const app = await startInsightsApp(() => Promise.resolve(clarificationResponse()), lakebase);

    try {
      await app.ask({
        conversationId: 'conv-clarify',
        prompt: 'How many rows are in the master table?',
        executePlan: true,
      });
    } finally {
      await app.close();
    }

    const stored = lakebase.messages.filter((message) => message.role === 'assistant');
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toContain('catalog.schema.table');
    const payload = JSON.parse(String(stored[0].response_json)) as Record<string, unknown>;
    expect(payload.type).toBe('clarification');

    // And the stored turn carries the question forward as the assistant's words,
    // so the user's reply reads as an answer to it rather than as a new question.
    const history = buildServingHistory([
      { role: 'user', content: 'How many rows are in the master table?' },
      { role: 'assistant', content: stored[0].content, response_json: payload },
    ]);
    expect(history[1]?.content).toContain('catalog.schema.table');
  });

  it('shows the steps that led to a question when the run is opened', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const lakebase = memoryLakebase();
    const app = await startInsightsApp(() => Promise.resolve(clarificationResponse()), lakebase);

    try {
      const answered = await app.ask({
        conversationId: 'conv-clarify-trace',
        prompt: 'How many rows are in the master table?',
        executePlan: true,
      });
      const clarification = answered.clarification as { id: string };
      const { status, body } = await app.runTrace(`msg-${clarification.id}`);

      expect(status).toBe(200);
      expect(body.state).toBe('trace');
      expect(body.trace?.stages?.length).toBeGreaterThan(0);
      expect(body.takeaway).toContain('catalog.schema.table');
      expect(body.note).toContain('question back to the user');
      // Nothing was read, so nothing is cited: the same rule the answer path follows.
      expect(body.sources).toEqual([]);
      expect(body.sql).toBe('');
    } finally {
      await app.close();
    }
  });

  it('keeps the trace detail the trace panel renders', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    let answered: AskResponse;
    try {
      answered = await app.ask({
        conversationId: 'conv-trace',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
    } finally {
      await app.close();
    }

    const expected = servingResponses.liveAnswerResponse.custom_outputs.answer.trace;
    expect(answered.trace?.id).toBe(expected.id);
    expect(answered.trace?.totalMs).toBe(expected.totalMs);
    expect(answered.trace?.toolCalls).toBe(expected.toolCalls);
    // This fixture was captured from a model version that predates the nesting
    // keys, so `depth` and `parent_id` are absent from it. They are DEFAULTED
    // rather than optional (the same choice `charts` makes), so every stage the
    // timeline receives has a level, whichever agent version produced it.
    expect(answered.trace?.stages).toEqual(expected.stages.map((stage) => ({ depth: 0, parent_id: '', ...stage }))
    );
    expect(answered.caveats).toEqual(servingResponses.liveAnswerResponse.custom_outputs.answer.caveats
    );
  });

  it('says so when the question ran as the application instead of as the reader', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      // No forwarded token, which is what a background caller looks like and
      // what a deployment missing `serving.serving-endpoints` from its user
      // scopes looks like. Either way the endpoint sees the app, so the
      // warehouse enforces the app's grants and not the reader's.
      const fellBack = await app.ask({ conversationId: 'conv-sp-fallback', prompt: NONTRIVIAL_QUESTION, executePlan: true },
        null
      );
      expect(fellBack.caveats).toContain(SERVICE_PRINCIPAL_FALLBACK_CAVEAT);

      // And the ordinary case does not carry it. This half matters as much: a
      // caveat on every answer is a caveat nobody reads, and it would make the
      // claim the product is built on unfalsifiable.
      const ranAsUser = await app.ask({
        conversationId: 'conv-user-executed',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
      expect(ranAsUser.caveats).not.toContain(SERVICE_PRINCIPAL_FALLBACK_CAVEAT);
    } finally {
      await app.close();
    }
  });

  it('does not leave representative figures behind when the endpoint answers', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    let answered: AskResponse;
    try {
      answered = await app.ask({
        conversationId: 'conv-no-mix',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
    } finally {
      await app.close();
    }

    const representative = representativeAnswer(NONTRIVIAL_QUESTION);
    expect(answered.figures).not.toEqual(representative.figures);
    expect(answered.sources).not.toEqual(representative.sources);
    expect(answered.id).not.toBe(representative.id);
  });
});

/**
 * The `charts` half of the answer contract.
 *
 * Written against inline specs rather than the captured fixture on purpose: charts are
 * meant to come out of whatever the query returned, so a test that only ever sees one
 * recorded shape would not notice the schema quietly narrowing to it.
 */
describe('Plotly charts on the answer contract', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  function chart(overrides: Record<string, unknown> = {}) {
    return {
      id: 'chart-1',
      title: 'A title from the result set',
      kind: 'bar',
      data: [{ type: 'bar', x: ['a', 'b'], y: [2, 1], marker: { color: '#e4002b' } }],
      layout: { barmode: 'group', yaxis: { tickformat: ',' } },
      ...overrides,
    };
  }

  function answerWithCharts(charts: unknown) {
    const base = liveAnswerResponse.custom_outputs.answer as Record<string, unknown>;
    return {
      ...liveAnswerResponse,
      custom_outputs: {
        ...liveAnswerResponse.custom_outputs,
        answer: { ...base, charts },
      },
    };
  }

  it('reads a chart out of custom_outputs.answer', () => {
    const parsed = extractStructuredAnswer(answerWithCharts([chart()]));

    expect(parsed?.charts).toHaveLength(1);
    expect(parsed?.charts[0]?.kind).toBe('bar');
    expect(parsed?.charts[0]?.title).toBe('A title from the result set');
  });

  /**
   * The reason `charts` is defaulted rather than required. The agent and the app deploy
   * separately, so there is always a window where the endpoint is still returning the
   * previous contract. Requiring the field would fail the parse and hand the browser a
   * representative answer over HTTP 200: a live agent silently reduced to canned text.
   */
  it('still reads an answer from an endpoint that returns no charts at all', () => {
    const base = liveAnswerResponse.custom_outputs.answer as Record<string, unknown>;
    expect('charts' in base).toBe(false);

    const parsed = extractStructuredAnswer(liveAnswerResponse);
    expect(parsed).not.toBeNull();
    expect(parsed?.charts).toEqual([]);
    expect(parsed?.takeaway).toBe(base.takeaway);
  });

  it('rejects a chart missing its envelope rather than half-rendering it', () => {
    // `data` is the panel. An envelope without one would reach the client as a card
    // with nothing in it.
    const broken = extractStructuredAnswer(answerWithCharts([{ id: 'chart-1', title: 't', kind: 'bar' }])
    );
    expect(broken).toBeNull();
  });

  it('carries Plotly trace and layout keys through untouched', () => {
    // Plotly's vocabulary is several hundred keys deep and depends on the trace type,
    // so the schema validates that these are objects and does not enumerate them.
    const exotic = chart({
      kind: 'combo',
      data: [
        { type: 'scatter', mode: 'lines', x: [1, 2], y: [3, 4], line: { dash: 'dot', width: 2 } },
        { type: 'bar', x: [1, 2], y: [5, 6], hovertemplate: '%{y:,}<extra></extra>' },
      ],
      layout: { hovermode: 'x unified', legend: { orientation: 'h' }, bargap: 0.28 },
    });

    const parsed = extractStructuredAnswer(answerWithCharts([exotic]));
    expect(parsed?.charts[0]).toEqual(exotic);
  });

  it('does not report Plotly keys as contract drift', () => {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    try {
      extractStructuredAnswer(answerWithCharts([chart()]));
    } finally {
      warn.mockRestore();
    }
    expect(warnings.join('\n')).not.toContain('barmode');
    expect(warnings.join('\n')).not.toContain('marker');
  });

  it('reports an unknown key on the chart envelope, where drift would matter', () => {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    try {
      extractStructuredAnswer(answerWithCharts([chart({ caption: 'a newer agent field' })]));
    } finally {
      warn.mockRestore();
    }
    expect(warnings.join('\n')).toContain('charts[0].caption');
  });

  it('reaches the HTTP response the browser reads', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const specs = [chart(), chart({ id: 'chart-2', kind: 'line' })];
    const app = await startInsightsApp(() => Promise.resolve(answerWithCharts(specs)),
      memoryLakebase()
    );

    let answered: AskResponse;
    try {
      answered = await app.ask({
        conversationId: 'conv-charts',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
    } finally {
      await app.close();
    }

    expect(answered.mode).toBe('live');
    expect(answered.charts).toEqual(specs);
  });

  it('is persisted with the answer, so reopening a conversation still has its charts', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const specs = [chart()];
    const lakebase = memoryLakebase();
    const app = await startInsightsApp(() => Promise.resolve(answerWithCharts(specs)), lakebase);

    let answeredId: string | undefined;
    try {
      answeredId = (await app.ask({
          conversationId: 'conv-charts-stored',
          prompt: NONTRIVIAL_QUESTION,
          executePlan: true,
        })
      ).id as string;
    } finally {
      await app.close();
    }

    const row = lakebase.messages.find((message) => message.id === answeredId);
    const stored = JSON.parse(String(row?.response_json)) as Record<string, unknown>;
    expect(stored.charts).toEqual(specs);
  });
});

describe('identity and benchmark records', () => {
  it('discloses the service-principal execution identity', () => {
    process.env.DATABRICKS_CLIENT_ID = 'sp-1234';
    expect(identityPayload(request({ 'x-forwarded-email': 'analyst@example.example' }))).toEqual({
      signedInAs: 'analyst@example.example',
      identitySource: 'databricks-apps',
      executionIdentity: 'sp-1234',
      executionMode: 'service-principal',
      // Nobody has been through the access gate in this process, so there is no
      // decision to report, and the default is still the truthful label,
      // because the service principals execute whether or not anyone was asked.
      accessDecision: null,
      // The identity that actually reaches Genie and Unity Catalog, which is a
      // different principal from `executionIdentity` above. Null rather than
      // guessed: it is only knowable from a preflight report that has come back.
      servingPrincipal: null,
      // Whether the rail is carrying more than this person's conversations.
      // Asserted exhaustively on purpose: this payload is what the page knows
      // about who it is acting for, and a field appearing in it unnoticed is
      // how the page ends up describing a scope nobody chose.
      sharedConversationRail: false,
    });
  });

  it('reports the serving principal separately once a preflight has named it', () => {
    process.env.DATABRICKS_CLIENT_ID = 'app-sp';
    rememberServingPrincipal({ principal: 'serving-sp', principal_resolved: true });
    const payload = identityPayload(request({ 'x-forwarded-email': 'analyst@example.example' }));

    // The whole point of the pair: the app authenticates as one principal and
    // the thing that touches the data authenticates as another.
    expect(payload.executionIdentity).toBe('app-sp');
    expect(payload.servingPrincipal?.id).toBe('serving-sp');
    expect(payload.servingPrincipal?.id).not.toBe(payload.executionIdentity);
    forgetServingPrincipal();
  });

  it('reports a mode the server established rather than a fixed literal', () => {
    recordVerifiedAccess('analyst@example.example', 'holds SELECT on 10 tables');
    const payload = identityPayload(request({ 'x-forwarded-email': 'analyst@example.example' }));
    expect(payload.executionMode).toBe('user-verified');
    expect(payload.accessDecision?.detail).toContain('10 tables');

    // And it belongs to that user alone.
    expect(identityPayload(request({ 'x-forwarded-email': 'other@example.example' })).executionMode).toBe('service-principal'
    );
    forgetAccessDecisions();
  });

  it('marks a development identity as one rather than naming a person', () => {
    process.env.DATABRICKS_CLIENT_ID = 'sp-1234';
    const payload = identityPayload(request());

    // The old default returned the deployer's own address here, so a request
    // with no identity was indistinguishable from that person signing in.
    expect(payload.signedInAs).toBe(DEVELOPMENT_IDENTITY);
    expect(payload.identitySource).toBe('development-fallback');
    expect(payload.signedInAs).not.toContain('@databricks.com');
  });

  it('falls back to a readable execution identity when the client id is absent', () => {
    delete process.env.DATABRICKS_CLIENT_ID;
    expect(identityPayload(request()).executionIdentity).toBe('Player Insights service principal');
  });
});

/**
 * "Explore full run" sent people to a Run Explorer that read `benchmark_runs`
 * alone, so the conversation they had just finished was structurally absent from
 * the list. The answer was stored, in full, as a message nobody queried.
 */
describe('an answered conversation is a run', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  it('reads answered turns as well as benchmark runs', () => {
    const sql = RUNS_QUERY.replace(/\s+/g, ' ');

    expect(sql).toContain('FROM player_insights.messages m');
    expect(sql).toContain('FROM player_insights.benchmark_runs b');
    expect(sql).toContain('UNION ALL');
    // A plan proposal carries no trace, so it is a pending approval, not a run.
    expect(sql).toContain("jsonb_typeof(m.response_json->'trace') = 'object'");
  });

  it('lists a just-answered question, keyed by the id the answer came back with', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]),
      memoryLakebase()
    );

    try {
      const planned = await app.ask({ conversationId: 'conv-run', prompt: NONTRIVIAL_QUESTION });
      const answered = await app.ask({
        conversationId: 'conv-run',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: planned.plan?.id,
        executePlan: true,
      });
      expect(answered.type).toBe('answer');

      const runs = await app.runs();
      const run = runs.find((candidate) => candidate.id === answered.id);

      // Without a run for this turn the Run Explorer can only show the fallback rows.
      expect(runs.map((candidate) => candidate.id)).not.toContain('run-1042');
      expect(run).toBeDefined();
      expect(run?.kind).toBe('conversation');
      expect(run?.conversation_id).toBe('conv-run');
      // The link needs the question, not "Approved the proposed analysis plan."
      expect(run?.prompt).toBe(NONTRIVIAL_QUESTION);
      expect(run?.prompt).not.toBe(PLAN_APPROVAL_MESSAGE);
      expect(run?.duration_ms).toBe(Math.round(answered.trace?.totalMs ?? 0));

      // Status is the worst stage outcome, so a degraded run cannot list as clean.
      const stages = (answered.trace?.stages ?? []) as { status?: string }[];
      expect(stages.some((stage) => stage.status === 'partial')).toBe(true);
      expect(run?.status).toBe('partial');
    } finally {
      await app.close();
    }
  });

  it('leaves an unapproved plan out of the list', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const planned = await app.ask({ conversationId: 'conv-plan', prompt: NONTRIVIAL_QUESTION });
      expect(planned.type).toBe('plan');

      // Nothing derived, so the route falls back to the representative rows.
      const runs = await app.runs();
      expect(runs.map((run) => run.id)).toEqual(['run-1042', 'run-1041', 'run-1040']);
      expect(runs.some((run) => run.prompt === planned.plan?.id)).toBe(false);
    } finally {
      await app.close();
    }
  });

  /**
   * The whole journey the "Explore full run" button makes, on the shape of turn
   * that button is most often pressed on: the first answered turn of a brand-new
   * conversation, whose stages include a `partial`.
   *
   * Asserted end to end rather than a link at a time, because each hop was
   * already covered and the defect lived between them.
   */
  it('carries the first turn of a new conversation all the way to its trace', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const planned = await app.ask({ conversationId: 'conv-first-turn', prompt: NONTRIVIAL_QUESTION });
      const answered = await app.ask({
        conversationId: 'conv-first-turn',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: planned.plan?.id,
        executePlan: true,
      });

      const run = (await app.runs()).find((candidate) => candidate.id === answered.id);
      expect(run?.status).toBe('partial');

      // The id the button puts in the URL is the id the trace route answers to.
      const { status, body } = await app.runTrace(String(answered.id));
      expect(status).toBe(200);
      expect(body.runId).toBe(answered.id);
      expect(body.state).toBe('trace');
    } finally {
      await app.close();
    }
  });
});

/**
 * An answer the store did not keep.
 */
describe('an answer the store did not keep', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  /**
   * A store that refuses exactly one statement: the write of an answered turn.
   * Everything else: the conversation, the question, the reads behind it,
   * succeeds, which is what makes the failure invisible from anywhere else.
   */
  function lakebaseThatDropsAnswers() {
    const backing = memoryLakebase();
    const refused: string[] = [];
    return {
      refused,
      messages: backing.messages,
      lakebase: {
        query(text: string, params: unknown[] = []) {
          const sql = text.replace(/\s+/g, ' ').trim();
          if (sql.startsWith('INSERT INTO player_insights.messages') && isAnsweredTurn(params)) {
            refused.push(String(params[0]));
            return Promise.reject(new Error('Connection terminated due to connection timeout'));
          }
          return backing.query(text, params);
        },
      },
    };
  }

  /** The same test `RUNS_QUERY` applies: an assistant turn carrying a trace object. */
  function isAnsweredTurn(params: unknown[]) {
    if (params[2] !== 'assistant' || typeof params[4] !== 'string') return false;
    try {
      const parsed = JSON.parse(params[4]) as { trace?: unknown };
      return Boolean(parsed.trace) && typeof parsed.trace === 'object';
    } catch {
      return false;
    }
  }

  it('still answers, and says the run behind the answer was not stored', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const store = lakebaseThatDropsAnswers();
    const app = await startInsightsApp(agentContractTransport([]), store.lakebase);

    try {
      const planned = await app.ask({ conversationId: 'conv-dropped', prompt: NONTRIVIAL_QUESTION });
      const answered = await app.ask({
        conversationId: 'conv-dropped',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: planned.plan?.id,
        executePlan: true,
      });

      // The answer is not withheld. Losing the row does not make the work wrong.
      expect(answered.type).toBe('answer');
      expect(answered.takeaway).toBeTruthy();
      // Twice: a dropped connection is retryable, and the write is tried again
      // on a fresh one before the store is called unavailable.
      expect(store.refused).toEqual([answered.id, answered.id]);

      // And the response says the run is not there, so nothing offers to open it.
      expect(answered.runStored).toBe(false);

      const runs = await app.runs();
      expect(runs.map((run) => run.id)).not.toContain(answered.id);
    } finally {
      await app.close();
    }
  });

  /**
   * The same hole reached through the other write. `messages` has no owner of
   * its own, so `RUNS_QUERY` joins `conversations` to scope runs to the caller,
   * which means a first turn whose conversation row is lost stores an answer no
   * query can reach, however well the answer itself was written.
   */
  it('counts a first turn whose conversation row was lost as not stored', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const backing = memoryLakebase();
    const app = await startInsightsApp(agentContractTransport([]), {
      query(text: string, params: unknown[] = []) {
        if (text.replace(/\s+/g, ' ').trim().startsWith('INSERT INTO player_insights.conversations')) {
          return Promise.reject(new Error('Connection terminated due to connection timeout'));
        }
        return backing.query(text, params);
      },
    });

    try {
      const planned = await app.ask({ conversationId: 'conv-orphan', prompt: NONTRIVIAL_QUESTION });
      const answered = await app.ask({
        conversationId: 'conv-orphan',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: planned.plan?.id,
        executePlan: true,
      });

      expect(answered.type).toBe('answer');
      // The answer row itself landed, and is still unreachable.
      expect(backing.messages.some((message) => message.id === answered.id)).toBe(true);
      expect((await app.runs()).map((run) => run.id)).not.toContain(answered.id);
      expect(answered.runStored).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('reports a stored answer as stored, so the ordinary case still links', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const planned = await app.ask({ conversationId: 'conv-kept', prompt: NONTRIVIAL_QUESTION });
      const answered = await app.ask({
        conversationId: 'conv-kept',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: planned.plan?.id,
        executePlan: true,
      });

      expect(answered.runStored).toBe(true);
      expect((await app.runs()).map((run) => run.id)).toContain(answered.id);
    } finally {
      await app.close();
    }
  });
});

/**
 * Selecting a run showed the right id, wall time, and status next to a trace
 * that belonged to no run at all: a hardcoded reference shape. Looking real
 * while being unrelated is the specific failure these tests exist to prevent,
 * so most of them assert that what comes back matches the run that was asked
 * for and could not have come from the reference constant.
 */
describe('GET /api/runs/:id/trace', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
  const savedExperiment = process.env.PLAYER_INSIGHTS_EXPERIMENT_ID;
  const savedHost = process.env.DATABRICKS_HOST;

  afterEach(() => {
    for (const [name, value] of [
      ['DATABRICKS_SERVING_ENDPOINT_NAME', savedEndpoint],
      ['PLAYER_INSIGHTS_EXPERIMENT_ID', savedExperiment],
      ['DATABRICKS_HOST', savedHost],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** Answers a question end to end so a real stored run exists to look up. */
  async function answeredRun(app: Awaited<ReturnType<typeof startInsightsApp>>, conversationId: string) {
    const planned = await app.ask({ conversationId, prompt: NONTRIVIAL_QUESTION });
    const answered = await app.ask({
      conversationId,
      prompt: NONTRIVIAL_QUESTION,
      approvedPlanId: planned.plan?.id,
      executePlan: true,
    });
    expect(answered.type).toBe('answer');
    return answered;
  }

  it('resolves both kinds of run by id, and only by id', () => {
    const message = RUN_TRACE_MESSAGE_QUERY.replace(/\s+/g, ' ');
    const benchmark = RUN_TRACE_BENCHMARK_QUERY.replace(/\s+/g, ' ');

    expect(message).toContain('FROM player_insights.messages m');
    expect(message).toContain('WHERE m.id = $1');
    // The prompt label skips the approval turn, exactly as the run list does.
    expect(message).toContain('u.content <> $2');
    expect(benchmark).toContain('FROM player_insights.benchmark_runs b');
    expect(benchmark).toContain('WHERE b.id = $1');
  });

  /**
   * The registry calls `experiment-id` app-runtime ("the app reads this on every
   * request, so a value saved here takes effect immediately"), and the settings
   * pane reports a saved value as in force, from `app-saved`, editable. Nothing
   * read it: the deep link was built from `PLAYER_INSIGHTS_EXPERIMENT_ID` alone,
   * so a deployer whose experiment did not exist at release time saved the right
   * id, was told it had taken effect, and got no link on any trace.
   */
  it('links a stored trace into the experiment saved in the app, not only the one in the environment', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    process.env.DATABRICKS_HOST = 'https://example.cloud.databricks.com';
    delete process.env.PLAYER_INSIGHTS_EXPERIMENT_ID;
    const app = await startInsightsApp(agentContractTransport([]),
      memoryLakebase([], [
        {
          resource_id: 'experiment-id',
          value: '9998887776665554',
          intent: 'active',
          updated_by: 'deployer@acme.com',
        },
      ])
    );

    try {
      const answered = await answeredRun(app, 'conv-trace-experiment');
      const { body } = await app.runTrace(String(answered.id));
      const mlflow = body.mlflow as { experimentId: string | null; url: string | null } | null;

      expect(mlflow?.experimentId).toBe('9998887776665554');
      expect(mlflow?.url).toContain('/ml/experiments/9998887776665554/traces');
    } finally {
      await app.close();
    }
  });

  it('leaves the link off, and the id on, when nothing names an experiment', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    process.env.DATABRICKS_HOST = 'https://example.cloud.databricks.com';
    delete process.env.PLAYER_INSIGHTS_EXPERIMENT_ID;
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const answered = await answeredRun(app, 'conv-trace-no-experiment');
      const { body } = await app.runTrace(String(answered.id));
      const mlflow = body.mlflow as { traceId: string; experimentId: string | null; url: string | null } | null;

      expect(mlflow?.traceId).toMatch(/^tr-/);
      expect(mlflow?.experimentId).toBeNull();
      expect(mlflow?.url).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("returns the selected run's own stages rather than a reference shape", async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const answered = await answeredRun(app, 'conv-trace-read');
      const { status, body } = await app.runTrace(String(answered.id));

      expect(status).toBe(200);
      expect(body.runId).toBe(answered.id);
      expect(body.kind).toBe('conversation');
      expect(body.state).toBe('trace');
      expect(body.mode).toBe('live');
      expect(body.conversationId).toBe('conv-trace-read');
      expect(body.prompt).toBe(NONTRIVIAL_QUESTION);

      // Identical to what the answer carried, and different from the reference run.
      expect(body.trace?.id).toBe(answered.trace?.id);
      expect(body.trace?.totalMs).toBe(answered.trace?.totalMs);
      expect(body.trace?.stages).toEqual(answered.trace?.stages);
      expect(body.takeaway).toBe(answered.takeaway);
      expect(body.sql).toBe(answered.sql);

      const reference = representativeAnswer(NONTRIVIAL_QUESTION);
      expect(body.trace?.stages?.map((stage) => stage.id)).not.toEqual(reference.trace.stages.map((stage) => stage.id));
      expect(body.trace?.totalMs).not.toBe(reference.trace.totalMs);
    } finally {
      await app.close();
    }
  });

  it('restates the tool stages with their arguments and results', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const answered = await answeredRun(app, 'conv-trace-tools');
      const { body } = await app.runTrace(String(answered.id));

      const stages = (answered.trace?.stages ?? []) as { kind?: string; id?: string; input?: string }[];
      const toolStages = stages.filter((stage) => stage.kind === 'tool');
      expect(body.toolStages?.map((stage) => stage.id)).toEqual(toolStages.map((stage) => stage.id));
      for (const [index, stage] of (body.toolStages ?? []).entries()) {
        expect(stage.arguments).toBe(toolStages[index].input);
      }
      // The agent's own counter is kept separate; it counts work with no tool stage.
      expect(body.trace?.toolCalls).toBe(answered.trace?.toolCalls);
    } finally {
      await app.close();
    }
  });

  /**
   * The two tool-work quantities are allowed to disagree, and the endpoint must
   * report both rather than reconciling them. This pins the disagreement against a
   * response captured from the deployed endpoint, which reports a non-zero counter
   * and tags no stage as a tool at all, so `toolStages.length` is not the call
   * count and nothing downstream may treat it as one.
   */
  it('reports the agent call counter and the tool-tagged stages as separate quantities', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const answered = await answeredRun(app, 'conv-trace-two-numbers');
      const { body } = await app.runTrace(String(answered.id));

      const liveTrace = liveAnswerResponse.custom_outputs.answer.trace;
      const taggedTool = liveTrace.stages.filter((stage) => stage.kind === 'tool');

      // The captured response is the evidence: a real run counted external calls
      // while tagging none of its stages as tool work.
      expect(liveTrace.toolCalls).toBeGreaterThan(0);
      expect(taggedTool).toHaveLength(0);

      expect(body.trace?.toolCalls).toBe(liveTrace.toolCalls);
      expect(body.toolStages).toEqual([]);
      expect(body.toolStages?.length,
        'the derived list was made to agree with the counter. They measure different ' +
          'things (the counter includes calls with no tool-tagged stage), so forcing ' +
          'them together makes one of the two numbers wrong.'
      ).not.toBe(body.trace?.toolCalls);
    } finally {
      await app.close();
    }
  });

  it('does not publish a toolCalls array that could be mistaken for the counter', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const answered = await answeredRun(app, 'conv-trace-naming');
      const { body } = await app.runTrace(String(answered.id));

      expect(body).toHaveProperty('toolStages');
      expect(body,
        'a top-level `toolCalls` is back alongside `trace.toolCalls`. One is a list of ' +
          'tagged stages and the other is the agent call counter; sharing a name is how ' +
          'they got conflated.'
      ).not.toHaveProperty('toolCalls');
    } finally {
      await app.close();
    }
  });

  it('says a benchmark run has no comparable trace instead of inventing one', async () => {
    const lakebase = memoryLakebase();
    const app = await startInsightsApp(agentContractTransport([]), lakebase);

    try {
      // Seeded directly rather than posted to `/api/benchmarks/run`, which now
      // runs the suite against a live endpoint for minutes instead of returning
      // a row of constants. What this test protects is the read path, and the
      // metrics below are the shape the runner actually writes.
      lakebase.benchmarkRuns.push({
        id: 'bench-trace-1',
        suite_id: 'poc-benchmark',
        user_email: DEVELOPMENT_IDENTITY,
        status: 'partial',
        metrics_json: JSON.stringify({
          suiteId: 'poc-benchmark',
          passed: 2,
          total: 6,
          groundedness: 0.4,
          relevance: 1,
          durationMs: 268_000,
          counts: { total: 6, attempted: 6, passed: 2, failed: 3, errored: 1, clarified: 0, unresolved: 0 },
          judgeRates: { groundedness: { rate: 0.4, scored: 5, yes: 2, no: 3, notApplicable: 1, errored: 0 } },
          judge: { endpoint: 'databricks-claude-sonnet-4-5', promptVersion: 'mlflow-3.14.0' },
          servedModel: { version: '9', determinate: true },
          cases: [{ caseId: 'player-count', outcome: 'passed' }],
        }),
        created_at: new Date().toISOString(),
      });

      const { status, body } = await app.runTrace('bench-trace-1');

      // The whole point of this route for a benchmark id: an explanation, not a
      // 404. A benchmark run genuinely has no conversation trace, and "this kind
      // of run has no trace" and "this run does not exist" are different
      // statements, only one of them is true, and the false one shows the
      // customer an error where Run Explorer should show them a run.
      expect(status).toBe(200);
      expect(body.kind).toBe('benchmark');
      expect(body.state).toBe('no-trace');
      expect(body.trace).toBeNull();
      expect(body.toolStages).toEqual([]);
      expect(body.note).toContain('per-case');
      expect(body.note).toContain('trace');

      // The metrics it does have are returned as metrics, not dressed as stages.
      const benchmark = body.benchmark as Record<string, unknown> | undefined;
      expect(benchmark?.suiteId).toBe('poc-benchmark');
      expect(benchmark?.passed).toBe(2);
      expect(benchmark?.total).toBe(6);

      // And the keys beyond the six this projection used to name survive it. It
      // forwarded a fixed set and dropped the rest, so a run could describe its
      // own partial failure and none of that could reach the browser.
      expect(benchmark?.counts).toMatchObject({ errored: 1, failed: 3 });
      expect(benchmark?.judgeRates).toMatchObject({ groundedness: { scored: 5, notApplicable: 1 } });
      expect(benchmark?.judge).toMatchObject({ promptVersion: 'mlflow-3.14.0' });
      expect(benchmark?.servedModel).toMatchObject({ version: '9' });
      expect(benchmark?.cases).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('refuses to benchmark an endpoint it has not got, rather than scoring the fallback', async () => {
    delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const { status, body } = await app.benchmark('poc-benchmark');

      // Every other read path in this file may answer from representative data
      // and label it. A benchmark may not: a score for an agent that was never
      // called is a number about nothing, and this route used to return exactly
      // that, 8 of 10 passed, groundedness 0.92, over a suite of six cases.
      expect(status).toBe(503);
      expect(body.error).toBe('agent_endpoint_not_configured');
      expect(body.passed).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('separates a turn that only proposed a plan from one that ran', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const lakebase = memoryLakebase();
    const app = await startInsightsApp(agentContractTransport([]), lakebase);

    try {
      const planned = await app.ask({ conversationId: 'conv-trace-plan', prompt: NONTRIVIAL_QUESTION });
      expect(planned.type).toBe('plan');

      const planMessage = lakebase.messages.find((message) => message.role === 'assistant');
      const { status, body } = await app.runTrace(String(planMessage?.id));

      // It exists, so it is not a 404, but it never ran, so it has no stages.
      expect(status).toBe(200);
      expect(body.state).toBe('no-trace');
      expect(body.trace).toBeNull();
      expect(body.note).toContain('plan');
    } finally {
      await app.close();
    }
  });

  it('reports an unknown id as missing rather than as an empty trace', async () => {
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const { status, body } = await app.runTrace('msg-never-stored');

      expect(status).toBe(404);
      expect(body.error).toBe('run_not_found');
      expect(body.runId).toBe('msg-never-stored');
    } finally {
      await app.close();
    }
  });

  /**
   * The reference trace has two legitimate homes, and this is the one that is not
   * an outage: a reachable store with nothing in it yet, which is a fresh
   * deployment on its first day.
   */
  it('labels the reference trace as unstored, not as an outage, on a healthy empty store', async () => {
    const app = await startInsightsApp(agentContractTransport([]));

    try {
      const { status, body } = await app.runTrace('run-1042');

      expect(status).toBe(200);
      expect(body.mode).toBe('representative');
      expect(body.state).toBe('trace');
      expect(body.note).toContain('No stored run has this id');
      // The claim that sent us looking for a database problem that did not exist.
      expect(body.note).not.toContain('unavailable');
      expect(body.trace?.stages?.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('does say Lakebase is unavailable when the read actually fails', async () => {
    const app = await startInsightsApp(agentContractTransport([]), {
      query: () => Promise.reject(new Error('connection refused')),
    });

    try {
      const { status, body } = await app.runTrace('run-1042');

      expect(status).toBe(200);
      expect(body.mode).toBe('representative');
      expect(body.note).toContain('Lakebase is unavailable');
    } finally {
      await app.close();
    }
  });

  it('never labels a stored live run as representative', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const answered = await answeredRun(app, 'conv-trace-live');
      const { body } = await app.runTrace(String(answered.id));

      expect(body.mode).toBe('live');
      expect(body.note).toBe('');
    } finally {
      await app.close();
    }
  });

  it('forwards fields a newer agent adds to a stage instead of dropping them', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const base = servingResponses.liveAnswerResponse.custom_outputs.answer as Record<string, unknown>;
    const trace = base.trace as { stages: Record<string, unknown>[] };
    const widened = {
      ...servingResponses.liveAnswerResponse,
      custom_outputs: {
        ...servingResponses.liveAnswerResponse.custom_outputs,
        answer: {
          ...base,
          trace: {
            ...trace,
            // Nesting the app does not render yet, and a key it knows nothing about.
            stages: trace.stages.map((stage, index) => ({ ...stage, depth: index, retries: 0 })),
          },
        },
      },
    };

    const app = await startInsightsApp(() => Promise.resolve(widened), memoryLakebase());
    try {
      const answered = await app.ask({
        conversationId: 'conv-trace-widened',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
      const { body } = await app.runTrace(String(answered.id));

      expect(body.trace?.stages?.[1]?.depth).toBe(1);
      expect(body.trace?.stages?.[1]?.retries).toBe(0);
      expect(body.undeclaredKeys?.join(' ')).toContain('retries');
    } finally {
      await app.close();
    }
  });
});

/**
 * A separate investigation is trying to correlate an app answer to its MLflow
 * trace, and there is currently no way to do it. There already is one: the
 * agent sets `trace.id` from the active MLflow root span, so every live answer
 * has been persisting the real trace id all along.
 */
/**
 * An endpoint that accepts the connection and then says nothing.
 *
 * The benchmark runner bounds a turn at 120 s and the judges at 60 s, because
 * those are the paths somebody watched fail unattended. The interactive path had
 * no bound at all: `fetch` against a silent socket never settles, so a question
 * asked at a demo would sit with a spinner on it until the tab was closed, and
 * `GET /api/setup` (which the client calls before showing anything), would do
 * the same to the whole app.
 */
describe('an agent endpoint that never answers', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  it('is given up on, and says how long it was waited for', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const appkit = {
      lakebase: { query: () => Promise.resolve({ rows: [] }) },
      server: { extend: () => {} },
      servingTransport: () => new Promise<never>(() => {}),
    } as unknown as InsightsAppKit;

    await expect(invokeServing(appkit, { input: [] }, undefined, 30)).rejects.toThrow(/did not answer within 30 ms/
    );
  });

  it('waits longer for a question than for a report about the deployment', () => {
    // A question is a minute of real work at its longest and is allowed to be
    // slow; a preflight is a fixed round trip the wizard blocks on, so the two
    // cannot share one bound.
    expect(PREFLIGHT_TIMEOUT_MS).toBeLessThan(SERVING_INVOKE_TIMEOUT_MS);
    expect(PREFLIGHT_TIMEOUT_MS).toBeGreaterThan(15_900);
  });
});

describe('the MLflow trace behind an answer', () => {
  const savedHost = process.env.DATABRICKS_HOST;

  afterEach(() => {
    if (savedHost === undefined) delete process.env.DATABRICKS_HOST;
    else process.env.DATABRICKS_HOST = savedHost;
  });

  it('recognises an MLflow trace id and links to it', () => {
    process.env.DATABRICKS_HOST = 'https://example.cloud.databricks.com';

    // The trace id was verified against the deployed workspace on 2026-08-04:
    // it resolves through GET /api/3.0/mlflow/traces/{id}. The experiment it
    // resolved to was our own, and this asserts on the invented id used higher
    // up this file instead: the URL is built by concatenation, so which
    // experiment it names proves nothing, and naming a live one costs the
    // published copy of this test its only assertion. `<mlflow-experiment-id>`
    // is what the publish rewrite substitutes, and it URL-encodes to
    // %3Cmlflow-experiment-id%3E, which the expected string here cannot spell.
    const reference = mlflowReference('tr-52de35df2e06ca3ac7f5e77238d83847', '9998887776665554');

    expect(reference?.traceId).toBe('tr-52de35df2e06ca3ac7f5e77238d83847');
    expect(reference?.experimentId).toBe('9998887776665554');
    expect(reference?.url).toBe('https://example.cloud.databricks.com/ml/experiments/9998887776665554/traces' +
        '?selectedEvaluationId=tr-52de35df2e06ca3ac7f5e77238d83847'
    );
  });

  it("does not claim the agent's local fallback id is an MLflow trace", () => {
    process.env.DATABRICKS_HOST = 'https://example.cloud.databricks.com';

    // agent.py falls back to `trace-<uuid>` when no root span is active. Nothing
    // in MLflow answers to that, so offering a link would send people nowhere.
    expect(mlflowReference('trace-1042', '9998887776665554')).toBeNull();
  });

  it('still reports the id when no experiment is configured to link to', () => {
    process.env.DATABRICKS_HOST = 'https://example.cloud.databricks.com';

    const reference = mlflowReference('tr-52de35df2e06ca3ac7f5e77238d83847', '');

    expect(reference?.traceId).toBe('tr-52de35df2e06ca3ac7f5e77238d83847');
    expect(reference?.experimentId).toBeNull();
    expect(reference?.url).toBeNull();
  });
});

/**
 * The offline answer is complete, cites real tables, and (for the data quality
 * question), reports the true current null ratios beside stage timings that
 * measured nothing, all from a function that queries nothing. It has to keep
 * answering, so the fix is that it can no longer read as live.
 *
 * These tests pin the derivation rather than any one canned answer's wording,
 * because the disclosure is read off the trace id: only a traced agent run can
 * produce an MLflow trace id, so a canned answer written later cannot omit it.
 */
describe('a canned answer discloses that no live query produced it', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  it.each([
    ['the audience question', 'Compare active players by title over the last 30 days'],
    ['the data quality question', 'Check null ratios in the latest player activity data'],
  ])('marks the representative answer to %s', (_label, prompt) => {
    const answer = representativeAnswer(prompt);

    expect(answer.trace.id).not.toMatch(/^tr-[0-9a-f]+$/i);
    expect(answer.caveats[0]).toBe(REPRESENTATIVE_ANSWER_CAVEAT);
  });

  it('leaves an answer that carries a real MLflow trace id untouched', () => {
    const live = liveAnswerResponse.custom_outputs.answer;

    expect(live.trace.id).toMatch(/^tr-[0-9a-f]+$/i);
    expect(discloseAnswerProvenance(live)).toBe(live);
  });

  it('marks an answer once, however many times it passes through', () => {
    const answer = representativeAnswer('Compare active players by title');

    expect(discloseAnswerProvenance(answer).caveats).toEqual(answer.caveats);
  });

  it('discloses the fallback the ask route serves when the endpoint is unreachable', async () => {
    delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-offline-disclosure',
        prompt: 'Check null ratios in the latest player activity data.',
      });

      expect(answered.mode).toBe('representative');
      expect(answered.caveats).toContain(REPRESENTATIVE_ANSWER_CAVEAT);
    } finally {
      await app.close();
    }
  });

  it('does not mark an answer the agent actually produced', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-live-disclosure',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      expect(answered.mode).toBe('live');
      expect(answered.caveats).not.toContain(REPRESENTATIVE_ANSWER_CAVEAT);
    } finally {
      await app.close();
    }
  });

  /**
   * The case a per-answer flag would miss. A plain-text endpoint reply becomes a
   * live narrative on top of the representative chart, SQL, and stages, and is
   * labelled `mode: 'live'`, but the numbers on screen are still canned.
   */
  it('discloses a live narrative that kept the representative figures', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(() =>
        Promise.resolve({
          output: [{ content: [{ type: 'output_text', text: 'VLH Online leads the last 30 days.' }] }],
        }),
      memoryLakebase()
    );

    try {
      const answered = await app.ask({
        conversationId: 'conv-half-live',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      expect(answered.mode).toBe('live');
      expect(answered.narrative).toBe('VLH Online leads the last 30 days.');
      expect(answered.figures).toEqual(representativeAnswer(NONTRIVIAL_QUESTION).figures);
      expect(answered.caveats).toContain(REPRESENTATIVE_ANSWER_CAVEAT);
    } finally {
      await app.close();
    }
  });
});

/**
 * Serving the stored demo response is a decision, not a default.
 *
 * The route used to pre-seed `answer` with `representativeAnswer(prompt)` and
 * overwrite it where a live answer turned up, which meant every other way out
 * of the endpoint call inherited canned figures and returned them as
 * `type: 'answer'` over HTTP 200. There was no "on error, serve the fixture"
 * statement to audit, and nothing on the wire said which of the ways out had
 * been taken.
 *
 * These cover the two conditions that legitimately fall back, that each says
 * WHY, that they are distinguishable from each other, and, the reason the
 * shape mattered rather than the two known cases, that a payload nobody has
 * written a branch for cannot serve the fixture without saying so.
 */
describe('a fallback to the stored demo response is attributed', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  /** The caveat carrying the reason, or undefined if the route served one silently. */
  function fallbackCaveat(answered: AskResponse) {
    return (answered.caveats as string[] | undefined)?.find((caveat) =>
      caveat.startsWith(DEGRADED_ANSWER_MARKER)
    );
  }

  /** Captures console.error so the loudness of the log is asserted, not assumed. */
  async function askThrough(transport: ServingTransport, conversationId: string) {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    const app = await startInsightsApp(transport, memoryLakebase());
    try {
      const { status, body } = await app.askRaw({
        conversationId,
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
      return { status, body, errors };
    } finally {
      spy.mockRestore();
      await app.close();
    }
  }

  it('still answers 200 when the endpoint call throws, and says what threw', async () => {
    const { status, body, errors } = await askThrough(() => Promise.reject(new Error('socket hang up after 30000 ms')),
      'conv-fallback-throw'
    );

    // The demo keeps working. This is the whole reason the fallback exists and
    // the reason it was not simply replaced with a 500.
    expect(status).toBe(200);
    expect(body.type).toBe('answer');
    expect(body.mode).toBe('representative');
    expect(body.takeaway).toBeTruthy();

    // ...but a reader of that answer can now find out why it is not real.
    const caveat = fallbackCaveat(body);
    expect(caveat).toBeDefined();
    expect(caveat).toContain('the agent endpoint call failed');
    expect(caveat).toContain('socket hang up after 30000 ms');

    // console.warn is not the right severity for "invented numbers reached a
    // customer", and the codebase already uses console.error for the refusals.
    expect(errors.join('\n')).toContain('socket hang up after 30000 ms');
  });

  it('still answers 200 when the payload matches no contract, and says the payload was unreadable', async () => {
    const { status, body, errors } = await askThrough(() => Promise.resolve({ custom_outputs: { insight_bundle: { headline: 42 } } }),
      'conv-fallback-contract'
    );

    expect(status).toBe(200);
    expect(body.type).toBe('answer');
    expect(body.mode).toBe('representative');

    const caveat = fallbackCaveat(body);
    expect(caveat).toBeDefined();
    expect(caveat).toContain('cannot read as an answer');
    // Enough to start on: which keys came back, without putting the payload
    // itself in front of the reader.
    expect(caveat).toContain('custom_outputs');
    expect(errors.join('\n')).toContain('none of the four shapes');
  });

  it('tells the two fallbacks apart, which is the point of attributing them at all', async () => {
    const thrown = await askThrough(() => Promise.reject(new Error('endpoint is not ready')), 'conv-fallback-a');
    const unreadable = await askThrough(() => Promise.resolve({ unexpected: true }), 'conv-fallback-b');

    expect(fallbackCaveat(thrown.body)).not.toBe(fallbackCaveat(unreadable.body));
    expect(fallbackCaveat(thrown.body)).toContain('call failed');
    expect(fallbackCaveat(unreadable.body)).not.toContain('call failed');
  });

  /**
   * The defect the whole change is about, rather than either of the two known
   * conditions. Adding one `custom_outputs` type to the agent, which is
   * released separately from this app and in either order, used to be enough to
   * put the demo dataset in front of a customer over HTTP 200 with nothing on
   * the wire and one `console.warn` in the logs.
   *
   * A shape the app has no branch for still falls back, because the alternative
   * is a 500 during a live demo. What it can no longer do is fall back quietly.
   */
  it('cannot serve the fixture silently for a custom_outputs type nobody has written a branch for', async () => {
    const { status, body, errors } = await askThrough(() =>
        Promise.resolve({
          custom_outputs: {
            // A v9 agent answering in a shape this app predates entirely.
            player_insights_forecast: {
              horizon_days: 30,
              projected_active_players: [{ title: 'VLH Online', p50: 19_400 }],
            },
          },
        }),
      'conv-fallback-future'
    );

    expect(status).toBe(200);
    // It IS the fixture: nothing here was queried, and the test says so out
    // loud rather than leaving it to be inferred.
    expect(body.figures).toEqual(representativeAnswer(NONTRIVIAL_QUESTION).figures);
    expect(body.mode).toBe('representative');
    // And it cannot have got here silently.
    expect(fallbackCaveat(body)).toBeDefined();
    expect(errors.join('\n')).toContain('player_insights_forecast');
  });

  /**
   * The other half: attribution is not a badge stuck on every answer. An answer
   * the agent actually produced carries no fallback caveat, because a warning
   * that appears when nothing is wrong is one nobody reads when something is.
   */
  it('says nothing of the kind about an answer the agent produced', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-no-false-alarm',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      expect(answered.mode).toBe('live');
      expect(fallbackCaveat(answered)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  /**
   * The attribution has to survive the write, or it is only ever visible to
   * whoever was watching the screen when the answer arrived. Someone triaging a
   * complaint a day later reads the stored row.
   */
  it('stores the reason with the answer, so a bad answer can be triaged after the fact', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const lakebase = memoryLakebase();
    const app = await startInsightsApp(() => Promise.reject(new Error('connection refused')), lakebase);

    try {
      await app.ask({
        conversationId: 'conv-fallback-stored',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      const assistant = lakebase.messages.find((message) => message.role === 'assistant');
      expect(String(assistant?.response_json)).toContain('connection refused');
    } finally {
      await app.close();
    }
  });
});

/**
 * Saying where the parts of an answer came from, rather than leaving it to be
 * worked out from the caveats.
 *
 * `mode` answers "did a run happen", and there is one path where the honest
 * answer to that is yes and every figure on screen is still invented: the
 * endpoint replies in prose, the route keeps the words and serves them over the
 * stored demo response's figures, sources, SQL and stages, and labels the result
 * `mode: 'live'`. The browser had no fact to read, only the caveat about a
 * missing MLflow trace id, which also appears on genuinely live answers from a
 * workspace with tracing off. So it badged the card "Live agent response" and a
 * reader was told five numbers had been computed for their question.
 *
 * These pin the marker on all three paths out of the endpoint call, and, in the
 * half that would be the worse regression, pin that the ordinary live answer
 * gains nothing at all.
 */
describe('an answer says which of its parts came from the run', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  /** An endpoint that answers in prose, which is what the half-live path is. */
  const prose: ServingTransport = () =>
    Promise.resolve({
      output: [{ content: [{ type: 'output_text', text: 'VLH Online leads the last 30 days.' }] }],
    });

  it('marks a structured answer live, because nothing on it was borrowed', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-prov-live',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      expect(answered.mode).toBe('live');
      expect(answered.provenance).toBe('live');
      // The regression that would be worse than the bug. A demo where every
      // answer hedges is a demo nobody can give, and a warning that has been
      // wrong is one people learn to click past.
      expect(answered.caveats).not.toContain(STORED_FIGURES_CAVEAT);
      expect(answered.caveats).not.toContain(REPRESENTATIVE_ANSWER_CAVEAT);
      expect((answered.caveats as string[]).some((caveat) => caveat.startsWith(DEGRADED_ANSWER_MARKER))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('marks a prose reply mixed, and says which parts are the stored ones', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(prose, memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-prov-mixed',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      // Still live, and still correctly so: a run happened and these are its
      // words. What changed is that the figures under them no longer pass for
      // its work.
      expect(answered.mode).toBe('live');
      expect(answered.narrative).toBe('VLH Online leads the last 30 days.');
      expect(answered.provenance).toBe('mixed');
      expect(answered.figures).toEqual(representativeAnswer(NONTRIVIAL_QUESTION).figures);
      // First, above the figures, not fifth under "What to keep in mind". The
      // marker is for the renderer; this is for the person reading.
      expect((answered.caveats as string[])[0]).toBe(STORED_FIGURES_CAVEAT);
    } finally {
      await app.close();
    }
  });

  it('marks the stored demo response stored when nothing ran at all', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(() => Promise.reject(new Error('socket hang up')), memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-prov-stored',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      expect(answered.mode).toBe('representative');
      expect(answered.provenance).toBe('stored');
    } finally {
      await app.close();
    }
  });

  /**
   * The disclosure has to survive the write. A conversation reopened tomorrow
   * renders from the stored row, and a marker that only existed on the live
   * response would leave the reload badging the same answer as fully live.
   */
  it('stores the marker with the answer, so a reopened conversation discloses it too', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const lakebase = memoryLakebase();
    const app = await startInsightsApp(prose, lakebase);

    try {
      await app.ask({
        conversationId: 'conv-prov-persisted',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      const assistant = lakebase.messages.find((message) => message.role === 'assistant');
      const stored = JSON.parse(String(assistant?.response_json)) as Record<string, unknown>;
      expect(stored.mode).toBe('live');
      expect(stored.provenance).toBe('mixed');
    } finally {
      await app.close();
    }
  });

  /**
   * `undeclaredKeys` is how the app reports that the agent has shipped a field
   * ahead of the UI. A key the route writes itself must not show up there, or
   * every answer stored from now on reads as contract drift and the log stops
   * meaning anything.
   */
  it('is not reported as a field the agent added and the app cannot read', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-prov-drift',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
      const { body } = await app.runTrace(String(answered.id));

      expect(body.undeclaredKeys).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
