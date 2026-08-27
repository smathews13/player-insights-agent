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
  rejectionStatus,
  REPRESENTATIVE_ANSWER_CAVEAT,
  RUN_TRACE_BENCHMARK_QUERY,
  RUN_TRACE_MESSAGE_QUERY,
  RUNS_QUERY,
  SERVICE_PRINCIPAL_FALLBACK_CAVEAT,
  servingInvocationPath,
  setupInsightsRoutes,
  SHARED_RUN_OWNER,
  TraceSchema,
  type InsightsAppKit,
  type ServingTransport,
} from './insights-routes';
import { announceSeedAdmins } from '../lib/admin-roles';
import servingResponses from './__fixtures__/serving-responses.json';
import { FakeStore } from '../lib/__fixtures__/fake-run-store';
import { DEGRADED_ANSWER_MARKER } from '../../shared/setup-remedies';
import { PROSE_ONLY_ANSWER_CAVEAT } from '../../shared/prose-only-answer';
import { PLACEHOLDER_CONVERSATION_TITLE } from '../../shared/conversation-title';
import { DEFAULT_RUNTIME_SETTINGS, type RuntimeSettings } from '../../shared/runtime-settings';
import {
  answerRunVerdict,
  runVerdict,
  VERDICT_EXEMPT_STAGE_IDS,
  VERDICT_STAGE_EXEMPTION_SQL,
} from '../../shared/run-verdict';
import { unavailableHttpStatus } from '../../shared/terminal-response';
import type { FailureEvidence } from '../../shared/failure-evidence';
import {
  forgetAccessDecisions,
  forgetServingPrincipal,
  recordVerifiedAccess,
  rememberServingPrincipal,
} from './execution-identity';
import type { WarehouseCancellationTransport } from '../lib/warehouse-cancellation';

// Captured verbatim from the deployed `player-insights-agent` endpoint so the app
// contract is tested against what Model Serving actually returns.
const { liveAnswerResponse, livePlanResponse } = servingResponses;

function request(headers: Record<string, string> = {}) {
  return { header: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}

describe('extractLiveText', () => {
  it('reads ResponsesAgent output text', () => {
    expect(
      extractLiveText({
        output: [{ content: [{ type: 'output_text', text: 'Grounded answer' }] }],
      })
    ).toBe('Grounded answer');
  });

  it('does not treat endpoint errors as live answers', () => {
    expect(
      extractLiveText({
        error_code: 'ENDPOINT_NOT_FOUND',
        message: 'The configured endpoint does not exist.',
      })
    ).toBeNull();
  });
});

describe('extractStructuredAnswer', () => {
  it('reads the ResponsesAgent custom output contract', () => {
    const expected = liveAnswerResponse.custom_outputs.answer;
    const result = extractStructuredAnswer({
      custom_outputs: { answer: expected },
    });

    expect(result?.takeaway).toBe(expected.takeaway);
    expect(result?.trace.stages).toHaveLength(expected.trace.stages.length);
  });

  it('reads an AppKit-wrapped ResponsesAgent response', () => {
    const expected = liveAnswerResponse.custom_outputs.answer;
    const result = extractStructuredAnswer({
      data: { custom_outputs: { answer: expected } },
    });

    expect(result?.takeaway).toBe(expected.takeaway);
  });

  it('rejects incomplete custom output', () => {
    expect(extractStructuredAnswer({ custom_outputs: { answer: { takeaway: 'Missing fields' } } })).toBeNull();
  });

  it('keeps a deadline answer whose narrative is empty so the stages are not thrown away', () => {
    const stored = liveAnswerResponse.custom_outputs.answer;
    const result = extractStructuredAnswer({
      custom_outputs: { answer: { ...stored, narrative: '' } },
    });
    expect(result).not.toBeNull();
    expect(result?.narrative).toBe('');
    expect(result?.trace.stages.length).toBeGreaterThan(0);
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
    expect(extractLiveText(liveAnswerResponse)).toContain(
      liveAnswerResponse.custom_outputs.answer.takeaway.slice(0, 40)
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
        id: 'clarify-cafecafecafe',
        question: 'Which table did you mean? Give the full catalog.schema.table for the master table.',
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
    const result = extractClarification(clarificationResponse({ reason: undefined, options: undefined }));

    expect(result?.reason).toBe('');
    expect(result?.options).toEqual([]);
    expect(result?.question).toBeTruthy();
  });

  it('reads one wrapped by AppKit, as the other extractors do', () => {
    expect(extractClarification({ data: clarificationResponse() })?.id).toBe('clarify-cafecafecafe');
  });

  it('is null for an answer, a plan, and an endpoint error', () => {
    expect(extractClarification(liveAnswerResponse)).toBeNull();
    expect(extractClarification(livePlanResponse)).toBeNull();
    expect(
      extractClarification({
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
      const result = extractAnalysisPlan(
        planResponse({ ...wholePlan, estimated_cost_usd: 0.42, data_scope: 'gold only' })
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
      const result = extractAnalysisPlan(
        planResponse({
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

  it.each(['requires_approval', 'uses_conversation_context', 'uses_attachment_context'])(
    'still reads a plan from a model version logged before %s existed',
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
    const stored = liveAnswerResponse.custom_outputs.answer;
    const history = buildServingHistory([
      { role: 'user', content: 'Compare active players by title' },
      { role: 'assistant', content: stored.narrative, response_json: stored },
    ]);

    expect(history[1]?.content).toBe(`${stored.takeaway}\n\n${stored.narrative}`);
  });

  it('parses assistant history that Lakebase returned as a JSON string', () => {
    const stored = liveAnswerResponse.custom_outputs.answer;
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
      await expect(extractAttachmentText(filename, Buffer.from('x'))).rejects.toThrow(
        /PDF, TXT, Markdown, CSV, or JSON/
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

const NONTRIVIAL_QUESTION = 'Compare active players by title and label over the last 30 days and explain the drivers.';

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
  return trace as { totalMs?: number; stages?: { id?: string; status?: string }[] };
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
  charts?: { id?: string; title?: string; kind?: string; data?: unknown[]; layout?: Record<string, unknown> }[];
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
function memoryLakebase(
  attachments: StoredAttachment[] = [],
  /** Rows of `deployment_settings`, for the values the app resolves per request. */
  settings: Record<string, unknown>[] = [],
  runtimeSettings?: RuntimeSettings
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

  /** Conversation id to the label the rail shows for it. Kept apart from the owner
   *  map above because the two follow different upsert rules. */
  const conversationTitles = new Map<string, string>();

  /** The question a stored answer belongs to, skipping the plan-approval turn. */
  function questionBefore(index: number, conversationId: string, approvalMessage: string) {
    const questions = messages
      .slice(0, index)
      .filter(
        (earlier) =>
          earlier.conversation_id === conversationId && earlier.role === 'user' && earlier.content !== approvalMessage
      );
    return questions.length > 0 ? questions[questions.length - 1].content : null;
  }

  return {
    messages,
    benchmarkRuns,
    conversations,
    conversationTitles,
    query(text: string, params: unknown[] = []) {
      const sql = text.replace(/\s+/g, ' ').trim();

      // An existing conversation keeps the owner it was created with: the upsert's
      // `DO UPDATE` never touches `user_email`.
      //
      // The title is different, and this fake has to model that difference or a test
      // cannot see it. A conversation created by attaching a document is titled with
      // the placeholder before anything is asked, and the ask upsert claims that
      // title once, on the first turn, leaving a title from a real question alone
      // afterwards. `$4` carries the placeholder to compare against.
      if (sql.startsWith('INSERT INTO player_insights.conversations')) {
        const id = String(params[0]);
        if (!conversations.has(id)) {
          conversations.set(id, String(params[1]));
          conversationTitles.set(id, String(params[2]));
        } else if (params.length > 3 && conversationTitles.get(id) === String(params[3])) {
          conversationTitles.set(id, String(params[2]));
        }
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      }

      if (sql.startsWith('SELECT user_email FROM player_insights.conversations WHERE id = $1')) {
        const owner = conversations.get(String(params[0]));
        return Promise.resolve({ rows: owner === undefined ? [] : [{ user_email: owner }] });
      }

      if (sql.startsWith('SELECT c.id, c.title, c.updated_at, c.user_email')) {
        const caller = params.length > 0 ? String(params[0]) : null;
        const rows = [...conversations.entries()]
          .filter(([, owner]) => caller === null || owner === caller)
          .map(([id, user_email]) => ({
            id,
            user_email,
            title: conversationTitles.get(id),
            updated_at: new Date().toISOString(),
          }));
        return Promise.resolve({ rows });
      }

      if (sql.startsWith('SELECT resource_id')) {
        return Promise.resolve({ rows: settings });
      }

      if (sql.includes('.runtime_settings') && sql.startsWith('SELECT settings FROM')) {
        return Promise.resolve({
          rows: runtimeSettings === undefined ? [] : [{ settings: runtimeSettings }],
        });
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
            return {
              id: message.id,
              kind: 'conversation',
              conversation_id: message.conversation_id,
              prompt: questionBefore(index, message.conversation_id, approvalMessage),
              stakeholder: caller,
              // The rule itself, not a restatement of it. This used to be a local
              // `stages.some(status)` pair, which meant the fake agreed with the
              // query only for as long as nobody changed one of them -- and the
              // exemption the query now carries would have been invisible to
              // every test that reads a run's status through this route.
              status: runVerdict(trace?.stages ?? []),
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
    const approved = Boolean(customInputs.approved_plan_id) || customInputs.execute_plan === true;
    return Promise.resolve(approved ? servingResponses.liveAnswerResponse : servingResponses.livePlanResponse);
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
    // Loopback rather than the wildcard, or this binds a port another process
    // holds on 127.0.0.1 and every fetch through this harness reaches that
    // process instead. See the note in shared-rail.test.ts.
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
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

async function startInsightsApp(
  transport: ServingTransport,
  lakebase: InsightsAppKit['lakebase'] = { query: () => Promise.resolve({ rows: [] }) },
  overrides: Pick<InsightsAppKit, 'warehouseCancellationTransport'> = {}
) {
  const app = express();
  app.use(express.json());
  const appkit: InsightsAppKit = {
    lakebase,
    server: { extend: (fn) => fn(app) },
    servingTransport: transport,
    ...overrides,
  };
  // Benchmark Lab's endpoints are admin-only, so the harness's caller has to be
  // an administrator for the tests below to be about benchmarking rather than
  // about the role. Without this every `/api/benchmarks` call answers 403, which
  // is the correct refusal and not what any of these tests are checking. The
  // refusal itself is tested in admin-roles.test.ts, against a consumer.
  announceSeedAdmins(DEVELOPMENT_IDENTITY);
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
    async ask(body: Record<string, unknown>, userToken: string | null = 'forwarded-user-token'): Promise<AskResponse> {
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
    async askRaw(
      body: Record<string, unknown>,
      /** For headers the route reads rather than the harness, such as Idempotency-Key. */
      extraHeaders: Record<string, string> = {}
    ): Promise<{ status: number; body: AskResponse }> {
      const response = await fetch(`http://127.0.0.1:${port}/api/insights/ask`, {
        method: 'POST',
        headers: headers({
          'Content-Type': 'application/json',
          'x-forwarded-access-token': 'forwarded-user-token',
          ...extraHeaders,
        }),
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as AskResponse };
    },
    async runs(): Promise<RunRow[]> {
      const response = await fetch(`http://127.0.0.1:${port}/api/runs`, { headers: headers() });
      return (await response.json()) as RunRow[];
    },
    async cancelRun(identifier: string, email = DEVELOPMENT_IDENTITY) {
      const response = await fetch(`http://127.0.0.1:${port}/api/runs/${encodeURIComponent(identifier)}/cancel`, {
        method: 'POST',
        headers: headers({ 'x-forwarded-email': email }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    async cancelAll(email = DEVELOPMENT_IDENTITY) {
      const response = await fetch(`http://127.0.0.1:${port}/api/admin/runs/cancel-all`, {
        method: 'POST',
        headers: headers({ 'x-forwarded-email': email }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    async conversations(): Promise<{ id: string; title: string }[]> {
      const response = await fetch(`http://127.0.0.1:${port}/api/conversations`, { headers: headers() });
      return (await response.json()) as { id: string; title: string }[];
    },
    async conversationRun(id: string): Promise<Record<string, unknown> | null> {
      const response = await fetch(`http://127.0.0.1:${port}/api/conversations/${encodeURIComponent(id)}/run`, {
        headers: headers(),
      });
      return (await response.json()) as Record<string, unknown> | null;
    },
    /**
     * Starts the same SSE request Ask PIA uses and lets the test navigate away.
     *
     * Aborting this socket is stronger than a React unmount: if server work
     * survives it, changing views without a signal cannot cancel the run.
     */
    askAndDisconnect(body: Record<string, unknown>) {
      const controller = new AbortController();
      const finished = fetch(`http://127.0.0.1:${port}/api/insights/ask`, {
        method: 'POST',
        headers: headers({
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'x-forwarded-access-token': 'forwarded-user-token',
        }),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .then((response) => response.text())
        .catch((error: unknown) => error);
      return { abort: () => controller.abort(), finished };
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

  it('sends promoted Prompt Registry guidance only when one was saved', () => {
    const body = buildAskServingBody({
      history: [{ role: 'user', content: NONTRIVIAL_QUESTION }],
      prompt: NONTRIVIAL_QUESTION,
      conversationId: 'conv-1',
      attachmentText: '',
      evalGuidance: 'Stay inside governed tables.',
    });
    expect(body.custom_inputs).toMatchObject({
      conversation_id: 'conv-1',
      eval_guidance: 'Stay inside governed tables.',
    });
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
    expect(servingInvocationPath('player-insights-agent')).toBe('/serving-endpoints/player-insights-agent/invocations');
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
    raw: boolean;
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

  /** The `{ contents }` shape the SDK returns for a raw streaming request. */
  function streamOf(...events: string[]) {
    const encoder = new TextEncoder();
    return {
      contents: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(event));
          controller.close();
        },
      }),
    };
  }

  /** One `predict_stream` stage event, at the status given. */
  function stageEvent(status: string, id = 'plan', name = 'Chose the next step') {
    return `data: ${JSON.stringify({
      type: 'response.output_item.done',
      custom_outputs: { type: 'stage', stage: { id, name, kind: 'agent', status } },
    })}\n\n`;
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

  it('does not re-invoke after a truncated stream already reported a stage', async () => {
    const seen: SeenRequest[] = [];
    const transport = createServingTransport(() =>
      Promise.resolve({
        request: (options: SeenRequest) => {
          seen.push(options);
          return Promise.resolve(streamOf(stageEvent('complete', 'plan', 'Planned')));
        },
      })
    );

    await expect(
      transport({
        path: '/serving-endpoints/x/invocations',
        payload: { stream: true },
        onStage: () => undefined,
      })
    ).rejects.toMatchObject({ name: 'TruncatedStreamError', stages: 1 });
    expect(seen).toHaveLength(1);
  });

  it('cancels the serving response body and starts no fallback after an explicit abort', async () => {
    const seen: SeenRequest[] = [];
    let bodyCancelled = false;
    const transport = createServingTransport(() =>
      Promise.resolve({
        request: (options: SeenRequest) => {
          seen.push(options);
          return Promise.resolve({
            contents: new ReadableStream<Uint8Array>({
              cancel() {
                bodyCancelled = true;
              },
            }),
          });
        },
      })
    );
    const controller = new AbortController();
    const pending = transport({
      path: '/serving-endpoints/x/invocations',
      payload: { stream: true },
      onStage: () => undefined,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'RunCancelledError' });
    expect(bodyCancelled).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('falls back to the blocking call when a truncated stream only announced steps', async () => {
    // THE REGRESSION THIS PINS. `running` events are a step saying it has
    // started. A stream that dies after nothing but those has produced no work
    // to keep, so treating them as "the agent already ran" withheld the one
    // call that could still answer, and the reader was shown an interrupted run
    // for a question the endpoint had barely begun.
    const seen: SeenRequest[] = [];
    const transport = createServingTransport(() =>
      Promise.resolve({
        request: (options: SeenRequest) => {
          seen.push(options);
          if (options.raw) {
            return Promise.resolve(streamOf(stageEvent('running'), stageEvent('running', 'genie')));
          }
          return Promise.resolve(servingResponses.liveAnswerResponse);
        },
      })
    );

    await expect(
      transport({
        path: '/serving-endpoints/x/invocations',
        payload: { stream: true },
        onStage: () => undefined,
      })
    ).resolves.toBe(servingResponses.liveAnswerResponse);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.payload.stream).toBe(false);
  });

  it('does not re-invoke when an announcement was followed by a reported stage', async () => {
    // The other half of the rule. Once a step has REPORTED, the stack has done
    // governed reads, and a blocking retry would run orchestrator → tools →
    // synthesis again. The announcement in front of it changes nothing.
    const seen: SeenRequest[] = [];
    const transport = createServingTransport(() =>
      Promise.resolve({
        request: (options: SeenRequest) => {
          seen.push(options);
          return Promise.resolve(streamOf(stageEvent('running'), stageEvent('complete')));
        },
      })
    );

    await expect(
      transport({
        path: '/serving-endpoints/x/invocations',
        payload: { stream: true },
        onStage: () => undefined,
      })
    ).rejects.toMatchObject({ name: 'TruncatedStreamError', stages: 1 });
    expect(seen).toHaveLength(1);
  });

  it('keeps the blocking fallback when a truncated stream reported zero stages', async () => {
    const seen: SeenRequest[] = [];
    const transport = createServingTransport(() =>
      Promise.resolve({
        request: (options: SeenRequest) => {
          seen.push(options);
          if (options.raw) return Promise.resolve(streamOf(''));
          return Promise.resolve(servingResponses.liveAnswerResponse);
        },
      })
    );

    await expect(
      transport({
        path: '/serving-endpoints/x/invocations',
        payload: { stream: true },
        onStage: () => undefined,
      })
    ).resolves.toBe(servingResponses.liveAnswerResponse);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.payload.stream).toBe(false);
  });
});

describe('what the route actually puts on the wire', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  it('puts the saved runtime settings on the next ask payload', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const captured: CapturedInvocation[] = [];
    const stored: RuntimeSettings = {
      ...DEFAULT_RUNTIME_SETTINGS,
      loop: { maxSteps: 10, maxToolCalls: 15, maxRunSeconds: 200 },
      answer: {
        ...DEFAULT_RUNTIME_SETTINGS.answer,
        takeaway: true,
        takeawayGuidance: 'Test',
        narrativeGuidance: 'Cite the table.',
        narrativeMaxCharacters: 800,
        maxCharts: 1,
        maxFigures: 6,
        figuresOrder: 'totals-first',
        chartsTypes: 'bar',
      },
      behavior: {
        ...DEFAULT_RUNTIME_SETTINGS.behavior,
        timezone: 'America/Los_Angeles',
      },
    };
    const lakebase = memoryLakebase([], [], stored);
    const app = await startInsightsApp(agentContractTransport(captured), lakebase);

    try {
      await app.ask({
        conversationId: 'conv-runtime-settings',
        prompt: 'How many active players are there?',
        executePlan: true,
      });
    } finally {
      await app.close();
    }

    expect(captured[0]?.payload.custom_inputs).toMatchObject({
      runtime_settings: stored,
    });

    const assistant = lakebase.messages.find((message) => message.role === 'assistant');
    const persisted = JSON.parse(String(assistant?.response_json)) as Record<string, unknown>;
    expect(persisted.runtime_settings).toEqual(stored);
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
    expect(customInputs.attachment_text).toBe(
      '## halcyon-memo.txt\nProject HALCYON-7742 retires Iron Frontier Online on 2026-11-15.'
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
    expect(customInputs.attachment_text).toBe('## a.txt\nfirst report\n\n## b.pdf\nsecond report');
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

    const endpointAnswer = servingResponses.liveAnswerResponse.custom_outputs.answer as Record<string, unknown>;

    // Comparing key-by-key means a widened agent contract fails here rather than
    // disappearing silently on the way to the browser.
    for (const [key, value] of Object.entries(endpointAnswer)) {
      // The trace is compared below. It is the one field the app fills in rather
      // than forwards verbatim: `depth` and `parent_id` are defaulted onto stages,
      // and the token counts onto the trace itself, for a model version that
      // predates them.
      if (key === 'trace') continue;
      expect(answered[key], `custom_outputs.answer.${key} did not reach the response`).toEqual(value);
    }
    const trace = endpointAnswer.trace as { stages: Record<string, unknown>[] };
    expect(answered.trace).toEqual({
      // The token counts are NOT defaulted in, which is the difference between the
      // stage fields and these: a stage without a depth still happened, whereas a
      // token count of zero is a measurement. A version that reported no usage
      // reports no keys, and the tiles say so rather than printing a zero.
      ...trace,
      stages: trace.stages.map((stage) => ({ depth: 0, parent_id: '', ...stage })),
    });
    expect(answered.type).toBe('answer');
    expect(answered.mode).toBe('live');
  });

  /**
   * A GATEWAY THAT REPORTS A TOTAL AND NO SPLIT must not be turned into a model
   * that read nothing and wrote nothing.
   *
   * The counts were `.optional().default(0)`, which filled the two missing halves
   * with a measurement. RunExplorer guards against exactly this -- "half a split
   * filled in with a zero is a claim that the model read nothing" -- by testing
   * `typeof === 'number'`, and a default made that test always true, so the guard
   * had never once fired. Absence has to survive the parse for it to work.
   */
  it('keeps an unreported token count absent rather than calling it zero', () => {
    const parsed = TraceSchema.parse({
      id: 'tr-1',
      totalMs: 1200,
      toolCalls: 2,
      stages: [],
      total_tokens: 12431,
    });

    expect(parsed.total_tokens).toBe(12431);
    expect(parsed.prompt_tokens).toBeUndefined();
    expect(parsed.completion_tokens).toBeUndefined();
    // What the tile does with that: the guard can now be false.
    expect(typeof parsed.prompt_tokens === 'number' && typeof parsed.completion_tokens === 'number').toBe(false);
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

    const base = servingResponses.liveAnswerResponse.custom_outputs.answer as Record<string, unknown>;
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
    expect(answered.trace?.stages).toEqual(expected.stages.map((stage) => ({ depth: 0, parent_id: '', ...stage })));
    expect(answered.caveats).toEqual(servingResponses.liveAnswerResponse.custom_outputs.answer.caveats);
  });

  it('says so when the question ran as the application instead of as the reader', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      // No forwarded token, which is what a background caller looks like and
      // what a deployment missing `serving.serving-endpoints` from its user
      // scopes looks like. Either way the endpoint sees the app, so the
      // warehouse enforces the app's grants and not the reader's.
      const fellBack = await app.ask(
        { conversationId: 'conv-sp-fallback', prompt: NONTRIVIAL_QUESTION, executePlan: true },
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

  it('answers only from the run, with no stored fixture mixed into it', async () => {
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

    // There is no fixture left to compare against, which is the stronger form
    // of the property this used to assert by inequality: every section came
    // from the endpoint's own reply, so it is asserted against that reply.
    expect(answered.mode).toBe('live');
    expect(answered.provenance).toBe('live');
    expect(answered.figures).toEqual(liveAnswerResponse.custom_outputs.answer.figures);
    expect(answered.sql).toBe(liveAnswerResponse.custom_outputs.answer.sql);
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
    const broken = extractStructuredAnswer(answerWithCharts([{ id: 'chart-1', title: 't', kind: 'bar' }]));
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
    const app = await startInsightsApp(() => Promise.resolve(answerWithCharts(specs)), memoryLakebase());

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
      answeredId = (
        await app.ask({
          conversationId: 'conv-charts-stored',
          prompt: NONTRIVIAL_QUESTION,
          executePlan: true,
        })
      ).id as string;
      const trace = await app.runTrace(answeredId);
      expect(trace.status).toBe(200);
      expect(trace.body.charts).toEqual(specs);
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
      // decision to report. The default gate mode is service-principal (own access
      // not verified); who executes is analyticalExecution below, not this field.
      accessDecision: null,
      // The endpoint's own principal when preflight has reported it. Null rather
      // than guessed: it is only knowable from a preflight report that has come back.
      servingPrincipal: null,
      // Whether the rail is carrying more than this person's conversations.
      // Asserted exhaustively on purpose: this payload is what the page knows
      // about who it is acting for, and a field appearing in it unnoticed is
      // how the page ends up describing a scope nobody chose.
      sharedConversationRail: false,
      // Which principal the next question would run as, which is NOT
      // `executionMode` above: that is where this reader left the access gate,
      // and this is the boundary the ask route would enforce. They disagree
      // here for a reason worth keeping visible -- no user token was forwarded,
      // so this process would execute as itself, and it says so rather than
      // inheriting the gate's answer.
      analyticalExecution: { mode: 'app_service_principal', verified: false },
      // What the sign-in this browser presented was shown to carry. This request
      // forwards no token, so the honest answer is that nothing was established,
      // and the shape of that answer is the point: no cause, no evidence, and
      // NO REMEDY. A remedy here would be the app telling somebody to go and fix
      // a session it never looked at, which is the 2026-08-16 defect in
      // miniature. `server/lib/diagnosis-audit.test.ts` enforces it.
      session: {
        state: 'undetermined',
        cause: 'undetermined',
        evidence: '',
        explanation:
          'This request carried no forwarded sign-in, so there is nothing to compare against the ' +
          'permissions this app asks for. Nothing about your sign-in was established either way.',
        remedy: null,
        // The fact this branch is about. Nothing was forwarded, which is not the
        // same as a sign-in the app could not read, and the two are otherwise
        // identical here.
        signedIn: false,
        tokenScopes: null,
        declaredScopes: null,
        missingScopes: [],
      },
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
    expect(identityPayload(request({ 'x-forwarded-email': 'other@example.example' })).executionMode).toBe(
      'service-principal'
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
    expect(payload.signedInAs).not.toContain('@example.com');
  });

  it('falls back to a readable execution identity when the client id is absent', () => {
    delete process.env.DATABRICKS_CLIENT_ID;
    expect(identityPayload(request()).executionIdentity).toBe('Astrolabe service principal');
  });
});

/**
 * "Explore full run" sent people to a Run Explorer that read `benchmark_runs`
 * alone, so the conversation they had just finished was structurally absent from
 * the list. The answer was stored, in full, as a message nobody queried.
 */
describe('the label a conversation carries in the rail', () => {
  /** Longer than the 80 characters the label used to be cut to, and cut there it
   *  ended "and how many" — a question with its question removed. */
  const LONG_QUESTION =
    'Which three titles had the most active players in the last 30 days, and how many did each have?';

  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  /** Asks, approves the plan it proposes, and returns the store. */
  async function askAndApprove(conversationId: string, prompt: string) {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const store = memoryLakebase();
    const app = await startInsightsApp(agentContractTransport([]), store);
    try {
      const planned = await app.ask({ conversationId, prompt });
      await app.ask({
        conversationId,
        prompt,
        approvedPlanId: planned.plan?.id,
        executePlan: true,
      });
      return store;
    } finally {
      await app.close();
    }
  }

  it('stores the whole question, not the first 80 characters of it', async () => {
    expect(LONG_QUESTION.length).toBeGreaterThan(80);

    const store = await askAndApprove('conv-label', LONG_QUESTION);

    expect(store.conversationTitles.get('conv-label')).toBe(LONG_QUESTION);
  });

  it('renames a conversation an upload created, which used to read "New conversation" forever', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const store = memoryLakebase();
    const app = await startInsightsApp(agentContractTransport([]), store);

    try {
      // Establish the caller's address the way the route does, by asking once, so
      // the seeded row below is owned by the person who then asks in it. A row
      // owned by somebody else is refused, which would pass this test for the
      // wrong reason.
      const planned = await app.ask({ conversationId: 'conv-owner', prompt: NONTRIVIAL_QUESTION });
      await app.ask({
        conversationId: 'conv-owner',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: planned.plan?.id,
        executePlan: true,
      });
      const email = store.conversations.get('conv-owner');
      expect(email).toBeDefined();

      // What attaching a document does: the conversation exists, with a placeholder
      // for a label, before anybody has asked anything in it.
      await store.query('INSERT INTO player_insights.conversations (id, user_email, title) VALUES ($1,$2,$3)', [
        'conv-uploaded',
        email,
        PLACEHOLDER_CONVERSATION_TITLE,
      ]);
      expect(store.conversationTitles.get('conv-uploaded')).toBe(PLACEHOLDER_CONVERSATION_TITLE);

      const second = await app.ask({ conversationId: 'conv-uploaded', prompt: LONG_QUESTION });
      await app.ask({
        conversationId: 'conv-uploaded',
        prompt: LONG_QUESTION,
        approvedPlanId: second.plan?.id,
        executePlan: true,
      });

      expect(store.conversationTitles.get('conv-uploaded')).toBe(LONG_QUESTION);
    } finally {
      await app.close();
    }
  });

  it('does not rename a conversation on its later turns', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const store = memoryLakebase();
    const app = await startInsightsApp(agentContractTransport([]), store);

    try {
      const first = await app.ask({ conversationId: 'conv-two-turns', prompt: LONG_QUESTION });
      await app.ask({
        conversationId: 'conv-two-turns',
        prompt: LONG_QUESTION,
        approvedPlanId: first.plan?.id,
        executePlan: true,
      });

      const later = await app.ask({ conversationId: 'conv-two-turns', prompt: NONTRIVIAL_QUESTION });
      await app.ask({
        conversationId: 'conv-two-turns',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: later.plan?.id,
        executePlan: true,
      });

      // The rail names a conversation by what it was opened with. Renaming it on
      // every turn would move the label out from under a reader mid-conversation.
      expect(store.conversationTitles.get('conv-two-turns')).toBe(LONG_QUESTION);
    } finally {
      await app.close();
    }
  });
});

describe('an answered conversation is a run', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  it('reads answered turns as well as benchmark runs', () => {
    const sql = RUNS_QUERY.replace(/\s+/g, ' ');

    expect(sql).toContain('FROM player_insights.messages m');
    expect(sql).toContain('FROM player_insights.runs r');
    expect(sql).toContain("WHERE r.state = 'CANCELLED'");
    expect(sql).toContain("COALESCE(label_overlay.status, 'cancelled') AS status");
    expect(sql).toContain('FROM player_insights.benchmark_runs b');
    expect(sql).toContain('UNION ALL');
    // A plan proposal carries no trace, so it is a pending approval, not a run.
    expect(sql).toContain("jsonb_typeof(m.response_json->'trace') = 'object'");
  });

  it('carries whether each run stopped early, from what each half recorded', () => {
    // The Run Explorer's Truncated badge had no field to read: the list query
    // carried a status and a duration, and a run cut short looks exactly like a
    // short one in both. Neither half infers it -- a benchmark writes a
    // `truncation` object when it abandons cases, and a conversation run that
    // hit one of the agent's bounds closes with the `cap` stage and no other
    // path emits one -- so both are read rather than guessed from the counts.
    const sql = RUNS_QUERY.replace(/\s+/g, ' ');

    expect(sql).toContain('$.stages[*] ? (@.id == "cap")');
    expect(sql).toContain("jsonb_typeof(b.metrics_json->'truncation') = 'object'");
    // Once per half, and nowhere else: a UNION takes its column names from the
    // first branch, so a half that omitted the column would silently borrow the
    // other's value for every row.
    expect(sql.match(/AS truncated/g)).toHaveLength(3);
  });

  it('carries the agent tool-call count used by the Run Explorer badge', () => {
    const sql = RUNS_QUERY.replace(/\s+/g, ' ');

    expect(sql).toContain("(a.trace->>'toolCalls')::int AS tool_calls");
    expect(sql).toContain('NULL::int AS tool_calls');
    expect(sql.match(/AS tool_calls/g)).toHaveLength(3);
  });

  it('carries which Genie space answered each run', () => {
    // Nothing recorded this. The space is chosen at request time from settings
    // baked into the model artifact, so the app cannot look it up and no stored
    // run named one -- which is why Genie-per-person could not be shown at all.
    const sql = RUNS_QUERY.replace(/\s+/g, ' ');

    expect(sql).toContain("a.trace->'genie_spaces' AS genie_spaces");
    // NULL, not an empty array, on the half that does not record it. A suite has
    // no single trace to read spaces off, and '[]' there would assert that a run
    // of Genie cases opened no space.
    expect(sql).toContain('NULL::jsonb AS genie_spaces');
    expect(sql.match(/AS genie_spaces/g)).toHaveLength(3);
  });

  it('declares the spaces on the answer contract, so a run that used one is not drift', () => {
    // The trace projection reports undeclared keys as the agent having moved
    // ahead of the app. Undeclared here, every answer from an agent that records
    // this would log a drift warning on every question anyone asked.
    const parsed = TraceSchema.parse({
      id: 'tr-1',
      totalMs: 1,
      toolCalls: 1,
      stages: [],
      genie_spaces: [{ id: 'space-data', title: 'Player Insights Data' }],
    });

    expect(parsed.genie_spaces).toEqual([{ id: 'space-data', title: 'Player Insights Data' }]);
    // Absent stays absent. A run stored before the agent recorded this reported
    // nothing, and defaulting it to [] would claim it asked no Genie space.
    expect(TraceSchema.parse({ id: 'tr-2', totalMs: 1, toolCalls: 0, stages: [] }).genie_spaces).toBeUndefined();
  });

  it('lists a just-answered question, keyed by the id the answer came back with', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

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

      // Nothing derived, and nothing substituted for it either: the store
      // answered and held no runs, which is an empty list. This used to assert
      // the seeded rows, which made the interesting half of the case (that the
      // plan is not among them) true for the wrong reason.
      const runs = await app.runs();
      expect(runs).toEqual([]);
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
 * A chart is not the answer, so its outcome is not the answer's verdict.
 *
 * The live run this was written from: ten steps, nine of them green, and step
 * ten -- "Built the charts" -- amber, because the plotting model was handed
 * results holding no series and sent back an empty figure. The Run Explorer
 * filed that turn as `partial`, the conversation rail put an amber pill on it,
 * and the narrative, the figures, the sources and the SQL underneath were all
 * correct and all queried.
 */
describe('the run verdict a chart cannot degrade', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  /** The contract transport, answering with stages of this test's choosing. */
  function transportWithStages(stages: Record<string, unknown>[]): ServingTransport {
    return ({ payload }) => {
      const wire = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
      const customInputs = (wire.custom_inputs ?? {}) as Record<string, unknown>;
      const approved = Boolean(customInputs.approved_plan_id) || customInputs.execute_plan === true;
      if (!approved) return Promise.resolve(servingResponses.livePlanResponse);
      const answer = JSON.parse(
        JSON.stringify(servingResponses.liveAnswerResponse)
      ) as typeof servingResponses.liveAnswerResponse;
      (answer.custom_outputs.answer.trace as unknown as { stages: unknown[] }).stages = stages;
      return Promise.resolve(answer);
    };
  }

  const step = (id: string, status: string) => ({
    id,
    name: id,
    kind: id === 'plot' ? 'tool' : 'agent',
    status,
    start: 0,
    duration: 1,
    calls: 1,
    input: '4 tool result(s) to plot',
    output: 'No chart rendered.',
  });

  it('lists a run whose only amber step was the chart as complete', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(
      transportWithStages([step('plan', 'complete'), step('synthesis', 'complete'), step('plot', 'partial')]),
      memoryLakebase()
    );

    try {
      const planned = await app.ask({ conversationId: 'conv-chart', prompt: NONTRIVIAL_QUESTION });
      const answered = await app.ask({
        conversationId: 'conv-chart',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: planned.plan?.id,
        executePlan: true,
      });
      expect(answered.type).toBe('answer');

      const run = (await app.runs()).find((candidate) => candidate.id === answered.id);

      // The step keeps its own account of itself; only the aggregate changes.
      const stages = (answered.trace?.stages ?? []) as { id?: string; status?: string }[];
      expect(stages.find((stage) => stage.id === 'plot')?.status).toBe('partial');
      expect(run?.status).toBe('complete');
    } finally {
      await app.close();
    }
  });

  it('still lets a step that IS the answer degrade the run', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(
      transportWithStages([step('discover', 'partial'), step('plot', 'complete')]),
      memoryLakebase()
    );

    try {
      const planned = await app.ask({ conversationId: 'conv-degraded', prompt: NONTRIVIAL_QUESTION });
      const answered = await app.ask({
        conversationId: 'conv-degraded',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: planned.plan?.id,
        executePlan: true,
      });

      const run = (await app.runs()).find((candidate) => candidate.id === answered.id);
      expect(run?.status).toBe('partial');
    } finally {
      await app.close();
    }
  });

  it('exempts the chart step from failed as well as partial', () => {
    // A plotting endpoint that cannot be reached is the same class of event as a
    // spec it would not render: a picture is missing and the answer is not.
    expect(runVerdict([{ id: 'plot', status: 'failed' }])).toBe('complete');
    expect(runVerdict([{ id: 'plot', status: 'partial' }])).toBe('complete');
    expect(
      runVerdict([
        { id: 'discover', status: 'failed' },
        { id: 'plot', status: 'complete' },
      ])
    ).toBe('failed');
    // Worst-first still holds among the steps that do count.
    expect(
      runVerdict([
        { id: 'discover', status: 'partial' },
        { id: 'synthesis', status: 'failed' },
      ])
    ).toBe('failed');
    // A step this rule cannot recognise counts, rather than being waved through.
    expect(runVerdict([{ status: 'partial' }])).toBe('partial');
    expect(runVerdict([])).toBe('failed');
  });

  it('does not call a deadline or salvage caveat a complete answer when nothing landed', () => {
    expect(
      answerRunVerdict({
        stages: [{ id: 'synthesis', status: 'complete' }],
        caveats: ['The turn deadline was reached before the answer could be written.'],
      })
    ).toBe('partial');
    expect(answerRunVerdict({ stages: [], caveats: [] })).toBe('failed');
  });

  it('does not call a finished tabled answer Partial because a tool step missed', () => {
    expect(
      answerRunVerdict({
        stages: [
          { id: 'sql', status: 'failed' },
          { id: 'synthesis', status: 'complete' },
        ],
        caveats: ['The turn deadline was reached before the answer could be written.'],
        figures: [{ label: 'VLH', value: 6655 }],
        narrative: '| Franchise | Players |\n| VLH | 6655 |',
      })
    ).toBe('complete');
  });

  it('does not fail a tabled answer because sources were incomplete', () => {
    expect(
      answerRunVerdict({
        stages: [{ id: 'synthesis', status: 'complete' }],
        caveats: [
          'The sources for this answer are incomplete: part of it came from a query whose tables could not be determined.',
        ],
        figures: [{ label: 'VLH', value: 6655 }],
        narrative: '| Franchise | Players |\n| VLH | 6655 |',
      })
    ).toBe('complete');
  });

  it('carries the same exemption into the SQL the store actually runs', () => {
    // The verdict is computed in Postgres, so the TypeScript rule above proves
    // nothing on its own. Both are built from VERDICT_EXEMPT_STAGE_IDS; this is
    // the assertion that the query really was built from it.
    const sql = RUNS_QUERY.replace(/\s+/g, ' ');

    expect(VERDICT_EXEMPT_STAGE_IDS).toContain('plot');
    for (const id of VERDICT_EXEMPT_STAGE_IDS) {
      expect(VERDICT_STAGE_EXEMPTION_SQL).toContain(`@.id != "${id}"`);
    }
    expect(sql).toContain(`'$.stages[*] ? (@.status == "failed" ${VERDICT_STAGE_EXEMPTION_SQL})'`);
    expect(sql).toContain(`'$.stages[*] ? (@.status == "partial" ${VERDICT_STAGE_EXEMPTION_SQL})'`);
    expect(sql).toContain('@.id == "synthesis"');
    expect(sql).toContain('@.status == "failed"');
    expect(sql).toContain('@.status == "partial"');
    expect(sql).toContain('run limit was reached');
    expect(sql).not.toContain('(@.status == "failed" || @.status == "partial")');
    expect(sql).toContain("jsonb_array_length(a.trace->'stages') = 0");
    expect(sql).toContain('turn deadline');
    expect(sql).toContain("a.payload->'figures'");
    expect(sql).toContain("THEN 'partial'");
    expect(sql).toContain("THEN 'complete'");
    expect(sql).toContain('declared tables');
    expect(sql).toContain('>= 40');
    expect(sql).toContain('label_overlay');
    expect(sql).toContain('this answer is degraded');
    // No unfiltered any-stage failed predicate. A finished answer with one
    // missed SQL call must not become Partial on read.
    expect(sql).not.toContain('(@.status == "failed")');
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

  it('answers statelessly when the app role cannot use the Postgres schema', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const captured: CapturedInvocation[] = [];
    const denied = new Error('permission denied for schema player_insights') as Error & { code: string };
    denied.code = '42501';
    const app = await startInsightsApp(agentContractTransport(captured), {
      query: () => Promise.reject(denied),
    });

    try {
      const planned = await app.ask({ conversationId: 'conv-no-storage', prompt: NONTRIVIAL_QUESTION });
      const answered = await app.ask({
        conversationId: 'conv-no-storage',
        prompt: NONTRIVIAL_QUESTION,
        approvedPlanId: planned.plan?.id,
        executePlan: true,
      });

      expect(answered.type).toBe('answer');
      expect(answered.takeaway).toBeTruthy();
      expect(answered.runStored).toBe(false);
      expect(captured).toHaveLength(2);
      // No unread history or attachment is represented as empty stored data.
      // The current question still reaches the endpoint as a stateless turn.
      expect(captured[1]?.payload.input).toEqual([{ role: 'user', content: NONTRIVIAL_QUESTION }]);
      expect(captured[1]?.payload.custom_inputs).not.toHaveProperty('attachment_text');
    } finally {
      await app.close();
    }
  });

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

  /**
   * The Run Explorer's Final answer tab, which showed an answer's takeaway, its
   * prose and its source and none of its caveats.
   *
   * This projection is the whole of that bug. The stored row has always carried
   * them, `AnswerCaveats` has always been able to draw them, and this object
   * -- the only thing the tab is built from -- did not list the key, so a
   * governance refusal or a coverage gap that qualified a figure was absent from
   * the one surface people open when they have begun to doubt the figure. Asserted
   * against the caveats the agent actually sent rather than a count, because a
   * count would still pass if the projection carried only the ones the app
   * appends itself.
   */
  it('carries the answer’s own caveats, which the Final answer tab draws', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const answered = await answeredRun(app, 'conv-trace-caveats');
      const { body } = await app.runTrace(String(answered.id));
      const caveats = body.caveats as string[];

      expect(caveats.some((caveat) => caveat.includes('records in this demo are synthetic'))).toBe(true);
      expect(caveats.some((caveat) => caveat.includes('counted three times across the table'))).toBe(true);
    } finally {
      await app.close();
    }
  });

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
    const app = await startInsightsApp(
      agentContractTransport([]),
      memoryLakebase(
        [],
        [
          {
            resource_id: 'experiment-id',
            value: '9998887776665554',
            intent: 'active',
            updated_by: 'deployer@acme.com',
          },
        ]
      )
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

      // Identical to what the answer carried, stage for stage.
      expect(body.trace?.id).toBe(answered.trace?.id);
      expect(body.trace?.totalMs).toBe(answered.trace?.totalMs);
      expect(body.trace?.stages).toEqual(answered.trace?.stages);
      expect(body.takeaway).toBe(answered.takeaway);
      expect(body.sql).toBe(answered.sql);
    } finally {
      await app.close();
    }
  });

  it('returns the runtime that ask sent, not today’s settings', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const stored: RuntimeSettings = {
      ...DEFAULT_RUNTIME_SETTINGS,
      loop: { maxSteps: 10, maxToolCalls: 15, maxRunSeconds: 200 },
      answer: {
        ...DEFAULT_RUNTIME_SETTINGS.answer,
        takeaway: false,
        narrativeMaxCharacters: 800,
        figuresOrder: 'totals-first',
      },
    };
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase([], [], stored));

    try {
      const answered = await answeredRun(app, 'conv-runtime-used');
      const { body } = await app.runTrace(String(answered.id));
      expect(body.runtimeUsed).toEqual({
        loop: { maxSteps: 10, maxToolCalls: 15, maxRunSeconds: 200 },
        answer: {
          takeaway: false,
          narrative: true,
          figures: true,
          charts: true,
          narrativeMaxCharacters: 800,
          figuresOrder: 'totals-first',
        },
      });
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
      expect(
        body.toolStages?.length,
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
      expect(
        body,
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
      // Empty rather than absent, which is what lets the Final answer tab draw
      // its caveat panel from this key without first asking whether it exists.
      expect(body.caveats).toEqual([]);
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
   * There is no reference trace to fall back to on any deployment, so the two
   * conditions that used to produce one are now told apart by their status.
   * A store that answered and holds no such run is a 404; a store nobody could
   * read is not, because "no run with this id" is a claim the app cannot make
   * when it could not look.
   */
  it('answers an id no stored run has with a 404, whatever the id looks like', async () => {
    const app = await startInsightsApp(agentContractTransport([]));

    try {
      // A formerly-seeded id is not special. The store answered and holds no
      // run with it, which is the same 404 any other unknown id gets, rather
      // than a reference trace wearing the id the user clicked.
      const { status, body } = await app.runTrace('run-1042');

      expect(status).toBe(404);
      expect(body.error).toBe('run_not_found');
    } finally {
      await app.close();
    }
  });

  it('says the store could not be read rather than that the run does not exist', async () => {
    const app = await startInsightsApp(agentContractTransport([]), {
      query: () => Promise.reject(new Error('connection refused')),
    });

    try {
      const { status, body } = await app.runTrace('run-1042');

      // Not a 404, and not a fixture. Answering 404 here would report a run as
      // never stored on the strength of a read that never happened.
      expect(status).toBe(503);
      expect(body.code).toBe('PERSISTENCE_UNAVAILABLE');
      expect(body.mode).not.toBe('representative');
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

  it('abandons a silent endpoint rather than waiting forever', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const appkit = {
      lakebase: { query: () => Promise.resolve({ rows: [] }) },
      server: { extend: () => {} },
      servingTransport: () => new Promise<never>(() => {}),
    } as unknown as InsightsAppKit;

    await expect(invokeServing(appkit, { input: [] }, undefined, 30)).rejects.toThrow(/did not answer within 30 ms/);
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

    // BOTH IDS HERE ARE INVENTED, and the trace id has to stay that way. A live
    // one sat here, recorded as resolving through GET /api/3.0/mlflow/traces/{id}
    // against the deployed workspace, and it proved nothing this one does not:
    // `mlflowReference` validates the `tr-<hex>` shape and builds the URL by
    // concatenation, so which trace and which experiment it names is not part of
    // what is under test. Naming a live experiment also costs the published copy
    // of this test its only assertion, because `<mlflow-experiment-id>` is what
    // the publish rewrite substitutes and it URL-encodes to
    // %3Cmlflow-experiment-id%3E, which the expected string here cannot spell.
    const reference = mlflowReference('tr-0123456789abcdef0123456789abcdef', '9998887776665554');

    expect(reference?.traceId).toBe('tr-0123456789abcdef0123456789abcdef');
    expect(reference?.experimentId).toBe('9998887776665554');
    expect(reference?.url).toBe(
      'https://example.cloud.databricks.com/ml/experiments/9998887776665554/traces' +
        '?selectedEvaluationId=tr-0123456789abcdef0123456789abcdef'
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

    const reference = mlflowReference('tr-0123456789abcdef0123456789abcdef', '');

    expect(reference?.traceId).toBe('tr-0123456789abcdef0123456789abcdef');
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

  /**
   * An answer carrying evidence but no MLflow trace id, which is what any
   * untraced answer looks like now that no canned one is served. The derivation
   * is what is pinned: nothing has to remember to set a flag.
   */
  function untraced(overrides: Record<string, unknown> = {}) {
    return {
      caveats: [],
      figures: [{ label: 'Title A', value: 100, display: '1,000', comparison: '#1' }],
      sources: [{ name: '<catalog>.<schema>.some_table', freshness: 'Current' }],
      sql: 'SELECT 1',
      trace: { id: 'trace-not-an-mlflow-id', stages: [{}] },
      ...overrides,
    };
  }

  it('marks an answer that carries evidence with no MLflow trace behind it', () => {
    const disclosed = discloseAnswerProvenance(untraced());

    expect(disclosed.trace.id).not.toMatch(/^tr-[0-9a-f]+$/i);
    expect(disclosed.caveats[0]).toBe(REPRESENTATIVE_ANSWER_CAVEAT);
  });

  it('leaves an answer that carries a real MLflow trace id untouched', () => {
    const live = liveAnswerResponse.custom_outputs.answer;

    expect(live.trace.id).toMatch(/^tr-[0-9a-f]+$/i);
    expect(discloseAnswerProvenance(live)).toBe(live);
  });

  it('marks an answer once, however many times it passes through', () => {
    const once = discloseAnswerProvenance(untraced());

    expect(discloseAnswerProvenance(once).caveats).toEqual(once.caveats);
  });

  /**
   * The disclosure is on the answer rather than at the place it was built, which
   * is what makes it cover an answer stored before the seeded content was
   * removed: those rows are read back out of `response_json` long after the code
   * that wrote them is gone, and they still have to render disclosed.
   */
  it('leaves a disclosure already on a stored answer exactly where it is', () => {
    const stored = untraced({ caveats: [REPRESENTATIVE_ANSWER_CAVEAT, 'Some other caveat.'] });

    expect(discloseAnswerProvenance(stored).caveats).toEqual([REPRESENTATIVE_ANSWER_CAVEAT, 'Some other caveat.']);
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
   * The case this disclosure used to be needed for, kept as the assertion that
   * it cannot happen. A plain-text endpoint reply became a live narrative on top
   * of the representative figures, chart, SQL and stages, and the caveat was the
   * only thing standing between a reader and canned numbers about their own
   * business. The reply now carries nothing but its own words, so the caveat has
   * nothing to warn about and must not be added: a warning about stored figures
   * on a screen with no figures teaches people to ignore the warning.
   */
  it('leaves a prose reply with no borrowed figures to disclose', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(
      () =>
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
      expect(answered.figures).toEqual([]);
      expect(answered.caveats).not.toContain(REPRESENTATIVE_ANSWER_CAVEAT);
    } finally {
      await app.close();
    }
  });

  it('strips the process view off a live answer that has no MLflow id', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const payload = JSON.parse(JSON.stringify(servingResponses.liveAnswerResponse)) as Record<string, unknown>;
    const outputs = payload.custom_outputs as { answer: { trace: { id: string; stages: unknown[] } } };
    outputs.answer.trace.id = 'trace-local';
    const app = await startInsightsApp(() => Promise.resolve(payload), memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-untraced-process',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      expect(answered.caveats).toContain(REPRESENTATIVE_ANSWER_CAVEAT);
      expect((answered.trace as { id: string }).id).toBe('trace-local');
      expect((answered.trace as { stages: unknown[] }).stages).toEqual([]);
      expect((answered.trace as { totalMs: number; toolCalls: number }).totalMs).toBe(
        servingResponses.liveAnswerResponse.custom_outputs.answer.trace.totalMs
      );
      expect((answered.trace as { toolCalls: number }).toolCalls).toBe(
        servingResponses.liveAnswerResponse.custom_outputs.answer.trace.toolCalls
      );
      expect(answered.figures).toEqual(servingResponses.liveAnswerResponse.custom_outputs.answer.figures);
    } finally {
      await app.close();
    }
  });

  it('recovers the MLflow id from the serving envelope and keeps the process view', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const payload = JSON.parse(JSON.stringify(servingResponses.liveAnswerResponse)) as Record<string, unknown>;
    const outputs = payload.custom_outputs as { answer: { trace: { id: string } } };
    outputs.answer.trace.id = 'trace-local';
    payload.databricks_output = { databricks_request_id: 'tr-0123456789abcdef0123456789abcdef' };
    const app = await startInsightsApp(() => Promise.resolve(payload), memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-recovered-trace',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      expect(answered.caveats).not.toContain(REPRESENTATIVE_ANSWER_CAVEAT);
      expect((answered.trace as { id: string }).id).toBe('tr-0123456789abcdef0123456789abcdef');
      expect((answered.trace as { stages: unknown[] }).stages.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('binds a stream tr- id when the serving request id is a UUID', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const payload = JSON.parse(JSON.stringify(servingResponses.liveAnswerResponse)) as Record<string, unknown>;
    const outputs = payload.custom_outputs as { answer: { trace: { id: string } }; trace_id?: string };
    outputs.answer.trace.id = 'trace-local';
    outputs.trace_id = 'tr-0123456789abcdef0123456789abcdef';
    payload.databricks_output = { databricks_request_id: 'deadbeef-0000-4000-8000-000000000001' };
    const app = await startInsightsApp(() => Promise.resolve(payload), memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-stream-trace',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      expect((answered.trace as { id: string }).id).toBe('tr-0123456789abcdef0123456789abcdef');
      expect((answered.trace as { stages: unknown[] }).stages.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});

/**
 * A failed question is reported as one.
 *
 * The route used to pre-seed `answer` with a canned response and overwrite it
 * where a live answer turned up, which meant every other way out of the
 * endpoint call inherited canned figures and returned them as `type: 'answer'`
 * over HTTP 200. That became an explicit fallback with the reason in the
 * caveats, then a flag-gated one, and is now gone entirely: a labelled fixture
 * is still the app answering a question somebody asked with figures nobody
 * queried, and the label was never the control. Compiled-in content may fill a
 * surface with nothing on it; a question with the reader's own words above it
 * is not one.
 *
 * These used to run twice, once per state of the flag that gated the fallback,
 * because a regression that re-gated it rather than removing it would pass the
 * unset half. With no flag left to gate on there is one deployment shape, so
 * they run once and the property is the same one: nothing is invented.
 */
describe('a failed run is answered with nothing', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

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

  it('reports an endpoint that could not be called, and invents no figures', async () => {
    const { status, body, errors } = await askThrough(
      () => Promise.reject(new Error('socket hang up after 30000 ms')),
      'conv-honest-throw'
    );

    expect(status).toBe(503);
    expect(body.type).toBe('unavailable');
    expect((body as { code?: string }).code).toBe('DEPENDENCY_UNAVAILABLE');
    // The assertion this whole contract exists for. Not "the figures are
    // labelled", not "the figures are correct": there are none.
    expect(body.figures).toBeUndefined();
    expect(body.takeaway).toBeUndefined();
    expect(body.narrative).toBeUndefined();
    expect((body as { request_id?: string }).request_id).toBeTruthy();
    // console.warn is not the right severity for a question that went
    // unanswered, and the cause is the first thing anyone triaging it wants.
    expect(errors.join('\n')).toContain('socket hang up after 30000 ms');
  });

  /**
   * The failure the reader is shown is built from these fields, so a route that
   * stops populating them puts the old sentence back on the screen without
   * changing a word of the copy.
   *
   * Asserted per field rather than as one object, because the regression is
   * always one field going missing -- `detail` was populated at every site for
   * months while the browser rendered none of it -- and an object comparison
   * fails in a way that does not say which.
   */
  it('names the endpoint and quotes its error, so the panel has something to show', async () => {
    const { body } = await askThrough(
      () => Promise.reject(new Error('socket hang up after 30000 ms')),
      'conv-evidence-dependency'
    );

    const evidence = (body as { evidence?: FailureEvidence }).evidence;
    // The name a reader can go and look at, from the environment this request
    // was actually sent with.
    expect(evidence?.dependency).toEqual({ kind: 'agent-endpoint', name: 'player-insights-agent' });
    // Verbatim. Anything else here is a paraphrase of an error, which is a
    // second error to debug.
    expect(evidence?.providerMessage).toBe('socket hang up after 30000 ms');
    // A socket that hung up carried no HTTP status and none is invented: "HTTP
    // 0" on a panel reads as a status the provider returned.
    expect(evidence?.status).toBeUndefined();
    // Nothing narrated this turn, and a stage claim would name a step that never
    // reported.
    expect(evidence?.stage).toBeUndefined();
  });

  /**
   * The disclosure boundary, held at the field that crosses it.
   *
   * Unity Catalog names the table, the missing privilege and its owner, which is
   * correct for a client holding the credential and wrong for this response
   * body: it reaches the reader who has just been told they may not read that
   * table, and another label's restricted product is that label's business. The
   * STATUS is disclosed, because 401-versus-403 is what the reader is actually
   * stuck on -- their session or their grants, two different people to go and
   * see -- and it names nothing.
   */
  it('discloses the status of a denial without forwarding what the provider named', async () => {
    const denial = Object.assign(
      new Error(
        'PERMISSION_DENIED: User does not have SELECT on table ' + 'restricted_catalog.other_label.player_identity'
      ),
      { statusCode: 403 }
    );
    const { status, body } = await askThrough(() => Promise.reject(denial), 'conv-evidence-denial');

    expect(status).toBe(403);
    const evidence = (body as { evidence?: FailureEvidence }).evidence;
    expect(evidence?.status).toBe(403);
    expect(evidence?.dependency?.name).toBe('player-insights-agent');
    // The reader's own address is theirs to see; the table is not.
    expect(evidence?.providerMessage).not.toContain('other_label');
    expect(evidence?.providerMessage).not.toContain('SELECT');
    expect(JSON.stringify(body)).not.toContain('player_identity');
  });

  it('reports a payload it cannot read, without answering from the fixture', async () => {
    const { status, body, errors } = await askThrough(
      () => Promise.resolve({ custom_outputs: { insight_bundle: { headline: 42 } } }),
      'conv-honest-contract'
    );

    // A different code from the one above, because the remedies differ: this
    // one is a version skew between this app and the agent, and telling an
    // operator the endpoint is down would send them to look at a healthy one.
    expect(status).toBe(502);
    expect((body as { code?: string }).code).toBe('OUTPUT_SCHEMA_VIOLATION');
    expect(body.figures).toBeUndefined();
    expect(errors.join('\n')).toContain('none of the four shapes');
  });

  /**
   * The defect the whole change is about, rather than either of the two known
   * conditions. Adding one `custom_outputs` type to the agent, which is
   * released separately from this app and in either order, used to be enough to
   * put the demo dataset in front of a customer over HTTP 200 with nothing on
   * the wire and one `console.warn` in the logs.
   */
  it('serves no fixture for a custom_outputs type nobody has written a branch for', async () => {
    const { status, body, errors } = await askThrough(
      () =>
        Promise.resolve({
          custom_outputs: {
            // A v9 agent answering in a shape this app predates entirely.
            player_insights_forecast: {
              horizon_days: 30,
              projected_active_players: [{ title: 'VLH Online', p50: 19_400 }],
            },
          },
        }),
      'conv-honest-future'
    );

    expect(status).toBe(502);
    expect(body.type).toBe('unavailable');
    // Absent rather than empty. An empty section is a card the reader still
    // sees; this path serves no answer at all.
    expect(body.figures).toBeUndefined();
    expect(body.sources).toBeUndefined();
    expect(errors.join('\n')).toContain('player_insights_forecast');
  });

  it('writes no answer row for a question that was never answered', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const lakebase = memoryLakebase();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await startInsightsApp(() => Promise.reject(new Error('connection refused')), lakebase);

    try {
      await app.askRaw({
        conversationId: 'conv-honest-stored',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      // Storing one would put the invented answer into the conversation
      // history and into Run Explorer, where the panel that said it was
      // unavailable is nowhere to be seen.
      expect(lakebase.messages.filter((message) => message.role === 'assistant')).toEqual([]);
    } finally {
      spy.mockRestore();
      await app.close();
    }
  });

  /**
   * The other half: this is not a warning stuck on every answer. An answer the
   * agent actually produced carries no degradation caveat, because a warning
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
      expect((answered.caveats as string[]).some((caveat) => caveat.startsWith(DEGRADED_ANSWER_MARKER))).toBe(false);
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
      expect(answered.caveats).not.toContain(PROSE_ONLY_ANSWER_CAVEAT);
      expect(answered.caveats).not.toContain(REPRESENTATIVE_ANSWER_CAVEAT);
      expect((answered.caveats as string[]).some((caveat) => caveat.startsWith(DEGRADED_ANSWER_MARKER))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('serves a prose reply with its words and nothing underneath them', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(prose, memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-prov-prose',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      // Live, and correctly so: a run happened, these are its words, and there
      // is now nothing on the answer that did not come from it.
      expect(answered.mode).toBe('live');
      expect(answered.narrative).toBe('VLH Online leads the last 30 days.');
      expect(answered.provenance).toBe('live');
      // The whole point. This used to be the demo seed's figures, sitting under
      // a narrative about the reader's own business over HTTP 200.
      expect(answered.figures).toEqual([]);
      expect(answered.sources).toEqual([]);
      expect(answered.sql).toBe('');
      expect((answered.trace as { stages: unknown[] }).stages).toEqual([]);
      // Above the answer in red, not fifth under "What to keep in mind". The
      // marker is for the renderer; the sentence is for the person reading.
      expect((answered.caveats as string[])[0]).toBe(PROSE_ONLY_ANSWER_CAVEAT);
      // The stored-demo caveat would be a lie in the other direction here:
      // there is no stored demo response on this screen to warn about.
      expect(answered.caveats).not.toContain(REPRESENTATIVE_ANSWER_CAVEAT);
    } finally {
      await app.close();
    }
  });

  it('does not keep streamed steps on a prose reply that has no MLflow id', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const transport: ServingTransport = ({ onStage }) => {
      onStage?.({
        id: 'step-1',
        name: 'Chose the next step',
        kind: 'agent',
        status: 'complete',
        start: 0,
        duration: 12,
        calls: 1,
        input: '',
        output: 'data_genie',
      });
      onStage?.({
        id: 'step-2',
        name: 'Querying governed data',
        kind: 'tool',
        status: 'running',
        start: 12,
        duration: 40,
        calls: 0,
        input: '{"question":"x"}',
        output: '',
      });
      return Promise.resolve({
        output: [{ content: [{ type: 'output_text', text: 'VLH Online leads the last 30 days.' }] }],
      });
    };
    const app = await startInsightsApp(transport, memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-prov-prose-steps',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
      expect((answered.trace as { stages: unknown[] }).stages).toEqual([]);
      expect((answered.caveats as string[]).some((caveat) => caveat.includes('stopped after 2 steps'))).toBe(true);
      expect((answered.caveats as string[]).some((caveat) => caveat.includes('no tool steps were recorded'))).toBe(
        false
      );
    } finally {
      await app.close();
    }
  });

  it('keeps streamed steps on a prose reply once serving recorded an MLflow id', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const transport: ServingTransport = ({ onStage }) => {
      onStage?.({
        id: 'step-1',
        name: 'Chose the next step',
        kind: 'agent',
        status: 'complete',
        start: 0,
        duration: 12,
        calls: 1,
        input: '',
        output: 'data_genie',
      });
      onStage?.({
        id: 'step-2',
        name: 'Querying governed data',
        kind: 'tool',
        status: 'running',
        start: 12,
        duration: 40,
        calls: 0,
        input: '{"question":"x"}',
        output: '',
      });
      return Promise.resolve({
        output: [{ content: [{ type: 'output_text', text: 'VLH Online leads the last 30 days.' }] }],
        databricks_output: { databricks_request_id: 'tr-0123456789abcdef0123456789abcdef' },
      });
    };
    const app = await startInsightsApp(transport, memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-prov-prose-traced',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
      const stages = (answered.trace as { stages: { id: string; status: string }[] }).stages;
      expect((answered.trace as { id: string }).id).toBe('tr-0123456789abcdef0123456789abcdef');
      expect(stages.map((stage) => [stage.id, stage.status])).toEqual([
        ['step-1', 'complete'],
        ['step-2', 'failed'],
      ]);
      expect(answered.caveats).not.toContain(REPRESENTATIVE_ANSWER_CAVEAT);
    } finally {
      await app.close();
    }
  });

  /**
   * There used to be a third path here, and this is what replaced it. Nothing
   * ran, so the route had a `mode` and a `provenance` to get right on a card
   * full of figures it had made up. The card is gone, so there is no answer to
   * label, and no deployment on which one comes back.
   */
  it('has no provenance to state when nothing ran at all, because it serves no answer', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await startInsightsApp(() => Promise.reject(new Error('socket hang up')), memoryLakebase());

    try {
      const { status, body } = await app.askRaw({
        conversationId: 'conv-prov-stored',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      expect(status).toBe(503);
      expect(body.type).toBe('unavailable');
      expect(body.mode).toBeUndefined();
      expect(body.provenance).toBeUndefined();
    } finally {
      spy.mockRestore();
      await app.close();
    }
  });

  /**
   * The disclosure has to survive the write. A conversation reopened tomorrow
   * renders from the stored row, so a prose answer whose emptiness existed only
   * on the live response would come back from the store with whatever the
   * renderer defaults to under it.
   */
  it('stores the prose answer as empty, so a reopened conversation stays empty', async () => {
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
      expect(stored.provenance).toBe('live');
      expect(stored.figures).toEqual([]);
      expect(stored.sources).toEqual([]);
      expect(stored.sql).toBe('');
      expect((stored.caveats as string[])[0]).toBe(PROSE_ONLY_ANSWER_CAVEAT);
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

/**
 * The ask route with a working run ledger behind it.
 *
 * `memoryLakebase` answers a statement it does not recognise with no rows,
 * which is what a ledger write looks like when the tables were never created,
 * so it exercises the degraded path rather than the working one. This composes
 * the two: the ledger statements go to the same fake Postgres the ledger's own
 * tests use, and everything else to the store the route tests already have.
 */
function lakebaseWithLedger(store: ReturnType<typeof memoryLakebase>) {
  const ledger = new FakeStore();
  return {
    ledger,
    lakebase: {
      query: (sql: string, params: unknown[] = []) =>
        /player_insights\.(runs|run_attempts|run_events)/.test(sql)
          ? ledger.lakebase.query(sql, params)
          : store.query(sql, params),
    },
  };
}

describe('the run ledger under POST /api/insights/ask', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  it('refuses a key it cannot honour before writing anything at all', async () => {
    // The request leaves no conversation row and no user turn behind it. A
    // question that was never asked must not appear in the rail, and the next
    // turn in that conversation must not carry it as context.
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const store = memoryLakebase();
    const app = await startInsightsApp(agentContractTransport([]), store);

    try {
      const { status, body } = await app.askRaw(
        { conversationId: 'conv-bad-key', prompt: NONTRIVIAL_QUESTION },
        { 'Idempotency-Key': 'short' }
      );

      expect(status).toBe(400);
      expect(store.messages).toHaveLength(0);
      // The code and the status agree, which they did not while a malformed
      // header was refused under the conflict's name over the conflict's
      // status. It leaves in the same shape as every other refusal now.
      expect(body.type).toBe('unavailable');
      expect(body.code).toBe('IDEMPOTENCY_KEY_MALFORMED');
      expect(status).toBe(unavailableHttpStatus('IDEMPOTENCY_KEY_MALFORMED'));
    } finally {
      await app.close();
    }
  });

  it('answers exactly as it always did when the ledger cannot record the run', async () => {
    // What shadow mode is for. On a database where the ledger's CREATE was
    // refused on ownership, every ledger statement fails and no reader may
    // notice.
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-no-ledger',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      expect(answered.type).toBe('answer');
      expect(answered.mode).toBe('live');
    } finally {
      await app.close();
    }
  });

  it('records the run and closes it as SUCCEEDED, naming the answer it can be replayed from', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const store = memoryLakebase();
    const { ledger, lakebase } = lakebaseWithLedger(store);
    const app = await startInsightsApp(agentContractTransport([]), lakebase);

    try {
      const answered = await app.ask({
        conversationId: 'conv-ledger-ok',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      expect(ledger.runs).toHaveLength(1);
      expect(ledger.runs[0].state).toBe('SUCCEEDED');
      expect(ledger.runs[0].terminal_message_id).toBe(answered.id);
      expect(ledger.runs[0].completed_at).not.toBeNull();
      // Walked rather than jumped, so a run that answered can be shown to have
      // passed through synthesis.
      expect(ledger.events.map((event) => event.to)).toEqual(['PLANNING', 'RUNNING', 'SYNTHESIZING', 'SUCCEEDED']);
    } finally {
      await app.close();
    }
  });

  it('persists before serving and finishes after the Ask view disconnects', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    let announceStarted: () => void = () => {};
    let releaseAnswer: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const answerGate = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    const transport: ServingTransport = async () => {
      announceStarted();
      await answerGate;
      return servingResponses.liveAnswerResponse;
    };
    const store = memoryLakebase();
    const { ledger, lakebase } = lakebaseWithLedger(store);
    const app = await startInsightsApp(transport, lakebase);

    try {
      const request = app.askAndDisconnect({
        conversationId: 'conv-detached',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
      await started;

      // All three durable records exist before Model Serving is allowed to
      // answer: the rail row, the user's turn, and the run itself.
      expect(store.conversations.has('conv-detached')).toBe(true);
      expect(
        store.messages.some((message) => message.conversation_id === 'conv-detached' && message.role === 'user')
      ).toBe(true);
      expect(ledger.runs).toHaveLength(1);
      expect(ledger.runs[0].state).toBe('RECEIVED');

      // A second view can discover both the conversation and its working run.
      await expect(app.conversations()).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'conv-detached' })])
      );
      await expect(app.conversationRun('conv-detached')).resolves.toMatchObject({ state: 'RECEIVED' });

      request.abort();
      await request.finished;
      releaseAnswer();

      // Closing the response only drops narration. The server still stores the
      // answer and closes the run, which is what the returning view polls for.
      await vi.waitFor(() => {
        expect(
          store.messages.some((message) => message.conversation_id === 'conv-detached' && message.role === 'assistant')
        ).toBe(true);
        expect(ledger.runs[0].state).toBe('SUCCEEDED');
      });
    } finally {
      releaseAnswer();
      await app.close();
    }
  });

  it('cancels an owned run durably, aborts its serving consumer, and persists no answer', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const savedWarehouse = process.env.DATABRICKS_SQL_WAREHOUSE_ID;
    process.env.DATABRICKS_SQL_WAREHOUSE_ID = 'warehouse-cancel-test';
    let announceStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    let invocations = 0;
    const transport: ServingTransport = ({ signal }) => {
      invocations += 1;
      announceStarted();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(signal.reason instanceof Error ? signal.reason : new Error('Run cancelled')),
          { once: true }
        );
      });
    };
    const store = memoryLakebase();
    const { ledger, lakebase } = lakebaseWithLedger(store);
    const cancelledStatements: string[] = [];
    const warehouseCancellationTransport: WarehouseCancellationTransport = {
      listQueries({ status }) {
        const run = ledger.runs[0];
        return Promise.resolve({
          res:
            status === 'RUNNING' && run
              ? [
                  {
                    query_id: 'statement-for-owned-run',
                    status: 'RUNNING',
                    warehouse_id: 'warehouse-cancel-test',
                    executed_as_user_name: DEVELOPMENT_IDENTITY,
                    query_tags: {
                      application: 'Astrolabe',
                      run_id: run.run_id,
                      correlation_id: run.correlation_id,
                    },
                  },
                  {
                    query_id: 'unrelated-statement',
                    status: 'RUNNING',
                    warehouse_id: 'warehouse-cancel-test',
                    executed_as_user_name: DEVELOPMENT_IDENTITY,
                    query_tags: { application: 'Catalog Explorer' },
                  },
                ]
              : [],
        });
      },
      cancelStatement(statementId) {
        cancelledStatements.push(statementId);
        return Promise.resolve();
      },
    };
    const app = await startInsightsApp(transport, lakebase, { warehouseCancellationTransport });

    try {
      const asking = app.ask({
        conversationId: 'conv-explicit-stop',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
      await started;
      const run = ledger.runs[0];
      const fenceBefore = run.fencing_token;

      const stopped = await app.cancelRun(String(run.correlation_id));
      const terminal = await asking;

      expect(stopped.status).toBe(200);
      expect(stopped.body).toMatchObject({ targeted: 1, cancelled: 1, runIds: [run.run_id], failures: [] });
      expect(stopped.body.warehouse).toMatchObject({ matched: 1, cancel_requested: 1, failed: 0, refused: 0 });
      expect(cancelledStatements).toEqual(['statement-for-owned-run']);
      expect(terminal).toMatchObject({ type: 'cancelled', state: 'CANCELLED', runId: run.run_id });
      expect(run.state).toBe('CANCELLED');
      expect(run.fencing_token).toBe(fenceBefore + 1);
      expect(run.lease_owner).toBeNull();
      expect(run.lease_expires_at).toBeNull();
      expect(store.messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
      // Cancellation is never a reason to try the blocking fallback.
      expect(invocations).toBe(1);
    } finally {
      if (savedWarehouse === undefined) delete process.env.DATABRICKS_SQL_WAREHOUSE_ID;
      else process.env.DATABRICKS_SQL_WAREHOUSE_ID = savedWarehouse;
      await app.close();
    }
  });

  it('returns 404 without revealing or stopping another reader run', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    let announceStarted: () => void = () => {};
    let releaseAnswer: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    const transport: ServingTransport = async () => {
      announceStarted();
      await gate;
      return servingResponses.liveAnswerResponse;
    };
    const store = memoryLakebase();
    const { ledger, lakebase } = lakebaseWithLedger(store);
    const app = await startInsightsApp(transport, lakebase);

    try {
      const asking = app.ask({
        conversationId: 'conv-owner-only-stop',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
      await started;
      const run = ledger.runs[0];

      const refused = await app.cancelRun(run.run_id, 'someone.else@example.com');

      expect(refused.status).toBe(404);
      expect(refused.body).not.toHaveProperty('owner');
      expect(run.state).toBe('RECEIVED');
      releaseAnswer();
      await asking;
      expect(run.state).toBe('SUCCEEDED');
    } finally {
      releaseAnswer();
      await app.close();
    }
  });

  it('guards Stop all as admin-only and cancels only the current snapshot', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    let announceStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const transport: ServingTransport = ({ signal }) => {
      announceStarted();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(signal.reason instanceof Error ? signal.reason : new Error('Run cancelled')),
          { once: true }
        );
      });
    };
    const store = memoryLakebase();
    const { ledger, lakebase } = lakebaseWithLedger(store);
    const app = await startInsightsApp(transport, lakebase);

    try {
      const asking = app.ask({
        conversationId: 'conv-admin-stop',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
      await started;

      const consumer = await app.cancelAll('consumer@example.com');
      expect(consumer.status).toBe(403);
      expect(ledger.runs[0].state).toBe('RECEIVED');

      const stopped = await app.cancelAll();
      await asking;
      expect(stopped.status).toBe(200);
      expect(stopped.body).toMatchObject({
        targeted: 1,
        cancelled: 1,
        failures: [],
        oneShot: true,
        deleted: 0,
        futureAsksPaused: false,
      });

      // The payload states the route's one-shot contract; the ledger unit test
      // admits a run created after the snapshot and proves there is no pause row.
      expect(stopped.body.futureAsksPaused).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('replays the steps a reader walked away from, and the ones taken while they were gone', async () => {
    /**
     * The reported bug, end to end. A reader leaves a running question; their
     * response body is gone and the run carries on. Coming back they used to be
     * told only that a run was in flight -- question on screen, composer shut,
     * agent path empty for the rest of the run -- because the steps only ever
     * existed on the socket that closed.
     */
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    let announceStarted: () => void = () => {};
    let releaseAnswer: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const answerGate = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    /** Held in an object so the assignment inside the transport is visible below. */
    const laterStep: { narrate: () => void } = { narrate: () => {} };
    const transport: ServingTransport = async ({ onStage }) => {
      onStage?.({
        id: 'step-1',
        name: 'Chose the next step',
        kind: 'agent',
        status: 'complete',
        start: 0,
        duration: 9,
        calls: 1,
      });
      // Announced but unfinished, which is the row a reader is watching when
      // they navigate away.
      onStage?.({
        id: 'step-2',
        name: 'Querying governed data',
        kind: 'tool',
        status: 'running',
        start: 9,
        duration: 0,
        calls: 0,
      });
      laterStep.narrate = () => {
        onStage?.({
          id: 'step-2',
          name: 'Queried governed data',
          kind: 'tool',
          status: 'complete',
          start: 9,
          duration: 40,
          calls: 1,
        });
      };
      announceStarted();
      await answerGate;
      return servingResponses.liveAnswerResponse;
    };
    const store = memoryLakebase();
    const { ledger, lakebase } = lakebaseWithLedger(store);
    const app = await startInsightsApp(transport, lakebase);

    try {
      const request = app.askAndDisconnect({
        conversationId: 'conv-replay-steps',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
      await started;
      await vi.waitFor(() => expect(ledger.stageEvents).toHaveLength(2));

      // The reader leaves. Their socket is gone; the run is not.
      request.abort();
      await request.finished;

      const whileAway = await app.conversationRun('conv-replay-steps');
      expect((whileAway?.stages as { id: string; status: string }[]).map((stage) => [stage.id, stage.status])).toEqual([
        ['step-1', 'complete'],
        ['step-2', 'running'],
      ]);

      // The run keeps narrating into a table rather than into a closed socket,
      // so the path a returning reader is shown goes on growing.
      laterStep.narrate();
      await vi.waitFor(() => expect(ledger.stageEvents).toHaveLength(3));
      const later = await app.conversationRun('conv-replay-steps');
      const replayed = later?.stages as { id: string; status: string; name: string }[];
      // The completion arrives as its own row under the same id, which is how
      // the browser learns the step it was waiting on has landed. Collapsing
      // them here would need the write path to update rows in place, and a
      // dense append-only sequence is what makes the order the run's order.
      expect(replayed).toHaveLength(3);
      expect(replayed[2]).toMatchObject({ id: 'step-2', status: 'complete', name: 'Queried governed data' });

      releaseAnswer();
      await vi.waitFor(() => expect(ledger.runs[0].state).toBe('SUCCEEDED'));
    } finally {
      releaseAnswer();
      await app.close();
    }
  });

  it('keeps the tool result out of the replayed steps', async () => {
    // The replay is read by the same browser that renders the rail, so it is a
    // response body a reader's own step arguments reach. Row data must not: the
    // authoritative trace carries results, and this table's own schema comment
    // rules them out.
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const transport: ServingTransport = ({ onStage }) => {
      onStage?.({
        id: 'step-1-1-data_genie',
        name: 'Queried governed data',
        kind: 'tool',
        status: 'complete',
        start: 0,
        duration: 40,
        calls: 1,
        input: '{"question": "which titles lost the most active players"}',
        output: '[{"title_id": 4471, "hours_viewed": 91827364}]',
      });
      return Promise.resolve(servingResponses.liveAnswerResponse);
    };
    const store = memoryLakebase();
    const { ledger, lakebase } = lakebaseWithLedger(store);
    const app = await startInsightsApp(transport, lakebase);

    try {
      const request = app.askAndDisconnect({
        conversationId: 'conv-replay-redaction',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
      await request.finished;
      await vi.waitFor(() => expect(ledger.stageEvents).toHaveLength(1));

      const replayed = (await app.conversationRun('conv-replay-redaction'))?.stages as Record<string, unknown>[];
      expect(replayed[0]).not.toHaveProperty('output');
      expect(replayed[0].input).toContain('which titles lost the most active players');
    } finally {
      await app.close();
    }
  });

  it('parks a run behind a plan rather than finishing it, and lets go of the lease', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const store = memoryLakebase();
    const { ledger, lakebase } = lakebaseWithLedger(store);
    const app = await startInsightsApp(agentContractTransport([]), lakebase);

    try {
      const planned = await app.ask({ conversationId: 'conv-ledger-plan', prompt: NONTRIVIAL_QUESTION });

      expect(planned.type).toBe('plan');
      expect(ledger.runs[0].state).toBe('AWAITING_APPROVAL');
      expect(ledger.runs[0].lease_expires_at).toBeNull();
      expect(ledger.runs[0].completed_at).toBeNull();
      expect(ledger.runs[0].plan_fingerprint).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('opens an attempt naming the process that took the run', async () => {
    // A lease naming nothing is a lease nobody can chase. Apps run more than
    // one container, so a run stuck mid-flight has to point at one.
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const store = memoryLakebase();
    const { ledger, lakebase } = lakebaseWithLedger(store);
    const app = await startInsightsApp(agentContractTransport([]), lakebase);

    try {
      await app.ask({ conversationId: 'conv-ledger-attempt', prompt: NONTRIVIAL_QUESTION, executePlan: true });

      expect(ledger.attempts).toHaveLength(1);
      expect(ledger.attempts[0].executor).toContain(String(process.pid));
      expect(ledger.attempts[0].outcome).toBe('SUCCEEDED');
    } finally {
      await app.close();
    }
  });
});

/**
 * The status read off a rejection, including the case where there is no prose to
 * read.
 *
 * The prose match is a deliberate guess and the cases below keep it working, but
 * it must only ever be guessing at something somebody actually wrote. A
 * rejection that is neither an `Error` nor a scalar used to be stringified into
 * the literal `[object Object]` and matched against these patterns, which is
 * matching against the name of a type rather than against a message. Reading it
 * as absent is the honest version, and both outcomes still refuse the request:
 * an unrecognised status is rethrown rather than answered.
 */
describe('the status carried by a refused invocation', () => {
  it('prefers the status the SDK carried, whichever field it used', () => {
    expect(rejectionStatus({ statusCode: 403 })).toBe(403);
    expect(rejectionStatus({ status: 401 })).toBe(401);
  });

  it("reads an Error's message when no status was carried", () => {
    expect(rejectionStatus(new Error('permission denied for table players'))).toBe(403);
    expect(rejectionStatus(new Error('invalid access token'))).toBe(401);
  });

  it('reads a scalar rejection, which is prose somebody wrote', () => {
    expect(rejectionStatus('403 Forbidden')).toBe(403);
    expect(rejectionStatus(401)).toBe(401);
  });

  it('reads a rejection that is neither an Error nor a scalar as carrying no prose', () => {
    // The array is the case that mattered: stringifying it yields the element,
    // so a malformed rejection got classified as a credential refusal on the
    // strength of punctuation. The object is the `[object Object]` case, which
    // matched nothing before and still matches nothing.
    expect(rejectionStatus(['permission denied'])).toBeNull();
    expect(rejectionStatus({ detail: 'forbidden' })).toBeNull();
    expect(rejectionStatus(null)).toBeNull();
  });

  it('still has nothing to say about a rejection that names no status at all', () => {
    expect(rejectionStatus(new Error('Connection terminated unexpectedly'))).toBeNull();
  });
});

/**
 * What an answer says about how it got its figure.
 *
 * Four facts per statement, derived by the agent from the parse of the SQL it
 * executed: which table, which measure, which date range, which filter. This
 * block is about the app's half of that -- reading the field, not deriving it --
 * and the three ways it can go wrong are all about drift between two artifacts
 * that release separately. The model version live today publishes no such field,
 * so the DEFAULT case here is the one running in production.
 */
describe('the provenance an answer carries', () => {
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  const ENTRY = {
    source: '<your_catalog>.<your_schema>.silver_gameplay_activity',
    metric: 'active_players',
    window: '2026-05-01 → 2026-08-03',
    filter: 'platform = xbox',
  };

  /** The live fixture with a provenance field on its answer. */
  function answerWithDerivation(derivation: unknown) {
    const response = servingResponses.liveAnswerResponse as Record<string, unknown>;
    const outputs = response.custom_outputs as Record<string, unknown>;
    const base = outputs.answer as Record<string, unknown>;
    return {
      ...response,
      custom_outputs: { ...outputs, answer: { ...base, derivation } },
    };
  }

  /** Serves the plan, then the answer above, exactly as the contract transport does. */
  function transportServing(derivation: unknown): ServingTransport {
    return ({ payload }) => {
      const wire = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
      const inputs = (wire.custom_inputs ?? {}) as Record<string, unknown>;
      const approved = Boolean(inputs.approved_plan_id) || inputs.execute_plan === true;
      return Promise.resolve(approved ? answerWithDerivation(derivation) : servingResponses.livePlanResponse);
    };
  }

  /**
   * A parse, and the warnings it wrote.
   *
   * Both, because the warnings are the app's only record of drift and half the
   * cases below are about what the parse RETURNED while it was writing one.
   */
  function parseWatchingWarnings<T>(run: () => T): { value: T; drift: string } {
    const written: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      written.push(args.map(String).join(' '));
    });
    try {
      return { value: run(), drift: written.join('\n') };
    } finally {
      warn.mockRestore();
    }
  }

  it('reads the four facts off the answer the endpoint returned', () => {
    const parsed = extractStructuredAnswer(answerWithDerivation([ENTRY]));

    expect(parsed?.derivation).toEqual([ENTRY]);
  });

  /**
   * The case in production today, and the reason the field is defaulted rather
   * than required: the app and the model release separately, and requiring a key
   * the live model version does not send would fail the parse and reduce a live
   * agent to its prose. An answer that states no provenance is a far better
   * outcome than an answer with no figures.
   */
  it('still reads an answer from the model version that publishes none', () => {
    const base = (servingResponses.liveAnswerResponse.custom_outputs as Record<string, unknown>).answer as Record<
      string,
      unknown
    >;
    expect('derivation' in base).toBe(false);

    const parsed = extractStructuredAnswer(servingResponses.liveAnswerResponse);
    expect(parsed).not.toBeNull();
    expect(parsed?.derivation).toEqual([]);
    expect(parsed?.figures.length).toBeGreaterThan(0);
  });

  it('carries a partial entry as the part it knows, rather than refusing it', () => {
    // A statement with no WHERE clause has no window and no filter. Both empty
    // is what the agent sends and empty is what the renderers draw as nothing.
    const parsed = extractStructuredAnswer(answerWithDerivation([{ source: ENTRY.source, metric: 'active_players' }]));

    expect(parsed?.derivation).toEqual([{ source: ENTRY.source, metric: 'active_players', window: '', filter: '' }]);
  });

  it('reports a key it does not know about, on the entry it was on', () => {
    const { drift } = parseWatchingWarnings(() =>
      extractStructuredAnswer(answerWithDerivation([{ ...ENTRY, grain: 'daily' }]))
    );

    expect(drift).toContain('derivation[0].grain');
  });

  /**
   * The asymmetry against `charts`, deliberately: a malformed chart envelope
   * fails the parse, because the chart is the content. A malformed provenance
   * entry must not, because failing here would take the figures, the sources and
   * the SQL down with it and serve the agent's prose alone -- trading the answer
   * for a caption on it. So the entry states nothing and the answer survives.
   */
  it('drops an entry it cannot read without dropping the answer under it', () => {
    const { value: parsed, drift } = parseWatchingWarnings(() =>
      extractStructuredAnswer(answerWithDerivation(['not an entry at all']))
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.figures.length).toBeGreaterThan(0);
    expect(parsed?.derivation).toEqual([{ source: '', metric: '', window: '', filter: '' }]);
    // Not silent. This line is the only record that the agent sent something the
    // app could not read.
    expect(drift).toContain('provenance entry this app could not read');
  });

  it('reaches the answer the browser reads', async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(transportServing([ENTRY]), memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-derivation',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });

      expect(answered.mode).toBe('live');
      expect(answered.derivation).toEqual([ENTRY]);
    } finally {
      await app.close();
    }
  });

  it('is on the trace a reader opens when they have begun to doubt the figure', async () => {
    // The Run Explorer, from the stored row rather than from the reply. Every
    // hop between the model and that pane is a place the field can be dropped,
    // and the pane is the one surface where "over what window" is the question.
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(transportServing([ENTRY]), memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-derivation-trace',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
      const { status, body } = await app.runTrace(String(answered.id));

      expect(status).toBe(200);
      expect(body.derivation).toEqual([ENTRY]);
    } finally {
      await app.close();
    }
  });

  it('leaves the key off a trace whose run derived none, rather than sending an empty list', async () => {
    // Absent and empty read the same on screen, and they do not mean the same
    // thing: this run was answered by a model version that derives nothing, and
    // the pane must be able to tell that from a run that derived nothing.
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
    const app = await startInsightsApp(agentContractTransport([]), memoryLakebase());

    try {
      const answered = await app.ask({
        conversationId: 'conv-derivation-absent',
        prompt: NONTRIVIAL_QUESTION,
        executePlan: true,
      });
      const { status, body } = await app.runTrace(String(answered.id));

      expect(status).toBe(200);
      expect('derivation' in body).toBe(false);
    } finally {
      await app.close();
    }
  });
});
