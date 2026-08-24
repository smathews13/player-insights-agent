import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupInsightsRoutes, type InsightsAppKit, type ServingTransport } from './insights-routes';
import servingResponses from './__fixtures__/serving-responses.json';
import { FakeStore } from '../lib/__fixtures__/fake-run-store';
import { RUN_LEDGER_MODE_ENV } from '../lib/run-admission';

/**
 * `/api/insights/ask` over Server-Sent Events, end to end through the real
 * route.
 */

interface SseFrame {
  event: string;
  data: unknown;
}

async function startApp(
  transport: ServingTransport,
  lakebase: InsightsAppKit['lakebase'] = { query: () => Promise.resolve({ rows: [] }) }
) {
  const app = express();
  app.use(express.json());
  await setupInsightsRoutes({
    lakebase,
    server: { extend: (fn) => fn(app) },
    servingTransport: transport,
  } satisfies InsightsAppKit);

  // Loopback rather than the wildcard, or this binds a port another process holds
  // on 127.0.0.1 and the fetch below reaches that process. See shared-rail.test.ts.
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
    /** Posts asking for a stream and returns every frame, in arrival order. */
    async askStreaming(body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
      const response = await fetch(`http://127.0.0.1:${port}/api/insights/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...extraHeaders },
        body: JSON.stringify(body),
      });
      const frames: SseFrame[] = [];
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        return { response, contentType, frames, json: await response.json() };
      }
      const text = await response.text();
      for (const block of text.split(/\r?\n\r?\n/)) {
        const eventLine = block.split(/\r?\n/).find((line) => line.startsWith('event:'));
        const dataLine = block.split(/\r?\n/).find((line) => line.startsWith('data:'));
        if (!eventLine || !dataLine) continue;
        frames.push({ event: eventLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) });
      }
      return { response, contentType, frames, json: undefined };
    },
    /** The unchanged contract: no Accept header, one JSON body. */
    async askJson(body: Record<string, unknown>) {
      const response = await fetch(`http://127.0.0.1:${port}/api/insights/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { response, body: await response.json() };
    },
  };
}

/** A transport that narrates `names` and then answers. */
function narratingTransport(names: string[], answer: unknown = servingResponses.liveAnswerResponse) {
  const requests: Record<string, unknown>[] = [];
  const transport: ServingTransport = ({ payload, onStage }) => {
    requests.push(payload);
    for (const [index, name] of names.entries()) {
      onStage?.({
        id: `step-${index + 1}`,
        name,
        kind: 'tool',
        status: 'complete',
        start: index * 10,
        duration: 10,
        calls: 1,
      });
    }
    return Promise.resolve(answer);
  };
  return { transport, requests };
}

describe('POST /api/insights/ask, asked for as a stream', () => {
  // Without an endpoint name the route throws before it reaches the transport,
  // so every stage assertion below would pass vacuously against a run that
  // never happened.
  const savedEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
  beforeEach(() => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
  });
  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = savedEndpoint;
  });

  it('sends each stage before the answer, in the order the agent finished them', async () => {
    const { transport } = narratingTransport([
      'Chose the next step',
      'Listed available tables',
      'Queried governed data',
    ]);
    const app = await startApp(transport);

    const { contentType, frames } = await app.askStreaming({
      conversationId: 'conv-stream',
      prompt: 'Which titles lost the most active players?',
      executePlan: true,
      approvedPlanId: 'plan-1',
    });

    expect(contentType).toContain('text/event-stream');
    expect(frames.map((frame) => frame.event)).toEqual(['stage', 'stage', 'stage', 'result']);
    expect(frames.slice(0, 3).map((frame) => (frame.data as { name: string }).name)).toEqual([
      'Chose the next step',
      'Listed available tables',
      'Queried governed data',
    ]);
    expect((frames[3].data as { type: string }).type).toBe('answer');

    await app.close();
  });

  /**
   * The property the whole feature rests on, and the one every other test here
   * is blind to: a stage has to reach the browser *while the run is still
   * going*. Buffered and delivered with the answer, it is the spinner it
   * replaced with extra steps.
   */
  it('delivers a stage while the run is still going, not with the answer', async () => {
    let releaseAnswer: () => void = () => {};
    const answerGate = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    const transport: ServingTransport = async ({ onStage }) => {
      onStage?.({
        id: 'step-1',
        name: 'Chose the next step',
        kind: 'agent',
        status: 'complete',
        start: 0,
        duration: 11,
        calls: 2,
      });
      await answerGate;
      return servingResponses.liveAnswerResponse;
    };
    const app = await startApp(transport);

    const response = await fetch(`http://127.0.0.1:${app.port}/api/insights/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        conversationId: 'conv-incremental',
        prompt: 'Which titles lost the most active players?',
        executePlan: true,
        approvedPlanId: 'plan-1',
      }),
    });

    const body = response.body as ReadableStream<Uint8Array> | null;
    if (!body) throw new Error('the route answered a stream request with no body');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    const pump = async () => {
      const chunk = await reader.read();
      if (chunk.done) return false;
      seen += decoder.decode(chunk.value, { stream: true });
      return true;
    };

    while (!seen.includes('event: stage')) {
      if (!(await pump())) break;
    }

    // Read before the transport was allowed to produce an answer at all.
    expect(seen).toContain('Chose the next step');
    releaseAnswer();

    while (await pump());
    expect(seen).toContain('event: result');

    await app.close();
  }, 10_000);

  it('opens the stream before conversation context reads finish', async () => {
    let releaseContext!: () => void;
    const contextGate = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    const contextReads: string[] = [];
    const lakebase = {
      async query(sql: string) {
        const normalised = sql.replace(/\s+/g, ' ').trim();
        if (normalised.startsWith('SELECT role, content, response_json FROM (')) {
          contextReads.push('history');
          await contextGate;
        }
        if (normalised.includes('SELECT filename, extracted_text FROM player_insights.attachments')) {
          contextReads.push('attachments');
          await contextGate;
        }
        return { rows: [] as Record<string, unknown>[] };
      },
    };
    const { transport } = narratingTransport(['Chose the next step']);
    const app = await startApp(transport, lakebase);

    const response = await fetch(`http://127.0.0.1:${app.port}/api/insights/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        conversationId: 'conv-early-open',
        prompt: 'Which titles lost the most active players?',
        executePlan: true,
        approvedPlanId: 'plan-1',
      }),
    });

    // Fetch resolves on the flushed headers while both independent Lakebase
    // reads are still blocked. If begin() moves below either await, this hangs
    // until the gate is released and the assertion cannot be reached.
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(contextReads.sort()).toEqual(['attachments', 'history']);

    releaseContext();
    expect(await response.text()).toContain('event: result');
    await app.close();
  });

  it('reports an admission conflict as a typed stream error without running twice', async () => {
    const previousMode = process.env[RUN_LEDGER_MODE_ENV];
    process.env[RUN_LEDGER_MODE_ENV] = 'enforce';
    const ledger = new FakeStore();
    const userTurns = new Set<string>();
    const lakebase = {
      query: (sql: string, params: unknown[] = []) => {
        if (/player_insights\.(runs|run_attempts|run_events)/.test(sql)) {
          return ledger.lakebase.query(sql, params);
        }
        // Assistant answers are also INSERTs into messages. Only the user row
        // is the ghost-turn bug: a refused ask left a question with no run.
        if (/INSERT INTO \w+\.messages/.test(sql) && params[2] === 'user') {
          userTurns.add(String(params[0]));
        }
        if (/DELETE FROM \w+\.messages WHERE id/.test(sql)) {
          userTurns.delete(String(params[0]));
        }
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      },
    };
    const transport = vi.fn<ServingTransport>(() => Promise.resolve(servingResponses.liveAnswerResponse));
    const app = await startApp(transport, lakebase);
    const key = 'same-idempotency-key-1234567890';

    try {
      const first = await app.askStreaming(
        { conversationId: 'conv-idempotent', prompt: 'Which titles lost the most active players?' },
        { 'Idempotency-Key': key }
      );
      const firstTerminal: SseFrame | undefined = first.frames[first.frames.length - 1];
      expect(firstTerminal?.event).toBe('result');

      const conflict = await app.askStreaming(
        { conversationId: 'conv-idempotent', prompt: 'Which titles gained the most active players?' },
        { 'Idempotency-Key': key }
      );
      expect(conflict.contentType).toContain('text/event-stream');
      const conflictTerminal: SseFrame | undefined = conflict.frames[conflict.frames.length - 1];
      expect(conflictTerminal?.event).toBe('error');
      expect((conflictTerminal?.data as { code?: string }).code).toBe('IDEMPOTENCY_CONFLICT');
      expect(transport).toHaveBeenCalledTimes(1);
      expect(userTurns.size).toBe(1);
    } finally {
      await app.close();
      if (previousMode === undefined) delete process.env[RUN_LEDGER_MODE_ENV];
      else process.env[RUN_LEDGER_MODE_ENV] = previousMode;
    }
  });

  it('asks the endpoint to stream only when the caller can read one', async () => {
    const { transport, requests } = narratingTransport(['Chose the next step']);
    const app = await startApp(transport);

    await app.askStreaming({
      conversationId: 'c1',
      prompt: 'A question about players.',
      executePlan: true,
      approvedPlanId: 'p',
    });
    await app.askJson({
      conversationId: 'c1',
      prompt: 'A question about players.',
      executePlan: true,
      approvedPlanId: 'p',
    });

    expect(requests[0].stream).toBe(true);
    // Absent, not false. A caller that did not ask for narration puts exactly
    // the bytes on the wire it did before streaming existed.
    expect(requests[1]).not.toHaveProperty('stream');

    await app.close();
  });

  it('still carries custom_inputs, which is the whole reason for the hand-rolled transport', async () => {
    const { transport, requests } = narratingTransport(['Chose the next step']);
    const app = await startApp(transport);

    await app.askStreaming({
      conversationId: 'conv-approval',
      prompt: 'Run the approved analysis.',
      approvedPlanId: 'plan-77',
      executePlan: true,
    });

    expect(requests[0].custom_inputs).toMatchObject({
      conversation_id: 'conv-approval',
      approved_plan_id: 'plan-77',
      execute_plan: true,
    });

    await app.close();
  });

  it('answers a plan turn with no stages at all, rather than inventing one', async () => {
    // The agent proposes before it runs anything, so a plan turn genuinely has
    // no steps to report. A narration here would be pure invention.
    const { transport } = narratingTransport([], servingResponses.livePlanResponse);
    const app = await startApp(transport);

    const { frames } = await app.askStreaming({
      conversationId: 'conv-plan',
      prompt: 'Compare recurrent consumer spending with net bookings by title.',
    });

    expect(frames.map((frame) => frame.event)).toEqual(['result']);
    expect((frames[0].data as { type: string }).type).toBe('plan');

    await app.close();
  });

  it('reports a run that died after some steps as an error, not as an answer', async () => {
    const transport: ServingTransport = ({ onStage }) => {
      onStage?.({
        id: 'step-1',
        name: 'Chose the next step',
        kind: 'agent',
        status: 'complete',
        start: 0,
        duration: 9,
        calls: 1,
      });
      onStage?.({
        id: 'step-2',
        name: 'Queried governed data',
        kind: 'tool',
        status: 'failed',
        start: 9,
        duration: 40,
        calls: 1,
      });
      return Promise.reject(new Error('the endpoint dropped the connection'));
    };
    const app = await startApp(transport);

    const { frames } = await app.askStreaming({
      conversationId: 'conv-dead',
      prompt: 'Which titles lost the most active players?',
      executePlan: true,
      approvedPlanId: 'plan-1',
    });

    // Two real stages, then a terminal frame. What must not happen is the stream
    // simply stopping, which reads on screen as a run still going.
    //
    // The terminal frame used to be a `result` carrying a disclosed
    // representative answer. It is now an `error`, because the endpoint dropped
    // the connection and no answer exists: the stages that DID finish stay on
    // the timeline, since those were observed, and nothing is invented to sit
    // underneath them.
    expect(frames.slice(0, 2).map((frame) => frame.event)).toEqual(['stage', 'stage']);
    const terminal: SseFrame | undefined = frames[frames.length - 1];
    expect(terminal?.event).toBe('error');
    expect((terminal?.data as { code: string }).code).toBe('DEPENDENCY_UNAVAILABLE');

    await app.close();
  });

  it('forwards a step announced before it finished, and does not count it as one that did', async () => {
    // The endpoint announces each step as it starts, under the id the completion
    // will carry, so the rail can draw the row a reader is waiting on. The route
    // forwards both -- an announcement dropped here is a rail that only ever shows
    // finished work -- but counts only completions, because the count exists to
    // say how far a failed run GOT.
    const transport: ServingTransport = ({ onStage }) => {
      onStage?.({
        id: 'step-1',
        name: 'Choosing the next step',
        kind: 'agent',
        status: 'running',
        start: 0,
        duration: 0,
        calls: 0,
      });
      onStage?.({
        id: 'step-1',
        name: 'Chose the next step',
        kind: 'agent',
        status: 'complete',
        start: 0,
        duration: 9,
        calls: 1,
      });
      onStage?.({
        id: 'step-2',
        name: 'Querying governed data',
        kind: 'tool',
        status: 'running',
        start: 9,
        duration: 0,
        calls: 0,
      });
      return Promise.reject(new Error('the endpoint dropped the connection'));
    };
    const app = await startApp(transport);

    const { frames } = await app.askStreaming({
      conversationId: 'conv-announced',
      prompt: 'Which titles lost the most active players?',
      executePlan: true,
      approvedPlanId: 'plan-1',
    });

    const stages = frames
      .filter((frame) => frame.event === 'stage')
      .map((frame) => frame.data as Record<string, unknown>);
    expect(stages.map((stage) => [stage.name, stage.status])).toEqual([
      ['Choosing the next step', 'running'],
      ['Chose the next step', 'complete'],
      ['Querying governed data', 'running'],
    ]);
    const terminal = frames[frames.length - 1];
    expect(terminal?.event).toBe('error');
    // One step finished. Three stage frames went past, and two of them were
    // announcements of work that never returned.
    expect((terminal?.data as { evidence?: { stage?: { completed: number; title: string } } }).evidence?.stage).toEqual(
      {
        title: 'Chose the next step',
        completed: 1,
      }
    );

    await app.close();
  });

  it('keeps a real status code on a refusal made before the run started', async () => {
    const { transport } = narratingTransport(['Chose the next step']);
    const app = await startApp(transport);

    // Too short for the schema, so this is refused before anything is invoked.
    const { response, contentType } = await app.askStreaming({ conversationId: 'c', prompt: 'x' });

    expect(response.status).toBe(400);
    // Not SSE: the stream had not opened, so the refusal keeps its status line
    // instead of being flattened to a 200 with an error event inside it.
    expect(contentType).not.toContain('text/event-stream');

    await app.close();
  });

  it('returns one JSON body to a caller that did not ask for a stream', async () => {
    const { transport } = narratingTransport(['Chose the next step']);
    const app = await startApp(transport);

    const { response, body } = await app.askJson({
      conversationId: 'conv-json',
      prompt: 'Which titles lost the most active players?',
      executePlan: true,
      approvedPlanId: 'plan-1',
    });

    expect(response.headers.get('content-type')).toContain('application/json');
    expect((body as { type: string }).type).toBe('answer');

    await app.close();
  });
});
